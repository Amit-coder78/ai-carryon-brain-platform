import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { canonical, sha256 } from "./package.js";
import { generateSigningKey, signingConfigFromEnv } from "./signing.js";

const pool = createPool();
let dbUp = true;
try { await pool.query("select 1 from brain_exports limit 1"); } catch { dbUp = false; }
const opts = { skip: dbUp ? false : "database not reachable or not migrated (run make up && make migrate)" };

const keyA = generateSigningKey();
const keyB = generateSigningKey();

// Three registries over one database, differing only in signing policy.
function registry(env) {
  const server = createApp({ pool, checkDb: () => pool.query("select 1"), signing: signingConfigFromEnv(env) }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  test.after(() => server.close());
  return async function call(method, path, { ws, body } = {}) {
    const r = await fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(ws ? { "x-workspace-id": ws } : {}), "x-actor": "test" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
}
const lenient = registry({});                                                     // cannot sign, signatures optional
const signer = registry({ BRAIN_SIGNING_KEY: keyA.private_key });                 // signs with A, trusts A
const strict = registry({ BRAIN_TRUSTED_KEYS: keyA.key_id, BRAIN_REQUIRE_SIGNATURE: "1" });   // trusts A only, requires it
const strictB = registry({ BRAIN_TRUSTED_KEYS: keyB.key_id, BRAIN_REQUIRE_SIGNATURE: "1" });  // trusts B only
test.after(async () => { await pool.end(); });

const uniq = () => Math.random().toString(36).slice(2, 10);
const newWs = async () => (await lenient("POST", "/workspaces", { body: { name: "ws-" + uniq() } })).body.workspace_id;
async function seed(ws) {
  const brain = (await lenient("POST", "/brains", { ws, body: { name: "demand-" + uniq(), brain_type: "demand" } })).body;
  await lenient("POST", `/brains/${brain.brain_id}/versions`, { ws, body: { capabilities: ["rank"], checksum: "c1" } });
  return brain;
}
const count = async (ws) => (await lenient("GET", "/brains", { ws })).body.items.length;
const versionCount = async (ws, id) => (await lenient("GET", `/brains/${id}/versions`, { ws })).body.items.length;
const actions = async (ws) => (await lenient("GET", "/audit", { ws })).body.items.map((x) => x.action);
const sigCheck = (r) => r.body.checks.find((c) => c.name === "signature");
function reseal(pkg) {   // a forger who fixes every checksum
  pkg.manifest.files = pkg.manifest.files.map((f) => {
    const s = canonical(pkg.files[f.path]);
    return { path: f.path, sha256: sha256(s), size: Buffer.byteLength(s) };
  });
  pkg.package_sha256 = sha256(canonical(pkg.manifest));
  return pkg;
}
const exportOf = async (call, ws, brain) => (await call("POST", `/brains/${brain.brain_id}/export`, { ws, body: {} })).body.package;

test("GET /signing says who can sign and whom to trust, and never returns a private key", opts, async () => {
  const s = (await signer("GET", "/signing")).body;
  assert.equal(s.can_sign, true);
  assert.equal(s.key_id, keyA.key_id);
  assert.equal(s.public_key, keyA.public_key);
  assert.deepEqual(s.trusted_key_ids, [keyA.key_id]);
  assert.ok(!JSON.stringify(s).includes(keyA.private_key));
  const l = (await lenient("GET", "/signing")).body;
  assert.deepEqual([l.can_sign, l.key_id, l.require_signature], [false, null, false]);
  assert.equal((await strict("GET", "/signing")).body.require_signature, true);
});

test("a registry with a key signs its exports; one without a key exports unsigned; the audit says who signed", opts, async () => {
  const ws = await newWs();
  const brain = await seed(ws);
  const signed = await exportOf(signer, ws, brain);
  assert.equal(signed.signature.key_id, keyA.key_id);
  assert.equal(signed.signature.alg, "ed25519");
  assert.equal((await exportOf(lenient, ws, brain)).signature, undefined);
  const log = (await lenient("GET", "/audit", { ws })).body.items.filter((x) => x.action === "brain.export");
  assert.deepEqual(log.map((x) => x.detail.signed_by).sort(), [null, keyA.key_id].sort());
});

test("round trip: a signed package imports into a registry that trusts the signer, and the Brain records who signed it", opts, async () => {
  const ws = await newWs();
  const pkg = await exportOf(signer, ws, await seed(ws));
  const ws2 = await newWs();
  const dry = await strict("POST", "/brains/import", { ws: ws2, body: { package: pkg, dry_run: true } });
  assert.equal(dry.status, 200);
  assert.deepEqual([sigCheck(dry).status, sigCheck(dry).result, sigCheck(dry).signer], ["ok", "valid", { key_id: keyA.key_id, trusted: true }]);
  assert.equal(await count(ws2), 0, "dry run creates nothing");
  const imp = await strict("POST", "/brains/import", { ws: ws2, body: { package: pkg } });
  assert.equal(imp.status, 201);
  assert.deepEqual(imp.body.brain.origin.signature, { key_id: keyA.key_id, trusted: true });
  const audit = (await lenient("GET", "/audit", { ws: ws2 })).body.items.find((x) => x.action === "brain.import");
  assert.equal(audit.detail.signature.key_id, keyA.key_id);
});

test("a registry that requires signatures refuses an unsigned package, and nothing is created", opts, async () => {
  const ws = await newWs();
  const pkg = await exportOf(lenient, ws, await seed(ws));
  const ws2 = await newWs();
  const r = await strict("POST", "/brains/import", { ws: ws2, body: { package: pkg } });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "invalid_package");
  assert.equal(r.body.details.checks.find((c) => c.name === "signature").result, "unsigned");
  assert.equal(await count(ws2), 0);
  assert.ok((await actions(ws2)).includes("brain.import.rejected"));
  assert.equal((await lenient("POST", "/brains/import", { ws: ws2, body: { package: pkg } })).status, 201, "an optional-signature registry still accepts it");
});

test("a valid signature from a key the registry does not trust is refused when signatures are required", opts, async () => {
  const ws = await newWs();
  const pkg = await exportOf(signer, ws, await seed(ws));   // signed by A
  const ws2 = await newWs();
  const r = await strictB("POST", "/brains/import", { ws: ws2, body: { package: pkg } });   // trusts only B
  assert.equal(r.status, 422);
  const c = r.body.details.checks.find((x) => x.name === "signature");
  assert.deepEqual([c.result, c.signer.trusted], ["valid", false]);
  assert.equal(await count(ws2), 0);
});

test("an edited, re-sealed signed package is refused even where signatures are optional", opts, async () => {
  const ws = await newWs();
  const pkg = await exportOf(signer, ws, await seed(ws));
  pkg.files["brain.json"].versions[0].capabilities.push("exfiltrate");
  reseal(pkg);
  const ws2 = await newWs();
  const r = await lenient("POST", "/brains/import", { ws: ws2, body: { package: pkg } });
  assert.equal(r.status, 422);
  const checks = r.body.details.checks;
  assert.deepEqual(checks.filter((c) => c.status === "failed").map((c) => c.name), ["signature"]);
  assert.equal(checks.find((c) => c.name === "signature").result, "invalid");
  assert.equal(await count(ws2), 0);
});

test("a package that fails an earlier check is not examined for a signature", opts, async () => {
  const ws = await newWs();
  const pkg = await exportOf(signer, ws, await seed(ws));
  pkg.files["brain.json"].name = "edited without re-sealing";
  const r = await strict("POST", "/brains/import", { ws: await newWs(), body: { package: pkg } });
  assert.equal(r.status, 422);
  const by = Object.fromEntries(r.body.details.checks.map((c) => [c.name, c.status]));
  assert.deepEqual([by.checksums, by.signature], ["failed", "skipped"]);
});

test("importing versions into an existing Brain honours the same signature rules", opts, async () => {
  const ws = await newWs();
  const src = await seed(ws);
  const pkg = await exportOf(signer, ws, src);
  const ws2 = await newWs();
  const target = await seed(ws2);
  // unsigned into a strict registry: refused, no version added
  const unsigned = await exportOf(lenient, ws, src);
  const refused = await strict("POST", `/brains/${target.brain_id}/versions/import`, { ws: ws2, body: { package: unsigned } });
  assert.equal(refused.status, 422);
  assert.equal(await versionCount(ws2, target.brain_id), 1);
  // tampered signature: refused
  const bad = structuredClone(pkg);
  bad.signature.value = Buffer.alloc(64, 1).toString("base64");
  assert.equal((await lenient("POST", `/brains/${target.brain_id}/versions/import`, { ws: ws2, body: { package: bad } })).status, 422);
  assert.equal(await versionCount(ws2, target.brain_id), 1);
  // good signature from a trusted key: added, and the audit records the signer
  const ok = await strict("POST", `/brains/${target.brain_id}/versions/import`, { ws: ws2, body: { package: pkg } });
  assert.equal(ok.status, 201);
  assert.equal(sigCheck(ok).result, "valid");
  assert.equal(await versionCount(ws2, target.brain_id), 2);
  const entry = (await lenient("GET", "/audit", { ws: ws2 })).body.items.find((x) => x.action === "brain.version.import");
  assert.equal(entry.detail.signature.key_id, keyA.key_id);
});
