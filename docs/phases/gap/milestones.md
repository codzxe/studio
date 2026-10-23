# Milestone Master Checklist -- EffectCraft (Studio) v1 plan

> **SUPERSEDED (W5-08, 2026-10-23):** this checklist was the W-R reader wave's
> pre-landing completion map. Waves W1–W5 have since landed the build —
> milestone evidence now lives in `docs/phases/M0.md`–`M8.md` (+ the
> `m8-cli-spike.md` evidence file), rulings in `docs/DECISIONS.md`, the build
> log in the fleet `worklog.md`. Treat every verdict below as a historical
> snapshot; do not cite it as the current gap list. Kept for the paper trail.


Status: canonical fleet checklist | Compiled by agent W-R6 (reader), 2026-10-22
Sources (read in full): `docs/BUILD_PLAN.md` (841 lines), `docs/PRODUCT_ARCHITECTURE.md`
(905), `docs/EDITOR_CHAT_UX.md` (640), `docs/UI_DESIGN_SYSTEM.md` (743),
`docs/adr/0006-effectcraft-editor-pivot.md`, `docs/README.md` (doc index), root
`README.md`, `CHANGELOG.md`, `docs/AGENTS.md`, plus headers of
`docs/phases/phase-exit-audit.md` and `docs/phases/acceptance-matrix.md`.

Precedence rule (from docs/README.md): the five docs above + ADR 0006 are the plan of
record for the NEW product. `docs/BUILD_PROMPT.md` is superseded where PhotoCraft-specific
(its sections 2, 7-10, 20, 24). Where two new docs disagree, see section 6 (Ambiguity
list) -- the main agent rules; do not guess.

Non-negotiable (BUILD_PLAN header, ADR 0006, PA 6.6, ECUX 1, UI_DS header): EffectCraft's
editor UI is FROZEN. No redesign, reskin, panel/menu/timeline change. Chat is additive.
Any work that edits `editor/crates/ui-egui` for visual reasons fails the milestone.

v1 "done" (BUILD_PLAN 1): landing -> sign up -> workspace -> trial (card) -> dashboard ->
project -> editor loads (unmodified EffectCraft) -> upload assets -> chat "make this title
pop" -> context inspect -> plan card -> preview -> apply (one atomic engine.batch) ->
undo/redo -> version saved -> close/reopen intact -> render/export -> download -> ledger
shows credits. Not done when the editor loads or chat streams; done when the full loop
works for a new user on a clean machine with tenant isolation, credits and recovery.

Repo-state note (observed, not assumed): `editor/` is already vendored with pin
`9db7f3b21700fd821f215782ed1c82afe077880f` (editor/UPSTREAM.md, "studio Wave 0,
2026-10-22"), `.git` exists, and the old PhotoCraft dirs (`vendor/`, `engine-patches/`,
`apps/gateway`, `apps/worker`, `packages/agent|tools|engine-client|evals`) are already
gone from the tree. BUILD_PLAN's status line still says "Implementation not started"
(2026-10-21). M0.1-M0.3 therefore look partially executed; keep them open until the
evidence files required by BUILD_PLAN 13 exist (`docs/phases/M0.md` etc.).

---

## 1. Milestone table

Critical path: M0 -> M1 -> M2 -> M3 -> M4 -> M5 -> M10. M6 beside M3-M5; M7 beside M5;
M8 beside M5-M7; M9 from M1 onward. Private beta 20-24 weeks (full team), public beta
26-30; two-person team: 9-12 months, cut M7/M8. One-week waves, demo + green build each;
two-week hardening after M3/M5/M8/M10; written exit checklist per milestone in
`docs/phases/`; feature flags for M6-M8 so the critical path ships without them.

Task ID scheme below: `<milestone>.<n>` maps 1:1 to the numbered "Tasks:" items in
BUILD_PLAN 3. Total numbered tasks: 74 (M0:7, M1:6, M2:7, M3:8, M4:7, M5:8, M6:6,
M7:6, M8:5, M9:7, M10:7).

### M0 -- Baseline, fork and build (2 weeks; deps: none)

Goal: a clean, reproducible repository that builds the real editor and the SaaS shell.
Remove the old PhotoCraft critical path without losing salvageable work.

| ID | Task (one line, BUILD_PLAN wording compressed) |
|---|---|
| M0.1 | Preserve the current tree before deleting anything: git init, baseline commit, remote, tag `pre-effectcraft-baseline` (zip outside repo if no remote); delete nothing before this. |
| M0.2 | Audit and classify old code: keep/adapt `packages/billing` (ledger/tests), `packages/storage` (validation, S3), `packages/config` (env parsing), selected UI primitives, auth patterns; reference-only `packages/agent`, `packages/tools`, `packages/engine-client`, `apps/worker`; archive `vendor/photocraft`, `engine-patches`, PhotoCraft fixtures, mock coffee demo, static-design templates; delete from active path only after archive tag. |
| M0.3 | Fork EffectCraft into `editor/`: pin exact commit in `editor/UPSTREAM.md`; upstream remote; verify `cargo test --workspace` + native CLI; build web editor (`cargo xtask web`), record wasm size / load time / browser requirements; verify `window.effectcraft` methods (execute, request, inspect, renderFrame, addFile, readFile, saveToBrowser, screenshot); verify `engine.batch` atomicity, `$N` references, rollback, one-undo-step with a real project; record every patch in UPSTREAM.md, zero UI patches. |
| M0.4 | Create target monorepo skeleton: `apps/web`, `services/gateway`, `services/worker`, `packages/ui`, `packages/contracts`, `packages/editor-bridge`, `packages/config`; rebuild a clean Hono gateway rather than repairing `openapi.ts` if cleaner. |
| M0.5 | Local environment without Docker: native Postgres, Valkey, MinIO; LiteLLM in Python venv with one model alias; `.env.example` with every variable + fail-fast startup check; `pnpm dev` starts web + gateway. |
| M0.6 | CI skeleton: web typecheck/lint/unit/build; gateway typecheck/tests/migration check; editor `cargo test`, `cargo clippy`, wasm build at the pin; licence/attribution check. |
| M0.7 | Docs reset: point `docs/AGENTS.md` at BUILD_PLAN + ADR 0006 and mark PhotoCraft sections historical; record pin + attribution in `ATTRIBUTION.md`/`NOTICE`; add `docs/phases/M0.md` with evidence (build logs, wasm size, load time, test results). |

