# Repository map

Companion to the root `README.md`. One paragraph per top-level directory, app and
package: what it is, the key entry files, and where its wire contract lives. The
authoritative layout is spec §4 (`docs/BUILD_PROMPT.md`); service responsibilities
are §3.1. Statuses cited from `docs/phases/phase-exit-audit.md`.

## Top-level directories

### `apps/` — deployable services

Five Node 22 services, one per §3.1 responsibility, each with its own `Dockerfile`
(repo-root build context, non-root `node` user) and healthcheck contract in
`infra/compose/docker-compose.yml`.

### `packages/` — shared libraries

Workspace packages (`@studio/*`) consumed by the apps. TypeScript strict, ESM,
Vitest with fakes — no package reaches into another's internals; seams are
structural interfaces (e.g. `packages/tools/src/types.ts`).

### `engine-patches/` — upstreamable Rust engine additions

New modules authored for the vendored editor (§2.3, §16.1 policy: never edit
`vendor/photocraft` in place). Contains `template_cmds/`, `component_cmds/`,
`layout_cmds/`, `agent_cmds/` (incl. `document_diff.rs`), `registration/`
(commands-registry patch), `tests/` (obligations + panic-hunt table + review log),
`docs/`, `scripts/` and a `README.md`. Wire contract: the vendored editor's command
registry (`crates/engine/src/commands.rs`) plus the upstreamable-modules README;
verification runs in CI's Rust job (`cargo check/test/clippy` + `panic_hunt`),
parked in `infra/ci-staged/engine-patches.yml`.

### `evals/` — golden fixtures

Content-only fixtures (no PII): `templates/` holds 16 template manifests
(`manifest.json` + `document.json` + `assets-note.md` each — §7 shape) and
`components/` holds 10 components (`component.json` + `layer.json` — §8 shape).
Wire contract: `docs/authoring/template-authoring.md` and
`docs/authoring/component-authoring.md`; consumed by `packages/evals` briefs and
the demo scripts.

### `infra/` — hosting & operations (spec §17)

`compose/` (single-box stack: caddy, gateway, worker, engine-pool, web, db, valkey +
optional `obs` profile; override example for host dev ports), `caddy/` (the only
host-port publisher; TLS/ACME), `obs/` (§22 Prometheus alert rules, scrape configs,
Grafana-format dashboards + on-call README), `scripts/` (backup-v2, verify-backup,
drill-restore, deploy-v2, rollback, migrate, smoke — the §17.3/§17.4 operating
tooling), `tests/` (load + chaos harnesses, not runnable on the build box),
`ci-staged/` (parked GitHub Actions until the PAT gains `workflow` scope),
`tofu/` (optional OpenTofu), plus `environments.md` (local/staging/prod matrix)
and `README.md`. Wire contract: root `.env` (ADR-0002) read by both Compose
interpolation and `env_file`.

### `docs/` — the paper trail

`BUILD_PROMPT.md` (the spec — source of truth), `AGENTS.md` (fleet law),
`adr/` (0001 editor pin, 0002 env & root config, 0003 auth & orgs, 0004 queue &
cache, 0005 observability), `api/` (§13 is the contract until the generated
OpenAPI publishes), `authoring/` (template + component guides), `phases/`
(phase-exit audit + acceptance matrix), `runbooks/` (RB-01…08 + drill log),
`devlog.md`. Wire contract: PRs cite §-refs; ADRs record any library, architecture
or protocol choice.

### `scripts/` — fleet tooling

`git-sync.sh` — the ONLY sanctioned push path (stage, commit, `pull --rebase`,
push; serialized fleet-wide; never force-push). `check-licenses.mjs` — the §16
license gate wired into CI and `pnpm check:licenses`. Wire contract:
`docs/AGENTS.md` git-workflow section.

### `LICENSES/` · `ATTRIBUTION.md` · `licenses.overrides.json`

Licensing surface: permissive license texts, the attribution ledger (one row per
third-party dependency/asset), and declared overrides for the checker. Wire
contract: spec §16 + §16.5 denylist (no AGPL/SSPL/BUSL/RSALv2/Elastic).

### `.github/` — repo automation

`pull_request_template.md` (summary / spec-refs / checklist), `CODEOWNERS`,
`dependabot.yml`. `workflows/` is intentionally EMPTY — CI lives parked in
`infra/ci-staged/` until the `origin` PAT gains `workflow` scope (see that
README; a human must enable it).

