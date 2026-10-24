import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { buildPackage, canonical, sha256 } from "./package.js";

const pool = createPool();
let dbUp = true;
try { await pool.query("select params from brain_versions limit 1"); await pool.query("select 1 from brain_exports limit 1"); } catch { dbUp = false; }
const opts = { skip: dbUp ? false : "database not reachable or not migrated (run make up && make migrate)" };

const server = createApp({ pool, checkDb: () => pool.query("select 1") }).listen(0);
const base = `http://127.0.0.1:${server.address().port}/v1`;
test.after(async () => { server.close(); await pool.end(); });

async function call(method, path, { ws, body, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(ws ? { "x-workspace-id": ws } : {}), "x-actor": "test", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
const uniq = () => Math.random().toString(36).slice(2, 10);
const newWorkspace = async () => (await call("POST", "/workspaces", { body: { name: "ws-" + uniq() } })).body.workspace_id;
const newBrain = async (ws, type = "demand") => (await call("POST", "/brains", { ws, body: { name: "b-" + uniq(), brain_type: type } })).body;
const addVersion = async (ws, brain, body = {}) => (await call("POST", `/brains/${brain.brain_id}/versions`, { ws, body })).body;
const versionsOf = async (ws, brain) => (await call("GET", `/brains/${brain.brain_id}/versions`, { ws })).body.items.sort((a, b) => a.version - b.version);
const exportPkg = async (ws, brain, mode = "all") => (await call("POST", `/brains/${brain.brain_id}/export`, { ws, body: { versions: mode } })).body.package;
const importInto = (ws, brain, body, headers) => call("POST", `/brains/${brain.brain_id}/versions/import`, { ws, body, headers });
const actions = async (ws) => (await call("GET", "/audit", { ws })).body.items.map((x) => x.action);

// A source Brain with two versions that carry settings, and a target Brain (other workspace) with one version.
async function setup() {
  const src = await newWorkspace(), dst = await newWorkspace();
  const from = await newBrain(src);
  await addVersion(src, from, { capabilities: ["rank"], checksum: "s1-" + uniq(), params: { half_life_days: 7 } });
  await addVersion(src, from, { capabilities: ["rank", "explain"], artifact_refs: ["s3://m/v2.bin"], checksum: "s2-" + uniq(), params: { min_requesters: 5 } });
  const target = await newBrain(dst);
  const t1 = await addVersion(dst, target, { checksum: "t1-" + uniq() });
  return { src, dst, from, target, t1, pkg: await exportPkg(src, from) };
}

test("appends the package's versions after the Brain's last version, in order, unevaluated, with their settings", opts, async () => {
  const s = await setup();
  const r = await importInto(s.dst, s.target, { package: s.pkg });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.versions.map((v) => v.version), [2, 3]);
  assert.deepEqual(r.body.versions.map((v) => v.params), [{ half_life_days: 7 }, { min_requesters: 5 }]);
  assert.deepEqual(r.body.versions.map((v) => v.capabilities), [["rank"], ["rank", "explain"]]);
  assert.ok(r.body.versions.every((v) => v.evaluation_status === "unevaluated" && v.brain_id === s.target.brain_id));
  const all = await versionsOf(s.dst, s.target);
  assert.deepEqual(all.map((v) => v.version), [1, 2, 3]);
  assert.equal(all[0].brain_version_id, s.t1.brain_version_id);          // the existing version is untouched
  assert.match(r.body.note, /versions 2, 3/);
  assert.ok((await actions(s.dst)).includes("brain.version.import"));
  assert.equal((await versionsOf(s.src, s.from)).length, 2);              // the source is untouched
});

test("attachments stay pinned to their version and the Brain's status does not change", opts, async () => {
  const s = await setup();
  const ch = (await call("POST", "/channels", { ws: s.dst, body: { name: "cricket" } })).body.channel_id;
  const att = await call("POST", "/attachments", { ws: s.dst, body: { brain_id: s.target.brain_id, channel_id: ch, brain_version_id: s.t1.brain_version_id, role: "primary" } });
  assert.equal(att.status, 201);
  const before = (await call("GET", `/brains/${s.target.brain_id}`, { ws: s.dst })).body;
  assert.equal((await importInto(s.dst, s.target, { package: s.pkg })).status, 201);
  const on = (await call("GET", `/channels/${ch}/brains`, { ws: s.dst })).body.items;
  assert.equal(on.length, 1);
  assert.equal(on[0].attached_version_id ?? on[0].brain_version_id, s.t1.brain_version_id);   // still version 1
  const after = (await call("GET", `/brains/${s.target.brain_id}`, { ws: s.dst })).body;
  assert.equal(after.status, before.status);
});

test("a draft Brain stays a draft: importing never activates anything", opts, async () => {
  const s = await setup();
  const draft = (await call("POST", `/brains/${s.from.brain_id}/clone`, { ws: s.src, body: { versions: "none", name: "empty-" + uniq() } })).body.brain;
  assert.equal(draft.status, "draft");
  const r = await importInto(s.src, draft, { package: s.pkg });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.versions.map((v) => v.version), [1, 2]);
  assert.equal((await call("GET", `/brains/${draft.brain_id}`, { ws: s.src })).body.status, "draft");
});

