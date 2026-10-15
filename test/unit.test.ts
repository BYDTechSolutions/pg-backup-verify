import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareCounts, matchesPattern, parseTolerance } from '../src/compare.js';
import { parseConnection, quoteIdent, quoteLiteral, redactText, redactUrl, withDatabase } from '../src/connection.js';
import { detectDump, findUnsafePlainLine } from '../src/dump.js';
import { formatReport, scratchName } from '../src/index.js';
import type { Report } from '../src/index.js';
import { parseMajor } from '../src/pg.js';
import { parsePgRestoreOutput, parsePsqlOutput } from '../src/restore.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pgbv-unit-'));

describe('connections and redaction', () => {
  it('keeps the password out of the dbname and the display form', () => {
    const c = parseConnection('postgres://app:p%40ss%3Aword@db.example.com:6543/shop?sslmode=require', '--source');
    expect(c.password).toBe('p@ss:word');
    expect(c.database).toBe('shop');
    expect(c.dbname).toBe('postgres://app@db.example.com:6543/shop?sslmode=require');
    expect(c.display).toBe('postgres://app:***@db.example.com:6543/shop?sslmode=require');
    expect(c.server).toBe('db.example.com:6543');
  });

  it('points the same credentials at another database', () => {
    const c = withDatabase(parseConnection('postgresql://u:pw@h/a', 'x'), 'a_verify_1');
    expect(c.database).toBe('a_verify_1');
    expect(c.password).toBe('pw');
    expect(c.display).toBe('postgresql://u:***@h/a_verify_1');
  });

  it('uses a fallback database, or requires one', () => {
    expect(parseConnection('postgres://u@h', '--scratch-url', 'postgres').database).toBe('postgres');
    expect(() => parseConnection('postgres://u@h', '--source')).toThrow(/must name a database/);
  });

  it('rejects non-postgres URLs and garbage with a usage error', () => {
    expect(() => parseConnection('mysql://u@h/db', '--source')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => parseConnection('not a url', '--source')).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });

  it('redacts URLs and free text', () => {
    expect(redactUrl('postgres://u:secret@h:5432/db')).toBe('postgres://u:***@h:5432/db');
    expect(redactUrl('postgres://u@h/db')).toBe('postgres://u@h/db');
    expect(redactText('failed for postgres://u:secret@h/db and then secret again', ['secret'])).toBe(
      'failed for postgres://u:***@h/db and then *** again',
    );
  });

  it('quotes identifiers and literals', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("o'clock")).toBe("'o''clock'");
  });
});

describe('tolerance and comparison', () => {
  it('parses rows and percentages', () => {
    expect(parseTolerance(undefined)).toEqual({ kind: 'rows', value: 0 });
    expect(parseTolerance('25')).toEqual({ kind: 'rows', value: 25 });
    expect(parseTolerance('0.5%')).toEqual({ kind: 'percent', value: 0.5 });
    expect(parseTolerance(3)).toEqual({ kind: 'rows', value: 3 });
    for (const bad of ['-1', 'ten', '1.5', '150%', '%']) {
      expect(() => parseTolerance(bad)).toThrow(expect.objectContaining({ code: 'USAGE' }));
    }
  });

  it('classifies every kind of difference', () => {
    const restored = new Map([
      ['public.same', 10],
      ['public.fewer', 90],
      ['public.more', 12],
      ['public.small', 99],
      ['public.extra', 1],
    ]);
    const source = new Map([
      ['public.same', 10],
      ['public.fewer', 100],
      ['public.more', 10],
      ['public.small', 100],
      ['public.gone', 5],
    ]);
    const byName = Object.fromEntries(
      compareCounts(restored, source, { kind: 'rows', value: 1 }).map((t) => [t.table, t]),
    );
    expect(byName.same).toMatchObject({ status: 'match', ok: true, difference: 0 });
    expect(byName.fewer).toMatchObject({ status: 'restored-fewer', ok: false, difference: -10 });
    expect(byName.more).toMatchObject({ status: 'restored-more', ok: false, difference: 2 });
    expect(byName.small).toMatchObject({ status: 'within-tolerance', ok: true, difference: -1 });
    expect(byName.gone).toMatchObject({ status: 'missing-in-restore', ok: false, restored: null, source: 5 });
    expect(byName.extra).toMatchObject({ status: 'missing-in-source', ok: false, restored: 1, source: null });
  });

  it('applies percentages to the source count', () => {
    const r = compareCounts(new Map([['s.t', 990]]), new Map([['s.t', 1000]]), { kind: 'percent', value: 1 });
    expect(r[0]?.status).toBe('within-tolerance');
    const r2 = compareCounts(new Map([['s.t', 989]]), new Map([['s.t', 1000]]), { kind: 'percent', value: 1 });
    expect(r2[0]?.status).toBe('restored-fewer');
  });

  it('reports restored counts without a source', () => {
    const r = compareCounts(new Map([['a.b', 3]]), null, { kind: 'rows', value: 0 });
    expect(r).toEqual([{ schema: 'a', table: 'b', restored: 3, source: null, difference: null, status: 'restored', ok: true }]);
  });

  it('matches exclusion globs on bare and qualified names', () => {
    expect(matchesPattern('public', 'audit_log', ['audit_*'])).toBe(true);
    expect(matchesPattern('billing', 'audit_log', ['public.audit_*'])).toBe(false);
    expect(matchesPattern('public', 'sessions', ['public.sessions'])).toBe(true);
    expect(matchesPattern('public', 'tmp_1', ['*.tmp_?'])).toBe(true);
    expect(matchesPattern('public', 'users', ['audit_*', 'sessions'])).toBe(false);
  });
});

