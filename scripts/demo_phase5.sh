#!/usr/bin/env bash
set -euo pipefail
API=${API:-http://localhost:3000}; ENG=${ENG:-http://localhost:8001}
J='content-type: application/json'
post() { curl -fsS -X POST "$@"; }
field() { python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }
WS=$(post $API/v1/workspaces -H "$J" -d '{"name":"p5"}' | field workspace_id)
CH=$(post $API/v1/channels -H "x-workspace-id: $WS" -H "$J" -d '{"name":"english"}' | field channel_id)
B=$(post $API/v1/brains -H "x-workspace-id: $WS" -H "$J" -d '{"name":"h1","brain_type":"heuristic"}' | field brain_id)
V=$(post $API/v1/brains/$B/versions -H "x-workspace-id: $WS" -H "$J" -d '{}' | field brain_version_id)
post $API/v1/attachments -H "x-workspace-id: $WS" -H "$J" -d "{\"brain_id\":\"$B\",\"channel_id\":\"$CH\",\"brain_version_id\":\"$V\",\"role\":\"primary\"}" >/dev/null
echo "signals:"; post $API/v1/comment-signals -H "x-workspace-id: $WS" -H "$J" -d "{\"channel_id\":\"$CH\",\"signals\":[{\"commenter_id\":\"a\",\"topic\":\"IPL Final\"},{\"commenter_id\":\"b\",\"topic\":\"ipl, final?\"},{\"commenter_id\":\"c\",\"topic\":\"IPL final.\"}]}"; echo
echo "ranking:"; post $ENG/v1/runtime/execute -H "x-workspace-id: $WS" -H "$J" -d "{\"channel_id\":\"$CH\",\"candidates\":[{\"candidate_id\":\"a\",\"title\":\"Old match recap\"},{\"candidate_id\":\"b\",\"title\":\"IPL Final\"}]}" | python3 -m json.tool | head -14
echo "decisions:"; curl -fsS $API/v1/decisions -H "x-workspace-id: $WS"; echo
