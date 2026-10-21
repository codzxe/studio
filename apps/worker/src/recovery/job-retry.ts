// apps/worker/src/recovery/job-retry.ts — BullMQ retry policy glue for §3.4.
// Owner: W6-M (docs/AGENTS.md).
//
// Spec anchors:
//   §3.4   "Crash recovery: queue job retried with backoff ×3; if still
//          failing, mark run failed and alert. Engine crash mid-run: restart,
//          replay to checkpoint, resume once."
//   §3.3   step 2 — the gateway enqueues the BullMQ job with jobId = the run's
//          idempotency key, so retries never double-charge or double-apply.
//
// The two retry layers are DIFFERENT things (apps/engine-pool/src/
// recovery-contract.md): the QUEUE retries the JOB; the RecoveryCoordinator
// (worker side: src/recovery/run-recovery.ts) resumes the RUN. Without the
// split, the ping-pong hazard bites: a crashed engine is often half-dead when
// BullMQ's first retry lands 5 s later, and three queue attempts must not buy
// three engine replays. This module owns the queue-side classification:
//   - attempts 1–3: the job may run; a retryable failure re-enters with
//     exponential backoff (5 s, then 10 s — documented constants below, derived
//     from JOB_RETRY in src/queues.ts so the whole app has ONE retry budget);
//   - attempt > 3: terminal — the run is marked failed and the alert fires;
//   - jobId = runId (the idempotency key): duplicate enqueues of the same run
//     dedupe at the queue, so a redelivered job re-enters recovery with the
//     same gate state instead of double-applying;
//   - shouldResume(attempt, cause): only crash-class failures take the §3.4
//     resume path; validation/plan errors are deterministic rejections — fail
//     fast, because retrying a schema violation can never succeed (the same
//     poison-payload rule as src/queues.ts parseJobPayload).
//
// The resume-ONCE gate itself lives in run-recovery.ts (MAX_RESUME_ATTEMPTS_
// PER_RUN); shouldResume only routes failures onto that path.

import { JOB_RETRY } from "../queues.js";
import type { RunRecoveryOutcome } from "./run-recovery.js";

// ---------------------------------------------------------------------------
// §3.4 retry budget — derived from the single source of truth (src/queues.ts)
// ---------------------------------------------------------------------------

/** §3.4 backoff ×3 — total job attempts BullMQ allows per run job. */
export const MAX_JOB_ATTEMPTS = JOB_RETRY.attempts; // 3

/** Exponential backoff base delay (BullMQ applies base × 2^(attempt − 1)). */
export const RETRY_BACKOFF_BASE_MS = JOB_RETRY.backoff.delay; // 5_000

/** The BullMQ backoff strategy configured in src/queues.ts JOB_RETRY. */
export const RETRY_BACKOFF_TYPE = JOB_RETRY.backoff.type; // "exponential"

/** Programmer-error guard for 1-based BullMQ attempt numbers. */
export class InvalidJobAttemptError extends Error {
  constructor(attempt: number) {
    super(
      `invalid BullMQ attempt ${attempt} (attempts are 1-based; budget: ${MAX_JOB_ATTEMPTS}, §3.4)`,
    );
    this.name = "InvalidJobAttemptError";
  }
}

const assertAttempt = (attempt: number): void => {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvalidJobAttemptError(attempt);
  }
};

/** Backoff BullMQ applies after `failedAttempt` fails: base × 2^(attempt − 1) — 5 s, 10 s (§3.4). */
export function backoffDelayMsAfter(failedAttempt: number): number {
  assertAttempt(failedAttempt);
  return RETRY_BACKOFF_BASE_MS * 2 ** (failedAttempt - 1);
}

export interface JobAttemptPlan {
  /** "execute" — the attempt may run; "terminal" — §3.4: mark run failed + alert. */
  readonly action: "execute" | "terminal";
  /** 1-based attempt number, echoed for logs. */
  readonly attempt: number;
  /** Queue retries left if THIS attempt fails. */
  readonly remainingRetries: number;
  /** Backoff BullMQ applied BEFORE this attempt (attempts 2+); undefined on attempt 1. */
  readonly backoffBeforeMs?: number;
  /** True once the §3.4 budget is exhausted. */
  readonly exhausted: boolean;
}

/**
 * Attempt classification (§3.4 "queue job retried with backoff ×3; if still
 * failing, mark run failed and alert"):
 *
 * | attempt | action    | backoff before | remaining retries |
 * | ------- | --------- | -------------- | ---------------- |
 * | 1       | execute   | —              | 2                |
 * | 2       | execute   | 5 000 ms       | 1                |
 * | 3       | execute   | 10 000 ms      | 0                |
 * | > 3     | terminal  | —              | 0                |
 */
