#!/usr/bin/env bash
# Package signing demo: a signed export, import, a forger who fixes every checksum, and strict mode.
# Needs the API on :3000 started WITH a signing key (source ~/.brain-signing-env && make api). The engine is not needed.
# It starts a second, strict API on :3010 (requires signatures, trusts only your key) and stops it when done.
set -euo pipefail
cd "$(dirname "$0")/.."
API=${API:-http://localhost:3000}; STRICT_PORT=${STRICT_PORT:-3010}; STRICT=http://localhost:$STRICT_PORT
J='content-type: application/json'
post() { curl -fsS -X POST "$@"; }
field() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
jfield() { python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)$1))"; }
sig_of() { python3 -c "import sys,json;d=json.load(sys.stdin);ch=d.get('checks') or d['details']['checks'];print(' ',d.get('code','imported'),[c['name']+':'+c['status']+(('/'+c['result']) if c['name']=='signature' and c.get('result') else '') for c in ch if c['name'] in ('checksums','signature')])"; }
body() { python3 -c "import json,sys;print(json.dumps({'package':json.load(open(sys.argv[1]))}))" "$1"; }

S=$(curl -fsS $API/v1/signing) || { echo "API not reachable on $API (run: source ~/.brain-signing-env && make api)"; exit 1; }
[ "$(echo "$S" | field "['can_sign']")" = "True" ] || { echo "this API has no signing key. Run: source ~/.brain-signing-env && make api"; exit 1; }
KEY_ID=$(echo "$S" | field "['key_id']")

STRICT_PID=""; trap '[ -n "$STRICT_PID" ] && kill $STRICT_PID 2>/dev/null || true' EXIT
env -u BRAIN_SIGNING_KEY API_PORT=$STRICT_PORT BRAIN_TRUSTED_KEYS=$KEY_ID BRAIN_REQUIRE_SIGNATURE=1 \
  node services/api/src/server.js >/tmp/sd-strict.log 2>&1 & STRICT_PID=$!
for _ in $(seq 1 40); do curl -fsS $STRICT/v1/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS $STRICT/v1/health >/dev/null 2>&1 || { echo "strict API did not start (is :$STRICT_PORT free?). Log:"; cat /tmp/sd-strict.log; exit 1; }

WS_A=$(post $API/v1/workspaces -H "$J" -d '{"name":"sig-source-'$RANDOM'"}' | field "['workspace_id']")
WS_B=$(post $API/v1/workspaces -H "$J" -d '{"name":"sig-destination-'$RANDOM'"}' | field "['workspace_id']")
B=$(post $API/v1/brains -H "x-workspace-id: $WS_A" -H "$J" -d '{"name":"demand-1","brain_type":"demand"}' | field "['brain_id']")
post $API/v1/brains/$B/versions -H "x-workspace-id: $WS_A" -H "$J" -d '{"capabilities":["rank"]}' >/dev/null

echo "this registry signs as key ${KEY_ID:0:16}...; the strict registry (:$STRICT_PORT) trusts only that key and requires signatures"

echo "1. export: the package carries a signature over its hash:"
post $API/v1/brains/$B/export -H "x-workspace-id: $WS_A" -H "$J" -d '{}' | jfield "['package']" > /tmp/sd-signed.json
python3 -c "import json;p=json.load(open('/tmp/sd-signed.json'));s=p['signature'];print('  alg',s['alg'],'signed by',s['key_id'][:16]+'...','sealed hash',p['package_sha256'][:16]+'...')"

echo "2. dry-run import (nothing created): the signature is valid and trusted:"
python3 -c "import json,sys;print(json.dumps({'package':json.load(open('/tmp/sd-signed.json')),'dry_run':True}))" > /tmp/sd-dry.json
post $API/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/sd-dry.json | python3 -c "import sys,json;d=json.load(sys.stdin);c=[c for c in d['checks'] if c['name']=='signature'][0];print(' ',c['result'],c['signer']['trusted'] and 'trusted' or 'untrusted')"

echo "3. real import into the strict registry: accepted, and the Brain remembers who signed it:"
body /tmp/sd-signed.json > /tmp/sd-import.json
post $STRICT/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/sd-import.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('  status',d['brain']['status'],'origin.signature =',{k:(v[:16]+'...' if k=='key_id' else v) for k,v in d['brain']['origin']['signature'].items()})"

echo "4. a forger edits the package and fixes every checksum. Checksums alone would pass it:"
python3 - <<'PY'
import json, hashlib
canon = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
p = json.load(open('/tmp/sd-signed.json'))
p['files']['brain.json']['versions'][0]['capabilities'].append('extra')
for f in p['manifest']['files']:
    s = canon(p['files'][f['path']]); f['sha256'] = sha(s); f['size'] = len(s.encode())
p['package_sha256'] = sha(canon(p['manifest']))
json.dump(p, open('/tmp/sd-forged.json', 'w'))
PY
body /tmp/sd-forged.json > /tmp/sd-forged-body.json
curl -s -X POST $API/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/sd-forged-body.json | sig_of

echo "5. the same package with its signature removed (unsigned): the normal registry accepts it, the strict one refuses:"
python3 -c "import json;p=json.load(open('/tmp/sd-signed.json'));p.pop('signature');json.dump(p,open('/tmp/sd-unsigned.json','w'))"
body /tmp/sd-unsigned.json > /tmp/sd-unsigned-body.json
python3 -c "import json;print(json.dumps({**json.load(open('/tmp/sd-unsigned-body.json')),'dry_run':True}))" > /tmp/sd-unsigned-dry.json
echo -n "  normal (:3000): "; curl -s -X POST $API/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/sd-unsigned-dry.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('dry run valid =',d['valid'],'(unsigned)')"
echo -n "  strict (:$STRICT_PORT):"; curl -s -X POST $STRICT/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/sd-unsigned-body.json | sig_of

echo "6. signed by a stranger's key (valid signature, key not trusted): the strict registry refuses it:"
node --input-type=module -e "
import fs from 'node:fs';
const { generateSigningKey, loadSigningKey, signPackage } = await import('./services/api/src/signing.js');
const p = JSON.parse(fs.readFileSync('/tmp/sd-unsigned.json', 'utf8'));
const stranger = loadSigningKey(generateSigningKey().private_key);
fs.writeFileSync('/tmp/sd-stranger.json', JSON.stringify({ package: signPackage(p, stranger) }));"
curl -s -X POST $STRICT/v1/brains/import -H "x-workspace-id: $WS_B" -H "$J" -d @/tmp/sd-stranger.json | python3 -c "import sys,json;d=json.load(sys.stdin);c=[c for c in d['details']['checks'] if c['name']=='signature'][0];print(' ',d['code'],c['result'],'trusted =',c['signer']['trusted'])"

echo "audit (destination workspace):"
curl -fsS $API/v1/audit -H "x-workspace-id: $WS_B" | python3 -c "import sys,json;print(' ',[x['action'] for x in reversed(json.load(sys.stdin)['items'])])"
