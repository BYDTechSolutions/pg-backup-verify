import type { Connection } from './connection.js';
import { redactText } from './connection.js';
import type { DumpFormat } from './dump.js';
import { environment, VerifyError } from './errors.js';
import { clientEnv, run } from './pg.js';

/**
 * - `clean`: the restore tool exited 0 and printed no errors or warnings.
 * - `with-errors`: it finished, but reported errors or warnings
 *   (`pg_restore` carries on past a failed statement and says
 *   "errors ignored on restore" at the end).
 * - `failed`: it stopped before the end (`psql` with ON_ERROR_STOP, or a
 *   `pg_restore` that could not read the archive).
 */
export type RestoreStatus = 'clean' | 'with-errors' | 'failed';

export interface RestoreResult {
  tool: 'pg_restore' | 'psql';
  status: RestoreStatus;
  exitCode: number | null;
  /** Each error message the tool printed, multi-line messages kept together. */
  errors: string[];
  /** Each warning message the tool printed. */
  warnings: string[];
  /** A plain-language hint for well-known failures (old client, truncated file). */
  hint: string | null;
  durationMs: number;
}

export interface RestoreRun {
  binary: string;
  format: DumpFormat;
  path: string;
  target: Connection;
  jobs?: number;
  signal?: AbortSignal;
}

/** Restores a dump into `target` with `pg_restore` (archives) or `psql` (plain SQL). */
export async function restoreDump(r: RestoreRun): Promise<RestoreResult> {
  const plain = r.format === 'plain';
  const args = plain
    ? ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--dbname', r.target.dbname, '-f', r.path]
    : [
        '--dbname',
        r.target.dbname,
        '--no-owner',
        '--no-privileges',
        ...(r.jobs && r.jobs > 1 ? [`--jobs=${r.jobs}`] : []),
        r.path,
      ];
  const started = Date.now();
  let out;
  try {
    out = await run(r.binary, args, { env: clientEnv(r.target), signal: r.signal, ignoreStdout: true });
  } catch (err) {
    if (err instanceof VerifyError) throw err;
    throw environment(`Could not run ${r.binary}: ${(err as Error).message}`);
  }
  const stderr = redactText(out.stderr, [r.target.password]);
  const parsed = plain ? parsePsqlOutput(stderr) : parsePgRestoreOutput(stderr);
  let status: RestoreStatus;
  if (plain) {
    status = out.code !== 0 ? 'failed' : parsed.errors.length || parsed.warnings.length ? 'with-errors' : 'clean';
  } else if (out.code !== 0) {
    status = parsed.completed ? 'with-errors' : 'failed';
  } else {
    status = parsed.errors.length || parsed.warnings.length ? 'with-errors' : 'clean';
  }
  if (out.signal) status = 'failed';
  return {
    tool: plain ? 'psql' : 'pg_restore',
    status,
    exitCode: out.code,
    errors: parsed.errors,
    warnings: parsed.warnings,
    hint: hintFor(stderr),
    durationMs: Date.now() - started,
  };
}

interface Parsed {
  errors: string[];
  warnings: string[];
  /** pg_restore reached the end and summarized ignored errors. */
  completed: boolean;
}

/**
 * Groups `pg_restore` stderr into messages. A message starts at a line with
 * the `pg_restore: ` prefix and runs until the next one; a "from TOC entry"
 * line (older clients print it before the error it locates) is joined to the
 * message that follows.
 */
export function parsePgRestoreOutput(stderr: string): Parsed {
  const blocks: string[][] = [];
  let pendingToc: string[] | null = null;
  for (const line of stderr.split('\n')) {
    if (line.trim() === '') continue;
    if (line.startsWith('pg_restore: ')) {
      if (/^pg_restore: while PROCESSING TOC:?\s*$/.test(line)) continue;
      if (/^pg_restore: from TOC entry/.test(line)) {
        pendingToc = [line];
        continue;
      }
      blocks.push([...(pendingToc ?? []), line]);
      pendingToc = null;
    } else if (pendingToc) {
      pendingToc.push(line);
    } else if (blocks.length) {
      blocks[blocks.length - 1]!.push(line);
    } else {
      blocks.push([line]);
    }
  }
  if (pendingToc) blocks.push(pendingToc);

  const errors: string[] = [];
  const warnings: string[] = [];
  let completed = false;
  for (const b of blocks) {
    const text = b.join('\n');
    if (/pg_restore: warning: errors ignored on restore: \d+/.test(text)) {
      completed = true;
      continue;
    }
    if (/pg_restore: (error|fatal|\[archiver[^\]]*\] could not)/.test(text) || /\bERROR:/.test(text)) {
      errors.push(text);
    } else if (/pg_restore: warning:/.test(text) || /\bWARNING:/.test(text)) {
      warnings.push(text);
    } else if (!/^pg_restore: (processing|creating|executing|connecting|implied data-only)/.test(text)) {
      warnings.push(text);
    }
  }
  return { errors, warnings, completed };
}

/** Picks errors and warnings out of `psql -f` stderr; NOTICE lines are ignored. */
export function parsePsqlOutput(stderr: string): Parsed {
  const errors: string[] = [];
  const warnings: string[] = [];
  let last: string[] | null = null;
  for (const line of stderr.split('\n')) {
    if (line.trim() === '') continue;
    if (/(^|:\s)(ERROR|FATAL|PANIC):|(^|:\s)error:|^psql: error/.test(line)) {
      last = errors;
      errors.push(line);
    } else if (/(^|:\s)WARNING:|(^|:\s)warning:/.test(line)) {
      last = warnings;
      warnings.push(line);
    } else if (/(^|:\s)(NOTICE|INFO|DEBUG|LOG):/.test(line)) {
      last = null;
    } else if (last && last.length) {
      last[last.length - 1] += `\n${line}`;
    }
  }
  return { errors, warnings, completed: true };
}

function hintFor(stderr: string): string | null {
  if (/unsupported version \([\d.]+\) in file header/.test(stderr)) {
    return 'This pg_restore is older than the pg_dump that wrote the archive. Use pg_restore from the same major version as that pg_dump, or newer (see --pg-bin).';
  }
  if (/invalid command \\(restrict|unrestrict)/.test(stderr)) {
    return 'The dump uses \\restrict, which newer pg_dump releases write into plain dumps. Use a psql from a release that understands it (a current minor release of any supported major), or dump with --format=custom.';
  }
  if (/could not read from input file: end of file|unexpected end of file|could not find header for file|did not find magic string/.test(stderr)) {
    return 'The dump looks truncated or corrupted: it ends before the archive does.';
  }
  if (/could not uncompress data|incorrect header check|invalid (stored|code|distance)/.test(stderr)) {
    return 'Compressed data in the archive is corrupted.';
  }
  if (/permission denied to create extension|extension "[^"]+" is not available|could not open extension control file/.test(stderr)) {
    return 'The dump needs an extension the scratch server does not have, or the role cannot create it. Restore onto a server with the same extensions (see --scratch-url).';
  }
  return null;
}