Exit criteria: baseline + EffectCraft pin commits in `git log`; `editor/` builds native +
wasm from clean checkout; editor opens at `/editor/` with COOP/COEP, no console errors;
SaaS shell starts with a health page; one real LiteLLM chat completion succeeds from a
script; old PhotoCraft path archived, not silently half-live; no product code imports
deleted modules. Risks to resolve now: pin the Rust/wasm toolchain; test that
`saveToBrowser` marks the project clean BEFORE building autosave; measure wasm size
before M3.

### M1 -- Auth, workspace and shell (3 weeks; deps: M0)

Goal: a real tenant boundary and a navigable SaaS shell.

| ID | Task |
|---|---|
| M1.1 | Better Auth with Drizzle/Postgres: `organization`, `apiKey`, `admin` plugins; email/password, Google, GitHub; session cookies, CSRF, rate limits; no custom auth tables; roles `owner | admin | editor | viewer` with server-side permission checks. |
| M1.2 | Workspace lifecycle: create, slug availability, switch, invite/accept, remove member, transfer ownership; audit events for invites, role changes, removals, API keys. |
| M1.3 | API foundation: Hono (or Next route handlers) with Zod envelopes, request ids, error mapping; tenant-scoped repository layer (every query filters `workspace_id`); idempotency middleware for mutations. |
| M1.4 | App shell: left rail, top bar, workspace switcher, command palette, toasts, error boundary; route groups `(marketing)`, `(auth)`, `(app)`; middleware protects app routes, unauthenticated -> sign-in with return path. |
| M1.5 | Onboarding: create workspace -> use case (skippable) -> trial start; trial start stubbed until M6 (dev entitlement flag). |
| M1.6 | Tests: auth flows, invite acceptance, role matrix, cross-tenant 404s, API-key scopes; Playwright sign up -> create workspace -> invite -> accept -> role gate. |

Exit: two workspaces cannot see each other's data (API + UI); permissions match the
matrix in PRODUCT_ARCHITECTURE.md; invites work for new and existing users; shell is
keyboard-navigable and responsive at 390/768/1440; no auth logic outside Better Auth.

### M2 -- Projects, assets and versions (3 weeks; deps: M1)

Goal: the data model and storage the editor and agent depend on.

| ID | Task |
|---|---|
| M2.1 | Projects CRUD: name, slug, description, thumbnail, archived; create from blank or import `.ecproj`; duplicate; delete with confirmation and recovery window. |
| M2.2 | Assets: upload (multipart or presigned), MIME sniffing, size/duration/dimension probe, SHA-256 dedupe, signed download URLs, workspace/project scoping; stable virtual paths `/assets/<assetId>/<sanitizedName>`. |
| M2.3 | Versions: immutable snapshot upload with `base_version_id`, SHA-256, size, label, `agent_run_id`; current version pointer; list/restore (restore creates a new version); optimistic concurrency `409 PROJECT_VERSION_CONFLICT`. |
| M2.4 | Lease: acquire/renew/release; 2-minute heartbeat, 5-minute expiry; read-only for others. |
| M2.5 | Storage quotas: per-plan limits; reject over-quota before upload; usage counters. |
| M2.6 | Project hub UI: Overview, Versions, Comments (placeholder), Renders (placeholder), Activity; thumbnail generation stub (real render in M8). |
| M2.7 | Tests: signed URL scope, cross-tenant access, version conflict, restore, lease expiry, duplicate/delete recovery, quota rejection; load a 24 MP asset and a 100 MB video without server-side whole-file buffering. |

Exit: create -> upload asset -> save version -> list -> restore works via API and UI;
stale `base_version_id` returns 409 and never overwrites; a second editor gets read-only;
object keys never leak in API responses; quotas enforced server-side.

### M3 -- Editor host, bridge and autosave (4 weeks; deps: M2)

Goal: the unmodified EffectCraft editor runs inside the product, loads a cloud project and
saves it back.

| ID | Task |
|---|---|
| M3.1 | Editor build pipeline: production wasm build, hashed assets, service worker, COOP/COEP headers; serve at `/editor/`; dev proxy from Next.js, prod Caddy route; `?empty` start, no restore of local browser sessions. |
| M3.2 | `packages/editor-bridge`: typed wrapper around `window.effectcraft`; timeout, retry, error normalisation; same-origin iframe, readiness handshake, version check; event bus for ready/focus/resize/error; no DOM polling. |
| M3.3 | Load sequence: fetch manifest -> register assets by virtual path -> upload `.ecproj` -> open -> restore active comp/playhead/selection; missing-asset placeholders + non-blocking banner. |
| M3.4 | Autosave/versioning: dirty tracking, debounce, `saveToBrowser`/`readFile`, SHA-256, version upload; save on explicit Cmd/Ctrl+S, after agent apply, before close, and every 30s while dirty; conflict UI with compare/restore, never silent overwrite. |
| M3.5 | Editor page chrome: full-bleed iframe; floating project bar (auto-hide), back button, presence, Share, read-only badge; no persistent top nav, no injected CSS, no editor restyle. |
| M3.6 | Keyboard/focus: same-origin listener forwards `Cmd/Ctrl+L/K/I` from iframe to chat; editor keeps its own shortcuts; no global capture that breaks it. |
| M3.7 | Failure handling: unsupported GPU/browser message; wasm load failure with retry; editor crash recovery to last version; unsaved-changes guard. |
| M3.8 | Tests: Playwright open/edit/save/reload, verify composition tree; visual regression: editor screenshot equals upstream (only floating product bar/chat allowed); bridge contract tests with a fake editor. |