test("dry run reports the version numbers it would create and writes nothing", opts, async () => {
  const s = await setup();
  const r = await importInto(s.dst, s.target, { package: s.pkg, dry_run: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.would_add, [{ source_version: 1, new_version: 2 }, { source_version: 2, new_version: 3 }]);
  assert.equal(r.body.can_import, true);
  assert.deepEqual(r.body.blockers, []);
  assert.ok(r.body.checks.every((c) => c.status === "ok"));
  assert.equal((await versionsOf(s.dst, s.target)).length, 1);
  const h = await newBrain(s.dst, "heuristic");
  const wrong = await importInto(s.dst, h, { package: s.pkg, dry_run: true });
  assert.equal(wrong.body.can_import, false);                              // a dry run reports blockers instead of failing
  assert.match(wrong.body.blockers[0], /brain_type/);
  assert.equal((await versionsOf(s.dst, h)).length, 0);
});

test("refused with a 409 and nothing added: wrong Brain type, archived Brain, package with no versions", opts, async () => {
  const s = await setup();
  const h = await newBrain(s.dst, "heuristic");
  const wrong = await importInto(s.dst, h, { package: s.pkg });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.message, /brain_type "demand" but this Brain is "heuristic"/);
  assert.equal((await versionsOf(s.dst, h)).length, 0);

  const arch = await newBrain(s.dst);
  await addVersion(s.dst, arch);
  assert.equal((await call("POST", `/brains/${arch.brain_id}/archive`, { ws: s.dst, body: {} })).status, 200);
  const closed = await importInto(s.dst, arch, { package: s.pkg });
  assert.equal(closed.status, 409);
  assert.match(closed.body.message, /archived/);
  assert.equal((await versionsOf(s.dst, arch)).length, 1);

  const none = (await call("POST", `/brains/${s.from.brain_id}/clone`, { ws: s.src, body: { versions: "none", name: "none-" + uniq() } })).body.brain;
  const emptyPkg = await exportPkg(s.src, none);
  const r = await importInto(s.dst, s.target, { package: emptyPkg });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /no versions/);
  assert.equal((await versionsOf(s.dst, s.target)).length, 1);
});

test("another workspace's Brain is a 404, and a missing package or bad dry_run is a 400", opts, async () => {
  const s = await setup();
  const other = await newWorkspace();
  assert.equal((await importInto(other, s.target, { package: s.pkg })).status, 404);
  assert.equal((await importInto(s.dst, s.target, {})).status, 400);
  assert.equal((await importInto(s.dst, s.target, { package: s.pkg, dry_run: "yes" })).status, 400);
  assert.equal((await versionsOf(s.dst, s.target)).length, 1);
});

test("a tampered package is refused with the failing check, adds nothing, and is audited", opts, async () => {
  const s = await setup();
  const bad = structuredClone(s.pkg);
  bad.files["brain.json"].versions[1].capabilities.push("exfiltrate");
  const r = await importInto(s.dst, s.target, { package: bad });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "invalid_package");
  assert.equal(r.body.details.checks.find((c) => c.status === "failed").name, "checksums");
  assert.equal((await versionsOf(s.dst, s.target)).length, 1);
  assert.ok((await actions(s.dst)).includes("brain.version.import.rejected"));
});

test("a package that carries a secret is refused by the scan", opts, async () => {
  const s = await setup();
  const forged = structuredClone(s.pkg);
  forged.files["brain.json"].versions[0].artifact_refs = [{ api_key: "sk-live-" + "a".repeat(30) }];
  forged.manifest.files = forged.manifest.files.map((f) => {
    const t = canonical(forged.files[f.path]);
    return { path: f.path, sha256: sha256(t), size: Buffer.byteLength(t) };
  });
  forged.package_sha256 = sha256(canonical(forged.manifest));
  const r = await importInto(s.dst, s.target, { package: forged });
  assert.equal(r.status, 422);
  assert.equal(r.body.details.checks.find((c) => c.status === "failed").name, "scan");
  assert.equal((await versionsOf(s.dst, s.target)).length, 1);
});

