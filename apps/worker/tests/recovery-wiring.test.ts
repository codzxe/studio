// apps/worker/tests/recovery-wiring.test.ts — §3.4 crash-recovery WIRING tests
// (W6-M). Fakes only: in-memory WAL rows (with W6-I markers), fake pool,
// fake attach executor, in-memory resume gate, recording run manager + refund.
// Deterministic, no network, <5 s (docs/AGENTS.md).
//
// The four mandated §3.4 scenarios (see apps/engine-pool/src/recovery-contract.md
// "Test seam parity" — here replay is measured in REVISIONS because the adapter
// maps markers out of the seq algebra):
//   1. crash mid-run → marker filter + replay 11–12 + resume ONCE;
//   2. second crash → fail clean + refund;
//   3. rolled_back rows excluded from replay;
//   4. BullMQ attempt classification table (backoff ×3, >3 terminal).
import { describe, expect, it } from "vitest";
import { JOB_RETRY } from "../src/queues.js";
import {
  MAX_RESUME_ATTEMPTS_PER_RUN,
  type AttachExecutorLike,
  type AttachOutcome,
  type PoolLike,
  type ReallocationRequest,
  type RecoveryAttachPlan,
  type RecoveryBudget,
  type RecoveryCheckpoint,
  type RefundLike,
  type RefundOutcome,
  type RefundRequest,
  type ReplayCommand,
  type RunManagerLike,
  type RunRecoveryDeps,
  type RunRecoveryOutcome,
  type RunRecoveryRequest,
  type WorkerWalEntry,
  WAL_ROLLED_BACK_FLAG,
  createInMemoryResumeGate,
  filterReplayableRows,
  planRecoveryAttach,
  recoverRun,
  RunRecoveryService,
  verifyWALSinceCheckpoint,
} from "../src/recovery/run-recovery.js";
import {
  type JobFailureCause,
  InvalidJobAttemptError,
  InvalidRunJobIdError,
  JOB_FAILURE_CAUSES,
  MAX_JOB_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_TYPE,
  backoffDelayMsAfter,
  classifyJobAttempt,
  recoveryActionForJob,
  runJobId,
  shouldResume,
} from "../src/recovery/job-retry.js";

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const REQUEST: RunRecoveryRequest = {
  runId: "run_1",
  documentId: "doc_1",
  organizationId: "org_1",
  crashCause: "pool",
};

interface RowOptions {
  readonly flag?: string;
  readonly result?: Readonly<Record<string, unknown>> | null;
}

/** One `commands` table row; default result marks a successful mutating command. */
const row = (
  seq: number,
  commandName: string,
  revisionBefore: number,
  revisionAfter: number,
  options: RowOptions = {},
): WorkerWalEntry => ({
  documentId: "doc_1",
  seq,
  commandName,
  params: { seq },
  revisionBefore,
  revisionAfter,
  result: options.result === undefined ? { ok: true } : options.result,
  flag: options.flag,
});

/** Crash mid-run after TWO un-checkpointed commands — the canonical §3.4 scenario. */
const CRASH_ROWS: readonly WorkerWalEntry[] = [
  row(11, "agent.begin", 10, 10), // W6-I marker: (R→R), never replayed
  row(12, "layer.new.layer", 10, 11),
  row(13, "edit.fill", 11, 12),
];

interface Fakes {
  readonly deps: RunRecoveryDeps;
  readonly gate: ReturnType<typeof createInMemoryResumeGate>;
  readonly calls: {
    readonly wal: Array<{ readonly documentId: string; readonly fromRevision: number }>;
    readonly pool: ReallocationRequest[];
    readonly attach: Array<{
      readonly documentId: string;
      readonly plan: RecoveryAttachPlan;
      readonly commands: readonly ReplayCommand[];
    }>;
    readonly refund: RefundRequest[];
    readonly failed: Array<{ readonly runId: string; readonly documentRevision: number }>;
  };
}

interface FakeOverrides {
  readonly rows?: readonly WorkerWalEntry[];
  readonly checkpoint?: RecoveryCheckpoint | null;
  readonly walThrows?: boolean;
  readonly poolThrows?: boolean;
  readonly attachOutcome?: () => AttachOutcome;
  readonly budget?: RecoveryBudget;
}

const OK_REFUND: RefundOutcome = { ok: true, amountRefunded: 7, duplicate: false };

