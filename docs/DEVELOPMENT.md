# Studio development guide

The practical dev loop: bootstrap → database → run → test. The fleet law
(ownership, style gates, git workflow) lives in [AGENTS.md](AGENTS.md); the
SQLite seam rules (twin schema, dialect forks) live in its
"SQLite dev database" section. **Postgres is not required for local
development** — the dev stack runs on a throwaway SQLite file.

## Prerequisites

- **Node ≥ 22** and **pnpm 9.15.9 via corepack** — `corepack enable` pins it
  from the root `packageManager` field; every command below is
  `corepack pnpm …` (this repo is pnpm-only).
- No Docker, no Postgres, no Redis needed for the SQLite dev path. Optional
  native services (Valkey, LiteLLM) degrade gracefully when unset.
- A Rust toolchain is needed **only** to rebuild the vendored editor wasm —
  the built dist is committed at `apps/web/public/editor/` and served
  same-origin at `/editor/`.

## 1. Bootstrap

```sh
corepack pnpm install              # workspace + Turborepo install

cp .env.example .env && chmod 600 .env
```

Edit `.env` for the SQLite path (the template defaults to Postgres):

- `DATABASE_URL="file:$PWD/.local/studio-dev.db"` (repo-root-absolute) — a
  `file:`/`sqlite:` URL; accepted only with `APP_ENV=local`
  (staging/production require Postgres). Use the repo-root-absolute path:
  scripts run from different workspace directories, and a relative `file:`
  path resolves against the current one.
- `AUTH_SECRET=` … generate one: `openssl rand -base64 32`.
- `MOCK_MODEL=true` — offline model provider for local dev (dev-only flag,
  rejected when `APP_ENV=production`; avoids needing a LiteLLM proxy).

The full env matrix (34 vars, with per-var docs) is generated from
`packages/config/src/env.ts`; regenerate the template with
`corepack pnpm dev:env`. Note: services read `process.env` only — the
`.env` file is a worksheet for you, not auto-loaded by the gateway
(`scripts/dev-stack.sh` exports the working local set).

## 2. Database

### SQLite — the PG-free dev default

```sh
corepack pnpm dev:sqlite           # = scripts/dev-sqlite.sh start:
                                    # bootstrap schema + demo seed, idempotent
corepack pnpm dev:sqlite:reset     # delete the file and rebuild fresh
bash scripts/dev-sqlite.sh status  # file + tables + row counts
bash scripts/dev-sqlite.sh dump-schema
```

- File: `.local/studio-dev.db` (gitignored; overrides `STUDIO_SQLITE_DB` /
  `STUDIO_SQLITE_URL`). WAL journal, foreign keys ON, 5 s busy timeout.
- **Scope**: the SQLite twin is an addition beyond [`BUILD_PLAN.md`](BUILD_PLAN.md),
  which assumes Postgres — staging/production stay Postgres, and `file:`/
  `sqlite:` URLs are rejected outside `APP_ENV=local`. The dev seam is
  verified end-to-end: idempotent seed, gateway boot (health/sign-in/projects/
  credits all 200) and the M8 render pipeline (claim → hydrate → settle/refund
  on sqlite via `cd services/worker && node --import tsx
  scripts/sqlite-pipeline-smoke.ts`, a self-contained throwaway-DB smoke).
- **Throwaway by design**: no migrations — `sqlite-bootstrap.ts` recreates the
  tables (`CREATE TABLE IF NOT EXISTS`) on every open; delete the file to
  rebuild. The seed (`corepack pnpm db:seed`) is idempotent on either dialect.
