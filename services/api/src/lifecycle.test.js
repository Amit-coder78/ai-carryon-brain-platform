import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { buildPackage } from "./package.js";

const pool = createPool();
let dbUp = true;
try { await pool.query("select 1 from brain_exports limit 1"); } catch { dbUp = false; }
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
const actions = async (ws) => (await call("GET", "/audit", { ws })).body.items.map((x) => x.action);

async function newWorkspace() {
  return (await call("POST", "/workspaces", { body: { name: "ws-" + uniq() } })).body.workspace_id;
}
// A workspace with one channel and a Brain "perf" that has two versions.
async function seed({ ws } = {}) {
  ws = ws ?? await newWorkspace();
  const ch = (await call("POST", "/channels", { ws, body: { name: "cricket" } })).body.channel_id;
  const brain = (await call("POST", "/brains", { ws, body: { name: "perf", brain_type: "performance" } })).body;
  const v1 = (await call("POST", `/brains/${brain.brain_id}/versions`, { ws, body: { capabilities: ["rank"], checksum: "c1" } })).body;
  const v2 = (await call("POST", `/brains/${brain.brain_id}/versions`, { ws, body: { capabilities: ["rank", "explain"], artifact_refs: ["s3://models/v2.bin"], checksum: "c2" } })).body;
  return { ws, ch, brain, v1, v2 };
}
const attach = (s, brainId, versionId, role = "supporting") =>
  call("POST", "/attachments", { ws: s.ws, body: { brain_id: brainId, channel_id: s.ch, brain_version_id: versionId, role } });
const getBrain = async (ws, id) => call("GET", `/brains/${id}`, { ws });

// ---------------------------------------------------------------- clone
test("clone: new identity, latest version by default, renumbered, origin recorded, nothing else copied", opts, async () => {
  const s = await seed();
  await attach(s, s.brain.brain_id, s.v2.brain_version_id, "primary");
  const r = await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: {} });
  assert.equal(r.status, 201);
  const { brain, versions } = r.body;
  assert.notEqual(brain.brain_id, s.brain.brain_id);
  assert.equal(brain.name, "perf (clone)");
  assert.equal(brain.status, "draft");
  assert.deepEqual(brain.origin, { kind: "clone", from_brain_id: s.brain.brain_id, source_versions: [2] });
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
  assert.deepEqual(versions[0].capabilities, ["rank", "explain"]);
  assert.equal(versions[0].evaluation_status, "unevaluated");
  assert.notEqual(versions[0].brain_version_id, s.v2.brain_version_id);
  assert.ok(r.body.not_copied.includes("attachments"));
  const onChannel = (await call("GET", `/channels/${s.ch}/brains`, { ws: s.ws })).body.items;
  assert.deepEqual(onChannel.map((x) => x.brain_id), [s.brain.brain_id]); // the clone is not attached anywhere
  assert.equal((await call("GET", `/brains/${s.brain.brain_id}/versions`, { ws: s.ws })).body.items.length, 2); // source untouched
  assert.ok((await actions(s.ws)).includes("brain.clone"));
});

test("clone: versions all/none, explicit name, name conflict, bad mode", opts, async () => {
  const s = await seed();
  const all = await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { versions: "all", name: "perf-all" } });
  assert.deepEqual(all.body.versions.map((v) => v.version), [1, 2]);
  assert.deepEqual(all.body.versions.map((v) => v.checksum), ["c1", "c2"]);
  const none = await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { versions: "none", name: "perf-none" } });
  assert.equal(none.body.versions.length, 0);
  assert.equal((await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { name: "perf-all" } })).status, 409);
  assert.equal((await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { versions: "some" } })).status, 400);
});

test("clone: a draft clone becomes active when attached, or when activated; activate needs a version", opts, async () => {
  const s = await seed();
  const c1 = (await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { name: "c1" } })).body;
  const att = await attach(s, c1.brain.brain_id, c1.versions[0].brain_version_id);
  assert.equal(att.status, 201);
  assert.equal((await getBrain(s.ws, c1.brain.brain_id)).body.status, "active"); // engine only runs active Brains
  const c2 = (await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { name: "c2" } })).body;
  assert.equal((await call("POST", `/brains/${c2.brain.brain_id}/activate`, { ws: s.ws })).body.status, "active");
  assert.equal((await call("POST", `/brains/${c2.brain.brain_id}/activate`, { ws: s.ws })).status, 409);
  const c3 = (await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { name: "c3", versions: "none" } })).body;
  assert.equal((await call("POST", `/brains/${c3.brain.brain_id}/activate`, { ws: s.ws })).status, 409);
  assert.ok((await actions(s.ws)).includes("brain.activate"));
});

