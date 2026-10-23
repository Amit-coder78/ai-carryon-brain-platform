-- Phase 2: one live attachment per (brain, channel); lookup indexes
CREATE UNIQUE INDEX one_live_attachment_per_brain_channel ON attachments (brain_id, channel_id)
  WHERE status IN ('pending','active','disabled');
CREATE INDEX attachments_by_channel ON attachments (channel_id);
CREATE INDEX brains_by_workspace ON brains (workspace_id, status);
