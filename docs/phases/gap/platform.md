# Platform Gap Report - worker / infra / evals / CI / scripts / env

Agent: W-R4 (reader, read-only) - 2026-10-22
Scope: services/worker/**, infra/**, scripts/**, evals/**, .github/**, .env.example,
turbo.json, pnpm-workspace.yaml, biome.json, root package.json.
Baseline read: worklog.md (22 lines), docs/BUILD_PLAN.md M8, M10, S7, S2.3.
Verdict scale: MET / PARTIAL / MISSING.

---

## 1. Worker (services/worker) vs BUILD_PLAN M8

### Exact state: MISSING (empty directory)

`services/worker/` contains exactly one EMPTY directory (`src/`) and nothing else:

- No `package.json` -> not yet a pnpm workspace package (pnpm-workspace.yaml
  includes `services/*`, so it auto-joins the moment a manifest exists).
- No source, no queue processors, no render runner, no tests, no Dockerfile.
- `ls -R services/worker` -> `src/` with zero files.

### What the gateway already stages for the worker (the contract to implement)

`services/gateway/src/routes/renders.ts` (mounted in app.ts):

- `RenderWorker` seam: `enqueue(render: { id, projectId }): Promise<void>`.
  Default binding is `createNoopRenderWorker`, which logs `render_worker_noop`
  and leaves the job `queued` forever. Comment: "TODO(W4/worker)".
- `POST /v1/renders` (requireWorkspace("editor")): validates
  `QUEUE_RENDER_SCHEMA`, creates the render row (status queued, credits 0),
  PRE-CREATES the S3 object key via `renderKey()` "so the worker never guesses
  layout", writes an audit row `render.queued`, returns 201 RenderJob.
- `GET /v1/renders/:id` (viewer): status row; `resultUrl` only via signed URL
  when status is `completed`. NO list/history endpoint (M8 "render history"
  surface is a DB table only - see below).
- Contracts `packages/contracts/src/routes/renders.ts`: RENDER_FORMATS =
  `mp4 | prores | png-seq | gif | wav`; RENDER_SETTINGS_SCHEMA = { timeFrom,
  timeTo, width, height, frameRate, quality(draft|good|best), extra };
  RENDER_STATUSES = `queued | running | succeeded | failed | cancelled`;
  idempotencyKey required on queue.
- DB `packages/db/src/schema.ts:504` `renders` table with
  `renders_status_idx`, `renders_project_created_idx`, nullable `credits`,
  `objectKey`, `error`, `completedAt` -> persistence side of M8 exists.
- Agent runner seam (`runner.ts`): MOCK_MODEL=true -> MockRunner; false ->
  UnavailableRunner (`RUN_MODEL_UNAVAILABLE`, no charge). Header says "Wave 4
  replaces this with the LiteLLM runner behind the same seam" - the worker
  owns that too.
- Infra already templated for it: compose `worker` service (profile `apps`,
  placeholder Dockerfile "WIRED IN THE RENDER WAVE") and systemd
  `studio-worker.service` ("@studio/worker does not exist yet").

### Missing entirely vs M8 (task-by-task)

M8.1 Worker: ALL of it - effectcraft-cli runner, confined temp dir, per-job
workspace; Valkey/BullMQ job queue; retries, timeouts, cancellation,
concurrency limits; input assembly (version object + asset manifest); output
production for the 5 formats.
M8.2 Render API/UI: no editor "Render..." UI, no project-hub queueing, no
credit estimate, no progress, no history listing endpoint (only GET by id).
M8.3 Preview vs final: browser renderFrame previews are editor-side; nothing
final exists.
M8.4 Storage/lifecycle: signed download exists (gateway); output retention by
plan + cleanup job MISSING.
M8.5 Tests: none (golden render hash/frame compare, cancellation, timeout,
crash recovery, malformed project, missing asset, quota, 10-render load test).

Credit commit (M8 exit "credits charged only for completed renders") has no
implementor: rows are created with credits 0 and nothing transitions status.
Exit criteria "job survives worker restart; no duplicate outputs on retry" are
untestable until the worker exists. Valkey is ALREADY optional in the env
contract (queues degrade gracefully), so the worker must also handle
VALKEY_URL-unset (documented degraded mode).

## 2. Infra - compose / caddy / litellm / systemd

### compose (infra/compose/docker-compose.yml, name: studio)

Two profiles by design:

- default (data plane, "usable today"): `db` postgres:17-alpine
  (127.0.0.1:5432, pg_isready healthcheck, db-init mount), `valkey`
  valkey/valkey:8-alpine (ping healthcheck, NO host port), `minio` :latest
  (127.0.0.1:9000/9001, `mc ready` healthcheck), `minio-init` one-shot bucket
  create, `litellm` ghcr.io/berriai/litellm-database:main (127.0.0.1:4000;
  LITELLM_MASTER_KEY=LITELLM_API_KEY with `:?` hard-fail; LITELLM_DATABASE_URL
  -> separate `litellm` DB created by db-init/01-litellm.sql; depends db
  healthy).
- `apps` profile: web, gateway, worker, caddy - ALL placeholder build contexts
  (no Dockerfiles exist anywhere in the repo; `--profile apps` build fails by
  design until the app/render waves).
- env mechanics: `env_file: ../../.env` (34 app vars into containers) +
  `--env-file` interpolation for compose-only knobs (POSTGRES_PASSWORD,
  SITE_ADDR, ACME_EMAIL, LITELLM_DATABASE_URL).
- FLEET NOTE in compose/README.md: root `.dockerignore` predates the pivot and
  does NOT exclude `editor/` (multi-GB target) or `.local/` - must be extended
  before wiring app Dockerfiles.

### caddy (infra/caddy/Caddyfile + Dockerfile)

- Site block on `{$SITE_ADDR:app.example.com}` with ACME email
  `{$ACME_EMAIL:ops@example.com}` (both EDIT-ME placeholders); encode
  brotli+zstd+gzip (custom image) or `zstd gzip` via CADDY_ENCODERS for stock
  binaries; HSTS, nosniff, X-Frame-Options SAMEORIGIN, -Server on everything.
- `/editor` -> 308 to `/editor/`; `handle_path /editor/*` root `/srv/editor`
  with the S6.1 contract: COOP same-origin + COEP require-corp
  (SharedArrayBuffer), hashed assets + wasm+glue `immutable, max-age=31536000`,
  index.html/sw.js `no-cache`, manifest/icons/helpers 1h, explicit
  `application/wasm`.
- `/v1/*` -> `gateway:8787` with `flush_interval -1` (SSE passthrough);
  fallback -> `web:3000`.
- Dockerfile: Caddy 2.11 builder + `ueffel/caddy-brotli v1.7.0`, COPY Caddyfile,
  COPY prebuilt `editor-dist/` (gitignored prebuilt input; editor/target stays
  out of Docker by design).

### litellm (infra/litellm/config.yaml)

EDIT-ME template, nothing production-ready as-is: aliases `studio-fast`
(openai/gpt-4o-mini), `studio-smart` (openai/gpt-4o), `studio-vision`
(openai/gpt-4o) - the app's MODEL_CATALOG tiers so providers can be swapped
without app changes; api_key via env (OPENAI_API_KEY commented in compose);
litellm_settings: max_budget 100 USD / 30d, drop_params, request_timeout 300,
num_retries 2; master_key + database_url from env; STORE_MODEL_IN_DB=True.
M0 exit "one real LiteLLM chat completion succeeds" is NOT yet evidenced.

### systemd (infra/systemd/)

Three template units (studio-web :3000, studio-gateway :8787, studio-worker)
targeting a root-installed /opt/studio box: EnvironmentFile=/etc/studio/.env
(34-var contract, chmod 600), NODE_ENV=production, `pnpm --filter @studio/* start`,
Restart=always + RestartSec=3; hardening: NoNewPrivileges, ProtectSystem=strict
with ReadWritePaths=/opt/studio/.local, PrivateTmp/PrivateDevices, ProtectHome +
kernel/clock/hostname tunables, RestrictSUIDSGID/Realtime, LockPersonality,
RestrictAddressFamilies, CapabilityBoundingSet= empty, SystemCallFilter=@system-service
(web only); MemoryDenyWriteExecute deliberately OFF (V8 JIT needs W+X - noted
per unit). Worker unit header: "WIRED IN THE RENDER WAVE". README installs
distro Postgres 17 + Valkey 8 natively; dev-postgres/dev-valkey are explicitly
dev-only, not for the prod box.

### Can THIS box boot the stack? NO (and it is not supposed to)

Verified on the box: docker MISSING (no engine, no compose plugin), podman
missing -> the compose path cannot run here. systemd 257 exists but the units
expect root + /opt/studio (this sandbox runs as user `z`, installs are
forbidden by fleet protocol). What IS present: node 24.21, python 3.12.15,
curl/tar/unzip, caddy binary (/usr/bin/caddy), ffmpeg; MISSING: pnpm on PATH
(corepack present), cargo/rustc, psql, valkey/redis binaries. No `.local/`
yet -> the portable services have never been started. So the native dev path
is *partially* bootable: dev-postgres.sh + dev-valkey.sh can bring up PG/Valkey
(downloads allowed by scripts; installs are not), Caddyfile is locally
validatable (`CADDY_ENCODERS="zstd gzip" caddy validate`), but the editor wasm
build (cargo) and LiteLLM (venv) cannot be produced here. This matches
AGENTS.md: 2 CPUs, no installs, no dev servers - runtime proof belongs to CI +
a live box. Infra verdict: files COMPLETE and coherent, runtime evidence ZERO.

## 3. Evals vs BUILD_PLAN S7.2

- `evals/prompts/` exists and is EMPTY: **0 golden prompts against the required
  >= 30**. Category coverage **0/10**: title comp creation, animation timings,
  add/tune effect, brand colors across layers, reorganize/rename, lower third,
  3D-ish camera move, ambiguous->clarify, destructive->confirm,
  impossible->explain. No prompt files, no fixtures, no README.
- NO scoring harness anywhere in the active tree: no promptfoo config, no
  eval-gate, no Langfuse wiring. The S7.2 score dimensions (plan validity,
  apply success, visual sanity via frame compare, undo success, credits
  accuracy, latency; targets >= 90% valid plans, >= 95% apply success) have no
  implementation.
- Reference only: the pre-pivot promptfoo suite (67 golden briefs,
  chat-edits gate, eval-gate.mjs >= 0.85) is preserved under
  `archive/packages/evals` + `archive/evals` - it targets photocraft commands
  and is not reusable as-is; the category taxonomy and gate mechanics are
  salvageable.
- Consequence: M4/M5 exit (agent quality) and M10 beta gates are unmeasurable
  until at least the 30-prompt corpus + harness land. This is the single
  cheapest high-value gap in the domain (content work, no installs).

## 4. CI (.github)

- `.github/` contains exactly: CODEOWNERS (everything @codzxe during W1),
  dependabot.yml (npm root manifest weekly direct-only + github-actions weekly,
  reviewer codzxe, PR limit 5), pull_request_template.md (summary / spec
  section refs / checklist: tests, ADR, attribution+license gate, no
  secrets/fonts, vendor untouched).
- **NO `.github/workflows/` directory at all** - zero workflows exist; nothing
  typechecks, lints, tests, builds, or license-gates on PR/push. Not even
  staged: the legacy staged CI (ci.yml, engine-patches.yml, license-check.yml)
  now lives in `archive/infra/ci-staged/` and targets the pre-pivot layout
  (apps/*, engine-patches) - it needs a rewrite for the new monorepo, not a copy.
- Everything CI would invoke already exists as scripts: root package.json has
  `dev/build/lint (biome check .)/typecheck (turbo)/test (turbo)/check:licenses`;
  editor jobs would be `pnpm editor:test|editor:web` (cargo - no Rust on this
  box, so editor CI must run on a GitHub runner). turbo.json defines
  build/dev/typecheck/lint/test with `^build` ordering; biome.json: strict-ish
  (noExplicitAny error, noConsole warn, noNonNullAssertion error), ignores
  dist/.next/md/fixtures/archive/editor/target.
- M0 task 6 (CI skeleton: web typecheck+lint+unit+build; gateway
  typecheck+tests+migration check; editor cargo test/clippy + wasm at the pin;
  licence check) is therefore PARTIAL: the harness commands exist, the
  workflows do not. The prior build's #1 retrospective lesson ("enable CI in
  hour one - the fleet flew blind for 139 commits", devlog G5) is at risk of
  repeating verbatim.

## 5. Scripts (fleet protocol + dev)

- `git-sync.sh` - the ONLY sanctioned git mutation path (AGENTS.md): cd repo
  root; takes a global exclusive flock on `/home/z/my-project/.studio-git.lock`
  (fd 9, 900 s timeout, fail with message); if dirty (tracked diff, staged, or
  any untracked file) -> `git add -A` + `git commit -m "$MSG"`; then up to 6
  attempts: `git pull --rebase origin main` -> `git push origin main` (rebase
  conflict -> `git rebase --abort`, GitHub wins), sleep jitter 2-9 s between
  tries; on total failure prints "your commit is safe locally - report it",
  exit 1. Never force-pushes; serializes the whole agent fleet.
- `gen-env.sh` -> runs `gen-env.ts` via tsx (pnpm exec, else pnpm dlx
  download): regenerates `.env.example` from the single source of truth
  `packages/config/src/env.ts` ENV_VAR_SPECS (34 vars); applies local dev
  defaults (loopback DATABASE_URL/VALKEY_URL, blank S3_ENDPOINT -> filesystem
  storage driver, loopback LITELLM_BASE_URL, EDITOR_DEV_SERVER_URL :8765),
  injects per-var notes, replaces the header, and prints a FRESH
  `AUTH_SECRET=...` suggestion to stdout only (never writes it). Never
  hand-edit .env.example.
- `serve-editor.py` - localhost-only static server for
  `editor/target/web/dist` (default :8765) sending the same headers as
  `cargo xtask web --serve`: COOP same-origin, COEP require-corp, nosniff,
  `application/wasm` for .wasm. Purpose: editor dev/proxy target behind the
  app's EDITOR_DEV_SERVER_URL without a cargo round-trip.
- `check-licenses.mjs` (`pnpm check:licenses`) - offline, zero-dependency
  license gate: every external dep of root + apps/* + packages/* must be
  declared in `licenses.overrides.json`; S16.0 allowlist MIT / Apache-2.0 /
  BSD-2 / BSD-3 / ISC / 0BSD / PostgreSQL / MPL-2.0 (conditional: unmodified
  + notice); deny AGPL / SSPL / BUSL / RSAL / Elastic / FSL /
  Sustainable-Use / GPL family / CC-BY-NC|SA|ND / unlicensed; parses SPDX
  OR/AND/WITH; also fails on committed font binaries (.ttf/.otf/.woff*) and
  real `.env` files (.example/.sample allowed); `TODO-verify` rows warn unless
  --strict / LICENSE_CHECK_STRICT=1.
- `dev-postgres.sh` - portable rootless PostgreSQL 17 (M0 task 5): download
  probe order EDB (403 AccessDenied today, kept first to auto-heal) ->
  theseus-rs 17.5.1 (working, sha256-verified, full toolset) -> zonky 17.6.0
  (server-only jar, system psql); installs under gitignored `.local/pg`;
  initdb with scram-sha-256 (mirrors prod, never trust); starts on
  127.0.0.1:5432, creates db `studio`; commands start/stop/restart/status/
  install/psql; fully idempotent; env overrides PG_PORT/USER/PASSWORD/DB/HOME/
  TARBALL_URL; detects foreign listeners on the port.
- `dev-valkey.sh` - OPTIONAL rootless Valkey 8: reuse system
  valkey/redis-server if present, else anonymous DockerHub OCI pull of
  valkey/valkey:8-alpine WITHOUT docker (curl + python3 + tar; token +
  manifest + layer fetch, extract server/cli + musl loader + libssl3, wrapper
  runs it via the bundled loader on any Linux); 127.0.0.1:6379, PING-wait
  start; commands start/stop/restart/status/cli. VALKEY_URL is optional in
  the env contract - queues/rate limits degrade gracefully when unset.

## 6. Env (.env.example) - 34 vars, 11 secrets, fail-fast

Generated file (never hand-edit; `pnpm dev:env`). Groups:

- app: APP_URL, APP_ENV(local|staging|production), LOG_LEVEL, MOCK_MODEL
  (rejected when APP_ENV=production)
- db: DATABASE_URL [SECRET]
- queue: VALKEY_URL [SECRET, optional - graceful degrade]
- storage: S3_ENDPOINT (blank -> filesystem driver under `.local/storage/`),
  S3_REGION, S3_ACCESS_KEY_ID [SECRET], S3_SECRET_ACCESS_KEY [SECRET],
  S3_BUCKET, ASSET_MAX_BYTES (500 MB), PROJECT_MAX_BYTES (250 MB)
- stripe: STRIPE_SECRET_KEY [SECRET, required in staging/prod],
  STRIPE_WEBHOOK_SECRET [SECRET], STRIPE_PRICE_IDS (JSON map)
- auth: AUTH_SECRET [SECRET, >=32 chars, instructions-only in template],
  AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET [SECRET], AUTH_GITHUB_ID,
  AUTH_GITHUB_SECRET [SECRET]
- litellm: LITELLM_BASE_URL, LITELLM_API_KEY [SECRET],
  LITELLM_VIRTUAL_KEY [SECRET, optional v1]
- editor: EDITOR_PUBLIC_PATH (/editor), EDITOR_DEV_SERVER_URL (dev-only,
  rejected in production), EDITOR_WASM_MAX_MB (18, enforced at serve + CI)
- agent: CHAT_MAX_STEPS (50), AGENT_BATCH_MAX_STEPS (100),
  AGENT_BATCH_MAX_BYTES (2 MiB), AGENT_BATCH_TIMEOUT_MS (60 s)
- lease: LEASE_HEARTBEAT_MS (120 s), LEASE_TTL_MS (300 s)
- obs: OTEL_EXPORTER_OTLP_ENDPOINT (optional - telemetry off when unset)

11 vars are flagged "Secret - never commit": DATABASE_URL, VALKEY_URL,
S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY,
STRIPE_WEBHOOK_SECRET, AUTH_SECRET, AUTH_GOOGLE_SECRET, AUTH_GITHUB_SECRET,
LITELLM_API_KEY, LITELLM_VIRTUAL_KEY.

Fail-fast behavior (packages/config/src/env.ts, 935 lines): `parseEnv` throws
a single typed `EnvFatalError` naming EVERY missing/invalid/rejected variable
at once (purpose included, secret VALUES never echoed); blank counts as unset
and schema defaults apply; cross-field rules reject MOCK_MODEL and
EDITOR_DEV_SERVER_URL in production and require STRIPE_SECRET_KEY in
staging/production. Committing a real `.env` additionally fails the license
gate (check-licenses.mjs scans for it). compose adds 4 deployment-only knobs
(POSTGRES_PASSWORD, SITE_ADDR, ACME_EMAIL, LITELLM_DATABASE_URL) that are
deliberately outside the 34-var app contract.

## 7. Top gaps, ranked (next actions)

1. WORKER DOES NOT EXIST (M8 fully open). Create `services/worker` package:
   BullMQ queue on VALKEY_URL implementing the gateway `RenderWorker` seam;
   effectcraft-cli runner in a confined per-job workspace; retries, timeouts,
   cancellation, concurrency caps; version-object + asset-manifest input;
   mp4/prores/png-seq/gif/wav output to the pre-created `renderKey`; credit
   commit only on completion (rows today sit at credits 0 / queued forever);
   status transitions queued->running->succeeded|failed|cancelled. Compose
   service + systemd unit are pre-staged and only need the Dockerfile + start
   script. Also owns the LiteLLM AgentRunner replacement for
   UnavailableRunner.
2. CI IS ZERO (.github has no workflows). Author them NOW, before more code
   lands: typecheck/lint/test/build (turbo) + check:licenses on PR; editor
   cargo test/clippy + wasm-size job on a runner (no Rust on this box). The
   commands all exist; only the yml is missing. Archive's ci-staged is a
   reference, not a copy source.
3. EVALS 0/30 prompts, 0/10 categories, no harness. Cheapest high-value gap:
   content-only work; blocks M4/M5 quality gates and M10 beta evidence. The
   S7.2 category list is the direct writing brief; archive promptfoo mechanics
   are the salvage pattern.
4. Render history endpoint missing (GET /v1/renders list w/ cursor) though DB
   indexes (status, project+created) already anticipate it.
5. Render progress stream for the UI (poll vs SSE) undefined; only GET by id
   exists.
6. LiteLLM aliases are EDIT-ME placeholders; M0 exit "one real completion
   succeeds" unevidenced (needs provider keys on a live box).
7. Retention-by-plan + render cleanup job (M8.4) unbuilt.
8. Before `--profile apps` builds: write apps/web + services/gateway +
   services/worker Dockerfiles AND extend root `.dockerignore` to exclude
   `editor/` + `.local/` (compose README fleet note) or contexts will upload
   multi-GB trees.

Box boot verdict (for whoever runs the live env): docker absent -> compose path
needs the real deployment box; on THIS box only the portable PG/Valkey dev
services (+ caddy validate, ffmpeg) are available, and they have never been
started (.local/ empty). Runtime proof of infra belongs to CI + that box; all
infra files are internally consistent and cross-referenced with the docs.
