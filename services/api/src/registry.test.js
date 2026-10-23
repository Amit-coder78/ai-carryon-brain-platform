import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { createPool } from "./db.js";

const pool = createPool();
let dbUp = true;
try { await pool.query("select 1 from brains limit 1"); } catch { dbUp = false; }
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

async function seed() {
  const ws = (await call("POST", "/workspaces", { body: { name: "ws-" + uniq() } })).body.workspace_id;
  const ch = (await call("POST", "/channels", { ws, body: { name: "cricket" } })).body.channel_id;
  const brain = (await call("POST", "/brains", { ws, body: { name: "perf", brain_type: "performance" } })).body;
  const v1 = (await call("POST", `/brains/${brain.brain_id}/versions`, { ws, body: { capabilities: ["rank"] } })).body;
  return { ws, ch, brain, v1 };
}

test("brain create, duplicate, list, get", opts, async () => {
  const { ws, brain } = await seed();
  assert.equal((await call("POST", "/brains", { ws, body: { name: "perf", brain_type: "x" } })).status, 409);
  assert.equal((await call("POST", "/brains", { ws, body: { brain_type: "x" } })).status, 400);
  const list = await call("GET", "/brains", { ws });
  assert.equal(list.body.items.length, 1);
  assert.equal((await call("GET", `/brains/${brain.brain_id}`, { ws })).body.status, "active"); // first version activates
});

test("workspace isolation: other workspace sees 404, empty list", opts, async () => {
  const a = await seed();
  const b = await seed();
  assert.equal((await call("GET", `/brains/${a.brain.brain_id}`, { ws: b.ws })).status, 404);
  assert.equal((await call("GET", `/brains/${a.brain.brain_id}/versions`, { ws: b.ws })).status, 404);
  assert.equal((await call("POST", "/attachments", { ws: b.ws, body: { brain_id: a.brain.brain_id, channel_id: b.ch, brain_version_id: a.v1.brain_version_id } })).status, 404);
  assert.equal((await call("GET", "/brains", { ws: b.ws })).body.items.length, 1);
});

test("versions number up and rows are immutable", opts, async () => {
  const { ws, brain, v1 } = await seed();
  const v2 = (await call("POST", `/brains/${brain.brain_id}/versions`, { ws, body: {} })).body;
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  await assert.rejects(pool.query("update brain_versions set checksum='x' where brain_version_id=$1", [v1.brain_version_id]), /immutable/);
  await assert.rejects(pool.query("delete from brain_versions where brain_version_id=$1", [v1.brain_version_id]), /immutable/);
});

test("concurrent version creation gets distinct numbers", opts, async () => {
  const { ws, brain } = await seed();
  const rs = await Promise.all([1, 2, 3, 4].map(() => call("POST", `/brains/${brain.brain_id}/versions`, { ws, body: {} })));
  assert.ok(rs.every((r) => r.status === 201));
  assert.equal(new Set(rs.map((r) => r.body.version)).size, 4);
});

test("attach rules: one primary per channel, no duplicate attach, detach frees the slot", opts, async () => {
  const { ws, ch, brain, v1 } = await seed();
  const other = (await call("POST", "/brains", { ws, body: { name: "demand", brain_type: "demand" } })).body;
  const ov = (await call("POST", `/brains/${other.brain_id}/versions`, { ws, body: {} })).body;
  const a1 = await call("POST", "/attachments", { ws, body: { brain_id: brain.brain_id, channel_id: ch, brain_version_id: v1.brain_version_id, role: "primary" } });
  assert.equal(a1.status, 201);
  assert.equal((await call("POST", "/attachments", { ws, body: { brain_id: other.brain_id, channel_id: ch, brain_version_id: ov.brain_version_id, role: "primary" } })).status, 409);
  assert.equal((await call("POST", "/attachments", { ws, body: { brain_id: brain.brain_id, channel_id: ch, brain_version_id: v1.brain_version_id, role: "shadow" } })).status, 409);
  assert.equal((await call("POST", "/attachments", { ws, body: { brain_id: other.brain_id, channel_id: ch, brain_version_id: ov.brain_version_id, role: "supporting" } })).status, 201);
  assert.equal((await call("POST", `/attachments/${a1.body.attachment_id}/detach`, { ws })).body.status, "detached");
  assert.equal((await call("POST", `/attachments/${a1.body.attachment_id}/detach`, { ws })).status, 409);
  const again = await call("POST", "/attachments", { ws, body: { brain_id: other.brain_id, channel_id: ch, brain_version_id: ov.brain_version_id, role: "primary" } });
  assert.equal(again.status, 409); // already attached (supporting)
  const list = await call("GET", `/channels/${ch}/brains`, { ws });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].brain_name, "demand");
});

