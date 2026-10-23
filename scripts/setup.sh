#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)"; MISSING=1; }; }
MISSING=0
need node "install Node 20+  (brew install node)"
need python3 "install Python 3.11+  (brew install python)"
need docker "install Docker Desktop (or use your own Postgres and edit DATABASE_URL in .env)"
need psql "brew install libpq && brew link --force libpq"
[ "$MISSING" = 1 ] && echo "install the above, then re-run make setup" && exit 1

[ -f .env ] || { cp .env.example .env; echo "created .env"; }

(cd services/api && npm install)

cd services/engine
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements-dev.txt
echo
echo "done. next:  make up && make migrate && make api   (engine: make engine)"
