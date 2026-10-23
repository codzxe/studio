# Studio product documentation

Status: **accepted direction, in execution** · 2026-10-24 · M0–M9 landed —
per-milestone evidence in [`phases/`](phases/) (`M0.md`–`M8.md`; M9's evidence
file still owed) — M10 (hardening, private beta, release) open. See
[`BUILD_PLAN.md`](BUILD_PLAN.md).

Studio is a multi-tenant, agentic **motion-graphics SaaS** built on the open-source
**EffectCraft** engine and editor. The editor UI is used as-is. The product adds cloud
projects, auth, workspaces, credits, billing, versions, comments, renders and a
Cursor-style chat layer.

## Read in this order

| Doc | What it answers |
|---|---|
| [`PRODUCT_ARCHITECTURE.md`](PRODUCT_ARCHITECTURE.md) | Repo layout, runtime, editor boundary, APIs, data model, agent loop, billing, security, deployment |
| [`EDITOR_CHAT_UX.md`](EDITOR_CHAT_UX.md) | Floating/sidebar chat, Cursor modes, context, tool cards, preview/apply/undo, states, shortcuts |
| [`UI_DESIGN_SYSTEM.md`](UI_DESIGN_SYSTEM.md) | Brand direction, tokens, typography, components, page-by-page **SaaS** redesign, quality bar |
| [`BUILD_PLAN.md`](BUILD_PLAN.md) | The full loop in milestones, acceptance criteria, estimates, risks, post-v1 refinements |
| [`adr/0006-effectcraft-editor-pivot.md`](adr/0006-effectcraft-editor-pivot.md) | Why the editor changed from PhotoCraft to EffectCraft, and what is frozen |

## Hard rules

1. **EffectCraft's editor UI is frozen.** No redesign of its panels, menus, timeline,
   toolbar, theme, density or interaction model. The chat is additive.
2. **The editor is Rust.** The SaaS control plane is TypeScript. Do not rewrite the
   editor in React.
3. **The model never sees raw engine commands.** The model sees curated Studio tools;
   the server compiles them to validated `engine.batch` payloads.
4. **Every agent edit is one atomic batch and one undo step.** A failed step rolls the
   whole run back.
5. **No free plan.** Subscription + credits, 14-day trial with card, platform model
   keys only in v1.
6. **Better Auth only.** No custom auth tables or session logic.
7. **No EffectCraft/ArtCraft branding in the commercial product.** Keep upstream
   licences and attribution.
8. **No CRDT in v1.** Comments, presence, versions and a single-writer lease only.

## Legacy docs

`BUILD_PROMPT.md` still contains the original PhotoCraft/static-design plan. Its
PhotoCraft-specific editor sections are superseded by ADR 0006 and the docs above.
`docs/adr/0001-editor-pin.md` is historical. `docs/phases/phase-exit-audit.md` and
`docs/phases/acceptance-matrix.md` are the pre-pivot PhotoCraft era's exit-audit
docs — kept for the audit trail and marked **historical** at the top; nothing in
them describes the current product (current milestone evidence lives in
`docs/phases/M0.md`–`M8.md`). New work starts from this folder, not from the
old vendor pin.

## Codename

`Studio` is the internal codename only. The user-facing name is a brand decision and a
token swap; nothing in the architecture should depend on it.
