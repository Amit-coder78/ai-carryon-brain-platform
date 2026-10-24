# Build phases: detailed implementation notes

Moved out of the main README so the front page stays readable. Newest phase first. Back to the [README](../README.md).

## Phase 7: Lifecycle and portable packages (roadmap steps 4 and 11)

Code: `services/api/src/lifecycle.js` (routes), `services/api/src/package.js` (package format, checksums, secret scan), migration `0004_lifecycle_packages.sql`. Demo: `scripts/demo_phase7.sh`.

- **Clone** `POST /v1/brains/{id}/clone` `{name?, versions?: latest|all|none}`. New identity, created as `draft`, versions renumbered from 1 and `unevaluated`, `origin` records the source. Never copied: attachments, audit and decision history, credentials.
- **Archive / unarchive** `POST /v1/brains/{id}/archive` `{detach_attachments?}`. Refused with the list of bindings while the Brain is attached, unless `detach_attachments: true` (then they are detached in the same transaction). Unarchive never re-binds a channel. The engine only runs `active` Brains, so archiving takes effect immediately and the channel falls back to `baseline_fallback`.
- **Delete** `DELETE /v1/brains/{id}` is a soft delete, allowed only for `draft` or `archived` Brains with no live attachments (409 lists the blockers). Versions, audit rows and decision records stay readable; the name becomes reusable. `GET /v1/brains/{id}/dependencies` shows bindings, clones, exports and decision records, and whether archive and delete are allowed. Clones and past exports are history, not blockers.
- **Activate** `POST /v1/brains/{id}/activate` (draft to active). Attaching a draft Brain does the same, so a cloned or imported Brain can never sit attached but silently idle. Attach, archive and delete now take the same row lock on the Brain, so a Brain cannot be archived while a binding is being added.
- **Export** `POST /v1/brains/{id}/export` `{versions?: all|latest}` returns `{export_id, package}`. The package is `{manifest, files, package_sha256}`: `brain.json` (name, type, versions) and `provenance.json`, each listed in the manifest with sha256 and size, plus a seal over the manifest. Registry data only: no channel bindings, no workspace ids, no model artifacts. Output is refused with `422 export_blocked` (field paths only, never the value) if anything looks like a secret.
- **Import** `POST /v1/brains/import` `{package, name?, dry_run?}` runs the doc's order: structure, checksums, compatibility (package schema version 1), secret scan, then a dry-run report or a real import. A real import is one transaction with a health check at the end, so it is all or nothing. The new Brain is `draft` until activated or attached. Rejections and dry runs are audited (`brain.import.rejected`, `brain.import.dry_run`).
- **Import versions into an existing Brain** `POST /v1/brains/{id}/versions/import` `{package, dry_run?}`. Same four checks as a normal import, then the package's versions are appended after the Brain's highest version number, in order, `unevaluated`, with their `params`. It changes nothing else: attachments stay pinned to the version they use (switch with replace), and a `draft` Brain stays `draft`. Refused with a 409 and nothing written if the package's `brain_type` differs from the Brain's, the Brain is archived, the package holds no versions, or this exact package was already imported into this Brain. Re-exporting a Brain gives a new package, so that is allowed. `dry_run` lists `would_add` (source version to new version) and any `blockers` instead of failing. All-or-nothing with the same health check as import; an `Idempotency-Key` replays the first answer. Audited as `brain.version.import`, with the package hash and the new version numbers.
- **Package signatures (optional, Ed25519).** Checksums detect damage or editing, but anyone can build a valid package; a signature says who sealed it. Run `make signing-key`, then `export` the printed `BRAIN_SIGNING_KEY` in the shell that runs `make api`. With a key set, every export carries a `signature` block `{alg, key_id, public_key, value}`; without one, exports are unsigned as before. The signature covers `package_sha256` (which already seals the manifest and every file) and sits outside the sealed content, so old unsigned packages stay valid and signing changes no checksum. Imports (`/brains/import` and `/versions/import`) gain a fifth check, `signature`, reported as `result: unsigned | valid | invalid` and, when valid, `signer: {key_id, trusted}`. A signature that is present but wrong is always refused, even when signatures are optional. The key travels inside the package, so a valid signature only means "consistent"; **trust is a list you control**: `BRAIN_TRUSTED_KEYS` (comma-separated key ids; a registry always trusts its own key). Set `BRAIN_REQUIRE_SIGNATURE=1` to refuse unsigned packages and packages signed by an untrusted key. A valid signature is recorded on the imported Brain's `origin.signature` and in the audit log (`signature`; exports record `signed_by`). `GET /v1/signing` shows this registry's key id, public key, policy and trusted ids (never the private key). No migration and no new dependency (`node:crypto`). Keys are not rotated or revoked by the registry: remove a key id from `BRAIN_TRUSTED_KEYS` to stop trusting it. `scripts/demo_signing.sh` walks through it: signed export, import, a forger who re-seals every checksum, and strict mode (it starts its own strict API on :3010).
- Everything is synchronous (no job table yet), so `/clone`, `/export` and `/import` return 201/200 instead of the 202 job the Phase 1 contract sketched. Bodies are capped at 1 MB (413).

