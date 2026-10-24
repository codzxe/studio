# Repository map

Companion to `docs/AGENTS.md` (the fleet law) and `docs/BUILD_PLAN.md` (the
M0–M10 execution plan). One paragraph per top-level directory, service and
package: what it is, the key entry files, and where its wire contract lives.
Rewritten to the as-built post-pivot tree by W1-10 (the pre-pivot map
described the archived PhotoCraft layout — see git history).

## Top-level directories

> **Deleted 2026-10-23 (user order, W1-01):** `archive/` (the pre-pivot PhotoCraft
> legacy tree — retained in git history only, `git log --oneline -- archive/`),
> `agent-ctx/` (stale subagent handoff files) and `tool-results/` (session scratch).
> All three are gitignored; do not recreate or commit them.
>
> **Untracked 2026-10-23 (user order, W3-B purge round 2):** `skills/` (the live
> agent harness — 1070 files, stays on disk), `upload/` + `download/` (session
> paste/deliverable dirs), `bun.lock` (bun contamination; repo is pnpm-only) and
> `services/gateway/scratch-w1-07.ts` (self-declared scratch swept into a sync).
> All gitignored; do not re-commit them.

### `apps/` — deployable UI

One app: `apps/web` (Next.js 16 marketing + product UI). The old multi-service
`apps/` split died with the pivot — the API lives under `services/`.

Route groups under `apps/web/src/app/` (URLs carry no group names):

- `(marketing)/` — public site: `/` (landing), `/pricing`, `/faq`, `/status`,
  `/changelog`, `/legal/{terms,privacy,licences}`.
- `(auth)/` — `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`,
  `/verify-email`, `/invite/[token]`.
- `(app)/onboarding/` — the 3-step workspace/trial onboarding (fresh accounts
  only; any existing membership redirects to `/w`).
- `(app)/w/(shell)/` — the signed-in shell (rail + top bar + ⌘K palette from
  `components/shell/*`, resolved by `lib/workspace-membership.ts`):
  `/w` (dashboard), `/w/projects` (workspace project browser), `/w/billing`,
  `/w/settings{,/members,/api-keys,/audit,/models,/licences}`.
- `(app)/w/[slug]/` — per-project: `(shell)/history` (project hub: overview,
  versions, comments, share links) and `editor` (the real EffectCraft host
  page via `components/editor-host/*` + `lib/editor-session/`).
- `(share)/s/[token]/` — the public share/review page.

Component dirs mirror those surfaces (`components/{marketing,auth,onboarding,
shell,dashboard,projects,hub,billing,settings,share,editor-host,chat,comments,
presence,activity,render,renders-hub,versions,system}`), wired to the gateway
only through `@studio/api-client` via port interfaces. `src/lib/` holds the
`gatewayCall` seam, `lib/chat/` (client chat controller + tool executor),
`lib/editor-session/` (load/autosave engine) and `lib/workspace-membership.ts`.

### `services/` — backend services

#### `services/gateway` — Hono REST + SSE API (the only service the browser talks to)

Auth (Better Auth), RBAC + rate limits, tenant-scoped repos, projects/versions/
assets/leases, chat SSE with the LiteLLM runner + plan compiler, comments/
presence/share, billing (Stripe seam) + credits ledger, renders v2, members +
api-keys + invites, settings + workspace audit. Key entries: `src/index.ts`,
`src/app.ts` (the mount table), `src/routes/` (one module per API domain —
25 modules incl. the `health` and `local-storage` infra routes that have no
contracts module), `src/middleware.ts`,
`src/plan-compiler.ts`, `src/litellm/` (runner + prompt), `src/stripe.ts`,
`src/storage.ts`, `src/signing.ts`. Wire contract: `@studio/contracts` route
schemas + `Ok`/`Err` envelopes on `/v1/*`; error codes add-only in
`packages/config/src/errors.ts` (code → status table in `src/errors.ts`).

#### `services/worker` — render worker (M8)

Claim loop over the Postgres render queue (SKIP LOCKED), hydrates browser-shaped
projects (leading-slash footage rewrite), runs the real effectcraft-cli with
progress/cancel/timeout handling, retention sweeps, in-repo store-method ZIP
writer for png-seq. Key entries: `src/index.ts` (claim loop + sweeps),
`src/pipeline.ts` (runJob), `src/hydrate.ts`, `src/cli.ts`, `src/sweeps.ts`,
`src/zip.ts`, `src/storage.ts`. Wire contract: the `RendersRepo` queue methods
in `@studio/db` + the `RENDER_*` env group in `@studio/config`.

### `packages/` — shared libraries

