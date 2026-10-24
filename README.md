# AI CarryON Brain Platform

> The decision-making backend for [**AI CarryON**](https://github.com/Unknown183-a/ai-carryon): a registry of versioned "Brains" that rank candidate topics, fuse their opinions, and record every decision so it can be audited and learned from.

![Node](https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/python-3.11-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/engine-FastAPI-009688?logo=fastapi&logoColor=white)
![Postgres](https://img.shields.io/badge/db-Postgres%20%2B%20pgvector-336791?logo=postgresql&logoColor=white)

## Architecture

### [**Open the interactive architecture diagram**](https://htmlpreview.github.io/?https://github.com/Amit-coder78/ai-carryon-brain-platform/blob/main/docs/architecture/index.html)

One click, no setup: it opens in your browser as a fully rendered page (layers, Brain lifecycle, channel binding, parallel execution, learning loop, database design, API, export/import, roadmap).

- Source file: [`docs/architecture/index.html`](docs/architecture/index.html)
- Offline: clone the repo and open that file in any browser.

## How this relates to AI CarryON

This repository is the **backend** used by the [`ai-carryon`](https://github.com/Unknown183-a/ai-carryon) pipeline repository.

```mermaid
flowchart LR
    subgraph C["ai-carryon (client)"]
        S["scheduler.py"] --> T["topic_selection.py"] --> B["brain_client.py"]
    end
    subgraph P["ai-carryon-brain-platform (backend)"]
        E["Engine (FastAPI)<br/>/v1/runtime/execute<br/>rank + fuse (rrf-v1)"]
        R["Registry API + Postgres<br/>Brains, versions, decisions"]
        E --- R
    end
    B -- "candidates" --> E
    E -- "ranked list" --> B
```

| Concern | Where it lives |
| --- | --- |
| Client code | `ai-carryon`: `agents/brain_client.py`, `agents/topic_selection.py` |
| Enable / disable | `ai-carryon`: repository variable `BRAIN_ENABLED=true` |
| Engine inside CI | this repo: `.github/actions/ci-engine` (no hosting needed) |
| Contract between the two | this repo: `contracts/openapi.yaml` and `contracts/schemas/` |

**Safe by design:** if the Brain is off, unreachable, or has no opinion, the pipeline silently keeps its original topic selection. The Brain can improve a decision but can never break a run.

See the matching section in the [ai-carryon README](https://github.com/Unknown183-a/ai-carryon#brain-platform-backend).

## Features

- **Brain Registry**: workspaces, channels, Brains, immutable numbered versions, attachments (attach / detach / disable / replace), audit log.
- **Parallel runtime**: runs every attached Brain concurrently with per-Brain timeouts, fuses rankings with reciprocal-rank fusion (`rrf-v1`). One Brain failing never fails the call.
- **Brain types**: `heuristic` (starter) and `demand` (recency-weighted distinct requesters with explicit uncertainty).
- **Signals and decisions**: privacy-preserving comment signals (salted hash + normalized topic, never comment text), a decision record for every execution, outcome observations (e.g. `views_24h`).
- **Lifecycle**: clone, archive, soft-delete, activate.
- **Portable packages**: checksummed export/import with dry-run, secret scan, and optional Ed25519 signatures.
- **Graceful fallback**: no Brain attached, wrong workspace, disabled attachment → `baseline_fallback`, never an error.

## Tech stack

| Layer | Technology |
| --- | --- |
| Registry API | Node.js 20, Express (`services/api`) |
| Runtime engine | Python 3.11, FastAPI, Uvicorn (`services/engine`) |
| Database | PostgreSQL 16 + pgvector, plain SQL migrations (`db/migrations`) |
| Contracts | OpenAPI 3 + JSON Schema (`contracts/`) |
| Tests | `node --test` (API), `pytest` (engine) |

## Quick start

**Prerequisites:** Node 20+, Python 3.11+, Docker, `psql`.

```bash
git clone https://github.com/Amit-coder78/ai-carryon-brain-platform.git
cd ai-carryon-brain-platform

make setup      # creates .env, installs npm deps, builds Python venv
make up         # starts Postgres (pgvector) via Docker
make migrate    # applies db/migrations/*.sql

make api        # Registry API on :3000
make engine     # Runtime engine on :8001  (second terminal)

make check      # health / readiness of both services
make test       # API + engine test suites
```

Try a full flow with the demo scripts in [`scripts/`](scripts/) (`demo_phase5.sh`, `demo_phase6.sh`, `demo_phase7.sh`, `demo_signing.sh`).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://brain:brain@localhost:5432/brain` | Postgres connection |
| `API_PORT` | `3000` | Registry API port |
| `ENGINE_PORT` | `8001` | Runtime engine port |
| `BRAIN_SIGNING_KEY` | unset | Enables Ed25519 signing of exports (`make signing-key`) |
| `BRAIN_TRUSTED_KEYS` | unset | Comma-separated signer key ids to trust |
| `BRAIN_REQUIRE_SIGNATURE` | unset | `1` = refuse unsigned or untrusted packages |

Secrets never go in this repo. Copy `.env.example` to `.env` (git-ignored).

## Core API

Full contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). All registry calls need `x-workspace-id: <uuid>` (placeholder identity until real auth).

| Method & path | Service | What it does |
| --- | --- | --- |
| `POST /v1/runtime/execute` | engine | Rank candidate topics with the channel's attached Brains |
| `POST /v1/brains` · `/versions` | API | Create a Brain; add an immutable version |
| `POST /v1/attachments` | API | Attach a Brain version to a channel |
| `POST /v1/comment-signals` | API | Ingest demand signals (hashed, no comment text) |
| `GET /v1/decisions` · `/{id}` | API | Inspect what was decided and why |
| `POST /v1/decisions/{id}/selection` | API | Pipeline reports which candidate it used |
| `POST /v1/observations` | API | Record outcomes (e.g. `views_24h`) |
| `POST /v1/brains/{id}/export` · `/v1/brains/import` | API | Portable, checksummed (optionally signed) packages |
| `GET /v1/health` · `/v1/ready` | both | Liveness and readiness |

Example response shape from `execute` (abridged):

```json
{
  "source": "brains",
  "policy_version": "rrf-v1",
  "execution_id": "…",
  "decision_id": "…",
  "ranked": [{ "candidate_id": "…", "aggregate_score": 0.82 }],
  "brains": [{ "brain_id": "…", "brain_version_id": "…", "role": "primary", "status": "ok" }]
}
```

`source` is `brains`, `partial`, or `baseline_fallback`.

## Repository layout

| Path | Contents |
| --- | --- |
| `contracts/` | OpenAPI, JSON Schemas, shared topic-key test vectors |
| `db/migrations/` | SQL migrations 0001 to 0005 |
| `docs/architecture/` | Interactive architecture page (`index.html`) |
| `docs/PHASES.md` | Detailed per-phase implementation notes |
| `services/api/` | Express Registry API (registry, lifecycle, packages, signing, signals) |
| `services/engine/` | FastAPI runtime (router, executor, brains, demand, decisions) |
| `scripts/` | Setup, migrate, CI engine bootstrap, demos |
| `.github/actions/ci-engine/` | Reusable composite action that runs the engine in CI |
| `docker-compose.yml` | Local Postgres (pgvector) |
| `Makefile` | Developer entry points |

## Running the engine inside GitHub Actions (no hosting)

`ai-carryon` uses this composite action to start an ephemeral engine inside its workflow job:

```yaml
- uses: Amit-coder78/ai-carryon-brain-platform/.github/actions/ci-engine@main
  with: { channel: english }
```

It starts pgvector Postgres, migrates, seeds one workspace + channel + active heuristic Brain, waits for `/v1/ready`, then exports `BRAIN_ENGINE_URL`, `BRAIN_WORKSPACE_ID` and `BRAIN_CHANNEL_ID_<CHANNEL>` to later steps (~15 s). Everything is discarded when the job ends. Use a hosted engine with a persistent database if you need history across runs.

## Security and privacy

- No comment text is stored: only a salted hash of the commenter and a normalized topic key.
- Export packages are refused (`422 export_blocked`) if they look like they contain secrets.
- Optional Ed25519 package signing; trust is an explicit list you control.
- Workspace isolation: other workspaces get `404`.

## Status and roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Boundaries, schemas, contracts, skeletons | Done |
| 2 | Brain Registry API | Done |
| 3 | Parallel runtime and rank fusion | Done |
| 4 | Pipeline integration (ai-carryon) | Done |
| 5 | Signals, features, decision records | Done |
| 6 | Demand estimation and per-version params | Done |
| 7 | Lifecycle, portable packages, signing | Done |
| Next | Auth and permissions, learned models, experiments, job queue | Planned |

Details for each phase: [`docs/PHASES.md`](docs/PHASES.md).

## Contributing

1. Branch from `main`, keep changes focused.
2. Run `make test` before opening a PR.
3. Changing an endpoint? Update `contracts/openapi.yaml` in the same PR.

---

*Part of the AI CarryON project, built by Amit Kumar.*
