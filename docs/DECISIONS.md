# DECISIONS — binding rulings for the build fleet

These settle every ambiguity found in the docs during the W-R reader wave
(`docs/phases/gap/milestones.md` §Ambiguities). Where a doc conflicts with a ruling
here, **the ruling wins**. Cite as `DECISIONS.md D-n` in code comments where relevant.

| ID | Topic | Ruling |
|---|---|---|
| D-1 | Step caps (BP M5.2 "100 steps/2 MB/60s" vs PA §8.6 "20 plan steps" vs ECUX §4.3 "8 model steps") | Three different layers, all enforced: model loop ≤ **8 steps** per run (ECUX §4.3); `EditPlan` ≤ **20 steps** (PA §8.6); compiled batch ≤ **100 commands**, payload ≤ **2 MB**, plan validation ≤ **60 s** (BP M5.2). |
| D-2 | Render formats v1 | **MP4 (H.264) + PNG sequence only** (BP §12 default; scope-cut order §9). ProRes/GIF/WAV stay in contracts as future formats; worker rejects them with a typed error until enabled. |
| D-3 | Gateway shape | Hono standalone at `services/gateway`, mounted at `/v1` (as built in W2/W3). No migration to Next route handlers. |
| D-4 | Trial: plan vs state | **Trial is a subscription state** (`status='trialing'`, UI_DS §14), on the Starter row. Pricing page shows only the 3 paid plans. Trial entitlements come from `@studio/config`, not a plan row. Card-required wording per BP M6. |
| D-5 | Cmd/Ctrl+K collision | Inside the editor route → **inline edit** (ECUX §4.2); everywhere else → **command palette**. Cmd/Ctrl+I → agent mode inside the editor. Both forwarded from the iframe via the bridge shortcut seam. |
| D-6 | Autosave cadence | **30 s while dirty** (BP M3.4 wins) + explicit Cmd/Ctrl+S + after every agent apply + before close. |
| D-7 | Preview frame size | Max preview render **1280 px** on the long edge (768p-class budget stays: <2 s p75). |
| D-8 | studio-vision model | Declared in `models.ts`; **not offered in the v1 model picker**; reserved for the eval harness / vision critic. |
| D-9 | Editor-ready budgets | Measured at 50 Mbps (PA) and recorded in `docs/performance.md` with an explicit waiver; targets unchanged. |
| D-10 | localStorage keys | Keep ECUX-literal keys (e.g. `studio.chat.layout.v1`). The codename ban covers user-visible surfaces only; storage keys are not user-facing. |
| D-11 | Run-status enum drift | **DB wins** (it is the persistence source of truth and 42 tests are green on it): `running` stays; contracts' `streaming|applying` are renamed to DB statuses at the next contracts edit. Render status likewise aligns to DB (`completed`, not `succeeded`). |
| D-12 | Credits precision | Ledger stores **integer microcredits** (1 credit = 1,000,000 µc) — append-only INTEGER rows (as built). API/UI surface converts to whole credits with up to 2 decimals at the route boundary. No floats in ledger math. |
| D-13 | Legacy packages | `packages/billing` and any PhotoCraft-legacy module that fails typecheck get **archived to `archive/legacy-packages/`**, not fixed (real ledger lives in `@studio/db`). W-prep-1 archived `billing`. |
| D-14 | Member management | Member removal, role change and API-key endpoints are IN scope for the M1 tail (Wave A) — they were exit-criteria for M1, missing from W2/W3. |
| D-15 | Comments comp filtering | `compId` filter is **server-side** (query param), not client-side. |
| D-16 | Model provider on this box | Real runners speak the OpenAI-compatible HTTP contract (LiteLLM aliases `studio-fast`/`studio-smart`, per PA §7). Base URL + key come from env (`MODEL_BASE_URL_*` / `MODEL_API_KEY_*`). `MOCK_MODEL=true` stays the default in local `.env` and tests; production rejects it (as built). |
| D-17 | Editor dist on this box | **Real EffectCraft only — no mocks.** The Rust toolchain is installed and the wasm dist is built from the vendored pin (`cargo xtask web`) and committed to `apps/web/public/editor/` as a build artifact (size + date recorded in `editor/UPSTREAM.md`). **Single-repo policy (user directive, 2026-10-22): the vendored source at `editor/` IS the canonical source of truth** — patches are made directly in `editor/`, recorded in `editor/UPSTREAM.md`, and kept as diff artifacts under `editor/patches/` for provenance. The separate `codzxe/effectcraft` fork is **deprecated** (kept only as historical provenance for patch 0001; **deleted 2026-10-23** (verified gone — GET/DELETE return 404; the new token carries `delete_repo`)). |
| D-18 | Chat overlay chrome | Floating default over the editor; dockable sidebar + collapsed pill persist via localStorage (ECUX §2). Never restyle the editor; overlay may not render inside the iframe bounds when docked-left on narrow viewports — clamp instead. |
| D-19 | SSE chat disconnect semantics | A client/stream disconnect aborts the request signal → the gateway **cancels the live run and refunds the full reserve** (never a zombie hold). Reconnect with the same idempotencyKey + `Last-Event-ID` replays the (now terminal) log; the UI offers Retry. Mid-run LIVE resume would need a heartbeat/grace design — revisit only if UX demands (M4 closeout ruling). |
| D-20 | Ledger settle semantics | `balance = SUM(amount)`; the reserve already deducted N, so `settle(commit M)` must **release the FULL hold**: `refund = outstanding`, entries `reserve −N, commit −M, refund +N` ⇒ the run nets exactly −M. (The pre-M4 `refund = N − M` double-charged every completed run by M — fixed 2026-10-23 with unit + integration + E2E proofs; `planSettlement` is the single source.) |

## Ambiguity docket (resolved by the above)

Full docket with section pairs: `docs/phases/gap/milestones.md`. New ambiguities found
by any agent: append a row here in your worklog report; the main agent rules; do not
decide alone in code.
