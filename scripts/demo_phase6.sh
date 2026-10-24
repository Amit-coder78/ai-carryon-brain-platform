#!/usr/bin/env bash
# Phase 6 demo: the demand Brain (demand-v1) end to end.
# Shows: one person counts once, fewer than 3 people score 0, old demand fades, and the Brain abstains when
# nobody has enough demand. Needs the API on :3000 and the engine on :8001 (make api, make engine).
set -euo pipefail
API=${API:-http://localhost:3000}; ENG=${ENG:-http://localhost:8001}
J='content-type: application/json'
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
post() { curl -fsS -X POST "$@"; }
field() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

WS=$(post $API/v1/workspaces -H "$J" -d '{"name":"p6-demo"}' | field "['workspace_id']")
CH=$(post $API/v1/channels -H "x-workspace-id: $WS" -H "$J" -d '{"name":"english"}' | field "['channel_id']")
attach() { # name type role
  local b v
  b=$(post $API/v1/brains -H "x-workspace-id: $WS" -H "$J" -d "{\"name\":\"$1\",\"brain_type\":\"$2\"}" | field "['brain_id']")
  v=$(post $API/v1/brains/$b/versions -H "x-workspace-id: $WS" -H "$J" -d '{}' | field "['brain_version_id']")
  post $API/v1/attachments -H "x-workspace-id: $WS" -H "$J" -d "{\"brain_id\":\"$b\",\"channel_id\":\"$CH\",\"brain_version_id\":\"$v\",\"role\":\"$3\"}" >/dev/null
  echo "$b"
}
DEMAND=$(attach demand-1 demand primary)
attach heuristic-1 heuristic supporting >/dev/null
echo "attached: demand Brain (primary) + heuristic Brain (supporting)"

# Signals: who asked for what, and when. Each person is a salted hash in the database, never a name.
python3 - "$CH" > "$T/signals.json" <<'PY'
import sys, json, datetime as dt
now = dt.datetime.now(dt.timezone.utc)
old = (now - dt.timedelta(days=28)).isoformat()
s = []
s += [{"commenter_id": f"fresh-{i}", "topic": "Build AI agents"} for i in range(12)]            # 12 people, today
s += [{"commenter_id": f"old-{i}", "topic": "Old trend topic", "observed_at": old} for i in range(12)]   # 12 people, 4 weeks ago
s += [{"commenter_id": "spammer", "topic": "Spam topic"} for _ in range(50)]                       # 1 person, 50 comments
s += [{"commenter_id": "a", "topic": "Tiny topic"}, {"commenter_id": "b", "topic": "Tiny topic"}]   # 2 people
print(json.dumps({"channel_id": sys.argv[1], "signals": s}))
PY
echo "signals sent:"; post $API/v1/comment-signals -H "x-workspace-id: $WS" -H "$J" -d @"$T/signals.json"; echo

show() { # prints the demand Brain's own view and the fused ranking
  python3 -c "
import sys, json
d = json.load(sys.stdin); demand = '$DEMAND'
titles = {c['candidate_id']: c['title'] for c in json.load(open('$T/cands.json'))['candidates']}
b = next(x for x in d['brains'] if x['brain_id'] == demand)
print('  source:', d['source'], '| demand Brain status:', b['status'])
print('  %-18s %7s %6s  %s' % ('topic', 'score', 'conf', 'reason codes'))
for r in b['recommendations']:
    print('  %-18s %7.3f %6.2f  %s' % (titles[r['candidate_id']], r['score'], r['confidence'], ', '.join(r['reason_codes']) or '-'))
print('  fused ranking:', [(titles[r['candidate_id']], r['aggregate_score'], ','.join(r['reason_codes'])) for r in d['ranked']])
"
}
run() { post $ENG/v1/runtime/execute -H "x-workspace-id: $WS" -H "$J" -d @"$T/cands.json" | show; }

python3 - "$CH" > "$T/cands.json" <<'PY'
import sys, json
t = ["Build AI agents", "Old trend topic", "Spam topic", "Tiny topic"]
print(json.dumps({"channel_id": sys.argv[1], "candidates": [{"candidate_id": f"t{i}", "title": x} for i, x in enumerate(t)]}))
PY
echo; echo "1. rank four topics (12 fresh people, 12 people 4 weeks ago, 1 person x50, 2 people):"
run

python3 - "$CH" > "$T/cands.json" <<'PY'
import sys, json
t = ["Spam topic", "Tiny topic"]
print(json.dumps({"channel_id": sys.argv[1], "candidates": [{"candidate_id": f"t{i}", "title": x} for i, x in enumerate(t)]}))
PY
echo; echo "2. only weak topics: the demand Brain abstains (all scores 0), so only the heuristic Brain votes."
echo "   Look at the fused scores: about half of step 1, because one Brain voted instead of two."
run
echo; echo "decisions recorded (each stores the Brain versions and the policy used):"
curl -fsS $API/v1/decisions -H "x-workspace-id: $WS" | python3 -c "import sys,json;[print(' ',x['decision_id'][:8],x['source'],x['policy_version']) for x in json.load(sys.stdin)['items']]"
