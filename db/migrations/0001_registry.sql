-- Phase 1: registry, versions, attachments, audit. Brain != attachment.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE workspaces (
  workspace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  channel_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE RESTRICT,
  name text NOT NULL,
  youtube_channel_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE brains (
  brain_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE RESTRICT,
  name text NOT NULL,
  brain_type text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','disabled','archived','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE brain_versions (
  brain_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id uuid NOT NULL REFERENCES brains ON DELETE RESTRICT,
  version int NOT NULL CHECK (version > 0),
  capabilities jsonb NOT NULL DEFAULT '[]',
  artifact_refs jsonb NOT NULL DEFAULT '[]',
  checksum text,
  evaluation_status text NOT NULL DEFAULT 'unevaluated',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brain_id, version)
);

-- brain_versions rows are immutable
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER brain_versions_immutable BEFORE UPDATE OR DELETE ON brain_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE attachments (
  attachment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id uuid NOT NULL REFERENCES brains ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES channels ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('primary','supporting','experimental','shadow')),
  enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','disabled','detached')),
  attached_version_id uuid REFERENCES brain_versions,  -- pin
  version_policy text NOT NULL DEFAULT 'pinned' CHECK (version_policy IN ('pinned','latest_approved')),
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- one active primary per channel
CREATE UNIQUE INDEX one_primary_per_channel ON attachments (channel_id)
  WHERE role = 'primary' AND status = 'active';

CREATE TABLE idempotency_keys (
  key text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE audit_log (
  audit_id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces,
  actor text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid,
  correlation_id text,
  detail jsonb NOT NULL DEFAULT '{}',   -- never secrets or raw private comments
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_by_object ON audit_log (object_type, object_id);
