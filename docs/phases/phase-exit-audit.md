> **HISTORICAL — pre-pivot (PhotoCraft era).** Superseded by ADR-0006 and the
> EffectCraft build plan. Kept for audit trail; nothing here describes the
> current product. Current milestone evidence: `docs/phases/M0.md`–`M8.md`.

# Phase Exit Audit — §19 criteria, scored honestly (W7-K, 2026-10-21)

One row per §19 exit criterion, per phase. Statuses mean exactly this:

- **MET** — satisfied inside this repo today: code + tests/artifacts citable now.
- **BUILD-ONLY** — the code exists and is unit/integration-tested with fakes/mocks,
  but the criterion's runtime half **needs a live environment** this box cannot
  provide: a real Stripe test-mode subscription, a real `photocraft-cli` binary
  (no `cargo build` here — AGENTS.md), live paid model keys, a booted Compose
  stack, or load/chaos traffic. CI + a live box own the confirmation.
- **NOT-MET** — not built (or scoped out of this build); honest gap per §1.3.

The repo build satisfies the **code criteria**; the **runtime criteria** are
owed to a live environment. Evidence pointers are test files, docs, or commit
subjects (`git log --oneline`).

---

## Phase 0 — Spike

§19 exit criteria: "`pnpm demo:coffee` produces a valid layered `.pcraft`, a PNG,
a critic report, and a command log, deterministically, in `local` Compose."

| # | Criterion (§19) | Status | Evidence |
|---|---|---|---|
| 0.1 | `packages/engine-client`: spawn `photocraft-cli serve`, authenticate, call `doc.new`/`engine.execute`/`doc.render`/`doc.save`, typed + unit-tested | **BUILD-ONLY** (typed client complete + tested against the protocol-faithful mock; "against a real process" needs a real engine binary — CI Rust job / live box) | `packages/engine-client/tests/{contract,drift-check,methods,auth,budgets,capabilities}.test.ts`; commits `e9a6422` W2-A transport, `e77a625` W2-B auth, `30bf075` W2-C methods, `14b3406` W2-G spawner (CLI contract per `lib.rs`), `a6cd6b5` W2-D2 registry |
| 0.2 | One hard-coded Instagram template manifest; script applies+fills it and saves `.pcraft` + PNG | **MET** (vs mock engine; emulated apply/fill batches with graceful-refusal probes documented) | `evals/templates/instagram-post@3/` (§7.2 verbatim, `49d9d5a` W3-J); `apps/worker/scripts/demo-coffee.mjs` (`80b715c` W7-G) — `.pcraft` read back + layered asserts, PNG magic asserted |
| 0.3 | One LLM call path (brief → fill JSON) | **BUILD-ONLY** (model router + planner prompts exist; a live Gemini call needs paid keys, §1.5-6; demo runs a mock critic with 0 model calls, clearly labeled) | `46fd1bf` W6-H model router (tier routing/breakers/failover); `c95cfa3` W1-P agent core plan schema/model routes; `packages/agent/prompts` (§23.x mirrors) |
| 0.4 | Render + a single vision critic call + one revision | **BUILD-ONLY** (critic service + 2-cycle repair gate built; vision critic needs a live model; demo uses a placeholder rubric — labeled, no gaming) | `acf120f` W6-E critic + 2-cycle gate, `e1475f1` W6-F repair planner; demo critic step in `demo-coffee.mjs` |
| 0.5 | Command log printed for the run | **MET** | `command-log.jsonl` artifact in demo output; WAL schema `4800ccf` W1-D (unique `(document_id, seq)`); `command-log` WAL rows asserted |
| 0.6 | Deterministic output | **MET** (×2 passes vs two fresh spawns; hash-equal `.pcraft`/PNG/critic bytes + ts-stripped WAL; digest `sha256:e03c0170…270687`, pin hook `DEMO_COFFEE_EXPECT_SHA256`) | `80b715c` W7-G; `apps/worker/scripts/demo-coffee-README.md`; spine determinism `3f01954` W2-J (`apps/worker/tests/spine/`) |
| 0.7 | `pnpm demo:coffee` alias | **NOT-MET** (trivial but real: `apps/worker/package.json` ships only `demo:spine`; run today via `node scripts/demo-coffee.mjs` — W7-G FLAG 1 to the package.json owner) | `apps/worker/package.json`; W7-G worklog |
| 0.8 | "in `local` Compose" | **BUILD-ONLY** (compose stack + TLS + backup scripts authored; never booted on this box — no installs/servers, AGENTS.md) | `dc191c6` W1-L compose/backup/deploy scripts |

