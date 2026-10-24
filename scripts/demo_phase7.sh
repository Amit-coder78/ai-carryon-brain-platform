#!/usr/bin/env bash
# Phase 7 demo: clone, export -> import across workspaces, archive and delete with dependency checks.
# Needs the API on :3000 and the engine on :8001 (make api, make engine).
set -euo pipefail
API=${API:-http://localhost:3000}; ENG=${ENG:-http://localhost:8001}
J='content-type: application/json'
post() { curl -fsS -X POST "$@"; }
field() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
jfield() { python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)$1))"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

WS_A=$(post $API/v1/workspaces -H "$J" -d '{"name":"p7-source"}' | field "['workspace_id']")
WS_B=$(post $API/v1/workspaces -H "$J" -d '{"name":"p7-destination"}' | field "['workspace_id']")
CH_B=$(post $API/v1/channels -H "x-workspace-id: $WS_B" -H "$J" -d '{"name":"english"}' | field "['channel_id']")
B=$(post $API/v1/brains -H "x-workspace-id: $WS_A" -H "$J" -d '{"name":"h1","brain_type":"heuristic"}' | field "['brain_id']")
post $API/v1/brains/$B/versions -H "x-workspace-id: $WS_A" -H "$J" -d '{"capabilities":["rank"]}' >/dev/null

echo "1. clone (copies the latest version, never the attachments):"
post $API/v1/brains/$B/clone -H "x-workspace-id: $WS_A" -H "$J" -d '{"name":"h1-copy"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(' ',d['brain']['name'],d['brain']['status'],'origin=',d['brain']['origin']['kind'],'versions=',len(d['versions']))"

echo "2. export from workspace A, dry-run import into workspace B:"
post $API/v1/brains/$B/export -H "x-workspace-id: $WS_A" -H "$J" -d '{}' | jfield "['package']" > /tmp/p7-package.json
python3 -c "import json;p=json.load(open('/tmp/p7-package.json'));print('  package_sha256',p['package_sha256'][:16]+'...','files',[f['path'] for f in p['manifest']['files']])"
python3 -c "import json;print(json.dumps({'package':json.load(open('/tmp/p7-package.json')),'dry_run':True}))" > /tmp/p7-dry.json
post $API/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/p7-dry.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('  checks',[(c['name'],c['status']) for c in d['checks']],'name_available',d['name_available'])"

echo "3. real import: the Brain arrives inactive (draft), then attach it and rank:"
python3 -c "import json;print(json.dumps({'package':json.load(open('/tmp/p7-package.json'))}))" > /tmp/p7-import.json
IMP=$(post $API/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/p7-import.json)
BI=$(echo "$IMP" | field "['brain']['brain_id']"); VI=$(echo "$IMP" | field "['versions'][0]['brain_version_id']")
echo "  status after import: $(echo "$IMP" | field "['brain']['status']")"
post $API/v1/attachments -H "x-workspace-id: $WS_B" -H "$J" -d "{\"brain_id\":\"$BI\",\"channel_id\":\"$CH_B\",\"brain_version_id\":\"$VI\",\"role\":\"primary\"}" >/dev/null
echo "  status after attach: $(curl -fsS $API/v1/brains/$BI -H "x-workspace-id: $WS_B" | field "['status']")"
post $ENG/v1/runtime/execute -H "x-workspace-id: $WS_B" -H "$J" -d "{\"channel_id\":\"$CH_B\",\"candidates\":[{\"candidate_id\":\"hot\",\"features\":{\"unique_requesters\":80,\"similar_requests\":40,\"days_since_trend\":1}},{\"candidate_id\":\"cold\",\"features\":{\"unique_requesters\":1,\"similar_requests\":1,\"days_since_trend\":60}}]}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('  source:',d['source'],'ranked:',[r['candidate_id'] for r in d['ranked']])"

echo "4. a tampered package is refused and creates nothing:"
python3 -c "import json;p=json.load(open('/tmp/p7-package.json'));p['files']['brain.json']['versions'][0]['capabilities'].append('extra');print(json.dumps({'package':p}))" > /tmp/p7-bad.json
curl -s -X POST $API/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/p7-bad.json | python3 -c "import sys,json;d=json.load(sys.stdin);print(' ',d['code'],[c['name']+':'+c['status'] for c in d['details']['checks']])"

echo "5. dependencies, then archive and delete:"
curl -fsS $API/v1/brains/$BI/dependencies -H "x-workspace-id: $WS_B" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  bindings',len(d['bindings']),'archive',d['archive'],'delete',d['delete']['allowed'])"
echo "  delete while active: HTTP $(code -X DELETE $API/v1/brains/$BI -H "x-workspace-id: $WS_B")"
echo "  archive without detach: HTTP $(code -X POST $API/v1/brains/$BI/archive -H "x-workspace-id: $WS_B" -H "$J" -d '{}')"
post $API/v1/brains/$BI/archive -H "x-workspace-id: $WS_B" -H "$J" -d '{"detach_attachments":true}' | field "['status']"
echo "  delete after archive: HTTP $(code -X DELETE $API/v1/brains/$BI -H "x-workspace-id: $WS_B")"
R=$(post $ENG/v1/runtime/execute -H "x-workspace-id: $WS_B" -H "$J" -d "{\"channel_id\":\"$CH_B\",\"candidates\":[{\"candidate_id\":\"a\",\"title\":\"any topic\",\"features\":{}}]}" | field "['source']")
echo "  ranking now falls back: $R"
echo "audit:"; curl -fsS $API/v1/audit -H "x-workspace-id: $WS_B" | python3 -c "import sys,json;print(' ',[x['action'] for x in reversed(json.load(sys.stdin)['items'])])"
