import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { validateParams } from "./params.js";
import { buildPackage, inspectPackage, canonical, sha256 } from "./package.js";

// ---------------------------------------------------------------- pure
test("validateParams: demand settings are range-checked and unknown keys are refused", () => {
  assert.deepEqual(validateParams("demand", {}), []);
  assert.deepEqual(validateParams("demand", { half_life_days: 7, min_requesters: 5 }), []);
  assert.deepEqual(validateParams("demand", { half_life_days: 1 }), []);
  assert.deepEqual(validateParams("demand", { half_life_days: 365, min_requesters: 1000 }), []);
  for (const bad of [{ half_life_days: 0.5 }, { half_life_days: 366 }, { half_life_days: "14" }, { half_life_days: null },
    { half_life_days: NaN }, { half_life_days: true }, { min_requesters: 0 }, { min_requesters: 2.5 }, { min_requesters: "3" },
    { min_requesters: 1001 }, { saturation_k: 10 }]) {
    assert.ok(validateParams("demand", bad).length > 0, JSON.stringify(bad));
  }
});

test("validateParams: other Brain types take no settings; params must be an object", () => {
  assert.deepEqual(validateParams("heuristic", {}), []);
  assert.match(validateParams("heuristic", { half_life_days: 7 })[0], /takes no params/);
  for (const bad of [null, [], "x", 5]) assert.deepEqual(validateParams("demand", bad), ["params must be an object"]);
});

const brain = { brain_id: "11111111-1111-4111-8111-111111111111", name: "d", brain_type: "demand", origin: {} };
const versions = [{ version: 1, capabilities: [], artifact_refs: [], checksum: null, params: { half_life_days: 7, min_requesters: 5 } }];
const make = (v = versions, b = brain) => structuredClone(buildPackage(b, v, { actor: "t" }));
function reseal(pkg) {
  pkg.manifest.files = pkg.manifest.files.map((f) => {
    const s = canonical(pkg.files[f.path]);
    return { path: f.path, sha256: sha256(s), size: Buffer.byteLength(s) };
  });
  pkg.package_sha256 = sha256(canonical(pkg.manifest));
  return pkg;
}

test("package: settings travel with each version and come back from inspect", () => {
  const pkg = make();
  assert.deepEqual(pkg.files["brain.json"].versions[0].params, { half_life_days: 7, min_requesters: 5 });
  const r = inspectPackage(pkg);
  assert.equal(r.valid, true);
  assert.deepEqual(r.brain.versions[0].params, { half_life_days: 7, min_requesters: 5 });
});

test("package: a package made before settings existed (no params anywhere) is still accepted", () => {
  const pkg = make();
  delete pkg.files["brain.json"].versions[0].params;
  const r = inspectPackage(reseal(pkg));
  assert.equal(r.valid, true);
});

test("package: sealed but invalid settings are refused at the compatibility check, nothing restored", () => {
  for (const [type, params] of [["demand", { half_life_days: -3 }], ["demand", { surprise: 1 }], ["heuristic", { half_life_days: 7 }]]) {
    const pkg = make([{ ...versions[0], params }], { ...brain, brain_type: type });
    const r = inspectPackage(pkg);
    assert.equal(r.valid, false, JSON.stringify(params));
    assert.deepEqual(r.checks.map((c) => c.status), ["ok", "ok", "failed", "skipped"], JSON.stringify(params));
    assert.match(r.checks[2].problems.join(), /version 1:/);
    assert.equal(r.brain, null);
  }
});

// ---------------------------------------------------------------- with the database
const pool = createPool();
let dbUp = true;
try { await pool.query("select params from brain_versions limit 1"); } catch { dbUp = false; }
const opts = { skip: dbUp ? false : "database not reachable or migration 0005 not applied (make migrate)" };
const server = createApp({ pool, checkDb: () => pool.query("select 1") }).listen(0);
const base = `http://127.0.0.1:${server.address().port}/v1`;
test.after(async () => { server.close(); await pool.end(); });

