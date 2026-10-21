// apps/worker/src/recovery/run-recovery.ts — worker-side §3.4 crash recovery wiring.
// Owner: W6-M (docs/AGENTS.md).
//
// Spec anchors:
//   §3.4   "Engine crash mid-run: restart, replay to checkpoint, resume once."
//          "queue job retried with backoff ×3; if still failing, mark run failed
//          and alert." — the QUEUE retries the job (src/recovery/job-retry.ts);
//          THIS service resumes the RUN. Layered-retry semantics: see
//          apps/engine-pool/src/recovery-contract.md (ping-pong hazard).
//   §3.3   step 7 — any failure: refund reservation, keep the document at the
//          last committed checkpoint, emit run.failed.
//   §5.6   the command log (`commands` table) IS the write-ahead log; replay
//          applies logged commands verbatim from the durable checkpoint.
//   §5.2   replayed commands count against run budgets — resume budgets are
//          hard caps; fail clean + refund instead of an unbounded replay.
//   §14.2  the refund itself is the billing policy's job (classifyRefund +
//          idempotent `${runId}:refund` ledger key, packages/billing); this
//          service only TRIGGERS it through the injected RefundLike seam.
//
// Contract reconciliation (why structural seams, no imports):
//   engine-pool's RecoveryCoordinator (src/recovery.ts, W2-I), WAL algebra
//   (src/wal.ts, W2-I) and attach plan (src/attach.ts, W2-H) are NOT exported
//   from the engine-pool barrel (src/index.ts), and @studio/worker does not
//   depend on @studio/engine-pool in package.json (manifest owned elsewhere).
//   This module therefore MIRROS those contracts as worker-side structural
//   seams; the composition root wires the real implementations (or thin
//   adapters over them), which satisfy the shapes below structurally.
//   Mirrored semantics, verified against those files:
//     - resume ONCE per run: MAX_RESUME_ATTEMPTS_PER_RUN = 1, gate checked
//       BEFORE any WAL read (second crash → fail clean, no replay, §3.4);
//     - sequencing guarantee (recovery-contract.md): the single resume attempt
//       is consumed only after the WAL slice was read, verified and
//       budget-checked AND a replacement session was allocated; failures before
//       that point are terminal or queue-retryable WITHOUT spending the resume;
//       failures after it leave the attempt spent — a half-replayed resume is
//       never retried;
//     - retryable envelopes (WAL read / reallocate failures) consume no resume
//       and trigger no refund: the job throws and BullMQ applies backoff ×3.
//
// W6-I marker filtering note (packages/agent/src/transactions/manager.ts):
//   the log is append-only and carries AUDIT MARKERS — `agent.begin` (R→R),
//   `agent.commit`, `agent.rollback` (flag `rolled_back`; revision columns
//   carry the engine reply verbatim, intentionally NOT +1-chained) plus ANY
//   flagged row. Markers are never replayed content: the engine re-derives the
//   run's collapse from history again. readSlice-style consumers must filter
//   them out — THIS module is that wiring-layer consumer. Failed commands
//   (result IS NULL) are audited via agent_steps and never replayed (§5.6).
//   The revision→seq WAL cursor mapping also lives in the adapter (WalReadLike),
//   because sliceForReplay's revision==seq identity breaks once markers exist.

// ---------------------------------------------------------------------------
// §3.4 constants (mirror apps/engine-pool/src/recovery.ts)
// ---------------------------------------------------------------------------

/** §3.4: "resume once" — one engine resume per run id. */
export const MAX_RESUME_ATTEMPTS_PER_RUN = 1;

/**
 * Refund is the worker's job; recovery only hints (mirrors engine-pool
 * REFUND_HINT — the billing policy owns classification, §14.2).
 */
export const REFUND_HINT =
  "Refund the run's credit reservation via the billing policy; the document stays at its last committed checkpoint (§3.4, §14.2).";

