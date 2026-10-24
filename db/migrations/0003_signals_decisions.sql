-- Phase 5: demand signals, decision records, outcome observations.
-- Privacy: no raw comment text and no raw commenter identity is stored (only a salted hash).

CREATE TABLE comment_signals (
  signal_id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES channels ON DELETE RESTRICT,
  topic_key text NOT NULL,              -- normalized topic (see contracts/topic-key-vectors.json)
  commenter_hash text NOT NULL,         -- sha256(workspace_id:commenter_id); same person counts once
  kind text NOT NULL DEFAULT 'request' CHECK (kind IN ('request','reaction')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signals_lookup ON comment_signals (workspace_id, channel_id, topic_key, observed_at);

CREATE TABLE decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES channels ON DELETE RESTRICT,
  execution_id uuid NOT NULL,
  source text NOT NULL,                 -- brains | partial | baseline_fallback
  policy_version text NOT NULL,
  candidates jsonb NOT NULL,            -- [{candidate_id,title,features}]
  ranked jsonb NOT NULL,                -- [{candidate_id,aggregate_score,reason_codes}]
  brains jsonb NOT NULL,                -- [{brain_id,brain_version_id,role,status,duration_ms}]
  selected_candidate text,              -- set once, by the pipeline, via POST /v1/decisions/{id}/selection
  selected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_by_channel ON decisions (workspace_id, channel_id, created_at DESC);

CREATE TABLE observations (
  observation_id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES channels ON DELETE RESTRICT,
  decision_id uuid REFERENCES decisions,
  video_ref text NOT NULL,
  metric text NOT NULL,                 -- e.g. views_24h, retention_pct
  value double precision NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observations_by_decision ON observations (decision_id);