async function call(method, path, { ws, body } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(ws ? { "x-workspace-id": ws } : {}), "x-actor": "test" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
const uniq = () => Math.random().toString(36).slice(2, 10);
const newWorkspace = async () => (await call("POST", "/workspaces", { body: { name: "ws-" + uniq() } })).body.workspace_id;
async function demandBrain(ws, type = "demand") {
  return (await call("POST", "/brains", { ws, body: { name: "d-" + uniq(), brain_type: type } })).body;
}

test("versions: settings are stored on the version, default to {}, and each version keeps its own", opts, async () => {
  const ws = await newWorkspace();
  const b = await demandBrain(ws);
  const v1 = await call("POST", `/brains/${b.brain_id}/versions`, { ws, body: {} });
  const v2 = await call("POST", `/brains/${b.brain_id}/versions`, { ws, body: { params: { half_life_days: 7, min_requesters: 5 } } });
  assert.equal(v1.status, 201);
  assert.deepEqual(v1.body.params, {});
  assert.deepEqual(v2.body.params, { half_life_days: 7, min_requesters: 5 });
  const list = (await call("GET", `/brains/${b.brain_id}/versions`, { ws })).body.items;
  assert.deepEqual(list.map((v) => v.params), [{ half_life_days: 7, min_requesters: 5 }, {}]);   // newest first
  const audit = (await call("GET", "/audit", { ws })).body.items.find((x) => x.action === "brain.version.create" && x.detail.version === 2);
  assert.deepEqual(audit.detail.params, { half_life_days: 7, min_requesters: 5 });
});

test("versions: bad settings are a 400 and create no version", opts, async () => {
  const ws = await newWorkspace();
  const b = await demandBrain(ws);
  for (const params of [{ half_life_days: 0 }, { min_requesters: 0 }, { nope: 1 }, [], "x", 5]) {   // explicit null counts as "not given", like capabilities
    const r = await call("POST", `/brains/${b.brain_id}/versions`, { ws, body: { params } });
    assert.equal(r.status, 400, JSON.stringify(params));
  }
  const h = await demandBrain(ws, "heuristic");
  assert.equal((await call("POST", `/brains/${h.brain_id}/versions`, { ws, body: { params: { half_life_days: 7 } } })).status, 400);
  assert.equal((await call("GET", `/brains/${b.brain_id}/versions`, { ws })).body.items.length, 0);
  assert.equal((await call("GET", `/brains/${h.brain_id}/versions`, { ws })).body.items.length, 0);
});

test("the database refuses non-object settings even if the API were bypassed", opts, async () => {
  const ws = await newWorkspace();
  const b = await demandBrain(ws);
  await assert.rejects(pool.query(`INSERT INTO brain_versions (brain_id, version, params) VALUES ($1, 1, '[1]')`, [b.brain_id]), /brain_versions_params_object/);
});

test("clone and export/import carry the settings of every copied version", opts, async () => {
  const a = await newWorkspace();
  const b = await demandBrain(a);
  await call("POST", `/brains/${b.brain_id}/versions`, { ws: a, body: { params: { half_life_days: 3 } } });
  await call("POST", `/brains/${b.brain_id}/versions`, { ws: a, body: { params: { half_life_days: 7, min_requesters: 5 } } });

  const clone = await call("POST", `/brains/${b.brain_id}/clone`, { ws: a, body: { versions: "all" } });
  assert.deepEqual(clone.body.versions.map((v) => v.params), [{ half_life_days: 3 }, { half_life_days: 7, min_requesters: 5 }]);

  const pkg = (await call("POST", `/brains/${b.brain_id}/export`, { ws: a, body: {} })).body.package;
  const other = await newWorkspace();
  const imp = await call("POST", "/brains/import", { ws: other, body: { package: pkg } });
  assert.equal(imp.status, 201);
  const imported = (await call("GET", `/brains/${imp.body.brain.brain_id}/versions`, { ws: other })).body.items;
  assert.deepEqual(imported.map((v) => v.params), [{ half_life_days: 7, min_requesters: 5 }, { half_life_days: 3 }]);
});
