import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildPackage, inspectPackage, canonical, sha256 } from "./package.js";
import { generateSigningKey, loadSigningKey, signPackage, checkSignature, signingConfigFromEnv, keyIdOf } from "./signing.js";

const brain = { brain_id: "11111111-1111-4111-8111-111111111111", name: "perf", brain_type: "performance", origin: {} };
const versions = [{ version: 1, capabilities: ["rank"], artifact_refs: [], checksum: null }];
const plain = () => structuredClone(buildPackage(brain, versions, { actor: "tester" }));
const mkSigner = () => { const k = generateSigningKey(); return { ...loadSigningKey(k.private_key), raw: k }; };
const alice = mkSigner();
const mallory = mkSigner();
const trust = (...s) => ({ trustedKeys: new Set(s.map((x) => x.keyId)), require: false });
function reseal(pkg) {
  pkg.manifest.files = pkg.manifest.files.map((f) => {
    const s = canonical(pkg.files[f.path]);
    return { path: f.path, sha256: sha256(s), size: Buffer.byteLength(s) };
  });
  pkg.package_sha256 = sha256(canonical(pkg.manifest));
  return pkg;
}

test("a signed package verifies, names its signer, and is trusted only if its key is on the list", () => {
  const pkg = signPackage(plain(), alice);
  assert.equal(pkg.signature.key_id, alice.keyId);
  const trusted = checkSignature(pkg, trust(alice));
  assert.deepEqual([trusted.status, trusted.result, trusted.signer], ["ok", "valid", { key_id: alice.keyId, trusted: true }]);
  const stranger = checkSignature(pkg, trust(mallory));
  assert.deepEqual([stranger.status, stranger.result, stranger.signer.trusted], ["ok", "valid", false]);
});

test("signing adds a block outside the sealed content: checksums, scan and every other check are unchanged", () => {
  const before = plain();
  const signed = signPackage(before, alice);
  assert.equal(signed.package_sha256, before.package_sha256);
  assert.deepEqual(signed.manifest, before.manifest);
  const r = inspectPackage(signed);
  assert.equal(r.valid, true);
  assert.deepEqual(r.checks.map((c) => c.name), ["structure", "checksums", "compatibility", "scan"]);
  assert.equal(before.signature, undefined, "signPackage returns a copy");
});

test("unsigned: fine by default, refused when signatures are required", () => {
  assert.deepEqual(checkSignature(plain()), { name: "signature", status: "ok", result: "unsigned", problems: [], signer: null });
  const r = checkSignature(plain(), { require: true });
  assert.deepEqual([r.status, r.result], ["failed", "unsigned"]);
});

test("require: a valid signature from an untrusted key is refused, a trusted one passes", () => {
  const pkg = signPackage(plain(), mallory);
  const refused = checkSignature(pkg, { trustedKeys: new Set([alice.keyId]), require: true });
  assert.equal(refused.status, "failed");
  assert.equal(refused.result, "valid");
  assert.match(refused.problems[0], /does not trust/);
  assert.equal(checkSignature(pkg, { trustedKeys: new Set([mallory.keyId]), require: true }).status, "ok");
});

test("editing a signed package and re-sealing it breaks the signature (checksums alone would not)", () => {
  const pkg = signPackage(plain(), alice);
  pkg.files["brain.json"].versions[0].capabilities.push("exfiltrate");
  reseal(pkg);
  assert.equal(inspectPackage(pkg).valid, true, "the forger fixed every checksum");
  const r = checkSignature(pkg, trust(alice));
  assert.deepEqual([r.status, r.result], ["failed", "invalid"]);
});

test("swapping in your own key and signature gives a valid but untrusted package; a mismatched key_id is invalid", () => {
  const forged = signPackage(plain(), alice);
  forged.files["brain.json"].name = "evil";
  reseal(forged);
  const resigned = signPackage(forged, mallory);   // attacker signs the edited package with their own key
  const r = checkSignature(resigned, { trustedKeys: new Set([alice.keyId]), require: true });
  assert.equal(r.status, "failed");
  assert.equal(r.signer.key_id, mallory.keyId);
  assert.equal(r.signer.trusted, false);

  const lying = signPackage(plain(), mallory);
  lying.signature.key_id = alice.keyId;             // claim to be alice while carrying mallory's public key
  const l = checkSignature(lying, { trustedKeys: new Set([alice.keyId]), require: true });
  assert.deepEqual([l.status, l.result], ["failed", "invalid"]);
  assert.match(l.problems[0], /key_id does not match/);
});

test("a signature over the bare hash (no domain prefix) is not accepted", async () => {
  const { sign } = await import("node:crypto");
  const pkg = plain();
  pkg.signature = { alg: "ed25519", key_id: alice.keyId, public_key: alice.publicKey,
    value: sign(null, Buffer.from(pkg.package_sha256), alice.key).toString("base64") };
  assert.equal(checkSignature(pkg, trust(alice)).result, "invalid");
});

test("garbage signature blocks never throw and are always failures, even when signatures are optional", () => {
  const junk = [null, 0, "x", [], {}, { alg: "rsa" }, { alg: "ed25519", public_key: "!!", value: "!!" },
    { alg: "ed25519", key_id: "a".repeat(64), public_key: "AAAA", value: "AAAA" },
    { alg: "ed25519", key_id: keyIdOf(Buffer.from("AAAA", "base64")), public_key: "AAAA", value: "AAAA" }];
  for (const sig of junk) {
    const pkg = plain();
    pkg.signature = sig;
    const r = checkSignature(pkg, {});
    assert.deepEqual([r.status, r.result], ["failed", "invalid"], JSON.stringify(sig));
  }
  assert.equal(checkSignature(null, {}).result, "unsigned");
  assert.doesNotThrow(() => checkSignature({ signature: alice.raw }, {}));
});

test("a non-Ed25519 public key is refused", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" });
  const pkg = plain();
  pkg.signature = { alg: "ed25519", key_id: createHash("sha256").update(rsa).digest("hex"), public_key: rsa.toString("base64"), value: "AAAA" };
  assert.match(checkSignature(pkg, {}).problems[0], /not an Ed25519 key/);
});

test("config: own key is trusted, trusted ids are validated, the require flag is read, bad keys never echo", () => {
  const k = generateSigningKey();
  const cfg = signingConfigFromEnv({ BRAIN_SIGNING_KEY: k.private_key, BRAIN_TRUSTED_KEYS: ` ${alice.keyId.toUpperCase()} , ` , BRAIN_REQUIRE_SIGNATURE: "true" });
  assert.equal(cfg.signer.keyId, k.key_id);
  assert.deepEqual([...cfg.trustedKeys].sort(), [alice.keyId, k.key_id].sort());
  assert.equal(cfg.require, true);
  const none = signingConfigFromEnv({});
  assert.deepEqual([none.signer, none.trustedKeys.size, none.require], [null, 0, false]);
  assert.throws(() => signingConfigFromEnv({ BRAIN_TRUSTED_KEYS: "not-hex" }), /64-character hex/);
  const secret = "c3VwZXItc2VjcmV0LW5vdC1hLWtleQ==";
  assert.throws(() => signingConfigFromEnv({ BRAIN_SIGNING_KEY: secret }), (e) => !e.message.includes(secret) && /valid base64 PKCS#8/.test(e.message));
});
