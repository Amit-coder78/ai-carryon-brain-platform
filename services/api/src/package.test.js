import test from "node:test";
import assert from "node:assert/strict";
import { buildPackage, inspectPackage, canonical, findSecrets, sha256 } from "./package.js";

const brain = { brain_id: "11111111-1111-4111-8111-111111111111", name: "perf", brain_type: "performance", origin: {} };
const versions = [
  { version: 1, capabilities: ["rank"], artifact_refs: [], checksum: null },
  { version: 2, capabilities: ["rank", "explain"], artifact_refs: ["s3://models/perf-v2.bin"], checksum: "abc" },
];
const make = () => structuredClone(buildPackage(brain, versions, { actor: "tester" }));
const failedNames = (r) => r.checks.filter((c) => c.status === "failed").map((c) => c.name);
// Re-seal a package after editing it, the way a careful attacker (or a buggy tool) would.
function reseal(pkg) {
  pkg.manifest.files = pkg.manifest.files.map((f) => {
    const s = canonical(pkg.files[f.path]);
    return { path: f.path, sha256: sha256(s), size: Buffer.byteLength(s) };
  });
  pkg.package_sha256 = sha256(canonical(pkg.manifest));
  return pkg;
}

test("canonical json ignores key order", () => {
  assert.equal(canonical({ b: 1, a: [{ d: 1, c: 2 }] }), canonical({ a: [{ c: 2, d: 1 }], b: 1 }));
});

test("a built package passes every check and yields the content to restore", () => {
  const r = inspectPackage(make());
  assert.equal(r.valid, true);
  assert.deepEqual(r.checks.map((c) => c.name), ["structure", "checksums", "compatibility", "scan"]);
  assert.ok(r.checks.every((c) => c.status === "ok"));
  assert.equal(r.brain.name, "perf");
  assert.deepEqual(r.brain.versions.map((v) => v.version), [1, 2]);
});

test("an edited file is caught by checksums, and later checks are skipped", () => {
  const pkg = make();
  pkg.files["brain.json"].versions[1].capabilities.push("exfiltrate");
  const r = inspectPackage(pkg);
  assert.equal(r.valid, false);
  assert.deepEqual(failedNames(r), ["checksums"]);
  assert.deepEqual(r.checks.slice(2).map((c) => c.status), ["skipped", "skipped"]);
  assert.equal(r.brain, null);
});

test("a re-hashed file with an untouched manifest seal is still caught", () => {
  const pkg = make();
  pkg.files["brain.json"].name = "renamed";
  pkg.manifest.files = pkg.manifest.files.map((f) => {
    const s = canonical(pkg.files[f.path]);
    return { ...f, sha256: sha256(s), size: Buffer.byteLength(s) };
  });
  assert.deepEqual(failedNames(inspectPackage(pkg)), ["checksums"]); // package_sha256 no longer matches the manifest
});

test("structure problems: missing, unlisted, traversal path, too deep", () => {
  let pkg = make(); delete pkg.files["brain.json"];
  assert.deepEqual(failedNames(inspectPackage(pkg)), ["structure"]);
  pkg = make(); pkg.files["extra.json"] = {};
  assert.match(inspectPackage(pkg).checks[0].problems.join(), /not listed/);
  pkg = make(); pkg.manifest.files[0].path = "../evil.json";
  assert.match(inspectPackage(pkg).checks[0].problems.join(), /invalid path/);
  pkg = make(); let deep = {}; for (let i = 0; i < 100; i++) deep = { x: deep };
  pkg.files["brain.json"].versions[0].artifact_refs = [deep];
  assert.match(inspectPackage(pkg).checks[0].problems.join(), /nested deeper/);
  for (const bad of [null, [], "x", 5, {}]) assert.equal(inspectPackage(bad).valid, false);
});

test("an unsupported schema version is refused even when the package is correctly sealed", () => {
  const pkg = make();
  pkg.manifest.package_schema_version = 2;
  pkg.package_sha256 = sha256(canonical(pkg.manifest));
  const r = inspectPackage(pkg);
  assert.deepEqual(failedNames(r), ["compatibility"]);
  assert.match(r.checks[2].problems[0], /unsupported package_schema_version 2/);
});

test("brain.json problems: bad version order, wrong types, manifest mismatch", () => {
  let pkg = make(); pkg.files["brain.json"].versions[1].version = 1;
  assert.deepEqual(failedNames(inspectPackage(reseal(pkg))), ["compatibility"]);
  pkg = make(); pkg.files["brain.json"].versions[0].capabilities = "rank";
  assert.deepEqual(failedNames(inspectPackage(reseal(pkg))), ["compatibility"]);
  pkg = make(); pkg.manifest.brain.name = "other";
  pkg.package_sha256 = sha256(canonical(pkg.manifest));
  assert.match(inspectPackage(pkg).checks[2].problems.join(), /manifest.brain does not match/);
});

test("secrets are refused by path, and the value is never echoed", () => {
  const pkg = make();
  pkg.files["brain.json"].versions[1].artifact_refs = [{ url: "https://x/y", api_key: "hunter2" }, "Bearer abcdefghijklmnop1234"];
  const r = inspectPackage(reseal(pkg));
  assert.deepEqual(failedNames(r), ["scan"]);
  const text = JSON.stringify(r.checks);
  assert.match(text, /artifact_refs\[0\]\.api_key/);
  assert.match(text, /artifact_refs\[1\]/);
  assert.ok(!text.includes("hunter2") && !text.includes("abcdefghijklmnop1234"));
});

test("secret scan does not flag ordinary content", () => {
  assert.deepEqual(findSecrets({ capabilities: ["rank", "explain"], artifact_refs: ["s3://models/perf-v2.bin", { path: "a/b" }], name: "token-economy brain" }), []);
  assert.deepEqual(findSecrets({ a: { password: "x" } }), ["$.a.password"]);
});
