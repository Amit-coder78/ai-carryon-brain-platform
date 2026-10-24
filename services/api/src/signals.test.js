import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { topicKey } from "./topickey.js";

const vectors = JSON.parse(readFileSync(new URL("../../../contracts/topic-key-vectors.json", import.meta.url)));
test("topicKey matches the shared vectors", () => {
  for (const [input, want] of vectors) assert.equal(topicKey(input), want, JSON.stringify(input));
});

const pool = createPool();
let dbUp = true;
try { await pool.query("select 1 from decisions limit 1"); } catch { dbUp = false; }
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
  return { ws, ch };
}
async function seedDecision(ws, ch) {
  const { rows } = await pool.query(
    `INSERT INTO decisions (workspace_id, channel_id, execution_id, source, policy_version, candidates, ranked, brains)
     VALUES ($1,$2,gen_random_uuid(),'brains','rrf-v1',$3,'[]','[]') RETURNING decision_id`,
    [ws, ch, JSON.stringify([{ candidate_id: "a" }, { candidate_id: "b" }])]);
  return rows[0].decision_id;
}

test("signals store hashed people and normalized topics only", opts, async () => {
  const { ws, ch } = await seed();
  const r = await call("POST", "/comment-signals", { ws, body: { channel_id: ch, signals: [
    { commenter_id: "UC_alice", topic: "IPL Final!" },
    { commenter_id: "UC_alice", topic: "ipl   final" },     // same person again: still stored, counted once later
    { commenter_id: "UC_bob", topic: "IPL Final", kind: "reaction" },
    { commenter_id: "", topic: "x" }, { commenter_id: "u", topic: "!!!" }, { commenter_id: "u", topic: "ok", kind: "weird" }] } });
  assert.equal(r.status, 202);
  assert.deepEqual([r.body.accepted, r.body.rejected], [3, 3]);
  const { rows } = await pool.query("select topic_key, commenter_hash, kind from comment_signals where workspace_id=$1", [ws]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.topic_key === "ipl final" && /^[a-f0-9]{64}$/.test(x.commenter_hash) && !x.commenter_hash.includes("alice")));
  const people = await pool.query("select count(distinct commenter_hash)::int n from comment_signals where workspace_id=$1 and kind='request'", [ws]);
  assert.equal(people.rows[0].n, 1);
});

test("signals: same person hashes differently per workspace; validation; isolation", opts, async () => {
  const a = await seed(), b = await seed();
  const sig = (ch) => ({ channel_id: ch, signals: [{ commenter_id: "UC_same", topic: "t" }] });
  await call("POST", "/comment-signals", { ws: a.ws, body: sig(a.ch) });
  await call("POST", "/comment-signals", { ws: b.ws, body: sig(b.ch) });
  const h = await pool.query("select distinct commenter_hash from comment_signals where workspace_id in ($1,$2)", [a.ws, b.ws]);
  assert.equal(h.rows.length, 2);
  assert.equal((await call("POST", "/comment-signals", { ws: b.ws, body: sig(a.ch) })).status, 404);     // other workspace's channel
  assert.equal((await call("POST", "/comment-signals", { ws: a.ws, body: { channel_id: a.ch, signals: [] } })).status, 400);
  assert.equal((await call("POST", "/comment-signals", { ws: a.ws, body: { channel_id: "nope", signals: [{}] } })).status, 400);
  assert.equal((await call("POST", "/comment-signals", { body: sig(a.ch) })).status, 400);               // no workspace header
});

test("signals: Idempotency-Key replays without double counting", opts, async () => {
  const { ws, ch } = await seed();
  const h = { "idempotency-key": "s-" + uniq() };
  const body = { channel_id: ch, signals: [{ commenter_id: "u1", topic: "t" }] };
  assert.equal((await call("POST", "/comment-signals", { ws, headers: h, body })).status, 202);
  assert.equal((await call("POST", "/comment-signals", { ws, headers: h, body })).status, 202);
  assert.equal((await pool.query("select count(*)::int n from comment_signals where workspace_id=$1", [ws])).rows[0].n, 1);
});

test("observations: link to a decision, validate, isolate", opts, async () => {
  const { ws, ch } = await seed();
  const other = await seed();
  const d = await seedDecision(ws, ch);
  const ok = await call("POST", "/observations", { ws, body: { channel_id: ch, decision_id: d, video_ref: "yt:abc", metric: "views_24h", value: 1234 } });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.decision_id, d);
  assert.equal((await call("POST", "/observations", { ws, body: { channel_id: ch, video_ref: "yt:abc", metric: "views_24h", value: "many" } })).status, 400);
  assert.equal((await call("POST", "/observations", { ws: other.ws, body: { channel_id: other.ch, decision_id: d, video_ref: "v", metric: "m", value: 1 } })).status, 404);
});

test("decisions: list, get, isolation, selection once", opts, async () => {
  const { ws, ch } = await seed();
  const other = await seed();
  const d = await seedDecision(ws, ch);
  assert.equal((await call("GET", `/decisions?channel_id=${ch}`, { ws })).body.items.length, 1);
  assert.equal((await call("GET", "/decisions", { ws: other.ws })).body.items.length, 0);
  assert.equal((await call("GET", `/decisions/${d}`, { ws: other.ws })).status, 404);
  assert.equal((await call("GET", `/decisions/${d}`, { ws })).body.candidates.length, 2);
  assert.equal((await call("POST", `/decisions/${d}/selection`, { ws, body: { candidate_id: "zzz" } })).status, 400);
  assert.equal((await call("POST", `/decisions/${d}/selection`, { ws, body: { candidate_id: "b" } })).body.selected_candidate, "b");
  assert.equal((await call("POST", `/decisions/${d}/selection`, { ws, body: { candidate_id: "b" } })).status, 200);   // retry ok
  assert.equal((await call("POST", `/decisions/${d}/selection`, { ws, body: { candidate_id: "a" } })).status, 409);   // no rewriting history
  assert.equal((await call("POST", `/decisions/${d}/selection`, { ws: other.ws, body: { candidate_id: "b" } })).status, 404);
  const acts = (await call("GET", "/audit", { ws })).body.items.map((x) => x.action);
  assert.ok(acts.includes("decision.select"));
});
