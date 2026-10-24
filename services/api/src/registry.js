import express from "express";
import { createHash } from "node:crypto";
import { tx } from "./db.js";
import { audit } from "./audit.js";
import { HttpError, badRequest, notFound, conflict, requireUuid, requireString, isUuid } from "./errors.js";

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const ROLES = ["primary", "supporting", "experimental", "shadow"];
const BRAIN_STATUS = ["draft", "active", "disabled", "archived", "deleted"];

// Phase 2 identity: caller states workspace + actor in headers. REAL authN/authZ replaces this before any
// non-local use; every query below is already scoped by ctx.workspaceId so the swap is one function.
export function context(req) {
  const workspaceId = req.get("x-workspace-id");
  if (!isUuid(workspaceId)) throw badRequest("x-workspace-id header (uuid) is required");
  return { workspaceId, actor: req.get("x-actor") || "anonymous", correlationId: req.correlationId };
}

// Idempotency: same key + same body replays the stored response; same key + different body is a 409.
export async function idempotent(client, ctx, req, run) {
  const key = req.get("idempotency-key");
  if (!key) return run();
  const hash = createHash("sha256").update(req.method + req.path + JSON.stringify(req.body ?? {})).digest("hex");
  const ins = await client.query(
    `INSERT INTO idempotency_keys (key, workspace_id, request_hash) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING key`, [key, ctx.workspaceId, hash]);
  if (ins.rowCount === 0) {
    const { rows } = await client.query(
      `SELECT request_hash, response FROM idempotency_keys WHERE workspace_id=$1 AND key=$2`, [ctx.workspaceId, key]);
    if (rows[0].request_hash !== hash) throw conflict("Idempotency-Key reused with a different request");
    if (!rows[0].response) throw conflict("request with this Idempotency-Key is still in progress");
    return { ...rows[0].response, replayed: true };
  }
  const out = await run();
  await client.query(`UPDATE idempotency_keys SET response=$3 WHERE workspace_id=$1 AND key=$2`,
    [ctx.workspaceId, key, JSON.stringify(out)]);
  return out;
}