/**
 * The three §5.6 transaction commands whose WAL rows are audit markers, never
 * replay content (wire ids verified against engine-patches/docs/commands.md,
 * W3-F; mirrors AGENT_TX_COMMANDS in packages/agent transactions/manager.ts).
 */
export const AGENT_TRANSACTION_COMMANDS = [
  "agent.begin",
  "agent.commit",
  "agent.rollback",
] as const satisfies readonly string[];

/** Audit flag marking rolled-back history (W6-I WAL_ROW_FLAGS; any flagged row is a marker). */
export const WAL_ROLLED_BACK_FLAG = "rolled_back";

/** Who reported the crash — mirrors engine-pool CrashCause (§3.4 recovery (a)). */
export const CRASH_CAUSES = ["watchdog", "pool", "manual"] as const;
export type CrashCause = (typeof CRASH_CAUSES)[number];

// ---------------------------------------------------------------------------
// Typed envelopes (§4 conventions; never carries ids, paths or stack traces)
// ---------------------------------------------------------------------------

export type RunRecoveryErrorCode =
  | "invalid_recovery_request"
  | "engine_session_lost"
  | "wal_invalid_input"
  | "wal_gap_detected"
  | "wal_monotonicity_violation"
  | "wal_slice_mismatch"
  | "resume_budget_exceeded";

