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

### `apps/` — deployable UI

One app: `apps/web` (Next.js 16 marketing + product UI). The old multi-service
`apps/` split died with the pivot — the API lives under `services/`.

### `services/` — backend services

#### `services/gateway` — Hono REST + SSE API (the only service the browser talks to)

Auth (Better Auth), RBAC + rate limits, tenant-scoped repos, projects/versions/
assets/leases, chat SSE with the LiteLLM runner + plan compiler, comments/
presence/share, billing (Stripe seam) + credits ledger, renders v2, members +
api-keys + invites. Key entries: `src/index.ts`, `src/app.ts` (the mount
table), `src/routes/` (23 route modules), `src/middleware.ts`,
`src/plan-compiler.ts`, `src/litellm/` (runner + prompt), `src/stripe.ts`,
`src/storage.ts`, `src/signing.ts`. Wire contract: `@studio/contracts` route
schemas + `Ok`/`Err` envelopes on `/v1/*`; error codes add-only in `src/errors.ts`.

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
  NOTE: not yet a declared dependency of `@studio/gateway` (imported via a
  relative source-path seam, `services/gateway/src/routes/assets.ts:64-68`) —
  one-line package-graph follow-up owed.
- `packages/editor-bridge` — the `EditorBridge` binding to the real
  `window.effectcraft` surface. Key entries: `src/types.ts`,
  `attachEditorBridge` / dev `attachFake`.
- `packages/ui` — design-system primitives + tokens (23 components, dark-only,
  token-styled; every primitive has a `*.example.tsx` gallery + unit tests).
  Key entries: `src/components/*`, `src/styles/tokens.css`.

### `editor/` — vendored EffectCraft editor (the product editor)

Byte-identical upstream pin `9db7f3b2` (v0.13.0) per `editor/UPSTREAM.md` and
ADR-0006; the wasm dist is built with the Rust toolchain (`cargo xtask web`)
and committed under `apps/web/public/editor/`. Editor UI is frozen (law #7);
the chat is an additive overlay. Wire contract: the `window.effectcraft`
surface consumed by `packages/editor-bridge`.

### `deploy/` — service deployment extras

`deploy/litellm/` — LiteLLM model-proxy config (`config.yaml` + README) for
the OpenAI-compatible endpoint the gateway's `litellm/` runner targets;
run locally via `scripts/dev-litellm.sh` (127.0.0.1:4000, optional).

### `infra/` — hosting & operations

`compose/` (single-box stack: caddy, gateway, web, db, valkey), `caddy/` (the
only host-port publisher; TLS/ACME), `obs/` (alert rules, scrape configs,
dashboards), `scripts/` (backup/verify/drill/deploy/migrate/smoke operating
tooling), `ci-staged/` (parked GitHub Actions until the PAT gains `workflow`
scope), `tofu/` (optional OpenTofu), `environments.md`.

### `docs/` — the paper trail

`AGENTS.md` (fleet law), `BUILD_PLAN.md` (M0–M10), `PRODUCT_ARCHITECTURE.md`,
`EDITOR_CHAT_UX.md`, `UI_DESIGN_SYSTEM.md`, `DECISIONS.md` (binding rulings —
read before deciding anything), `adr/` (0001–0006, incl. the EffectCraft pivot),
`phases/` (milestone evidence files + gap maps), `api/`, `runbooks/`,
`devlog.md`, `repo-map.md` (this file).

### `scripts/` — fleet tooling

`git-sync.sh` — the ONLY sanctioned push path (stage, commit, `pull --rebase`,
push; serialized fleet-wide; never force-push). Dev services:
`dev-postgres.sh` (PG17 on 127.0.0.1:5432), `dev-valkey.sh` (optional),
`dev-litellm.sh`. Editor dist build: `build-editor-dist.sh`. License gate:
`check-licenses.mjs`. Env matrix generator: `gen-env.ts` (`.env.example`).

### `LICENSES/` · `ATTRIBUTION.md` · `licenses.overrides.json`

Licensing surface: permissive license texts, the attribution ledger, declared
overrides for the checker. Wire contract: spec §16 denylist (no
AGPL/SSPL/BUSL/RSALv2/Elastic).

### Not mapped (deliberate)

`upload/` and `download/` hold user-provided session files; `skills/` holds
sandbox tooling — all outside the product tree (see W1-01's worklog entry);
`node_modules/`, `.local/`, `.turbo/` are build/state dirs.

### Root files

`package.json` (turbo scripts), `pnpm-workspace.yaml`, `turbo.json`,
`tsconfig.base.json`, `biome.json` (lint + format gate), `.env.example` (the
canonical env matrix — regenerate via `scripts/gen-env.ts`), `.gitignore`
(stale-tsc-emit + junk-dir rules), `CHANGELOG.md`. Real secrets never live
here — only in a 0600 `.env` on the box (docs/secrets-policy.md).

---

Ownership note: this file describes the tree as-built. Keep it updated when
the layout changes (W1-10 refreshed it 2026-10-23 after the W1-01 purge; the
per-milestone proof lives in `docs/phases/*.md` and the fleet `worklog.md`).
