// @studio/engine-pool — RecoveryCoordinator (§3.4 crash recovery, §5.6 replay).
//
// Engine crash mid-run: restart the session, replay the command log from the last
// committed checkpoint, resume ONCE. A second crash — or any unrecoverable state
// (WAL gap, revision violation, replay budget blown) — fails clean: a typed
// `engine_session_lost` envelope with a refund hint; the worker applies the
// billing policy, and the document is left at its last committed checkpoint.
//
// How this composes with the BullMQ backoff ×3 is documented in
// src/recovery-contract.md (queue retries the JOB; the coordinator resumes the RUN).

import type { EngineSession, EngineSessionState } from "./types.js";
import {
  type WalCursor,
  type WalEntry,
  type WalProvider,
  sliceCount,
  sliceForReplay,
  verifyReplaySlice,
} from "./wal.js";

/** Who reported the crash — the classification step of §3.4 recovery (a). */
export type CrashCause = "watchdog" | "pool" | "manual";

export interface CrashEvidence {
  readonly source: CrashCause;
  /** Sanitized context (no paths, no internals); surfaced in logs only. */
  readonly detail?: string;
}

/** The crashed run and its durable position, as the worker knows it. */
export interface RecoverySession {
  readonly runId: string;
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly state: EngineSessionState;
  /** Last committed checkpoint — the document's durable state (§3.3 step 7). */
  readonly checkpoint: WalCursor;
  /** Crash classification evidence; absent = unexpected exit reported by the pool. */
  readonly crash?: CrashEvidence;
}

/** How a replacement session rehydrates the document. */
export const ATTACH_PLANS = ["replay", "checkpoint"] as const;
export type AttachPlan = (typeof ATTACH_PLANS)[number];

/** Hard cap on one resume attempt; replayed commands count against run budgets (§5.2). */
export interface RecoveryBudget {
  readonly maxReplayedCommands: number;
}

/** One replay step's outcome — values, not throws; `message` must be safe to surface. */
export interface EngineReplayOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  /** Document revision after the step, when the engine reports one. */
  readonly revision?: number;
}

/** The minimum engine surface recovery needs; the real client arrives with the Wave-2 spawner. */
export interface ReplayEngine {
  /** Rehydrate a fresh session from the durable checkpoint (§5.6 snapshot machinery). */
  loadCheckpoint(session: EngineSession, checkpoint: WalCursor): Promise<EngineReplayOutcome>;
  /** Apply one logged command verbatim — the idempotent replay path (§3.4). */
  applyCommand(session: EngineSession, entry: WalEntry): Promise<EngineReplayOutcome>;
}

/** Reallocation request: same tenant + document (§3.2 one session per document), fresh process. */
export interface ReallocationRequest {
  readonly organizationId: string;
  readonly documentId: string;
  readonly runId: string;
}

/** Pool seam: bring up a replacement session for a crashed one (§3.4 restart). */
export interface PoolLike {
  reallocate(request: ReallocationRequest): Promise<EngineSession>;
}

export interface RecoverDeps {
  readonly walProvider: WalProvider;
  readonly engine: ReplayEngine;
  readonly attachPlan: AttachPlan;
  readonly budget: RecoveryBudget;
}

export type RecoveryErrorCode =
  | "engine_session_lost"
  | "wal_invalid_input"
  | "wal_gap_detected"
  | "wal_monotonicity_violation"
  | "wal_slice_mismatch"
  | "resume_budget_exceeded";

/** Why a recovery failed clean; every terminal path leaves the document at its checkpoint. */
export type RecoveryFailReason =
  | "session_not_crashed"
  | "resume_already_attempted"
  | "invalid_attach_plan"
  | "wal_invalid_input"
  | "wal_provider_failed"
  | "wal_slice_unavailable"
  | "wal_gap_detected"
  | "wal_monotonicity_violation"
  | "wal_slice_mismatch"
  | "resume_budget_exceeded"
  | "reallocate_failed"
  | "checkpoint_load_failed"
  | "replay_command_failed"
  | "replay_revision_mismatch";

export type ResumedReason =
  | "pool_crash_replayed"
  | "watchdog_crash_replayed"
  | "manual_stop_replayed";

