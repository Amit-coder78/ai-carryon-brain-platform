#!/usr/bin/env bash
# Runs the Brain engine INSIDE a CI job: migrates an EPHEMERAL Postgres, seeds one workspace +
# channel + active heuristic Brain, starts the engine on 127.0.0.1, waits until it is ready, then
# publishes the connection settings for later steps. Nothing persists after the job ends.
#
# Env in:  DATABASE_URL (required, the ephemeral DB)   CHANNEL (default english)   PORT (default 8001)
#          SEMANTIC_ROLE  off | shadow (default) | supporting. How the semantic-neighbour Brain is attached next to the
#                         heuristic Brain: `shadow` runs and is reported but never changes the ranking, `supporting`
#                         lets it vote in rank fusion, `off` seeds only the heuristic Brain.
#          GITHUB_ENV (set by Actions; if absent the settings are printed as exports instead)
# Env out: BRAIN_ENGINE_URL, BRAIN_WORKSPACE_ID, BRAIN_CHANNEL_ID_<CHANNEL>
# The settings are only published AFTER the engine answers /v1/ready, so a failed start leaves the
# pipeline with the Brain simply switched off.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANNEL="${CHANNEL:-english}"
PORT="${PORT:-8001}"
: "${DATABASE_URL:?DATABASE_URL is required}"
case "$CHANNEL" in (*[!a-z0-9_]*|"") echo "CHANNEL must be lowercase letters, digits or _" >&2; exit 2;; esac
SEMANTIC_ROLE="${SEMANTIC_ROLE:-shadow}"
case "$SEMANTIC_ROLE" in (off|shadow|supporting) ;; (*) echo "SEMANTIC_ROLE must be off, shadow or supporting" >&2; exit 2;; esac

for i in $(seq 1 30); do
  psql "$DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "database not ready after 60s" >&2; exit 1; }
  sleep 2
done

"$ROOT/scripts/migrate.sh"

IDS="$(psql "$DATABASE_URL" -tA -F ' ' -v ON_ERROR_STOP=1 <<SQL
with w as (insert into workspaces(name) values ('ai-carryon-ci') returning workspace_id),
     c as (insert into channels(workspace_id, name) select workspace_id, '$CHANNEL' from w returning channel_id),
     b as (insert into brains(workspace_id, name, brain_type, status)
           select workspace_id, 'heuristic-v1', 'heuristic', 'active' from w returning brain_id),
     v as (insert into brain_versions(brain_id, version) select brain_id, 1 from b
           returning brain_id, brain_version_id),
     a as (insert into attachments(brain_id, channel_id, role, enabled, status, attached_version_id)
           select v.brain_id, c.channel_id, 'primary', true, 'active', v.brain_version_id from v, c returning 1)
select (select workspace_id from w), (select channel_id from c);
SQL
)"
if [ "$SEMANTIC_ROLE" != "off" ]; then
  # Second Brain: the semantic-neighbour estimator (pure function; the pipeline sends it the neighbour features).
  psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -v role="$SEMANTIC_ROLE" <<'SQL' >/dev/null
with b as (insert into brains(workspace_id, name, brain_type, status)
           select workspace_id, 'semantic-v1', 'semantic', 'active' from workspaces where name = 'ai-carryon-ci' returning brain_id),
     v as (insert into brain_versions(brain_id, version, params) select brain_id, 1, '{}'::jsonb from b
           returning brain_id, brain_version_id)
insert into attachments(brain_id, channel_id, role, enabled, status, attached_version_id)
select v.brain_id, c.channel_id, :'role', true, 'active', v.brain_version_id
from v, channels c join workspaces w on w.workspace_id = c.workspace_id where w.name = 'ai-carryon-ci';
SQL
fi
WORKSPACE_ID="${IDS%% *}"
CHANNEL_ID="${IDS##* }"
[ -n "$WORKSPACE_ID" ] && [ -n "$CHANNEL_ID" ] || { echo "seeding failed: '$IDS'" >&2; exit 1; }

python3 -m venv "$ROOT/.ci-venv"
"$ROOT/.ci-venv/bin/pip" install -q -r "$ROOT/services/engine/requirements.txt"
# Detach fully (own session, all three stdio streams redirected) so the step never waits on the engine.
cd "$ROOT/services/engine"
DATABASE_URL="$DATABASE_URL" setsid nohup "$ROOT/.ci-venv/bin/python" -m uvicorn app.main:app \
    --host 127.0.0.1 --port "$PORT" > "$ROOT/engine.log" 2>&1 < /dev/null &
cd "$ROOT"

for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/v1/ready" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "engine not ready after 30s:" >&2; tail -n 30 "$ROOT/engine.log" >&2; exit 1; }
  sleep 1
done

VAR="BRAIN_CHANNEL_ID_$(printf '%s' "$CHANNEL" | tr 'a-z' 'A-Z')"
if [ -n "${GITHUB_ENV:-}" ]; then
  { echo "BRAIN_ENGINE_URL=http://127.0.0.1:$PORT"; echo "BRAIN_WORKSPACE_ID=$WORKSPACE_ID"; echo "$VAR=$CHANNEL_ID"; } >> "$GITHUB_ENV"
else
  echo "export BRAIN_ENGINE_URL=http://127.0.0.1:$PORT BRAIN_WORKSPACE_ID=$WORKSPACE_ID $VAR=$CHANNEL_ID"
fi
echo "Brain engine ready (channel '$CHANNEL')."
