# studio — Agent Onboarding (READ THIS FIRST)

You are one agent in a large **parallel** build of the studio SaaS. This file is the law.
Where code and instinct disagree, the docs win.

## Product truth (post-pivot)

The product is an **agentic motion-graphics SaaS** built around the **EffectCraft**
editor (MIT OR Apache-2.0), vendored at `editor/` (pin `9db7f3b2`, v0.13.0, per
`editor/UPSTREAM.md` and ADR-0006). The old PhotoCraft product lived under `archive/`
until it was **deleted by user order on 2026-10-23** (W1-01) — git history retains
it (`git log --oneline -- archive/`); never import from it and never restore it.

Doc hierarchy (all under `docs/`): `BUILD_PLAN.md` (execution, milestones M0–M10) →
`PRODUCT_ARCHITECTURE.md` → `EDITOR_CHAT_UX.md` → `UI_DESIGN_SYSTEM.md` →
`adr/0006-effectcraft-editor-pivot.md`. `docs/DECISIONS.md` holds **binding rulings**
on every documented ambiguity — read it before "deciding" anything.
`docs/phases/gap/` holds the completion map from the W-R reader wave.

## Environment truth (this box, re-probed 2026-10-22; dated corrections 2026-10-24)

- node 24, pnpm 9.15.9 (on PATH), bun available. **No Docker.** Rust toolchain IS
  installed (rustup at /home/z/.rustup, cargo at /home/z/.cargo/bin — export
  PATH="$HOME/.cargo/bin:$PATH") with the wasm32 target; verified 2026-10-24:
  rustc 1.99.1, `wasm-bindgen-cli` 0.2.129, `wasm-opt` 125 all on PATH (W1-C) —
  the editor wasm dist is built from the vendored pin **on this box** (re-tuned
  2026-10-24, 49.4 MB wasm). ffmpeg IS available, and Playwright's chromium
  runs here: the e2e stack boots on-box via `scripts/e2e-run.sh` (W1-E,
  2026-10-24).
- PostgreSQL 17 is **installed** at `127.0.0.1:5432` (user `studio`, pw
  `studio`, db `studio`) via `scripts/dev-postgres.sh` — *2026-10-24:* currently
  STOPPED (W1-F left it stopped; start it with the script when a command needs
  the DB). When a command needs the DB,
  export `DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio` — the shell may
  carry a STALE `DATABASE_URL=file:...custom.db`; always set it explicitly in your
  command. PG-free alternative for dev-server work: the SQLite dev database (next
  section).
- Valkey optional: `bash scripts/dev-valkey.sh start` (127.0.0.1:6379). Everything
  degrades gracefully without it.