/** Typed envelope (§4 conventions); never carries ids, paths or stack traces. */
export interface RecoveryErrorEnvelope {
  readonly ok: false;
  readonly code: RecoveryErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

/** Terminal outcome of one recover() call (§3.4 (b)/(c)). */
export type RecoveryOutcome =
  | {
      readonly kind: "resumed";
      readonly reason: ResumedReason;
      readonly crashCause: CrashCause;
      /** Fresh session the worker resumes the agent loop on (token stays worker-side). */
      readonly sessionId: string;
      readonly fromSeq: number;
      readonly toSeq: number;
      readonly replayedCount: number;
      /** Document revision after replay (== the last replayed command's revisionAfter). */
      readonly revision: number;
      /** Resume attempts consumed by this run — 1 here; §3.4 allows no more. */
      readonly resumeAttempts: number;
    }
  | {
      readonly kind: "failed_clean";
      readonly reason: RecoveryFailReason;
      readonly crashCause: CrashCause;
      readonly resumeAttempts: number;
      /** Last committed checkpoint revision — the document never regresses past it. */
      readonly documentRevision: number;
      readonly error: RecoveryErrorEnvelope;
    };

/** §3.4: "restart, replay to checkpoint, resume ONCE" — one engine resume per run. */
export const MAX_RESUME_ATTEMPTS_PER_RUN = 1;

/** Refund is the worker's job (billing policy owns classification, §14.2); recovery only hints. */
export const REFUND_HINT =
  "Refund the run's credit reservation via the billing policy; the document stays at its last committed checkpoint (§3.4, §14.2).";

/**
 * Step (a) — classify the crash cause. The pool's exit hook is the default
 * reporter (`pool`); watchdog stop-failures pass their own evidence; `manual`
 * marks operator-initiated restarts (drain/eviction mid-run).
 */
export function classifyCrash(session: RecoverySession): CrashCause {
  return session.crash?.source ?? "pool";
}

function resumedReason(cause: CrashCause): ResumedReason {
  switch (cause) {
    case "watchdog":
      return "watchdog_crash_replayed";
    case "manual":
      return "manual_stop_replayed";
    default:
      return "pool_crash_replayed";
  }
}

function envelope(
  code: RecoveryErrorCode,
  message: string,
  options: { hint?: string; retryable: boolean },
): RecoveryErrorEnvelope {
  return { ok: false, code, message, hint: options.hint, retryable: options.retryable };
}

export interface RecoveryCoordinatorOptions {
  readonly pool: PoolLike;
}

/**
 * Drives §3.4 crash recovery for engine sessions. Per run id it allows at most
 * `MAX_RESUME_ATTEMPTS_PER_RUN` engine resumes; anything else fails clean. The
 * attempt counter is in-memory by design — the queue-level idempotency (BullMQ
 * jobId = idempotency key) plus the run row guard the cross-process case; see
 * recovery-contract.md.
 */
export class RecoveryCoordinator {
  readonly #pool: PoolLike;
  /** Resume attempts per run id; worker-process-local (see recovery-contract.md). */
  readonly #resumeAttempts = new Map<string, number>();

  constructor(options: RecoveryCoordinatorOptions) {
    this.#pool = options.pool;
  }

  /** Attempts consumed so far for a run (observability + worker-side gating). */
  resumeAttempts(runId: string): number {
    return this.#resumeAttempts.get(runId) ?? 0;
  }