// ---------------------------------------------------------------- archive / unarchive
test("archive: refused while attached; detach_attachments detaches in the same step; archived Brain is closed to changes", opts, async () => {
  const s = await seed();
  const a = (await attach(s, s.brain.brain_id, s.v1.brain_version_id, "primary")).body;
  const refused = await call("POST", `/brains/${s.brain.brain_id}/archive`, { ws: s.ws });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.bindings[0].attachment_id, a.attachment_id);
  assert.equal((await getBrain(s.ws, s.brain.brain_id)).body.status, "active"); // nothing changed
  const done = await call("POST", `/brains/${s.brain.brain_id}/archive`, { ws: s.ws, body: { detach_attachments: true } });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "archived");
  assert.equal(done.body.detached_attachments, 1);
  assert.equal((await call("GET", `/channels/${s.ch}/brains`, { ws: s.ws })).body.items.length, 0);
  assert.equal((await attach(s, s.brain.brain_id, s.v1.brain_version_id)).status, 409);
  assert.equal((await call("POST", `/brains/${s.brain.brain_id}/versions`, { ws: s.ws, body: {} })).status, 409);
  assert.equal((await call("POST", `/brains/${s.brain.brain_id}/archive`, { ws: s.ws })).status, 409); // already archived
  const log = await actions(s.ws);
  assert.ok(log.includes("brain.archive") && log.includes("attachment.detach"));
});

test("unarchive restores the Brain but never re-binds it to a channel", opts, async () => {
  const s = await seed();
  await attach(s, s.brain.brain_id, s.v1.brain_version_id);
  await call("POST", `/brains/${s.brain.brain_id}/archive`, { ws: s.ws, body: { detach_attachments: true } });
  assert.equal((await call("POST", `/brains/${s.brain.brain_id}/unarchive`, { ws: s.ws })).body.status, "active");
  assert.equal((await call("GET", `/channels/${s.ch}/brains`, { ws: s.ws })).body.items.length, 0);
  assert.equal((await call("POST", `/brains/${s.brain.brain_id}/unarchive`, { ws: s.ws })).status, 409);
  assert.equal((await attach(s, s.brain.brain_id, s.v1.brain_version_id)).status, 201);
});

// ---------------------------------------------------------------- delete + dependencies
test("delete: needs archive first and no live bindings; keeps versions and decisions; frees the name", opts, async () => {
  const s = await seed();
  await attach(s, s.brain.brain_id, s.v1.brain_version_id);
  const early = await call("DELETE", `/brains/${s.brain.brain_id}`, { ws: s.ws });
  assert.equal(early.status, 409);
  assert.match(early.body.details.blockers.join(), /archive it before deleting/);
  assert.match(early.body.details.blockers.join(), /live attachment/);
  await call("POST", `/brains/${s.brain.brain_id}/archive`, { ws: s.ws, body: { detach_attachments: true } });
  await pool.query(
    `insert into decisions(workspace_id,channel_id,execution_id,source,policy_version,candidates,ranked,brains)
     values ($1,$2,gen_random_uuid(),'brains','rrf-v1','[]','[]',$3)`,
    [s.ws, s.ch, JSON.stringify([{ brain_id: s.brain.brain_id, brain_version_id: s.v1.brain_version_id, role: "primary", status: "ok" }])]);
  const del = await call("DELETE", `/brains/${s.brain.brain_id}`, { ws: s.ws });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.retained, { versions: 2, decisions: 1, exports: 0 });
  assert.equal((await getBrain(s.ws, s.brain.brain_id)).status, 404);
  assert.equal((await call("GET", "/brains", { ws: s.ws })).body.items.length, 0);
  assert.equal((await call("DELETE", `/brains/${s.brain.brain_id}`, { ws: s.ws })).status, 404);
  const kept = await pool.query(`select (select count(*)::int from brain_versions where brain_id=$1) v, (select count(*)::int from decisions where workspace_id=$2) d`, [s.brain.brain_id, s.ws]);
  assert.deepEqual(kept.rows[0], { v: 2, d: 1 });
  assert.equal((await call("POST", "/brains", { ws: s.ws, body: { name: "perf", brain_type: "performance" } })).status, 201); // name is free again
  assert.ok((await actions(s.ws)).includes("brain.delete"));
});