function makeFakes(overrides: FakeOverrides = {}): Fakes {
  const rows = overrides.rows ?? CRASH_ROWS;
  const calls: Fakes["calls"] = {
    wal: [],
    pool: [],
    attach: [],
    refund: [],
    failed: [],
  };
  let sessionCounter = 0;
  const gate = createInMemoryResumeGate();
  const wal: RunRecoveryDeps["wal"] = {
    slice: async (documentId, fromRevision) => {
      calls.wal.push({ documentId, fromRevision });
      if (overrides.walThrows === true) {
        throw new Error("wal down");
      }
      return rows;
    },
  };
  const pool: PoolLike = {
    reallocate: async (request: ReallocationRequest) => {
      calls.pool.push(request);
      if (overrides.poolThrows === true) {
        throw new Error("engine spawn failed");
      }
      sessionCounter += 1;
      return {
        sessionId: `sess_${sessionCounter}`,
        organizationId: request.organizationId,
        documentId: request.documentId,
      };
    },
  };
  const attach: AttachExecutorLike = {
    executePlan: async (_session, documentId, plan, commands) => {
      calls.attach.push({ documentId, plan, commands });
      if (overrides.attachOutcome !== undefined) {
        return overrides.attachOutcome();
      }
      return {
        ok: true,
        kind: plan.kind,
        fromRevision: plan.fromRevision,
        appliedCommands: commands.length,
      };
    },
  };
  const runManager: RunManagerLike = {
    markFailedClean: async (input) => {
      calls.failed.push({
        runId: input.runId,
        documentRevision: input.documentRevision,
      });
    },
  };
  const refund: RefundLike = {
    release: async (request: RefundRequest) => {
      calls.refund.push(request);
      return OK_REFUND;
    },
  };
  const deps: RunRecoveryDeps = {
    wal,
    checkpoint: overrides.checkpoint === undefined ? { revision: 10 } : overrides.checkpoint,
    pool,
    attach,
    gate,
    budget: overrides.budget ?? { maxReplayedCommands: 50 },
    runManager,
    refund,
  };
  return { deps, gate, calls };
}

const expectResumed = (outcome: RunRecoveryOutcome) => {
  if (outcome.kind !== "resumed") {
    throw new Error(`expected resumed, got ${outcome.reason}: ${outcome.error.message}`);
  }
  return outcome;
};

const expectFailedClean = (outcome: RunRecoveryOutcome) => {
  if (outcome.kind !== "failed_clean") {
    throw new Error(`expected failed_clean, got resumed (${outcome.sessionId})`);
  }
  return outcome;
};

// ---------------------------------------------------------------------------
// Pure §3.4 step (a): marker filter + WAL verification (W6-I note)
// ---------------------------------------------------------------------------

describe("filterReplayableRows — W6-I markers never replay", () => {
  it("drops agent.begin/commit/rollback, flagged and failed rows; keeps the rest in seq order", () => {
    const input = [
      row(3, "edit.fill", 2, 3),
      row(1, "agent.begin", 0, 0),
      row(2, "layer.new.layer", 0, 1),
      row(4, "agent.commit", 3, 3),
      row(5, "edit.fill", 3, 4, { flag: WAL_ROLLED_BACK_FLAG }),
      row(6, "type.create", 3, 4, { result: null }),
      row(7, "text.set", 3, 4),
    ];
    const names = filterReplayableRows(input).map((entry) => entry.commandName);
    expect(names).toEqual(["layer.new.layer", "edit.fill", "text.set"]);
  });

  it("keeps rows whose result is absent (adapter already filtered failures)", () => {
    const input = [{ ...row(1, "edit.fill", 0, 1), result: undefined }];
    expect(filterReplayableRows(input)).toHaveLength(1);
  });
});

