// Phase 7: Brain lifecycle (roadmap step 4) and portable packages (step 11).
// Disable, detach, archive, replace, clone and delete are different operations (architecture doc).
// Everything here is synchronous: a package holds registry data only, so there is no job to wait for.
import express from "express";
import { tx } from "./db.js";
import { audit } from "./audit.js";
import { HttpError, badRequest, notFound, conflict, unprocessable, requireUuid, requireString } from "./errors.js";
import { context, idempotent, wrap } from "./registry.js";
import { buildPackage, inspectPackage, findSecrets, MAX_VERSIONS } from "./package.js";

const LIVE = ["pending", "active", "disabled"];
const NOT_COPIED = ["attachments", "audit history", "decision history", "evaluation status", "credentials"];

// Best-effort audit for refusals: it runs after the transaction rolled back, and must never hide the real error.
const auditRefusal = (pool, ctx, action, detail) => audit(pool, ctx, action, "brain", null, detail).catch(() => {});

export function lifecycleRouter(pool) {
  const r = express.Router();

  async function loadBrain(c, ctx, id, lock) {
    requireUuid(id, "brain_id");
    const { rows } = await c.query(
      `SELECT * FROM brains WHERE brain_id=$1 AND workspace_id=$2 AND status <> 'deleted' ${lock ? "FOR UPDATE" : ""}`, [id, ctx.workspaceId]);
    if (!rows.length) throw notFound("brain not found"); // same answer for "exists in another workspace"
    return rows[0];
  }

  async function requireWorkspace(c, ctx) {
    const { rowCount } = await c.query(`SELECT 1 FROM workspaces WHERE workspace_id=$1`, [ctx.workspaceId]);
    if (!rowCount) throw notFound("workspace not found");
  }

  async function insertBrain(c, ctx, { name, brainType, origin }) {
    try {
      const { rows } = await c.query(
        `INSERT INTO brains (workspace_id, name, brain_type, status, origin) VALUES ($1,$2,$3,'draft',$4) RETURNING *`,
        [ctx.workspaceId, name, brainType, JSON.stringify(origin)]);
      return rows[0];
    } catch (e) {
      if (e.code === "23505") throw conflict("brain name already exists in workspace; pass a different name");
      if (e.code === "23503") throw notFound("workspace not found");
      throw e;
    }
  }

  // Copies are renumbered from 1 (new identity). Evaluation never carries over: the copy has to earn it again.
  async function insertVersions(c, brainId, versions) {
    const out = [];
    for (const [i, v] of versions.entries()) {
      const { rows } = await c.query(
        `INSERT INTO brain_versions (brain_id, version, capabilities, artifact_refs, checksum) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [brainId, i + 1, JSON.stringify(v.capabilities), JSON.stringify(v.artifact_refs), v.checksum ?? null]);
      out.push(rows[0]);
    }
    return out;
  }

  const versionsOf = async (c, brainId) =>
    (await c.query(`SELECT * FROM brain_versions WHERE brain_id=$1 ORDER BY version`, [brainId])).rows;

  // ---- dependency inspection: what would archive or delete touch? ----
  async function inspect(c, ctx, brain) {
    const bindings = (await c.query(
      `SELECT a.attachment_id, a.channel_id, ch.name AS channel_name, a.role, a.status
       FROM attachments a JOIN channels ch ON ch.channel_id=a.channel_id
       WHERE a.brain_id=$1 AND a.status = ANY($2) ORDER BY a.created_at`, [brain.brain_id, LIVE])).rows;
    const clones = (await c.query(
      `SELECT brain_id, name, status FROM brains
       WHERE workspace_id=$1 AND status <> 'deleted' AND origin->>'from_brain_id' = $2 ORDER BY created_at`,
      [ctx.workspaceId, brain.brain_id])).rows;
    const exports = (await c.query(`SELECT count(*)::int n FROM brain_exports WHERE brain_id=$1`, [brain.brain_id])).rows[0].n;
    const decisions = (await c.query(
      `SELECT count(*)::int n FROM decisions WHERE workspace_id=$1 AND brains @> $2::jsonb`,
      [ctx.workspaceId, JSON.stringify([{ brain_id: brain.brain_id }])])).rows[0].n;
    const versions = (await c.query(`SELECT count(*)::int n FROM brain_versions WHERE brain_id=$1`, [brain.brain_id])).rows[0].n;

    const archiveBlockers = [];
    if (brain.status === "archived") archiveBlockers.push("brain is already archived");
    if (bindings.length) archiveBlockers.push(`${bindings.length} live attachment(s); pass detach_attachments: true to detach them`);
    const deleteBlockers = [];
    if (!["draft", "archived"].includes(brain.status)) deleteBlockers.push(`brain is ${brain.status}; archive it before deleting`);
    if (bindings.length) deleteBlockers.push(`${bindings.length} live attachment(s); detach them first`);
    return {
      brain_id: brain.brain_id, status: brain.status, versions, bindings,
      // A clone is a snapshot with its own identity, so it never blocks the source. Listed for information.
      dependent_brains: clones, exports, decisions,
      archive: { allowed: !archiveBlockers.length, blockers: archiveBlockers },
      delete: { allowed: !deleteBlockers.length, blockers: deleteBlockers },
    };
  }

  r.get("/brains/:brain_id/dependencies", wrap(async (req, res) => {
    const ctx = context(req);
    res.json(await inspect(pool, ctx, await loadBrain(pool, ctx, req.params.brain_id)));
  }));

  // ---- clone: new identity from a snapshot; the caller chooses what is copied ----
  r.post("/brains/:brain_id/clone", wrap(async (req, res) => {
    const ctx = context(req);
    const mode = req.body?.versions ?? "latest";
    if (!["latest", "all", "none"].includes(mode)) throw badRequest("versions must be latest, all or none");
    const given = req.body?.name !== undefined ? requireString(req.body.name, "name") : null;
    const out = await tx(pool, (c) => idempotent(c, ctx, req, async () => {
      const src = await loadBrain(c, ctx, req.params.brain_id);
      const all = await versionsOf(c, src.brain_id);
      const picked = mode === "none" ? [] : mode === "latest" ? all.slice(-1) : all;
      const brain = await insertBrain(c, ctx, {
        name: given ?? `${src.name} (clone)`.slice(0, 200), brainType: src.brain_type,
        origin: { kind: "clone", from_brain_id: src.brain_id, source_versions: picked.map((v) => v.version) },
      });
      const versions = await insertVersions(c, brain.brain_id, picked);
      await audit(c, ctx, "brain.clone", "brain", brain.brain_id, { from_brain_id: src.brain_id, versions: mode, copied: versions.length });
      return { status: 201, body: { brain, versions, copied: { versions: mode }, not_copied: NOT_COPIED } };
    }));
    res.status(out.status).json(out.body);
  }));

  // ---- activate: draft -> active (attaching a draft Brain does the same) ----
  r.post("/brains/:brain_id/activate", wrap(async (req, res) => {
    const ctx = context(req);
    const row = await tx(pool, async (c) => {
      const b = await loadBrain(c, ctx, req.params.brain_id, true);
      if (b.status !== "draft") throw conflict(`brain is ${b.status}`);
      if (!(await versionsOf(c, b.brain_id)).length) throw conflict("brain has no versions to activate");
      const { rows } = await c.query(`UPDATE brains SET status='active', updated_at=now() WHERE brain_id=$1 RETURNING *`, [b.brain_id]);
      await audit(c, ctx, "brain.activate", "brain", b.brain_id, { via: "activate" });
      return rows[0];
    });
    res.json(row);
  }));

  // ---- archive: out of normal selection, records and versions stay ----
  r.post("/brains/:brain_id/archive", wrap(async (req, res) => {
    const ctx = context(req);
    const detach = req.body?.detach_attachments === true;
    if (req.body?.detach_attachments !== undefined && typeof req.body.detach_attachments !== "boolean") throw badRequest("detach_attachments must be a boolean");
    const row = await tx(pool, async (c) => {
      const b = await loadBrain(c, ctx, req.params.brain_id, true);
      if (b.status === "archived") throw conflict("brain is already archived");
      const live = (await c.query(`SELECT attachment_id, channel_id, role, status FROM attachments WHERE brain_id=$1 AND status = ANY($2) FOR UPDATE`, [b.brain_id, LIVE])).rows;
      if (live.length && !detach) throw conflict(`brain has ${live.length} live attachment(s); detach them or pass detach_attachments: true`, { bindings: live });
      for (const a of live) {
        await c.query(`UPDATE attachments SET status='detached', enabled=false, updated_at=now() WHERE attachment_id=$1`, [a.attachment_id]);
        await audit(c, ctx, "attachment.detach", "attachment", a.attachment_id, { from: a.status, via: "archive" });
      }
      const { rows } = await c.query(`UPDATE brains SET status='archived', updated_at=now() WHERE brain_id=$1 RETURNING *`, [b.brain_id]);
      await audit(c, ctx, "brain.archive", "brain", b.brain_id, { from: b.status, detached: live.length });
      return { ...rows[0], detached_attachments: live.length };
    });
    res.json(row);
  }));

  r.post("/brains/:brain_id/unarchive", wrap(async (req, res) => {
    const ctx = context(req);
    const row = await tx(pool, async (c) => {
      const b = await loadBrain(c, ctx, req.params.brain_id, true);
      if (b.status !== "archived") throw conflict(`brain is ${b.status}`);
      const to = (await versionsOf(c, b.brain_id)).length ? "active" : "draft";
      const { rows } = await c.query(`UPDATE brains SET status=$2, updated_at=now() WHERE brain_id=$1 RETURNING *`, [b.brain_id, to]);
      await audit(c, ctx, "brain.unarchive", "brain", b.brain_id, { to });
      return rows[0]; // attachments stay detached: restoring a Brain never silently re-binds it to a channel
    });
    res.json(row);
  }));

  // ---- delete: soft. Versions, audit and decision records stay readable; only the Brain leaves normal view ----
  r.delete("/brains/:brain_id", wrap(async (req, res) => {
    const ctx = context(req);
    const out = await tx(pool, async (c) => {
      const b = await loadBrain(c, ctx, req.params.brain_id, true);
      const d = await inspect(c, ctx, b);
      if (!d.delete.allowed) throw conflict("brain cannot be deleted", { blockers: d.delete.blockers, bindings: d.bindings });
      await c.query(`UPDATE brains SET status='deleted', deleted_at=now(), updated_at=now() WHERE brain_id=$1`, [b.brain_id]);
      await audit(c, ctx, "brain.delete", "brain", b.brain_id, { from: b.status, retained: { versions: d.versions, decisions: d.decisions, exports: d.exports }, dependent_brains: d.dependent_brains.length });
      return { brain_id: b.brain_id, status: "deleted", retained: { versions: d.versions, decisions: d.decisions, exports: d.exports } };
    });
    res.json(out);
  }));

  // ---- export ----
  r.post("/brains/:brain_id/export", wrap(async (req, res) => {
    const ctx = context(req);
    const mode = req.body?.versions ?? "all";
    if (!["all", "latest"].includes(mode)) throw badRequest("versions must be all or latest");
    let out;
    try {
      out = await tx(pool, (c) => idempotent(c, ctx, req, async () => {
        const brain = await loadBrain(c, ctx, req.params.brain_id);
        const all = await versionsOf(c, brain.brain_id);
        if (mode === "all" && all.length > MAX_VERSIONS) throw badRequest(`brain has ${all.length} versions; a package holds at most ${MAX_VERSIONS}. Use versions: "latest"`);
        const picked = mode === "latest" ? all.slice(-1) : all;
        const pkg = buildPackage(brain, picked, { actor: ctx.actor });
        const secrets = findSecrets(pkg.files, "files");
        if (secrets.length) throw unprocessable("export_blocked", "export refused: the Brain contains something that looks like a secret", { paths: secrets });
        const { rows } = await c.query(
          `INSERT INTO brain_exports (workspace_id, brain_id, package_sha256, versions, manifest, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING export_id`,
          [ctx.workspaceId, brain.brain_id, pkg.package_sha256, picked.map((v) => v.version), JSON.stringify(pkg.manifest), ctx.actor]);
        await audit(c, ctx, "brain.export", "brain", brain.brain_id, { export_id: rows[0].export_id, package_sha256: pkg.package_sha256, versions: picked.length });
        return { status: 200, body: { export_id: rows[0].export_id, package: pkg } };
      }));
    } catch (e) {
      if (e instanceof HttpError && e.code === "export_blocked") {
        await audit(pool, ctx, "brain.export.blocked", "brain", req.params.brain_id, { paths: e.details.paths }).catch(() => {});
      }
      throw e;
    }
    res.status(out.status).json(out.body);
  }));

  // ---- import: upload -> validate -> checksums -> compatibility -> scan -> (dry run) -> create -> health check -> inactive ----
  r.post("/brains/import", wrap(async (req, res) => {
    const ctx = context(req);
    if (req.body?.package === undefined) throw badRequest("package is required");
    if (req.body.dry_run !== undefined && typeof req.body.dry_run !== "boolean") throw badRequest("dry_run must be a boolean");
    const dry = req.body.dry_run === true;
    const given = req.body.name !== undefined ? requireString(req.body.name, "name") : null;
    await requireWorkspace(pool, ctx);

    const report = inspectPackage(req.body.package);
    if (!report.valid) {
      await auditRefusal(pool, ctx, "brain.import.rejected", { dry_run: dry, failed: report.checks.filter((k) => k.status === "failed") });
      throw unprocessable("invalid_package", "package failed validation; nothing was created", { checks: report.checks });
    }
    const name = given ?? report.brain.name;

    if (dry) {
      const taken = (await pool.query(`SELECT 1 FROM brains WHERE workspace_id=$1 AND name=$2 AND status <> 'deleted'`, [ctx.workspaceId, name])).rowCount > 0;
      await auditRefusal(pool, ctx, "brain.import.dry_run", { name, versions: report.brain.versions.length, name_available: !taken });
      return res.json({
        dry_run: true, valid: true, checks: report.checks, name_available: !taken,
        would_create: { name, brain_type: report.brain.brain_type, versions: report.brain.versions.length, status: "draft" },
      });
    }

    let out;
    try {
      out = await tx(pool, (c) => idempotent(c, ctx, req, async () => {
        const src = report.brain;
        const brain = await insertBrain(c, ctx, {
          name, brainType: src.brain_type,
          origin: { kind: "import", package_sha256: req.body.package.package_sha256, source_brain_id: src.source_brain_id, source_versions: src.versions.map((v) => v.version) },
        });
        const versions = await insertVersions(c, brain.brain_id, src.versions);
        // Health check, still inside the transaction: if anything is off, the whole import rolls back.
        const h = (await c.query(
          `SELECT count(*)::int n, COALESCE(min(version),0) lo, COALESCE(max(version),0) hi,
                  (SELECT count(*)::int FROM attachments WHERE brain_id=$1) att,
                  (SELECT status FROM brains WHERE brain_id=$1) status
           FROM brain_versions WHERE brain_id=$1`, [brain.brain_id])).rows[0];
        const ok = h.n === src.versions.length && (h.n === 0 || (h.lo === 1 && h.hi === h.n)) && h.att === 0 && h.status === "draft";
        if (!ok) throw new HttpError(500, "import_health_check_failed", "imported Brain failed its health check; nothing was created");
        await audit(c, ctx, "brain.import", "brain", brain.brain_id, { package_sha256: req.body.package.package_sha256, versions: versions.length, source_brain_id: src.source_brain_id });
        return { status: 201, body: { brain, versions, checks: report.checks, note: "Imported Brain is inactive (draft). Activate it or attach it to a channel to use it." } };
      }));
    } catch (e) {
      if (e instanceof HttpError) await auditRefusal(pool, ctx, "brain.import.rejected", { reason: e.message });
      throw e;
    }
    res.status(out.status).json(out.body);
  }));

  return r;
}
