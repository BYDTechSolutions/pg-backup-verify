import { usage } from './errors.js';

/**
 * A parsed `postgres://` URL, split so the password never reaches a command
 * line (where `ps` would show it) or a log line.
 */
export interface Connection {
  /** The URL with the password removed: safe for `psql --dbname`. */
  readonly dbname: string;
  /** The URL with the password replaced by `***`: safe to print. */
  readonly display: string;
  /** Decoded password, or undefined when the URL has none (libpq then uses PGPASSWORD or ~/.pgpass). */
  readonly password: string | undefined;
  /** Decoded database name. */
  readonly database: string;
  /** Host and port as written in the URL, for "same server" messages. */
  readonly server: string;
  /** The original URL object (password included). Internal use only. */
  readonly url: URL;
}

const PROTOCOLS = new Set(['postgres:', 'postgresql:']);

/**
 * Parses a connection URL. `fallbackDatabase` is used when the URL has no path
 * (`postgres://host`); without one, a database name is required.
 */
export function parseConnection(raw: string, label: string, fallbackDatabase?: string): Connection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usage(`${label} is not a valid URL. Expected postgres://user:password@host:5432/database.`);
  }
  if (!PROTOCOLS.has(url.protocol)) {
    throw usage(`${label} must start with postgres:// or postgresql:// (got ${url.protocol}//).`);
  }
  const fromPath = safeDecode(url.pathname.replace(/^\//, ''));
  const database = fromPath || fallbackDatabase || '';
  if (!database) {
    throw usage(`${label} must name a database: postgres://user@host:5432/<database>.`);
  }
  if (!fromPath) url.pathname = `/${encodeURIComponent(database)}`;
  return build(url);
}

/** The same server and credentials, pointed at another database. */
export function withDatabase(conn: Connection, database: string): Connection {
  const url = new URL(conn.url.href);
  url.pathname = `/${encodeURIComponent(database)}`;
  return build(url);
}

function build(url: URL): Connection {
  const password = url.password ? safeDecode(url.password) : undefined;
  const bare = new URL(url.href);
  bare.password = '';
  const shown = new URL(url.href);
  if (shown.password) shown.password = '***';
  return {
    dbname: bare.href,
    display: shown.href,
    password,
    database: safeDecode(url.pathname.replace(/^\//, '')),
    server: url.host || 'local socket',
    url,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Replaces the password in a connection URL with `***`. Anything that is not a
 * parseable URL is passed through {@link redactText}.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.href;
  } catch {
    return redactText(raw);
  }
}

/**
 * Scrubs secrets from free text: the password part of any `scheme://user:pass@`
 * it contains, and every exact occurrence of the given secrets.
 */
export function redactText(text: string, secrets: Iterable<string | undefined> = []): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@]*@/gi, '$1***@');
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join('***');
  }
  return out;
}

/** Double-quotes an SQL identifier. */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw usage('Identifiers cannot contain NUL bytes.');
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quotes an SQL string literal (standard_conforming_strings on). */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw usage('Values cannot contain NUL bytes.');
  return `'${value.replace(/'/g, "''")}'`;
}