describe("verifyWALSinceCheckpoint — never silently skip (§5.6)", () => {
  it("accepts a dense +1 chain rooted at the checkpoint", () => {
    const verified = verifyWALSinceCheckpoint(
      [row(11, "agent.begin", 10, 10), row(12, "layer.new.layer", 10, 11), row(13, "edit.fill", 11, 12)],
      10,
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.replayable.map((entry) => entry.commandName)).toEqual([
        "layer.new.layer",
        "edit.fill",
      ]);
    }
  });

  const violationCases: Array<
    [string, readonly WorkerWalEntry[], number | null, string]
  > = [
    ["raw seq gap", [row(11, "layer.new.layer", 10, 11), row(13, "edit.fill", 11, 12)], 10, "wal_gap_detected"],
    ["checkpoint does not precede the slice", [row(11, "layer.new.layer", 9, 10)], 10, "wal_slice_mismatch"],
    ["broken revision chain", [row(11, "layer.new.layer", 10, 11), row(12, "edit.fill", 12, 13)], 10, "wal_monotonicity_violation"],
    ["revision rewind", [row(11, "layer.new.layer", 10, 11), row(12, "edit.fill", 11, 11)], 10, "wal_monotonicity_violation"],
    ["invalid seq position", [row(0, "layer.new.layer", 10, 11)], 10, "wal_invalid_input"],
  ];
  for (const [label, entries, checkpoint, code] of violationCases) {
    it(`rejects ${label} with ${code}`, () => {
      const verified = verifyWALSinceCheckpoint(entries, checkpoint);
      expect(verified.ok).toBe(false);
      if (!verified.ok) {
        expect(verified.code).toBe(code);
      }
    });
  }
});

describe("planRecoveryAttach — mirror of engine-pool decideAttachPlan", () => {
  const cases: Array<[string, number | null, number, RecoveryAttachPlan]> = [
    ["no checkpoint, empty log → fresh", null, 0, { kind: "fresh", fromRevision: 0, commandCount: 0 }],
    ["no checkpoint, rows → full replay", null, 3, { kind: "replay", fromRevision: 0, commandCount: 3 }],
    ["checkpoint @R, nothing after → checkpoint", 10, 0, { kind: "checkpoint", fromRevision: 10, commandCount: 0 }],
    ["checkpoint @R, rows after → replay", 10, 2, { kind: "replay", fromRevision: 10, commandCount: 2 }],
  ];
  for (const [label, checkpoint, count, expected] of cases) {
    it(label, () => {
      expect(planRecoveryAttach(checkpoint, count)).toEqual(expected);
    });
  }
});

