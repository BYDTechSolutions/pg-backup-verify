import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';

/* CLI behavior that needs no database: usage and environment errors exit 2. */

const dir = mkdtempSync(join(tmpdir(), 'pgbv-cli-'));
const plain = join(dir, 'tiny.sql');
writeFileSync(plain, 'CREATE TABLE t (id int);\n');
const noUrl = { DATABASE_URL: '' };
const PASSWORD = 'cli-Secret-Pw-4410';

describe('cli without a database', () => {
  it('prints help and version', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage');
    const version = await runCli(['--version']);
    expect(version.code).toBe(0);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(version.stdout.trim()).toBe(pkg.version);
  });

  it('exits 2 without a dump', async () => {
    const r = await runCli([], { env: noUrl });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Which dump/);
  });

  it('exits 2 for an unknown option, without echoing a password', async () => {
    const r = await runCli([plain, `--sorce=postgres://u:${PASSWORD}@localhost/db`], { env: noUrl });
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).not.toContain(PASSWORD);
  });

  it('exits 2 when there is no source and no --no-source', async () => {
    const r = await runCli([plain], { env: noUrl });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/DATABASE_URL/);
  });

  it('exits 2 for a missing dump, a bad tolerance and bad --jobs', async () => {
    const src = ['--source', `postgres://u:${PASSWORD}@127.0.0.1:1/db`];
    for (const args of [
      [join(dir, 'missing.dump'), ...src],
      [plain, ...src, '--tolerance', 'lots'],
      [plain, ...src, '--jobs', '0'],
      [plain, ...src, '--jobs', '4'],
    ]) {
      const r = await runCli(args, { env: noUrl });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr + r.stdout).not.toContain(PASSWORD);
    }
  });

  it('exits 2 with a clear message when psql is not where it is told to look', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pgbv-nobin-'));
    const r = await runCli([plain, '--source', `postgres://u:${PASSWORD}@127.0.0.1:1/db`, '--pg-bin', empty], { env: noUrl });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/needs psql/);
  });

  it('refuses a pg_dumpall-style plain dump before touching any server', async () => {
    const all = join(dir, 'all.sql');
    writeFileSync(all, 'CREATE DATABASE prod;\n\\connect prod\nCREATE TABLE t (id int);\n');
    const r = await runCli([all, '--source', 'postgres://u@127.0.0.1:1/db'], { env: noUrl });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Refusing to restore/);
  });

  it('reports usage errors as JSON with --json', async () => {
    const r = await runCli([plain, '--json'], { env: noUrl });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});
