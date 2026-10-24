export class HttpError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const badRequest = (m) => new HttpError(400, "bad_request", m);
export const notFound = (m = "not found") => new HttpError(404, "not_found", m);
export const conflict = (m, details) => new HttpError(409, "conflict", m, details);
export const unprocessable = (code, m, details) => new HttpError(422, code, m, details);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === "string" && UUID.test(s);
export function requireUuid(s, name) { if (!isUuid(s)) throw badRequest(`${name} must be a uuid`); return s; }
export function requireString(s, name) {
  if (typeof s !== "string" || !s.trim() || s.length > 200) throw badRequest(`${name} is required (1-200 chars)`);
  return s.trim();
}
