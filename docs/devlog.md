# Devlog — studio SaaS

One entry per build phase (§19: "each phase ends with a green CI, a demo-able
artifact, and a short devlog entry"). Entries are append-only; newest at the bottom.
Each entry records: what shipped (with commits), what was decided (with ADRs), what
was learned, and what the next phase depends on. Alert/runbook references use
`docs/runbooks/RB-xx`; architecture decisions use `docs/adr/NNNN`.

---

## Phase 0 — Spike / foundation (Waves 0–1) — 2026-10-20

**Goal (§19 Phase 0):** prove the spine end-to-end (`pnpm demo:coffee`: brief →
template → engine → render → critic → `.pcraft` + PNG + command log) with zero product
polish. Wave 0 + Wave 1 laid the monorepo, schemas and service skeletons that the spike
code builds on; the spike itself (engine-client calls, one template, one LLM path,
critic loop) is the immediate next step.

**Fleet:** Wave 1 ran as ~20 parallel agents (W1-A…W1-T) plus the W0 scaffold agents;
10 of them had landed at the time of this entry. **Repo:** 8 packages (`agent`,
`billing`, `config`, `db`, `engine-client`, `evals`, `tools`, `ui`) + 4 apps
(`gateway`, `worker`, `engine-pool`, `web`) = 12 pnpm workspace projects.

**Shipped (commit → what):**

- ✅ `ffe228f` W0 — repo scaffold: build prompt (`docs/BUILD_PROMPT.md`), agent law
  (`docs/AGENTS.md`), `scripts/git-sync.sh`, ADR-0001 editor pins, `ATTRIBUTION.md`.
- ✅ `82cfcf4` W0b — monorepo shell: pnpm workspaces + Turborepo, TS strict ESM
  NodeNext base, Biome, `turbo.json`, package skeletons.
- ✅ `7fe021f` W1-A — environment matrix + `.env.example` + ADR-0002 (fail-fast env
  parsing contract for the fleet).
- ✅ `e4f2ceb` W1-E — runs schema: `agent_runs`/`agent_steps`/`run_events` with
  idempotency + per-run event `seq`.
- ✅ `8ee9242` W1-F — billing schema: append-only `credit_ledger`, `credit_reservations`,
  `plans`, `subscriptions`, `idempotency_keys`, `rate_limit_buckets` + `audit_log`.
- ✅ `4800ccf` W1-D — content schema: documents, versions, command-log WAL (unique
  `(document_id, seq)`), assets, comments, workspace templates.
- ✅ `de16acb` W1-I — worker skeleton: BullMQ queue topology (`runs:quick|max …`,
  `exports`, `images`), §3.4 timeouts, retry ×3, injectable `RunProcessor` seam.
- ✅ `7133e91` W1-H — gateway skeleton: Hono app factory, request-id + pino logger,
  flat error envelope, `/v1/health` + `/v1/health/deep`, graceful drain.
- ✅ `c57c0c3` W1-J — engine-pool skeleton: session registry, 256-bit token alloc,
  watchdog, tenant-checked lookups, injectable spawner (24 tests, zero real processes).
- ✅ `28c6ecc` W1-G — db client factory (postgres-js + Drizzle), `drizzle.config.ts`,
  idempotent seed script, migration docs.
- ✅ ADR-0003 (Better Auth org/apiKey/admin + RBAC matrix), ADR-0004 (BullMQ on Valkey,
  license rationale), ADR-0005 (pino/OTel/Langfuse/GlitchTip/Uptime Kuma), runbooks
  RB-01…RB-08 (§22 alerts → procedures), API docs index (`docs/api/README.md`).

**Decisions worth remembering:**

- Valkey, not Redis ≥ 7.4 (RSALv2/SSPL, §16.5) — ADR-0004; Better Auth over
  Clerk/NextAuth — ADR-0003; GlitchTip over Sentry self-host (FSL) — ADR-0005.
- Ledger is append-only; queue is transport, never money truth (ADR-0004).
- Cross-tenant lookups are indistinguishable from not-found (W1-J registry rule).

**Known open items (for the next wave):**

- Error envelope reconciliation: gateway ships the flat `{ ok:false, code, message,
  hint }` (AGENTS.md law) while §13.3 sketches nested `{ error: { … } }` — decided in
  the contract wave (see `docs/api/README.md`).
- Text vs uuid id columns across schema files need repository-layer casts (W1-D/W1-F
  notes); `tsconfig.base.json` composite + `tsc --noEmit` risk flagged fleet-wide.
- Phase 0 exit gate not yet met: `pnpm demo:coffee` needs the engine-client wired to
  `photocraft-cli serve`, one template manifest, and one Gemini call path.

**Next:** finish Phase 0 spike, then Phase 1 MVP (§19: auth+workspaces, gateway
endpoints with RBAC, worker+billing live, engine pool live, validator v1, 3 templates).

---

## Phase 0 — Spike — COMPLETE — 2026-10-21

**Outcome (§19 Phase 0 exit):** the spine is proven end-to-end against the
protocol-faithful mock engine, deterministically, with all four §19 artifacts
(`.pcraft`, PNG, critic report, command log). `node apps/worker/scripts/demo-coffee.mjs`
is green in spawn and connect modes (twice against two fresh spawns; in-process
determinism assert on `.pcraft`/PNG/critic bytes + ts-stripped WAL rows;
sha256 digest `e03c0170…270687` stable, pin hook `DEMO_COFFEE_EXPECT_SHA256`).

**Shipped (commit → what):**

- ✅ `e9a6422` W2-A — engine transport: TCP framing, auth-first connection,
  correlation, reconnect (`packages/engine-client/src/transport`).
- ✅ `e77a625` W2-B — engine auth (256-bit tokens), capability roots, reply budgets.
- ✅ `30bf075` W2-C — typed protocol methods (doc/engine/batch/jobs per `rpc.rs`).
- ✅ `14b3406` W2-G — `photocraft-cli serve` spawner: CLI contract per `lib.rs`,
  readiness probe, cleanup.
- ✅ `53751e1` W2-F — mock-engine: protocol-faithful fake with fault hooks
  (`apps/mock-engine`) — the CI stand-in for the real binary (no `cargo build`
  on this box, AGENTS.md; the CI Rust job owns the real-process run).
- ✅ `347a536` W2-I — WAL cursor + recovery coordinator (resume-once, fail-clean);
  `1b89a4e` W2-H — checkpoint/attach/health, WAL replay decisions, idle saves.
- ✅ `3f01954` W2-J — spine tests: `apps/worker/tests/spine/{engine-spine,
  recovery-spine}.test.ts` (mock E2E + crash recovery) + `demo-spine.mjs`.
- ✅ `a6cd6b5` W2-D2 — commands registry + engine-client barrel (command ids
  verified against `commands.rs`, never invented).
- ✅ `80b715c` W7-G — `demo-coffee.mjs`: the §24.1 coffee trace end-to-end
  (auth → doc.new → emulated apply/fill batches → render ×2 → validator
  (WCAG contrast computed) → mock critic (0 model calls, §1.5-6) →
  agent.commit → doc.save), artifacts to `apps/worker/.demo-output/`,
  hash-deterministic ×2 passes. README documents every mock-vs-real seam.

**Honest caveats (kept per §1.3):**

- The demo runs against the **mock engine**, not a real `photocraft-cli` binary —
  this box forbids `cargo build`/installs (AGENTS.md); the real-process exercise
  belongs to CI's engine-patch job and a live Compose box.
- "`pnpm demo:coffee`" alias is **not yet wired** in `apps/worker/package.json`
  (only `demo:spine` is); run via `node scripts/demo-coffee.mjs` — flagged to the
  package.json owner (W7-G FLAG 1). `.demo-output/` gitignore line also owed.
- "In `local` Compose" (§19) untested here — compose stack exists (W1-L `dc191c6`)
  but was never booted on this box.

**Next:** Phase 1 assembly was already underway in parallel (see below).

---

## Phase 1 — MVP — COMPLETE-BUILD — 2026-10-21

**Meaning of COMPLETE-BUILD:** every §19 Phase 1 bullet exists as code with
tests in this repo; the runtime halves (staging deploy, real Stripe test-mode
subscription, live engine) require a live environment this box cannot provide
(no installs, no dev servers — AGENTS.md). Per-phase detail: `docs/phases/phase-exit-audit.md`.

**Shipped (commit → what):**

- ✅ `7133e91` W1-H + W4 wave — gateway assembled: **40 OpenAPI 3.1 paths**
  (`416c275` W4-O + `eaf06e4` W4-N/R sweep; `apps/gateway/src/openapi.ts`),
  mounted and audited against §13. Routes: auth-context/request-context +
  role gate (`b120f53` W4-B), RBAC + cross-tenant guard (`45424c7` W4-C),
  rate limiter + upload/run caps (`4057858` W4-D), runs API reserve→queue→
  idempotent create (`b20042f` W4-G), SSE backfill+live+resume+resync
  (`3e07ada` W4-H), exports + cached preview (`f07b6b0` W4-L), credits/usage
  (`629f5e1` W4-M), catalog (`17a936d` W4-J), manual command exec + undo/redo
  + WAL (`e3339e1` W4-K), deep health + audit (`52f120c`+`35f3827` W4-Q),
  Stripe checkout/portal/webhook (`eaf06e4` W4-N/R).
- ✅ **Cross-tenant suites** (§20 #11): `apps/gateway/tests/integration/
  cross-tenant.test.ts` (lookups-stay-404 + typed `cross_tenant_denied`
  assertions, both directions with OWNER tokens, storage-key tenant guard
  across all five object namespaces) + `rbac-matrix.test.ts`,
  `signup-flow.test.ts` (§20 #1 partial: workspace/invite/membership semantics).
- ✅ **Ledger idempotency tests** (§20 #10): `apps/gateway/tests/integration/
  ledger-flow.test.ts` (reserve/commit/refund rows over the REAL
  `billingFromLedger` adapter; same idempotency key never charges twice;
  failed run refunds; trial credits 30) + `2b6d0a4` W1-N billing domain
  (`packages/billing/tests/ledger.test.ts`).
- ✅ **Engine pool live-shaped** (§19): `c57c0c3` W1-J skeleton (session
  registry, 256-bit token alloc, watchdog, tenant-checked lookups) +
  `1b89a4e` W2-H checkpoint/attach/health + `347a536` W2-I recovery
  coordinator (`apps/engine-pool/src/recovery-contract.md`).
- ✅ **Run manager + worker recovery** (§19): `de16acb` W1-I BullMQ topology,
  `961b289` W6-M recovery wiring (replay + resume-once + retry glue),
  `d8e4dd3` W6-N run-manager files (`apps/worker/src/run-manager/{crash,deps,
  emit,processor}.ts`); `053222f` W6-J run state machine + cooperative
  cancellation; `2a37d76` W6-B executor loop; `46fd1bf` W6-H model router.
- ✅ Validator v1 + critic v1 + 2 repair cycles (§19): `5f427b3` W6-D run
  validator, `acf120f` W6-E critic + 2-cycle repair gate, `e1475f1` W6-F repair
  planner; `9b8339b` W6-I transaction manager (single-undo semantics);
  `91c8ded` W6-K injection guards + tool-call gate.
- ✅ 3 templates + components beyond spec: `49d9d5a` W3-J seed templates
  (instagram-post@3 verbatim §7.2, youtube-thumbnail@1, presentation-slide@1);
  `67af6b4` W3-K ten component manifests (spec asked 5).
- ✅ Deploy assets: `dc191c6` W1-L compose stack, TLS reverse proxy,
  backup/restore/deploy scripts; `fc6fac2` W1-K web shell + SSE helper;
  `74ae09e` W1-T UI kit; `00cfbc2`+`89a050d` W1-M CI (workflows parked in
  `/home/z/my-project/ci-staging` — PAT scope, see worklog).

**Honest caveats:** "passes on staging with a real Stripe test-mode subscription"
(§19 Phase 1 exit) is **not demonstrable from this box** — no live Postgres/
Valkey/Stripe/engine. Stripe routes are unit-tested with fakes; the live
subscription flow needs the Compose box. Signup email verification (Better Auth
server + email) is outside the current test seam (signup-flow.test.ts header).

---

## Phase 2 — Templates & components — COMPLETE-BUILD — 2026-10-21

**Shipped (commit → what):**

- ✅ **4 engine modules** (§2.3, upstreamable under `engine-patches/`):
  `template_cmds` (`3f85400` W3-A manifest/list/inspect/apply + `4988dd2`
  W3-B3 template.validate + fill_specs), `component_cmds`
  (`component_cmds.rs` + `component_manifest.rs`), `layout_cmds` (`4b66e49`
  W3-N parent module + fit_specs/fit_text/layout_apply; `15f7690` W4-S
  TextMeasurer impl — the fit_text ↔ layout_apply bridge), `agent_cmds`
  (`621c45a` W3-F begin/commit/rollback single-undo transactions + `0a6efec`
  W3-G document.diff). Registration patch + panic-hunt obligations table
  (`7a20eb9` W3-H); golden-rules review with violations fixed (`82cb863`
  W3-L, `engine-patches/tests/review-log.md`); upstream PR guide + docs
  (`ebbe2a9` W3-I).
- ✅ **Templates: 16 manifests on disk** (spec target 10): 3 seed (`49d9d5a`)
  + 5 social (`ef272ea` sweep, W7-A: instagram-story, facebook-cover, x-post,
  linkedin-banner, pinterest-pin) + 4 digital (`00e1842` W7-C: email-header,
  web-hero-banner, blog-cover, presentation-quote) + 4 print (`c728330` W7-B:
  event-flyer, product-poster, business-card, cafe-menu). Every manifest
  validated against `manifest.rs` limits + `validate.rs` rules (owners'
  zero-dep gates, see worklog). Fixture generator + committed synthetic PNGs
  (`ef272ea`+`effebfe` W7-E, deterministic, ≤50 KB each).
- ✅ **10 components** (spec target 15 — honest gap of 5, incl. `qr-code@1`
  flagged by W7-B for event-flyer's badge slot): `67af6b4` W3-K
  (badge/logo/rating/price/button/quote/avatar/divider/ribbon/handle).
- ✅ **67-brief eval suite** (§19 gate ≥50): `097c56e`+`bd22702` W7-D —
  52 new cases in `packages/evals/cases/expanded/` (suite 15→67): create_post
  ×32, edit_layers ×9, resize ×3, variant ×5, export ×3, clarify ×2,
  injection ×2, budget ×2; every manifest-bearing template has ≥1 happy path.
  Honest gap: promptfoo.config.yaml registration of the expanded files is
  still owed to the config owner (block ready in `cases/expanded/README.md`).
- ✅ **Chat-edit set** (§19 Phase 2 "chat edits correct ≥90%"): `0580c0c`
  W6-O chat-edit classifier (§23.5 byte-verbatim prompt, cheapest-action
  routing, §24.2 composite actions, tier downgrade/raise guard; 81 tests)
  + quick-edit cases in `cases/expanded/edits.yaml` (6 quick §24.2-style
  + 2 standard).
- ✅ Brand tokens per workspace (§7.5): `ba3bffc` W7-F (palette/fonts/logo,
  per-field fallback, §10.2 font gate, §5.4 style-guide block).
- ✅ Tools wave (§6): template_apply `e97268e` W5-C, workspace_snapshot
  `406f131` W5-A, text_set `3e079ce` W5-G, layer_ops `1182b2a` W5-H,
  style_apply `f553571` W5-I, component_list/place `515a006` W5-K,
  component_set_vars `ab73bdf` W5-L, render_preview `755a5a6` W5-M,
  validate_document `96db04f` W5-N, ask_user `0862a79` W5-R,
  variant_create `3d2e82e` W5-P — no raw coordinates (layout.apply/fitText
  per §7.4 contract).
- ✅ Command-log replay determinism (§19 Phase 2 exit "replays to an identical
  document hash"): asserted in-repo by demo-coffee's ×2 hash equality (vs
  mock engine) + WAL resume-once spine (`3f01954`, `961b289`).

**Honest caveats:** "≥85% eval pass / ≥90% chat edits" need live model keys
(the CI default provider is the deterministic mock-planner — zero cost, §1.5-6);
the real-engine replay hash + `cargo` panic-hunt green belong to the CI Rust
job. 5 of 15 spec components still owed.

---

## Phase 3 / Phase 4 — STATUS: SCOPED (not started as phases) — 2026-10-21

Honest scope note per §1.3 — what this repo build did and did not deliver:

**Phase 3 (freeform & collaboration) — mostly NOT-MET, pieces in place:**
- Built: `document.diff` engine module (`0a6efec` W3-G, the version-compare
  primitive), public API surface + OpenAPI 3.1 doc + §13 audit (`416c275`),
  API-key auth design (ADR-0003), storage presigning (`b4ddba3` W2-M),
  freeform eval cases ×2 (`097c56e` W7-D, planner must flag freeform),
  comments table in schema (`4800ccf` W1-D — no routes yet).
- **Remains vs spec:** freeform composer on layout primitives + planner
  template-vs-freeform choice; comments UI/positions/notifications; presence
  (Centrifugo), run sharing, workspace activity feed; product webhooks
  (`run.succeeded`/`export.ready` — only the Stripe webhook exists); PSD
  export fidelity report (W2-N ships PSD as experimental); large-canvas
  tiers; export presets. Freeform quality evals untouched (spec gate ≥70%).

**Phase 4 (production hardening) — mostly BUILD-ONLY/NOT-MET:**
- Built (code-level): runbooks RB-01…RB-08 + §22 alert mapping, ADR-0005
  observability stack, compose/backup/restore/deploy scripts (`dc191c6`),
  license checker + manifest (`7f776e4` W1-R), CI pipeline (`00cfbc2`),
  prompt-injection suite + tool-call gate (`91c8ded` W6-K, 97 tests),
  authz matrix tests, upload fuzzing guards (`120f61b` W2-O),
  crash/recovery paths (`961b289`, `d8e4dd3`), refunds in billing domain
  (`2b6d0a4`).
- **Remains vs spec:** load tests, chaos drills, multi-box scaling, a real
  restore drill, live dashboards/alerts/cost guardrails, billing edge cases
  (dunning, tax, invoices, credits-expiry display), onboarding funnel, pricing
  page, support inbox, pen-test — all need a live environment and are the
  honest gap between this repo build and the paid beta gate.

Per-criterion scoring: `docs/phases/phase-exit-audit.md` (§19) and
`docs/phases/acceptance-matrix.md` (§20).
