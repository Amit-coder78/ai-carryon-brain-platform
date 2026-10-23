#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:=postgresql://brain:brain@localhost:5432/brain}"
psql "$DATABASE_URL" -q -c "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"
for f in db/migrations/*.sql; do
  n=$(basename "$f")
  if [ "$(psql "$DATABASE_URL" -tAc "select 1 from schema_migrations where name='$n'")" = "1" ]; then
    echo "skip $n"; continue
  fi
  echo "applying $n"
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" -c "insert into schema_migrations(name) values ('$n')"
done