test("dependencies: bindings, clones, exports and decisions are listed; clones do not block", opts, async () => {
  const s = await seed();
  await attach(s, s.brain.brain_id, s.v1.brain_version_id, "primary");
  const clone = (await call("POST", `/brains/${s.brain.brain_id}/clone`, { ws: s.ws, body: { name: "child" } })).body;
  await call("POST", `/brains/${s.brain.brain_id}/export`, { ws: s.ws, body: {} });
  const d = (await call("GET", `/brains/${s.brain.brain_id}/dependencies`, { ws: s.ws })).body;
  assert.equal(d.bindings.length, 1);
  assert.equal(d.bindings[0].channel_name, "cricket");
  assert.deepEqual(d.dependent_brains.map((x) => x.brain_id), [clone.brain.brain_id]);
  assert.equal(d.exports, 1);
  assert.equal(d.versions, 2);
  assert.equal(d.archive.allowed, false);
  await call("POST", `/brains/${s.brain.brain_id}/archive`, { ws: s.ws, body: { detach_attachments: true } });
  const after = (await call("GET", `/brains/${s.brain.brain_id}/dependencies`, { ws: s.ws })).body;
  assert.equal(after.delete.allowed, true); // the clone and the export are history, not blockers
  assert.equal((await call("DELETE", `/brains/${s.brain.brain_id}`, { ws: s.ws })).status, 200);
  assert.equal((await getBrain(s.ws, clone.brain.brain_id)).status, 200);
});

test("workspace isolation: every lifecycle route answers 404 for another workspace's Brain", opts, async () => {
  const a = await seed();
  const b = await seed();
  const id = a.brain.brain_id;
  for (const [m, p, body] of [["GET", `/brains/${id}/dependencies`], ["POST", `/brains/${id}/clone`, {}], ["POST", `/brains/${id}/export`, {}],
    ["POST", `/brains/${id}/archive`, {}], ["POST", `/brains/${id}/unarchive`], ["POST", `/brains/${id}/activate`], ["DELETE", `/brains/${id}`]]) {
    assert.equal((await call(m, p, { ws: b.ws, body })).status, 404, `${m} ${p}`);
  }
  assert.equal((await getBrain(a.ws, id)).body.status, "active");
});

// ---------------------------------------------------------------- export / import
test("export then import into another workspace: same content, inactive, renumbered, auditable", opts, async () => {
  const a = await seed();
  const exp = await call("POST", `/brains/${a.brain.brain_id}/export`, { ws: a.ws });
  assert.equal(exp.status, 200);
  const pkg = exp.body.package;
  assert.equal(pkg.manifest.brain.versions.length, 2);
  assert.ok(!JSON.stringify(pkg).includes(a.ws), "package must not carry the source workspace id");
  const b = { ws: await newWorkspace() };
  const imp = await call("POST", "/brains/import", { ws: b.ws, body: { package: pkg } });
  assert.equal(imp.status, 201);
  assert.equal(imp.body.brain.status, "draft");
  assert.equal(imp.body.brain.name, "perf");
  assert.equal(imp.body.brain.origin.kind, "import");
  assert.equal(imp.body.brain.origin.package_sha256, pkg.package_sha256);
  assert.deepEqual(imp.body.versions.map((v) => [v.version, v.capabilities, v.artifact_refs, v.checksum, v.evaluation_status]),
    [[1, ["rank"], [], "c1", "unevaluated"], [2, ["rank", "explain"], ["s3://models/v2.bin"], "c2", "unevaluated"]]);
  assert.ok((await actions(a.ws)).includes("brain.export"));
  assert.ok((await actions(b.ws)).includes("brain.import"));
  const att = await pool.query("select count(*)::int n from attachments where brain_id=$1", [imp.body.brain.brain_id]);
  assert.equal(att.rows[0].n, 0);
});

test("export latest only; the import renumbers from 1 and remembers the source version", opts, async () => {
  const a = await seed();
  const pkg = (await call("POST", `/brains/${a.brain.brain_id}/export`, { ws: a.ws, body: { versions: "latest" } })).body.package;
  assert.deepEqual(pkg.manifest.brain.versions, [2]);
  const imp = (await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg, name: "perf-restored" } })).body;
  assert.deepEqual(imp.versions.map((v) => v.version), [1]);
  assert.deepEqual(imp.brain.origin.source_versions, [2]);
  assert.equal((await call("POST", `/brains/${a.brain.brain_id}/export`, { ws: a.ws, body: { versions: "newest" } })).status, 400);
});

