# scripts/perf — on-box performance measurement scripts (BUILD_PLAN §6)

Reusable, honest, one-invocation measurement tooling. The numbers these
produce are recorded in `docs/performance.md` (the §6 ledger). Everything
here targets the **dev-mode stack** (`next dev` + the gateway's tsx dev
process on the seeded SQLite twin db) — results are flagged as dev-mode and
shared-CPU in the ledger; they are floors/inflated baselines, never
production-build claims.

## Files

| File | What it measures |
|---|---|
| `editor-ready.mjs` | §6 "Editor ready" — navigation start → the app's own readiness signal (`[data-testid="editor-host"][data-editor-phase="open"]`, the same marker the m5 e2e journey waits on). Cold-ish series (fresh context per run: empty HTTP cache) + warm series (same-session reloads). p75 of each via nearest-rank. Own chromium via the repo-root `playwright` package. |
| `api-latency.mjs` | §6 "API read p95" / "API write p95" — client-observed loopback latency against a live gateway: `GET /health` (context), authed `GET /v1/projects` ×N (the budget read), `POST /v1/projects/:id/presence` ×N (a deliberately safe, idempotent write — see the file header for why presence and nothing else). |
| `apply-timing.mjs` | §6 "Apply (engine.batch)" — the m5 high-risk apply journey, timed: scripted-SSE plan (model wire intercepted, so MOCK_MODEL never contaminates the timing) → confirm-Apply click → plan card `applied` + the `POST /v1/projects/:id/versions` upload. Records every mutation + page error, so an app-side failure (W2-B8 triage #1 / in-flight W3-C1 fix) lands in the evidence file as a terminal card status, not a silent zero. Currently the journey settles `failed` (applyRun 404 on the scripted runId) — the budget row is owed until that passes. |
| `boot-and-measure.sh` | The ONE-invocation wrapper (the sandbox reaps background processes between Bash calls): waits for `:3000`/`:8787` to free (parallel-fleet etiquette — it never kills another agent's live stack unless `PERF_FORCE_CLEANUP=1`), re-seeds `.local/e2e.db` (idempotent), boots the §5b stack, runs the named script, tears down. |
| `results/` | One JSON per run (samples + stats + caveats note). Append-only evidence. |

## Running a round (one shell invocation each)

```sh
cd /home/z/my-project
scripts/perf/boot-and-measure.sh api       # gateway only  → api-latency.mjs
scripts/perf/boot-and-measure.sh editor    # gateway + web → editor-ready.mjs
scripts/perf/boot-and-measure.sh apply     # gateway + web → apply-timing.mjs
```

Env knobs: `PERF_RUNS` (samples per series; default 30 api / 5 editor / 3 apply),
`PERF_WAIT_PORTS` (seconds to wait for a parallel agent's stack to free the
ports, default 300), `PERF_SKIP_SEED=1`, `PERF_BASE_URL` /
`PERF_GATEWAY_URL` (non-default targets).

## The boot recipe (copied from apps/web/e2e/README.md §5b)

Gateway `:8787` with `MOCK_MODEL=true` on `DATABASE_URL=file:.local/e2e.db`
(seeded demo world: `demo@studio.test` / `org_demo` / `prj_demo`), `next dev
--port 3000`, browser at **`http://localhost:3000`** — never `127.0.0.1` for
the browser: Next 16 dev treats any other origin as cross-origin and silently
never hydrates (W2-B8 root-cause; the dev `/v1/*` rewrite proxies to the
gateway, so no edge is needed).

## What is deliberately NOT measured here

- **Apply (`engine.batch`) p75 as a PASSING number** — attempted (see
  `apply-timing.mjs`): the journey currently settles `failed` app-side
  (scripted-run applyRun 404; the W3-C1 save-leg fix landed mid-measurement —
  the post-fix run shows the version upload landing at 201). The budget row
  stays OWED in `docs/performance.md` until the m5 journey passes.
- **Chat first token / context assembly / plan validation** — the model wire
  is `MOCK_MODEL=true` on this box; the budgets need the deployed LiteLLM
  stack (+ server-side instrumentation for the latter two).
- **Landing LCP/INP/CLS** — need 4G throttling and field data (CrUX-class),
  not a lab box.
- **Render queue start / 1080p 10s render** — CLI-e2e territory: W3-C3's
  v1-loop proof (14.6 s wall for a 1080p 2s comp; golden 11.65 s) is cited
  in `docs/performance.md` rather than re-measured here.
