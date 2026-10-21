# studio — agentic design SaaS

A user types a prompt and AI agents create or edit **real layered documents** —
backgrounds, photos, text, shapes, masks, adjustments, effects, groups — inside a
professional image editor. The output is an **editable layered file** (native
`.pcraft`, plus PNG/JPG/PSD export), never a flat AI image. Users then chat-edit
individual elements, undo an entire agent run in one step, version, comment, and
export.

**The core insight** (spec §0): treat the document like a code repository and engine
commands like file edits. The agent reads layers (`document.inspect`, `layer.list`),
edits via engine commands, "runs tests" (`doc.render` preview → deterministic
validator → vision critic), and commits each run as **one transaction** — a single
undo reverts it. Editability is the product (§25): no LLM pixel painting, no
flattening, no baking.

> **Codename.** `studio` is an internal codename only. The product name is undecided
> and must never use the forbidden names (§1.5); nothing user-facing may carry it.
> The editor engine is an open-source Rust project vendored as a shallow clone at
> `vendor/photocraft`, pinned per ADR-0001 and driven only over its headless control
> protocol.

## Status

| Phase | Goal (§19) | Status |
|---|---|---|
| 0 — Spike | engine spine end-to-end: prompt → template fill → render → critic | **complete (code)** — proven end-to-end against the protocol-faithful mock engine, determinism hash-asserted |
| 1 — MVP | sign-up → upload → prompt → watch → undo → export, billing | **build-complete** — 40 gateway paths, cross-tenant/RBAC/ledger suites, engine pool; staging + Stripe test-mode owed to a live env |
| 2 — Templates & components | engine additions, 10 templates, 15 components | **build-complete** — 4 engine patch modules, 16 templates, 10/15 components, 67-brief eval suite; 85/90/70% gates need live models |
| 3 — Freeform & collaboration | comments, variants, public API | **scoped out** — primitives only (`document.diff`, OpenAPI/API-key surface, freeform eval seeds) |
| 4 — Production hardening | paid beta | **scoped out** — runbooks, recovery, guards and license/CI landed with earlier phases; the operational gate is honestly open |

### Honest state note

This repo is **build-complete**: the code criteria of §19 are satisfied in-tree and
unit/integration-tested with fakes and the mock engine. The **runtime criteria** —
booting the Compose stack, a real `photocraft-cli` binary, a Stripe test-mode
subscription E2E, paid-model eval runs, load/chaos drills — need a live environment
this build box cannot provide. The full row-by-row audit and the environment-debt
ledger live in [`docs/phases/phase-exit-audit.md`](docs/phases/phase-exit-audit.md)
(companion: [`docs/phases/acceptance-matrix.md`](docs/phases/acceptance-matrix.md)).

## 5-minute quickstart

Node 22+, pnpm 9, Docker. Clone, then:

```sh
pnpm install                                   # workspace + Turborepo install

cp .env.example .env && chmod 600 .env         # env matrix (ADR-0002);
                                               # host dev: use localhost in
                                               # DATABASE_URL / VALKEY_URL

cd infra/compose && \
  docker compose --env-file ../../.env -f docker-compose.yml up -d db valkey
cd ../..                                       # Postgres 16 + Valkey 8 up

pnpm --filter @studio/worker demo:coffee      # Phase-0 exit demo: the §24.1
                                               # coffee-promo run end-to-end vs
                                               # the mock engine — layered .pcraft
                                               # + PNG + critic report + command
                                               # log, determinism-asserted. Zero
                                               # deps; no db/valkey needed.

pnpm db:seed                                   # seed the Drizzle schema
pnpm dev                                       # web :3000 · gateway :8787 ·
                                               # worker · engine-pool
```

Artifacts land in `apps/worker/.demo-output/` (see
`apps/worker/scripts/demo-coffee-README.md` for what each proves — and what is
honestly mocked). A root-level `pnpm demo:coffee` alias is still owed
(phase-exit-audit ledger); today use the `--filter` form above.

## Architecture

