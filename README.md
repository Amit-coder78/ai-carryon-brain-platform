# ai-carryon-brain-platform

A modular AI Brain platform for AI CarryON, enabling channel-specific intelligence, versioning, orchestration, and continuous learning.

Architecture: open `docs/architecture/index.html` in a browser.

## Phase 4: LangGraph integration (client lives in ai-carryon-saas)

The pipeline's Trend node calls `POST /v1/runtime/execute` before choosing a topic (client: `backend/ai/brain_platform/client.py` in `ai-carryon-saas`). Contract points this repo guarantees and tests (`services/engine/tests/test_api.py`, `test_runtime.py`):

- Response carries `source` (`brains` | `partial` | `baseline_fallback`), `policy_version`, `execution_id`, `ranked`, and each Brain's `brain_id` / `brain_version_id` / `role` / `status`, so the pipeline can record exactly where a pick came from.
- A Brain whose scores are all identical **abstains** from fusion (no alphabetical tie-break leaking in as a fake recommendation), and tied scores inside an informative Brain share a rank. Candidates nobody scored come back as `unscored` with `aggregate_score` 0.0 in the caller's order.
- No attached Brain, wrong workspace, disabled attachment: `baseline_fallback`, never an error.

### Running the engine inside a GitHub Actions job (no hosting)

`.github/actions/ci-engine` starts an ephemeral pgvector Postgres, migrates it, seeds one workspace + channel + active heuristic Brain, starts the engine on `127.0.0.1`, waits for `/v1/ready`, then exports `BRAIN_ENGINE_URL`, `BRAIN_WORKSPACE_ID` and `BRAIN_CHANNEL_ID_<CHANNEL>` to the later steps. Everything is discarded when the job ends (about 15 s of setup). The settings are published only after the engine is ready, so a failed start leaves the Brain switched off rather than half-configured.

```yaml
- uses: Amit-coder78/ai-carryon-brain-platform/.github/actions/ci-engine@main
  with: { channel: english }
```

`scripts/ci_engine.sh` is the same logic for local use: `DATABASE_URL=... CHANNEL=english ./scripts/ci_engine.sh` prints the exports. Note the registry is re-created every run, so there is no history or audit trail across runs; use a hosted engine with a persistent database when you need that.

```bash
make test   # engine suite runs the DB-backed tests once `make up && make migrate` has run
```

## Phase 3: Brain Runtime (engine, :8001)

`POST /v1/runtime/execute` (header `x-workspace-id`) takes `channel_id` + candidate topics, resolves that channel's active attachments (pinned immutable versions, same workspace), runs the Brains in parallel (per-Brain timeout, concurrency cap), fuses rankings with reciprocal-rank fusion (`rrf-v1`; Brain scores are not assumed comparable), and returns each Brain's standard response plus `source`: `brains`, `partial` or `baseline_fallback`. Shadow Brains run and are recorded but never affect the ranking. One Brain failing or timing out never fails the call. Starter Brain type: `heuristic` (set `brain_type` to `heuristic` when creating the Brain).

```bash
make test        # api (13) + engine (15)
```

## Phase 2: Brain Registry API

Workspaces, channels, Brains, immutable versions, attachments (attach / detach / disable / replace), per-channel brain list and audit log, all in `services/api/src/registry.js`. Registry calls need `x-workspace-id: <uuid>` (placeholder identity until real auth). Rules enforced: one active primary Brain per channel, one live attachment per Brain+channel, versions immutable and numbered per Brain, Idempotency-Key on create calls, workspace isolation (other workspaces get 404).

```bash
make migrate && make test   # 13 tests, needs `make up` for Postgres
```

## Phase 1

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