test("version must belong to the brain", opts, async () => {
  const { ws, ch, brain } = await seed();
  const other = (await call("POST", "/brains", { ws, body: { name: "other", brain_type: "t" } })).body;
  const ov = (await call("POST", `/brains/${other.brain_id}/versions`, { ws, body: {} })).body;
  assert.equal((await call("POST", "/attachments", { ws, body: { brain_id: brain.brain_id, channel_id: ch, brain_version_id: ov.brain_version_id } })).status, 400);
});

test("replace switches version, rejects foreign version, disable blocks replace", opts, async () => {
  const { ws, ch, brain, v1 } = await seed();
  const v2 = (await call("POST", `/brains/${brain.brain_id}/versions`, { ws, body: {} })).body;
  const a = (await call("POST", "/attachments", { ws, body: { brain_id: brain.brain_id, channel_id: ch, brain_version_id: v1.brain_version_id } })).body;
  const rep = await call("POST", `/attachments/${a.attachment_id}/replace`, { ws, body: { brain_version_id: v2.brain_version_id } });
  assert.equal(rep.body.attached_version_id, v2.brain_version_id);
  const back = await call("POST", `/attachments/${a.attachment_id}/replace`, { ws, body: { brain_version_id: v1.brain_version_id } });
  assert.equal(back.body.attached_version_id, v1.brain_version_id); // rollback path
  const other = (await call("POST", "/brains", { ws, body: { name: "o2", brain_type: "t" } })).body;
  const ov = (await call("POST", `/brains/${other.brain_id}/versions`, { ws, body: {} })).body;
  assert.equal((await call("POST", `/attachments/${a.attachment_id}/replace`, { ws, body: { brain_version_id: ov.brain_version_id } })).status, 400);
  assert.equal((await call("POST", `/attachments/${a.attachment_id}/disable`, { ws })).body.status, "disabled");
  assert.equal((await call("POST", `/attachments/${a.attachment_id}/replace`, { ws, body: { brain_version_id: v2.brain_version_id } })).status, 409);
});

test("idempotency key replays, and conflicts on different body", opts, async () => {
  const { ws } = await seed();
  const key = "k-" + uniq();
  const h = { "idempotency-key": key };
  const first = await call("POST", "/brains", { ws, headers: h, body: { name: "idem", brain_type: "t" } });
  const second = await call("POST", "/brains", { ws, headers: h, body: { name: "idem", brain_type: "t" } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.brain_id, first.body.brain_id);
  const diff = await call("POST", "/brains", { ws, headers: h, body: { name: "different", brain_type: "t" } });
  assert.equal(diff.status, 409);
  const { rows } = await pool.query("select count(*)::int n from brains where workspace_id=$1 and name='idem'", [ws]);
  assert.equal(rows[0].n, 1);
});

test("audit log records lifecycle events without leaking across workspaces", opts, async () => {
  const { ws, ch, brain, v1 } = await seed();
  const a = (await call("POST", "/attachments", { ws, body: { brain_id: brain.brain_id, channel_id: ch, brain_version_id: v1.brain_version_id } })).body;
  await call("POST", `/attachments/${a.attachment_id}/detach`, { ws });
  const actions = (await call("GET", "/audit", { ws })).body.items.map((x) => x.action);
  for (const want of ["channel.create", "brain.create", "brain.version.create", "attachment.create", "attachment.detach"]) assert.ok(actions.includes(want), want);
  const other = await seed();
  assert.ok(!(await call("GET", "/audit", { ws: other.ws })).body.items.some((x) => x.object_id === brain.brain_id));
});

test("missing or bad workspace header is a 400; bad json is a 400", opts, async () => {
  assert.equal((await call("GET", "/brains")).status, 400);
  assert.equal((await call("GET", "/brains", { ws: "nope" })).status, 400);
  const r = await fetch(base + "/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
  assert.equal(r.status, 400);
});
