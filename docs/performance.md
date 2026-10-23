# Performance record — measured numbers and waivers

BUILD_PLAN §6: "If a budget cannot be met, record the measured number, the cause, and an
explicit waiver. Do not silently relax it." This file is the ledger. Reference machine for
future numbers: the §6 spec box (8-core, 16 GB, integrated GPU+, Chrome stable, 100 Mbps);
today's numbers come from the build box (2 cores, 4 GB RAM) and are flagged as such.

## Editor wasm transfer (budget: < 18 MB compressed)

| Measurement | Value | Where | Date |
|---|---|---|---|
| `effectcraft_web_bg.wasm` uncompressed | 76.2 MB | `apps/web/public/editor/` | 2026-10-22 |
| brotli q8 (the production path: Caddy `encode zstd br`) | **14.5 MB** — **within budget** | build-box measurement | 2026-10-22 |
| gzip fallback (dev servers, no brotli) | 19.8 MB — over budget without brotli | build-box measurement | 2026-10-22 |

Causes of the large uncompressed size vs upstream's ≈58 MB note (editor/UPSTREAM.md):
`wasm-opt -O2` is skipped (binaryen absent on the build box) and the release profile was
built with `codegen-units=16` instead of upstream's `1` (env override; the 4 GB build box
OOM-kills rustc at `codegen-units=1` on heavy crates). Thin LTO was kept.

**Waiver/rebuild note:** the committed dist is the best this box can produce. A re-tuned
rebuild (`codegen-units=1`, `lto="thin"`, `wasm-opt -O2`) on a ≥16 GB CI box should land
≈58 MB uncompressed / ≈10-12 MB brotli and is owed before the private beta gate. The
committed artifact is re-buildable from the pin + patch 0001 at any time.

## Editor ready time (budgets: < 6 s warm, < 12 s cold)

Not yet measured — needs a browser with WebGPU/WebGL2 on the reference machine; the build
box has no display. Owed with the first staging deploy (M3 exit).

## Everything else

Unmeasured. Baseline capture (landing, dashboard, chat first token, apply, render) is
owned by the M10 hardening milestone; see BUILD_PLAN §6 for the full budget table.

## Wave-3 on-box measurements (2026-10-23)

Measured on the build box by `scripts/perf/` (reusable, one-invocation scripts; raw
samples in `scripts/perf/results/*.json`, append-only): the e2e/README §5b dev stack —
gateway (`tsx` dev process, `MOCK_MODEL=true`, seeded SQLite twin `.local/e2e.db`) +
`next dev --port 3000`, browser = Playwright's chromium at `http://localhost:3000`.
Sign-in is the real better-auth form as the seeded demo user. p75/p95 = nearest-rank.

### §6 budget ledger

