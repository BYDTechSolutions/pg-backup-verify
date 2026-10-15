/**
 * Prove a Postgres backup restores.
 *
 * A backup nobody has restored is a file, not a backup. {@link verifyBackup}
 * restores a dump into a scratch database beside the real one, compares every
 * table's exact row count against the source, and drops the scratch database
 * again.
 *
 * @packageDocumentation
 */
import { basename, resolve } from 'node:path';
import type { Tolerance, TableResult } from './compare.js';
import { compareCounts, matchesPattern, parseTolerance } from './compare.js';
import type { Connection } from './connection.js';
import { parseConnection, redactText, withDatabase } from './connection.js';
import type { DumpFormat } from './dump.js';
import { detectDump, findUnsafePlainLine } from './dump.js';
import { environment, usage, VerifyError } from './errors.js';
import type { ClientVersion, ServerInfo, TableRef } from './pg.js';
import {
  binary,
  clientVersion,
  countRows,
  createDatabase,
  dropDatabase,
  listTables,
  QueryError,
  serverInfo,
} from './pg.js';
import type { RestoreResult } from './restore.js';
import { restoreDump } from './restore.js';
import { formatAge } from './age.js';

export { VerifyError } from './errors.js';
export type { VerifyErrorCode } from './errors.js';
export type { Tolerance, TableResult, TableStatus } from './compare.js';
export { parseTolerance } from './compare.js';
export type { DumpFormat } from './dump.js';
export type { RestoreResult, RestoreStatus } from './restore.js';
export { redactUrl } from './connection.js';
export { formatReport } from './report.js';
export type { FormatOptions } from './report.js';

/** Options for {@link verifyBackup}. Only `dump` is required. */
export interface VerifyOptions {
  /** Path to the dump: a custom-format file, a tar file, a directory dump, or plain SQL. */
  dump: string;
  /**
   * The database the dump was taken from, as a `postgres://` URL. Its row
   * counts are the reference, and its server hosts the scratch database unless
   * `scratchUrl` is set. Defaults to `env.DATABASE_URL`.
   */
  source?: string;
  /**
   * Skip the comparison: only prove the dump restores, and report its counts.
   * A server is still needed for the scratch database: `scratchUrl`, else
   * `source`, else `env.DATABASE_URL`.
   * @defaultValue false
   */
  noSource?: boolean;
  /**
   * Create the scratch database on another server. The URL's database is the
   * one connected to for CREATE/DROP DATABASE (default `postgres`); the dump is
   * never restored into it.
   */
  scratchUrl?: string;
  /** Leave the scratch database in place for inspection. @defaultValue false */
  keep?: boolean;
  /** Compare only these schemas. Default: every non-system schema. */
  schemas?: string[];
  /** Skip tables matching these globs (`audit_*`, `public.sessions`, `*.tmp_?`). */
  excludeTables?: string[];
  /** Allowed drift per table: rows (`10`) or percent of the source count (`"0.5%"`). @defaultValue 0 */
  tolerance?: string | number | Tolerance;
  /**
   * Accept a restore that finished with errors or warnings, as long as the
   * counts match. Without it, any restore error fails verification.
   * @defaultValue false
   */
  allowRestoreWarnings?: boolean;
  /** Parallel `pg_restore` jobs (custom and directory dumps only). @defaultValue 1 */
  jobs?: number;
  /** Directory holding `psql` and `pg_restore`. Default: whatever is on PATH. */
  pgBin?: string;
  /** Abort the run: the restore is stopped and the scratch database dropped before the promise rejects. */
  signal?: AbortSignal;
  /** Progress messages, already free of passwords. */
  onProgress?: (message: string) => void;
  /** Where `DATABASE_URL` is read from. @defaultValue process.env */
  env?: Record<string, string | undefined>;
}