Exit: a real project opens, edits, autosaves and reopens with the same comps/layers;
assets resolve after reload, missing assets do not block; autosave creates immutable
versions and handles 409; read-only lease enforced in UI and API; screenshot diff confirms
editor UI unchanged; editor ready p75 < 6s warm cache, < 12s cold on the reference machine.

### M4 -- Chat with read-only agent (3 weeks; deps: M3)

Goal: a chat panel that can inspect the project and answer/propose without mutating.

| ID | Task |
|---|---|
| M4.1 | Chat overlay: floating default, dockable sidebar, collapsed pill, resize/drag/clamp, persisted layout; header, context strip, thread, composer, footer; markdown; virtualized list; streaming caret; stop; reconnect; error banners. |
| M4.2 | AI SDK route: `POST /v1/threads/:id/chat` with UI message stream; persist threads/messages/runs; `Last-Event-ID` replay; model picker backed by plan entitlements (`studio-fast`/`studio-smart`). |
| M4.3 | LiteLLM integration: OpenAI-compatible client; aliases; virtual keys/budgets; fallbacks; usage capture; redact prompts in logs. |
| M4.4 | Context assembly: `ui.inspect`, `project.summary`, `layer.tree` depth 2, `prop.get` for selected props, `render.frame` on demand; context popover; manual attach/detach; token estimates; treat project text as untrusted data. |
| M4.5 | Read tools: `studio.get_context`, `list_layers`, `get_properties`, `plan_edit`, `render_preview`; tool cards with expandable args/results. |
| M4.6 | Safety: no write tools registered yet, the model cannot mutate; prompt-injection tests; tool allowlist; step/time limits. |
| M4.7 | Tests: SSE contract; reconnect; cancel; context limits; tool validation; injection; Playwright open editor -> ask "what's on this comp?" -> receive a correct summary. |

Exit: chat streams inside the editor without touching the editor UI; context chips
accurately reflect what is sent; read-only agent answers questions about open
comp/selection/playhead; no write path exists in the tool registry; chat first token
p75 < 1.5s (excluding provider cold start).

### M5 -- Agent edits: plan, preview, apply, undo (4 weeks; deps: M4)

Goal: the agent changes the project safely, atomically and reversibly.

| ID | Task |
|---|---|
| M5.1 | Write tools: `create_composition`, `create_text`, `set_properties`, `add_effect`, `set_keyframes`, `apply_preset`, `undo_run`, `save_version`; each returns a proposed batch, no direct execution. |
| M5.2 | Plan compiler: model plan -> Zod `EditPlan` -> command batch validation against `command.describe`/JSON Schema; allowlist command ids; max 100 steps, 2 MB, 60s; reject unknown/ambiguous; `$N` reference handling; layer id resolution from names with disambiguation. |
| M5.3 | Plan/preview UI: plan card with risk, affected layers, credit estimate, steps; preview before/after frame at playhead or first affected time; high-risk confirmation; cancel. |
| M5.4 | Apply path: client calls `effectcraft.execute("engine.batch", batch)`; atomic rollback, one undo step; post result + sha256 to gateway; create version; commit credits. |
| M5.5 | Undo/redo: `edit.undo` for the whole run; card state changes; version remains; re-apply only if `base_version_id` matches, otherwise explain. |
| M5.6 | Auto-apply (optional, off by default): only low-risk reversible edits; server-side policy; per-user setting. |
| M5.7 | Agent UX polish: inline edit (Cmd/Ctrl+K), agent mode (Cmd/Ctrl+I), quick actions; diff cards; "View in timeline"; error/clarify cards. |
| M5.8 | Tests: golden prompts against a real project (text animation, color change, effect add, keyframes, multi-layer edit); failure injection (invalid command, mid-batch failure, editor disconnect, version conflict, zero credits -> rollback/no charge); `panic_hunt`-equivalent tool-arg fuzzing (adversarial JSON never crashes gateway or bridge); Playwright prompt -> plan -> preview -> apply -> undo -> redo. |

Exit: at least 10 representative prompts apply successfully on the corpus project; every
applied run is one undo step and one version; a failed step never leaves a partial edit;
the model never receives raw command registry or filesystem paths; high-risk actions
always require confirmation; apply p75 < 300ms for <= 20 steps (excluding preview render).

### M6 -- Billing, credits and entitlements (3 weeks; deps: M1, M2)

Goal: a real paid product with no free tier and correct money paths.

| ID | Task |
|---|---|
| M6.1 | Plans and entitlements: Trial (14 days, card required), Starter, Pro, Studio; seats, models, storage, render minutes, credit allowance; server-side entitlement checks; UI reads entitlements, never hardcodes. |
| M6.2 | Stripe: checkout (subscription + top-up packs), customer portal, webhooks with signature verification and idempotency; trial start, renewal, past due, cancel, grace period; no work deletion. |
| M6.3 | Credit ledger: append-only `credit_ledger`; reserve/commit/refund with idempotency keys; reserve at run start, commit model + render + storage, refund difference/failure; reconciliation job with LiteLLM spend and render usage. |
| M6.4 | UI: billing page (plan, credits, usage, payment, invoices, cancel); low-credit banners, upgrade CTAs, top-up flow, ledger table; chat footer estimate; block runs at zero balance before the model call. |
| M6.5 | Abuse controls: one trial per workspace/customer; card fingerprint; Stripe Radar; rate limits; no trial for disposable domains (configurable). |
| M6.6 | Tests: webhook replay, out-of-order events, reserve/commit/refund, insufficient credits, plan downgrade, seat limits, top-up idempotency; Stripe test clocks for trial/renewal/past due. |