| Budget (BUILD_PLAN §6) | Measured (n, method) | Verdict |
|---|---|---|
| Editor ready, warm cache < 6 s | **p75 2,829 ms** (n=5 same-session reloads; nav-start → `[data-editor-phase="open"]` read in-page via `performance.now()`) | **MET** — but see caveats; n=5 is small |
| Editor ready, cold < 12 s | **p75 8,230 ms** (n=5 fresh-context loads — *cold-ish*: dev server + OS caches already warm, empty HTTP cache only) | **MET** (cold-ish, not a true cold boot; n=5) |
| Editor wasm transfer < 18 MB | 14.5 MB brotli (2026-10-22, unchanged above) | MET (existing measurement) |
| Editor memory (1080p project) < 1.5 GB | host-page JS heap 57.5 MB / chromium tree RSS 66–70 MB on the seeded *demo* comp | **NOT MEASURED for this row** — the budget scenario is a 1080p 20-layer comp on the reference box; recorded as a non-budget data point (host-context heap only; the wasm iframe's heap is not visible to the host page) |
| Editor playback 60 fps @1080p | — | UNMEASURABLE on this box (headless software GL, no GPU) — reference-machine row |
| Chat first token < 1.5 s p75 | — | **UNMEASURABLE here**: the model wire is `MOCK_MODEL=true` (canned script — timing it would measure the mock, not the model). Needs the deployed LiteLLM stack |
| Context assembly < 400 ms p75 | — | UNMEASURABLE here — a server-internal stage with no instrumentation (and the model wire is mock) |
| Plan validation < 100 ms p75 | — | UNMEASURABLE here — same (server-internal, uninstrumented) |
| Apply (`engine.batch`, ≤20 steps) < 300 ms p75 | version-upload POST `/v1/projects/prj_demo/versions` answered **201 at +2,058 ms** after the confirm click (n=1); card settles `data-status="failed"` | **OWED** — see "Apply" below: the m5 apply journey does not currently pass app-side (fix in flight by W3-C1), and engine.batch itself is un-instrumented |
| Preview frame (720p) < 2 s p75 | — | UNMEASURED — the M5-H preview panel is not thread-mounted in this environment (m5 spec run-3 note), so there is no user-visible preview frame to time |
| API read p95 < 300 ms | **p95 31.7 ms** (GET `/v1/projects`, n=30, authed, loopback; p50 5.3, max 36.8) | **MET** (loopback = floor for the over-network intent) |
| API write p95 < 600 ms | **p95 44.1 ms** (POST `/v1/projects/:id/presence` heartbeat, n=30, fresh Idempotency-Key per beat; p50 12.3, max 49.1) | **MET** (safe idempotent write; project/version/asset writes deliberately not measured — they mutate the seeded world) |
| Render queue start < 30 s p75 | not separately instrumented; bounded by W3-C3's end-to-end wall | **MET by bound** (see Render below) |
| 1080p 10 s render < 5 min (reference box) | W3-C3 measured a **2 s** 1080p comp, not 10 s | **MET (proxy)** — see Render below |
| Landing LCP/INP/CLS, Dashboard TTI | — | UNMEASURED — needs a production build + 4G throttling / field data; still owed to M10/staging |
| Crash-free sessions > 99.5% | anecdote only: 13/13 editor loads reached `open` with zero page errors (1 benign console.error in warm reloads: W3-C1's temporary `[W3C1-DIAG]` autosave instrumentation) | UNMEASURED — a telemetry/field metric, not lab-measurable |

### Editor ready — detail

Cold-ish series (fresh browser context = empty HTTP cache; the dev server, gateway and
OS page cache were already warm from the untimed bootstrap load): samples 7,766.8 /
7,922.4 / 8,019.4 / 8,230.3 / 8,576 ms → p50 8,019, p75 8,230. Warm series (one
context, reloads): 2,268.1 / 2,450 / 2,803.1 / 2,829.4 / 3,937.6 ms → p50 2,803,
p75 2,829. The readiness signal is the app's own
`[data-testid="editor-host"][data-editor-phase="open"]` — the exact marker the m5 e2e
journey waits on (wasm bridge ready → project download → `file.open` + lease). n=5 per
series is small: p75 here is the 4th of 5 samples; treat the verdicts as indicative,
not statistical. Evidence: `scripts/perf/results/editor-ready-2026-10-23T20-02-04.json`.

### API — detail

One untimed warmup per endpoint, then 30 timed requests each, client-observed on
loopback against the live gateway (`GET /health` context: p95 5.3 ms). The read rides
real auth (better-auth session cookie) + workspace middleware + repos on the SQLite
twin db. Evidence: `scripts/perf/results/api-latency-2026-10-23T19-48-38.json`
(measured 19:48 UTC by this task's first attempt on side port :8791 — the numbers are
gateway-processing floors; the parallel-fleet etiquette note is in the script header).

### Apply — owed, with the honest on-box picture

The m5 high-risk apply journey (scripted SSE plan — the model wire is mock and is
deliberately intercepted, so timing is not contaminated by it) does **not** currently
pass app-side: the engine batch + version upload land (POST `/v1/…/versions` → 201,
+2,058 ms after the confirm click, n=1), but the follow-up `POST /v1/runs/:runId/apply`
report 404s ("run not found" — the scripted runId has no server-side run row) and the
plan card settles `data-status="failed"` ("The edit didn't apply — nothing changed.
run not found"). Separately, the sibling W3-C1 fix for the W2-B8 triage #1 save bug
(apply.ts/autosave.ts) landed **mid-measurement** — the first 3 runs (20:03–20:06 UTC)
saw a client-side exception with no version POST at all; the 20:07 run saw the 201.
engine.batch alone is un-instrumented, and the 300 ms budget row targets it on the
reference machine. **Verdict: OWED** — re-measure with `scripts/perf/apply-timing.mjs`
after W3-C1 lands (and after the scripted-harness applyRun 404 is addressed, e.g. a
run row the harness can report against). Evidence:
`scripts/perf/results/apply-timing-2026-10-23T20-03-47.json` (3 runs, pre-fix) and
`…T20-07-18.json` (1 run, post-fix, with page-error + mutation capture).

### Render — citing W3-C3's proof (not re-measured here)

W3-C3 (worklog 2026-10-23) drove one real v1-loop render on this box's Postgres:
queue → worker claim → `effectcraft-cli` 0.13.0 → MP4 **h264 1920×1080 @30, 60 frames
(2.000 s comp), wall 14,593 ms, 1,836,181 bytes**, ledger netting exactly the quoted
280,000 µc (evidence: `.local/v1-loop-proof/proof.json`); the worker golden 1080p mp4
runs at **11.65 s**. The §6 row is a **10 s** 1080p comp on the *reference* box, so
this is a proxy: a 2 s comp at 14.6 s end-to-end wall (which *includes* queue start,
hydration and ledger settle) extrapolates nowhere near 5 min for 10 s of comp, but the
direct measurement stays owed to the reference machine. Queue start is not separately
instrumented — it is bounded by the 14.6 s end-to-end wall, comfortably under the 30 s
budget.

### Caveats (all Wave-3 numbers)

- `next dev` (Turbopack, dev overlays) + `tsx` gateway — no production bundling/minify;
  editor-ready numbers are inflated vs a production build.
- Shared sandbox CPU (2 cores) with parallel fleet agents active; headless software GL.
- Loopback network — API numbers are floors for the over-network budget intent.
- n=5 (editor) and n=30 (API) — small samples; nearest-rank percentiles.
- The prior ERR_CONNECTION_REFUSED flakiness seen by this task's first attempt is
  encoded in `scripts/perf/boot-and-measure.sh`: it waits out (never kills) a parallel
  agent's live stack, because Next 16 allows only one dev server per app directory.

