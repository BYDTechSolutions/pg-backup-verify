# Security

This tool connects to production databases with credentials, creates and
drops databases, and runs `psql` on plain SQL dumps. Reports about any of that
going wrong are very welcome.

## Reporting a vulnerability

Email **sales.bydtech@gmail.com** with "pg-backup-verify security" in the
subject, or use GitHub's private vulnerability reporting on this repository.
Please do not open a public issue for a vulnerability. Expect an
acknowledgment, and credit in the release notes if you would like it.

Especially in scope:

- A password appearing in output, logs, JSON, error messages or a process's
  command line.
- The tool dropping, or writing to, any database other than the scratch
  database it created.
- A dump escaping the scratch database during a restore.

## Supported versions

Only the latest release receives fixes.
