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
cp .env.example .env
docker compose up -d postgres
./scripts/migrate.sh
cd services/api && npm install && npm start      # :3000
cd services/engine && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && uvicorn app.main:app --port 8000
curl localhost:3000/v1/health; curl localhost:3000/v1/ready; curl localhost:8000/v1/ready
```

Secrets never go in this repo.