  /**
   * Recover one crashed run. Steps per §3.4:
   *  (a) classify the crash cause (watchdog / pool / manual);
   *  (b) first resume: verify the WAL slice, restart via `pool.reallocate`,
   *      replay the slice onto the fresh session, resume ONCE;
   *  (c) anything unrecoverable: fail clean — `engine_session_lost` with a refund
   *      hint; the document is left at its last committed checkpoint.
   */
  async recover(session: RecoverySession, deps: RecoverDeps): Promise<RecoveryOutcome> {
    const crashCause = classifyCrash(session);
    const fail = (reason: RecoveryFailReason, error: RecoveryErrorEnvelope): RecoveryOutcome => ({
      kind: "failed_clean",
      reason,
      crashCause,
      resumeAttempts: this.#resumeAttempts.get(session.runId) ?? 0,
      documentRevision: session.checkpoint.revision,
      error,
    });

    if (session.state !== "crashed") {
      return fail(
        "session_not_crashed",
        envelope("engine_session_lost", "Recovery invoked on a session that is not crashed", {
          hint: "Only crashed mid-run sessions take the replay path (§3.4).",
          retryable: false,
        }),
      );
    }
    if (session.checkpoint.documentId !== session.documentId) {
      return fail(
        "wal_invalid_input",
        envelope("wal_slice_mismatch", "The checkpoint belongs to a different document", {
          retryable: false,
        }),
      );
    }
    if (this.resumeAttempts(session.runId) >= MAX_RESUME_ATTEMPTS_PER_RUN) {
      return fail(
        "resume_already_attempted",
        envelope(
          "engine_session_lost",
          "The engine session was already resumed once for this run",
          { hint: REFUND_HINT, retryable: false },
        ),
      );
    }

    // WAL slice: everything after the durable checkpoint must replay (§5.6).
    let totalSeq: number;
    try {
      totalSeq = await deps.walProvider.totalSeq(session.documentId);
    } catch {
      return fail(
        "wal_provider_failed",
        envelope("engine_session_lost", "The command log could not be read", {
          hint: "A queue-level retry may succeed; the resume attempt is not consumed (§3.4).",
          retryable: true,
        }),
      );
    }
    const sliced = sliceForReplay(session.documentId, session.checkpoint.revision, totalSeq);
    if (!sliced.ok) {
      return fail(
        "wal_slice_unavailable",
        envelope(sliced.code, sliced.message, { hint: sliced.hint, retryable: false }),
      );
    }
    const slice = sliced.slice;
    const count = sliceCount(slice);

    if (count > deps.budget.maxReplayedCommands) {
      return fail(
        "resume_budget_exceeded",
        envelope(
          "resume_budget_exceeded",
          `Replaying ${count} command(s) exceeds the resume budget of ${deps.budget.maxReplayedCommands}`,
          {
            hint: "Resume budgets are hard caps (§5.2); fail clean and refund instead of an unbounded replay.",
            retryable: false,
          },
        ),
      );
    }
    if (deps.attachPlan === "checkpoint" && count > 0) {
      return fail(
        "invalid_attach_plan",
        envelope(
          "engine_session_lost",
          "Attach plan 'checkpoint' cannot resume past uncommitted commands",
          {
            hint: "Use attachPlan 'replay' when the command log holds commands after the checkpoint (§5.6).",
            retryable: false,
          },
        ),
      );
    }

    // Verify the slice BEFORE spawning anything: a corrupt log must never cost
    // an engine process, and must never be applied (never silently skip, §5.6).
    let entries: readonly WalEntry[] = [];
    if (count > 0) {
      try {
        entries = await deps.walProvider.readSlice(slice);
      } catch {
        return fail(
          "wal_provider_failed",
          envelope("engine_session_lost", "The command log slice could not be read", {
            hint: "A queue-level retry may succeed; the resume attempt is not consumed (§3.4).",
            retryable: true,
          }),
        );
      }
      const verified = verifyReplaySlice({
        slice,
        entries,
        checkpointRevision: session.checkpoint.revision,
      });
      if (!verified.ok) {
        return fail(
          verified.code,
          envelope(verified.code, verified.message, { hint: verified.hint, retryable: false }),
        );
      }
    }

    // Restart: a fresh session for the same tenant + document (§3.4 restart).
    let fresh: EngineSession;
    try {
      fresh = await this.#pool.reallocate({
        organizationId: session.organizationId,
        documentId: session.documentId,
        runId: session.runId,
      });
    } catch {
      return fail(
        "reallocate_failed",
        envelope("engine_session_lost", "A replacement engine session could not be started", {
          hint: "The queue-level retry (backoff ×3) may succeed; the resume attempt is not consumed (§3.4).",
          retryable: true,
        }),
      );
    }

    // The resume truly begins here — consume the single attempt before touching
    // the document so a half-completed resume can never be retried into a double
    // apply (§3.4 resume ONCE; recovery-contract.md "Sequencing guarantee").
    this.#resumeAttempts.set(session.runId, this.resumeAttempts(session.runId) + 1);
    const resumeAttempts = this.resumeAttempts(session.runId);

    try {
      const load = await deps.engine.loadCheckpoint(fresh, session.checkpoint);
      if (!load.ok) {
        return fail(
          "checkpoint_load_failed",
          envelope(
            "engine_session_lost",
            "The durable checkpoint could not be loaded into the replacement session",
            { hint: REFUND_HINT, retryable: false },
          ),
        );
      }
    } catch {
      return fail(
        "checkpoint_load_failed",
        envelope(
          "engine_session_lost",
          "Loading the durable checkpoint into the replacement session failed",
          { hint: REFUND_HINT, retryable: false },
        ),
      );
    }

    let revision = session.checkpoint.revision;
    for (const entry of entries) {
      let applied: EngineReplayOutcome;
      try {
        applied = await deps.engine.applyCommand(fresh, entry);
      } catch {
        return fail(
          "replay_command_failed",
          envelope("engine_session_lost", "Applying a replayed command failed unexpectedly", {
            hint: REFUND_HINT,
            retryable: false,
          }),
        );
      }
      if (!applied.ok) {
        return fail(
          "replay_command_failed",
          envelope(
            "engine_session_lost",
            applied.message ?? "A replayed command was rejected by the engine",
            { hint: REFUND_HINT, retryable: false },
          ),
        );
      }
      revision = applied.revision ?? entry.revisionAfter;
    }
    const last = entries.at(-1);
    if (last !== undefined && revision !== last.revisionAfter) {
      return fail(
        "replay_revision_mismatch",
        envelope(
          "engine_session_lost",
          "The engine revision after replay does not match the command log",
          { hint: REFUND_HINT, retryable: false },
        ),
      );
    }

    return {
      kind: "resumed",
      reason: resumedReason(crashCause),
      crashCause,
      sessionId: fresh.sessionId,
      fromSeq: slice.fromSeq,
      toSeq: slice.toSeq,
      replayedCount: entries.length,
      revision,
      resumeAttempts,
    };
  }
}