### Root files

`package.json` (turbo scripts: build/dev/lint/typecheck/test/db:seed/check:licenses),
`pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json` (lint +
format gate), `.env.example` (the canonical env matrix), `.editorconfig`,
`.nvmrc` (Node 22), `ATTRIBUTION.md`, `licenses.overrides.json`, and this
README. Real secrets never live here — only in a 0600 `.env` on the box.

## `apps/`

### `apps/web` — Next.js marketing + product UI

Sign-up, workspaces, document library, prompt composer, run timeline, preview,
versions, comments, billing pages, editor shell. Key entries: `src/app/`
(`(marketing)` / `(auth)` / `(app)` route groups, `health/route.ts`), domain
components under `src/components/` (compose, runs, editor, documents, assets,
gallery, billing, settings, shell, realtime, comments, flows, onboarding,
marketing), and `src/lib/api/` (typed client + SSE + a schema mirror asserted
against the gateway). Wire contract: `NEXT_PUBLIC_API_BASE_URL` → gateway `/v1`
(§13), SSE event strings from `packages/config/src/constants/events.ts`.

### `apps/gateway` — Hono REST + SSE API

Auth (Better Auth), RBAC, rate limits, uploads, documents/runs/exports/credits
routes, Stripe webhooks, audit log — the only service the browser talks to
(§3.1). Key entries: `src/index.ts`, `src/app.ts`, `src/routes/` (40 paths),
`src/services/` (runs, documents, exports, billing-complete, event-store…),
`src/middleware/`, `src/authz/` (matrix + guard), `src/openapi.ts` (generated
spec). Wire contract: §13 + `docs/api/README.md`; error envelope codes from
`packages/config/src/errors.ts`.

### `apps/worker` — BullMQ worker (agent loop, critic, exports)

Consumes run/export/image jobs from Valkey, executes the agent loop against the
engine pool, renders previews, commits transactions (§3.1). Key entries:
`src/index.ts` (processor construction + shutdown), `src/queues.ts` (one queue
per tier + Zod payload schemas), `src/run-manager/` (processor, emit, crash),
`src/recovery/` (job retry, run recovery), `scripts/demo-coffee.mjs` /
`demo-spine.mjs` (Phase-0 exit demos). Wire contract: queue payloads + the
`RunProcessor`/`RunOutcome` seam in `src/processor.ts`; tier wall clocks §5.2;
timeouts §3.4.

### `apps/engine-pool` — engine supervisor

One `photocraft-cli serve` process per active session, each with its own 256-bit
token, capability roots, idle timeout and watchdog; crash → checkpoint replay
(§3.2). Key entries: `src/pool.ts`, `src/registry.ts`, `src/attach.ts`,
`src/checkpoint.ts`, `src/recovery.ts`, `src/wal.ts`, `src/health.ts`,
`src/spawners/photocraft-serve.ts` + `serve-config.ts`,
`src/recovery-contract.md`. Wire contract: the vendored editor's control protocol
(via `packages/engine-client`) + the in-tree recovery contract; the browser never
reaches an engine.

### `apps/mock-engine` — protocol-faithful engine fake

Zero-dependency Node fake of the vendored editor's headless control server,
with fault injection. Key entries: `src/index.mjs`, `src/engine.mjs`,
`src/faults.mjs`, `tests/selftest.mjs`. Wire contract: mirrors
`vendor/photocraft/docs/control-protocol.md`; used by `demo-coffee` (spawn +
connect mode), the worker spine tests and the chaos harness.

## `packages/`

### `packages/agent` — the agent runtime (§5)

The deterministic state machine behind a run: planner → executor → validator →
critic → repair (2-cycle gate) → settlement, plus chat-edit classification,
model routing with circuit breakers/failover (§5.3), tier budgets (§5.2),
transactions, cancellation, prompt-injection guards, brand-token service, usage
metering and an OTel/Langfuse observer. Key entries: `src/index.ts`, `src/run-state/machine.ts`,
`src/planner/`, `src/executor/`, `src/classifier/`, `src/critic/`,
`src/repair/`, `src/validator/`, `src/router/`, `src/budgets-service/`,
`src/transactions/`, `src/guards/`. Wire contract: plan schema
`packages/evals/schemas/plan.schema.json`; outcomes surface to the worker's
`RunOutcome`; events over the worker's SSE path.

### `packages/tools` — the 15-tool semantic surface (§6)

