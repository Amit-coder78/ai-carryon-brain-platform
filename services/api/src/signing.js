// Package signatures (Phase 7 follow-up). Pure functions plus config parsing; no database, no HTTP.
//
// What a signature proves: the package was sealed by whoever holds the private key behind `key_id`, and
// nothing in it changed since. It covers `package_sha256`, which already seals the manifest and every file.
// The signature sits OUTSIDE the sealed content, so signing never changes a package's checksums, and an
// unsigned package from an older export stays valid.
//
// What it does not prove: that you should trust that key. The public key travels inside the package, so a
// valid signature only says "consistent". Trust comes from this registry's allow-list (BRAIN_TRUSTED_KEYS).
// Ed25519 via node:crypto; no new dependency. Keys are base64 DER (PKCS#8 private, SPKI public): one line each.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonical, sha256 } from "./package.js";

export const SIGNATURE_ALG = "ed25519";
// Domain separation: a signature made for packages can never double as a signature over some other 32-byte hash.
const DOMAIN = "ai-carryon-brain-package/v1\n";
const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const NO_SIGNING = Object.freeze({ signer: null, trustedKeys: new Set(), require: false });

const message = (packageSha) => Buffer.from(DOMAIN + packageSha);
export const keyIdOf = (publicDer) => createHash("sha256").update(publicDer).digest("hex");

export function generateSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" });
  return {
    private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    public_key: pub.toString("base64"),
    key_id: keyIdOf(pub),
  };
}

// Never echoes the key material in an error.
export function loadSigningKey(b64) {
  const bad = () => new Error("BRAIN_SIGNING_KEY is not a valid base64 PKCS#8 Ed25519 private key (make signing-key creates one)");
  if (typeof b64 !== "string" || !B64.test(b64)) throw bad();
  let key;
  try { key = createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" }); } catch { throw bad(); }
  if (key.asymmetricKeyType !== "ed25519") throw bad();
  const pub = createPublicKey(key).export({ format: "der", type: "spki" });
  return { key, publicKey: pub.toString("base64"), keyId: keyIdOf(pub) };
}

export function signingConfigFromEnv(env = process.env) {
  const signer = env.BRAIN_SIGNING_KEY?.trim() ? loadSigningKey(env.BRAIN_SIGNING_KEY.trim()) : null;
  const trustedKeys = new Set();
  for (const raw of (env.BRAIN_TRUSTED_KEYS ?? "").split(",")) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    if (!HEX64.test(id)) throw new Error("BRAIN_TRUSTED_KEYS must be comma-separated 64-character hex key ids");
    trustedKeys.add(id);
  }
  if (signer) trustedKeys.add(signer.keyId);   // a registry trusts its own key: it can re-import what it exported
  const require = ["1", "true"].includes((env.BRAIN_REQUIRE_SIGNATURE ?? "").trim().toLowerCase());
  return { signer, trustedKeys, require };
}

// Returns a copy of the package with a `signature` block. Signs the hash of the manifest as it is NOW, not the
// package's claimed package_sha256, so a package with a lying hash gets a signature that will not verify.
export function signPackage(pkg, signer) {
  const value = sign(null, message(sha256(canonical(pkg.manifest))), signer.key).toString("base64");
  return { ...pkg, signature: { alg: SIGNATURE_ALG, key_id: signer.keyId, public_key: signer.publicKey, value } };
}

// One entry for the import report's `checks` list. Never throws, whatever the input looks like.
//   result: "unsigned" | "valid" | "invalid"; signer: { key_id, trusted } when the signature verified.
// A signature that is present but wrong is ALWAYS a failure. An unsigned package, or one signed by a key this
// registry does not trust, fails only when `require` is on.
export function checkSignature(pkg, { trustedKeys = new Set(), require = false } = {}) {
  const out = (status, result, problems = [], signer = null) => ({ name: "signature", status, result, problems, signer });
  const sig = pkg?.signature;
  if (sig === undefined) {
    return require ? out("failed", "unsigned", ["package is not signed and this registry requires signed packages"]) : out("ok", "unsigned");
  }
  const invalid = (why) => out("failed", "invalid", [why]);
  if (!sig || typeof sig !== "object" || Array.isArray(sig)) return invalid("signature must be an object");
  if (sig.alg !== SIGNATURE_ALG) return invalid(`unsupported signature algorithm; this registry reads ${SIGNATURE_ALG}`);
  if (typeof sig.public_key !== "string" || !B64.test(sig.public_key) || typeof sig.value !== "string" || !B64.test(sig.value)) {
    return invalid("signature needs a base64 public_key and value");
  }
  let pub, der;
  try {
    der = Buffer.from(sig.public_key, "base64");
    pub = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch { return invalid("signature public_key is not a valid key"); }
  if (pub.asymmetricKeyType !== "ed25519") return invalid("signature public_key is not an Ed25519 key");
  if (keyIdOf(der) !== sig.key_id) return invalid("signature key_id does not match its public_key");
  let ok = false;
  try {
    const sha = sha256(canonical(pkg.manifest));
    ok = verify(null, message(sha), pub, Buffer.from(sig.value, "base64"));
  } catch { ok = false; }
  if (!ok) return invalid("signature does not match the package: it was edited after signing, or signed with another key");
  const trusted = trustedKeys.has(sig.key_id);
  const signer = { key_id: sig.key_id, trusted };
  if (require && !trusted) return out("failed", "valid", [`signed by key ${sig.key_id}, which this registry does not trust`], signer);
  return out("ok", "valid", [], signer);
}