describe('scratch database name', () => {
  it('is <db>_verify_<utc timestamp>', () => {
    expect(scratchName('shop', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('shop_verify_20260102030405');
  });
  it('fits in 63 bytes', () => {
    const name = scratchName('x'.repeat(80));
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name).toMatch(/_verify_\d{14}$/);
  });
});

describe('dump format detection', () => {
  it('recognizes custom, tar, directory and plain dumps by content', async () => {
    const dir = tmp();
    const custom = join(dir, 'a.backup');
    writeFileSync(custom, Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 15, 0]), Buffer.alloc(64)]));
    const tar = join(dir, 'a.bin');
    const tarBuf = Buffer.alloc(1024);
    tarBuf.write('toc.dat', 0);
    tarBuf.write('ustar', 257);
    writeFileSync(tar, tarBuf);
    const plain = join(dir, 'a.dump');
    writeFileSync(plain, '-- PostgreSQL database dump\nSELECT 1;\n');
    const directory = join(dir, 'dirdump');
    mkdirSync(directory);
    writeFileSync(join(directory, 'toc.dat'), Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 14, 0])]));

    expect(await detectDump(custom)).toMatchObject({ format: 'custom', archiveVersion: '1.15.0' });
    expect(await detectDump(tar)).toMatchObject({ format: 'tar' });
    expect(await detectDump(plain)).toMatchObject({ format: 'plain' });
    expect(await detectDump(directory)).toMatchObject({ format: 'directory', archiveVersion: '1.14.0' });
  });

  it('refuses compressed, binary and missing files with usage errors', async () => {
    const dir = tmp();
    const gz = join(dir, 'a.sql.gz');
    writeFileSync(gz, Buffer.from([0x1f, 0x8b, 8, 0, 0, 0]));
    const bin = join(dir, 'a.bin');
    writeFileSync(bin, Buffer.from([1, 2, 0, 4]));
    const notDump = join(dir, 'empty-dir');
    mkdirSync(notDump);
    await expect(detectDump(gz)).rejects.toMatchObject({ code: 'USAGE', message: expect.stringMatching(/gzip/) });
    await expect(detectDump(bin)).rejects.toMatchObject({ code: 'USAGE' });
    await expect(detectDump(notDump)).rejects.toMatchObject({ code: 'USAGE', message: expect.stringMatching(/toc\.dat/) });
    await expect(detectDump(join(dir, 'nope.dump'))).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('plain dump safety scan', () => {
  it('flags \\connect and CREATE DATABASE, which would leave the scratch database', async () => {
    const dir = tmp();
    const all = join(dir, 'all.sql');
    writeFileSync(all, 'SET x = 1;\nCREATE DATABASE shop;\n\\connect shop\n');
    expect(await findUnsafePlainLine(all)).toMatchObject({ line: 2, why: expect.stringMatching(/CREATE DATABASE/) });
    const conn = join(dir, 'conn.sql');
    writeFileSync(conn, 'SELECT 1;\n\\connect -reuse-previous=on "dbname=\'shop\'"\n');
    expect(await findUnsafePlainLine(conn)).toMatchObject({ line: 2 });
  });

  it('ignores row data inside COPY blocks', async () => {
    const dir = tmp();
    const f = join(dir, 'ok.sql');
    writeFileSync(f, 'COPY public.notes (body) FROM stdin;\nCREATE DATABASE is just text here\n\\.\nSELECT 1;\n');
    expect(await findUnsafePlainLine(f)).toBeNull();
  });
});

describe('restore output parsing', () => {
  it('groups pg_restore errors with their TOC context and spots the summary', () => {
    const stderr = [
      'pg_restore: while PROCESSING TOC:',
      'pg_restore: from TOC entry 2; 3079 16385 EXTENSION file_fdw (no owner)',
      'pg_restore: error: could not execute query: ERROR:  permission denied to create extension "file_fdw"',
      'HINT:  Must be superuser to create this extension.',
      'Command was: CREATE EXTENSION IF NOT EXISTS file_fdw WITH SCHEMA public;',
      'pg_restore: warning: errors ignored on restore: 1',
      '',
    ].join('\n');
    const p = parsePgRestoreOutput(stderr);
    expect(p.completed).toBe(true);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toMatch(/TOC entry 2[\s\S]*permission denied[\s\S]*Command was/);
    expect(p.warnings).toHaveLength(0);
  });

  it('treats a pg_restore that stopped early as not completed', () => {
    const p = parsePgRestoreOutput('pg_restore: error: could not read from input file: end of file\n');
    expect(p.completed).toBe(false);
    expect(p.errors).toEqual(['pg_restore: error: could not read from input file: end of file']);
  });

  it('picks psql errors and warnings, ignoring notices', () => {
    const p = parsePsqlOutput(
      [
        'psql:/x/a.sql:10: NOTICE:  table "t" does not exist, skipping',
        'psql:/x/a.sql:12: ERROR:  syntax error at or near "TABEL"',
        'LINE 1: CREATE TABEL t (id int);',
        'psql:/x/a.sql:20: WARNING:  something odd',
      ].join('\n'),
    );
    expect(p.errors).toEqual(['psql:/x/a.sql:12: ERROR:  syntax error at or near "TABEL"\nLINE 1: CREATE TABEL t (id int);']);
    expect(p.warnings).toEqual(['psql:/x/a.sql:20: WARNING:  something odd']);
  });
});

describe('versions', () => {
  it('reads majors old and new', () => {
    expect(parseMajor('16.4')).toBe(16);
    expect(parseMajor('17')).toBe(17);
    expect(parseMajor('9.6.24')).toBe(9.6);
  });
});

describe('text report', () => {
  const base: Report = {
    ok: false,
    verdict: 'mismatch',
    dump: { path: '/b/app.dump', format: 'custom', sizeBytes: 4096, modifiedAt: '2026-01-01T00:00:00.000Z', archiveVersion: '1.15.0' },
    source: { url: 'postgres://app:***@db/app', database: 'app', serverVersion: '16.4' },
    scratch: {
      url: 'postgres://app:***@db/app_verify_20260101020000',
      database: 'app_verify_20260101020000',
      serverVersion: '16.4',
      sameServerAsSource: true,
      kept: false,
      dropped: true,
      dropError: null,
    },
    restore: { tool: 'pg_restore', status: 'clean', exitCode: 0, errors: [], warnings: [], hint: null, durationMs: 1200, clientVersion: '16.4' },
    tolerance: { kind: 'rows', value: 0 },
    tables: [
      { schema: 'public', table: 'users', restored: 1200, source: 1200, difference: 0, status: 'match', ok: true },
      { schema: 'public', table: 'events', restored: 5000, source: 5012, difference: -12, status: 'restored-fewer', ok: false },
    ],
    summary: {
      tables: 2,
      matched: 1,
      withinTolerance: 0,
      restoredFewer: 1,
      restoredMore: 0,
      missingInRestore: 0,
      missingInSource: 0,
      restoredRows: 6200,
      sourceRows: 6212,
    },
    notes: ['1 table(s) restored FEWER rows than the source has now.'],
    startedAt: '2026-01-01T02:00:00.000Z',
    durationMs: 2000,
  };

  it('shows counts, the mismatch, the drift note and the verdict', () => {
    const text = formatReport(base);
    expect(text).toContain('public.events');
    expect(text).toMatch(/5,000\s+5,012\s+-12\s+MISMATCH\s+restored fewer/);
    expect(text).toContain('modified 2 h 0 min ago');
    expect(text).toContain('NOT VERIFIED');
    expect(text).not.toContain('\x1b[');
    expect(formatReport(base, { color: true })).toContain('\x1b[31m');
  });

  it('says VERIFIED only when the report is', () => {
    const ok = formatReport({ ...base, ok: true, verdict: 'verified', tables: [base.tables[0]!], notes: [] });
    expect(ok).toContain('VERIFIED: the dump restored');
  });
});
