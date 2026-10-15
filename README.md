# @bydtech/pg-backup-verify

Prove a Postgres backup restores: restore the dump into a scratch database, compare every table's exact row count against the source, and drop the scratch database again.

[![npm](https://img.shields.io/npm/v/@bydtech/pg-backup-verify.svg)](https://www.npmjs.com/package/@bydtech/pg-backup-verify)
[![CI](https://github.com/BYDTechSolutions/pg-backup-verify/actions/workflows/ci.yml/badge.svg)](https://github.com/BYDTechSolutions/pg-backup-verify/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why it exists

A backup nobody has restored is a file, not a backup. The ways a dump goes bad are quiet: a disk fills and truncates it, a `pg_dump` run with the wrong flags leaves a table out, or the custom format is newer than the `pg_restore` you will have on the bad day. Each of those still looks like a perfectly good file. This tool does the restore now, on a scratch database next to the real one, and tells you whether what came back matches.

## Install

```sh
npm install --save-dev @bydtech/pg-backup-verify
# or run it without installing
npx @bydtech/pg-backup-verify --help
```

It needs Node 20 or newer and the PostgreSQL client tools (`psql`, plus `pg_restore` for anything but plain SQL) on PATH, at the server's major version or newer.

## Quick start

```sh
pg_dump --dbname "$DATABASE_URL" --format=custom --file app.dump
npx @bydtech/pg-backup-verify app.dump --source "$DATABASE_URL"
```

```
Dump     /home/app/app.dump  (custom, 3.4 KB, modified less than a minute ago)
Source   postgres://app:***@db.internal:5432/app  (Postgres 16.4)
Scratch  app_verify_20261016091502 on the same server  (dropped)
Restore  pg_restore 16.4: clean, 0.2 s

  table             restored  source  diff  status
  billing.invoices         7       7     0  ok
  public.users           100     100     0  ok

2 tables, 2 match. 107 rows restored, 107 in the source.

VERIFIED: the dump restored into a scratch database and every table matched the source.
```

When the source has changed since the dump, the counts say which way:

```
  public.users           100     101    -1  MISMATCH  restored fewer

note 1 table(s) restored FEWER rows than the source has now. The usual cause is rows added to the
source after the dump was taken (the dump file was last modified 3 h 5 min ago). If that is
expected, allow it with --tolerance; otherwise take a fresh dump and verify that one.
```

## CLI

```
pg-backup-verify <dump> [--source <postgres-url>] [options]
```

`<dump>` is a custom-format file, a tar file, a directory dump, or plain SQL. The format is detected from the contents, not the file name.

| Option | What it does |
|---|---|
| `--source <url>` | The database the dump was taken from. Default: `$DATABASE_URL`. |
| `--no-source` | Only prove the dump restores, and print its counts. A server is still needed: `--scratch-url`, `--source` or `$DATABASE_URL`. |
| `--scratch-url <url>` | Create the scratch database on this server instead of the source's. Its database (default `postgres`) is only connected to for `CREATE DATABASE` / `DROP DATABASE`; the dump is never restored into it. |
| `--keep` | Leave the scratch database in place to inspect it. Its name is printed. |
| `--schema <name>` | Compare only this schema. Repeatable. |
| `--exclude-table <glob>` | Skip matching tables. `audit_*` matches the table name in any schema; `public.sessions` or `*.tmp_?` match `schema.table`. Repeatable. |
| `--tolerance <n\|n%>` | Allowed difference per table: a number of rows, or a percentage of the source count. |
| `--allow-restore-warnings` | Accept a restore that reported errors or warnings, as long as the counts match. |
| `--jobs <n>` | Parallel `pg_restore` jobs (custom and directory dumps). |
| `--pg-bin <dir>` | Directory holding `psql` and `pg_restore`, when the ones on PATH are the wrong version. |
| `--json` | Print the report as JSON on stdout (progress messages are not printed). |
| `-h`, `--help` / `-v`, `--version` | Help and version. |

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Verified: the restore was clean and every table is within tolerance. With `--no-source`: the restore was clean and produced tables. |
| `1` | Not verified: counts differ, a table is missing on one side, or the restore failed. |
| `2` | Could not tell: bad options, no `psql`/`pg_restore`, the server cannot be reached, or no permission to create a database. |
| `130` / `143` | Interrupted by SIGINT / SIGTERM. The scratch database is dropped before exiting; a second signal exits at once. |

Text output goes to stdout and progress to stderr. Colors are used on a terminal and turned off by `NO_COLOR`.

## API

```ts
import { verifyBackup, formatReport, VerifyError } from '@bydtech/pg-backup-verify';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

try {
  const report = await verifyBackup({
    dump: 'backups/app.dump',
    source: process.env.DATABASE_URL,
    tolerance: '0.1%',
    signal: controller.signal,
    onProgress: (message) => console.error(message),
  });
  console.log(formatReport(report));
  if (!report.ok) process.exitCode = 1;
} catch (err) {
  if (err instanceof VerifyError) console.error(err.code, err.message); // USAGE | ENVIRONMENT | ABORTED
  else throw err;
}
```

### `verifyBackup(options): Promise<Report>`

Resolves with a report whether or not the backup verified; check `report.ok`. It rejects only when no verdict is possible, with a `VerifyError` whose `code` is `USAGE` (bad options), `ENVIRONMENT` (missing binaries, unreachable server, no CREATEDB) or `ABORTED` (the signal fired; `err.scratchDropped` says whether the scratch database was dropped).

The `Report` holds:

| Field | Contents |
|---|---|
| `ok`, `verdict` | `verdict` is `verified`, `mismatch` or `restore-failed`. |
| `dump` | `path`, `format`, `sizeBytes`, `modifiedAt`, `archiveVersion` (from a custom or directory dump's header). |
| `source` | Redacted `url`, `database`, `serverVersion`. `null` with `noSource`. |
| `scratch` | Redacted `url`, `database`, `serverVersion`, `sameServerAsSource`, `kept`, `dropped`, `dropError`. |
| `restore` | `tool`, `clientVersion`, `status` (`clean`, `with-errors`, `failed`), `exitCode`, every `errors` and `warnings` message, a `hint` for well-known failures, `durationMs`. |
| `tables` | One entry per table: `schema`, `table`, `restored`, `source`, `difference` (restored minus source), `status`, `ok`. |
| `summary` | Counts per status, and total rows on each side. |
| `notes` | Version warnings, and plain-language explanations of any drift. |
| `tolerance`, `startedAt`, `durationMs` | As run. |

A table's `status` is `match`, `within-tolerance`, `restored-fewer`, `restored-more`, `missing-in-restore`, `missing-in-source`, or `restored` (with `noSource`).

Also exported: `formatReport(report, { color?, maxMessages? })` renders the CLI's text, `redactUrl(url)` hides a URL's password, and `parseTolerance(input)` parses `"10"` or `"0.5%"`.

## Configuration

| API option | CLI flag | Default |
|---|---|---|
| `dump` | `<dump>` | required |
| `source` | `--source` | `env.DATABASE_URL` |
| `noSource` | `--no-source` | `false` |
| `scratchUrl` | `--scratch-url` | the source's server; database `postgres` when the URL names none |
| `keep` | `--keep` | `false` |
| `schemas` | `--schema` | every schema except `pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp_*` |
| `excludeTables` | `--exclude-table` | none |
| `tolerance` | `--tolerance` | `0` rows |
| `allowRestoreWarnings` | `--allow-restore-warnings` | `false` |
| `jobs` | `--jobs` | `1` |
| `pgBin` | `--pg-bin` | PATH |
| `signal` | (SIGINT, SIGTERM) | none |
| `onProgress` | (stderr) | none |
| `env` | (process environment) | `process.env` |

Connection URLs are `postgres://` or `postgresql://` URLs, and their query parameters (`sslmode`, `sslrootcert`, `host` for a Unix socket, and so on) are passed to libpq unchanged. A URL without a password falls back to `PGPASSWORD` or `~/.pgpass`, as `psql` would.

The role needs to read every table in the source, and `CREATEDB` on the server that hosts the scratch database.

## How it works

1. **Reads the dump's first bytes.** Custom-format files start with `PGDMP`, directory dumps hold a `toc.dat`, tar archives carry `ustar` at byte 257; any other text is plain SQL. Compressed files (`.sql.gz` and friends) are refused with a message to decompress them first. A plain dump is scanned for `\connect`, `CREATE DATABASE` and similar lines and refused if it has them: that is `pg_dumpall` output or a `--create` dump, and `psql` would run it against the real database, not the scratch one.
2. **Checks the client tools** (`psql --version`, `pg_restore --version`) before touching any server, and warns when the client's major version is older than the server's. An old `pg_restore` cannot read a newer archive (`unsupported version (1.15) in file header`); when that happens the report says so in plain words.
3. **Counts the source**: lists every ordinary table (partitions included) outside the system schemas, applies `--schema` and `--exclude-table`, and runs an exact `count(*)` per table in one round trip. Counts are exact, not `pg_stat` estimates, which read 0 on a freshly restored table until it is analyzed.
4. **Creates `<db>_verify_<UTC timestamp>`** from `template0`, on the source's server or on `--scratch-url`. It never drops a database it did not create, and the name cannot be the source's.
5. **Restores** with `pg_restore --no-owner --no-privileges` (archives) or `psql -X -v ON_ERROR_STOP=1` (plain SQL). `pg_restore` carries on past failed statements and exits non-zero at the end; every error and warning it prints is kept, and a restore that reported any fails verification unless `--allow-restore-warnings` is given. A `pg_restore` that stopped early (truncated or corrupted file) always fails.
6. **Counts the scratch database** the same way, and compares table by table: same count, within tolerance, fewer or more rows (with the direction explained), or present on one side only.
7. **Drops the scratch database** in a `finally` block, so also after an error or an abort. It ends any session still connected to it first (an interrupted restore can leave one), and uses `DROP DATABASE ... WITH (FORCE)` on Postgres 13 and newer. With `--keep` it is left in place.

**Why `psql` and not the `pg` package.** The restore has to shell out to `pg_restore` or `psql` anyway, so the client tools are a hard requirement already. Using `psql` for the handful of queries as well means no runtime dependencies at all, and one connection path: `sslmode`, client certificates, `~/.pgpass`, service files and Unix sockets behave the same for the counts as for the restore, so a URL that works for one works for the other. The queries ask Postgres for JSON (`json_agg`) rather than parsing `psql`'s table output. The cost is a process start per query, about eight per run.

**Passwords** never reach a command line (where `ps` would show them): the URL is passed without its password, and the password goes to `psql` and `pg_restore` in `PGPASSWORD`. Every URL printed, in text, JSON or error messages, has its password replaced by `***`, and the password is scrubbed from any tool output that is passed through.

### Limits

- **Row counts, not contents.** A dump with the right number of rows and wrong values passes. This proves the dump restores and is complete table by table; it does not diff data.
- **The source is counted now, not when the dump was taken.** On a database that takes writes, some drift is expected. That is what `--tolerance` and the direction of each difference are for; for an exact check, verify a dump taken while writes are paused, or restore-and-compare against a replica stopped at the dump's point in time.
- **Only ordinary tables are counted.** Views, materialized views, sequences' current values, large objects and foreign tables are not compared (their definitions are restored; a failure restoring them shows up as a restore error). A partitioned table is compared through its partitions.
- **Row-level security** applies to the counting role. Count the source as the tables' owner or a role with `BYPASSRLS`, or the counts will be of the rows that role can see.
- **Ownership and grants are not verified**: the restore runs with `--no-owner --no-privileges`, so a dump restores without its roles existing on the scratch server.
- **The scratch database uses the server's default encoding and locale** (it is created from `template0`). Extensions the dump needs must be installable there.
- **Exact counts read every row.** On a large database that is real load on the source; run it off-peak, and use `--scratch-url` to keep the restore's load off the source's server.
- **A plain dump is SQL, and `psql` runs it.** Only verify plain dumps you trust; the `\connect` check stops the obvious ways out of the scratch database, not a dump written to do harm. Plain dumps from current `pg_dump` releases contain `\restrict`, which older `psql` builds do not understand; use a current client.
- Tested on macOS and Linux. Windows has not been tested.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

Maintained by [BYD Tech](https://bydtech.in), a software studio that builds MVPs, AI agents, and web & mobile apps.
