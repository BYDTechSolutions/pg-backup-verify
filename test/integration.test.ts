import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBackup, VerifyError } from '../src/index.js';
import type { Report } from '../src/index.js';
import { has, runCli } from './helpers.js';

/*
 * Integration tests against a real Postgres.
 *
 * Locally they start their own throwaway container (never an existing one)
 * and remove it afterwards, also when a test fails. The image defaults to the
 * major version of the local pg_dump, because pg_dump refuses a newer server;
 * override with PGBV_TEST_IMAGE. In CI, PGBV_TEST_URL points at a service
 * container instead, and no container is started here.
 *
 * Every database these tests create is their own: src_* for sources, and the
 * scratch databases the tool creates and drops.
 */

const PASSWORD = 'pgbv-Test-Pw-7731';
const externalUrl = process.env.PGBV_TEST_URL;
const pgDumpVersion = has('pg_dump');
const clientMajor = Number(/\)\s+(\d+)/.exec(pgDumpVersion ?? '')?.[1] ?? 16);
const dockerOk = !externalUrl && has('docker', ['info', '--format', '{{.ServerVersion}}']) !== null;
const canRun = !!pgDumpVersion && has('psql') !== null && (!!externalUrl || dockerOk);

if (!canRun) {
  console.warn(
    '\n[pg-backup-verify] Skipping integration tests: ' +
      (!pgDumpVersion ? 'pg_dump/psql are not on PATH. ' : '') +
      (!externalUrl && !dockerOk ? 'Docker is not available and PGBV_TEST_URL is not set.' : '') +
      '\n',
  );
}

let container: string | null = null;
let admin: URL; // superuser URL to the test server's "postgres" database
const work = mkdtempSync(join(tmpdir(), 'pgbv-it-'));
let dbCounter = 0;

function removeContainer() {
  if (container) {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    container = null;
  }
}
process.on('exit', removeContainer);

const urlFor = (db: string, base: URL = admin) => {
  const u = new URL(base.href);
  u.pathname = `/${db}`;
  return u.href;
};

const pgEnv = (base: URL = admin) => ({ ...process.env, PGPASSWORD: decodeURIComponent(base.password) });

function psql(db: string, sql: string, base: URL = admin): string {
  const r = spawnSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '--dbname', urlFor(db, base).replace(/:[^:@/]*@/, '@'), '-c', sql], {
    encoding: 'utf8',
    env: pgEnv(base),
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
}

function pgDump(db: string, file: string, args: string[] = []) {
  const r = spawnSync('pg_dump', ['--dbname', urlFor(db).replace(/:[^:@/]*@/, '@'), '-f', file, ...args], {
    encoding: 'utf8',
    env: pgEnv(),
  });
  if (r.status !== 0) throw new Error(`pg_dump failed: ${r.stderr}`);
  return file;
}

/** A fresh source database: public.users (100), public.orders (250), billing.invoices (40). */
function seedSource(): string {
  const db = `src_${process.pid}_${++dbCounter}`;
  psql('postgres', `create database ${db}`);
  psql(
    db,
    `create table users (id serial primary key, email text not null);
     insert into users (email) select 'user' || g || '@example.com' from generate_series(1, 100) g;
     create table orders (id bigserial primary key, user_id int references users(id), total numeric(10,2));
     insert into orders (user_id, total) select 1 + (g % 100), g * 1.5 from generate_series(1, 250) g;
     create schema billing;
     create table billing.invoices (id int primary key, note text);
     insert into billing.invoices select g, 'invoice ' || g from generate_series(1, 40) g;`,
  );
  return db;
}

const leftovers = () => psql('postgres', "select string_agg(datname, ',') from pg_database where datname like '%\\_verify\\_%'");

const status = (report: Report, name: string) => report.tables.find((t) => `${t.schema}.${t.table}` === name)?.status;

