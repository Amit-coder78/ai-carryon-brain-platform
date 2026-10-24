-- Phase 7: Brain lifecycle (clone, archive, delete) and portable packages (export/import).

-- Where a Brain came from: {} (created here), {kind:"clone", from_brain_id, source_versions}
-- or {kind:"import", package_sha256, source_brain_id, source_versions}.
ALTER TABLE brains ADD COLUMN origin jsonb NOT NULL DEFAULT '{}';
ALTER TABLE brains ADD COLUMN deleted_at timestamptz;

-- Delete is soft (history, versions and decision records must stay readable), so a deleted Brain
-- must not keep its name reserved.
ALTER TABLE brains DROP CONSTRAINT brains_workspace_id_name_key;
CREATE UNIQUE INDEX brains_name_live ON brains (workspace_id, name) WHERE status <> 'deleted';
CREATE INDEX brains_by_origin ON brains ((origin->>'from_brain_id')) WHERE origin ? 'from_brain_id';

-- One row per export, so exports are auditable and visible in dependency inspection.
CREATE TABLE brain_exports (
  export_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE RESTRICT,
  brain_id uuid NOT NULL REFERENCES brains ON DELETE RESTRICT,
  package_sha256 text NOT NULL,
  versions int[] NOT NULL,
  manifest jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brain_exports_by_brain ON brain_exports (brain_id, created_at DESC);