Exit: a new user must add a card to start the trial, no permanent free path; credits
cannot go negative, every entry reconciles; failed/cancelled run refunds fully, successful
run commits actual usage; billing state gates models, seats, storage and renders
server-side; invoices and ledger visible and correct.

### M7 -- Collaboration v1 (3 weeks; deps: M3, M6)

Goal: review and versioning without the complexity of CRDT.

| ID | Task |
|---|---|
| M7.1 | Comments: anchor to project/comp/layer/time; create, reply, resolve; filters; guest comments on share links (name/email, rate-limited). |
| M7.2 | Presence: who is viewing, active comp, playhead; heartbeat; no cursor co-editing. |
| M7.3 | Lease UX: "Alex is editing" banner; request edit; release on close; expiry; read-only mode blocks mutations at the bridge and API. |
| M7.4 | Versions/activity: version timeline; labels; restore with confirmation; diff summary; activity feed with actor/action/target/time; audit export. |
| M7.5 | Share/review page: `/s/:token`: player, frame step, comments, password option, request access; no editor for anonymous users in v1. |
| M7.6 | Tests: lease race (two tabs), expiry takeover, read-only enforcement, comment anchors, share token revocation, guest abuse limits. |

Exit: two users can review the same project, only the lease holder edits; comments survive
reload and link to the right comp/time; restore creates a new version and never rewrites
history; share links are revocable and scoped.

### M8 -- Renders and export (4 weeks; deps: M2, M6, M0)

Goal: produce real, downloadable outputs from the cloud, not just browser previews.

| ID | Task |
|---|---|
| M8.1 | Worker: `effectcraft-cli` runner with confined temp dir and per-job workspace; job queue (Valkey/BullMQ), retries, timeouts, cancellation, concurrency limits; input version object + asset manifest; output MP4/ProRes/PNG sequence/GIF/WAV. |
| M8.2 | Render API/UI: queue from editor ("Render...") and project hub; format, resolution, fps, range, quality; credit estimate; progress; download; render history with status, error, credits, expiry. |
| M8.3 | Preview vs final: browser `render.frame` for fast previews, worker for final outputs; do not block the editor while a render runs. |
| M8.4 | Storage/lifecycle: output bucket keys; signed downloads; retention by plan; cleanup job. |
| M8.5 | Tests: golden render of a known project (hash/frame compare), cancellation, timeout, worker crash recovery, malformed project, missing asset, quota; load test 10 concurrent renders on the reference box. |

Exit: a user can render a project and download a playable file; job survives worker
restart, no duplicate outputs on retry; credits charged only for completed renders (or
documented partial policy); render p75 start < 30s; 1080p 10s comp < 5 min on the
reference box.

### M9 -- Design system, landing and dashboard (4 weeks; parallel from M1)

Goal: replace the current generic UI with the cinematic system in UI_DESIGN_SYSTEM.md.

| ID | Task |
|---|---|
| M9.1 | Tokens and primitives: CSS variables, Tailwind mapping, fonts, buttons, inputs, dialogs, menus, tabs, tables, toasts, badges, skeletons, command palette; Storybook/examples; axe tests; dark-only. |
| M9.2 | Marketing: landing, pricing, FAQ, legal, changelog, status, 404/500; real product demo capture; no fake logos/metrics; performance budget. |
| M9.3 | Auth and onboarding: sign-in/up, invite, reset, verify, workspace creation, trial start. |
| M9.4 | Dashboard and project hub: rail, top bar, project grid, empty/loading/error, versions, activity. |
| M9.5 | Billing/settings: plan, credits, usage, invoices, members, roles, API keys, models, audit, licences. |
| M9.6 | Chat visual pass: align the overlay with the design system without restyling the editor. |
| M9.7 | Visual QA: screenshots at 390/768/1024/1280/1440/1920; 200% zoom; reduced motion; axe; editor screenshot diff vs upstream. |

Exit: every page has empty/loading/error/offline/permission states; no placeholder copy,
fake data or dead links; landing LCP < 2.5s p75 on 4G, CLS < 0.1, INP < 200ms; chat
overlay looks native over the editor, editor UI unchanged; design tokens are the only
source of colour/radius/type.

### M10 -- Hardening, private beta and release (4 weeks; deps: M5, M6, M7, M8, M9)

Goal: prove the loop, secure it, and operate it.

| ID | Task |
|---|---|
| M10.1 | Security review: tenant isolation, IDOR, signed URLs, SSRF, uploads, prompt injection, tool allowlist, command validation, API-key scopes, CSRF, rate limits; dependency/licence audit, no AGPL/SSPL, attribution complete. |
| M10.2 | Reliability: backups + restore drill; queue recovery; editor crash recovery; idempotency; ledger reconciliation; graceful degradation when LiteLLM/provider is down. |
| M10.3 | Performance: run the budgets in BUILD_PLAN 6 on the reference machine; fix regressions; record numbers. |
| M10.4 | E2E and load: full loop on staging with Stripe test clocks; 50 concurrent editor sessions; 10 concurrent renders; 100 chat runs/hour. |
| M10.5 | Observability: traces, metrics, dashboards, alerts for 5xx, queue depth, render failures, credit mismatch, wasm load errors. |
| M10.6 | Docs and support: runbooks (deploy, rollback, restore, provider outage, render stuck, billing dispute); status page; security contact; privacy/terms. |
| M10.7 | Private beta: 10-20 design partners; onboarding calls; instrumentation; weekly triage; gate: no P0/P1 open, crash-free > 99.5%, apply success > 95%, refund/reconcile 100%. |

