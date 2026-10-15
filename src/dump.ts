import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { usage } from './errors.js';

/** The four formats `pg_dump --format` writes. */
export type DumpFormat = 'custom' | 'directory' | 'tar' | 'plain';

export interface DumpInfo {
  path: string;
  format: DumpFormat;
  /** Bytes on disk (for a directory dump: the sum of its files' sizes is not computed; this is 0). */
  sizeBytes: number;
  /** Last modification time, used to explain drift ("the dump is 3 h old"). */
  modifiedAt: Date;
  /** Archive format version from the header of a custom or directory dump, e.g. "1.15.0". */
  archiveVersion: string | null;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const archiveVersionOf = (head: Buffer) =>
  head.length >= 8 ? `${head[5]}.${head[6]}.${head[7]}` : null;

/**
 * Works out what kind of dump `path` is, from its contents rather than its
 * name: custom-format files start with `PGDMP`, directory dumps hold a
 * `toc.dat` that does, tar archives carry `ustar` at byte 257, and anything
 * else that is text is taken as plain SQL.
 */
export async function detectDump(path: string): Promise<DumpInfo> {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw usage(`Dump not found: ${path}`);
  }

  if (st.isDirectory()) {
    let head: Buffer;
    try {
      head = await readHead(join(path, 'toc.dat'), 8);
    } catch {
      throw usage(`${path} is a directory but not a pg_dump directory dump (it has no toc.dat).`);
    }
    return {
      path,
      format: 'directory',
      sizeBytes: 0,
      modifiedAt: st.mtime,
      archiveVersion: head.subarray(0, 5).toString('latin1') === 'PGDMP' ? archiveVersionOf(head) : null,
    };
  }
  if (!st.isFile()) throw usage(`${path} is not a file or a directory.`);

  const head = await readHead(path, 512);
  const base = { path, sizeBytes: st.size, modifiedAt: st.mtime };

  if (head.subarray(0, 5).toString('latin1') === 'PGDMP') {
    return { ...base, format: 'custom', archiveVersion: archiveVersionOf(head) };
  }
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') {
    return { ...base, format: 'tar', archiveVersion: null };
  }
  const compressed = compressionOf(head);
  if (compressed) {
    throw usage(
      `${path} is ${compressed}-compressed. Decompress it first, or dump with --format=custom, which compresses internally and restores directly.`,
    );
  }
  if (head.includes(0)) {
    throw usage(`${path} does not look like a pg_dump file: it is binary but not a custom-format or tar archive.`);
  }
  return { ...base, format: 'plain', archiveVersion: null };
}

function compressionOf(head: Buffer): string | null {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  if (head[0] === 0x04 && head[1] === 0x22 && head[2] === 0x4d && head[3] === 0x18) return 'lz4';
  if (head.subarray(0, 3).toString('latin1') === 'BZh') return 'bzip2';
  if (head[0] === 0xfd && head.subarray(1, 6).toString('latin1') === '7zXZ\0') return 'xz';
  return null;
}

/**
 * Lines in a plain dump that would make `psql` leave the scratch database.
 * `pg_dumpall` output and `pg_dump --create` both `\connect` to the real
 * database by name, so restoring them "into a scratch database" would write
 * into production. `\!` runs a shell command. None of these appear in a plain
 * single-database `pg_dump`.
 */
const UNSAFE: { re: RegExp; why: string }[] = [
  { re: /^\\(connect|c)(\s|$)/, why: 'switches to another database (\\connect)' },
  { re: /^create\s+database\b/i, why: 'creates a database (CREATE DATABASE)' },
  { re: /^drop\s+database\b/i, why: 'drops a database (DROP DATABASE)' },
  { re: /^alter\s+database\b/i, why: 'alters a database (ALTER DATABASE)' },
  { re: /^create\s+role\b|^alter\s+role\b|^drop\s+role\b/i, why: 'changes cluster roles' },
  { re: /^\\!/, why: 'runs a shell command (\\!)' },
];

export interface UnsafeLine {
  line: number;
  text: string;
  why: string;
}

/**
 * Scans a plain SQL dump for statements that would reach outside the scratch
 * database. Lines inside `COPY ... FROM stdin` data blocks are skipped, since
 * those are row data, not commands.
 */
export async function findUnsafePlainLine(path: string): Promise<UnsafeLine | null> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  let inCopy = false;
  try {
    for await (const raw of rl) {
      n++;
      if (inCopy) {
        if (raw === '\\.') inCopy = false;
        continue;
      }
      const text = raw.trimStart();
      if (/^copy\s.+\sfrom\s+stdin\b/i.test(text)) {
        inCopy = true;
        continue;
      }
      for (const { re, why } of UNSAFE) {
        if (re.test(text)) return { line: n, text: raw.slice(0, 200), why };
      }
    }
  } finally {
    rl.close();
  }
  return null;
}
