-- Follow-up to Phase 6: settings that belong to one Brain version (e.g. the demand Brain's half-life and
-- minimum requesters). Versions are immutable, so a different setting means a new version, and every
-- decision record that names a version also names its settings. Existing versions get {} = built-in defaults.
ALTER TABLE brain_versions ADD COLUMN params jsonb NOT NULL DEFAULT '{}';
ALTER TABLE brain_versions ADD CONSTRAINT brain_versions_params_object CHECK (jsonb_typeof(params) = 'object');
