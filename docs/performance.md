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
| `effectcraft_web_bg.wasm` uncompressed — re-tuned rebuild | **49,353,339 bytes (47.1 MiB / 49.4 MB)**; dist total 49,590,279 bytes (≈49.6 MB) | `apps/web/public/editor/` | 2026-10-24 |
| brotli q8 — re-tuned rebuild | **13,431,119 bytes (12.8 MiB / 13.4 MB)** — **within budget** | build-box node-zlib re-measurement | 2026-10-24 |
| gzip fallback — re-tuned rebuild | 17,835,959 bytes (17.8 MB) — **now also within budget** (GNU gzip -9 CLI: 17,708,918 bytes) | build-box measurement | 2026-10-24 |

The 2026-10-22 rows are kept as history — they measured the superseded cg16 artifact
(re-derived 2026-10-24 from the old git blob for this ledger: 76,155,501 bytes →
14,547,137 bytes brotli q8 / 20,783,682 bytes gzip). Cause of that size: `wasm-opt -O2`
was skipped (binaryen absent on the build box) and the release profile was built with
`codegen-units=16` instead of upstream's `1` (env override; the 4 GB build box
OOM-kills rustc at `codegen-units=1` on heavy crates). Thin LTO was kept.

**Re-tune done 2026-10-24 — the owed rebuild landed, and on this box.** Rebuilt from
the same pin `9db7f3b2` + patch 0001 with the profile's true `lto="thin"` +
`codegen-units=1` (no cg16 override this time) plus the xtask's `wasm-opt -O2` pass
(binaryen 125, absent at the first build): Rust 1.99.1 (same as the original),
wasm-bindgen-cli 0.2.129 (crate pin `=0.2.129`). Result: uncompressed −35.2%
(76,155,501 → 49,353,339 bytes — better than the old waiver's ≈58 MB estimate),
brotli q8 −7.7% (14,547,137 → 13,431,119 bytes = 12.8 MiB — a hair above the old
waiver's ≈10-12 MB estimate, comfortably inside the binding < 18 MB budget), and the
< 18 MB budget now holds even on the gzip fallback path. The
re-tuned dist is committed and was boot-verified live in Chromium the same day:
`window.effectcraft` present, `info().version` "0.13.0", `window.effectcraftLoad`
wasmMs ≈ 3,198 / readyMs ≈ 3,433, `crossOriginIsolated` true, zero console errors,
zero failed requests (`scripts/e2e-probe-editor.mjs`, the §5b stack). Over the same
dist `chat.spec.ts` passed 5 with 1 skip (editor-unchanged pixel baselines green) and
`m5-agent-edits` went 3/4 — the m5-readonly pixel baseline is owed to W1-E and is not
claimed here. The superseded artifact stays re-buildable from the pin + patch 0001 +
the `scripts/build_editor_web.sh` cg16 recipe.

## Editor ready time (budgets: < 6 s warm, < 12 s cold)

Reference-machine measurement still owed (WebGPU/WebGL2, first staging deploy, M3
exit). On-box data points, same caveats as the wave-3 numbers below (dev server,
headless software GL, shared 2-core box):
- 2026-10-23, against the old 76.2 MB dist: p75 2,829 ms warm / 8,230 ms cold-ish
  (the wave-3 section below — measured before the re-tune, so it does not describe
  the committed dist).
- 2026-10-24, against the re-tuned 49.4 MB dist — first boot smoke, n=1
  (`scripts/e2e-probe-editor.mjs` through the §5b stack): `window.effectcraftLoad`
  wasmMs ≈ 3,198 (module fetch + compile) / readyMs ≈ 3,433 (until the app runs),
  `info().version` "0.13.0", `crossOriginIsolated` true, zero console errors, zero
  failed requests. Different readiness marker than the wave-3 rows
  (`window.effectcraftLoad` vs the app's `data-editor-phase="open"`) — indicative
  only, not a budget verdict.
- 2026-10-25, same dist + the W3-D app-start prewarm (see the next section): p50
  4,547 ms warm / 10,003 ms cold-ish / 6,687 ms prewarmed (n=3 per series; the
  box was more loaded than the 10-23 round — cross-round comparisons are
  indicative only). Evidence:
  `scripts/perf/results/editor-ready-2026-10-25T06-47-31.json`.

## App-start editor prewarm (W3-D, 2026-10-25)

The user-facing complaint this addresses: "whenever the user opens the editor it
should not load there — it should load at start itself." The 49.4 MB engine
download + compile used to start only when the editor route mounted (the
capability gate's "supported" verdict), i.e. INSIDE the editor-open critical
path; and the hub/history "Open editor" CTAs were plain `<a>` links — a full
page reload that threw away any warmed module.

The mechanism (all app-side; the frozen dist is untouched):

1. **The shell prewarms at app start** — `AppShell` mounts the invisible
   `EditorPrewarm` on every authenticated surface (dashboard, projects, billing,
   hub), which probes the GPU once (verdict cached and shared with the editor
   route's gate — one adapter request per session) and, only on a capable
   machine, starts `warmEditorWasm()` (the 49 MB download + compile, published
   on `window.__studioEditorWasm`) plus a one-shot prefetch of the dist's small
   boot files (index document — the iframe's exact `/editor/?empty` URL, glue
   JS, worker, audio-worklet, snippet host.js — bodies drained so the HTTP
   cache keeps them) into the HTTP cache.
2. **The CTAs are client-side** — hub/history/queue-card "Open editor" are
   `next/link` `<Link>`s now: no full reload, so the prewarmed compiled module
   survives the navigation and the iframe ADOPTS it (zero wasm network
   traffic in the editor-open path — verified in the evidence file: no second
   `.wasm` resource entry in any prewarmed run); the route is also prefetched
   by the link while it sits in the viewport (production).
3. **Everything is a pure accelerator** — unsupported machines fetch nothing,
   and any prewarm failure falls back to the dist's own fetch path.

Measured (n=3 per series, 2026-10-25, same §5b dev stack + caveats as wave-3):

| Series | p50 | What it means |
|---|---|---|
| cold-ish | 10,003 ms | direct editor URL, empty HTTP cache — the old experience |
| warm | 4,547 ms | same-session reload of the editor URL |
| prewarmed | **6,687 ms from the final click** | /w first, engine download+compile done **while browsing (2,311–2,425 ms)**, then the real click path — the user never waits for the 49 MB module |

The prewarmed phase breakdown (`scripts/perf/prewarm-diagnose.mjs`, n=2): click →
editor-host mounted 705–759 ms (dev-mode unbundled chunks; production serves the
prefetched bundle) → iframe init 4,392–4,725 ms (glue eval + GPU pre-flight +
**wasm instantiation of the adopted module** — the dominant remaining cost, CPU-
bound) → engine ready +200 ms → project open +~1.7 s (`file.open` + lease). Known
tail: instantiation is inherent to the dist's `init()` (compilation ≠
instantiation; the glue instantiates with its own imports); moving it off the
critical path would need dist-side changes (pre-instantiated module or a
pre-booted iframe architecture) — deliberately out of scope for W3-D.

On a real network the win is larger than on loopback: the 49 MB transfer
(~13.4 MB brotli in production) is fully removed from the editor-open wait and
spent on browsing time instead.

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
| Editor wasm transfer < 18 MB | **13,431,119 bytes brotli q8 (12.8 MiB / 13.4 MB)** — re-measured 2026-10-24 on the re-tuned committed dist (was 14.5 MB on the 2026-10-22 cg16 dist, see the top ledger); gzip fallback 17.8 MB now also within budget | **MET** (re-measured on the current committed artifact) |
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