beforeAll(async () => {
  if (!canRun) return;
  if (externalUrl) {
    admin = new URL(externalUrl);
    return;
  }
  const image = process.env.PGBV_TEST_IMAGE ?? `postgres:${clientMajor}-alpine`;
  container = `pgbv-test-${randomBytes(4).toString('hex')}`;
  const run = spawnSync(
    'docker',
    ['run', '--rm', '-d', '--name', container, '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-p', '127.0.0.1::5432', image],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    container = null;
    throw new Error(`Could not start ${image}: ${run.stderr}`);
  }
  const port = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]!.split(':').pop();
  admin = new URL(`postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      psql('postgres', 'select 1');
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

afterAll(() => {
  if (canRun && externalUrl && admin) {
    // On a shared server, remove what these tests created.
    const mine = psql('postgres', `select string_agg(datname, ' ') from pg_database where datname like 'src\\_${process.pid}\\_%'`);
    for (const db of mine.split(' ').filter(Boolean)) psql('postgres', `drop database if exists ${db} with (force)`);
    try {
      psql('postgres', 'drop role if exists pgbv_verifier');
    } catch {
      /* still owns something; harmless on a throwaway service container */
    }
  }
  removeContainer();
});

describe.skipIf(!canRun)('against a real Postgres', () => {
  it('verifies a matching custom-format dump and drops the scratch database', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    const progress: string[] = [];
    const report = await verifyBackup({ dump, source: urlFor(db), onProgress: (m) => progress.push(m) });
    expect(report.verdict).toBe('verified');
    expect(report.ok).toBe(true);
    expect(report.dump.format).toBe('custom');
    expect(report.restore.status).toBe('clean');
    expect(report.tables.map((t) => [`${t.schema}.${t.table}`, t.restored, t.source])).toEqual([
      ['billing.invoices', 40, 40],
      ['public.orders', 250, 250],
      ['public.users', 100, 100],
    ]);
    expect(report.scratch.database).toMatch(new RegExp(`^${db}_verify_\\d{14}$`));
    expect(report.scratch.dropped).toBe(true);
    expect(leftovers()).toBe('');
    expect(progress.join('\n')).not.toContain(PASSWORD);
  });

  it('verifies directory and tar dumps', async () => {
    const db = seedSource();
    const dir = pgDump(db, join(work, `${db}.dir`), ['--format=directory']);
    const tar = pgDump(db, join(work, `${db}.tar`), ['--format=tar']);
    const a = await verifyBackup({ dump: dir, source: urlFor(db), jobs: 2 });
    const b = await verifyBackup({ dump: tar, source: urlFor(db) });
    expect([a.dump.format, a.verdict]).toEqual(['directory', 'verified']);
    expect([b.dump.format, b.verdict]).toEqual(['tar', 'verified']);
  });

  it('verifies a plain SQL dump through psql', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.sql`));
    const report = await verifyBackup({ dump, source: urlFor(db) });
    expect(report.restore.tool).toBe('psql');
    expect(report.verdict).toBe('verified');
  });

  it('fails a truncated dump and still drops the scratch database', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    const truncated = join(work, `${db}-truncated.dump`);
    writeFileSync(truncated, readFileSync(dump).subarray(0, Math.floor(statSync(dump).size / 2)));
    const report = await verifyBackup({ dump: truncated, source: urlFor(db) });
    expect(report.verdict).toBe('restore-failed');
    expect(report.ok).toBe(false);
    expect(report.restore.status).not.toBe('clean');
    expect(report.restore.errors.join('\n')).toMatch(/end of file|could not read/);
    expect(report.scratch.dropped).toBe(true);
    expect(leftovers()).toBe('');
  });

  it('fails a tampered plain dump (psql stops at the first error)', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.sql`));
    const tampered = join(work, `${db}-tampered.sql`);
    writeFileSync(tampered, readFileSync(dump, 'utf8').replace('CREATE TABLE public.orders', 'CREATE TABEL public.orders'));
    const report = await verifyBackup({ dump: tampered, source: urlFor(db) });
    expect(report.verdict).toBe('restore-failed');
    expect(report.restore.status).toBe('failed');
    expect(report.restore.errors.join('\n')).toMatch(/syntax error/);
    expect(leftovers()).toBe('');
  });

  it('fails a custom dump with corrupted bytes', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    const buf = readFileSync(dump);
    for (let i = Math.floor(buf.length * 0.4); i < Math.floor(buf.length * 0.9); i += 7) buf[i] = buf[i]! ^ 0xff;
    const corrupted = join(work, `${db}-corrupted.dump`);
    writeFileSync(corrupted, buf);
    const report = await verifyBackup({ dump: corrupted, source: urlFor(db) });
    expect(report.ok).toBe(false);
    expect(leftovers()).toBe('');
  });

  it('reports a table missing from the dump, and one missing from the source', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom', '--exclude-table=billing.invoices']);
    psql(db, 'create table late_table (id int); drop table orders;');
    const report = await verifyBackup({ dump, source: urlFor(db) });
    expect(report.verdict).toBe('mismatch');
    expect(status(report, 'billing.invoices')).toBe('missing-in-restore');
    expect(status(report, 'public.late_table')).toBe('missing-in-restore');
    expect(status(report, 'public.orders')).toBe('missing-in-source');
    expect(report.summary).toMatchObject({ missingInRestore: 2, missingInSource: 1, matched: 1 });

    const excluded = await verifyBackup({
      dump,
      source: urlFor(db),
      excludeTables: ['billing.invoices', 'late_*', 'public.orders'],
    });
    expect(excluded.verdict).toBe('verified');
    expect(excluded.tables.map((t) => t.table)).toEqual(['users']);
  });

  it('explains row drift, and accepts it within a tolerance', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    psql(db, "insert into users (email) select 'late' || g from generate_series(1, 5) g; delete from billing.invoices where id <= 2;");

    const strict = await verifyBackup({ dump, source: urlFor(db) });
    expect(strict.verdict).toBe('mismatch');
    const users = strict.tables.find((t) => t.table === 'users')!;
    expect(users).toMatchObject({ restored: 100, source: 105, difference: -5, status: 'restored-fewer' });
    expect(strict.tables.find((t) => t.table === 'invoices')).toMatchObject({ difference: 2, status: 'restored-more' });
    expect(strict.notes.join('\n')).toMatch(/FEWER rows[\s\S]*added to the source after the dump/);
    expect(strict.notes.join('\n')).toMatch(/MORE rows[\s\S]*deleted from the source/);

    const loose = await verifyBackup({ dump, source: urlFor(db), tolerance: 5 });
    expect(loose.verdict).toBe('verified');
    expect(status(loose, 'public.users')).toBe('within-tolerance');

    const percent = await verifyBackup({ dump, source: urlFor(db), tolerance: '1%' });
    expect(percent.verdict).toBe('mismatch'); // 1% of 105 is 1.05 rows; 5 is too many

    const enough = await verifyBackup({ dump, source: urlFor(db), tolerance: '6%' });
    expect(enough.verdict).toBe('verified'); // 5 of 105 is 4.8%, 2 of 38 is 5.3%
  });

  it('compares only the schemas asked for', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    psql(db, 'insert into users (email) values (1)');
    const report = await verifyBackup({ dump, source: urlFor(db), schemas: ['billing'] });
    expect(report.verdict).toBe('verified');
    expect(report.tables.map((t) => t.table)).toEqual(['invoices']);
    await expect(verifyBackup({ dump, source: urlFor(db), schemas: ['nope'] })).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('only proves the restore in --no-source mode', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    psql(db, 'truncate orders');
    const report = await verifyBackup({ dump, noSource: true, scratchUrl: admin.href });
    expect(report.verdict).toBe('verified');
    expect(report.source).toBeNull();
    expect(report.tables.find((t) => t.table === 'orders')).toMatchObject({ restored: 250, source: null, status: 'restored' });
    expect(report.scratch.database).toMatch(/^postgres_verify_/);
  });

  it('uses --scratch-url for the scratch database, and --keep leaves it there', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    const report = await verifyBackup({ dump, source: urlFor(db), scratchUrl: urlFor('postgres'), keep: true });
    expect(report.verdict).toBe('verified');
    expect(report.scratch).toMatchObject({ sameServerAsSource: false, kept: true, dropped: false });
    expect(leftovers()).toBe(report.scratch.database);
    expect(psql(report.scratch.database, 'select count(*) from users')).toBe('100');
    psql('postgres', `drop database ${report.scratch.database}`);
    expect(leftovers()).toBe('');
  });

  it('fails a restore that finished with errors, unless --allow-restore-warnings', async () => {
    // A role that can create databases but not untrusted extensions, so the
    // restore of a dump with CREATE EXTENSION file_fdw reports an error and
    // carries on, and the tables still arrive.
    const db = seedSource();
    psql('postgres', `do $$ begin create role pgbv_verifier login createdb password '${PASSWORD}'; exception when duplicate_object then null; end $$`);
    psql(db, 'create extension if not exists file_fdw; grant select on all tables in schema public, billing to pgbv_verifier; grant usage on schema billing to pgbv_verifier;');
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    const asVerifier = new URL(admin.href);
    asVerifier.username = 'pgbv_verifier';
    const source = urlFor(db, asVerifier);

    const strict = await verifyBackup({ dump, source });
    expect(strict.restore.status).toBe('with-errors');
    expect(strict.restore.errors.join('\n')).toMatch(/file_fdw/);
    expect(strict.verdict).toBe('restore-failed');
    expect(strict.tables.every((t) => t.ok)).toBe(true);

    const allowed = await verifyBackup({ dump, source, allowRestoreWarnings: true });
    expect(allowed.verdict).toBe('verified');
    expect(allowed.notes.join('\n')).toMatch(/allow-restore-warnings/);
    expect(leftovers()).toBe('');
  });

  it('warns when the client is older than the server', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
    const bin = mkdtempSync(join(tmpdir(), 'pgbv-oldbin-'));
    for (const tool of ['psql', 'pg_restore']) {
      const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(
        join(bin, tool),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${tool} (PostgreSQL) 9.6.24"; exit 0; fi\nexec "${real}" "$@"\n`,
      );
      chmodSync(join(bin, tool), 0o755);
    }
    const report = await verifyBackup({ dump, source: urlFor(db), pgBin: bin });
    expect(report.notes.join('\n')).toMatch(/pg_restore 9\.6\.24 is older than the server/);
  });

  it('drops the scratch database when aborted mid-restore', async () => {
    const db = seedSource();
    const dump = pgDump(db, join(work, `${db}.sql`));
    appendFileSync(dump, '\nSELECT pg_sleep(60);\n');
    const controller = new AbortController();
    const started = Date.now();
    const err = await verifyBackup({
      dump,
      source: urlFor(db),
      signal: controller.signal,
      onProgress: (m) => {
        if (m.startsWith('Restoring')) setTimeout(() => controller.abort(), 1500);
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerifyError);
    expect(err).toMatchObject({ code: 'ABORTED', scratchDropped: true });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(leftovers()).toBe('');
  });

  describe('cli', () => {
    it('exits 0 when verified, 1 on drift, and never prints the password', async () => {
      const db = seedSource();
      const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
      const ok = await runCli([dump, '--source', urlFor(db)]);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('VERIFIED');
      expect(ok.stdout).toMatch(/public\.users\s+100\s+100\s+0\s+ok/);

      psql(db, "insert into users (email) values ('late')");
      const drift = await runCli([dump, '--json'], { env: { DATABASE_URL: urlFor(db) } });
      expect(drift.code).toBe(1);
      const report = JSON.parse(drift.stdout) as Report;
      expect(report.verdict).toBe('mismatch');
      expect(report.source?.url).toContain(':***@');

      for (const r of [ok, drift]) {
        expect(r.stdout + r.stderr).not.toContain(PASSWORD);
        expect(r.stdout + r.stderr).toContain('***');
      }
    });

    it('exits 1 when the restore fails', async () => {
      const db = seedSource();
      const truncated = join(work, `${db}-cli-truncated.dump`);
      const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
      writeFileSync(truncated, readFileSync(dump).subarray(0, 1500));
      const r = await runCli([truncated, '--source', urlFor(db)]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('did not restore cleanly');
      expect(r.stdout + r.stderr).not.toContain(PASSWORD);
    });

    it('exits 2 when the source cannot be reached, without leaking the password', async () => {
      const db = seedSource();
      const dump = pgDump(db, join(work, `${db}.dump`), ['--format=custom']);
      const wrong = new URL(urlFor(db));
      wrong.password = `${PASSWORD}-wrong`;
      const r = await runCli([dump, '--source', wrong.href]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Could not connect to the source/);
      expect(r.stdout + r.stderr).not.toContain(PASSWORD);
    });

    it('drops the scratch database on SIGINT and exits 130', async () => {
      const db = seedSource();
      const dump = pgDump(db, join(work, `${db}.sql`));
      appendFileSync(dump, '\nSELECT pg_sleep(60);\n');
      let sent = false;
      const r = await runCli([dump, '--source', urlFor(db)], {
        onStderr: (soFar, child) => {
          if (!sent && soFar.includes('Restoring')) {
            sent = true;
            setTimeout(() => child.kill('SIGINT'), 1500);
          }
        },
      });
      expect(r.code).toBe(130);
      expect(r.stderr).toMatch(/dropped/);
      expect(leftovers()).toBe('');
    });
  });
});