Zod-strict tools that wrap engine commands so the model never sees raw command
ids. Key entries: `src/kit.ts` (`defineTool`, `ok`/`err`, capped schema helpers),
`src/registry.ts` (`TOOLS` — the pinned §6 surface), `src/types.ts` (result
envelopes + the structural seams `EngineLike`, `DbLike`, …), one file per tool in
`src/tools/`. Wire contract: `docs/tool-contract.md` + `docs/tool-coverage.md`
in-package; §6.1 rules are enforced by the kit, not by review.

### `packages/engine-client` — typed control-protocol client

The only product-code path to the engine: transport (socket/frame/connection),
methods (`doc.new`, `doc.render`, `doc.save`, engine-command batches), auth
handshake, capability discovery, retry/budget plumbing. Key entries:
`src/client.ts`, `src/transport/`, `src/methods/`, `src/commands.ts`,
`src/capabilities.ts`, plus protocol fixtures under `fixtures/replies/`. Wire
contract: `vendor/photocraft/docs/control-protocol.md` + `rpc.rs`/`commands.rs`,
drift-checked by `tests/drift-check.test.ts`.

### `packages/db` — Drizzle schema + migrations (§12)

PostgreSQL source of truth: users/orgs/workspaces, documents/versions, runs +
append-only command log (WAL), credits ledger + reservations, comments, audit.
Key entries: `src/client.ts`, `src/schema/{auth,content,runs,billing,audit}.ts`,
`drizzle.config.ts`, `migrations/` (forward-only), `scripts/seed.ts` (via root
`pnpm db:seed`). Wire contract: §12; migrations run through the gateway image's
`MIGRATE=1` entrypoint contract or `drizzle-kit migrate` — never manual prod edits.

### `packages/billing` — credits, plans, guardrails (§14)

Append-only credit ledger, plans/pricing, trial rules, plan limits, and the
cost-guardrail family: per-workspace daily spend caps, demo-workspace policy
(watermarked exports, global cap) and provider-class kill switches. Key entries:
`src/ledger.ts`, `src/plans.ts`, `src/policy.ts`, `src/limits/`,
`src/guardrails/`. Wire contract: §14 + §18.4; ledger bridges into the gateway's
billing-complete service; idempotency keys on every money path.

### `packages/config` — env parsing, constants, error catalog

The single env boundary (Zod per app: shared/web/gateway/worker/engine-pool;
missing secrets refuse to start), stable error codes + HTTP status map (§13.3),
SSE event names, tier/limit/pricing constants, feature flags. Key entries:
`src/env/`, `src/errors.ts`, `src/constants/`, `src/flags.ts`, `src/index.ts`.
Wire contract: root `.env.example` (ADR-0002) — app code never reads
`process.env` directly.

### `packages/evals` — promptfoo suites + prompts (§11, §21)

Eval briefs (`cases/` incl. `expanded/` and `chat-edits/`, 67 total), versioned
system prompts (`prompts/planner|executor|critic.system.txt`, §23 mirrors), the
plan JSON schema, the deterministic mock provider, and the pass-rate gate.
Key entries: `promptfoo.config.yaml`, `scripts/eval-gate.mjs` (exit 1 below
0.85), `schemas/plan.schema.json`. Wire contract: §21 + the eval-gate exit
code; scoring the 85/90/70% gates needs live paid-model keys.

### `packages/storage` — object-storage seam

S3/R2 and local-FS drivers behind one interface: workspace-scoped keys (§15.1
prefixes), upload validation (§15.2 hard caps), sha256 integrity, SigV4 signing,
short-lived signed URLs (≤ 15 min). Key entries: `src/index.ts`,
`src/drivers/{local-fs,s3,sigv4}.ts`, `src/keys.ts`, `src/validate.ts`. Wire
contract: `S3_*` vars from `.env.example`; keys asserted by `tests/keys.test.ts`.

### `packages/ui` — design system

Shared React components + tokens for the web app: button/dialog/data-table/
command-palette/toast/tabs and friends, plus `tokens.css`. Key entries:
`src/index.ts` barrel, `src/components/`, `src/tokens.css`, `src/lib/cn.ts`.
Wire contract: the token sheet + component props (Vitest + Testing Library);
consumed only by `apps/web`.

---

Ownership note: this file describes the tree as-built; the phase-exit audit
(`docs/phases/phase-exit-audit.md`) is the companion for what is proven vs
build-only. Keep both updated when the layout changes.