```
                    ┌────────────────────────────────────────────┐
  Browser           │  web (Next.js) — marketing + product UI,   │
  (React app +     │  prompt composer, run timeline, editor      │
   wasm editor)    └───────────────────┬────────────────────────┘
                                         │ HTTPS
                          ┌──────────────▼──────────────┐
                          │  gateway (Hono, TS)          │  auth · RBAC · rate limits
                          │  REST + SSE · uploads ·      │  credit reservations
                          │  runs · billing · webhooks  │
                          └───┬───────────────────┬─────┘
                              │                   │
          Postgres ◄──────────┘                   └────────► Valkey (BSD, not Redis 7.4+)
          (users, workspaces,                               BullMQ: one queue per tier,
           documents, runs, credits ledger,                rate limits, caches
           append-only command log = WAL)
                              │                             │
                              │                             ▼
            S3 / R2                          ┌───────────────────────────┐
            (assets, renders,                 │ worker (BullMQ, TS)      │
             exports, .pcraft backups) ◄─────┤ agent loop · 15 semantic │
                                             │ tools · validator ·      │
                                             │ critic · repair · exports│
                                             └─────┬──────────────┬────┘
                                                   │              │
                                       LLM APIs ◄──┘              ▼
                                       (paid only,      engine-pool (supervisor)
                                       §5.3 routing)   └► one photocraft-cli serve
                                                         per active session — own
                                                         256-bit token, capability
                                                         roots, idle timeout; the
                                                         browser NEVER reaches an
                                                         engine (§3.2)
```

Request lifecycle (§3.3): prompt → gateway validates, reserves credits, enqueues a
BullMQ job → worker allocates/attaches the engine session, runs the agent loop,
renders previews → validator + critic, up to 2 repair cycles → transactional commit
(one undo reverts the run) → `.pcraft` + PNG to storage, credits settled, SSE events
to the UI. Failures roll back, refund, and report a typed error envelope.

## Repository map

```
apps/            deployable services: web · gateway · worker · engine-pool · mock-engine
packages/        shared libraries: agent · tools · engine-client · db · billing ·
                 evals · storage · ui · config
engine-patches/  upstreamable Rust modules for the vendored editor (§2.3, §16.1)
evals/           golden fixtures: 16 template manifests + 10 components
infra/           compose · caddy · obs · scripts · tofu · ci-staged · tests
docs/            BUILD_PROMPT.md (source of truth) · AGENTS.md · adr · runbooks ·
                 authoring · phases · api · devlog
scripts/         git-sync.sh (fleet push) · check-licenses.mjs (§16 gate)
LICENSES/        permissive license texts (Apache-2.0, BSD-3, ISC, MIT, MPL-2.0, …)
```

One paragraph per directory, app and package — with entry files and wire-contract
pointers — lives in **[docs/repo-map.md](docs/repo-map.md)**.

## Documentation

- **[docs/BUILD_PROMPT.md](docs/BUILD_PROMPT.md)** — the product spec and single
  source of truth (§0 is the one-page summary). Where code and instinct disagree,
  the spec wins; cite §-refs wherever the "why" matters.
- [docs/AGENTS.md](docs/AGENTS.md) — the build-fleet law: git workflow, ownership,
  style gates, forbidden list. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).
- [docs/adr/](docs/adr/) — architecture decisions: editor pin (0001), env/config
  (0002), auth & orgs (0003), queue & cache (0004), observability (0005).
- [docs/runbooks/](docs/runbooks/) — ops procedures RB-01…RB-08 + the restore-drill
  log, mapped to §22 alerts.
- [docs/authoring/](docs/authoring/) — template and component authoring guides.
- [docs/api/](docs/api/) — the public API: §13 is the contract; OpenAPI 3.1 is
  generated from the gateway's Zod schemas (`apps/gateway/src/openapi.ts`).
- [docs/phases/](docs/phases/) — honest phase-exit audit + acceptance matrix.

## Development

pnpm workspaces + Turborepo · TypeScript strict · ESM · Zod at every boundary ·
typed result envelopes (never thrown strings) · Vitest, deterministic, no network ·
Drizzle forward-only migrations. CI (staged in `infra/ci-staged/` until the repo
token gets `workflow` scope) runs: **lint → typecheck → unit tests → build**, plus
the §16 license gate and a Rust `cargo check/test/clippy + panic_hunt` job over
`engine-patches/`. Details for contributors: [CONTRIBUTING.md](CONTRIBUTING.md).

## License & attribution

Closed-source product code. Third-party code, fonts and assets are attributed in
[ATTRIBUTION.md](ATTRIBUTION.md) with license texts under [LICENSES/](LICENSES/);
permissive licenses only (§16.5) — no AGPL/SSPL/BUSL/RSALv2/Elastic-licensed
dependencies anywhere, which is why the queue is Valkey and the dashboards are
Perses. `pnpm check:licenses` (scripts/check-licenses.mjs) is the gate; overrides
are declared in `licenses.overrides.json`. Font files are never committed
(`CRAFT_FONTS_DIR` points at a pinned external clone).
