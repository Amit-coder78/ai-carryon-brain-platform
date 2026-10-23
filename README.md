# ai-carryon-brain-platform

A modular AI Brain platform for AI CarryON, enabling channel-specific intelligence, versioning, orchestration, and continuous learning.

Architecture: open `docs/architecture/index.html` in a browser.

## Phase 1 (this patch)

Boundaries, identifiers, schemas, API contracts, first migration, two health-checked service skeletons.

| Path | What |
|---|---|
| `docs/architecture/` | Architecture visualization |
| `contracts/openapi.yaml` | Proposed `/v1` API contract |
| `contracts/schemas/` | JSON Schemas: brain manifest, standard brain response |
| `db/migrations/0001_registry.sql` | workspaces, channels, brains, brain_versions (immutable), attachments, audit_log |
| `services/api` | Express API: `/v1/health`, `/v1/ready` |
| `services/engine` | FastAPI engine: `/v1/health`, `/v1/ready` |

## Run

```bash
make setup      # .env, npm install, python venv
make up         # postgres (pgvector)
make migrate
make api        # :3000
make engine     # :8000 (second terminal)
make check      # health/ready on both
make test
```

Secrets never go in this repo.