export interface RunRecoveryErrorEnvelope {
  readonly ok: false;
  readonly code: RunRecoveryErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

/** Why a recovery failed clean; every terminal path leaves the document at its checkpoint. */
export type RunRecoveryFailReason =
  | "invalid_recovery_request"
  | "resume_already_attempted"
  | "wal_slice_unavailable"
  | "wal_invalid_input"
  | "wal_gap_detected"
  | "wal_monotonicity_violation"
  | "wal_slice_mismatch"
  | "resume_budget_exceeded"
  | "reallocate_failed"
  | "attach_plan_failed";

export type ResumedReason =
  | "pool_crash_replayed"
  | "watchdog_crash_replayed"
  | "manual_stop_replayed";

const envelope = (
  code: RunRecoveryErrorCode,
  message: string,
  options: { readonly hint?: string; readonly retryable: boolean },
): RunRecoveryErrorEnvelope => ({
  ok: false,
  code,
  message,
  hint: options.hint,
  retryable: options.retryable,
});

const resumedReason = (cause: CrashCause): ResumedReason => {
  switch (cause) {
    case "watchdog":
      return "watchdog_crash_replayed";
    case "manual":
      return "manual_stop_replayed";
    default:
      return "pool_crash_replayed";
  }
};

// ---------------------------------------------------------------------------
// WAL read seam — the worker-side adapter over the `commands` table (§5.6)
// ---------------------------------------------------------------------------

/**
 * One command-log row as the worker reads it: the engine-pool WalEntry shape
 * (apps/engine-pool/src/wal.ts) plus the audit columns the W6-I manager writes
 * (`result`, `flag`) so this module can do the marker filtering itself.
 */
export interface WorkerWalEntry {
  readonly documentId: string;
  /** 1-based per-document position; unique(document_id, seq) gives the strict total order. */
  readonly seq: number;
  readonly commandName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  /**
   * `null` = the command failed before producing state: audited via
   * agent_steps, never replayed (§5.6). Absent = the adapter already filtered.
   */
  readonly result?: Readonly<Record<string, unknown>> | null;
  /** Audit marker, e.g. `rolled_back` (W6-I); ANY flagged row is a marker. */
  readonly flag?: string | null;
}

/**
 * Injected read access to the command log since a checkpoint. The ADAPTER owns
 * the revision→rows mapping (the W6-I note: revision==seq breaks once markers
 * exist) and must return EVERY logged row after `fromRevision`, in seq order —
 * unfiltered; the marker filtering happens here (single owner of the rule).
 */
export interface WalReadLike {
  slice(documentId: string, fromRevision: number): Promise<readonly WorkerWalEntry[]>;
}

/** The document's last committed checkpoint (§3.3 step 7); null = no checkpoint yet. */
export interface RecoveryCheckpoint {
  readonly revision: number;
}

/** A filtered, verified, replayable slice row handed to the engine replay. */
export type ReplayCommand = WorkerWalEntry;

const isAgentTransactionRow = (entry: WorkerWalEntry): boolean =>
  (AGENT_TRANSACTION_COMMANDS as readonly string[]).includes(entry.commandName);

const isFlaggedMarkerRow = (entry: WorkerWalEntry): boolean =>
  typeof entry.flag === "string" && entry.flag.length > 0;

/**
 * Replayable rows only (§3.4 step (a) filter, the W6-I note):
 * drops `agent.begin`/`agent.commit`/`agent.rollback` markers, ANY flagged row
 * (`rolled_back`) and failed commands (`result` IS NULL, §5.6); orders by seq —
 * the strict total replay order.
 */
export function filterReplayableRows(
  entries: readonly WorkerWalEntry[],
): readonly WorkerWalEntry[] {
  return entries
    .filter((entry) => !isAgentTransactionRow(entry))
    .filter((entry) => !isFlaggedMarkerRow(entry))
    .filter((entry) => entry.result !== null)
    .sort((a, b) => a.seq - b.seq);
}

/** Codes the WAL verification can produce — each doubles as its own fail reason. */
export const WAL_FAIL_CODES = [
  "wal_invalid_input",
  "wal_gap_detected",
  "wal_monotonicity_violation",
  "wal_slice_mismatch",
] as const;
export type WalFailCode = (typeof WAL_FAIL_CODES)[number];

export type WALVerificationResult =
  | { readonly ok: true; readonly replayable: readonly ReplayCommand[] }
  | {
      readonly ok: false;
      readonly code: WalFailCode;
      readonly message: string;
      readonly hint?: string;
    };

/**
 * Verify the slice before anything is applied (mirror of engine-pool
 * verifyReplaySlice, adapted to the adapter-mapped revision algebra):
 *   1. raw rows must be one dense seq run — a gap means rows were lost
 *      (never silently skip, §5.6);
 *   2. after filtering, the surviving commands must chain +1 starting exactly
 *      at the checkpoint revision (§5.6 monotonic counters).
 */
export function verifyWALSinceCheckpoint(
  entries: readonly WorkerWalEntry[],
  checkpointRevision: number | null,
): WALVerificationResult {
  const base = checkpointRevision ?? 0;
  let expected: number | undefined;
  for (const entry of entries) {
    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      return {
        ok: false,
        code: "wal_invalid_input",
        message: `Invalid command-log position ${entry.seq}`,
      };
    }
    if (expected !== undefined && entry.seq !== expected) {
      return {
        ok: false,
        code: "wal_gap_detected",
        message: `Command-log gap: expected seq ${expected}, found seq ${entry.seq} — a replay slice must be contiguous`,
      };
    }
    expected = entry.seq + 1;
  }
  const replayable = filterReplayableRows(entries);
  let previousRevision: number | undefined;
  for (const row of replayable) {
    const chainStart = previousRevision ?? base;
    if (row.revisionBefore !== chainStart) {
      if (previousRevision === undefined) {
        return {
          ok: false,
          code: "wal_slice_mismatch",
          message: `The checkpoint (revision ${base}) does not immediately precede the slice — its first command starts at revision ${row.revisionBefore}`,
        };
      }
      return {
        ok: false,
        code: "wal_monotonicity_violation",
        message: `Revision chain broken after revision ${previousRevision} (seq ${row.seq} starts at ${row.revisionBefore})`,
      };
    }
    if (row.revisionAfter !== row.revisionBefore + 1) {
      return {
        ok: false,
        code: "wal_monotonicity_violation",
        message: `Revision counter must advance by exactly one per replayed command (seq ${row.seq}: ${row.revisionBefore}→${row.revisionAfter})`,
      };
    }
    previousRevision = row.revisionAfter;
  }
  return { ok: true, replayable };
}

