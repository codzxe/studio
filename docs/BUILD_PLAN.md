# Studio Build Plan

Status: **in execution — M0–M9 landed, M10 (hardening, private beta, release) open** · 2026-10-24 · Waves W0–W3 + W4-ed (real de-branded editor dist vendored + committed, M0 evidence) + W5 (single-repo policy, fork removed) + **M3 landed** (bridge hardened 70/70 tests, editor-session engine, /w/[slug]/editor host page + autosave wiring, 97/97 web suite — evidence: docs/phases/M3.md) + **M4 landed** (read-only agent chat end-to-end: LiteLLM runner behind the real wire, 5 read tools with client-side executor + server-side plan_edit, full chat UI overlay, entitlements, injection-proofed — 1090 tests repo-wide; evidence: docs/phases/M4.md) + **M5 landed** (agent edits: 8 write tools propose-only, server-side plan compiler over a 37-command proven registry, plan card + preview + ONE atomic engine.batch apply → ONE version → µc commit, undo/reapply-gated, injection corpus, auto-apply policy per D-22 — evidence: docs/phases/M5.md) + **M6 landed** (billing/credits/entitlements: plan catalog, Stripe seam + durable-idempotent webhooks + guarded lifecycle, µc ledger with reconciliation, billing page + kit + chat gating, abuse controls, all exit criteria journey-proven — evidence: docs/phases/M6.md) + **M7 landed** (collaboration v1: comments/replies/guest, presence heartbeat, lease queue/election/read-only enforcement per D-23, §9.3 restore + activity + audit export, public share/review page, collab E2E 26 journeys — evidence: docs/phases/M7.md) + **M8 landed** (renders and export: Postgres-backed queue per D-25, the real effectcraft-cli worker with spike-proven hydration (docs/phases/m8-cli-spike.md), render API v2 with the entitlement ladder + µc reserve/settle per D-26, D-11 status flip per D-27, editor Render dialog + hub renders panel, retention + requeue sweeps, every exit criterion journey-proven (render-e2e 9 + worker CLI-gated 7; 1080p 10s comp in 59s on the reference box) — evidence: docs/phases/M8.md) + **M1/M2 evidence files added 2026-10-24** (docs/phases/M1.md — auth/workspace/shell; docs/phases/M2.md — projects/assets/versions; both authored from in-repo evidence with suites re-run and honest gaps sections) + **M9 landed** (design tokens + UI kit, marketing pages with real editor captures, auth/onboarding, dashboard + project hub + settings suite, chat visual pass, e2e m9-visual/m9-axe specs — evidence file docs/phases/M9.md still OWED; QA tails: no CI, so visual/axe suites never ran; field LCP/INP/CLS unmeasured) + **M10 is the open milestone** (no .github/workflows/ at all; perf budgets largely unmeasured; load/security/backup/rollback drills not run; private beta not started — see docs/phases/gap/ + worklog W1-A7's TOP-20) · completion map: docs/phases/gap/ · rulings: docs/DECISIONS.md

This is the execution plan for the EffectCraft-based product. It replaces the
PhotoCraft-specific phases in `docs/BUILD_PROMPT.md` §2, §7–§10, §20 and §24. The
architecture is in [`PRODUCT_ARCHITECTURE.md`](PRODUCT_ARCHITECTURE.md), the editor/chat
UX in [`EDITOR_CHAT_UX.md`](EDITOR_CHAT_UX.md), and the visual system in
[`UI_DESIGN_SYSTEM.md`](UI_DESIGN_SYSTEM.md).

> **Non-negotiable:** EffectCraft's editor UI is frozen. No milestone may include a
> redesign, reskin, panel change, menu change or timeline change. The chat is additive.
> Any work that edits `editor/crates/ui-egui` for visual reasons fails the milestone.

---

## 1. What “done” means

The v1 loop:

```text
landing → sign up → create workspace → start trial (card) → dashboard
  → create/open project → editor loads (unmodified EffectCraft)
  → upload/import assets → chat: “make this title pop”
  → agent inspects context → plan card → preview
  → apply (one atomic engine.batch) → undo/redo
  → version saved → close/reopen intact
  → render/export → download
  → billing ledger shows credits used
```

v1 is **not** done when the editor loads or the chat streams. It is done when the loop
above works for a new user, on a clean machine, with tenant isolation, credits and
recovery.

---

## 2. Team, estimates and sequencing

### 2.1 Assumed team

| Role | Allocation | Owns |
|---|---|---|
| Tech lead / full-stack TS | 1.0 | Gateway, architecture, integrations, reviews |
| Full-stack TS | 1.0 | Projects, assets, versions, billing, collaboration |
| Frontend / design engineer | 1.0 | Design system, marketing, dashboard, chat overlay |
| Rust / editor integration | 0.75–1.0 | EffectCraft pin, wasm build, bridge, worker CLI, upstream patches |
| Product design | 0.5 | UX flows, visual QA, marketing art direction |
| DevOps / QA | 0.25–0.5 | CI, environments, backups, E2E, load tests |

Estimates assume this team. **A solo build is roughly 2.5–3× the calendar time.** Do not
compress the editor, billing or security milestones; compress scope instead.

### 2.2 Estimate summary

| Milestone | Duration | Depends on |
|---|---:|---|
| M0 — Baseline, fork and build | 2 weeks | — |
| M1 — Auth, workspace and shell | 3 weeks | M0 |
| M2 — Projects, assets and versions | 3 weeks | M1 |
| M3 — Editor host, bridge and autosave | 4 weeks | M2 |
| M4 — Chat with read-only agent | 3 weeks | M3 |
| M5 — Agent edits: plan, preview, apply, undo | 4 weeks | M4 |
| M6 — Billing, credits and entitlements | 3 weeks | M1, M2 |
| M7 — Collaboration v1 | 3 weeks | M3, M6 |
| M8 — Renders and export | 4 weeks | M2, M6, M0 |
| M9 — Design system, landing and dashboard | 4 weeks | M1 (parallel) |
| M10 — Hardening, private beta, release | 4 weeks | M5, M6, M7, M8, M9 |

Critical path: **M0 → M1 → M2 → M3 → M4 → M5 → M10**. M6 can run beside M3–M5; M7 beside
M5; M8 beside M5–M7; M9 from M1 onward.

**Calendar target:** private beta in **20–24 weeks** with the team above; public beta
in **26–30 weeks**. If the team is two people, plan for **9–12 months** and cut M7/M8
from the first release.

### 2.3 Delivery cadence

- One-week waves; each wave ends with a demo and a green build.
- Two-week hardening at the end of M3, M5, M8 and M10.
- Every milestone has a written exit checklist in `docs/phases/`.
- No milestone is “done” with failing tests or a manual-only path.
- Feature flags for M6–M8 so the critical path can ship without waiting for billing or
  renders.

---

## 3. Milestones

### M0 — Baseline, fork and build (2 weeks)

**Goal:** a clean, reproducible repository that builds the real editor and the SaaS
shell. Remove the old PhotoCraft critical path without losing salvageable work.

Tasks:

1. **Preserve the current tree before deleting anything.** `studio-main` is not a git
   repository. Initialise git, commit the baseline, add a remote, and tag
   `pre-effectcraft-baseline`. If a remote is not available, create a zip outside the
   repo. Do not delete code until this is done.
2. **Audit and classify the old code.**
   - Keep/adapt: `packages/billing` (ledger/tests), `packages/storage` (validation,
     S3), `packages/config` (env parsing), selected UI primitives, auth patterns.
   - Reference only: `packages/agent`, `packages/tools`, `packages/engine-client`,
     `apps/worker` — built around PhotoCraft and not reusable as-is.
   - Archive: `vendor/photocraft`, `engine-patches`, PhotoCraft fixtures, the mock
     coffee demo, static-design templates.
   - Delete from the active path only after the archive tag exists.
3. **Fork EffectCraft into `editor/`.**
   - Pin an exact commit in `editor/UPSTREAM.md`.
   - Add the upstream remote; verify `cargo test --workspace` and the native CLI build.
   - Build the web editor (`cargo xtask web`) and record wasm size, load time and
     browser requirements.
   - Verify `window.effectcraft` methods needed by the bridge:
     `execute`, `request`, `inspect`, `renderFrame`, `addFile`, `readFile`,
     `saveToBrowser`, `screenshot`.
   - Verify `engine.batch` atomicity, `$N` references, rollback and one-undo-step
     behavior with a real project.
   - Record every build/integration patch in `editor/UPSTREAM.md`; there should be
     zero UI patches.
4. **Create the target monorepo skeleton.**
   - `apps/web`, `services/gateway`, `services/worker`, `packages/ui`,
     `packages/contracts`, `packages/editor-bridge`, `packages/config`.
   - If a new Hono gateway is cleaner than repairing `openapi.ts`, rebuild it and copy
     route logic deliberately. Do not spend a week fixing a scaffold that has never
     booted.
5. **Local environment without Docker.**
   - Postgres, Valkey, MinIO native installs or services.
   - LiteLLM in a Python venv; one model alias working.
   - `.env.example` with every variable and a startup check that fails fast on missing
     secrets.
   - `pnpm dev` starts web + gateway; editor is a second terminal or proxied build.
6. **CI skeleton.**
   - Web: typecheck, lint, unit tests, build.
   - Gateway: typecheck, tests, migration check.
   - Editor: `cargo test`, `cargo clippy`, wasm build at the pin.
   - Licence/attribution check.
7. **Docs reset.**
   - Point `docs/AGENTS.md` at this plan and ADR 0006; mark the PhotoCraft sections
     historical.
   - Record the pin and attribution in `ATTRIBUTION.md`/`NOTICE`.
   - Add `docs/phases/M0.md` with evidence: build logs, wasm size, load time, test
     results.

**Exit criteria**

- `git log` has a baseline commit and an EffectCraft pin commit.
- `editor/` builds native + wasm from a clean checkout.
- The editor opens at `/editor/` with COOP/COEP and no console errors.
- The SaaS shell starts with a health page.
- One real LiteLLM chat completion succeeds from a script.
- The old PhotoCraft path is archived, not silently half-live.
- No product code imports deleted modules.

**Risks to resolve now**

- EffectCraft's web build may require a specific Rust/wasm toolchain; pin it.
- `saveToBrowser` may not mark the project clean; test and record before autosave.
- The wasm bundle may be too large for the target hosting; measure before M3.

---

### M1 — Auth, workspace and shell (3 weeks)

**Goal:** a real tenant boundary and a navigable SaaS shell.

Tasks:

1. **Better Auth** with Drizzle/Postgres.
   - `organization`, `apiKey`, `admin` plugins; email/password, Google, GitHub.
   - Session cookies, CSRF, rate limits; no custom auth tables.
   - Roles: `owner | admin | editor | viewer`; server-side permission checks.
2. **Workspace lifecycle.**
   - Create workspace, slug availability, switch workspace, invite/accept, remove
     member, transfer ownership.
   - Audit events for invites, role changes, removals and API keys.
3. **API foundation.**
   - Hono (or Next route handlers) with Zod envelopes, request ids, error mapping.
   - Tenant-scoped repository layer; every query filters `workspace_id`.
   - Idempotency middleware for mutations.
4. **App shell.**
   - Left rail, top bar, workspace switcher, command palette, toasts, error boundary.
   - Route groups: `(marketing)`, `(auth)`, `(app)`.
   - Middleware protects app routes; unauthenticated → sign-in with return path.
5. **Onboarding.**
   - Create workspace → use case (skippable) → trial start.
   - Trial start is stubbed until M6; use a dev entitlement flag.
6. **Tests.**
   - Auth flows, invite acceptance, role matrix, cross-tenant 404s, API-key scopes.
   - Playwright: sign up → create workspace → invite → accept → role gate.

**Exit criteria**

- Two workspaces cannot see each other’s data, tested at API and UI level.
- Owner/admin/editor/viewer permissions match the matrix in
  `PRODUCT_ARCHITECTURE.md`.
- Invites work for new and existing users.
- Shell is keyboard-navigable and responsive at 390/768/1440.
- No auth logic outside Better Auth.

---

### M2 — Projects, assets and versions (3 weeks)

**Goal:** the data model and storage that the editor and agent depend on.

Tasks:

1. **Projects CRUD.**
   - Name, slug, description, thumbnail, archived; create from blank or import
     `.ecproj`; duplicate; delete with confirmation and recovery window.
2. **Assets.**
   - Upload (multipart or presigned), MIME sniffing, size/duration/dimension probe,
     SHA-256 dedupe, signed download URLs, workspace/project scoping.
   - Stable virtual paths: `/assets/<assetId>/<sanitizedName>`.
3. **Versions.**
   - Immutable snapshot upload with `base_version_id`, SHA-256, size, label,
     `agent_run_id`; current version pointer; list/restore (restore creates a new
     version).
   - Optimistic concurrency: `409 PROJECT_VERSION_CONFLICT`.
4. **Lease.**
   - Acquire/renew/release; 2-minute heartbeat, 5-minute expiry; read-only for others.
5. **Storage quotas.**
   - Per-plan limits; reject over-quota before upload; usage counters.
6. **Project hub UI.**
   - Overview, Versions, Comments (placeholder), Renders (placeholder), Activity.
   - Thumbnail generation stub (real render in M8).
7. **Tests.**
   - Signed URL scope, cross-tenant access, version conflict, restore, lease expiry,
     duplicate/delete recovery, quota rejection.
   - Load a 24 MP asset and a 100 MB video without buffering the whole file in memory
     on the server.

**Exit criteria**

- Create → upload asset → save version → list → restore works via API and UI.
- A stale `base_version_id` returns 409 and never overwrites.
- A second editor gets read-only and cannot mutate.
- Object keys never leak in API responses.
- Quotas enforced server-side.

---

### M3 — Editor host, bridge and autosave (4 weeks)

**Goal:** the unmodified EffectCraft editor runs inside the product, loads a cloud
project and saves it back.

Tasks:

1. **Editor build pipeline.**
   - Production wasm build, hashed assets, service worker, COOP/COEP headers.
   - Serve at `/editor/`; dev proxy from Next.js; prod Caddy route.
   - `?empty` start; no restore of local browser sessions.
2. **`packages/editor-bridge`.**
   - Typed wrapper around `window.effectcraft`; timeout, retry, error normalisation.
   - Same-origin iframe; readiness handshake; version check.
   - Event bus for ready/focus/resize/error; no polling of the DOM.
3. **Load sequence.**
   - Fetch manifest → register assets by virtual path → upload `.ecproj` → open →
     restore active comp/playhead/selection.
   - Missing asset placeholders + non-blocking banner.
4. **Autosave/versioning.**
   - Dirty tracking, debounce, `saveToBrowser`/`readFile`, SHA-256, version upload.
   - Save on explicit `Cmd/Ctrl+S`, after agent apply, before close, and every 30s
     while dirty.
   - Conflict UI with compare/restore; never silent overwrite.
5. **Editor page chrome.**
   - Full-bleed iframe; floating project bar (auto-hide), back button, presence,
     Share, read-only badge.
   - No persistent top nav, no injected CSS, no editor restyle.
6. **Keyboard/focus.**
   - Same-origin listener forwards `Cmd/Ctrl+L/K/I` from the iframe to the chat.
   - Editor keeps its own shortcuts; no global capture that breaks it.
7. **Failure handling.**
   - Unsupported GPU/browser message; wasm load failure with retry; editor crash
     recovery to last version; unsaved-changes guard.
8. **Tests.**
   - Playwright: open project, edit, save, reload, verify composition tree.
   - Visual regression: editor screenshot equals upstream (allowing only the floating
     product bar/chat).
   - Bridge contract tests with a fake editor.

**Exit criteria**

- A real project opens, edits, autosaves and reopens with the same comps/layers.
- Assets resolve after reload; missing assets do not block the project.
- Autosave creates immutable versions and handles 409.
- Read-only lease is enforced in the UI and API.
- Screenshot diff confirms EffectCraft's editor UI is unchanged.
- Editor ready p75 < 6s warm cache, < 12s cold on the reference machine.

---

### M4 — Chat with read-only agent (3 weeks)

**Goal:** a chat panel that can inspect the project and answer/propose without mutating.

Tasks:

1. **Chat overlay.**
   - Floating default, dockable sidebar, collapsed pill, resize/drag/clamp,
     persisted layout.
   - Header, context strip, thread, composer, footer; markdown; virtualized list.
   - Streaming caret; stop; reconnect; error banners.
2. **AI SDK route.**
   - `POST /v1/threads/:id/chat` with UI message stream.
   - Persist threads/messages/runs; `Last-Event-ID` replay.
   - Model picker backed by plan entitlements; `studio-fast`/`studio-smart`.
3. **LiteLLM integration.**
   - OpenAI-compatible client; aliases; virtual keys/budgets; fallbacks.
   - Usage capture; redact prompts in logs.
4. **Context assembly.**
   - `ui.inspect`, `project.summary`, `layer.tree` depth 2, `prop.get` for selected
     props, `render.frame` on demand.
   - Context popover; manual attach/detach; token estimates.
   - Treat project text as untrusted data.
5. **Read tools.**
   - `studio.get_context`, `list_layers`, `get_properties`, `plan_edit`,
     `render_preview`.
   - Tool cards with expandable args/results.
6. **Safety.**
   - No write tools registered yet; the model cannot mutate.
   - Prompt-injection tests; tool allowlist; step/time limits.
7. **Tests.**
   - SSE contract; reconnect; cancel; context limits; tool validation; injection.
   - Playwright: open editor → ask “what’s on this comp?” → receive a correct summary.

**Exit criteria**

- Chat streams inside the editor without touching the editor UI.
- Context chips accurately reflect what is sent.
- Read-only agent answers questions about the open comp/selection/playhead.
- No write path exists in the tool registry.
- Chat first token p75 < 1.5s (excluding provider cold start).

---

### M5 — Agent edits: plan, preview, apply, undo (4 weeks)

**Goal:** the agent changes the project safely, atomically and reversibly.

Tasks:

1. **Write tools.**
   - `create_composition`, `create_text`, `set_properties`, `add_effect`,
     `set_keyframes`, `apply_preset`, `undo_run`, `save_version`.
   - Each returns a proposed batch; no direct execution.
2. **Plan compiler.**
   - Model plan → Zod `EditPlan` → command batch validation against
     `command.describe`/JSON Schema.
   - Allowlist command ids; max 100 steps, 2 MB, 60s; reject unknown/ambiguous.
   - `$N` reference handling; layer id resolution from names with disambiguation.
3. **Plan/preview UI.**
   - Plan card with risk, affected layers, credit estimate, steps.
   - Preview before/after frame at playhead or first affected time.
   - High-risk confirmation; cancel.
4. **Apply path.**
   - Client calls `effectcraft.execute("engine.batch", batch)`.
   - Atomic rollback; one undo step.
   - Post result + sha256 to gateway; create version; commit credits.
5. **Undo/redo.**
   - `edit.undo` for the whole run; card state changes; version remains.
   - Re-apply only if `base_version_id` matches; otherwise explain.
6. **Auto-apply (optional, off by default).**
   - Only low-risk, reversible edits; server-side policy; per-user setting.
7. **Agent UX polish.**
   - Inline edit (`Cmd/Ctrl+K`), agent mode (`Cmd/Ctrl+I`), quick actions.
   - Diff cards; “View in timeline”; error/clarify cards.
8. **Tests.**
   - Golden prompts against a real project: text animation, color change, effect add,
     keyframes, multi-layer edit.
   - Failure injection: invalid command, mid-batch failure, editor disconnect,
     version conflict, zero credits → rollback/no charge.
   - `panic_hunt` equivalent for tool args: adversarial JSON never crashes gateway or
     editor bridge.
   - Playwright: prompt → plan → preview → apply → undo → redo.

**Exit criteria**

- At least 10 representative prompts apply successfully on the corpus project.
- Every applied run is one undo step and one version.
- A failed step never leaves a partial edit.
- The model never receives raw command registry or filesystem paths.
- High-risk actions always require confirmation.
- Apply p75 < 300ms for ≤ 20 steps (excluding preview render).

---

### M6 — Billing, credits and entitlements (3 weeks)

**Goal:** a real paid product with no free tier and correct money paths.

Tasks:

1. **Plans and entitlements.**
   - Trial (14 days, card required), Starter, Pro, Studio; seats, models, storage,
     render minutes, credit allowance.
   - Server-side entitlement checks; UI reads entitlements, never hardcodes.
2. **Stripe.**
   - Checkout (subscription + top-up packs), customer portal, webhooks with signature
     verification and idempotency.
   - Trial start, renewal, past due, cancel, grace period; no work deletion.
3. **Credit ledger.**
   - Append-only `credit_ledger`; reserve/commit/refund; idempotency keys.
   - Reserve at run start; commit model + render + storage; refund difference/failure.
   - Reconciliation job with LiteLLM spend and render usage.
4. **UI.**
   - Billing page: plan, credits, usage, payment, invoices, cancel.
   - Low-credit banners; upgrade CTAs; top-up flow; ledger table.
   - Chat footer estimate; block runs at zero balance before the model call.
5. **Abuse controls.**
   - One trial per workspace/customer; card fingerprint; Stripe Radar; rate limits;
     no trial for disposable domains (configurable).
6. **Tests.**
   - Webhook replay, out-of-order events, reserve/commit/refund, insufficient credits,
     plan downgrade, seat limits, top-up idempotency.
   - Stripe test clocks for trial/renewal/past due.

**Exit criteria**

- A new user must add a card to start the trial; no permanent free path.
- Credits cannot go negative; every entry reconciles.
- A failed/cancelled run refunds fully; a successful run commits actual usage.
- Billing state gates models, seats, storage and renders server-side.
- Invoices and ledger are visible and correct.

---

### M7 — Collaboration v1 (3 weeks)

**Goal:** review and versioning without the complexity of CRDT.

Tasks:

1. **Comments.**
   - Anchor to project/comp/layer/time; create, reply, resolve; filters.
   - Guest comments on share links (name/email, rate-limited).
2. **Presence.**
   - Who is viewing, active comp, playhead; heartbeat; no cursor co-editing.
3. **Lease UX.**
   - “Alex is editing” banner; request edit; release on close; expiry.
   - Read-only mode blocks mutations at the bridge and API.
4. **Versions/activity.**
   - Version timeline; labels; restore with confirmation; diff summary.
   - Activity feed with actor, action, target, time; audit export.
5. **Share/review page.**
   - `/s/:token`: player, frame step, comments, password option, request access.
   - No editor for anonymous users in v1.
6. **Tests.**
   - Lease race (two tabs), expiry takeover, read-only enforcement, comment anchors,
     share token revocation, guest abuse limits.

**Exit criteria**

- Two users can review the same project; only the lease holder edits.
- Comments survive reload and link to the right comp/time.
- Restore creates a new version and never rewrites history.
- Share links are revocable and scoped.

---

### M8 — Renders and export (4 weeks)

**Goal:** produce real, downloadable outputs from the cloud, not just browser previews.

Tasks:

1. **Worker.**
   - `effectcraft-cli` runner with a confined temp dir and per-job workspace.
   - Job queue (Valkey/BullMQ), retries, timeouts, cancellation, concurrency limits.
   - Input: version object + asset manifest; output: MP4/ProRes/PNG sequence/GIF/WAV.
2. **Render API/UI.**
   - Queue from editor (“Render…”) and project hub; format, resolution, fps, range,
     quality; credit estimate; progress; download.
   - Render history with status, error, credits, expiry.
3. **Preview vs final.**
   - Browser `render.frame` for fast previews; worker for final outputs.
   - Do not block the editor while a render runs.
4. **Storage/lifecycle.**
   - Output bucket keys; signed downloads; retention by plan; cleanup job.
5. **Tests.**
   - Golden render of a known project (hash/frame compare), cancellation, timeout,
     worker crash recovery, malformed project, missing asset, quota.
   - Load test: 10 concurrent renders on the reference box.

**Exit criteria**

- A user can render a project and download a playable file.
- Job survives worker restart; no duplicate outputs on retry.
- Credits are charged only for completed renders (or documented partial policy).
- Render p75 start < 30s; 1080p 10s comp < 5 min on the reference box.

---

### M9 — Design system, landing and dashboard (4 weeks, parallel)

**Goal:** replace the current generic UI with the cinematic system in
`UI_DESIGN_SYSTEM.md`.

Tasks:

1. **Tokens and primitives.**
   - CSS variables, Tailwind mapping, fonts, buttons, inputs, dialogs, menus, tabs,
     tables, toasts, badges, skeletons, command palette.
   - Storybook/examples; axe tests; dark-only.
2. **Marketing.**
   - Landing, pricing, FAQ, legal, changelog, status, 404/500.
   - Real product demo capture; no fake logos/metrics; performance budget.
3. **Auth and onboarding.**
   - Sign-in/up, invite, reset, verify, workspace creation, trial start.
4. **Dashboard and project hub.**
   - Rail, top bar, project grid, empty/loading/error, versions, activity.
5. **Billing/settings.**
   - Plan, credits, usage, invoices, members, roles, API keys, models, audit,
     licences.
6. **Chat visual pass.**
   - Align the overlay with the design system without restyling the editor.
7. **Visual QA.**
   - Screenshots at 390/768/1024/1280/1440/1920; 200% zoom; reduced motion; axe.
   - Editor screenshot diff vs upstream.

**Exit criteria**

- Every page has empty/loading/error/offline/permission states.
- No placeholder copy, fake data or dead links.
- Landing LCP < 2.5s p75 on 4G; CLS < 0.1; INP < 200ms.
- Chat overlay looks native over the editor; editor UI unchanged.
- Design tokens are the only source of colour/radius/type.

---

### M10 — Hardening, private beta and release (4 weeks)

**Goal:** prove the loop, secure it, and operate it.

Tasks:

1. **Security review.**
   - Tenant isolation, IDOR, signed URLs, SSRF, uploads, prompt injection, tool
     allowlist, command validation, API-key scopes, CSRF, rate limits.
   - Dependency/licence audit; no AGPL/SSPL; attribution complete.
2. **Reliability.**
   - Backups + restore drill; queue recovery; editor crash recovery; idempotency;
     ledger reconciliation; graceful degradation when LiteLLM/provider is down.
3. **Performance.**
   - Run the budgets in §6 on the reference machine; fix regressions; record numbers.
4. **E2E and load.**
   - Full loop on staging with Stripe test clocks; 50 concurrent editor sessions;
     10 concurrent renders; 100 chat runs/hour.
5. **Observability.**
   - Traces, metrics, dashboards, alerts for 5xx, queue depth, render failures,
     credit mismatch, wasm load errors.
6. **Docs and support.**
   - Runbooks: deploy, rollback, restore, provider outage, render stuck, billing
     dispute. Status page. Security contact. Privacy/terms.
7. **Private beta.**
   - 10–20 design partners; onboarding calls; instrumentation; weekly triage.
   - Gate: no P0/P1 open; crash-free > 99.5%; apply success > 95%; refund/reconcile
     100%.

**Exit criteria**

- Full E2E passes on staging and production.
- Restore drill succeeds from backup.
- No critical/high security findings open.
- Performance budgets met or explicitly waived with evidence.
- Rollback to the previous editor pin and previous app release is tested.
- Private beta cohort completes the loop without manual intervention.

---

## 4. Workstreams

| Workstream | Owner | Scope |
|---|---|---|
| **Editor** | Rust/editor | Pin, wasm build, bridge, command schema, worker CLI, upstream patches |
| **SaaS core** | Tech lead | Auth, tenancy, API, projects, versions, leases |
| **Agent** | Tech lead + TS | AI SDK, LiteLLM, context, tools, plan/apply/undo, evals |
| **Billing** | Full-stack TS | Stripe, plans, credits, ledger, entitlements, reconciliation |
| **Frontend/design** | Design engineer | Design system, marketing, dashboard, chat overlay, visual QA |
| **Collaboration** | Full-stack TS | Comments, presence, versions, activity, share |
| **Renders** | Rust + TS | Worker, queue, formats, storage lifecycle |
| **Platform** | DevOps | Local env, CI, deploy, backups, observability, security |

Shared files (`package.json`, route registry, env schema, DB schema) get small,
reviewed edits. New features live in their own modules to avoid merge conflicts.

---

## 5. Definition of done (every task)

A task is done only when:

1. The behaviour works end-to-end, not just in a unit test.
2. Types are strict; no `any` in exported APIs; Zod at every boundary.
3. Errors return typed envelopes with code, message, hint and retryable.
4. Tests cover success, failure, empty and adversarial input.
5. Tenant isolation and permissions are enforced server-side.
6. Idempotency is present for mutations, credits, webhooks and renders.
7. UI has empty/loading/error/disabled states and keyboard/focus behaviour.
8. No secrets, stack traces, absolute paths or provider URLs leak.
9. Docs/ADR/devlog updated if a decision or number changed.
10. `pnpm typecheck`, `pnpm test`, `pnpm lint`, editor tests and the relevant E2E
    pass.
11. The editor UI is untouched unless the task is an approved bridge patch.
12. A screenshot or short capture is attached for UI changes.

---

## 6. Performance budgets

Reference machine: 8-core CPU, 16 GB RAM, integrated GPU or better, Chrome stable,
100 Mbps, unless noted. Measure p75, not best case.

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
| Editor playback | 60 fps at 1080p for a 20-layer comp (reference project) |
| Chat first token | < 1.5s p75 |
| Context assembly | < 400ms p75 |
| Plan validation | < 100ms p75 |
| Apply (`engine.batch`, ≤20 steps) | < 300ms p75 |
| Preview frame (720p) | < 2s p75 |
| API read p95 | < 300ms |
| API write p95 | < 600ms |
| Render queue start | < 30s p75 |
| 1080p 10s render | < 5 min on reference box |
| Crash-free sessions | > 99.5% |

If a budget cannot be met, record the measured number, the cause, and an explicit
waiver in `docs/performance.md`. Do not silently relax it.

---

## 7. Test strategy

### 7.1 Layers

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | Pure logic, schemas, credit math, plan compiler |
| Integration | Vitest + real Postgres/MinIO | Repositories, auth, uploads, versions, webhooks |
| Contract | Zod/OpenAPI + fake bridge | API envelopes, SSE events, editor bridge |
| Rust | `cargo test`, clippy | Editor engine, command registry, wasm build |
| E2E | Playwright | Full loop, roles, lease, chat apply/undo |
| Visual | Playwright screenshots | Shell pages + editor unchanged |
| Load | k6/autocannon | API, chat, renders, concurrent editors |
| Security | manual + ZAP | Tenancy, IDOR, uploads, prompt injection |
| Evals | LiteLLM/Langfuse | Agent success on a golden prompt set |

### 7.2 Golden agent prompts

Maintain `evals/prompts/` with at least 30 prompts across:

- Create a title comp with text and a background.
- Animate scale/position/opacity with specific timings.
- Add and tune an effect.
- Change brand colours across layers.
- Reorganize/rename layers.
- Add a lower third.
- Create a 3D-ish camera move (within engine support).
- Ambiguous target → must clarify.
- Destructive request → must confirm.
- Impossible request → must explain, not hallucinate.

Score: plan validity, apply success, visual sanity (frame compare), undo success,
credits accuracy, latency. Target ≥ 90% valid plans, ≥ 95% apply success on valid
plans.

### 7.3 Security tests

- Cross-tenant reads/writes for every resource.
- Role escalation via API, UI and agent tools.
- Signed URL expiry/audience; object key guessing.
- Upload polyglots, zip bombs, huge dimensions, path traversal, MIME spoofing.
- Prompt injection in layer names, comments, asset metadata and `.ecproj` text.
- Tool arg fuzzing: NaN, Infinity, negative sizes, huge arrays, prototype pollution.
- Webhook replay/out-of-order; idempotency key reuse with different payloads.
- Render job escape: `../`, absolute paths, symlinks, network access.
- Rate limits and denial-of-wallet on chat/render.

---

## 8. Release plan

### 8.1 Environments

| Env | Purpose | Data |
|---|---|---|
| Local | Development | Demo/synthetic |
| Staging | E2E, Stripe test, provider sandbox | Demo/synthetic |
| Production | Private beta | Real, backed up |

### 8.2 Private beta gates

- M0–M6 and M9 complete; M7 comments/versions complete; M8 at least MP4 + PNG.
- Full E2E green on staging for 7 consecutive days.
- No P0/P1 bugs; P2 list triaged.
- Backups + restore drill passed.
- Security review closed.
- Support runbook and status page live.
- 10 design partners onboarded with consent for feedback.

### 8.3 Public beta gates

- M7/M8 complete; collaboration and renders stable for 2 weeks.
- 99.5% crash-free sessions over 14 days.
- Credit reconciliation zero variance for 14 days.
- Cost per active workspace measured; margin positive on paid plans.
- Load test at 2× expected beta concurrency.
- Legal: terms, privacy, DPA, licences/attribution, trademark check.

### 8.4 Rollback

- App: previous container/image + DB migrations are forward-only; rollback code only
  if schema-compatible.
- Editor: previous pinned wasm artifact; project format is backward-compatible within
  the supported pin range. Test opening a project saved by the new pin before
  rolling back.
- Billing: never roll back ledger rows; issue compensating adjustments.
- Feature flags: chat writes, auto-apply, renders, collaboration can be disabled
  independently.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| EffectCraft alpha bugs block editing | High | High | Pin, upstream tests, corpus, rollback pin, isolate patches |
| WASM size/load time | High | High | Compressed wasm, service worker, preload, skeleton, budget, CDN |
| WebGPU unavailable | Medium | High | WebGL2 fallback, capability check, clear message |
| Iframe focus/shortcut issues | Medium | Medium | Same-origin bridge, forwarding tests, focus ring, E2E matrix |
| Upstream churn | High | Medium | UI-frozen policy, tiny patch surface, `UPSTREAM.md` |
| Agent produces invalid commands | High | High | Schema validation, allowlist, plan preview, rollback, evals |
| Model cost/margin | Medium | High | LiteLLM budgets, credit reserve, plan gating, cheaper models |
| Render cost/time | Medium | Medium | Queue, quotas, presets, cancellation, worker pool |
| Billing/ledger bug | Medium | High | Append-only ledger, idempotency, reconciliation, test clocks |
| Cross-tenant leak | Low | Critical | Repository scoping, tests, security review, signed URLs |
| Solo/small-team capacity | High | High | Cut scope (M7/M8 later), no custom editor work, buy over build |
| Licensing/brand | Low | High | Attribution, licence CI, rename audit, legal review |
| Old scaffold traps | High | Medium | Archive, rebuild clean, reuse only tested modules |

### Scope cuts if the schedule slips

Cut in this order, never the critical path:

1. Auto-apply.
2. Guest comments on share links.
3. Extra render formats (ship MP4 + PNG).
4. Templates/marketplace.
5. Advanced presence (keep lease + comments).
6. Public API beyond read-only.
7. Native packaging (not v1 anyway).

Do **not** cut: tenant isolation, credits, undo, versioning, editor load/save, tests.

---

## 10. Post-v1 refinements

- Real-time co-editing with a CRDT/command-transform layer (separate architecture).
- Native desktop build (egui shell) reusing the same gateway/tool protocol.
- Native egui chat panel for desktop, if the web overlay proves limiting.
- Template/brand-kit system with variables.
- Marketplace for effects/templates with revenue share.
- BYOK and self-hosted model gateways for enterprise.
- Team libraries, shared assets, review approvals and annotations on video.
- Render farm autoscaling; priority queues; ProRes/EXR/alpha formats.
- Mobile review app (comments, approvals, notifications).
- Public API/SDK, webhooks, MCP server for external agents.
- Advanced evals: visual critic, brand consistency, accessibility of captions.
- Usage-based enterprise contracts and SSO/SCIM.

---

## 11. First 10 working days

A concrete start, in order:

1. **Day 1:** `git init`, baseline commit, tag, remote. Zip backup. Write `M0.md`.
2. **Day 1–2:** archive PhotoCraft paths; classify reusable packages; record in
   `docs/legacy-inventory.md`.
3. **Day 2–3:** clone EffectCraft at a pinned commit into `editor/`; build native CLI;
   run tests; write `editor/UPSTREAM.md`.
4. **Day 3–4:** build the wasm editor; serve it; verify `window.effectcraft` methods;
   record size/load time.
5. **Day 4:** verify `engine.batch` atomicity/undo with a real project; save evidence.
6. **Day 5:** scaffold `apps/web`, `services/gateway`, `packages/contracts`,
   `packages/editor-bridge`; health routes.
7. **Day 6:** Better Auth with Postgres; workspace create/switch; protect one route.
8. **Day 7:** editor proxy at `/editor/`; iframe loads; readiness handshake.
9. **Day 8:** first project record + `.ecproj` upload + editor open.
10. **Day 9:** LiteLLM alias + scripted chat completion; AI SDK route skeleton.
11. **Day 10:** demo: sign in → workspace → project → editor → chat says “hello” with
    comp context; write `M0`/`M1` evidence and next-wave tickets.

If any day’s assumption fails (especially `saveToBrowser`, wasm size or `engine.batch`
undo), stop and re-plan before building on it.

---

## 12. Open decisions

These do not block M0 but must be closed by the milestone noted:

| Decision | Needed by | Default |
|---|---|---|
| Final product name/domain | M9 | Codename `Studio`; token swap |
| Pricing numbers | M6 | Illustrative plans in architecture; validate margin |
| Trial card requirement wording | M6 | Card required at trial start |
| First render formats | M8 | MP4 (H.264) + PNG sequence |
| Supported browsers | M3 | Chrome/Edge latest; Safari/Firefox best-effort |
| Hosting provider | M10 | Single Linux box + Caddy for beta |
| Data retention | M10 | 30 days renders; versions retained; configurable |
| Model providers | M4 | One fast + one smart via LiteLLM |
| Whether to publish the API | post-v1 | Internal only in v1 |

---

## 13. Evidence to keep

For every milestone, store in `docs/phases/<milestone>/`:

- Build/test logs (trimmed).
- Screenshots and short captures.
- Performance numbers with hardware and date.
- Security review notes.
- Known gaps and waivers.
- Demo script and result.

This is how the next agent or contributor picks up without guessing, and how the
private beta gate is judged on evidence rather than optimism.
