# studio — Agent Onboarding (READ THIS FIRST)

You are one agent in a large **parallel** build of the studio SaaS. This file is the law.
Where code and instinct disagree, the docs win.

## Product truth (post-pivot)

The product is an **agentic motion-graphics SaaS** built around the **EffectCraft**
editor (MIT OR Apache-2.0), vendored at `editor/` (pin `9db7f3b2`, v0.13.0, per
`editor/UPSTREAM.md` and ADR-0006). The old PhotoCraft product is **archived** under
`archive/` — read it only for reference; never import from it.

Doc hierarchy (all under `docs/`): `BUILD_PLAN.md` (execution, milestones M0–M10) →
`PRODUCT_ARCHITECTURE.md` → `EDITOR_CHAT_UX.md` → `UI_DESIGN_SYSTEM.md` →
`adr/0006-effectcraft-editor-pivot.md`. `docs/DECISIONS.md` holds **binding rulings**
on every documented ambiguity — read it before "deciding" anything.
`docs/phases/gap/` holds the completion map from the W-R reader wave.

## Environment truth (this box, re-probed 2026-10-22)

- node 24, pnpm 9.15.9 (on PATH), bun available. **No Docker, no cargo** (the vendored
  editor cannot be compiled here; the wasm dist is a CI artifact, owed — see
  `editor/UPSTREAM.md`). ffmpeg IS available.
- PostgreSQL 17 is **installed and running** at `127.0.0.1:5432` (user `studio`, pw
  `studio`, db `studio`) via `scripts/dev-postgres.sh`. When a command needs the DB,
  export `DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio` — the shell may
  carry a STALE `DATABASE_URL=file:...custom.db`; always set it explicitly in your
  command.
- Valkey optional: `bash scripts/dev-valkey.sh start` (127.0.0.1:6379). Everything
  degrades gracefully without it.
- Dependencies are **installed**. Do NOT run `pnpm install`. Do NOT run dev servers or
  `pnpm dev` (port conflicts; use tests). This box OOMs on parallel tsc:
  always `pnpm turbo run <task> --concurrency=1`.
- `.env` (root) is populated for local runs (MOCK_MODEL=true, AUTH_SECRET set). Never
  commit it; never print secret values.

## Editor strategy on this box (critical)

No cargo → no wasm build → nothing servable at `/editor/` yet. The sanctioned stand-in
is a **protocol-faithful mock editor** served from `apps/web/public/editor/`,
clearly badged "mock engine build" inside its own UI. It must expose the exact
`window.effectcraft` surface that `packages/editor-bridge/src/types.ts` types and
`packages/editor-bridge/src/fake.ts` already models (execute with `engine.batch` +
`$N` refs + atomic rollback + one-undo-step, request, inspect, commands, describe,
query, renderFrame, addFile, readFile, saveToBrowser, screenshot, and the read-side
`ui.inspect` / `project.summary` / `layer.tree` / `prop.get` / `render.frame` /
`edit.history.list` / `edit.undo`). The bridge is written against the REAL contract;
re-pinning upstream later is a dist swap (see `editor/UPSTREAM.md` re-pin checklist).
**Never present the mock as the real engine.**

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
11. No product code imports from `archive/`, `upload/`, `download/`, `tool-results/`,
    `scripts/` (except via `pnpm` scripts) or from archived legacy packages.
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
