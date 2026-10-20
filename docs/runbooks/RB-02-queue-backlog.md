# RB-02 — Queue backlog

- **Alert (§22):** queue age > 2 minutes (metric: queue depth and age, per queue).
- **Owner:** on-call engineer · **Severity:** high · **Spec:** §22 alerts, §5.2 tiers, ADR-0004

## Symptom

Oldest job age in any BullMQ queue exceeds 2 minutes (7 queues per ADR-0004:
`runs:quick|standard|complex|premium|max`, `exports`, `images`). Users see runs stuck in
`queued` (SSE `run.queued` never followed by `run.started`, §13.2) and the preview never
begins. Tier wall clocks (2–15 min, §5.2) are in danger before a job even starts.

## Impact

Violates the tier budget promise (§5.2 wall clocks): a `quick` edit that queues 3 min
already missed its 2-min budget. Users do not distinguish "slow AI" from "broken
product"; concurrent-run limits (§15.1) make waiting interactive and visible.

## Diagnosis

1. Which queue? Backlog in one tier queue (a heavy `max` run blocking that tier) vs all
   queues (broker or worker-wide stall).
2. Is Valkey up? `GET /v1/health/deep` probes the queue (§13.1); check
   `valkey` container health and `--maxmemory 512mb --maxmemory-policy noeviction`
   (ADR-0004: noeviction means full memory = write failures, not silent loss).
3. Are workers consuming? `docker compose ps` (2 replicas, §17.2); worker logs for
   graceful-shutdown stalls, crash loops, or engine-pool exhaustion
   (`engine_unavailable` → the pool is the bottleneck, not the queue).
4. Engine pool saturation: §22 metrics sessions active/idle + pool utilisation — a full
   pool starves run jobs even though queues look idle (workers are awaiting sessions).
5. Flood or single huge job? Queue depth by workspace; one workspace hammering runs
   should hit its daily cap (§14.2 r7) rather than degrade everyone.

## Fix

- **Workers down/stuck:** restart the worker service one at a time (§17.2 deploy rules);
  BullMQ resumes jobs; stuck active jobs are retried per backoff ×3 (§3.4).
- **Valkey full:** identify runaway payload or cache growth, flush the *cache* keys
  (never job keys); if memory is the box's, apply RB-05 pressure steps.
- **Engine pool bottleneck:** let idle sessions expire (15-min idle timeout, §3.4),
  or temporarily lower concurrent sessions; long-term follow the §17.4 scale trigger
  (> 30 concurrent runs → second engine box).
- **Tier starvation:** premium/max jobs are bounded (rare); if one tier persistently
  backs up while others idle, rebalance worker replicas per queue (BullMQ Worker
  concurrency) — a config change, not a redesign.

## Verification

- Oldest-job age < 2 min and depth draining on the §22 queue age/depth metrics.
- A fresh run in the affected tier completes inside its §5.2 wall clock.
- No job was double-processed: `jobId = run_id` idempotency (ADR-0004) held — spot-check
  ledger entries for duplicated charges (§14.2 r6).

## Postmortem

Record: trigger (deploy, flood, pool saturation), peak depth/age, affected workspaces,
and whether alerting fired before users noticed. If the 2-min threshold was too loose
for `quick` tier, tighten the alert per tier. Update this runbook and `docs/devlog.md`.
