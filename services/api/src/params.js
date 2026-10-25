// Per-version Brain settings (brain_versions.params). Pure functions; the engine re-checks the same limits.
// A Brain type that has no settings accepts none, so a setting is never silently ignored.
const DEMAND_LIMITS = { half_life_days: [1, 365], min_requesters: [1, 1000] };
const SEMANTIC_LIMITS = { min_neighbors: [1, 50], prior_strength: [0.5, 50], repeat_similarity: [0.5, 1] };

export function validateParams(brainType, params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return ["params must be an object"];
  const keys = Object.keys(params);
  if (brainType === "semantic") return validateSemantic(params, keys);
  if (brainType !== "demand") {
    return keys.length ? [`brain_type "${brainType}" takes no params`] : [];
  }
  const p = [];
  for (const k of keys) if (!(k in DEMAND_LIMITS)) p.push(`unknown demand param: ${k}`);
  const h = params.half_life_days;
  if ("half_life_days" in params && !(typeof h === "number" && Number.isFinite(h) && h >= DEMAND_LIMITS.half_life_days[0] && h <= DEMAND_LIMITS.half_life_days[1])) {
    p.push(`half_life_days must be a number between ${DEMAND_LIMITS.half_life_days[0]} and ${DEMAND_LIMITS.half_life_days[1]}`);
  }
  const m = params.min_requesters;
  if ("min_requesters" in params && !(Number.isInteger(m) && m >= DEMAND_LIMITS.min_requesters[0] && m <= DEMAND_LIMITS.min_requesters[1])) {
    p.push(`min_requesters must be an integer between ${DEMAND_LIMITS.min_requesters[0]} and ${DEMAND_LIMITS.min_requesters[1]}`);
  }
  return p;
}

function validateSemantic(params, keys) {
  const p = [];
  for (const k of keys) if (!(k in SEMANTIC_LIMITS)) p.push(`unknown semantic param: ${k}`);
  const m = params.min_neighbors;
  if ("min_neighbors" in params && !(Number.isInteger(m) && m >= SEMANTIC_LIMITS.min_neighbors[0] && m <= SEMANTIC_LIMITS.min_neighbors[1])) {
    p.push(`min_neighbors must be an integer between ${SEMANTIC_LIMITS.min_neighbors[0]} and ${SEMANTIC_LIMITS.min_neighbors[1]}`);
  }
  for (const k of ["prior_strength", "repeat_similarity"]) {
    const v = params[k];
    if (k in params && !(typeof v === "number" && Number.isFinite(v) && v >= SEMANTIC_LIMITS[k][0] && v <= SEMANTIC_LIMITS[k][1])) {
      p.push(`${k} must be a number between ${SEMANTIC_LIMITS[k][0]} and ${SEMANTIC_LIMITS[k][1]}`);
    }
  }
  return p;
}