Exit: full E2E passes on staging and production; restore drill succeeds from backup; no
critical/high security findings open; performance budgets met or explicitly waived with
evidence; rollback to the previous editor pin and previous app release is tested; private
beta cohort completes the loop without manual intervention.

### Private/public beta gates and rollback (BUILD_PLAN 8)

- Private beta gates: M0-M6 and M9 complete; M7 comments/versions complete; M8 at least
  MP4 + PNG; full E2E green on staging 7 consecutive days; no P0/P1; backups + restore
  drill passed; security review closed; support runbook + status page live; 10 design
  partners onboarded with consent.
- Public beta gates: M7/M8 complete and stable 2 weeks; 99.5% crash-free over 14 days;
  credit reconciliation zero variance 14 days; cost per active workspace measured, margin
  positive; load test at 2x expected concurrency; legal (terms, privacy, DPA,
  licences/attribution, trademark).
- Rollback: app = previous image (migrations forward-only, rollback code only if
  schema-compatible); editor = previous pinned wasm artifact (test project from new pin
  first); billing = never roll back ledger rows, compensating adjustments; feature flags
  can independently disable chat writes, auto-apply, renders, collaboration.
- Scope cuts if slipping (in order, never the critical path): auto-apply; guest comments;
  extra render formats (ship MP4 + PNG); templates/marketplace; advanced presence (keep
  lease + comments); public API beyond read-only; native packaging. Never cut: tenant
  isolation, credits, undo, versioning, editor load/save, tests.
- Definition of done for EVERY task (BUILD_PLAN 5, 12 items): works end-to-end; strict
  types, Zod at boundaries; typed error envelopes; success/failure/empty/adversarial
  tests; server-side tenant isolation; idempotency for mutations/credits/webhooks/renders;
  UI empty/loading/error/disabled + keyboard; no leaks of secrets/stack/paths/URLs;
  docs/ADR/devlog updated on decision or number change; typecheck/test/lint/editor
  tests/E2E pass; editor UI untouched unless an approved bridge patch; screenshot for UI
  changes.

---

## 2. Cross-reference index (which doc owns which area)

