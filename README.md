# studio — agentic motion-graphics SaaS

A user types a prompt and AI agents create or edit **real motion-graphics
compositions** — layers, keyframes, effects, text, footage — inside a
professional After Effects–style editor. The product is built on
**[EffectCraft]**, an open-source Rust motion-graphics engine + editor,
vendored at `editor/` and used **exactly as it is**: its UI is frozen
(ADR-0006) and Studio adds the cloud control plane around it — workspaces,
**projects & compositions** (`.ecproj`), versions, assets, a microcredit
ledger, renders — plus a Cursor-style chat that plans, previews and applies
agent edits as **one atomic `engine.batch` = one undo step = one version**.

> **Codename.** `studio` is an internal codename only; nothing user-facing may
> carry it (product naming is a brand decision expressed through
> `@studio/config` tokens). EffectCraft is an upstream dependency
> (MIT OR Apache-2.0) credited in `ATTRIBUTION.md` — its marks, icons and name
> never appear in the commercial UI.

[EffectCraft]: editor/UPSTREAM.md

## Status

Milestones from [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) (M0–M10):

| Milestone | Scope | Status |
|---|---|---|
| M0–M2 | editor pin + wasm build · auth, workspaces, shell · projects, assets, versions | landed |
| M3 | editor host, bridge, autosave | landed |
| M4 | chat with read-only agent | landed |
| M5 | agent edits: plan → preview → apply → undo | landed |
| M6 | billing, credits (µc ledger), entitlements | landed |
| M7 | collaboration v1: comments, presence, lease, share | landed |
| M8 | renders and export (real `effectcraft-cli` worker) | landed |
| M9 | design system, landing, dashboard | audited + gap-fixed; field perf owed to M10 |
| M10 | hardening, private beta, release | remaining |

Per-milestone evidence: `docs/phases/` (M0, M3–M8 + the m8 CLI spike; the M1/M2
foundations predate the pivot). Binding rulings:
[`docs/DECISIONS.md`](docs/DECISIONS.md). Fleet history: `worklog.md`.

## 5-minute quickstart (zero Postgres, zero Docker)

Node 22+ and pnpm 9 via corepack. Clone, then:

```sh
corepack enable                   # pins pnpm 9.15.9 from packageManager
corepack pnpm install             # workspace + Turborepo install

corepack pnpm dev:sqlite          # SQLite dev DB at .local/studio-dev.db:
                                  # bootstraps the twin schema + demo seed,
                                  # idempotent — no Postgres needed

bash scripts/dev-stack.sh start   # real stack on the SQLite DB: gateway :8787
                                  # + web :3000, full local env set, logs in
                                  # .local/{gateway,web}-dev.log
```

Open <http://localhost:3000> and sign in as the seeded demo user
`demo@studio.test` / `demo-password-12345` (dev fixture only — never in
production). The editor loads at `/editor/` inside any open project; chat runs
offline with the mock model provider.

Stop with `bash scripts/dev-stack.sh stop`; rebuild the dev DB from scratch
with `corepack pnpm dev:sqlite:reset`. Manual per-service commands, the
Postgres-backed flow (staging/production parity, full DB-gated tests) and the
rest of the dev loop: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

