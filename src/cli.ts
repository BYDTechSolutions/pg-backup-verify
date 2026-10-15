#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatReport, VerifyError, verifyBackup } from './index.js';
import type { Report, VerifyOptions } from './index.js';
import { redactText } from './connection.js';

const HELP = `pg-backup-verify: prove a Postgres backup restores.

Restores the dump into a scratch database beside the source, compares every
table's exact row count against the source, and drops the scratch database.

Usage
  pg-backup-verify <dump> [--source <postgres-url>] [options]

Options
  --source <url>            database the dump was taken from (default: $DATABASE_URL)
  --no-source               only prove the dump restores; print its counts
  --scratch-url <url>       create the scratch database on this server instead
                            (its database is used for CREATE/DROP, default postgres)
  --keep                    leave the scratch database in place
  --schema <name>           compare only this schema (repeatable)
  --exclude-table <glob>    skip matching tables: audit_*, public.sessions (repeatable)
  --tolerance <n|n%>        allowed drift per table, rows or % of source (default 0)
  --allow-restore-warnings  accept a restore that reported errors if counts match
  --jobs <n>                parallel pg_restore jobs (custom/directory dumps)
  --pg-bin <dir>            directory with psql and pg_restore (default: PATH)
  --json                    print the report as JSON
  -h, --help                show this help
  -v, --version             show the version

Exit codes
  0  verified (or, with --no-source, restored cleanly)
  1  counts differ, or the restore failed
  2  usage or environment error (bad options, no psql, server unreachable)
`;

type Exit = 0 | 1 | 2 | 130 | 143;

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr }): Promise<Exit> {
  const write = (stream: NodeJS.WritableStream, s: string) => stream.write(s.endsWith('\n') ? s : `${s}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        source: { type: 'string' },
        'no-source': { type: 'boolean' },
        'scratch-url': { type: 'string' },
        keep: { type: 'boolean' },
        schema: { type: 'string', multiple: true },
        'exclude-table': { type: 'string', multiple: true },
        tolerance: { type: 'string' },
        'allow-restore-warnings': { type: 'boolean' },
        jobs: { type: 'string' },
        'pg-bin': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    write(io.err, `pg-backup-verify: ${redactText((err as Error).message)}\nRun pg-backup-verify --help for usage.`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const json = !!v.json;

  const fail = (code: 'USAGE' | 'ENVIRONMENT', message: string): Exit => {
    const safe = redactText(message);
    if (json) write(io.out, JSON.stringify({ ok: false, error: { code, message: safe } }, null, 2));
    else write(io.err, `pg-backup-verify: ${safe}`);
    return 2;
  };

  if (v.help) {
    write(io.out, HELP);
    return 0;
  }
  if (v.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    write(io.out, pkg.version);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail('USAGE', positionals.length ? 'Pass exactly one dump.' : 'Which dump? Usage: pg-backup-verify <dump> --source <postgres-url>');
  }
  if (v['no-source'] && v.source && v['scratch-url']) {
    return fail('USAGE', '--no-source with both --source and --scratch-url is ambiguous: pass one server.');
  }
  let jobs: number | undefined;
  if (v.jobs !== undefined) {
    jobs = Number(v.jobs);
    if (!Number.isInteger(jobs) || jobs < 1) return fail('USAGE', `--jobs must be a whole number of at least 1, got "${v.jobs}".`);
  }

  const controller = new AbortController();
  let interrupted: NodeJS.Signals | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (interrupted) {
      write(io.err, 'pg-backup-verify: interrupted again; exiting without cleanup.');
      process.exit(sig === 'SIGINT' ? 130 : 143);
    }
    interrupted = sig;
    write(io.err, `pg-backup-verify: ${sig}: stopping the restore and dropping the scratch database...`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const options: VerifyOptions = {
    dump: positionals[0]!,
    source: v.source,
    noSource: !!v['no-source'],
    scratchUrl: v['scratch-url'],
    keep: !!v.keep,
    schemas: v.schema,
    excludeTables: v['exclude-table'],
    tolerance: v.tolerance,
    allowRestoreWarnings: !!v['allow-restore-warnings'],
    jobs,
    pgBin: v['pg-bin'],
    signal: controller.signal,
    onProgress: json ? undefined : (m) => write(io.err, `- ${m}`),
  };

  let report: Report;
  try {
    report = await verifyBackup(options);
  } catch (err) {
    if (err instanceof VerifyError) {
      if (err.code === 'ABORTED') {
        write(io.err, `pg-backup-verify: ${redactText(err.message)}`);
        return interrupted === 'SIGTERM' ? 143 : 130;
      }
      return fail(err.code, err.message);
    }
    return fail('ENVIRONMENT', (err as Error).stack ?? String(err));
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (json) {
    write(io.out, JSON.stringify(report, null, 2));
  } else {
    const forced = !!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
    const color = !process.env.NO_COLOR && ((io.out as NodeJS.WriteStream).isTTY === true || forced);
    write(io.out, formatReport(report, { color }));
  }
  if (report.scratch.dropError) write(io.err, `pg-backup-verify: could not drop ${report.scratch.database}: ${report.scratch.dropError}`);
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`pg-backup-verify: ${redactText(String((err as Error)?.stack ?? err))}\n`);
    process.exitCode = 2;
  },
);
