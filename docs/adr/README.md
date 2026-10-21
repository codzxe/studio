# Architecture Decision Records

Status: current index · 2026-10-21

| ADR | Title | Status | Notes |
|---|---|---|---|
| [0001](0001-editor-pin.md) | Editor pin and vendor policy | **Superseded** | PhotoCraft pin; replaced by ADR 0006 |
| [0002](0002-environment-and-root-config.md) | Environment matrix and root configuration | Accepted | Still valid; editor path changes to `editor/` |
| [0003](0003-auth-and-orgs.md) | Auth and organizations: Better Auth | Accepted | Still valid; “documents” now “projects” |
| [0004](0004-queue-and-cache.md) | Queue and cache: BullMQ on Valkey | Accepted | Still valid; jobs are chats/renders |
| [0005](0005-observability.md) | Observability stack | Accepted | Still valid |
| [0006](0006-effectcraft-editor-pivot.md) | Editor pivot: EffectCraft, frozen UI, additive chat | Accepted | Current editor/product direction |

## Conventions

- One decision per ADR, numbered sequentially.
- Status is one of `proposed`, `accepted`, `superseded`, `deprecated`.
- Superseding an ADR means adding a new ADR that links back; do not rewrite history.
- Product docs (`../PRODUCT_ARCHITECTURE.md`, `../EDITOR_CHAT_UX.md`,
  `../UI_DESIGN_SYSTEM.md`, `../BUILD_PLAN.md`) are not ADRs. They describe the current
  system; ADRs explain why it changed.
