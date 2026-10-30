# ADR 0006 — Editor pivot: EffectCraft, frozen editor UI, additive chat

Date: 2026-10-21 · Status: accepted

## Context

The original plan (`docs/BUILD_PROMPT.md`) wraps **PhotoCraft**, a static layered-design
editor, and assumes `.pcraft` documents, templates, static layer composition and PNG
export. The product direction has changed: the commercial product is a **motion-graphics
and visual-effects SaaS** built on **EffectCraft** (`storytold/effectcraft`), an
After Effects–style editor written in Rust with compositions, a timeline, keyframes,
3D, 306 effects, a render queue and a WASM web build.

The product requirement is equally explicit about the editor UI: **use EffectCraft's
editor UI exactly as it is**. Do not redesign its panels, menus, timeline, toolbar,
theme or density. Add a Cursor-style chat surface on top of it. Chat must be able to
float inside the editor viewport and, optionally, dock as a sidebar.

## Decision

1. **Product domain.** Studio is a multi-tenant, agentic motion-graphics SaaS. A
   workspace owns projects; a project is an EffectCraft `.ecproj`; compositions,
   layers, keyframes, effects, media and renders live inside it.
2. **Editor.** Fork/vendor `storytold/effectcraft` into `editor/` as a self-contained
   Cargo workspace and build the upstream web editor for the browser. The editor is
   **UI-frozen**: no changes to `crates/ui-egui` panels, menus, theme, layout or
   interaction model. Only build/integration changes that are strictly required to
   host it are allowed, and each is recorded in `apps/editor/UPSTREAM.md`.
3. **Editor runtime.** Web-first. The browser editor runs from a pinned EffectCraft
   web build. Native packaging is out of scope for v1.
4. **Editor boundary.** The editor is served same-origin at `/editor/` and rendered in
   an iframe. The SaaS page owns the frame, auth, project loading, autosave and chat.
   The bridge is EffectCraft's existing `window.effectcraft` API
   (`request`, `execute`, `inspect`, `renderFrame`, `addFile`, `saveToBrowser`,
   `readFile`, `screenshot`). No new engine command surface is required for v1.
5. **Chat.** A React overlay in the SaaS workspace, positioned inside the editor
   viewport. Default: floating panel. Optional: docked sidebar. Chat contains the
   thread, streaming, tool cards, model picker, context chips, previews and
   apply/undo. It never modifies EffectCraft's internal UI.
6. **SaaS control plane.** TypeScript (Next.js + gateway), Better Auth (organization,
   API-key and admin plugins), Drizzle + Postgres, Stripe billing, credit ledger.
   The editor remains Rust.
7. **Agent stack.** Vercel AI SDK for chat/streaming/tool orchestration; self-hosted
   LiteLLM as the OpenAI-compatible model gateway. The model never sees raw engine
   commands; it sees a curated Studio tool surface that compiles to
   `engine.batch`.
8. **Domain language.** Product UI says **Projects** and **Compositions**. The old
   static-design term “Documents” is retired.
9. **Collaboration.** Comments, presence, versions, activity and a single-writer
   document lease in v1. No CRDT/OT real-time co-editing in v1.
10. **Brand.** The commercial product is not named EffectCraft or ArtCraft. EffectCraft
    is an upstream dependency and must be credited in `ATTRIBUTION.md` / `NOTICE`.
    Its marks, icons and product name are not used in the commercial UI.

## Consequences

- The PhotoCraft vendor pin, `engine-patches/` and PhotoCraft-specific commands in
  `docs/BUILD_PROMPT.md` become legacy. They must be removed or archived in Phase 0;
  they are not part of the new critical path.
- The editor can be upgraded by re-pinning upstream without merging a UI fork. The
  integration surface is intentionally small.
- The SaaS must implement cloud project loading/saving, asset registration, tenant
  isolation, credits and chat because EffectCraft has none of those.
- EffectCraft is alpha (first commit October 2026; ~91% feature parity, ~45% production
  readiness by its own assessment). The build plan must include upstream pinning,
  regression tests and a rollback path.
- The wasm editor is large (~58 MB uncompressed, ~10–17 MB compressed) and needs
  WebGPU/WebGL2, COOP/COEP headers, workers and service-worker caching. Performance
  budgets are part of the product, not an afterthought.

## Supersedes

- `docs/adr/0001-editor-pin.md` — PhotoCraft editor pin and patch policy.
- The PhotoCraft-specific assumptions in `docs/BUILD_PROMPT.md` §2, §7–§10, §20 and
  §24. The SaaS principles in §1, §3, §5, §11–§19 and §25 remain the baseline where
  they do not contradict this ADR.

## Upstream policy

- Pin an exact EffectCraft commit in `apps/editor/UPSTREAM.md` and `ATTRIBUTION.md`.
- Keep `editor/` a clean subtree with an `upstream` remote. Product changes do not go
  into `apps/editor/crates/ui-egui`.
- If a bridge/API gap forces a patch, it goes in `apps/editor/patches/` as a small,
  documented, upstreamable change; it is never a broad UI edit.
- Run EffectCraft's own gates (`cargo xtask ci`, wasm build, relevant tests) at every
  pin bump.
