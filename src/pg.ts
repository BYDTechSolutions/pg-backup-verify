import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Connection } from './connection.js';
import { quoteIdent, quoteLiteral, redactText } from './connection.js';
import { environment, VerifyError } from './errors.js';

/** Output kept from a child process, per stream. Restores can print a lot. */
const MAX_CAPTURE = 4 * 1024 * 1024;

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  /** Discard stdout instead of capturing it (restores print command tags). */
  ignoreStdout?: boolean;
}

/**
 * Runs a binary to completion. Rejects with ENOENT-style errors when it does
 * not exist; resolves with the exit code otherwise. When `signal` aborts, the
 * child is sent SIGTERM and the promise rejects with an `ABORTED` VerifyError
 * once it has exited.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new VerifyError('ABORTED', 'Aborted.'));
      return;
    }
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', opts.ignoreStdout ? 'ignore' : 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(new VerifyError('ABORTED', 'Aborted.'));
      else resolve({ code, signal, stdout, stderr });
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* The child exited before reading everything; its exit code says why. */
      });
      child.stdin.end(opts.input);
    }
  });
}

/** Where to find `psql` and `pg_restore`: a directory, or PATH. */
export function binary(name: 'psql' | 'pg_restore', pgBin?: string): string {
  return pgBin ? join(pgBin, name) : name;
}

export interface ClientVersion {
  /** e.g. 16 (or 9.6 for pre-10 releases). */
  major: number;
  /** e.g. "16.4". */
  version: string;
}

export function parseMajor(version: string): number {
  const [a, b] = version.split('.').map(Number);
  if (a === undefined || Number.isNaN(a)) return NaN;
  return a < 10 && b !== undefined ? Number(`${a}.${b}`) : a;
}

/** `psql --version` → `{ major: 16, version: "16.4" }`, or null when the binary is missing. */
export async function clientVersion(path: string): Promise<ClientVersion | null> {
  let r: RunResult;
  try {
    r = await run(path, ['--version']);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EACCES') return null;
    throw err;
  }
  if (r.code !== 0) return null;
  const m = /\)\s+(\d+(?:\.\d+)*)/.exec(r.stdout) ?? /(\d+(?:\.\d+)+)/.exec(r.stdout);
  if (!m?.[1]) return null;
  return { major: parseMajor(m[1]), version: m[1] };
}

/** Environment for libpq clients: the password goes here, never on the command line. */
export function clientEnv(conn: Connection): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGAPPNAME: 'pg-backup-verify' };
  if (conn.password !== undefined) env.PGPASSWORD = conn.password;
  if (!env.PGCONNECT_TIMEOUT) env.PGCONNECT_TIMEOUT = '10';
  return env;
}

/** A failed query, with the server's message (redacted). */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

/**
 * Runs SQL through `psql` and returns its unaligned, tuples-only output.
 * The SQL goes in on stdin, so its length is not limited by ARG_MAX.
 */
export async function query(psql: string, conn: Connection, sql: string, signal?: AbortSignal): Promise<string> {
  let r: RunResult;
  try {
    r = await run(psql, ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '--dbname', conn.dbname, '-f', '-'], {
      env: clientEnv(conn),
      input: sql,
      signal,
    });
  } catch (err) {
    if (err instanceof VerifyError) throw err;
    throw environment(`Could not run ${psql}: ${(err as Error).message}`);
  }
  if (r.code !== 0) {
    const msg = redactText(r.stderr.trim() || `psql exited with code ${r.code}`, [conn.password]);
    throw new QueryError(msg);
  }
  return r.stdout;
}

export interface ServerInfo {
  /** e.g. "16.4". */
  version: string;
  major: number;
}

export async function serverInfo(psql: string, conn: Connection, signal?: AbortSignal): Promise<ServerInfo> {
  const out = (await query(psql, conn, 'show server_version_num; show server_version;', signal)).trim().split('\n');
  const num = Number(out[0]);
  const version = (out[1] ?? '').split(/\s/)[0] ?? '';
  const major = num >= 100000 ? Math.floor(num / 10000) : Math.floor(num / 100) / 100;
  return { version, major };
}

export interface TableRef {
  schema: string;
  table: string;
}

/** Every ordinary table (partitions included, partitioned parents not) outside the system schemas. */
export async function listTables(psql: string, conn: Connection, signal?: AbortSignal): Promise<TableRef[]> {
  const sql = `
    select coalesce(json_agg(json_build_object('schema', n.nspname, 'table', c.relname)
                             order by n.nspname, c.relname), '[]')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_toast'
      and n.nspname !~ '^pg_temp_';`;
  return JSON.parse((await query(psql, conn, sql, signal)).trim() || '[]') as TableRef[];
}

/**
 * Exact `count(*)` of each table, in one round trip. `query_to_xml` runs a
 * dynamic `select count(*)` per row without creating a function, so the
 * check stays read-only on the source. Counts come back as text so a bigint
 * is never squeezed through a float on the way.
 */
export async function countRows(
  psql: string,
  conn: Connection,
  tables: TableRef[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (tables.length === 0) return counts;
  const values = tables.map((t) => `(${quoteLiteral(t.schema)}, ${quoteLiteral(t.table)})`).join(',\n  ');
  const sql = `
    select coalesce(json_agg(json_build_array(v.s, v.t,
      (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', v.s, v.t), false, true, '')))[1]::text
    )), '[]')
    from (values
  ${values}
    ) as v(s, t);`;
  const rows = JSON.parse((await query(psql, conn, sql, signal)).trim() || '[]') as [string, string, string][];
  for (const [s, t, n] of rows) counts.set(tableKey({ schema: s, table: t }), Number(n));
  return counts;
}

export const tableKey = (t: TableRef) => `${t.schema}.${t.table}`;

export async function createDatabase(psql: string, admin: Connection, name: string, signal?: AbortSignal) {
  await query(psql, admin, `create database ${quoteIdent(name)} template template0;`, signal);
}

/**
 * Drops a database this tool created. Ends any session still connected to it
 * first (an interrupted restore can leave a backend behind), and retries a
 * couple of times because a killed client's backend can take a moment to go.
 */
export async function dropDatabase(psql: string, admin: Connection, name: string, serverMajor: number): Promise<void> {
  const force = serverMajor >= 13 ? ' with (force)' : '';
  const sql = `
    select count(pg_terminate_backend(pid)) from pg_stat_activity
      where datname = ${quoteLiteral(name)} and pid <> pg_backend_pid();
    drop database if exists ${quoteIdent(name)}${force};`;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await query(psql, admin, sql);
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw last;
}

export async function databaseExists(psql: string, admin: Connection, name: string): Promise<boolean> {
  const out = await query(psql, admin, `select count(*) from pg_database where datname = ${quoteLiteral(name)};`);
  return out.trim() === '1';
}