- Dependencies are **installed**. *Correction 2026-10-24:* this box CAN install
  and CAN run dev stacks — the `@axe-core/playwright` devDep was installed +
  lockfile-synced 2026-10-24 (commit 3a766a3), and dev stacks + the full
  Playwright e2e boot on-box (`scripts/dev-stack.sh`, `scripts/e2e-run.sh` —
  the latter hardened by W1-E and load-bearing for every e2e run here). The
  old blanket "no installs / no dev servers" bans were environment-era
  claims, now superseded; what REMAINS is fleet coordination law: don't run
  `pnpm install` unless your task explicitly owns a dependency change (it
  mutates the shared `node_modules` under siblings' feet), don't race or
  abandon ports (exactly ONE `next dev` per app dir boots — a second defers
  to the survivor and dies; prefer tests for unit work), and tear stacks
  down when done. This box OOMs on parallel tsc:
  always `pnpm turbo run <task> --concurrency=1`.
- `.env` (root) is populated for local runs (MOCK_MODEL=true, AUTH_SECRET set). Never
  commit it; never print secret values.

## SQLite dev database (dual dialect)

Local dev runs on a **throwaway SQLite file** — zero Postgres, zero Docker
(seam landed W1-02/W1-03, completed W3-A; `scripts/dev-stack.sh` boots the real
stack on it). Postgres stays the canonical production dialect. Practical dev
loop: `docs/DEVELOPMENT.md`.

**Scope note (read before citing the plan):** `docs/BUILD_PLAN.md` assumes
Postgres throughout (§ "Postgres, Valkey, MinIO native installs", "Better Auth
with Drizzle/Postgres"). The SQLite dev twin is an **addition on top of the
plan** (user order "add sqlite for dev server", W1-02) — a dev-server
convenience only, never a production dialect. The seam is verified
end-to-end: W1-A1 (seed smoke — user/org/project/versions/ledger/thread rows
land with integer-ms timestamps, idempotent re-run), W1-A2 + W5-01 (gateway
boots healthy on sqlite: `/health` 200, email sign-in 200, projects 200,
`/v1/me` with credits balance 200, full authed page set 200), W5-10 (M8
render pipeline runs live on the dialect —
`services/worker/scripts/sqlite-pipeline-smoke.ts`).

- **URL pattern**: `DATABASE_URL="file:/home/z/my-project/.local/<name>.db"`
  (also `sqlite:…`; `file::memory:` = in-memory). Default file
  `.local/studio-dev.db`, created + seeded idempotently by
  `corepack pnpm dev:sqlite` (`scripts/dev-sqlite.sh start`; also `reset`,
  `status`, `dump-schema`; overrides `STUDIO_SQLITE_DB` / `STUDIO_SQLITE_URL`).
- `file:`/`sqlite:` URLs are accepted **only when `APP_ENV=local`** — env
  validation rejects them in staging/production (packages/config ENV_VAR_SPECS).

### Twin schema rule (BINDING for every schema change)

`packages/db/src/schema-sqlite.ts` mirrors `packages/db/src/schema.ts`. Every
`schema.ts` change MUST be mirrored in `schema-sqlite.ts`: same table names,
same column names, same indexes/FKs — only column types and default
expressions differ (`pg now()` → sqlite `(unixepoch('subsec') * 1000)`,
integer-millisecond timestamps). Type mapping: pg `timestamp` →
`integer` timestamp-ms, `jsonb` → `text` json, `boolean` → `integer` 0/1.
Order: pg twin FIRST, then regenerate the sqlite twin + the bootstrap DDL
(`packages/db/src/sqlite-bootstrap.ts`, drizzle-kit over the sqlite twin).
Never feed a migration from the twin and never run the pg migration folder
against it — dev sqlite databases are THROWAWAY (delete the file to rebuild;
`pnpm dev:sqlite:reset`). The PG-free sqlite suite
(`packages/db/tests/sqlite/`) exercises the real repos and fails on drift.

### Dialect rules for shared (repo) code

- Resolve tables through **`tablesFor(db)`** (`packages/db/src/tables.ts`) in
  any code that INSERTs/UPDATEs. A query built from a pg table carries pg
  defaults (`now()` — "no such function" on sqlite) and pg mappers (ISO
  strings into integer-ms columns); selects happen to work, writes corrupt.
  Inside a transaction, resolve from the `tx` handle you are given.
- Fork pg-specific SQL behind **`getDialect(exec) === "sqlite"`** (never off
  the static type — a sqlite handle flows through pg-typed signatures):
  drop `FOR UPDATE` / `SKIP LOCKED` (one serialized connection), skip
  advisory locks, `greatest()` → `max()`, `count(*)::int` → `count(*)`,
  `now()` → `unixepoch('subsec') * 1000`; unique violations arrive as
  `SQLITE_CONSTRAINT_UNIQUE` and must map onto the same typed CONFLICT path
  as pg 23505.
- `await db.transaction(async (tx) => …)` is **safe on the sqlite handle**:
  the factory swaps in an explicit BEGIN/COMMIT/ROLLBACK driver with
  SAVEPOINT nesting (`makeSqliteTransactionAsyncAware`,
  `packages/db/src/db.ts`); the callback receives the same handle. A
  pg-flavored `execute()` alias is installed as well.
- **Better Auth on sqlite** (`packages/db/src/auth.ts`): the drizzleAdapter
  gets `provider: "sqlite"`, `transaction: false` (the raw better-sqlite3
  driver rejects async callbacks) and the TWIN tables.
- `better-sqlite3` is a dev-only dependency, loaded lazily (dynamic
  `import()` / `createRequire`) — production (Postgres) bundles never include
  the native module.

### When to use which dialect

- **SQLite** (`file:…`): PG-free dev-server work (gateway + web + worker),
  hosts without Docker/Postgres, and the gateway test suite — it runs green
  on either dialect (`DATABASE_URL=file:/home/z/my-project/.local/studio-dev.db
  MOCK_MODEL=true corepack pnpm --filter @studio/gateway test`).
- **Postgres**: the `packages/db` DB-gated integration suite (advisory locks,
  SKIP LOCKED, jsonb predicates run live there and skip without Postgres),
  migration verification (`pnpm db:generate` / `db:migrate` target pg only),
  and staging/production parity. Start it with `corepack pnpm dev:pg`.

## Editor strategy on this box (critical)

The **real EffectCraft editor** is the product editor — no mocks, no stand-ins.
The vendored source at `editor/` (pin `9db7f3b2`, v0.13.0) is byte-identical to
upstream and IS the editor we ship. The wasm dist is built from it with the
Rust toolchain (`rustup` → stable + `wasm32-unknown-unknown`, `wasm-bindgen-cli
0.2.129`), emitted by `cargo xtask web` into `editor/target/web/dist`, and copied
to `apps/web/public/editor/` (served same-origin at `/editor/` with COOP/COEP,
flat relative URLs, trailing-slash already handled by `next.config.ts`).

Dist policy until the CI artifact pipeline lands: the built dist is committed
under `apps/web/public/editor/` (it is a build artifact — record size + date in
`editor/UPSTREAM.md` whenever it is rebuilt). Rebuild = `cargo xtask web` in
`editor/` then re-copy; the bridge (`packages/editor-bridge`) binds to the real
`window.effectcraft` surface. **Never mock the editor.**

## Hard rules (violations fail the task)

1. Typed envelopes everywhere (`Ok`/`Err` from `@studio/contracts`); no bare throws at
   boundaries; no stack traces / absolute paths / object keys / internal ids in
   responses.
2. Zod at every boundary: request bodies, query params, SSE payloads, bridge results,
   tool args, env.
3. Tenant isolation: every repository function takes `workspaceId` first and filters by
   it. Cross-tenant = **404**, never 403.
4. Idempotency for every mutation, credit operation and webhook.
5. The model never sees raw engine commands or filesystem paths. Curated `@studio/contracts`
   tools only; plans compile to `engine.batch` **server-side**.
6. Every agent edit = ONE atomic `engine.batch` = ONE undo step = ONE version.
7. Editor UI is frozen: nothing under `editor/crates/ui-egui` may be edited for visual
   reasons; nothing in the product may restructure `/editor`'s internals. The chat is
   an additive overlay only.
8. Design system only via tokens (`packages/ui` styles): no raw hex in components;
   dark-only; signal accent `--signal`.
9. Domain language: **projects & compositions**. The word "Document" is banned in new
   UI copy. No user-facing surface may carry the codename; product name comes from
   `@studio/config` brand tokens.
10. Money: append-only `credit_ledger`; reserve → commit/refund; no negative balance.
11. No product code imports from `upload/`, `download/`, `tool-results/`, `scripts/`
    (except via `pnpm` scripts) or from legacy/archived packages. The old `archive/`
    tree was deleted by user order on 2026-10-23 (W1-01; git history retains it) —
    never restore it.
12. You own ONLY the paths your task lists. Shared/registry files (root configs,
    package.json, tsconfig paths, barrels like `packages/contracts/src/index.ts`)
    only if your task explicitly lists them. Need a change elsewhere? Note it in your
    report + worklog; do not do it.

## Wire contracts (read before wiring)

- API: `/v1/*` behind `Ok`/`Err` envelopes (`packages/contracts/src/envelope.ts`),
  typed route schemas in `packages/contracts/src/routes/*`.
- SSE: `StudioStreamEvent` union (`packages/contracts/src/events.ts`), ordered `seq`
  per run, `Last-Event-ID` replay, cancel via abort.
- Bridge: `EditorBridge` (`packages/editor-bridge/src/types.ts`); attach via
  `attachEditorBridge` / dev `attachFake`.

## Style gates (CI-enforced)

- TypeScript strict, ESM (`"type": "module"`), no `any` in exported APIs, `'use client'`
  where needed, Biome formatting (`pnpm lint`).
- Tests: Vitest, deterministic, no network, `<5s` units; `pnpm turbo run test
  --concurrency=1` must stay green for files you touched; gateway DB-gated tests run
  when `DATABASE_URL` is exported (see above).
- Migrations: forward-only Drizzle SQL (`packages/db/drizzle/`), generated via
  `pnpm db:generate`; never hand-edit applied migrations.

## Git workflow (MANDATORY — every agent, every wave)

    scripts/git-sync.sh "W<Wave>-<ID>: what you did"

Stages, commits, pulls `--rebase` (GitHub wins) and pushes, serialized by a global
lock. NEVER hand-roll commit/push; never force-push; never rewrite history. Intermediate
syncs encouraged for large file sets.

## Worklog (MANDATORY)

- Before starting: `tail -n 120 /home/z/my-project/worklog.md`.
- After finishing, append (never overwrite):

```bash
cat >> /home/z/my-project/worklog.md << 'EOF'
---
Task ID: <your id, e.g. W4-A>
Agent: <subagent name>
Task: <one line>
Work Log:
- <step>
- <step>
Stage Summary:
- <files created / key decisions / blockers>
EOF
```
