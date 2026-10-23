> **HISTORICAL — pre-pivot (PhotoCraft era).** Superseded by ADR-0006 and the
> EffectCraft build plan. Kept for audit trail; nothing here describes the
> current product. Current milestone evidence: `docs/phases/M0.md`–`M9.md`.

# Acceptance Matrix — §20 beta gate — FINAL (W10-J, 2026-10-21)

Supersedes W7-K's v1 (`34d4eae`). Evidence frozen at `d0ef7cb` (139 commits, W10
landed around it). Final taxonomy (maps to v1 as MET → **EVIDENCED-BUILD**,
BUILD-ONLY stays **BUILD-ONLY**, NOT-MET → **OPEN**):

- **EVIDENCED-BUILD** — in-repo automated evidence directly asserts the criterion
  (real adapters + the protocol-faithful mock engine where a real process is
  barred on this box, AGENTS.md). A live env re-runs the same suite at full
  fidelity: confirmation, not first proof.
- **BUILD-ONLY** — code complete, unit/fake-tested, but the criterion itself is
  only demonstrable in a live environment; the **exact command/script** is listed.
- **OPEN** — repo-side gap (wired-owe or not built). No §20 row is OPEN as a
  whole; the gaps are itemized G1–G10 below.

| # | Criterion (§20) | Status | In-repo evidence | Live env must demonstrate |
|---|---|---|---|---|
| 1 | New user signs up, creates workspace, invites second member (editor); member sees the same project list | **BUILD-ONLY** (in-repo partial: fake auth sessions) | `apps/gateway/tests/integration/signup-flow.test.ts` (create → owner row → trial grant in REAL ledger → invite editor → accept → same project list → member can run); `apps/gateway/tests/integration/rbac-matrix.test.ts`; `/v1/invites/*` in `apps/gateway/src/openapi.ts`; ADR-0003. Live Better Auth server + email verification are outside the fake-session seam (header says "partial"); Playwright layer not yet authored (G7) | Boot (`./infra/scripts/migrate.sh` + `./infra/scripts/deploy-v2.sh`), then two browser sessions: sign up → verify email → create workspace → invite editor → accept → assert both project lists identical (§21 E2E scripted once authored) |
| 2 | Upload JPEG/PNG (25 MB cap); EXIF stripped; 60 MP bomb rejected with clear error | **BUILD-ONLY** + repo gap **G1** | `packages/storage/src/validate.ts` + `packages/storage/tests/validate.test.ts` (magic sniff, dims, polyglot/bomb guards, 25 MB cap — table-tested); `apps/gateway/src/routes/uploads.ts` (persisted `stripExifPlan`); `apps/gateway/tests/uploads.test.ts`; `120f61b` W2-O. Worker-side byte re-slice is **not wired** (G1) — EXIF half would fail today | `curl -F "file=@photo.jpg" "$BASE/v1/uploads"` (≤25 MB) → asset library; fetch stored bytes → `exiftool` shows no EXIF (only after G1); 60 MP bomb fixture → typed 4xx error, never a 500/stack |
| 3 | Document from template → layered `.pcraft` with named layers/groups (no `Layer N`) | **EVIDENCED-BUILD** (vs mock engine; real-binary render = live) | `apps/worker/scripts/demo-coffee.mjs` (`.pcraft` read back, named-layer asserts, hash-pinned); `apps/worker/tests/spine/engine-spine.test.ts`; template_apply `e97268e` W5-C (§7.4); `engine-patches/template_cmds/` (manifest/validate/apply/fill); catalog `17a936d` W4-J | `pnpm demo:coffee` with `ENGINE_BINARY_PATH` → host-built `photocraft-cli`: same asserts vs real binary; reopen in the editor → named layers/groups |
| 4 | User types the coffee brief and picks the standard tier | **EVIDENCED-BUILD** (API path; browser pick = live supplement) | Golden brief `packages/evals/cases/creates.yaml` (§24.1 verbatim); runs API reserve→queue idempotent `b20042f` W4-G; tier routing `46fd1bf` W6-H; tier credits `2b6d0a4` W1-N (`packages/billing/tests/{plans,policy}.test.ts`); `apps/worker/tests/queues.test.ts` | Type the brief in the web editor, pick standard, submit → charged 2 credits (§5.2 1/2/5), run accepted |
| 5 | UI streams plan → steps → previews → verdict, finishes ≤ 5 min with preview | **BUILD-ONLY** | SSE backfill+live+resume+resync `3e07ada` W4-H; web shell + SSE helper `fc6fac2` W1-K; api client sse/hooks `dd81566` W8-O; web unit tests (api/tiers/timeline) `107f6e8` W8-T; cached preview `f07b6b0` W4-L; run events `seq` `e4f2ceb` W1-E. Wall-clock bound needs live models (G6) | Browser run with live paid models: progress streams continuously; wall-clock submit → verdict+preview ≤ 5 min |
| 6 | Editable text layers matching the brief, placed photo, brand colours, validator zero blockers | **EVIDENCED-BUILD** (brief-match quality is #14's live question) | Run validator `5f427b3` W6-D; critic + 2-cycle repair `acf120f` W6-E / `e1475f1` W6-F; brand tokens `ba3bffc` W7-F (§7.5 fallbacks, §10.2 font gate); demo validator step computes WCAG contrast; §25 no-baking law in template_apply | Live-model run of the golden brief finishes with validator zero blockers (counted inside #14's gate) |
| 7 | One undo reverts the entire agent run; redo restores | **EVIDENCED-BUILD** | **WAL/undo/transactions**: `engine-patches/agent_cmds/` (begin/commit/rollback single-undo `621c45a` W3-F); transaction manager + WAL + checkpoints `9b8339b` W6-I; undo/redo routes + WAL `e3339e1` W4-K; `document.diff` `0a6efec` W3-G; run/event schema `e4f2ceb` W1-E; WAL replay in `apps/worker/tests/spine/recovery-spine.test.ts`; web undo/redo flow `f59a1fb` W8-P | Undo/redo from the web UI vs the real engine → document hash returns to pre-run state, redo restores (real-binary confirmation) |
| 8 | Chat-edit one element costs quick-edit tier; diff shows ≤ 2 changed layers | **BUILD-ONLY** (correctness on live models unmeasured, G6) | Chat-edit classifier `0580c0c` W6-O (cheapest-action routing, tier downgrade/raise guard, 81 tests); chat-edit eval set ×20 at 90% gate `b16127b` W7-J (`packages/evals/cases/chat-edits/` + `packages/evals/chat-edits.config.yaml`); diff primitive `0a6efec`; quick-edit cases `packages/evals/cases/expanded/edits.yaml` | `npx promptfoo eval -c packages/evals/chat-edits.config.yaml` with live provider keys → ≥ 90%; plus one UI "make the subhead smaller" run where `document.diff` reports ≤ 2 changed layers |
| 9 | Export produces PNG at requested size + `.pcraft` reopening with same layer tree (hash-verified replay) | **EVIDENCED-BUILD** | Export processor `9fe4a11` W2-N (png/jpg/pcraft, psd experimental); export routes `f07b6b0` W4-L; demo hash determinism ×2 spawn passes `80b715c` W7-G (digest pinned vs mock); WAL resume-once `347a536` W2-I + `apps/worker/tests/spine/recovery-spine.test.ts`; `apps/worker/tests/preview.test.ts`; web export flow `f59a1fb` W8-P | Export from UI; `.pcraft` reopens in the real editor with identical layer tree; byte-hash equal across two real-binary spawns |
| 10 | Credit ledger shows reserve/commit; balances match; failed run refunds; same idempotency key never charges twice | **EVIDENCED-BUILD** | **Ledger suites**: `apps/gateway/tests/integration/ledger-flow.test.ts` (reserve `−A` / commit `A−charge` / refund rows over the REAL `billingFromLedger` adapter via `tests/integration/harness.ts`; unique-key index mirrored; failed run refunds; trial 30); `packages/billing/tests/{ledger,plans,policy}.test.ts` + `fakes.ts` (`2b6d0a4` W1-N); append-only schema `8ee9242` W1-F; Stripe webhook money-once pinned by W9-A `015d86d` (`apps/gateway/src/services/billing-complete/` + its tests) | Nothing new to script in-repo; a Stripe test-mode subscription (checkout → webhook → one ledger grant) exercises the same path — next-action 5 |
| 11 | Second workspace's user cannot read/list/command/export the first workspace's documents or assets | **EVIDENCED-BUILD** | **Cross-tenant suite**: `apps/gateway/tests/integration/cross-tenant.test.ts` — lookups stay 404 (never confirm existence), typed `cross_tenant_denied` on resolved resources, both directions with OWNER tokens, storage-key tenant guard across all five object namespaces; `rbac-matrix.test.ts`; guard `45424c7` W4-C; engine-pool tenant-checked lookups `c57c0c3` W1-J | Re-run `pnpm --filter gateway test` on the booted stack (compose-backed Postgres if wired); no manual drill beyond the suite |
| 12 | Every run records model, tokens, cache hits, cost; dashboard shows daily cost per workspace + platform COGS/revenue | **BUILD-ONLY** + repo gaps **G2/G3** | Run telemetry columns `e4f2ceb` W1-E; budgets/model routes/usage `c95cfa3` W1-P; usage rollups + credits routes `629f5e1`/`c6c6b8a` W4-M; metering (micro-USD cost model, usage accumulator, daily attribution) `efb73b1` W9-C in `packages/agent/src/metering/` + tests; metrics routes `apps/gateway/src/routes/metrics.ts` + `apps/worker/src/metrics.ts` (W9-G); dashboards + alert rules `dc4b417` W9-F, compose obs profile `b49667b` W9-M (`infra/obs/`); `apps/worker/tests/metrics.test.ts` | `docker compose --profile obs up -d` → demo traffic → Perses dashboards render per-workspace daily cost + COGS; Prometheus scrapes gateway:3001 + worker:9876. **Requires G2/G3 closed first** |
| 13 | Run killed mid-execution (engine killed) recovers within 60 s or fails cleanly with a refund; document consistent | **BUILD-ONLY** (drills in-repo at mock fidelity; 60 s wall-clock + real kill need the live engine) | **Recovery drills**: `apps/worker/tests/spine/recovery-spine.test.ts` (`3f01954` W2-J — mock-engine kill, WAL replay, resume-once/fail-clean); `apps/worker/tests/recovery-wiring.test.ts` (`961b289` W6-M); `apps/worker/tests/run-manager/{happy-path.test.ts,fake-deps.ts}` (`d8e4dd3` W6-N); `apps/engine-pool/src/recovery-contract.md`; refund rows in `ledger-flow.test.ts`; scripted drill `infra/tests/chaos/kill-engine-midrun.mjs` (W9-L `55c588d`, + `kill-worker.mjs`) | `node infra/tests/chaos/kill-engine-midrun.mjs` against booted compose + real engine: kill lands mid-run → resume ≤ 60 s or clean typed failure + refund row + document hash consistent |
| 14 | Eval suite (≥ 50 briefs) passes at agreed threshold on CI prompt/model versions; human-reviewed sample confirms critic isn't gaming | **BUILD-ONLY** | **Eval suites**: 67 golden briefs — `packages/evals/cases/` (`creates/edits/operations/failures.yaml`, `chat-edits/`) + `packages/evals/cases/expanded/` (`creates/edits/operations/budget/clarify/freeform/injection/templates.yaml`; W7-D `097c56e`/`bd22702`); full-suite promptfoo config + chat gate wired `f34482f` W7-J (`packages/evals/promptfoo.config.yaml`, `chat-edits.config.yaml`) — **resolves v1's registration owe**; gate `packages/evals/scripts/eval-gate.mjs` (0.85); anti-gaming pair validator `5f427b3` + critic `acf120f`. Pass rate needs paid live models (G6); human review needs humans (G8) | `npx promptfoo eval -c packages/evals/promptfoo.config.yaml` on pinned live models → `node packages/evals/scripts/eval-gate.mjs` green (≥ 0.85); then human review of a sampled verdict set vs rubric |
| 15 | `cargo test -p photocraft-engine --test panic_hunt -- --ignored` green for new engine commands; adversarial params never panic; gateway returns friendly errors | **BUILD-ONLY** (needs Rust toolchain — CI `engine-patches` job, G5) | Obligations table `engine-patches/tests/README.md` (`7a20eb9` W3-H); golden-rules review `engine-patches/tests/review-log.md` (`82cb863` W3-L); four patch modules (`template_cmds`, `component_cmds`, `layout_cmds`, `agent_cmds`); upstream guide `engine-patches/docs/upstream-pr-guide.md`; gateway flat error envelope `7133e91` W1-H + `apps/gateway/tests/middleware.test.ts`; no-throw contract `c95cfa3`/`91c8ded` | Apply `engine-patches/` to the pinned vendor (`872748fb`, ADR-0001) → `cargo test -p photocraft-engine --test panic_hunt -- --ignored` + `cargo clippy -D warnings` green; adversarial params through live gateway → flat friendly envelope, never stack/500 |

**Final score: EVIDENCED-BUILD 7** (#3, #4, #6, #7, #9, #10, #11 — code + in-repo
suites) **· BUILD-ONLY 8** (#1, #2, #5, #8, #12, #13, #14, #15 — exact live
commands above) **· OPEN 0 whole rows.**

## Honest gap list (repo-side; fixable without the live env)

- **G1 (#2):** worker-side EXIF byte re-slice not wired — `stripExifPlan` is
  persisted, bytes unmodified. The live EXIF check fails today. Owner: worker
  upload pipeline. Must close before next-action live checks.
- **G2 (#12):** obs metric emitters are unprefixed (`runs_total`,
  `run_duration_seconds`, …) while dashboards/alert rules reference `studio_*`
  series — dashboards stay data-less until one side adopts the other
  (W9-D/W9-F naming reconciliation).
- **G3 (#12):** gateway `/metrics` route complete but NOT mounted in `app.ts`
  (bootstrap owner); worker metrics server must bind 0.0.0.0 for compose scrapes
  (W9-M flag).
- **G4:** `pnpm-lock.yaml` uncommitted — Dockerfile frozen-lockfile branch
  degraded; CI reproducibility risk (W9-I).
- **G5:** CI workflows are staged OUTSIDE the repo (`infra/ci-staged/{ci,
  engine-patches,license-check}.yml`, W1-M PAT scope) — **CI has never run**;
  every "CI verifies" statement in this repo is forward-looking. Enabling it is
  next-action 2.
- **G6 (#5/#8/#14):** thresholds (≤5 min, ≥0.90 chat, ≥0.85 full suite) are
  unmeasurable without paid live-model keys; the CI default provider is the
  deterministic mock-planner (zero cost, §1.5-6).
- **G7 (#1/#5):** §21's Playwright E2E layer is not yet authored — the live
  demonstrations for #1/#5 are manual-browser sequences until it exists.
- **G8 (#14):** the human-review half (critic not gaming) cannot be scripted;
  reviewers + rubric must be scheduled for the beta gate.
- **G9:** 5 of 15 spec components still owed (10 built; incl. `qr-code@1`
  flagged by W7-B for event-flyer's badge slot).
- **G10:** Phase 3 freeform/collab surfaces not built (freeform composer +
  planner template-vs-freeform choice, comments routes — table exists,
  presence, run sharing, product webhooks, PSD fidelity report) — outside §20
  rows; tracked in `docs/devlog.md` Phase 3 status.

Live-env command legend: `BASE` = `https://APP_DOMAIN` or compose-internal;
boot = `./infra/scripts/migrate.sh` → `./infra/scripts/deploy-v2.sh` →
`./infra/scripts/smoke.sh` (W9-J `b9d6000`). Runtime debt common to all
BUILD-ONLY rows: `docs/phases/phase-exit-audit.md` §"Environment-debt ledger".