- How it works: `createDb()` in `packages/db/src/db.ts` branches on the URL
  (`file:`/`sqlite:` → better-sqlite3 over the twin schema
  `schema-sqlite.ts`; anything else → Postgres over `schema.ts`). See
  [AGENTS.md](AGENTS.md#sqlite-dev-database-dual-dialect) for the twin-schema
  and dialect-fork rules that govern schema changes and shared repo code.

### Postgres — optional locally, canonical for staging/production

```sh
corepack pnpm dev:pg               # = scripts/dev-postgres.sh start:
                                    # portable PG17 @ 127.0.0.1:5432
                                    # (user studio / pw studio / db studio)
corepack pnpm db:migrate           # apply the forward-only Drizzle migrations
corepack pnpm db:generate          # generate a migration from schema changes
corepack pnpm dev:pg:stop
```

Set `DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio`. Required
for the `packages/db` DB-gated integration suite and for verifying pg-only SQL
(`SKIP LOCKED`, advisory locks, `jsonb` predicates) before it ships.

## 3. Run

Zero-wait one-shot (recommended): `pnpm dev:ready` boots the real stack and
returns the links only after every page is ALREADY compiled — no first-click
spinner, no EADDRINUSE, no browser-side compile:

```sh
corepack pnpm dev:ready            # [1/4] free ports (from 3000/8787)
                                    # [2/4] SQLite bootstrap + demo seed
                                    # [3/4] WASM editor dist verification
                                    # [4/4] boot gateway+web, sign in as the
                                    #       demo user, warm every route (2xx)
corepack pnpm dev:ready:status     # pid/port/http per service (exit 3 = down)
corepack pnpm dev:ready:logs       # last 40 lines of both logs (--follow)
corepack pnpm dev:ready:stop       # graceful process-group shutdown
```

Details (scripts/dev-ready.mjs): repo-owned zombies on the base ports are
stopped first (foreign processes are never killed — the stack moves to the
next free port instead); the port matrix is injected per child (PORT scoped,
GATEWAY_INTERNAL_URL / APP_URL / NEXT_PUBLIC_APP_URL — the dev-stack.sh set);
the warmup signs in through better-auth with the seeded credentials so the
`/w/*` pages compile their AUTHENTICATED render (better-auth rejects
Origin-less POSTs — the runner sends the trusted app origin); the wasm is
range-probed over HTTP (206, `application/wasm`, `\0asm`) without downloading
49 MB. HMR stays live — this is `next dev`, not a production build.

One-shot real stack (gateway + web on the SQLite dev DB, full local env set):

```sh
bash scripts/dev-stack.sh start    # gateway :8787 + web :3000
                                    # logs: .local/{gateway,web}-dev.log
bash scripts/dev-stack.sh stop
```

Manual, per service (env must be in your shell — the export block at the top
of `scripts/dev-stack.sh` is the minimal local set):

```sh
corepack pnpm dev:gateway          # Hono gateway on :8787 (tsx watch)
corepack pnpm dev:web              # Next.js on :3000 (rewrites /v1/* → gateway)
corepack pnpm --filter @studio/worker dev   # render worker (job queue drain)
```

- Demo login (seeded): `demo@studio.test` / `demo-password-12345`.
- The render worker needs the `effectcraft-cli` binary for real renders; with
  `MOCK_MODEL=true` chat works offline, and without the CLI render jobs fail
  honestly (`RENDER_CLI_MISSING`) with an idempotent credit refund.
- Optional: `bash scripts/dev-valkey.sh start` (Valkey — rate-limit/cache
  scale-out seam; everything degrades gracefully without it),
  `bash scripts/dev-litellm.sh start` (model proxy; not needed with
  `MOCK_MODEL=true`), `corepack pnpm editor:serve` (editor wasm dev server on
  :8765, proxied under `/editor/` when `EDITOR_DEV_SERVER_URL` is set).

## 4. Tests

```sh
corepack pnpm test                          # turbo: every workspace (Vitest)
corepack pnpm turbo run test --concurrency=1  # on memory-constrained boxes
corepack pnpm --filter @studio/<pkg> test   # one workspace, e.g. @studio/db
```

Dialect-specific suites:

```sh
# gateway suite on the SQLite dev DB (no Postgres needed):
DATABASE_URL="file:$PWD/.local/studio-dev.db" MOCK_MODEL=true \
  corepack pnpm --filter @studio/gateway test

# packages/db DB-gated integration suite (needs Postgres):
DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio \
  corepack pnpm --filter @studio/db test

# the PG-free sqlite dev-server suite (repos + auth + transactions):
corepack pnpm --filter @studio/db test tests/sqlite
```

Tests are deterministic and network-free. Style gates before finishing any
change: `corepack pnpm lint` (Biome), `corepack pnpm format`,
`corepack pnpm typecheck`, plus `corepack pnpm check:licenses` (the
permissive-licenses-only gate).

## 5. Common commands

| Command | What it does |
|---|---|
| `corepack pnpm install` | Install workspace + Turborepo deps |
| `corepack pnpm dev:sqlite` / `dev:sqlite:reset` | Bootstrap/reset the SQLite dev DB (`scripts/dev-sqlite.sh`) |
| `corepack pnpm dev:pg` / `dev:pg:stop` | Start/stop portable Postgres 17 (`scripts/dev-postgres.sh`) |
| `corepack pnpm dev:gateway` | Gateway dev server on :8787 |
| `corepack pnpm dev:web` | Next.js dev server on :3000 |
| `corepack pnpm db:seed` | Idempotent demo seed (either dialect) |
| `corepack pnpm db:migrate` / `db:generate` | Apply / generate pg Drizzle migrations |
| `corepack pnpm dev:env` | Regenerate `.env.example` from `@studio/config` |
| `corepack pnpm test` / `lint` / `format` / `typecheck` / `build` | Turborepo-wide gates |
| `corepack pnpm check:licenses` | License gate (`scripts/check-licenses.mjs`) |
| `corepack pnpm editor:web` / `editor:serve` / `editor:test` | Rebuild editor wasm / dev-serve it / cargo tests |
| `corepack pnpm dev:ready` (+ `:stop` / `:status` / `:logs`) | Zero-wait one-shot boot: free ports → seeded DB → wasm check → warm every route, then print the links (`scripts/dev-ready.mjs`) |
| `bash scripts/dev-stack.sh start` / `stop` | Boot/stop gateway + web on the SQLite DB |
| `bash scripts/git-sync.sh "<msg>"` | The only sanctioned commit/push path |

## 6. Editor notes

The EffectCraft editor is vendored at `editor/` (pin `9db7f3b2`, v0.13.0 —
never edit it for product reasons; see `editor/UPSTREAM.md` and ADR-0006). The
wasm dist is committed at `apps/web/public/editor/`; rebuild it with
`corepack pnpm editor:web` (or `scripts/build-editor-dist.sh`, which also
stages it) and record size + date in `editor/UPSTREAM.md`.

## 7. Agent fleet protocol

This repo is built by a **parallel agent fleet: 5 waves × 10 agents per wave**
(the ORCH-W1 fleet order). If you are an agent landing here, follow the same
rules:

1. **[AGENTS.md](AGENTS.md) is the law** — read it first; where code and
   instinct disagree, the docs win. [DECISIONS.md](DECISIONS.md) holds binding
   rulings on every documented ambiguity.
2. **Non-overlapping file ownership.** You own ONLY the paths your task lists.
   Shared/registry files (root configs, barrels) only if explicitly listed.
   Need a change elsewhere? Note it in your report + the worklog — don't do it.
   `editor/` (vendored upstream Rust) is never edited.
3. **Append-only `worklog.md`.** `tail -n 120` before starting; append your
   record at the end (never rewrite): `---`, `Task ID`, `Agent`, `Task`,
   `Work Log:` bullets, `Stage Summary:` bullets.
4. **Git-sync between waves.** `bash scripts/git-sync.sh "W<Wave>-<ID>: what
   you did"` — stages, commits, pulls `--rebase` (GitHub wins) and pushes,
   serialized by a global lock. Never hand-roll commits, never force-push,
   never rewrite history. Intermediate syncs encouraged for large file sets.
5. **Gates before finishing:** lint + typecheck + tests green for the files you
   touched; serial turbo (`--concurrency=1`) on constrained boxes; schema
   changes follow the twin-schema rule in [AGENTS.md](AGENTS.md).