**Phase 0 verdict: COMPLETE (code) — the four artifacts + determinism are proven
against the mock engine; the real-binary/Compose halves are BUILD-ONLY and owned
by CI + a live box.**

---

## Phase 1 — MVP

§19 exit criteria: "§20 acceptance criteria 1–12 pass on staging with a real
Stripe test-mode subscription."

| # | Criterion (§19) | Status | Evidence |
|---|---|---|---|
| 1.1 | Better Auth + workspaces + invites; identity/content/runs/ledger schema | **BUILD-ONLY** (ADR-0003 design + routes + schema complete; live Better Auth server + email verification need the box) | ADR-0003; `8ee9242` W1-F billing, `e4f2ceb` W1-E runs, `4800ccf` W1-D content, `28c6ecc` W1-G db; `apps/gateway/tests/integration/signup-flow.test.ts` (§20 #1 partial — workspace/invite/membership semantics pinned with fake sessions) |
| 1.2 | Gateway endpoints (§13) with RBAC and rate limits; SSE run stream | **MET** (code) — 40 OpenAPI paths assembled + §13-audited; RBAC matrix + limiter + SSE tested | `416c275` W4-O OpenAPI + audit (40 paths in `apps/gateway/src/openapi.ts`), `eaf06e4` W4-N/R assembler/stripe sweep; `45424c7` W4-C RBAC+cross-tenant guard; `4057858` W4-D limiter; `3e07ada` W4-H SSE; `apps/gateway/tests/{authz,rate-limit,runs-events}.test.ts`, `tests/integration/rbac-matrix.test.ts` |
| 1.3 | Worker + BullMQ; run tiers, budgets, reservations, ledger, Stripe checkout/webhooks | **MET** (code; Stripe routes tested with fakes) | `de16acb` W1-I queues; `b20042f` W4-G runs reserve→queue idempotent; `629f5e1`/`c6c6b8a` W4-M credits/usage; `eaf06e4` W4-N/R stripe routes; `2b6d0a4` W1-N billing domain; `apps/gateway/tests/billing.test.ts` |
| 1.4 | Engine pool: per-tenant tokens, capability roots, idle timeouts, watchdog | **MET** (code; spawner injectable, zero real processes) | `c57c0c3` W1-J (24 tests); `1b89a4e` W2-H checkpoint/attach/health; `347a536` W2-I recovery coordinator; `apps/engine-pool/src/*` |
| 1.5 | Browser flow: create-from-template, upload, prompt, timeline, preview, single-undo, versions, PNG/.pcraft export | **BUILD-ONLY** (routes + tools + web shell exist; the end-to-end browser flow needs a live stack) | `17a936d` W4-J catalog; `f07b6b0` W4-L exports/preview; `e3339e1` W4-K undo/redo; `fc6fac2` W1-K web shell + SSE helper; `74ae09e` W1-T UI kit |
| 1.6 | Validator v1, critic v1, 2 repair cycles | **MET** (code) | `5f427b3` W6-D validator; `acf120f` W6-E critic + 2-cycle gate; `e1475f1` W6-F repair planner |
| 1.7 | 3 templates, 5 components | **MET** (3 seed templates + 10 components — over target) | `49d9d5a` W3-J; `67af6b4` W3-K |
| 1.8 | Deploy to the box: Caddy + TLS, daily backups; trial credits, plan gating, insufficient-credits UX | **BUILD-ONLY** (scripts authored, never run; trial credits + gating logic tested) | `dc191c6` W1-L; ledger-flow trial credits 30 (`apps/gateway/tests/integration/ledger-flow.test.ts`); compose untested here |
| 1.9 | **Exit: §20 #1–12 pass on staging with a real Stripe test-mode subscription** | **BUILD-ONLY** — code criteria for #1–12 are satisfied in-repo (see `docs/phases/acceptance-matrix.md`); the staging run + real subscription need the live environment | `apps/gateway/tests/integration/*` (signup-flow, cross-tenant, ledger-flow, rbac-matrix) |

**Phase 1 verdict: COMPLETE-BUILD — the gateway (40 paths), cross-tenant suite,
ledger idempotency suite, engine pool, and run manager are assembled and tested
with fakes; staging + Stripe test-mode remain a live-environment obligation.**

---

## Phase 2 — Templates & components

§19 exit criteria: "eval suite ≥ 50 briefs with ≥ 85% pass; chat edits correct
≥ 90% on the curated set; a run's full command log replays to an identical
document hash."

| # | Criterion (§19) | Status | Evidence |
|---|---|---|---|
| 2.1 | `template_cmds.rs`, `component_cmds.rs`, `layout_cmds.rs`, `agent_cmds.rs` with tests + panic-hunt coverage; command discovery at startup with version checks | **BUILD-ONLY** (all four modules authored as upstreamable patches + obligations table + review; `cargo` compile/test/clippy/panic-hunt run in CI's Rust job, not on this box) | `engine-patches/{template_cmds,component_cmds,layout_cmds,agent_cmds}`; commits `3f85400` W3-A, `4988dd2` W3-B3, `4b66e49` W3-N, `621c45a` W3-F, `0a6efec` W3-G, `15f7690` W4-S; registration + panic-hunt table `7a20eb9` W3-H (`engine-patches/tests/README.md`); W3-L review `82cb863` (`engine-patches/tests/review-log.md`); docs `ebbe2a9` W3-I |
| 2.2 | Template authoring flow; 10 templates and 15 components; brand tokens | **MET** (templates) — **NOT-MET** (5 components) | 16 template manifests on disk: `49d9d5a` W3-J (×3 seed), `ef272ea`/W7-A social ×5, `00e1842` W7-C digital ×4, `c728330` W7-B print ×4; 10 components `67af6b4` W3-K (qr-code@1 etc. owed — W7-B flag); brand tokens `ba3bffc` W7-F |
| 2.3 | `layout.apply`/`layout.fitText` used by `template.fill`; no raw coordinates in tools | **MET** (code) | `e97268e` W5-C template_apply (§7.4 contract + engine error mapping); `15f7690` W4-S TextMeasurer bridge; tools wave W5 (`406f131`, `3e079ce`, `1182b2a`, `f553571`, `515a006`, `ab73bdf`, `755a5a6`, `96db04f`, `0862a79`, `3d2e82e`) |
| 2.4 | Multi-turn chat edits; quick-edit tier with `document.inspect` context | **BUILD-ONLY** (classifier + curated cases built; "correct ≥90%" needs live model keys — CI provider is the deterministic mock-planner) | `0580c0c` W6-O chat-edit classifier (§23.5 verbatim, cheapest-action routing, 81 tests); `packages/evals/cases/expanded/edits.yaml` (6 quick §24.2-style + 2 standard); `1622`/`1638` inspect routes in `openapi.ts` |
| 2.5 | Variants via data sets + layer comps; bulk export | **MET** (code) | `3d2e82e` W5-P variant_create; `f07b6b0` W4-L exports enqueue; cases in `packages/evals/cases/expanded/operations.yaml` |
| 2.6 | **Exit: eval suite ≥ 50 briefs with ≥ 85% pass** | **BUILD-ONLY** — 67 briefs authored + structurally validated (≥50 **MET**); the ≥85% pass-rate run needs real-model wiring/keys; promptfoo registration of the expanded files still owed to the config owner | `097c56e` + `bd22702` W7-D (52 new cases, suite 15→67); `packages/evals/scripts/eval-gate.mjs` (exit 1 below 0.85); `packages/evals/promptfoo.config.yaml` TODO row |
| 2.7 | **Exit: chat edits ≥ 90% on curated set** | **BUILD-ONLY** (set built; accuracy unmeasured without live models) | `0580c0c` W6-O + `cases/expanded/edits.yaml` |
| 2.8 | **Exit: command log replays to an identical document hash** | **MET** (vs mock engine, in-repo ×2 hash assert; real-engine confirmation owed to CI Rust job) | `80b715c` W7-G determinism assert; `3f01954` W2-J recovery-spine; `961b289` W6-M resume-once/replay; `347a536` W2-I WAL cursor |

**Phase 2 verdict: COMPLETE-BUILD — structure shipped (4 engine patch modules,
16 templates, 10/15 components, 67-brief suite, chat-edit set, brand tokens);
the percentage gates (85/90/70) and Rust-side green need a live environment.**

---

## Phase 3 — Freeform & collaboration (SCOPED)

§19 exit criteria: "§20 criteria 13–15; freeform eval subset ≥ 70% pass; API docs published."

| # | Criterion (§19) | Status | Evidence |
|---|---|---|---|
| 3.1 | Freeform composition + planner template-vs-freeform choice | **NOT-MET** (only eval cases force the freeform flag; no composer) | `packages/evals/cases/expanded/freeform.yaml` (§23.2/§24.3); planner seam `c95cfa3` W1-P |
| 3.2 | Comments with positions, notifications, version-compare UI via `document.diff` | **NOT-MET** (engine primitive + schema table only; no routes/UI) | `0a6efec` W3-G `agent_cmds/document_diff.rs`; comments table `4800ccf` W1-D |
| 3.3 | Presence (Centrifugo), run sharing, activity feed | **NOT-MET** | — (no code) |
| 3.4 | Public API keys + docs + OpenAPI spec; webhooks `run.succeeded`/`export.ready` | **PARTIAL: BUILD-ONLY** — OpenAPI 3.1 + docs published in-repo (`416c275` W4-O, `docs/api/`); API-key auth designed (ADR-0003); product webhooks **NOT-MET** (only `/v1/webhooks/stripe` exists) | `apps/gateway/src/openapi.ts`; `eaf06e4` W4-N/R |
| 3.5 | PSD export with fidelity report; large-canvas tiers; export presets | **NOT-MET** (PSD shipped as experimental without fidelity report; no large-canvas tiers/presets) | `9fe4a11` W2-N preview/export processor (psd experimental row) |
| 3.6 | **Exit: §20 #13–15** | #13 **BUILD-ONLY** (recovery code + tests; the 60 s wall-clock bound needs a live kill drill); #14 **BUILD-ONLY** (suite built, live-run + human review owed); #15 **BUILD-ONLY** (obligations + review done; `cargo test … panic_hunt` runs in CI's Rust job) | see `docs/phases/acceptance-matrix.md` rows 13–15 |
| 3.7 | **Exit: freeform eval subset ≥ 70% pass** | **NOT-MET** (subset exists ×2 cases; no freeform path to score) | `cases/expanded/freeform.yaml` |

**Phase 3 verdict: SCOPED OUT of this build except primitives (document.diff,
OpenAPI/API surface, storage, freeform eval seeds). Honest gap vs §19.**

---

## Phase 4 — Production hardening (SCOPED)

§19 exit criteria: "paid beta launched; ≤ 1% failed runs; p95 run latency within
tier budgets; restore drill passed; zero blockers open."

| # | Criterion (§19) | Status | Evidence |
|---|---|---|---|
| 4.1 | Multi-box scaling, load tests, chaos drills | **NOT-MET** (no load/chaos harness in repo; needs live fleet) | — |
| 4.2 | Observability dashboards + alerts + cost guardrails; on-call runbook | **BUILD-ONLY** (stack chosen ADR-0005; runbooks RB-01…RB-08 authored with §22 alert→procedure mapping; live dashboards/alerts need the box) | `docs/adr/0005-observability.md`; `docs/runbooks/RB-01…08`; `52f120c`+`35f3827` W4-Q deep-health + audit |
| 4.3 | Security review (authz matrix tests, upload fuzzing, prompt-injection suite), pen-test checklist, license audit | **MET** (repo-side) — authz/upload/injection suites + license checker; pen-test itself needs humans | `apps/gateway/tests/integration/rbac-matrix.test.ts`; `120f61b` W2-O upload validation + `packages/storage/tests/validate.test.ts`; `91c8ded` W6-K injection guards + tool gate (97 tests); `7f776e4` W1-R license checker |
| 4.4 | Billing edge cases: dunning, refunds, credits expiry display, tax, invoices | **BUILD-ONLY** (refunds + idempotency in domain; dunning/tax/invoices **NOT-MET**) | `2b6d0a4` W1-N; `ledger-flow.test.ts` refund rows |
| 4.5 | Onboarding: 5-minute first-success, demo project, gallery, docs, video; pricing page; support inbox | **NOT-MET** (marketing shell + demo script exist; funnel/instrumentation absent) | `fc6fac2` W1-K web shell; `demo-coffee.mjs` as the demo path |
| 4.6 | **Exit: paid beta; ≤1% failed runs; p95 within budgets; restore drill passed; zero blockers** | **NOT-MET** — unmeasurable without a live environment; restore scripts authored but the drill never ran | `dc191c6` W1-L backup/restore scripts (drill owed, RB-06) |

**Phase 4 verdict: SCOPED OUT of this build. Code-level hardening pieces
(recovery, guards, license/CI, runbooks) landed with earlier phases; the
operational gate needs a live box and is honestly open.**

---

## Environment-debt ledger (what a live box must run to close BUILD-ONLY rows)

1. Boot the `local` Compose stack (W1-L scripts); run `pnpm demo:coffee` against
   the real `photocraft-cli` binary; wire the `demo:coffee` package.json alias.
2. CI Rust job: `cargo check`/`test`/`clippy` + `panic_hunt -- --ignored` over the
   engine-patch series (`engine-patches/tests/README.md`).
3. Register the expanded eval cases in `promptfoo.config.yaml`; run the suite
   with paid model keys (never free tiers, §1.5-6) to score the 85/90/70 gates.
4. Stripe test-mode subscription E2E on staging (checkout → webhook → ledger).
5. Kill-drill the run path (engine kill mid-execution) for the §20 #13 60 s bound;
   run RB-06 restore drill; load-test for p95 + ≤1% failed runs.