**Databases.** The control plane is Drizzle + **Postgres** in
staging/production. Local dev additionally has a **SQLite dev twin** (an
addition beyond the build plan, which assumed Postgres):
`DATABASE_URL="file:/home/z/my-project/.local/<name>.db"` opens a throwaway
better-sqlite3 database over a mirrored schema — same tables and column
names, integer-millisecond timestamps. Dev SQLite files are throwaway (delete
the file to rebuild; no migrations). Twin-schema and dialect rules for
contributors:
[docs/AGENTS.md § SQLite dev database](docs/AGENTS.md#sqlite-dev-database-dual-dialect).

## Architecture

```
                    ┌────────────────────────────────────────────┐
  Browser           │  apps/web — Next.js 16 (React 19):         │
  (React app +      │  marketing · auth · dashboard · settings   │
   editor iframe)   │  chat overlay · hosts the pinned Effect-   │
                    │  Craft wasm editor same-origin at /editor/ │
                    └───────────────────┬────────────────────────┘
                                        │ HTTPS (REST + SSE /v1/*)
                         ┌──────────────▼──────────────┐
                         │  services/gateway — Hono    │  Better Auth (orgs,
                         │  REST + SSE · runs · assets │  API keys) · RBAC ·
                         │  billing · renders · collab │  rate limits · credits
                         └───┬───────────────────┬────┘
                             │                   │
  Postgres (production) ◄────┘                   └──► Valkey (optional —
  / SQLite dev twin                                  rate-limit + cache
  (users, workspaces, projects,                      scale-out seam)
   versions, runs, credit ledger)
                             │                             │
                             │                             ▼
             S3 / R2 / local FS             ┌───────────────────────────┐
             (assets, renders,              │ services/worker           │
              .ecproj versions) ◄──────────┤ Postgres-backed render     │
                                            │ queue · hydrate · drive   │
                                            │ effectcraft-cli · settle  │
                                            │ credits (reserve/refund)  │
                                            └─────┬──────────────┘
                                                  │
                                     LiteLLM ◄────┘ (self-hosted OpenAI-
                                     compatible model gateway; chat runs
                                     compile curated tools → engine.batch
                                     server-side — the model never sees raw
                                     engine commands)
```

Request lifecycle: prompt → gateway validates, reserves credits, enqueues a
run → agent loop over curated Studio tools (inspect → plan card → preview) →
one atomic `engine.batch` apply → immutable version (one undo reverts the run)
→ renders via the worker → credits settled, SSE events to the UI. Failures
roll back, refund and report a typed error envelope.

## Repository map

```
apps/web           Next.js 16 — marketing, auth, dashboard, settings, chat
                   overlay, editor host page; serves the pinned editor wasm
                   dist (committed) at /editor/ with COOP/COEP
services/gateway   Hono API on :8787 — Better Auth, projects, versions,
                   assets, threads/runs (SSE), credits, Stripe billing,
                   renders, comments/presence/leases/share
services/worker    render worker — claims jobs, hydrates the pinned version +
                   assets, drives effectcraft-cli, uploads, settles credits
packages/          ui · contracts · editor-bridge · api-client · config ·
                   db (Drizzle pg schema + sqlite twin + repos) · storage
editor/            vendored EffectCraft — Rust Cargo workspace, pin 9db7f3b2
                   (v0.13.0). UI-FROZEN: never edit for product reasons
                   (ADR-0006; patches only in editor/patches/)
scripts/           dev-sqlite.sh · dev-stack.sh · dev-postgres.sh ·
                   dev-valkey.sh · dev-litellm.sh · gen-env.sh ·
                   git-sync.sh · check-licenses.mjs · editor build helpers
infra/ deploy/     compose · caddy · systemd units · LiteLLM config
docs/              BUILD_PLAN.md (execution) · AGENTS.md (fleet law) ·
                   DEVELOPMENT.md · DECISIONS.md · adr/ · runbooks/ ·
                   phases/ · authoring/ · api/
LICENSES/          permissive license texts (Apache-2.0, BSD-3, ISC, MIT,
                   MPL-2.0, PostgreSQL, …)
```

## Documentation

- **[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)** — the execution plan
  (milestones M0–M10, acceptance criteria, estimates). It supersedes the
  legacy PhotoCraft plan in `docs/BUILD_PROMPT.md` (see
  [ADR-0006](docs/adr/0006-effectcraft-editor-pivot.md)).
- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — the dev loop: bootstrap,
  SQLite/Postgres dev databases, run gateway + web + worker, tests, common
  commands, agent-fleet protocol.
- [docs/AGENTS.md](docs/AGENTS.md) — the build-fleet law: product truth,
  ownership, style gates, SQLite twin-schema rules, git workflow. Humans: see
  [CONTRIBUTING.md](CONTRIBUTING.md).
- [docs/DECISIONS.md](docs/DECISIONS.md) — binding rulings on every
  documented ambiguity.
- [docs/adr/](docs/adr/) — architecture decisions: editor pivot (0006),
  environment (0002), auth & orgs (0003), queue & cache (0004),
  observability (0005), …
- [docs/runbooks/](docs/runbooks/) — ops procedures RB-01…RB-08 plus the
  restore-drill log.
- [docs/phases/](docs/phases/) — milestone evidence and the acceptance
  matrix.

## Development

pnpm workspaces + Turborepo · TypeScript strict · ESM · Zod at every boundary
· typed `Ok`/`Err` envelopes · Vitest (deterministic, no network) · Biome ·
Drizzle forward-only migrations (Postgres) + throwaway SQLite dev twin. Every
command is `corepack pnpm …` — start with
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License & attribution

Closed-source product code. Third-party code, fonts and assets are attributed
in [ATTRIBUTION.md](ATTRIBUTION.md) with license texts under
[LICENSES/](LICENSES/); permissive licenses only —
`corepack pnpm check:licenses` (scripts/check-licenses.mjs) is the gate;
overrides are declared in `licenses.overrides.json`.
