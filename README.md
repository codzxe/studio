# studio

Agentic design SaaS: a user types a prompt and AI agents create or edit **real layered
documents** — backgrounds, photos, text, shapes, masks, adjustments, effects, groups —
inside a professional image editor. Output is an editable layered file (native `.pcraft`
plus PNG/JPG/PSD export), never a flat AI image.

> Codename only — the product name is undecided and must not use forbidden names (§1.5).

## Status

| Phase | Goal | Status |
|---|---|---|
| 0 — Spike | engine spine end-to-end: client → template fill → render → critic | building |
| 1 — MVP | sign-up → upload → prompt → watch → undo → export, billing | building |
| 2 — Templates & components | engine additions, 10 templates, 15 components | building |
| 3 — Freeform & collaboration | comments, variants, public API | building |
| 4 — Production hardening | paid beta | building |

## Layout

```
apps/        web (Next.js) · gateway (Hono) · worker (BullMQ) · engine-pool (supervisor)
packages/    agent · tools · engine-client · db · billing · evals · ui · config
engine-patches/   upstreamable Rust additions for the editor (§2.3)
infra/       compose · caddy · scripts · tofu
docs/        BUILD_PROMPT.md (source of truth) · AGENTS.md · adr/
```

## Development

See `docs/AGENTS.md` for conventions, `docs/BUILD_PROMPT.md` for the full product spec.
CI: lint → typecheck → unit tests → build on every push.

## License & attribution

Closed-source product code. Third-party code, fonts and assets are attributed in
`ATTRIBUTION.md`; permissive licenses only (§16).