Not in this phase, on purpose: model artifacts and learned state in packages (they do not exist yet), a trusted-key table per workspace (trust is process-wide config for now), key rotation and revocation lists, hard purge and retention timers, running-job checks (no jobs yet), permissions and rate limits. The secret scan is a heuristic over key names and well-known token shapes, not a guarantee.

## Phase 6: Demand estimation and initial ranking (roadmap step 9)

- New Brain type `demand` (`services/engine/app/runtime/demand.py`, estimator `demand-v1`). Attach it like the heuristic Brain (`brain_type: "demand"`); it fuses with other Brains through the existing `rrf-v1` policy.
- **Distinct people, weighted by recency.** Each requester counts once, with a weight that halves every 14 days since their *latest* request. Fewer than 3 distinct requesters scores 0: one request never decides a topic.
- **Uncertainty is explicit.** The score is a conservative lower bound (`n_eff - 1.28*sqrt(n_eff)`, saturating so 10 effective requesters ~ 0.37). Confidence is the estimate's relative precision (about 0.26 at 3 requesters, 0.60 at 10, 0.87 at 100), so small samples never look certain. Evidence refs carry `estimator:demand-v1` and the interval. If no candidate has enough demand the Brain abstains from fusion (Phase 4 rule).
- **History fills `channel_baseline_ratio`** (it was always the neutral 1.0 before). From this channel's selected videos with a `views_24h` observation: baseline = median, topic ratio = mean of views/baseline over past videos with the *same* topic key. Needs 3+ videos, otherwise it stays neutral. Exact match only, no fuzzy guessing.
- Two new optional candidate features: `recent_requesters` (null = unknown, flagged `recency_unknown`, never assumed fresh) and `history_videos`. Explicit caller features still win. No migration needed.

Demo: `scripts/demo_phase6.sh` (needs `make api` and `make engine` running) shows fresh vs fading demand, one person counted once, and the Brain abstaining.

### Demand settings per Brain version

The demand Brain's half-life and minimum number of requesters can be set on each Brain version (`params` on `POST /v1/brains/{id}/versions`; migration `0005_version_params.sql`):

```
{"params": {"half_life_days": 7, "min_requesters": 5}}
```

- `half_life_days`: number from 1 to 365 (default 14). `min_requesters`: integer from 1 to 1000 (default 3). Missing keys use the defaults, so every version created before this change behaves exactly as before. Unknown keys and out-of-range values are a 400. Other Brain types accept no params.
- Versions are immutable, so changing a setting means a new version. The decision record already names the Brain version, so it also names the settings; the Brain's evidence refs show `param:half_life_days=...` and `param:min_requesters=...`.
- Clone and export/import copy the settings with each version. Packages made before this change import fine (no params means defaults); a package with invalid params fails the compatibility check.
- If the engine finds invalid params on a version, only that Brain fails (status `error`); the other Brains still rank.
- A half-life only applies when the engine computed the recency from stored signals. If a caller sends its own `features` with `recent_requesters`, that value is used as given and the reason code `half_life_not_applied` is added. `min_requesters` always applies.
- Ages are bucketed to the hour for this, which changes a weight by at most about 1.4% at the shortest half-life.

Not in this phase: spam/bot detection (comment classification is upstream; this only guarantees one person counts once), audience-size normalisation (the registry doesn't store it yet), semantic topic matching (clusters), and learned weights. The saturation constant and uncertainty band are fixed in `demand.py` and versioned by the estimator name; half-life and minimum requesters are per-version settings (below).

## Phase 5: Signals, features and decision records

- `POST /v1/comment-signals` (API :3000) stores demand signals: a salted hash of the commenter plus a normalized topic key, never comment text. The same person counts once however many times they comment.
- `POST /v1/runtime/execute` now fills in missing candidate features from the last 30 days of `request` signals (exact topic-key match, per channel). Explicit `features` from the caller always win. Every execution writes a decision record and returns `decision_id`.
- `GET /v1/decisions`, `GET /v1/decisions/{id}`, `POST /v1/decisions/{id}/selection` (pipeline reports what it used, once), `POST /v1/observations` (outcomes such as `views_24h`, linked to a decision).
- The topic key is defined once in `contracts/topic-key-vectors.json` and tested in both services.

## Phase 4: pipeline integration (client lives in ai-carryon)

The `ai-carryon` pipeline (per-channel scheduler jobs on GitHub Actions) calls `POST /v1/runtime/execute` before choosing a topic (client: `agents/brain_client.py`, selection: `agents/topic_selection.py`, both in `ai-carryon`). Contract points this repo guarantees and tests (`services/engine/tests/test_api.py`, `test_runtime.py`):

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

## Run (original Phase 1 notes)

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