// ---------------------------------------------------------------------------
// Attach plan — mirror of engine-pool decideAttachPlan (src/attach.ts, W2-H)
// ---------------------------------------------------------------------------

export type AttachStrategy = "replay" | "checkpoint" | "fresh";

/** The §3.4 decision output; deliberately execution-free until the seams run it. */
export interface RecoveryAttachPlan {
  readonly kind: AttachStrategy;
  /** Revision the replacement session starts from (checkpoint base; 0 = full replay). */
  readonly fromRevision: number;
  /** Verified WAL entries the executor must apply after the base (§5.6). */
  readonly commandCount: number;
}

/**
 * Decision table (mirror of engine-pool decideAttachPlan):
 *   no checkpoint, empty log       → fresh      { 0, 0 }
 *   no checkpoint, log non-empty   → replay     { 0, all } (full)
 *   checkpoint @R, nothing after R → checkpoint { R, 0 }
 *   checkpoint @R, rows after R    → replay     { R, n }
 * A crashed mid-run session always has a decided plan before reallocate, so
 * the infeasible "checkpoint with commands" combination can never be produced
 * (engine-pool recovery.ts gates it as invalid_attach_plan).
 */
export function planRecoveryAttach(
  checkpointRevision: number | null,
  replayableCount: number,
): RecoveryAttachPlan {
  if (checkpointRevision === null) {
    if (replayableCount === 0) return { kind: "fresh", fromRevision: 0, commandCount: 0 };
    return { kind: "replay", fromRevision: 0, commandCount: replayableCount };
  }
  if (replayableCount === 0) {
    return { kind: "checkpoint", fromRevision: checkpointRevision, commandCount: 0 };
  }
  return { kind: "replay", fromRevision: checkpointRevision, commandCount: replayableCount };
}

// ---------------------------------------------------------------------------
// Engine-side seams — structural, satisfied by engine-pool at the composition
// root: PoolLike.reallocate mirrors engine-pool recovery.ts; executePlan mirrors
// executeAttachPlan with the VERIFIED slice passed in, so what was verified is
// exactly what is applied — the coordinator's own loadCheckpoint +
// applyCommand-per-entry contract (§5.6 replay, idempotent per run).
// ---------------------------------------------------------------------------

export interface ReallocationRequest {
  readonly organizationId: string;
  readonly documentId: string;
  readonly runId: string;
}

/** Fresh replacement session (subset of engine-pool EngineSession). */
export interface ReplacementSession {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId?: string;
}

/** Pool seam: bring up a replacement engine process for a crashed run (§3.4 restart). */
export interface PoolLike {
  reallocate(request: ReallocationRequest): Promise<ReplacementSession>;
}

export type AttachOutcome =
  | {
      readonly ok: true;
      readonly kind: AttachStrategy;
      readonly fromRevision: number;
      readonly appliedCommands: number;
      readonly restoredFrom?: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
      readonly retryable?: boolean;
    };

/**
 * Executes the decided plan on the replacement session: restore the checkpoint
 * base (§3.3 step 6 object), then apply the verified slice verbatim (§5.6
 * replay). Failures here are terminal: the resume attempt is already spent
 * (recovery-contract.md sequencing guarantee).
 */
export interface AttachExecutorLike {
  executePlan(
    session: ReplacementSession,
    documentId: string,
    plan: RecoveryAttachPlan,
    commands: readonly ReplayCommand[],
  ): Promise<AttachOutcome>;
}

// ---------------------------------------------------------------------------
// Resume gate — the coordinator's resume-ONCE counter (§3.4)
// ---------------------------------------------------------------------------

export interface ResumeGateLike {
  /** Resume attempts consumed by the run so far (worker-process-local). */
  attempts(runId: string): number;
  /** Consume one attempt; called only when a resume truly begins. */
  record(runId: string): void;
}