export function registryRouter(pool) {
  const r = express.Router();

  // ---- workspaces & channels (minimal: needed so brains/attachments have something to point at) ----
  r.post("/workspaces", wrap(async (req, res) => {
    const name = requireString(req.body?.name, "name");
    const row = await tx(pool, async (c) => {
      const { rows } = await c.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING *`, [name]);
      await audit(c, { workspaceId: rows[0].workspace_id, actor: req.get("x-actor") || "anonymous", correlationId: req.correlationId },
        "workspace.create", "workspace", rows[0].workspace_id, { name });
      return rows[0];
    });
    res.status(201).json(row);
  }));

  r.post("/channels", wrap(async (req, res) => {
    const ctx = context(req);
    const name = requireString(req.body?.name, "name");
    const ref = req.body?.youtube_channel_ref ?? null;
    const row = await tx(pool, async (c) => {
      const ws = await c.query(`SELECT 1 FROM workspaces WHERE workspace_id=$1`, [ctx.workspaceId]);
      if (!ws.rowCount) throw notFound("workspace not found");
      try {
        const { rows } = await c.query(
          `INSERT INTO channels (workspace_id, name, youtube_channel_ref) VALUES ($1,$2,$3) RETURNING *`,
          [ctx.workspaceId, name, ref]);
        await audit(c, ctx, "channel.create", "channel", rows[0].channel_id, { name });
        return rows[0];
      } catch (e) { if (e.code === "23505") throw conflict("channel name already exists in workspace"); throw e; }
    });
    res.status(201).json(row);
  }));

  // ---- brains ----
  r.post("/brains", wrap(async (req, res) => {
    const ctx = context(req);
    const name = requireString(req.body?.name, "name");
    const brainType = requireString(req.body?.brain_type, "brain_type");
    const out = await tx(pool, (c) => idempotent(c, ctx, req, async () => {
      try {
        const { rows } = await c.query(
          `INSERT INTO brains (workspace_id, name, brain_type) VALUES ($1,$2,$3) RETURNING *`,
          [ctx.workspaceId, name, brainType]);
        await audit(c, ctx, "brain.create", "brain", rows[0].brain_id, { name, brain_type: brainType });
        return { status: 201, body: rows[0] };
      } catch (e) {
        if (e.code === "23505") throw conflict("brain name already exists in workspace");
        if (e.code === "23503") throw notFound("workspace not found");
        throw e;
      }
    }));
    res.status(out.status).json(out.body);
  }));

  r.get("/brains", wrap(async (req, res) => {
    const ctx = context(req);
    const params = [ctx.workspaceId];
    let sql = `SELECT * FROM brains WHERE workspace_id=$1 AND status <> 'deleted'`;
    if (req.query.status) {
      if (!BRAIN_STATUS.includes(req.query.status)) throw badRequest("invalid status");
      params.push(req.query.status); sql += ` AND status=$${params.length}`;
    }
    if (req.query.type) { params.push(String(req.query.type)); sql += ` AND brain_type=$${params.length}`; }
    if (req.query.name) { params.push(`%${String(req.query.name).replace(/[%_\\]/g, "\\$&")}%`); sql += ` AND name ILIKE $${params.length}`; }
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    params.push(limit, offset);
    sql += ` ORDER BY created_at DESC, brain_id LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);
    res.json({ items: rows, limit, offset });
  }));

  async function loadBrain(c, ctx, id, lock = false) {
    requireUuid(id, "brain_id");
    const { rows } = await c.query(`SELECT * FROM brains WHERE brain_id=$1 AND workspace_id=$2 AND status <> 'deleted' ${lock ? "FOR UPDATE" : ""}`, [id, ctx.workspaceId]);
    if (!rows.length) throw notFound("brain not found"); // same answer for "exists in another workspace"
    return rows[0];
  }

  r.get("/brains/:brain_id", wrap(async (req, res) => {
    const ctx = context(req);
    res.json(await loadBrain(pool, ctx, req.params.brain_id));
  }));

  r.get("/brains/:brain_id/versions", wrap(async (req, res) => {
    const ctx = context(req);
    await loadBrain(pool, ctx, req.params.brain_id);
    const { rows } = await pool.query(`SELECT * FROM brain_versions WHERE brain_id=$1 ORDER BY version DESC`, [req.params.brain_id]);
    res.json({ items: rows });
  }));

  // New immutable version. Numbering is serialized per brain by locking the brain row.
  r.post("/brains/:brain_id/versions", wrap(async (req, res) => {
    const ctx = context(req);
    const caps = req.body?.capabilities ?? [];
    const arts = req.body?.artifact_refs ?? [];
    if (!Array.isArray(caps) || !caps.every((x) => typeof x === "string")) throw badRequest("capabilities must be an array of strings");
    if (!Array.isArray(arts)) throw badRequest("artifact_refs must be an array");
    const checksum = req.body?.checksum ?? null;
    const row = await tx(pool, async (c) => {
      requireUuid(req.params.brain_id, "brain_id");
      const b = await c.query(`SELECT * FROM brains WHERE brain_id=$1 AND workspace_id=$2 AND status <> 'deleted' FOR UPDATE`,
        [req.params.brain_id, ctx.workspaceId]);
      if (!b.rowCount) throw notFound("brain not found");
      if (b.rows[0].status === "archived") throw conflict("brain is archived");
      const { rows } = await c.query(
        `INSERT INTO brain_versions (brain_id, version, capabilities, artifact_refs, checksum)
         VALUES ($1, COALESCE((SELECT MAX(version) FROM brain_versions WHERE brain_id=$1),0)+1, $2, $3, $4) RETURNING *`,
        [req.params.brain_id, JSON.stringify(caps), JSON.stringify(arts), checksum]);
      await c.query(`UPDATE brains SET updated_at=now(), status = CASE WHEN status='draft' THEN 'active' ELSE status END WHERE brain_id=$1`, [req.params.brain_id]);
      await audit(c, ctx, "brain.version.create", "brain", req.params.brain_id, { version: rows[0].version });
      return rows[0];
    });
    res.status(201).json(row);
  }));

  // ---- attachments ----
  async function loadAttachment(c, ctx, id, lock = false) {
    requireUuid(id, "attachment_id");
    const { rows } = await c.query(
      `SELECT a.* FROM attachments a JOIN brains b ON b.brain_id=a.brain_id
       WHERE a.attachment_id=$1 AND b.workspace_id=$2 ${lock ? "FOR UPDATE OF a" : ""}`, [id, ctx.workspaceId]);
    if (!rows.length) throw notFound("attachment not found");
    return rows[0];
  }

  async function checkVersion(c, brainId, versionId) {
    const { rows } = await c.query(`SELECT 1 FROM brain_versions WHERE brain_version_id=$1 AND brain_id=$2`, [versionId, brainId]);
    if (!rows.length) throw badRequest("brain_version_id does not belong to this brain");
  }

  r.post("/attachments", wrap(async (req, res) => {
    const ctx = context(req);
    const { brain_id, channel_id, brain_version_id } = req.body ?? {};
    requireUuid(brain_id, "brain_id"); requireUuid(channel_id, "channel_id"); requireUuid(brain_version_id, "brain_version_id");
    const role = req.body.role ?? "supporting";
    if (!ROLES.includes(role)) throw badRequest(`role must be one of ${ROLES.join(", ")}`);
    const out = await tx(pool, (c) => idempotent(c, ctx, req, async () => {
      // Locked: archive/delete take the same lock, so a Brain can't be archived while a binding is being added.
      const brain = await loadBrain(c, ctx, brain_id, true);
      if (!["active", "draft"].includes(brain.status)) throw conflict(`brain is ${brain.status}`);
      const ch = await c.query(`SELECT 1 FROM channels WHERE channel_id=$1 AND workspace_id=$2`, [channel_id, ctx.workspaceId]);
      if (!ch.rowCount) throw notFound("channel not found");
      await checkVersion(c, brain_id, brain_version_id);
      try {
        const { rows } = await c.query(
          `INSERT INTO attachments (brain_id, channel_id, role, enabled, status, attached_version_id, config)
           VALUES ($1,$2,$3,true,'active',$4,$5) RETURNING *`,
          [brain_id, channel_id, role, brain_version_id, JSON.stringify(req.body.config ?? {})]);
        await audit(c, ctx, "attachment.create", "attachment", rows[0].attachment_id, { brain_id, channel_id, role });
        // Only active Brains run. A draft Brain (cloned or imported) becomes active when it is attached, never silently idle.
        if (brain.status === "draft") {
          await c.query(`UPDATE brains SET status='active', updated_at=now() WHERE brain_id=$1`, [brain_id]);
          await audit(c, ctx, "brain.activate", "brain", brain_id, { via: "attach" });
        }
        return { status: 201, body: rows[0] };
      } catch (e) {
        if (e.constraint === "one_primary_per_channel") throw conflict("channel already has an active primary brain");
        if (e.constraint === "one_live_attachment_per_brain_channel") throw conflict("brain is already attached to this channel");
        throw e;
      }
    }));
    res.status(out.status).json(out.body);
  }));

  function transition(action, to, extra = "") {
    return wrap(async (req, res) => {
      const ctx = context(req);
      const row = await tx(pool, async (c) => {
        const a = await loadAttachment(c, ctx, req.params.attachment_id, true);
        if (a.status === "detached") throw conflict("attachment is detached");
        const { rows } = await c.query(
          `UPDATE attachments SET status=$2, enabled=false, updated_at=now() WHERE attachment_id=$1 RETURNING *`,
          [a.attachment_id, to]);
        await audit(c, ctx, `attachment.${action}`, "attachment", a.attachment_id, { from: a.status });
        return rows[0];
      });
      res.json(row);
    });
  }
  r.post("/attachments/:attachment_id/detach", transition("detach", "detached"));
  r.post("/attachments/:attachment_id/disable", transition("disable", "disabled"));

  // Atomic switch to another version of the same brain (old version row is untouched; rollback = replace again).
  r.post("/attachments/:attachment_id/replace", wrap(async (req, res) => {
    const ctx = context(req);
    const versionId = requireUuid(req.body?.brain_version_id, "brain_version_id");
    const row = await tx(pool, async (c) => {
      const a = await loadAttachment(c, ctx, req.params.attachment_id, true);
      if (a.status !== "active") throw conflict(`attachment is ${a.status}`);
      await checkVersion(c, a.brain_id, versionId);
      const { rows } = await c.query(
        `UPDATE attachments SET attached_version_id=$2, updated_at=now() WHERE attachment_id=$1 RETURNING *`, [a.attachment_id, versionId]);
      await audit(c, ctx, "attachment.replace", "attachment", a.attachment_id, { from: a.attached_version_id, to: versionId });
      return rows[0];
    });
    res.json(row);
  }));

  r.get("/channels/:channel_id/brains", wrap(async (req, res) => {
    const ctx = context(req);
    requireUuid(req.params.channel_id, "channel_id");
    const { rows } = await pool.query(
      `SELECT a.*, b.name AS brain_name, b.brain_type, v.version AS attached_version
       FROM attachments a
       JOIN brains b ON b.brain_id=a.brain_id
       JOIN channels ch ON ch.channel_id=a.channel_id
       LEFT JOIN brain_versions v ON v.brain_version_id=a.attached_version_id
       WHERE a.channel_id=$1 AND ch.workspace_id=$2 AND b.workspace_id=$2 AND a.status <> 'detached'
       ORDER BY a.created_at`, [req.params.channel_id, ctx.workspaceId]);
    res.json({ items: rows });
  }));

  r.get("/audit", wrap(async (req, res) => {
    const ctx = context(req);
    const { rows } = await pool.query(
      `SELECT * FROM audit_log WHERE workspace_id=$1 ORDER BY audit_id DESC LIMIT 200`, [ctx.workspaceId]);
    res.json({ items: rows });
  }));

  return r;
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), correlation_id: req.correlationId });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ code: "bad_request", message: "invalid JSON", correlation_id: req.correlationId });
  if (err.type === "entity.too.large") return res.status(413).json({ code: "too_large", message: "request body is larger than 1 MB", correlation_id: req.correlationId });
  console.error(JSON.stringify({ level: "error", correlation_id: req.correlationId, message: err.message }));
  res.status(500).json({ code: "internal", message: "internal error", correlation_id: req.correlationId });
}
