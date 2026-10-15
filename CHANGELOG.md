# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-16

### Added

- `pg-backup-verify <dump>` CLI and `verifyBackup()` API: restore a dump into a
  scratch database named `<db>_verify_<timestamp>`, compare exact row counts
  for every table against the source, and drop the scratch database in a
  `finally` block and on SIGINT/SIGTERM (or keep it with `--keep`).
- Custom, directory, tar and plain SQL dumps, detected from their contents.
  Plain dumps that `\connect` or `CREATE DATABASE` are refused.
- Restore errors and warnings reported in full; a restore with any of them
  fails unless `--allow-restore-warnings`.
- `--tolerance` in rows or percent, the direction of every difference, tables
  present on one side only, `--schema`, `--exclude-table`, `--no-source`,
  `--scratch-url`, `--jobs` and `--pg-bin`.
- Text and `--json` output; exit codes 0 (verified), 1 (not verified), 2
  (usage or environment error). Passwords are kept off command lines and out
  of all output.

[Unreleased]: https://github.com/BYDTechSolutions/pg-backup-verify/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BYDTechSolutions/pg-backup-verify/releases/tag/v0.1.0
