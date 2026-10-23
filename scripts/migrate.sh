#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:=postgresql://brain:brain@localhost:5432/brain}"
for f in db/migrations/*.sql; do echo "applying $f"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
