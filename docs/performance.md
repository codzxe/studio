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