describe("createInMemoryResumeGate", () => {
  it("counts per run id, starting at zero", () => {
    const gate = createInMemoryResumeGate();
    expect(gate.attempts("run_1")).toBe(0);
    gate.record("run_1");
    gate.record("run_1");
    gate.record("run_2");
    expect(gate.attempts("run_1")).toBe(2);
    expect(gate.attempts("run_2")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1 + 2: crash mid-run → replay + resume ONCE; second crash → fail
// clean + refund (§3.4, recovery-contract.md)
// ---------------------------------------------------------------------------

describe("recoverRun — §3.4 crash recovery wiring", () => {
  it("crash mid-run: filters markers, replays revisions 11–12, resumes ONCE", async () => {
    const { deps, calls, gate } = makeFakes();
    const outcome = await new RunRecoveryService(deps).recoverRun({
      ...REQUEST,
      crashCause: "watchdog",
    });
    const resumed = expectResumed(outcome);
    // The canonical scenario: checkpoint 10, two un-checkpointed commands →
    // replay exactly revisions 11–12 and resume once.
    expect(resumed.reason).toBe("watchdog_crash_replayed");
    expect(resumed.replayedCount).toBe(2);
    expect(resumed.fromRevision).toBe(10);
    expect(resumed.toRevision).toBe(12);
    expect(resumed.revision).toBe(12);
    expect(resumed.resumeAttempts).toBe(MAX_RESUME_ATTEMPTS_PER_RUN);
    expect(resumed.sessionId).toBe("sess_1");
    // (a) the slice was fetched since the last checkpoint…
    expect(calls.wal).toEqual([{ documentId: "doc_1", fromRevision: 10 }]);
    // (b) …a replacement session was reallocated for the same tenant + document…
    expect(calls.pool).toEqual([
      { organizationId: "org_1", documentId: "doc_1", runId: "run_1" },
    ]);
    // …and the replay plan carried ONLY the filtered content commands.
    expect(calls.attach).toHaveLength(1);
    const attachCall = calls.attach[0];
    if (attachCall === undefined) throw new Error("attach was not called");
    expect(attachCall.plan).toEqual({ kind: "replay", fromRevision: 10, commandCount: 2 });
    expect(attachCall.commands.map((command) => command.commandName)).toEqual([
      "layer.new.layer",
      "edit.fill",
    ]);
    // (c) the gate is consumed — resume ONCE.
    expect(gate.attempts("run_1")).toBe(1);
    // No failure side effects on the happy path (§3.3 step 7 is for failures).
    expect(calls.refund).toEqual([]);
    expect(calls.failed).toEqual([]);
  });

  it("second crash: fail clean immediately — refund called, no WAL re-read, no reallocate", async () => {
    const { deps, calls } = makeFakes();
    const first = expectResumed(await recoverRun(REQUEST, deps));
    expect(first.resumeAttempts).toBe(1);
    const second = expectFailedClean(await recoverRun(REQUEST, deps));
    // §3.4: resume ONCE — the second crash is terminal with the typed envelope.
    expect(second.reason).toBe("resume_already_attempted");
    expect(second.error.code).toBe("engine_session_lost");
    expect(second.error.retryable).toBe(false);
    expect(second.resumeAttempts).toBe(1);
    expect(second.documentRevision).toBe(10);
    // recovery-contract.md: no reallocate, no replay, no WAL reads.
    expect(calls.wal).toHaveLength(1);
    expect(calls.pool).toHaveLength(1);
    expect(calls.attach).toHaveLength(1);
    // §3.3 step 7: the run manager marked failed_clean and the refund fired.
    expect(calls.failed).toEqual([{ runId: "run_1", documentRevision: 10 }]);
    expect(calls.refund).toEqual([
      { organizationId: "org_1", runId: "run_1", cause: "resume_already_attempted" },
    ]);
    expect(second.refund).toEqual(OK_REFUND);
  });

  it("rolled_back rows (and agent markers, failed commands) are excluded from replay", async () => {
    const rows = [
      row(5, "agent.begin", 4, 4),
      row(6, "layer.new.layer", 4, 5),
      // flagged CONTENT row: excluded by the flag alone (W6-I: any flagged row is a marker)
      row(7, "edit.fill", 5, 6, { flag: WAL_ROLLED_BACK_FLAG }),
      row(8, "edit.fill", 5, 6),
      row(9, "style.apply", 6, 7),
      // rollback marker: agent.* AND flagged; revision columns verbatim (not +1-chained)
      row(10, "agent.rollback", 4, 7, { flag: WAL_ROLLED_BACK_FLAG }),
      // failed command: audited via agent_steps, never replayed (§5.6)
      row(11, "type.create", 7, 8, { result: null }),
      row(12, "text.set", 7, 8),
    ];
    const { deps, calls } = makeFakes({ rows, checkpoint: { revision: 4 } });
    const outcome = expectResumed(
      await recoverRun({ ...REQUEST, crashCause: "manual" }, deps),
    );
    expect(outcome.reason).toBe("manual_stop_replayed");
    expect(outcome.replayedCount).toBe(4);
    expect(outcome.revision).toBe(8);
    const attachCall = calls.attach[0];
    if (attachCall === undefined) throw new Error("attach was not called");
    expect(attachCall.commands.map((command) => command.commandName)).toEqual([
      "layer.new.layer",
      "edit.fill",
      "style.apply",
      "text.set",
    ]);
    expect(attachCall.commands.some((command) => command.flag === WAL_ROLLED_BACK_FLAG)).toBe(
      false,
    );
  });

  it("empty slice after the checkpoint: resume on the checkpoint with zero replayed commands", async () => {
    const { deps, calls } = makeFakes({ rows: [], checkpoint: { revision: 10 } });
    const outcome = expectResumed(await recoverRun(REQUEST, deps));
    expect(outcome.replayedCount).toBe(0);
    expect(outcome.revision).toBe(10);
    expect(outcome.toRevision).toBe(10);
    const attachCall = calls.attach[0];
    if (attachCall === undefined) throw new Error("attach was not called");
    expect(attachCall.plan).toEqual({ kind: "checkpoint", fromRevision: 10, commandCount: 0 });
    expect(attachCall.commands).toEqual([]);
  });

  it("no checkpoint yet: full replay from revision 0", async () => {
    const rows = [
      row(1, "agent.begin", 0, 0),
      row(2, "layer.new.layer", 0, 1),
      row(3, "edit.fill", 1, 2),
    ];
    const { deps, calls } = makeFakes({ rows, checkpoint: null });
    const outcome = expectResumed(await recoverRun(REQUEST, deps));
    expect(outcome.fromRevision).toBe(0);
    expect(outcome.revision).toBe(2);
    expect(outcome.replayedCount).toBe(2);
    expect(calls.wal).toEqual([{ documentId: "doc_1", fromRevision: 0 }]);
    const attachCall = calls.attach[0];
    if (attachCall === undefined) throw new Error("attach was not called");
    expect(attachCall.plan).toEqual({ kind: "replay", fromRevision: 0, commandCount: 2 });
  });

  it("unreadable WAL: queue-retryable, resume NOT consumed, no refund, no mark", async () => {
    const { deps, calls, gate } = makeFakes({ walThrows: true });
    const outcome = expectFailedClean(await recoverRun(REQUEST, deps));
    expect(outcome.reason).toBe("wal_slice_unavailable");
    expect(outcome.error.code).toBe("engine_session_lost");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.resumeAttempts).toBe(0);
    expect(gate.attempts("run_1")).toBe(0);
    expect(calls.pool).toEqual([]);
    expect(calls.refund).toEqual([]);
    expect(calls.failed).toEqual([]);
    expect(recoveryActionForJob(outcome)).toBe("throw_for_retry");
  });

  it("reallocate failure: queue-retryable, resume NOT consumed", async () => {
    const { deps, calls, gate } = makeFakes({ poolThrows: true });
    const outcome = expectFailedClean(await recoverRun(REQUEST, deps));
    expect(outcome.reason).toBe("reallocate_failed");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.resumeAttempts).toBe(0);
    expect(gate.attempts("run_1")).toBe(0);
    expect(calls.wal).toHaveLength(1);
    expect(calls.attach).toEqual([]);
    expect(calls.refund).toEqual([]);
    expect(calls.failed).toEqual([]);
  });

  it("resume budget exceeded: fail clean + refund, resume not consumed, no reallocate (§5.2)", async () => {
    const { deps, calls, gate } = makeFakes({ budget: { maxReplayedCommands: 1 } });
    const outcome = expectFailedClean(await recoverRun(REQUEST, deps));
    expect(outcome.reason).toBe("resume_budget_exceeded");
    expect(outcome.error.code).toBe("resume_budget_exceeded");
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.resumeAttempts).toBe(0);
    expect(gate.attempts("run_1")).toBe(0);
    expect(calls.pool).toEqual([]);
    expect(calls.refund).toHaveLength(1);
    expect(calls.failed).toHaveLength(1);
  });

  it("attach replay failure: fail clean + refund, resume attempt SPENT (sequencing guarantee)", async () => {
    const { deps, calls, gate } = makeFakes({
      attachOutcome: () => ({
        ok: false,
        code: "engine_replay_failed",
        message: "batch rejected",
        retryable: true,
      }),
    });
    const outcome = expectFailedClean(await recoverRun(REQUEST, deps));
    expect(outcome.reason).toBe("attach_plan_failed");
    expect(outcome.error.code).toBe("engine_session_lost");
    expect(outcome.error.retryable).toBe(false);
    // The attempt is spent — a half-replayed resume is never retried.
    expect(outcome.resumeAttempts).toBe(1);
    expect(gate.attempts("run_1")).toBe(1);
    expect(calls.refund).toHaveLength(1);
    expect(calls.failed).toHaveLength(1);
    expect(recoveryActionForJob(outcome)).toBe("complete_failed");
  });

  it("WAL gap detected through recoverRun: fail clean + refund, resume not consumed", async () => {
    const rows = [row(11, "layer.new.layer", 10, 11), row(13, "edit.fill", 11, 12)];
    const { deps, calls, gate } = makeFakes({ rows });
    const outcome = expectFailedClean(await recoverRun(REQUEST, deps));
    expect(outcome.reason).toBe("wal_gap_detected");
    expect(outcome.error.code).toBe("wal_gap_detected");
    expect(outcome.resumeAttempts).toBe(0);
    expect(gate.attempts("run_1")).toBe(0);
    expect(calls.refund).toHaveLength(1);
  });

  it("invalid request: typed envelope, no side effects (ids untrusted)", async () => {
    const { deps, calls } = makeFakes();
    const outcome = expectFailedClean(
      await recoverRun({ ...REQUEST, runId: "" }, deps),
    );
    expect(outcome.reason).toBe("invalid_recovery_request");
    expect(outcome.error.code).toBe("invalid_recovery_request");
    expect(outcome.refund).toBeUndefined();
    expect(calls.wal).toEqual([]);
    expect(calls.pool).toEqual([]);
    expect(calls.refund).toEqual([]);
    expect(calls.failed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: BullMQ attempt classification + retry glue (§3.4 backoff ×3)
// ---------------------------------------------------------------------------

describe("job-retry glue — §3.4 queue retries the JOB, coordinator resumes the RUN", () => {
  it("constants stay derived from the single source of truth (src/queues.ts JOB_RETRY)", () => {
    expect(MAX_JOB_ATTEMPTS).toBe(JOB_RETRY.attempts);
    expect(MAX_JOB_ATTEMPTS).toBe(3);
    expect(RETRY_BACKOFF_BASE_MS).toBe(JOB_RETRY.backoff.delay);
    expect(RETRY_BACKOFF_BASE_MS).toBe(5_000);
    expect(RETRY_BACKOFF_TYPE).toBe("exponential");
  });

  it("classifies attempts 1–3 as exponential-backoff retries and >3 as terminal", () => {
    const table: Array<
      [number, "execute" | "terminal", number | undefined, number, boolean]
    > = [
      [1, "execute", undefined, 2, false],
      [2, "execute", 5_000, 1, false],
      [3, "execute", 10_000, 0, false],
      [4, "terminal", undefined, 0, true],
      [7, "terminal", undefined, 0, true],
    ];
    for (const [attempt, action, backoffBeforeMs, remainingRetries, exhausted] of table) {
      const plan = classifyJobAttempt(attempt);
      expect(plan.action, `attempt ${attempt}`).toBe(action);
      expect(plan.backoffBeforeMs, `attempt ${attempt} backoff`).toBe(backoffBeforeMs);
      expect(plan.remainingRetries, `attempt ${attempt} remaining`).toBe(remainingRetries);
      expect(plan.exhausted, `attempt ${attempt} exhausted`).toBe(exhausted);
    }
  });

  it("exponential backoff doubles from the 5 s base (§3.4)", () => {
    expect(backoffDelayMsAfter(1)).toBe(5_000);
    expect(backoffDelayMsAfter(2)).toBe(10_000);
    expect(backoffDelayMsAfter(3)).toBe(20_000);
  });

  it("rejects non-1-based attempt numbers (programmer error)", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => classifyJobAttempt(bad)).toThrow(InvalidJobAttemptError);
      expect(() => backoffDelayMsAfter(bad)).toThrow(InvalidJobAttemptError);
      expect(() => shouldResume(bad, "engine_crash")).toThrow(InvalidJobAttemptError);
    }
  });

  it("shouldResume: crash-class failures at attempts 1–3 resume; everything else fails fast", () => {
    const table: Array<[number, JobFailureCause, boolean]> = [
      [1, "engine_crash", true],
      [2, "engine_crash", true],
      [3, "engine_crash", true],
      [4, "engine_crash", false], // §3.4 budget spent → mark failed + alert, never resume
      [1, "engine_timeout", false], // §3.4 timeouts: cancel, rollback, refund — no resume
      [2, "validation_failed", false],
      [2, "plan_invalid", false],
      [2, "payload_invalid", false],
      [2, "provider_unhealthy", false],
      [2, "budget_exceeded", false], // §5.2 clean stop
    ];
    for (const [attempt, cause, expected] of table) {
      expect(shouldResume(attempt, cause), `attempt ${attempt} ${cause}`).toBe(expected);
    }
    expect(JOB_FAILURE_CAUSES).toContain("engine_crash");
  });

  it("jobId = the run's idempotency key (§3.4)", () => {
    expect(runJobId("run_1")).toBe("run_1");
    expect(() => runJobId("")).toThrow(InvalidRunJobIdError);
  });

  it("maps recovery outcomes onto BullMQ actions (recovery-contract.md)", () => {
    const resumed: RunRecoveryOutcome = {
      kind: "resumed",
      reason: "pool_crash_replayed",
      crashCause: "pool",
      sessionId: "sess_1",
      fromRevision: 10,
      toRevision: 12,
      replayedCount: 2,
      revision: 12,
      resumeAttempts: 1,
    };
    expect(recoveryActionForJob(resumed)).toBe("continue");
    const retryable = expectFailedClean(
      await recoverRun(REQUEST, makeFakes({ walThrows: true }).deps),
    );
    expect(recoveryActionForJob(retryable)).toBe("throw_for_retry");
    const terminal = expectFailedClean(
      await recoverRun(REQUEST, makeFakes({ budget: { maxReplayedCommands: 1 } }).deps),
    );
    expect(recoveryActionForJob(terminal)).toBe("complete_failed");
  });
});