/**
 * Default in-memory gate (mirrors the RecoveryCoordinator's counter). The
 * in-memory caveat is deliberate (recovery-contract.md): if the worker itself
 * dies the count is lost — but so is the job; BullMQ redelivers and the
 * cross-process guard is the jobId idempotency key plus the run row state.
 */
export function createInMemoryResumeGate(): ResumeGateLike {
  const attempts = new Map<string, number>();
  return {
    attempts: (runId) => attempts.get(runId) ?? 0,
    record: (runId) => {
      attempts.set(runId, (attempts.get(runId) ?? 0) + 1);
    },
  };
}

/** Hard cap on one resume attempt; replayed commands count against budgets (§5.2). */
export interface RecoveryBudget {
  readonly maxReplayedCommands: number;
}

// ---------------------------------------------------------------------------
// Run manager + refund seams (§3.3 step 7; billing stays in packages/billing)
// ---------------------------------------------------------------------------

/** Marks the run failed_clean on the agent_runs row and emits run.failed. */
export interface MarkFailedCleanInput {
  readonly runId: string;
  readonly organizationId: string;
  readonly documentRevision: number;
  readonly error: RunRecoveryErrorEnvelope;
}

export interface RunManagerLike {
  markFailedClean(input: MarkFailedCleanInput): Promise<void>;
}

export interface RefundRequest {
  readonly organizationId: string;
  readonly runId: string;
  /** Credits held by the reservation (§14.2); when omitted the adapter reads the hold. */
  readonly amountReserved?: number;
  /** Why the run failed clean — the billing policy owns classification (§14.2). */
  readonly cause?: string;
}

export type RefundOutcome =
  | { readonly ok: true; readonly amountRefunded: number; readonly duplicate: boolean }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
      readonly retryable?: boolean;
    };

/**
 * Idempotent refund seam — the real adapter bridges to packages/billing
 * releaseReservation (ledger key `${runId}:refund`, §14.2), so a retried job
 * can never double-refund.
 */
export interface RefundLike {
  release(request: RefundRequest): Promise<RefundOutcome>;
}

// ---------------------------------------------------------------------------
// recoverRun — §3.4 (a) filter, (b) reallocate + replay, (c) resume once,
// (d) else fail clean + refund
// ---------------------------------------------------------------------------

export interface RunRecoveryRequest {
  readonly runId: string;
  readonly documentId: string;
  readonly organizationId: string;
  readonly crashCause: CrashCause;
}

export interface RunRecoveryDeps {
  readonly wal: WalReadLike;
  /** The document's last committed checkpoint as the run manager knows it (§3.3 step 7). */
  readonly checkpoint: RecoveryCheckpoint | null;
  readonly pool: PoolLike;
  readonly attach: AttachExecutorLike;
  readonly gate: ResumeGateLike;
  readonly budget: RecoveryBudget;
  readonly runManager: RunManagerLike;
  readonly refund: RefundLike;
}

export type RunRecoveryOutcome =
  | {
      /** §3.4 (c): replay applied — the agent loop continues on `sessionId`. */
      readonly kind: "resumed";
      readonly reason: ResumedReason;
      readonly crashCause: CrashCause;
      readonly sessionId: string;
      readonly fromRevision: number;
      readonly toRevision: number;
      readonly replayedCount: number;
      readonly revision: number;
      /** Resume attempts consumed by this run — 1 here; §3.4 allows no more. */
      readonly resumeAttempts: number;
    }
  | {
      /** §3.4 (d): terminal — run marked failed_clean, reservation refunded. */
      readonly kind: "failed_clean";
      readonly reason: RunRecoveryFailReason;
      readonly crashCause: CrashCause;
      readonly resumeAttempts: number;
      /** Last committed checkpoint revision — the document never regresses past it. */
      readonly documentRevision: number;
      readonly error: RunRecoveryErrorEnvelope;
      /** Refund seam reply, when one was triggered (§3.3 step 7); absent on retryable paths. */
      readonly refund?: RefundOutcome;
    };