Seven workspace packages (`@studio/*`). TypeScript strict, ESM, Vitest with
fakes; source-only (`main: ./src/index.ts` — never commit compiled output;
see the .gitignore stale-tsc-emit block).

- `packages/config` — the single env boundary, plan/entitlement catalog,
  render pricing, error-code catalog, brand tokens. Key entries: `src/env.ts`,
  `src/plans.ts`, `src/render-pricing.ts`, `src/errors.ts`, `src/brand.ts`.
- `packages/contracts` — the wire: per-route Zod schemas (`src/routes/*`),
  `envelope.ts` (Ok/Err), `events.ts` (SSE union), `write-tools.ts`
  (propose-only surface), `engine-batch.ts`, `command-registry.ts`.
- `packages/db` — Drizzle schema + repositories + forward-only migrations.
  Key entries: `src/schema.ts`, `src/repos/*` (all take `workspaceId` first),
  `drizzle/` (0000–0006). Wire contract: §12; migrate only via `pnpm db:*`.
- `packages/api-client` — typed browser client for the gateway: `src/client.ts`
  (ports + impls), `src/response-schemas.ts` (runtime validators),
  `src/fixtures.ts` (test doubles).
- `packages/storage` — object-storage seam: local-FS + S3 drivers, SigV4
  signing, workspace-scoped keys (§9.2), magic-byte `validate.ts` (the asset
  verify step's sniffer), sha256. Key entries: `src/index.ts`,
  `src/drivers/{local-fs,s3,sigv4}.ts`, `src/keys.ts`, `src/validate.ts`.
  A declared dependency of `@studio/gateway` since W4-KILL
  (`@studio/storage` + the `./validate` subpath export).
- `packages/editor-bridge` — the `EditorBridge` binding to the real
  `window.effectcraft` surface. Key entries: `src/types.ts`,
  `attachEditorBridge` / dev `attachFake`.
- `packages/ui` — design-system primitives + tokens (22 components, dark-only,
  token-styled; every primitive has a `*.example.tsx` gallery + unit tests).
  Key entries: `src/components/*`, `src/styles/tokens.css`.

### `editor/` — vendored EffectCraft editor (the product editor)

Byte-identical upstream pin `9db7f3b2` (v0.13.0) per `editor/UPSTREAM.md` and
ADR-0006; the wasm dist is built with the Rust toolchain (`cargo xtask web`)
and committed under `apps/web/public/editor/` (re-tuned 2026-10-24 to a
49.4 MB wasm — W1-C/W1-E). Editor UI is frozen (law #7);
the chat is an additive overlay. Wire contract: the `window.effectcraft`
surface consumed by `packages/editor-bridge`.

### `evals/` — golden agent prompts + scoring harness (added 2026-10-24 map refresh)

Deliberately NOT a pnpm workspace package (`pnpm-workspace.yaml` globs only
`apps/*`, `services/*`, `packages/*`, so turbo/root install/test are
unaffected). 40 golden prompts (`prompts/manifest.json`, the BUILD_PLAN §7.2
categories + six hardening extras) plus a hermetic scoring harness
(`harness/` — 20 schema-integrity tests, ~1 s, zero new dependencies;
vocabulary drift-checked against the real `@studio/contracts` sources);
live-model scoring is skip-guarded behind `EVALS_LIVE=1` and **not wired
yet**. Landed with wave 3 (90d74d2). Entry doc: `evals/README.md`.

### `deploy/` — service deployment extras

`deploy/litellm/` — LiteLLM model-proxy config (`config.yaml` + README) for
the OpenAI-compatible endpoint the gateway's `litellm/` runner targets;
run locally via `scripts/dev-litellm.sh` (127.0.0.1:4000, optional).

### `infra/` — hosting & operations

`compose/` (single-box stack: db, valkey, minio + litellm data plane, with a
pending `apps` profile for the app containers; `db-init/` LiteLLM schema),
`caddy/` (the only host-port publisher; TLS/ACME, `/editor/*` static +
COOP/COEP), `systemd/` (native no-Docker service units for
gateway/web/worker), `litellm/` (the compose-stack EDIT-ME proxy config — the
richer dev/runbook config lives at `deploy/litellm/`; both are wired,
consolidation candidate), `README.md` (bring-up, backup, upgrade, rollback).
The pre-pivot `obs/`, `scripts/`, `ci-staged/`, `tofu/` and `environments.md`
were deleted with the W0 monorepo skeleton (git history retains them).

### `docs/` — the paper trail

`AGENTS.md` (fleet law), `BUILD_PLAN.md` (M0–M10), `PRODUCT_ARCHITECTURE.md`,
`EDITOR_CHAT_UX.md`, `UI_DESIGN_SYSTEM.md`, `DECISIONS.md` (binding rulings —
read before deciding anything), `adr/` (0001–0006, incl. the EffectCraft pivot),
`phases/` (milestone evidence files + `gap/` — the W-R read-wave completion
maps, superseded by the W1–W5 landing; each carries a SUPERSEDED header),
`api/` (the wire-contract pointer — `@studio/contracts` + `@studio/api-client`
are the source of truth), `runbooks/`,
`devlog.md`, `repo-map.md` (this file). Also on disk (2026-10-24 refresh):
`DEVELOPMENT.md` (the dev loop), `performance.md` (the measured-budget
ledger), `release-checklist.md` (the v0.1.0-beta.0 tag gate),
`secrets-policy.md`, `BUILD_PROMPT.md` (the superseded pre-pivot plan),
`README.md` (the doc index), and the `authoring/`, `deploy/`, `legal/`,
`security/` subdirs.

### `scripts/` — fleet tooling

`git-sync.sh` — the ONLY sanctioned push path (stage, commit, `pull --rebase`,
push; serialized fleet-wide; never force-push). Dev services: `dev-postgres.sh`
(PG17 on 127.0.0.1:5432), `dev-sqlite.sh` (the file-backed dev DB — W5-01's
stack runs on it), `dev-stack.sh` (one-shot boot of the REAL stack: gateway
:8787 + web :3000 on the SQLite DB, `start|stop`, logs under `.local/`),
`dev-valkey.sh` (optional), `dev-litellm.sh` (optional, 127.0.0.1:4000).
E2E + perf (added 2026-10-24): `e2e-run.sh` (the on-box Playwright stack
runner — watch-free gateway boot + process-group teardown, hardened by W1-E
after an inotify watch-budget crash-loop; load-bearing for every e2e run
here), `e2e-probe-editor.mjs` (the committed editor-boot probe evidence),
`perf/` (the §6 budget measurers: `boot-and-measure.sh` entry,
`api-latency.mjs`, `editor-ready.mjs`, `apply-timing.mjs`; results under
`perf/results/`).
Editor: `build-editor-dist.sh` (canonical wasm-dist build + staging into
`apps/web/public/editor/`), `build_editor_web.sh` (the 4 GB-box OOM-workaround
chunked `cargo build` primitive behind it), `debrand_editor.py` +
`make_studio_assets.py` (provenance: they generate the editor/patches/0001
de-brand patch per ADR-0006 d10 — keep for upstream re-pins). Captures:
`captures/` (marketing/editor screenshot + webm tooling; `run-captures.sh`
is the entry — off-limits to doc purges). License gate: `check-licenses.mjs`.
Env matrix generator: `gen-env.ts` via `gen-env.sh` (`pnpm dev:env` →
`.env.example`). Purged by W5-08 as executed one-offs: `fix-plan-compiler.py`
(M6-A integrator migration, changes landed + test-pinned) and
`serve-editor.py` (superseded by `pnpm editor:serve` = `cargo xtask web
--serve`).

### `LICENSES/` · `ATTRIBUTION.md` · `licenses.overrides.json`

Licensing surface: permissive license texts, the attribution ledger, declared
overrides for the checker. Wire contract: spec §16 denylist (no
AGPL/SSPL/BUSL/RSALv2/Elastic).

### Not mapped (deliberate)

`skills/` (the live agent-harness tooling), `upload/` and `download/` (session
paste/deliverable dirs) are on disk but **untracked + gitignored** since the W3-B
purge (see also W1-01's worklog entry); `bun.lock` is deleted outright (pnpm-only
repo). `node_modules/`, `.local/`, `.turbo/` are build/state dirs.

### Root files

`package.json` (turbo scripts), `pnpm-workspace.yaml`, `turbo.json`,
`tsconfig.base.json`, `biome.json` (lint + format gate), `.env.example` (the
canonical env matrix — regenerate via `scripts/gen-env.ts`), `.gitignore`
(stale-tsc-emit + junk-dir rules), `CHANGELOG.md`. Real secrets never live
here — only in a 0600 `.env` on the box (docs/secrets-policy.md).

---

Ownership note: this file describes the tree as-built. Keep it updated when
the layout changes (W1-10 refreshed it 2026-10-23 after the W1-01 purge;
W5-08 refreshed the apps/web route-group map, the gateway route-module count
and the infra paragraph on 2026-10-23; W2-E re-verified the route map,
the gateway route-module count (25), the workspace-package count (7), the
UI-component count (22) and the drizzle range (0000–0006) against the tree
and added the `evals/`, scripts e2e/perf and docs-index entries on 2026-10-24;
the per-milestone proof lives in `docs/phases/*.md` and the fleet `worklog.md`).