/** What {@link verifyBackup} found. */
export interface Report {
  /** True when the restore succeeded and every compared table is within tolerance. */
  ok: boolean;
  verdict: 'verified' | 'mismatch' | 'restore-failed';
  dump: {
    path: string;
    format: DumpFormat;
    sizeBytes: number;
    modifiedAt: string;
    /** Archive format version from the dump header (custom and directory dumps). */
    archiveVersion: string | null;
  };
  /** Null in `noSource` mode. */
  source: { url: string; database: string; serverVersion: string } | null;
  scratch: {
    /** Redacted URL of the scratch database. */
    url: string;
    database: string;
    serverVersion: string;
    sameServerAsSource: boolean;
    kept: boolean;
    dropped: boolean;
    /** Why the drop failed, when it did. The database is then still there. */
    dropError: string | null;
  };
  restore: RestoreResult & { clientVersion: string };
  tolerance: Tolerance;
  tables: TableResult[];
  summary: {
    tables: number;
    matched: number;
    withinTolerance: number;
    restoredFewer: number;
    restoredMore: number;
    missingInRestore: number;
    missingInSource: number;
    restoredRows: number;
    sourceRows: number | null;
  };
  /** Warnings and explanations: client older than server, why counts drift. */
  notes: string[];
  startedAt: string;
  durationMs: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `<db>_verify_<UTC yyyymmddhhmmss>`, kept inside Postgres's 63-byte identifier limit. */
export function scratchName(database: string, now = new Date()): string {
  const stamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
  const suffix = `_verify_${stamp}`;
  let prefix = database;
  while (Buffer.byteLength(prefix + suffix) > 63) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new VerifyError('ABORTED', 'Aborted.');
}

/**
 * Restores `options.dump` into a fresh scratch database, compares exact row
 * counts for every table against the source, and drops the scratch database
 * (in a `finally`, so also when the restore or comparison throws, and when
 * `options.signal` aborts).
 *
 * Resolves with a {@link Report} whether or not the backup verified; check
 * `report.ok`. Rejects with a {@link VerifyError} only when no verdict is
 * possible: `USAGE` for bad options, `ENVIRONMENT` for missing binaries or an
 * unreachable server, `ABORTED` when the signal fired.
 *
 * @example
 * ```ts
 * const report = await verifyBackup({ dump: 'backups/app.dump', source: process.env.DATABASE_URL });
 * if (!report.ok) process.exitCode = 1;
 * ```
 */
export async function verifyBackup(options: VerifyOptions): Promise<Report> {
  const startedAt = new Date();
  const env = options.env ?? process.env;
  const progress = options.onProgress ?? (() => {});
  const signal = options.signal;
  const notes: string[] = [];

  // ---- Options ---------------------------------------------------------
  if (!options.dump) throw usage('Which dump? Pass the path to a pg_dump file or directory.');
  const tolerance = parseTolerance(options.tolerance);
  const jobs = options.jobs ?? 1;
  if (!Number.isInteger(jobs) || jobs < 1) throw usage('--jobs must be a whole number of at least 1.');
  const schemas = options.schemas ?? [];
  const excludes = options.excludeTables ?? [];

  const sourceRaw = options.noSource ? undefined : options.source ?? env.DATABASE_URL;
  if (!options.noSource && !sourceRaw) {
    throw usage('No source database. Pass --source <postgres-url> or set DATABASE_URL (or use --no-source).');
  }
  const source = sourceRaw ? parseConnection(sourceRaw, '--source') : null;

  let admin: Connection;
  if (options.scratchUrl) {
    admin = parseConnection(options.scratchUrl, '--scratch-url', 'postgres');
  } else if (source) {
    admin = source;
  } else {
    const serverRaw = options.source ?? env.DATABASE_URL;
    if (!serverRaw) {
      throw usage('--no-source still needs a server for the scratch database: pass --scratch-url, --source or DATABASE_URL.');
    }
    admin = parseConnection(serverRaw, options.source ? '--source' : 'DATABASE_URL');
  }
  const secrets = [source?.password, admin.password];
  const redact = (s: string) => redactText(s, secrets);

  // ---- The dump --------------------------------------------------------
  const dumpPath = resolve(options.dump);
  const dump = await detectDump(dumpPath);
  if (dump.format === 'tar' && jobs > 1) throw usage('--jobs works with custom and directory dumps, not tar.');
  if (dump.format === 'plain' && jobs > 1) throw usage('--jobs works with custom and directory dumps, not plain SQL.');
  if (dump.format === 'plain') {
    const unsafe = await findUnsafePlainLine(dumpPath);
    if (unsafe) {
      throw usage(
        `Refusing to restore ${basename(dumpPath)}: line ${unsafe.line} ${unsafe.why}:\n  ${unsafe.text}\n` +
          'That is pg_dumpall output or a dump made with --create, and psql would run it outside the scratch database. ' +
          'Verify a single-database dump (pg_dump without --create) instead.',
      );
    }
  }

  // ---- Client binaries -------------------------------------------------
  const psql = binary('psql', options.pgBin);
  const restoreBin = dump.format === 'plain' ? psql : binary('pg_restore', options.pgBin);
  const psqlVersion = await clientVersion(psql);
  const restoreVersion = dump.format === 'plain' ? psqlVersion : await clientVersion(restoreBin);
  const where = options.pgBin ? `in ${options.pgBin}` : 'on PATH';
  if (!psqlVersion || !restoreVersion) {
    const missing = [!psqlVersion && 'psql', !restoreVersion && 'pg_restore'].filter(Boolean).join(' and ');
    throw environment(
      `pg-backup-verify needs ${missing} ${where}. Install the PostgreSQL client tools ` +
        '(e.g. apt install postgresql-client, brew install libpq) at the same major version as the server or newer, ' +
        'or point --pg-bin at a directory that has them.',
    );
  }

  // ---- Servers ---------------------------------------------------------
  const connect = async (conn: Connection, label: string): Promise<ServerInfo> => {
    try {
      return await serverInfo(psql, conn, signal);
    } catch (err) {
      if (err instanceof QueryError) throw environment(`Could not connect to the ${label} at ${conn.display}:\n${redact(err.message)}`);
      throw err;
    }
  };
  progress(source ? `Connecting to ${source.display}` : `Connecting to ${admin.display}`);
  const sourceInfo = source ? await connect(source, 'source database') : null;
  const sameServer = !options.scratchUrl;
  const adminInfo = sameServer && sourceInfo ? sourceInfo : await connect(admin, 'scratch server');

  const checkClient = (client: ClientVersion, tool: string, server: ServerInfo, label: string) => {
    if (client.major < server.major) {
      notes.push(
        `${tool} ${client.version} is older than the ${label} (Postgres ${server.version}). ` +
          `Install the client tools for ${server.major} or newer${options.pgBin ? '' : ', or point --pg-bin at them'}: ` +
          `an older ${tool} may not read a dump written by a newer pg_dump.`,
      );
    }
  };
  checkClient(restoreVersion, dump.format === 'plain' ? 'psql' : 'pg_restore', adminInfo, sameServer ? 'server' : 'scratch server');
  if (sourceInfo && !sameServer) checkClient(psqlVersion, 'psql', sourceInfo, 'source server');

  // ---- Source counts ---------------------------------------------------
  const select = (tables: TableRef[]) =>
    tables.filter(
      (t) => (schemas.length === 0 || schemas.includes(t.schema)) && !matchesPattern(t.schema, t.table, excludes),
    );
  const counts = async (conn: Connection, label: string) => {
    try {
      return await countRows(psql, conn, select(await listTables(psql, conn, signal)), signal);
    } catch (err) {
      if (err instanceof QueryError) throw environment(`Could not count rows in the ${label}:\n${redact(err.message)}`);
      throw err;
    }
  };
  throwIfAborted(signal);
  let sourceCounts: Map<string, number> | null = null;
  if (source) {
    progress(`Counting rows in ${source.database}`);
    sourceCounts = await counts(source, 'source database');
    if (sourceCounts.size === 0 && (schemas.length || excludes.length)) {
      throw usage('--schema / --exclude-table left no tables in the source to compare. Check the names.');
    }
  }

  // ---- Scratch database ------------------------------------------------
  const name = scratchName(source?.database ?? admin.database);
  if (name === source?.database || name === admin.database) {
    throw usage(`Refusing to use ${name} as the scratch database: it is the source or maintenance database.`);
  }
  const scratch = withDatabase(admin, name);
  throwIfAborted(signal);
  progress(`Creating scratch database ${name}${sameServer ? ' on the same server' : ` on ${admin.server}`}`);
  try {
    // Not abortable: a CREATE killed halfway leaves it unclear whether the
    // database exists, and this tool only ever drops what it knows it made.
    await createDatabase(psql, admin, name);
  } catch (err) {
    if (err instanceof QueryError) {
      throw environment(
        `Could not create the scratch database ${name}:\n${redact(err.message)}\n` +
          'The role needs CREATEDB on that server; or pass --scratch-url for a server where it has it.',
      );
    }
    throw err;
  }

  let restore: RestoreResult | undefined;
  let restoredCounts = new Map<string, number>();
  let dropped = false;
  let dropError: string | null = null;
  let countError: string | null = null;
  try {
    progress(`Restoring ${basename(dumpPath)} (${dump.format}) with ${restoreBin === psql ? 'psql' : 'pg_restore'} ${restoreVersion.version}`);
    restore = await restoreDump({ binary: restoreBin, format: dump.format, path: dumpPath, target: scratch, jobs, signal });
    restore.errors = restore.errors.map(redact);
    restore.warnings = restore.warnings.map(redact);
    throwIfAborted(signal);
    progress(`Counting rows in ${name}`);
    try {
      restoredCounts = await countRows(psql, scratch, select(await listTables(psql, scratch, signal)), signal);
    } catch (err) {
      if (!(err instanceof QueryError)) throw err;
      countError = redact(err.message);
    }
  } finally {
    // Always, including when the restore threw or the run was aborted. A
    // scratch database left behind is still there a year later.
    if (options.keep) {
      progress(`Keeping ${name} (--keep): drop it yourself when done`);
    } else {
      progress(`Dropping ${name}`);
      try {
        await dropDatabase(psql, admin, name, adminInfo.major);
        dropped = true;
      } catch (err) {
        dropError = redact((err as Error).message);
      }
      if (signal?.aborted) {
        const e = new VerifyError('ABORTED', dropped ? `Aborted. ${name} was dropped.` : `Aborted. Could not drop ${name}: ${dropError}`);
        e.scratchDropped = dropped;
        e.scratchDatabase = name;
        throw e;
      }
    }
  }

  // ---- Verdict ---------------------------------------------------------
  const tables = compareCounts(restoredCounts, sourceCounts, tolerance);
  const restoreOk = restore.status === 'clean' || (restore.status === 'with-errors' && !!options.allowRestoreWarnings);
  if (countError) notes.push(`Could not count rows in the scratch database: ${countError}`);
  if (restore.hint) notes.push(restore.hint);
  if (restore.status === 'with-errors' && options.allowRestoreWarnings) {
    notes.push('The restore reported errors or warnings; accepted because of --allow-restore-warnings.');
  }
  const nothingRestored = restoredCounts.size === 0 && (!sourceCounts || sourceCounts.size > 0);
  if (restoreOk && nothingRestored && !countError) {
    notes.push(
      schemas.length || excludes.length
        ? 'No restored tables are left after --schema / --exclude-table. Check the names.'
        : 'The restore produced no tables. A dump of nothing is not a backup.',
    );
  }
  notes.push(...explainDrift(tables, dump.modifiedAt, startedAt));
  if (dropError) notes.push(`Could not drop the scratch database ${name}; drop it by hand: ${dropError}`);

  const verdict: Report['verdict'] =
    !restoreOk || countError || nothingRestored ? 'restore-failed' : tables.every((t) => t.ok) ? 'verified' : 'mismatch';

  const count = (s: TableResult['status']) => tables.filter((t) => t.status === s).length;
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  return {
    ok: verdict === 'verified',
    verdict,
    dump: {
      path: dumpPath,
      format: dump.format,
      sizeBytes: dump.sizeBytes,
      modifiedAt: dump.modifiedAt.toISOString(),
      archiveVersion: dump.archiveVersion,
    },
    source: source && sourceInfo ? { url: source.display, database: source.database, serverVersion: sourceInfo.version } : null,
    scratch: {
      url: scratch.display,
      database: name,
      serverVersion: adminInfo.version,
      sameServerAsSource: !!source && sameServer,
      kept: !!options.keep,
      dropped,
      dropError,
    },
    restore: { ...restore, clientVersion: restoreVersion.version },
    tolerance,
    tables,
    summary: {
      tables: tables.length,
      matched: count('match'),
      withinTolerance: count('within-tolerance'),
      restoredFewer: count('restored-fewer'),
      restoredMore: count('restored-more'),
      missingInRestore: count('missing-in-restore'),
      missingInSource: count('missing-in-source'),
      restoredRows: sum(tables.map((t) => t.restored)),
      sourceRows: sourceCounts ? sum(tables.map((t) => t.source)) : null,
    },
    notes,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
}

function explainDrift(tables: TableResult[], dumpedAt: Date, now: Date): string[] {
  const out: string[] = [];
  const age = formatAge(now.getTime() - dumpedAt.getTime());
  const fewer = tables.filter((t) => t.status === 'restored-fewer');
  const more = tables.filter((t) => t.status === 'restored-more');
  const missingRestore = tables.filter((t) => t.status === 'missing-in-restore');
  const missingSource = tables.filter((t) => t.status === 'missing-in-source');
  const within = tables.filter((t) => t.status === 'within-tolerance');
  if (fewer.length) {
    out.push(
      `${fewer.length} table(s) restored FEWER rows than the source has now. The usual cause is rows added to the source ` +
        `after the dump was taken (the dump file was last modified ${age} ago). If that is expected, allow it with --tolerance; ` +
        'otherwise take a fresh dump and verify that one. If the source has not changed, the dump is missing rows.',
    );
  }
  if (more.length) {
    out.push(
      `${more.length} table(s) restored MORE rows than the source has now: rows were deleted from the source after the dump, ` +
        'or the dump came from a different database.',
    );
  }
  if (missingRestore.length) {
    out.push(
      `${missingRestore.length} table(s) exist in the source but not in the restore: created after the dump, ` +
        'left out of it (pg_dump -T / -n), or the restore stopped before reaching them.',
    );
  }
  if (missingSource.length) {
    out.push(
      `${missingSource.length} table(s) were restored but are not in the source: dropped from the source since the dump, ` +
        'or the dump is of a different database.',
    );
  }
  if (within.length) out.push(`${within.length} table(s) differ from the source but are within the tolerance.`);
  return out;
}
