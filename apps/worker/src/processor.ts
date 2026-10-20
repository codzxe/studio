import type { Logger } from "./logger.js";
import type { RunJobPayload } from "./queues.js";

/**
 * Processor seam for the run pipeline. The real agent loop (§5.1 state
 * machine: plan → execute → observe → render → validate → critique → repair
 * → finalize) arrives in Wave 6 and implements `RunProcessor`; the bootstrap
 * injects it in src/index.ts without touching queue wiring.
 */

/** Typed error envelope (docs/AGENTS.md error convention). */
export interface RunError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** §5.1 outcome vocabulary, including `succeeded_with_warnings` after exhausted repairs. */
export type RunStatus = "succeeded" | "succeeded_with_warnings" | "failed";

export interface RunOutcome {
  readonly status: RunStatus;
  /** Credits actually charged (reservation commit, §3.3 step 6). */
  readonly creditsUsed?: number;
  /** Committed engine checkpoint/document version, when the run advanced the document. */
  readonly documentCheckpointId?: string;
  /** Non-blocking issues surfaced to the user (§5.1). */
  readonly warnings?: readonly string[];
  /** Required when status is "failed". */
  readonly error?: RunError;
}

/** Everything a processor needs about one run job; BullMQ details stay outside. */
export interface RunJobContext {
  readonly jobId: string;
  readonly payload: RunJobPayload;
  /** 1-based attempt (BullMQ attempts budget: `JOB_RETRY` in src/queues.ts). */
  readonly attempt: number;
  /** Aborts at the tier wall clock (§5.2); processors must poll and forward it. */
  readonly signal: AbortSignal;
}

/** Implementations run one agent run end-to-end (Wave 6). */
export interface RunProcessor {
  process(job: RunJobContext): Promise<RunOutcome>;
}

/** Thrown to hand a retryable failure back to BullMQ's backoff retries (§3.4). */
export class RetryableRunFailureError extends Error {
  readonly runError: RunError;

  constructor(runError: RunError) {
    super(`retryable run failure: ${runError.code}`);
    this.name = "RetryableRunFailureError";
    this.runError = runError;
  }
}

/**
 * Wave-1 stub: validates the seam, marks jobs done, and logs loudly.
 * Replaced in Wave 6 by the real agent-loop processor (§5.1).
 */
export class StubRunProcessor implements RunProcessor {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "stub-run-processor" });
  }

  async process(job: RunJobContext): Promise<RunOutcome> {
    this.logger.warn("TODO: agent-loop run processor arrives in Wave 6 — job completed by stub", {
      jobId: job.jobId,
      runId: job.payload.runId,
      organizationId: job.payload.organizationId,
      tier: job.payload.tier,
      attempt: job.attempt,
    });
    return {
      status: "succeeded",
      warnings: ["processed by StubRunProcessor; the agent loop (§5.1) is not wired yet"],
    };
  }
}