export function classifyJobAttempt(attempt: number): JobAttemptPlan {
  assertAttempt(attempt);
  const withinBudget = attempt <= MAX_JOB_ATTEMPTS;
  return {
    action: withinBudget ? "execute" : "terminal",
    attempt,
    remainingRetries: Math.max(0, MAX_JOB_ATTEMPTS - attempt),
    // A terminal attempt never runs, so no backoff was ever applied for it.
    backoffBeforeMs: withinBudget && attempt > 1 ? backoffDelayMsAfter(attempt - 1) : undefined,
    exhausted: !withinBudget,
  };
}

// ---------------------------------------------------------------------------
// jobId = idempotency key (§3.4)
// ---------------------------------------------------------------------------

/** Thrown when a producer tries to enqueue a run job without an idempotency key. */
export class InvalidRunJobIdError extends Error {
  constructor() {
    super("run jobs require a non-empty jobId (the run's idempotency key, §3.4)");
    this.name = "InvalidRunJobIdError";
  }
}

/**
 * jobId mapping note (§3.4 + src/queues.ts runJobPayloadSchema): the gateway
 * MUST set the BullMQ jobId to the run's idempotency key (the runId) —
 * duplicate enqueues then dedupe at the queue and a redelivered job re-enters
 * recovery with the same gate state, never double-applying or double-charging.
 */
export function runJobId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new InvalidRunJobIdError();
  }
  return runId;
}

// ---------------------------------------------------------------------------
// shouldResume — which failures take the §3.4 resume path at all
// ---------------------------------------------------------------------------

/**
 * Why a run job attempt failed, classified before recovery is considered.
 * `engine_crash` covers every §3.4 engine-process death (pool-reported exit,
 * watchdog stop-failure, operator-initiated restart mid-run).
 */
export const JOB_FAILURE_CAUSES = [
  "engine_crash",
  "engine_timeout",
  "provider_unhealthy",
  "validation_failed",
  "plan_invalid",
  "payload_invalid",
  "budget_exceeded",
] as const;
export type JobFailureCause = (typeof JOB_FAILURE_CAUSES)[number];

/**
 * §3.4 routing table — crash-class failures only:
 *   - `engine_crash` at attempts 1–3 → resume path (RunRecoveryService; its
 *     resume-ONCE gate is the real limiter — recovery-contract.md);
 *   - `engine_timeout` → §3.4 timeouts: cancel, rollback, refund, report —
 *     never a resume;
 *   - `validation_failed` / `plan_invalid` / `payload_invalid` → deterministic
 *     rejections: fail fast, no resume (retrying cannot succeed — the same
 *     rule as poison payloads in src/queues.ts);
 *   - `provider_unhealthy` → queue-retryable infra failure, not a crash: the
 *     backoff above is the retry mechanism, no engine resume involved;
 *   - `budget_exceeded` → §5.2 clean stop: not a failure to resume past;
 *   - any cause at attempt > 3 → the budget is spent: mark the run failed and
 *     alert (§3.4), never resume.
 */
export function shouldResume(attempt: number, cause: JobFailureCause): boolean {
  assertAttempt(attempt);
  if (cause !== "engine_crash") {
    return false;
  }
  return attempt <= MAX_JOB_ATTEMPTS;
}

// ---------------------------------------------------------------------------
// Outcome → BullMQ action (recovery-contract.md "Who does what")
// ---------------------------------------------------------------------------

export type RecoveryJobAction =
  /** `resumed` — the agent loop continues on the fresh session. */
  | "continue"
  /** Retryable envelope — rethrow so BullMQ applies backoff (§3.4); resume not consumed. */
  | "throw_for_retry"
  /** Terminal failed_clean — complete normally so the remaining attempts are not burned. */
  | "complete_failed";

/**
 * How the processor turns a RunRecoveryOutcome into queue behaviour
 * (recovery-contract.md): terminal failures already marked the run failed_clean
 * and triggered the idempotent refund inside recoverRun, so the job COMPLETES —
 * BullMQ must not burn its remaining attempts on a terminal run. Retryable
 * envelopes (WAL read / reallocate) consumed no resume: rethrow and let the
 * backoff ×3 deliver the next attempt.
 */
export function recoveryActionForJob(outcome: RunRecoveryOutcome): RecoveryJobAction {
  if (outcome.kind === "resumed") {
    return "continue";
  }
  return outcome.error.retryable ? "throw_for_retry" : "complete_failed";
}