| Area | Primary | Secondary |
|---|---|---|
| Milestones, estimates, DoD, risks, scope cuts, open decisions, first 10 days | BUILD_PLAN 2-5, 9, 11, 12 | docs/README.md (read order) |
| Pivot rationale, frozen-UI policy, upstream patch policy | adr/0006-effectcraft-editor-pivot.md | BUILD_PLAN header; PA 6.6 |
| Product definition, locked decisions, domain terms, roles matrix | PRODUCT_ARCHITECTURE 1-3 | ECUX 5.4 (system primer); UI_DS 2.1 (naming) |
| Repo shape, build commands, CI jobs | PRODUCT_ARCHITECTURE 4, 4.2, 4.3 | BUILD_PLAN M0.4/M0.6 |
| Runtime architecture, trust boundaries | PRODUCT_ARCHITECTURE 5, 5.1 | -- |
| Editor boundary: serving, bridge API, load sequence, autosave, context bridge | PRODUCT_ARCHITECTURE 6 (6.1-6.6) | ECUX 1-2; UI_DS 8.7; editor/docs/web.md (upstream) |
| SaaS control plane: auth, API surface, envelopes, SSE events | PRODUCT_ARCHITECTURE 7 (7.1-7.4) | ECUX 8.2-8.3 (client side) |
| Agent architecture: stack, model routing, context assembly, tools, engine.batch, EditPlan, apply/undo, credits, failure semantics | PRODUCT_ARCHITECTURE 8 (8.1-8.9) | ECUX 4-7; BUILD_PLAN M4-M5 |
| Data model (Postgres tables, object storage, versions/conflict) | PRODUCT_ARCHITECTURE 9 | BUILD_PLAN M2 |
| Billing, plans, credit rules, Stripe | PRODUCT_ARCHITECTURE 10 | BUILD_PLAN M6; UI_DS 8.8, 7.11 |
| Collaboration (comments, presence, lease) | PRODUCT_ARCHITECTURE 11 | BUILD_PLAN M7; UI_DS 8.6, 8.10 |
| Security, privacy, licensing, brand | PRODUCT_ARCHITECTURE 12 | BUILD_PLAN 7.3, M10.1; UI_DS 2.1 |
| Observability, SLOs | PRODUCT_ARCHITECTURE 13 | BUILD_PLAN M10.5 |
| Deployment, environments | PRODUCT_ARCHITECTURE 14 | BUILD_PLAN 8.1; infra/* |
| M4 chat UX (layout modes, panel anatomy, cursor modes, context model) | EDITOR_CHAT_UX 2-5 | PA 7.4, 8.3 |
| Chat cards, apply/undo/version UX, streaming states, shortcuts, visual language, edge states, copy tone | EDITOR_CHAT_UX 6-13 | UI_DS 9 |
| Design tokens (colour), typography, space/grid, motion | UI_DESIGN_SYSTEM 3, 4, 5, 6 | UI_DS 15 (implementation) |
| Components, iconography, imagery | UI_DESIGN_SYSTEM 7, 10, 11 | UI_DS 9 (chat overlay styling) |
| Page-by-page SaaS design (landing..share/states) | UI_DESIGN_SYSTEM 8 | -- |
| Accessibility, responsive, quality bar, v1 exclusions | UI_DESIGN_SYSTEM 12, 13, 16, 17 | ECUX 9.2, 12 |
| Performance budgets | BUILD_PLAN 6 (canonical) | PA 13.2 (SLOs); ECUX 11 (chat-only) |
| Test strategy, golden prompts, security tests | BUILD_PLAN 7 | per-milestone Tests tasks |
| Release gates, environments, rollback | BUILD_PLAN 8 | PA 14 |
| Evidence per milestone | BUILD_PLAN 13 | docs/phases/<milestone>/ |

Old-product docs that must NOT be used as build input: `docs/BUILD_PROMPT.md`
(PhotoCraft sections), `docs/phases/phase-exit-audit.md` + `acceptance-matrix.md`
(PhotoCraft 19/20 gates vs mock engine), root `README.md`, `docs/AGENTS.md`,
`CHANGELOG.md` (see section 5).

---

## 3. Test strategy (BUILD_PLAN 7, compressed)

Layers (BUILD_PLAN 7.1):

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | Pure logic, schemas, credit math, plan compiler |
| Integration | Vitest + real Postgres/MinIO | Repositories, auth, uploads, versions, webhooks |
| Contract | Zod/OpenAPI + fake bridge | API envelopes, SSE events, editor bridge |
| Rust | cargo test, clippy | Editor engine, command registry, wasm build |
| E2E | Playwright | Full loop, roles, lease, chat apply/undo |
| Visual | Playwright screenshots | Shell pages + editor unchanged |
| Load | k6/autocannon | API, chat, renders, concurrent editors |
| Security | manual + ZAP | Tenancy, IDOR, uploads, prompt injection |
| Evals | LiteLLM/Langfuse | Agent success on a golden prompt set |

Golden agent prompts (BUILD_PLAN 7.2): maintain `evals/prompts/` with at least 30
prompts across 10 categories: (1) create a title comp with text and a background;
(2) animate scale/position/opacity with specific timings; (3) add and tune an effect;
(4) change brand colours across layers; (5) reorganize/rename layers; (6) add a lower
third; (7) create a 3D-ish camera move (within engine support); (8) ambiguous target ->
must clarify; (9) destructive request -> must confirm; (10) impossible request -> must
explain, not hallucinate. Score: plan validity, apply success, visual sanity (frame
compare), undo success, credits accuracy, latency. Targets: >= 90% valid plans, >= 95%
apply success on valid plans.

Security tests (BUILD_PLAN 7.3): cross-tenant reads/writes for every resource; role
escalation via API, UI and agent tools; signed URL expiry/audience and object-key
guessing; upload polyglots, zip bombs, huge dimensions, path traversal, MIME spoofing;
prompt injection in layer names, comments, asset metadata and `.ecproj` text; tool-arg
fuzzing (NaN, Infinity, negative sizes, huge arrays, prototype pollution); webhook
replay/out-of-order and idempotency-key reuse with different payloads; render job escape
(`../`, absolute paths, symlinks, network access); rate limits and denial-of-wallet on
chat/render.

---

## 4. Performance budget (BUILD_PLAN 6 -- canonical, all numbers)

Reference machine: 8-core CPU, 16 GB RAM, integrated GPU or better, Chrome stable,
100 Mbps, unless noted. Measure p75, not best case. If a budget cannot be met, record
the measured number, the cause and an explicit waiver in `docs/performance.md`; never
silently relax.

| Surface | Budget |
|---|---|
| Landing LCP (4G) | < 2.5s |
| Landing INP | < 200ms |
| Landing CLS | < 0.1 |
| Dashboard TTI (warm) | < 2.5s |
| Editor ready (warm cache) | < 6s |
| Editor ready (cold, compressed wasm) | < 12s |
| Editor wasm transfer | < 18 MB compressed (target; record actual) |
| Editor memory (1080p project) | < 1.5 GB |
| Editor playback | 60 fps at 1080p, 20-layer comp (reference project) |
| Chat first token | < 1.5s p75 |
| Context assembly | < 400ms p75 |
| Plan validation | < 100ms p75 |
| Apply (engine.batch, <= 20 steps) | < 300ms p75 |
| Preview frame (720p) | < 2s p75 |
| API read p95 | < 300ms |
| API write p95 | < 600ms |
| Render queue start | < 30s p75 |
| 1080p 10s render | < 5 min on reference box |
| Crash-free sessions | > 99.5% |

Additions in EDITOR_CHAT_UX 11 (chat-only, not in BUILD_PLAN 6): chat open/render
< 100 ms; tool card appears < 50 ms after event; thread scroll 60 fps with 100 messages;
chat UI memory < 80 MB. Plus UI rules: poll `ui.inspect` 4 Hz only while chat open and
visible, 1 Hz idle; previews <= 1280px compressed before sending to the model (see
ambiguity A6: 1200 vs 1280).

Additions in PRODUCT_ARCHITECTURE 13.2 (SLOs): API 5xx rate < 0.5%; editor-ready SLO is
stated at 50 Mbps there vs 100 Mbps in BUILD_PLAN 6 (see ambiguity A9).

---

## 5. Stale-doc debt list (candidate tasks for the build fleet)

All are documentation-only; none touch product code. Suggested owners: DOC fleet agent
(main-agent approval), since M0.7 is the anchor task in BUILD_PLAN. M0.7 as written
covers only `docs/AGENTS.md`, `ATTRIBUTION.md`/`NOTICE` and `docs/phases/M0.md` -- the
items below extend it.

| # | File | What is stale | Must be rewritten | Candidate task |
|---|---|---|---|---|
| D1 | `/README.md` (root) | Entirely PhotoCraft-era: "real layered documents", `.pcraft`, PNG/JPG/PSD export, `vendor/photocraft` shallow clone + ADR-0001 pin `872748fb`, `photocraft-cli`, engine-pool/mock-engine architecture diagram, old phase 0-4 status table, `demo:coffee` quickstart, Docker-Compose quickstart (new plan is native, no Docker), "BUILD_PROMPT.md source of truth" pointer, section-refs to the old spec | Rewrite to the EffectCraft product definition (PA 1), status = pivot accepted / build in waves per BUILD_PLAN, quickstart per PA 14.1 (native Postgres/Valkey/MinIO + LiteLLM venv + `pnpm dev` + `cargo xtask web --serve 8765`), repo map per PA 4, docs pointer to `docs/README.md` read order, licence/attribution per ADR 0006 (MIT OR Apache-2.0, pin, no EffectCraft marks) | DOC-1 (tech lead review) |
| D2 | `docs/AGENTS.md` | Pre-pivot law: authoritative spec = BUILD_PROMPT; engine = `vendor/photocraft` pin 872748fb with `engine-patches/` policy; protocol truth = `vendor/photocraft/docs/control-protocol.md` + `rpc.rs` + `commands.rs`; reference apps `vendor/next-saas-stripe-starter`/`magicui`/`astrowind`; "DO NOT run pnpm install / cargo build" rule (conflicts with M0/M3 which require local wasm builds); section-refs (1.5, 16.1, 16.5, 25); CRAFT_FONTS_DIR; git-sync fleet protocol; Drizzle bits are still valid (keep) | Point at BUILD_PLAN + ADR 0006 as law; mark PhotoCraft sections historical (per M0.7); replace protocol-truth pointers with `editor/` + `window.effectcraft` + `editor/docs/control-protocol.md`; restate the build/CI rule for the new local-build reality; keep git-sync/worklog/ownership/style sections that still apply | DOC-2 (M0.7 proper) |
| D3 | `CHANGELOG.md` | Only `0.1.0-beta.0` (old PhotoCraft product: engine-patches, photocraft-serve, mock engine, template tools, demo:coffee). No entry for the pivot; no 0.2.0/Unreleased section | Add an `Unreleased`/`0.2.0` entry: pivot to EffectCraft per ADR 0006, archive/removal of the PhotoCraft path, `editor/` fork + pin `9db7f3b2`, new monorepo skeleton, link to BUILD_PLAN milestones; keep 0.1.0 as history | DOC-3 |
| D4 | `docs/BUILD_PROMPT.md` | Header still says "source of truth ... on top of the PhotoCraft editor"; no supersession banner (only docs/README.md says its sections are superseded) | Add a prominent banner: superseded by ADR 0006 + BUILD_PLAN for sections 2, 7-10, 20, 24; principles in 1, 3, 5, 11-19, 25 remain baseline where not contradicted (per ADR 0006 "Supersedes") | DOC-4 |
| D5 | `docs/phases/phase-exit-audit.md`, `docs/phases/acceptance-matrix.md` | Confirmed OLD product: S19/S20 PhotoCraft gates, `photocraft-cli`, `.pcraft`, mock-engine evidence, 0.1.0-beta.0 waves W0-W10. Not valid for the new plan | Mark clearly as archived/legacy at the top (or move to `docs/phases/legacy/`); start the new per-milestone exit checklists `docs/phases/M0.md`..`M10.md` required by BUILD_PLAN 2.3/13 | DOC-5 |
| D6 | `docs/devlog.md` | Header cites the old S19 phase gate | Re-point header at BUILD_PLAN milestone waves; keep append-only entries | DOC-6 (minor) |
| D7 | `docs/adr/0001..0005` | 0001 (PhotoCraft editor pin) is historical per docs/README; 0002-0005 (env, auth, queue, observability) never re-ratified for the new product | Main agent to confirm which ADRs carry over unchanged (0003 Better Auth and 0004 Valkey/BullMQ look compatible with PA 7.1/8.1); add "superseded/amended by 0006" notes where needed | DOC-7 (ruling + notes) |
| D8 | BUILD_PLAN status line | Says "Implementation not started (2026-10-21)" while the tree already contains the `editor/` fork (Wave 0, 2026-10-22) | Update status or record executed M0 work in `docs/phases/M0.md` evidence so the checklist and reality agree | DOC-8 |

---

## 6. Ambiguity list (BUILD_PLAN vs PRODUCT_ARCHITECTURE / EDITOR_CHAT_UX / UI_DESIGN_SYSTEM)

Builders: implement the "suggested default" only if the main agent has not ruled;
otherwise pause and ask. Ordered by consequence.

| ID | Conflict / two readings | Section pair | Suggested default |
|---|---|---|---|
| A1 | Step limits disagree. BP M5.2: plan compiler "max 100 steps, 2 MB, 60s". PA 8.6 EditPlan: `steps` max 20, each step's `batch.steps` max 100 (i.e. up to 2000 commands). PA 8.5: engine.batch "Bounded: max 100 steps". ECUX 4.3: "up to 8 model steps and 100 command steps". Which caps does the server enforce per run: 100 total commands, or 20 plan steps x 100? And is the 8-model-step cap authoritative anywhere besides ECUX? | BP M5.2 vs PA 8.5/8.6 vs ECUX 4.3 | Enforce all three as layered caps: EditPlan <= 20 steps (PA 8.6 schema is the contract), each batch <= 100 commands / 2 MB / 60s (PA 8.5), model steps <= 8 (ECUX 4.3); plan compiler rejects earlier of these |
| A2 | Render format scope. BP M8.1 lists outputs "MP4/ProRes/PNG sequence/GIF/WAV", but BP 12 open decision defaults "MP4 (H.264) + PNG sequence" and BP 9 scope cut #3 says "ship MP4 + PNG". Build five formats or two? | BP M8.1 vs BP 12 + BP 9 | Build the worker format-agnostic, ship MP4 + PNG only for v1 (12 + 9 win); ProRes/GIF/WAV are post-beta |
| A3 | Gateway shape. BP M1.3: "Hono (or Next route handlers)"; PA 4/7: a `services/gateway` Hono TS API is the architecture. Where does /v1 live? | BP M1.3 vs PA 4/7 | Hono in `services/gateway` (PA is authoritative for architecture; BP's parenthetical is the fallback if the service split fails) |
| A4 | Autosave cadence. BP M3.4: save "every 30s while dirty"; PA 6.4: "every N seconds of dirty editing" (N unspecified). | BP M3.4 vs PA 6.4 | 30s (BP is the execution plan; expose as config) |
| A5 | Cmd/Ctrl+K collision on the editor route. ECUX 4.2/9.1: inline edit on selection. UI_DS 7.10: command palette is Cmd/Ctrl+K "in the SaaS shell (not while the editor iframe has focus)". With the parent page focused on `/w/projects/:id/edit`, both claim K. | ECUX 4.2/9.1 vs UI_DS 7.10 | On the editor route Cmd/Ctrl+K = inline edit (ECUX wins on the editor page); palette binding active only on shell routes / when the editor iframe is not mounted |
| A6 | Preview frame size. PA 8.3 + ECUX 5.1: `render.frame` at 1200 px max side; ECUX 11 rules: "Render previews at <= 1280px". | PA 8.3 / ECUX 5.1 vs ECUX 11 | 1200 px max side (stated twice vs once) |
| A7 | Trial: plan or state? PA 10.1 lists Trial as a plan row (100 credits, fast model); UI_DS 14: "trial is a state, not a plan"; BP M6.1 lists Trial under "Plans and entitlements". Affects billing schema, pricing page copy and plan-gating logic. | PA 10.1 vs UI_DS 14 + BP M6.1 | Trial = entitlement state on the workspace (UI_DS), with the PA row used only for the entitlement values (100 credits, fast model, 14 days, card required) |
| A8 | Is `studio-vision` in v1? PA 8.2 defines it (plan-gated, metered separately) and UI_DS 8.9 settings expose "allow smart/vision", but BP M4.2/M6.1 only mention `studio-fast`/`studio-smart` and the Studio plan row in PA 10.1 includes vision. | PA 8.2 + UI_DS 8.9 vs BP M4.2/M6.1 | Include the alias in LiteLLM config at M4 but keep UI exposure behind the Studio plan entitlement; ship vision-dependent features only if M4/M6 time allows |
| A9 | Editor-ready network condition. BP 6 reference machine: 100 Mbps; PA 13.2 SLO: "Editor ready (p75, 50 Mbps, warm cache) < 6 s". Same target, different link speed changes the effective wasm-download budget. | BP 6 vs PA 13.2 | Measure and record at both; treat PA 13.2 (50 Mbps) as the gate since it is the harsher one |
| A10 | Golden prompt volume/artifacts. BP 7.2: maintain >= 30 prompts in `evals/prompts/`; BP M5 exit: "at least 10 representative prompts apply successfully on the corpus project". Two numbers, two locations (`evals/prompts/` vs "corpus project"). | BP 7.2 vs BP M5 exit | 10 = M5 exit gate on the fixed corpus project; 30 = the maintained eval corpus, growing through M5-M10 |
| A11 | M9 dependencies understated. BP 2.2: M9 depends on M1 only, yet M9.2 needs real demo capture (M3/M5 features) and M9.5 needs M6 billing routes. Sequencing risk if M9 is scheduled from M1 literally. | BP 2.2 vs BP M9.2/M9.5 | Treat M9.1/M9.3/M9.4 as M1-parallel; gate M9.2 capture and M9.5 pages on M3/M5/M6 respectively |
| A12 | Upload mechanism left open: "multipart or presigned" in both BP M2.2 and PA 9.1 version upload ("bytes (multipart or presigned upload)"). | BP M2.2 + PA 9.1 | Decide once in M2: presigned for large media, multipart for small files; record as ADR |
| A13 | localStorage key `studio.chat.layout.v1` hardcodes the codename despite the brand-token rule ("token swap in packages/config/brand.ts; no component hardcodes it"). | ECUX 2.5 vs UI_DS 2.1 | Derive the key prefix from the brand token; migration shim for existing users |
| A14 | Inline-edit cap: ECUX 4.2 says inline edit returns "a focused batch (<= 5 steps)", but PA 8.6 EditPlan allows up to 20 steps and BP M5 exit benchmarks <= 20 steps. Where is 5 enforced? | ECUX 4.2 vs PA 8.6 | Enforce <= 5 as a client-side prompt/policy constraint for inline mode (server still validates against 20) |
| A15 | ADR 0002-0005 applicability to the new product is unstated (only 0001 is marked historical). | docs/README "Legacy docs" vs docs/adr/0002-0005 | Carry over 0002/0003/0004/0005 with a short "reaffirmed for EffectCraft pivot" note each (DOC-7) |
| A16 | BP status says "Implementation not started" but `editor/` fork + pin already exist (2026-10-22). Which M0 items count as done is undefined until `docs/phases/M0.md` evidence lands. | BP status line vs repo state | Treat M0.1-M0.3 as provisionally done pending evidence; fleet writes docs/phases/M0.md before starting M0.4+ |

---

## 7. Totals

74 numbered milestone tasks (M0.1-M10.7). 11 milestones. 3 test-strategy layers blocks
(9 test layers, 10 golden-prompt categories, 9 security-test items). 19 canonical
performance budgets + 4 chat-only + 1 SLO-only. 8 stale-doc debt items. 16 flagged
ambiguities. End.
