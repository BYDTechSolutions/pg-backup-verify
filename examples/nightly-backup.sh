#!/bin/sh
# Take a backup and prove it restores before trusting it.
#
#   DATABASE_URL=postgres://app:secret@db.internal:5432/app ./examples/nightly-backup.sh /var/backups/app
#
# Needs pg_dump, pg_restore and psql on PATH, at the server's major version or
# newer, and a role that can read every table and has CREATEDB.
set -eu

out_dir="${1:-./backups}"
mkdir -p "$out_dir"
file="$out_dir/app-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --dbname "$DATABASE_URL" --format=custom --no-owner --no-privileges --file "$file"

# Rows written between the dump and the count show up as drift; allow a
# little of it on a busy database, or run this when writes are quiet.
if npx --yes @bydtech/pg-backup-verify "$file" --tolerance 0.1%; then
  echo "Backup verified: $file"
else
  status=$?
  echo "Backup NOT verified (exit $status): $file" >&2
  exit "$status"
fi