test("the same package twice: the second is a 409; the same Idempotency-Key replays instead", opts, async () => {
  const s = await setup();
  const key = "k-" + uniq();
  const first = await importInto(s.dst, s.target, { package: s.pkg }, { "idempotency-key": key });
  assert.equal(first.status, 201);
  const replay = await importInto(s.dst, s.target, { package: s.pkg }, { "idempotency-key": key });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body.versions.map((v) => v.brain_version_id), first.body.versions.map((v) => v.brain_version_id));
  const again = await importInto(s.dst, s.target, { package: s.pkg });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already imported .* versions 2, 3/);
  assert.deepEqual((await versionsOf(s.dst, s.target)).map((v) => v.version), [1, 2, 3]);
  const dry = await importInto(s.dst, s.target, { package: s.pkg, dry_run: true });
  assert.equal(dry.body.can_import, false);
});

test("a fresh export of the same Brain is a different package, so it can be imported (including into itself)", opts, async () => {
  const s = await setup();
  assert.equal((await importInto(s.dst, s.target, { package: s.pkg })).status, 201);
  const own = await exportPkg(s.dst, s.target, "latest");                  // version 3
  const r = await importInto(s.dst, s.target, { package: own });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.versions.map((v) => v.version), [4]);
  assert.deepEqual(r.body.versions[0].params, { min_requesters: 5 });
});

test("all-or-nothing: a failure while adding the second version leaves no new version behind", opts, async () => {
  const s = await setup();
  const marker = "boom-" + uniq(), fine = "fine-" + uniq();
  const pkg = buildPackage({ brain_id: s.from.brain_id, name: "x", brain_type: "demand", origin: {} }, [
    { version: 1, capabilities: [], artifact_refs: [], checksum: fine, params: {} },
    { version: 2, capabilities: [], artifact_refs: [], checksum: marker, params: {} },
  ], { actor: "x" });
  const fn = "fail_" + uniq(), trg = "trg_" + uniq();
  await pool.query(`create function ${fn}() returns trigger as $$ begin raise exception 'simulated storage failure'; end $$ language plpgsql`);
  await pool.query(`create trigger ${trg} before insert on brain_versions for each row when (new.checksum = '${marker}') execute function ${fn}()`);
  try {
    const r = await importInto(s.dst, s.target, { package: pkg });
    assert.equal(r.status, 500);
    assert.equal((await versionsOf(s.dst, s.target)).length, 1);
    assert.equal((await pool.query("select count(*)::int n from brain_versions where checksum=$1", [fine])).rows[0].n, 0);
  } finally {
    await pool.query(`drop trigger ${trg} on brain_versions`);
    await pool.query(`drop function ${fn}()`);
  }
  assert.equal((await importInto(s.dst, s.target, { package: s.pkg })).status, 201);   // the Brain is still usable afterwards
});

test("health check: if storage silently drops a version, the import is refused and rolled back", opts, async () => {
  const s = await setup();
  const marker = "vanish-" + uniq();
  const pkg = buildPackage({ brain_id: s.from.brain_id, name: "x", brain_type: "demand", origin: {} }, [
    { version: 1, capabilities: [], artifact_refs: [], checksum: "kept-" + uniq(), params: {} },
    { version: 2, capabilities: [], artifact_refs: [], checksum: marker, params: {} },
  ], { actor: "x" });
  const fn = "drop_" + uniq(), trg = "trg_" + uniq();
  await pool.query(`create function ${fn}() returns trigger as $$ begin return null; end $$ language plpgsql`);
  await pool.query(`create trigger ${trg} before insert on brain_versions for each row when (new.checksum = '${marker}') execute function ${fn}()`);
  try {
    const r = await importInto(s.dst, s.target, { package: pkg });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "import_health_check_failed");
    assert.equal((await versionsOf(s.dst, s.target)).length, 1);
  } finally {
    await pool.query(`drop trigger ${trg} on brain_versions`);
    await pool.query(`drop function ${fn}()`);
  }
});

test("concurrent imports and version creates into one Brain get distinct, contiguous numbers", opts, async () => {
  const s = await setup();
  const mk = (n) => buildPackage({ brain_id: s.from.brain_id, name: "x", brain_type: "demand", origin: {} },
    Array.from({ length: n }, (_, i) => ({ version: i + 1, capabilities: [], artifact_refs: [], checksum: `c-${uniq()}`, params: {} })), { actor: "x" });
  const results = await Promise.all([
    importInto(s.dst, s.target, { package: mk(2) }),
    importInto(s.dst, s.target, { package: mk(3) }),
    addVersion(s.dst, s.target, {}),
    importInto(s.dst, s.target, { package: mk(1) }),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.deepEqual((await versionsOf(s.dst, s.target)).map((v) => v.version), [1, 2, 3, 4, 5, 6, 7, 8]);   // 1 existing + 2 + 3 + 1 imported + 1 created
});