test("import dry run reports checks and name availability and creates nothing", opts, async () => {
  const a = await seed();
  const pkg = (await call("POST", `/brains/${a.brain.brain_id}/export`, { ws: a.ws })).body.package;
  const dry = await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg, dry_run: true } });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.valid, true);
  assert.equal(dry.body.name_available, false); // "perf" already exists here
  assert.deepEqual(dry.body.would_create, { name: "perf", brain_type: "performance", versions: 2, status: "draft" });
  assert.equal((await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg, dry_run: true, name: "fresh" } })).body.name_available, true);
  assert.equal((await call("GET", "/brains", { ws: a.ws })).body.items.length, 1);
  assert.equal((await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg } })).status, 409); // real import hits the name
  assert.equal((await call("GET", "/brains", { ws: a.ws })).body.items.length, 1);
  assert.equal((await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg, dry_run: "yes" } })).status, 400);
});

test("a tampered package is refused with the failing check, creates nothing, and is audited", opts, async () => {
  const a = await seed();
  const pkg = (await call("POST", `/brains/${a.brain.brain_id}/export`, { ws: a.ws })).body.package;
  pkg.files["brain.json"].versions[0].capabilities.push("extra");
  const dest = await newWorkspace();
  const r = await call("POST", "/brains/import", { ws: dest, body: { package: pkg } });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "invalid_package");
  assert.equal(r.body.details.checks.find((c) => c.status === "failed").name, "checksums");
  assert.equal((await call("GET", "/brains", { ws: dest })).body.items.length, 0);
  assert.ok((await actions(dest)).includes("brain.import.rejected"));
  assert.equal((await call("POST", "/brains/import", { ws: dest, body: {} })).status, 400);
  assert.equal((await call("POST", "/brains/import", { ws: dest, body: { package: "nope" } })).status, 422);
  assert.equal((await call("POST", "/brains/import", { ws: "00000000-0000-4000-8000-000000000000", body: { package: pkg } })).status, 404);
});

test("secrets: export refuses by path (no value echoed); import refuses a package that carries one", opts, async () => {
  const a = await seed();
  const risky = (await call("POST", "/brains", { ws: a.ws, body: { name: "risky", brain_type: "t" } })).body;
  await call("POST", `/brains/${risky.brain_id}/versions`, { ws: a.ws, body: { artifact_refs: [{ url: "https://x", api_key: "sk-live-0123456789abcdef0123" }] } });
  const r = await call("POST", `/brains/${risky.brain_id}/export`, { ws: a.ws });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "export_blocked");
  assert.ok(r.body.details.paths[0].includes("api_key"));
  assert.ok(!JSON.stringify(r.body).includes("sk-live-0123456789abcdef0123"));
  assert.equal((await pool.query("select count(*)::int n from brain_exports where brain_id=$1", [risky.brain_id])).rows[0].n, 0);
  assert.ok((await actions(a.ws)).includes("brain.export.blocked"));
  // a package built outside this registry, with a secret inside and valid checksums
  const forged = buildPackage({ brain_id: risky.brain_id, name: "forged", brain_type: "t", origin: {} },
    [{ version: 1, capabilities: [], artifact_refs: ["Bearer abcdefghijklmnop1234"], checksum: null }], { actor: "x" });
  const imp = await call("POST", "/brains/import", { ws: a.ws, body: { package: forged } });
  assert.equal(imp.status, 422);
  assert.equal(imp.body.details.checks.find((c) => c.status === "failed").name, "scan");
  assert.equal((await call("GET", "/brains?name=forged", { ws: a.ws })).body.items.length, 0);
});

