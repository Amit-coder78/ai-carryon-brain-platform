// Per-version Brain settings (brain_versions.params). Pure functions; the engine re-checks the same limits.
// A Brain type that has no settings accepts none, so a setting is never silently ignored.
const DEMAND_LIMITS = { half_life_days: [1, 365], min_requesters: [1, 1000] };

export function validateParams(brainType, params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return ["params must be an object"];
  const keys = Object.keys(params);
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
