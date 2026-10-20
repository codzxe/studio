# RB-01 — Run failure spike

- **Alert (§22):** run failure rate > 5 % over 15 minutes
  (metric: runs by status/tier — failed ÷ finished, 15-min window).
- **Owner:** on-call engineer · **Severity:** high (page) · **Spec:** §22 alerts, §3.4 failure semantics

## Symptom

Uptime Kuma / alerting fires: `run.failed` events exceed 5 % of terminal run states in a
15-minute rolling window. Users may report "run failed, credits refunded" in the UI or
on `GET /v1/runs/:id` (`run.failed` SSE event carries the actionable error, §13.2).

## Impact

Revenue-neutral but trust-critical: failed runs release/refund reservations (§14.2), so
money is safe; users lose 2–10 minutes per attempt and churn risk rises. If the cause is
systemic (engine, provider, deploy), every active workspace is affected within minutes.

## Diagnosis

1. Slice the failure rate by **tier** and by **error code** (`run.failed` payload /
   `agent_runs.error_code`, §12): one tier → tier-specific path (model routing, wall
   clock); one code → that subsystem.
2. Check correlation ids: sample failed `run_id`s and follow the pino chain
   `request_id → workspace_id → run_id → step_seq` (§22) into Langfuse — look for the
   first failed span (planner, tool, engine call, render, validator/critic).
3. Check §22 reliability metrics for the same window: engine restarts (> 3/h is RB-03),
   provider error rate (> 10 % is RB-04), queue age (> 2 min is RB-02), tool error rate,
   validator blocker rate (a bad prompt/model release fails at validation).
4. Recent deploy? Compare failure rate before/after the release tag; roll back first,
   debug second (§17.3 keeps the previous two images).

## Fix

- **Provider-caused:** apply RB-04 (circuit breaker should already have failed over; if
  all providers of a class are down, jobs stay queued — never fail the user's prompt
  forever, §17.4).
- **Engine-caused:** apply RB-03; crashed runs resume once from checkpoint (§3.4).
- **Deploy-caused:** `docker compose up -d --no-deps <svc>` at the previous image tag
  (§17.3 rollback), then reproduce in `staging` (§17.5) before re-shipping.
- **Single noisy workspace / prompt corpus:** rate-limit or cap via the daily cap
  (§14.2 r7) rather than disabling the platform; flag runs for prompt regression eval
  (§21).

## Verification

- Failure rate back under 5 % for two consecutive 15-min windows (§22 metric).
- A canary run (`pnpm demo:coffee` or the nightly canary, §17.3) passes end-to-end.
- Refund/ledger spot-check: failed runs released reservations exactly once
  (idempotency, §14.2 r6); no double refunds.

## Postmortem

Within 48 h: record window, blast radius (workspaces/runs affected), root cause, time to
detect/mitigate; file the fix issue; add an eval case or alert refinement if detection
lagged. Append an entry to `docs/devlog.md`; if a runbook step was wrong, fix this file
in the same change (§27 definition of done).
