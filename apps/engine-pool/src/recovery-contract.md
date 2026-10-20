# Recovery contract — engine crash × BullMQ retry (§3.4)

How `RecoveryCoordinator` (`src/recovery.ts` + `src/wal.ts`) composes with the
worker's BullMQ job retry (`apps/worker/src/queues.ts`: `JOB_RETRY` = 3 attempts,
exponential backoff, jobId = the run's idempotency key). The two retry layers are
different things: **the queue retries the JOB; the coordinator resumes the RUN.**

## Layered retries

- **Queue (BullMQ):** `attempts: 3`, exponential backoff. Duplicate enqueues of the
  same run cannot double-apply because the jobId is the idempotency key (§3.4).
- **Engine resume (coordinator):** at most `MAX_RESUME_ATTEMPTS_PER_RUN = 1` per run
  id — "restart, replay to checkpoint, resume once" (§3.4). Counted in-memory, per
  worker process.

## The ping-pong hazard

A crashed engine is often half-dead when BullMQ's first retry lands (5 s later):
zombie socket, OOM-killed process the pool has not fully reaped, a watchdog kill
still escalating. If every queue attempt bought a fresh engine resume, three queue
attempts → three replays → three more chances to corrupt the document or double-charge.
The resume-once gate stops the ping-pong:

1. Attempt 1 crashes mid-run → worker calls `recover()` → `resumed` (replay applied).
2. The run crashes again → `recover()` returns `failed_clean` /
   `resume_already_attempted` immediately — no reallocate, no replay, no WAL reads.
3. The worker sees the non-retryable `engine_session_lost` envelope (refund hint),
   marks the run failed, refunds via the billing policy, emits `run.failed`, and
   returns normally so BullMQ does not burn the remaining queue attempts on a
   terminal run.

## Who does what

- **Coordinator** (`recover`) — pure decision + orchestration via injected seams:
  `PoolLike.reallocate` (restart), `WalProvider` (the `commands` table, §5.6),
  `ReplayEngine` (checkpoint load + verbatim command replay). Returns a typed
  `RecoveryOutcome`; never throws.
- **Worker** —
  - `resumed`: continue the agent loop on `outcome.sessionId` (the fresh session).
  - `failed_clean`: mark the run failed, refund through the billing policy
    (`classifyRefund` — the envelope's hint only *says* refund; classification and
    the idempotent `${runId}:refund` ledger key stay in packages/billing, §14.2),
    keep the document at its last committed checkpoint, emit `run.failed`.
  - `retryable: true` envelopes (`wal_provider_failed`, `reallocate_failed`): infra
    failures that consumed no resume — let the job throw so BullMQ applies backoff
    and the next attempt re-enters `recover()` with the same gate state.

## Sequencing guarantee

The single resume attempt is consumed only when a resume truly begins: after the
WAL slice was read, verified (contiguity + monotonic revisions + checkpoint
coherence) and budget-checked, and a replacement session was allocated. Failures
before that point (unreadable/gapped/corrupt WAL, blown budget, failed reallocate)
are terminal or queue-retryable **without** spending the resume — the queue's
backoff is the retry mechanism there. Failures after it (checkpoint load, rejected
replay command, revision mismatch) leave the attempt spent: a half-replayed resume
is never retried, which is what makes replay idempotent per run.

## In-memory caveat (deliberate)

`resumeAttempts` lives in the coordinator instance (per worker process). If the
*worker itself* dies, the count is lost — but so is the job; BullMQ redelivers it
and the new process enters with a fresh coordinator. The cross-process guard is the
job idempotency key plus the run row: the worker must check the run is still in a
resumable (non-terminal) state before re-entering recovery. The document is safe
either way — replay applies the same logged commands from the same committed
checkpoint, so it converges; it does not accumulate.

## Test seam parity

`tests/recovery.test.ts` exercises the same steps with fakes: fake WAL provider
(in-memory `commands` rows), fake pool (`reallocate`), fake engine (records
`loadCheckpoint`/`applyCommand`). The four mandated §3.4 scenarios — crash at seq 12
with checkpoint 10 → replay 11–12; second crash → fail clean; WAL gap → fail clean;
monotonicity violation → fail clean — plus the budget, attach-plan, reallocate and
engine-failure paths.