test("import is all-or-nothing: a failure while restoring versions leaves no Brain behind", opts, async () => {
  const a = await seed();
  const marker = "boom-" + uniq(), fine = "fine-" + uniq();
  const pkg = buildPackage({ brain_id: a.brain.brain_id, name: "halfway", brain_type: "t", origin: {} }, [
    { version: 1, capabilities: [], artifact_refs: [], checksum: fine },
    { version: 2, capabilities: [], artifact_refs: [], checksum: marker },
  ], { actor: "x" });
  const fn = "fail_" + uniq(), trg = "trg_" + uniq();
  await pool.query(`create function ${fn}() returns trigger as $$ begin raise exception 'simulated storage failure'; end $$ language plpgsql`);
  await pool.query(`create trigger ${trg} before insert on brain_versions for each row when (new.checksum = '${marker}') execute function ${fn}()`);
  try {
    const r = await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg } });
    assert.equal(r.status, 500);
    const left = await pool.query("select (select count(*)::int from brains where workspace_id=$1 and name='halfway') b, (select count(*)::int from brain_versions where checksum=$2) v", [a.ws, fine]);
    assert.deepEqual(left.rows[0], { b: 0, v: 0 });
  } finally {
    await pool.query(`drop trigger ${trg} on brain_versions`);
    await pool.query(`drop function ${fn}()`);
  }
  assert.equal((await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg } })).status, 201); // same package works once the fault is gone
});

test("import health check: if storage silently drops a version, the import is refused and rolled back", opts, async () => {
  const a = await seed();
  const marker = "vanish-" + uniq();
  const pkg = buildPackage({ brain_id: a.brain.brain_id, name: "shrinks", brain_type: "t", origin: {} }, [
    { version: 1, capabilities: [], artifact_refs: [], checksum: "kept-" + uniq() },
    { version: 2, capabilities: [], artifact_refs: [], checksum: marker },
  ], { actor: "x" });
  const fn = "drop_" + uniq(), trg = "trg_" + uniq();
  await pool.query(`create function ${fn}() returns trigger as $$ begin return null; end $$ language plpgsql`);
  await pool.query(`create trigger ${trg} before insert on brain_versions for each row when (new.checksum = '${marker}') execute function ${fn}()`);
  try {
    const r = await call("POST", "/brains/import", { ws: a.ws, body: { package: pkg } });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "import_health_check_failed");
    assert.equal((await call("GET", "/brains?name=shrinks", { ws: a.ws })).body.items.length, 0);
  } finally {
    await pool.query(`drop trigger ${trg} on brain_versions`);
    await pool.query(`drop function ${fn}()`);
  }
});

test("import and clone honour Idempotency-Key", opts, async () => {
  const a = await seed();
  const pkg = (await call("POST", `/brains/${a.brain.brain_id}/export`, { ws: a.ws })).body.package;
  const h = { "idempotency-key": "imp-" + uniq() };
  const first = await call("POST", "/brains/import", { ws: a.ws, headers: h, body: { package: pkg, name: "once" } });
  const second = await call("POST", "/brains/import", { ws: a.ws, headers: h, body: { package: pkg, name: "once" } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.brain.brain_id, first.body.brain.brain_id);
  assert.equal((await call("POST", "/brains/import", { ws: a.ws, headers: h, body: { package: pkg, name: "other" } })).status, 409);
  assert.equal((await call("GET", "/brains?name=once", { ws: a.ws })).body.items.length, 1);
  const ch = { "idempotency-key": "cl-" + uniq() };
  const c1 = await call("POST", `/brains/${a.brain.brain_id}/clone`, { ws: a.ws, headers: ch, body: { name: "cl" } });
  const c2 = await call("POST", `/brains/${a.brain.brain_id}/clone`, { ws: a.ws, headers: ch, body: { name: "cl" } });
  assert.equal(c2.body.brain.brain_id, c1.body.brain.brain_id);
});

test("a body over 1 MB is a 413, not a 500", opts, async () => {
  const a = await seed();
  const r = await call("POST", "/brains/import", { ws: a.ws, body: { package: { pad: "x".repeat(1_100_000) } } });
  assert.equal(r.status, 413);
});

test("attach and archive cannot interleave: a Brain archived mid-attach never ends up bound", opts, async () => {
  const s = await seed();
  const results = await Promise.all([
    attach(s, s.brain.brain_id, s.v1.brain_version_id),
    call("POST", `/brains/${s.brain.brain_id}/archive`, { ws: s.ws, body: {} }),
  ]);
  const bound = (await pool.query("select count(*)::int n from attachments where brain_id=$1 and status in ('pending','active','disabled')", [s.brain.brain_id])).rows[0].n;
  const archived = (await getBrain(s.ws, s.brain.brain_id)).body.status === "archived";
  assert.ok(!(archived && bound > 0), `archived with ${bound} live attachment(s): ${results.map((r) => r.status)}`);
});
