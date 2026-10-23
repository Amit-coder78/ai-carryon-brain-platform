import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";

async function get(app, path) {
  const server = app.listen(0);
  const { port } = server.address();
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await r.json();
  server.close();
  return { status: r.status, body };
}

test("health is ok", async () => {
  const r = await get(createApp(), "/v1/health");
  assert.equal(r.status, 200);
});
test("ready fails when db down", async () => {
  const r = await get(createApp({ checkDb: async () => { throw new Error("x"); } }), "/v1/ready");
  assert.equal(r.status, 503);
});
test("unknown route is structured 404", async () => {
  const r = await get(createApp(), "/nope");
  assert.equal(r.body.code, "not_found");
});
