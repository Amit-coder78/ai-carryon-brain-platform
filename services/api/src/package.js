// Portable Brain packages (architecture doc: "Export and import").
// Pure functions only: no database, no HTTP. The checksums give integrity (a damaged or edited package is
// rejected); they do not prove who made a package. Authenticity is the optional signature in signing.js,
// which sits outside the sealed content.
import { createHash } from "node:crypto";
import { validateParams } from "./params.js";

export const PACKAGE_SCHEMA_VERSION = 1;
export const MAX_VERSIONS = 100;
const MAX_DEPTH = 32;
const FILE_PATH = /^[a-z0-9][a-z0-9._-]*\.json$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Stable JSON: sorted keys, no whitespace. The same value always gives the same bytes.
export function canonical(v) {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

function tooDeep(v, depth = 0) {
  if (depth > MAX_DEPTH) return true;
  if (v && typeof v === "object") return Object.values(v).some((x) => tooDeep(x, depth + 1));
  return false;
}

// ---- secrets: exports never contain them, imports refuse them -------------------------------------------
// A conservative heuristic, not a guarantee. It reports PATHS only and never echoes a value.
const SECRET_KEY = /^(.*[_-])?(secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|cookie)s?([_-].*)?$/i;
const SECRET_VALUE = [
  /sk-[A-Za-z0-9_-]{16,}/, /Bearer\s+[A-Za-z0-9._~+/-]{12,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /ya29\.[A-Za-z0-9_-]{20,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

export function findSecrets(value, path = "$", out = []) {
  if (typeof value === "string") {
    if (SECRET_VALUE.some((re) => re.test(value))) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((x, i) => findSecrets(x, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, x] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out.push(`${path}.${k}`);
      else findSecrets(x, `${path}.${k}`, out);
    }
  }
  return out;
}

// ---- build ----------------------------------------------------------------------------------------------
export function buildPackage(brain, versions, { actor, now = new Date() }) {
  const files = {
    "brain.json": {
      name: brain.name,
      brain_type: brain.brain_type,
      versions: versions.map((v) => ({ version: v.version, capabilities: v.capabilities, artifact_refs: v.artifact_refs, checksum: v.checksum ?? null, params: v.params ?? {} })),
    },
    "provenance.json": {
      platform: "ai-carryon-brain-platform",
      source_brain_id: brain.brain_id,
      source_origin: brain.origin ?? {},
      exported_at: now.toISOString(),
      exported_by: actor,
    },
  };
  const latest = versions[versions.length - 1];
  const manifest = {
    package_schema_version: PACKAGE_SCHEMA_VERSION,
    brain: {
      source_brain_id: brain.brain_id,
      name: brain.name,
      brain_type: brain.brain_type,
      versions: versions.map((v) => v.version),
      capabilities: latest ? latest.capabilities : [],
    },
    files: Object.keys(files).sort().map((path) => {
      const s = canonical(files[path]);
      return { path, sha256: sha256(s), size: Buffer.byteLength(s) };
    }),
    known_limitations: [
      "Registry data only: no model artifacts, learned state, training snapshots or channel bindings.",
      "Checksums give integrity, not authenticity. A signature, when present, shows who sealed the package, but only matters if you trust that key.",
      "Portability does not guarantee identical results on a different audience.",
    ],
    restoration: "POST /v1/brains/import. The Brain is created inactive (draft) and must be activated or attached.",
  };
  return { manifest, files, package_sha256: sha256(canonical(manifest)) };
}

// ---- inspect (the import workflow's checks, in the doc's order) -------------------------------------------
// Returns { valid, checks: [{name, status: "ok"|"failed"|"skipped", problems: []}], brain }.
// `brain` is the normalized content to restore, or null if any check failed.
export function inspectPackage(pkg) {
  const checks = [];
  let failed = false;
  const run = (name, fn) => {
    if (failed) return void checks.push({ name, status: "skipped", problems: [] });
    const problems = fn();
    if (problems.length) failed = true;
    checks.push({ name, status: problems.length ? "failed" : "ok", problems });
  };

  run("structure", () => {
    const p = [];
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return ["package must be an object"];
    if (tooDeep(pkg)) return [`package is nested deeper than ${MAX_DEPTH} levels`];
    const { manifest, files } = pkg;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) p.push("manifest must be an object");
    if (!files || typeof files !== "object" || Array.isArray(files)) p.push("files must be an object");
    if (typeof pkg.package_sha256 !== "string" || !HEX64.test(pkg.package_sha256)) p.push("package_sha256 must be a 64-character hex string");
    if (p.length) return p;
    if (!Number.isInteger(manifest.package_schema_version)) p.push("manifest.package_schema_version must be an integer");
    if (!Array.isArray(manifest.files)) return [...p, "manifest.files must be an array"];
    const listed = new Set();
    for (const f of manifest.files) {
      if (!f || typeof f.path !== "string" || !FILE_PATH.test(f.path) || f.path.includes("..")) { p.push("manifest.files has an invalid path"); continue; }
      if (listed.has(f.path)) p.push(`manifest.files lists ${f.path} twice`);
      listed.add(f.path);
      if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0) p.push(`manifest entry for ${f.path} needs sha256 and size`);
      if (!(f.path in files)) p.push(`file ${f.path} is listed but missing`);
    }
    for (const path of Object.keys(files)) if (!listed.has(path)) p.push(`file ${path} is present but not listed in the manifest`);
    if (!listed.has("brain.json")) p.push("brain.json is required");
    return p;
  });

  run("checksums", () => {
    const p = [];
    if (sha256(canonical(pkg.manifest)) !== pkg.package_sha256) p.push("package_sha256 does not match the manifest");
    for (const f of pkg.manifest.files) {
      const s = canonical(pkg.files[f.path]);
      if (sha256(s) !== f.sha256) p.push(`checksum mismatch for ${f.path}`);
      else if (Buffer.byteLength(s) !== f.size) p.push(`size mismatch for ${f.path}`);
    }
    return p;
  });

  let brain = null;
  run("compatibility", () => {
    const p = [];
    if (pkg.manifest.package_schema_version !== PACKAGE_SCHEMA_VERSION) {
      return [`unsupported package_schema_version ${pkg.manifest.package_schema_version}; this registry reads ${PACKAGE_SCHEMA_VERSION}`];
    }
    const b = pkg.files["brain.json"];
    const str = (s) => typeof s === "string" && s.trim() && s.length <= 200;
    if (!b || typeof b !== "object") return ["brain.json must be an object"];
    if (!str(b.name)) p.push("brain.json name is required (1-200 chars)");
    if (!str(b.brain_type)) p.push("brain.json brain_type is required (1-200 chars)");
    if (!Array.isArray(b.versions)) return [...p, "brain.json versions must be an array"];
    if (b.versions.length > MAX_VERSIONS) p.push(`a package holds at most ${MAX_VERSIONS} versions`);
    let prev = 0;
    for (const v of b.versions) {
      const ok = v && Number.isInteger(v.version) && v.version > prev
        && Array.isArray(v.capabilities) && v.capabilities.every((x) => typeof x === "string")
        && Array.isArray(v.artifact_refs) && (v.checksum === null || typeof v.checksum === "string");
      if (!ok) { p.push("each version needs an increasing integer version, string capabilities, artifact_refs and checksum"); break; }
      const bad = validateParams(typeof b.brain_type === "string" ? b.brain_type.trim() : "", v.params ?? {});   // packages from before params existed have none
      if (bad.length) { p.push(`version ${v.version}: ${bad.join("; ")}`); break; }
      prev = v.version;
    }
    const m = pkg.manifest.brain;
    if (!m || m.name !== b.name || m.brain_type !== b.brain_type || canonical(m.versions) !== canonical(b.versions.map((v) => v?.version))) {
      p.push("manifest.brain does not match brain.json");
    }
    if (!p.length) brain = { name: b.name.trim(), brain_type: b.brain_type.trim(), versions: b.versions, source_brain_id: m.source_brain_id ?? null };
    return p;
  });

  run("scan", () => {
    // Every file is scanned, including ones this registry does not restore.
    const hits = findSecrets(pkg.files, "files");
    return hits.map((h) => `possible secret at ${h}`);
  });

  if (failed) brain = null;
  return { valid: !failed, checks, brain };
}
