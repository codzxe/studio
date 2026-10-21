# Archive — pre-EffectCraft baseline

Everything in this directory belongs to the **superseded PhotoCraft/static-design
product** (see `docs/adr/0006-effectcraft-editor-pivot.md`). It is preserved for
reference and salvage under the `pre-effectcraft-baseline` git tag and this
archive tree. It is **not** part of the active build: it is excluded from the
pnpm workspace, CI and the product runtime. Do not import from `archive/` in
product code.

## What is here and why

| Path | Disposition | Notes |
|---|---|---|
| `apps/web` | archive | Old PhotoCraft product UI (documents, templates, photocraft engine). Replaced by the new `apps/web`. |
| `apps/gateway` | archive | Old Hono gateway bound to the photocraft engine protocol. Route logic deliberately re-homed into the new `services/gateway` where applicable. |
| `apps/worker` | archive | Old BullMQ worker around photocraft-cli. The new `services/worker` drives `effectcraft-cli`. |
| `apps/engine-pool`, `apps/mock-engine` | archive | Engine babysitting for the vendored photocraft editor; obsolete. |
| `packages/agent`, `packages/tools`, `packages/engine-client` | archive | Built around photocraft commands; concepts (tool surface, plan compiler, batch atomicity) are re-implemented against EffectCraft's live command registry. |
| `packages/db` | archive | Old Drizzle schema (documents/runs/credits for photocraft). New `packages/db` carries the ADR-0006 model (projects, versions, threads, runs, leases, comments, renders). |
| `packages/evals`, `evals/` | archive | Static-design brief evals for photocraft templates. |
| `packages/ui` | archive | Old design system. Replaced by the dark cinematic system in `docs/UI_DESIGN_SYSTEM.md`. |
| `engine-patches/` | archive | Upstreamable Rust patches for the photocraft editor. Not part of the new critical path. |
| `infra/` | archive | Old compose/caddy/obs wiring for the photocraft stack. New `infra/` is built per `docs/PRODUCT_ARCHITECTURE.md` §14. |

## Kept in the active tree

`packages/billing` (ledger + plans logic), `packages/storage` (S3 validation,
keys, sha256) and `packages/config` (env parsing patterns) remain active and are
being adapted to the new architecture per the M0 classification in
`docs/BUILD_PLAN.md`.

The full audit lives at `docs/phases/phase-exit-audit.md` (legacy) and the new
milestone evidence will land in `docs/phases/M0.md` onward.
