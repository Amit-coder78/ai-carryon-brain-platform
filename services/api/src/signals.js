import express from "express";
import { createHash } from "node:crypto";
import { tx } from "./db.js";
import { audit } from "./audit.js";
import { badRequest, notFound, conflict, requireUuid, requireString } from "./errors.js";
import { topicKey } from "./topickey.js";
import { wrap, context, idempotent } from "./registry.js";

const MAX_BATCH = 500;
const hashPerson = (workspaceId, id) => createHash("sha256").update(`${workspaceId}:${id}`).digest("hex");

export function signalsRouter(pool) {
  const r = express.Router();

  async function channelInWorkspace(c, ctx, channelId) {
    requireUuid(channelId, "channel_id");
    const { rowCount } = await c.query(`SELECT 1 FROM channels WHERE channel_id=$1 AND workspace_id=$2`, [channelId, ctx.workspaceId]);
    if (!rowCount) throw notFound("channel not found");
  }

  // Demand signals. Store a salted hash of the commenter and the normalized topic only; never the comment text.
  r.post("/comment-signals", wrap(async (req, res) => {
    const ctx = context(req);
    const { channel_id, signals } = req.body ?? {};
    if (!Array.isArray(signals) || !signals.length || signals.length > MAX_BATCH) throw badRequest(`signals must be an array of 1-${MAX_BATCH}`);
    const out = await tx(pool, (c) => idempotent(c, ctx, req, async () => {
      await channelInWorkspace(c, ctx, channel_id);
      const keys = [], hashes = [], kinds = [], times = [];
      let rejected = 0;
      for (const s of signals) {
        const key = topicKey(s?.topic);
        const who = typeof s?.commenter_id === "string" ? s.commenter_id.trim() : "";
        const kind = s?.kind ?? "request";
        const t = s?.observed_at ? new Date(s.observed_at) : new Date();
        if (!key || !who || !["request", "reaction"].includes(kind) || Number.isNaN(t.getTime())) { rejected++; continue; }
        keys.push(key); hashes.push(hashPerson(ctx.workspaceId, who)); kinds.push(kind); times.push(t.toISOString());
      }
      if (keys.length) {
        await c.query(
          `INSERT INTO comment_signals (workspace_id, channel_id, topic_key, commenter_hash, kind, observed_at)
           SELECT $1, $2, k, h, kd, t::timestamptz FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS u(k,h,kd,t)`,
          [ctx.workspaceId, channel_id, keys, hashes, kinds, times]);
      }
      await audit(c, ctx, "signals.ingest", "channel", channel_id, { accepted: keys.length, rejected });
      return { status: 202, body: { accepted: keys.length, rejected } };
    }));
    res.status(out.status).json(out.body);
  }));

  r.post("/observations", wrap(async (req, res) => {
    const ctx = context(req);
    const { channel_id, decision_id, metric, value } = req.body ?? {};
    const video_ref = requireString(req.body?.video_ref, "video_ref");
    const m = requireString(metric, "metric");
    if (typeof value !== "number" || !Number.isFinite(value)) throw badRequest("value must be a finite number");
    const when = req.body?.observed_at ? new Date(req.body.observed_at) : new Date();
    if (Number.isNaN(when.getTime())) throw badRequest("observed_at is not a date");
    const out = await tx(pool, (c) => idempotent(c, ctx, req, async () => {
      await channelInWorkspace(c, ctx, channel_id);
      if (decision_id != null) {
        requireUuid(decision_id, "decision_id");
        const d = await c.query(`SELECT 1 FROM decisions WHERE decision_id=$1 AND workspace_id=$2 AND channel_id=$3`, [decision_id, ctx.workspaceId, channel_id]);
        if (!d.rowCount) throw notFound("decision not found");
      }
      const { rows } = await c.query(
        `INSERT INTO observations (workspace_id, channel_id, decision_id, video_ref, metric, value, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.workspaceId, channel_id, decision_id ?? null, video_ref, m, value, when.toISOString()]);
      await audit(c, ctx, "observation.create", "observation", null, { channel_id, metric: m, decision_id: decision_id ?? null });
      return { status: 202, body: rows[0] };
    }));
    res.status(out.status).json(out.body);
  }));

  r.get("/decisions", wrap(async (req, res) => {
    const ctx = context(req);
    const params = [ctx.workspaceId];
    let sql = `SELECT decision_id, channel_id, execution_id, source, policy_version, selected_candidate, created_at
               FROM decisions WHERE workspace_id=$1`;
    if (req.query.channel_id) { params.push(requireUuid(req.query.channel_id, "channel_id")); sql += ` AND channel_id=$${params.length}`; }
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    res.json({ items: (await pool.query(sql, params)).rows, limit });
  }));

  r.get("/decisions/:decision_id", wrap(async (req, res) => {
    const ctx = context(req);
    requireUuid(req.params.decision_id, "decision_id");
    const { rows } = await pool.query(`SELECT * FROM decisions WHERE decision_id=$1 AND workspace_id=$2`, [req.params.decision_id, ctx.workspaceId]);
    if (!rows.length) throw notFound("decision not found");
    res.json(rows[0]);
  }));

  // The pipeline reports which candidate it actually used. Settable once; must be one of the decision's candidates.
  r.post("/decisions/:decision_id/selection", wrap(async (req, res) => {
    const ctx = context(req);
    requireUuid(req.params.decision_id, "decision_id");
    const cid = requireString(req.body?.candidate_id, "candidate_id");
    const row = await tx(pool, async (c) => {
      const { rows } = await c.query(`SELECT * FROM decisions WHERE decision_id=$1 AND workspace_id=$2 FOR UPDATE`, [req.params.decision_id, ctx.workspaceId]);
      if (!rows.length) throw notFound("decision not found");
      const d = rows[0];
      if (!d.candidates.some((x) => x.candidate_id === cid)) throw badRequest("candidate_id is not part of this decision");
      if (d.selected_candidate) {
        if (d.selected_candidate === cid) return d;   // idempotent retry
        throw conflict("a different candidate was already recorded for this decision");
      }
      const u = await c.query(`UPDATE decisions SET selected_candidate=$2, selected_at=now() WHERE decision_id=$1 RETURNING *`, [d.decision_id, cid]);
      await audit(c, ctx, "decision.select", "decision", d.decision_id, { candidate_id: cid });
      return u.rows[0];
    });
    res.json(row);
  }));

  return r;
}
