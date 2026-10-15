#!/usr/bin/env node
/**
 * Verify the newest dump in a directory, the way a nightly job would.
 *
 *   DATABASE_URL=postgres://app:secret@localhost:5432/app \
 *     node examples/verify-newest.mjs ./backups
 *
 * Exits 0 when the newest dump restores and matches the source, 1 when it
 * does not, 2 when it could not tell (no dumps, no psql, server unreachable).
 * The source may have taken writes since the dump, so a small tolerance is
 * allowed; set it to 0 for a database that is quiet during backups.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatReport, verifyBackup, VerifyError } from '@bydtech/pg-backup-verify';

const dir = resolve(process.argv[2] ?? 'backups');
const newest = readdirSync(dir)
  .filter((f) => /\.(dump|sql|tar)$/.test(f))
  .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (!newest) {
  console.error(`No .dump, .sql or .tar files in ${dir}.`);
  process.exit(2);
}

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  const report = await verifyBackup({
    dump: newest.path,
    source: process.env.DATABASE_URL,
    tolerance: '0.1%',
    signal: controller.signal,
    onProgress: (message) => console.error(`- ${message}`),
  });
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} catch (err) {
  if (!(err instanceof VerifyError)) throw err;
  console.error(err.message);
  process.exitCode = err.code === 'ABORTED' ? 130 : 2;
}