/**
 * Recover one crashed run, worker side. Never throws — every failure is a typed
 * outcome. Side effects (§3.3 step 7): terminal failures mark the run
 * failed_clean and trigger the idempotent refund; retryable failures (WAL read,
 * reallocate) do neither — the job throws and BullMQ applies backoff ×3 (§3.4).
 */
export async function recoverRun(
  request: RunRecoveryRequest,
  deps: RunRecoveryDeps,
): Promise<RunRecoveryOutcome> {
  const crashCause = request.crashCause;
  const checkpointRevision = deps.checkpoint === null ? null : deps.checkpoint.revision;
  const documentRevision = checkpointRevision ?? 0;

  const failedClean = (
    reason: RunRecoveryFailReason,
    error: RunRecoveryErrorEnvelope,
    refund?: RefundOutcome,
  ): RunRecoveryOutcome => ({
    kind: "failed_clean",
    reason,
    crashCause,
    resumeAttempts: deps.gate.attempts(request.runId),
    documentRevision,
    error,
    refund,
  });

  const retryableFail = (
    reason: RunRecoveryFailReason,
    error: RunRecoveryErrorEnvelope,
  ): RunRecoveryOutcome => failedClean(reason, error, undefined);

  // §3.3 step 7: mark failed_clean, then trigger the idempotent refund. Neither
  // seam failure may mask the typed verdict — the adapters log (§22).
  const failTerminal = async (
    reason: RunRecoveryFailReason,
    error: RunRecoveryErrorEnvelope,
  ): Promise<RunRecoveryOutcome> => {
    try {
      await deps.runManager.markFailedClean({
        runId: request.runId,
        organizationId: request.organizationId,
        documentRevision,
        error,
      });
    } catch {
      // swallowed by design — see above
    }
    let refund: RefundOutcome | undefined;
    try {
      refund = await deps.refund.release({
        organizationId: request.organizationId,
        runId: request.runId,
        cause: reason,
      });
    } catch {
      refund = {
        ok: false,
        code: "refund_unavailable",
        message: "The credit refund could not be triggered",
        hint: "Retry the release; the ledger refund key is idempotent (§14.2).",
        retryable: true,
      };
    }
    return failedClean(reason, error, refund);
  };

  // Request shape — internal seam, so manual checks + a typed envelope (the
  // ids cannot be trusted for side effects when they fail validation).
  const invalidRequest = (message: string): RunRecoveryOutcome =>
    failedClean(
      "invalid_recovery_request",
      envelope("invalid_recovery_request", message, {
        hint: "Recovery needs the crashed run's ids (§3.4); fix the caller.",
        retryable: false,
      }),
      undefined,
    );
  if (typeof request.runId !== "string" || request.runId.length === 0) {
    return invalidRequest("recoverRun requires a run id");
  }
  if (typeof request.documentId !== "string" || request.documentId.length === 0) {
    return invalidRequest("recoverRun requires a document id");
  }
  if (typeof request.organizationId !== "string" || request.organizationId.length === 0) {
    return invalidRequest("recoverRun requires an organization id");
  }
  if (!(CRASH_CAUSES as readonly string[]).includes(crashCause)) {
    return invalidRequest("recoverRun requires a known crash cause");
  }
  if (
    checkpointRevision !== null &&
    (!Number.isInteger(checkpointRevision) || checkpointRevision < 0)
  ) {
    return invalidRequest("The checkpoint revision must be a non-negative integer");
  }

  // Resume-ONCE gate FIRST (recovery-contract.md): a second crash fails clean
  // immediately — no WAL reads, no reallocate, no replay.
  if (deps.gate.attempts(request.runId) >= MAX_RESUME_ATTEMPTS_PER_RUN) {
    return failTerminal(
      "resume_already_attempted",
      envelope("engine_session_lost", "The engine session was already resumed once for this run", {
        hint: REFUND_HINT,
        retryable: false,
      }),
    );
  }

  // (a) WAL slice since the last checkpoint; unreadable log = queue-retryable,
  // resume NOT consumed (§3.4 backoff ×3 is the retry mechanism here).
  let raw: readonly WorkerWalEntry[];
  try {
    raw = await deps.wal.slice(request.documentId, documentRevision);
  } catch {
    return retryableFail(
      "wal_slice_unavailable",
      envelope("engine_session_lost", "The command log could not be read", {
        hint: "A queue-level retry may succeed; the resume attempt is not consumed (§3.4).",
        retryable: true,
      }),
    );
  }

  // Filter markers + verify the chain BEFORE anything touches an engine
  // process (never apply, never silently skip — §5.6, recovery-contract.md).
  const verified = verifyWALSinceCheckpoint(raw, checkpointRevision);
  if (!verified.ok) {
    return failTerminal(
      verified.code,
      envelope(verified.code, verified.message, { hint: verified.hint, retryable: false }),
    );
  }
  if (verified.replayable.length > deps.budget.maxReplayedCommands) {
    return failTerminal(
      "resume_budget_exceeded",
      envelope(
        "resume_budget_exceeded",
        `Replaying ${verified.replayable.length} command(s) exceeds the resume budget of ${deps.budget.maxReplayedCommands}`,
        {
          hint: "Resume budgets are hard caps (§5.2); fail clean and refund instead of an unbounded replay.",
          retryable: false,
        },
      ),
    );
  }

  // (b) Restart: a fresh session for the same tenant + document (§3.2, §3.4).
  let fresh: ReplacementSession;
  try {
    fresh = await deps.pool.reallocate({
      organizationId: request.organizationId,
      documentId: request.documentId,
      runId: request.runId,
    });
  } catch {
    return retryableFail(
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
  deps.gate.record(request.runId);
  const resumeAttempts = deps.gate.attempts(request.runId);

  const plan = planRecoveryAttach(checkpointRevision, verified.replayable.length);
  let attached: AttachOutcome;
  try {
    attached = await deps.attach.executePlan(fresh, request.documentId, plan, verified.replayable);
  } catch {
    return failTerminal(
      "attach_plan_failed",
      envelope(
        "engine_session_lost",
        "Replaying the command log onto the replacement session failed",
        {
          hint: REFUND_HINT,
          retryable: false,
        },
      ),
    );
  }
  if (!attached.ok) {
    return failTerminal(
      "attach_plan_failed",
      envelope(
        "engine_session_lost",
        `The replacement session could not replay the command log (${attached.code})`,
        { hint: REFUND_HINT, retryable: false },
      ),
    );
  }

  const last = verified.replayable.at(-1);
  return {
    kind: "resumed",
    reason: resumedReason(crashCause),
    crashCause,
    sessionId: fresh.sessionId,
    fromRevision: plan.fromRevision,
    toRevision: last === undefined ? plan.fromRevision : last.revisionAfter,
    replayedCount: verified.replayable.length,
    revision: last === undefined ? plan.fromRevision : last.revisionAfter,
    resumeAttempts,
  };
}

/**
 * DI wrapper for the run pipeline: the bootstrap constructs it once with the
 * shared adapters (WAL reader, pool, attach executor, gate, budget, run
 * manager, refund) and the processor calls `recoverRun` on engine-crash
 * evidence, after `shouldResume` (src/recovery/job-retry.ts) routed the
 * failure onto the resume path.
 */
export class RunRecoveryService {
  readonly #deps: RunRecoveryDeps;

  constructor(deps: RunRecoveryDeps) {
    this.#deps = deps;
  }

  recoverRun(request: RunRecoveryRequest): Promise<RunRecoveryOutcome> {
    return recoverRun(request, this.#deps);
  }
}
