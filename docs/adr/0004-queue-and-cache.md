# ADR 0004 — Queue and cache: BullMQ on Valkey (not Redis ≥ 7.4)

Date: 2026-10-20 · Status: accepted

## Context

Runs, exports and image generations are asynchronous jobs: the gateway reserves credits,
inserts an `agent_runs` row and enqueues (§3.3); the worker consumes, executes the agent
loop against the engine pool, and retries transient failures with backoff ×3 (§3.4).
The same store doubles as short-lived cache and SSE fan-out fallback (§3.1). The license
policy (§16.5) makes this a constrained choice: **Redis ≥ 7.4 is RSALv2/SSPL — forbidden
in the product or its deployment without written legal review.**

## Decision

**BullMQ (MIT) over Valkey (BSD-3-Clause)** via the Redis protocol.

1. **Valkey, not Redis.** Redis 7.4+ moved to RSALv2/SSPL (§16.5) — a license trap for
   a closed-core product. Valkey is the Linux-Foundation-maintained, BSD-3-Clause
   fork, wire-compatible with Redis 7.2 clients (BullMQ/ioredis work unchanged). The
   compose stack pins `valkey/valkey:8-alpine` with `--maxmemory-policy noeviction`
   (§17.2): queue payloads are durability-sensitive — a cache-evicted job means a
   silently lost run, so eviction is disabled and memory is bounded (512 MB) instead.

2. **One queue per model tier** (§5.2), plus exports and images — exactly the topology
   landed in `apps/worker/src/queues.ts` (W1-I):
   `runs:quick|standard|complex|premium|max`, `exports`, `images` (7 queues).
   Per-tier queues mean a `max` tier can never be head-of-line blocked behind a flood
   of `quick` edits, and tier wall-clocks (2/5/10/10/15 min, §5.2) are per-queue
   worker policy, not a global timeout.

3. **Idempotency:** BullMQ `jobId` = `run_id` (runs) or idempotency key (exports), so a
   gateway retry after a lost response enqueues the same job, never two (§3.4). Money
   correctness stays in the Postgres ledger (`idempotency_keys`, W1-F) — the queue is
   transport, never the source of truth.

4. **Retry/backoff ×3 (§3.4):** retryable failures (`RetryableRunFailureError`) retry
   with exponential backoff (`attempts: 3`, 5 s base); on the final failure the run is
   marked `failed`, the credit reservation is released/refunded (§14.2), and the alert
   in RB-01 fires if the failure rate crosses 5 %/15 min. Non-retryable failures
   (validation, quota) fail fast — no retry amplification.

5. **Timeouts** (§3.4) are enforced by the worker per job: tool 5 s, render 30 s,
   run 10 min, session idle 15 min — with per-tier wall clocks via `AbortSignal`.

### Why not Temporal / Trigger.dev yet (§16.4)

Both are listed as *optional, phase-dependent* (§16.4), not day-one picks:

- **Trigger.dev** (Apache-2.0) and **Temporal** (MIT) buy durable, long-running
  workflows — at the price of extra services/clusters to operate. Our deployment target
  is a single 4 GB Lightsail box (§17.1); "heavier ops" is the documented caveat.
- Our runs are already checkpointed: the command log is a WAL (§3.2), runs are
  idempotent (§3.4), and engine crashes resume once from checkpoint. That is 90 % of
  what a durable workflow engine provides for our run shape, for 0 % of the ops cost.
- **Migration path:** the worker's `RunProcessor` seam (W1-I) is a single injected
  interface — a Phase 3+ swap of BullMQ for Trigger.dev/Temporal touches
  `apps/worker/src/index.ts` and the enqueue call in the gateway, not the agent loop.
  Revisit if: runs regularly exceed 15 min, multi-step flows (variants/bulk export)
  need durable fan-out, or we run multi-box.

## Consequences

- `VALKEY_URL` (not `REDIS_URL`) is the canonical env var (ADR-0002); anything
  Redis-licensed in CI is a license-check failure (§16.5).
- Queue depth and age are first-class metrics (§22) with the RB-02 runbook at
  age > 2 min; BullMQ's delayed-job and repeat features are available for retries and
  nightly jobs (§17.3 backup canary) without new infra.
- One broker for jobs, rate-limit buckets, short-lived caches and the SSE fan-out
  fallback (§3.1) — but Postgres remains authoritative for anything money- or
  content-related.
