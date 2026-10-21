// apps/worker/tests/recovery/resume-once-gate.test.ts — the §3.4 resume-ONCE
// gate end to end (W10-D):
//
//   "Engine crash mid-run: restart, replay to checkpoint, resume once."
//   "queue job retried with backoff ×3; if still failing, mark run failed
//    and alert."
//
// The two retry layers are DIFFERENT things (apps/engine-pool/src/
// recovery-contract.md, mirrored in src/recovery/job-retry.ts): the QUEUE
// retries the JOB (backoff ×3); the worker resumes the RUN — ONCE. Without
// the split, the ping-pong hazard bites: three queue attempts must not buy
// three engine replays.
//
//   1. PROCESS — crash → resume (the single gate attempt is spent well, on a
//      real replacement engine, replaying measured WAL rows); crash AGAIN →
//      terminal fail-clean: not even a WAL read, no reallocate, no replay —
//      no third engine, refund once (a redelivered attempt refunds nothing
//      more), document revision pinned to the checkpoint. The §20 #13 latency
//      of the terminal decision is asserted under fake-clock acceleration.
//   2. PURE — the gate is PER RUN (a different crashed run still gets its
//      single resume on the same gate) + the BullMQ attempt mapping from W6-M:
//      the shouldResume routing table, attempt classification with the §3.4
//      backoff constants, jobId = idempotency key, and outcome → BullMQ
//      action (terminal failed_clean COMPLETES so remaining attempts are
//      never burned).
//
// Skip-guard: the process block skips if the mock-engine entry is missing
// (spine convention); the pure block always runs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
} from "../../src/recovery/job-retry.js";
import type { RunRecoveryOutcome } from "../../src/recovery/run-recovery.js";
import {
  MAX_RESUME_ATTEMPTS_PER_RUN,
  createInMemoryResumeGate,
  recoverRun,
} from "../../src/recovery/run-recovery.js";
import {
  DECISION_BUDGET_MS,
  type SpawnedEngineHandle,
  FakeAttachExecutor,
  FakeClock,
  FakeRefundLedger,
  ProcessAttachExecutor,
  RecordingPool,
  RecordingRunManager,
  RecordingWalReader,
  RESUME_REPLAY_CAP,
  TIER_CREDITS,
  chainedRows,
  detectCrashUnderFakeClock,
  establishCheckpoint,
  expectedResumeDecisionMs,
  expectedResumeExhaustedDecisionMs,
  executeScriptedRun,
  killNine,
  mutatingCallAgainstDeadEngine,
  sortedLayerNames,
  spawnDrillEngine,
} from "./drill-harness.js";
import {
  cleanupSpineRoot,
  makeSpineRoot,
  mockEngineEntry,
  rawInspect,
} from "../spine/harness.js";

const mockEntry = mockEngineEntry();

const ORG_ID = "org_w10d_gate";
const DOC_ID = "doc_gate";
const RUN_A = "run_gate_a";
const RUN_B = "run_gate_b";
const RUN_C = "run_gate_c";

// ---------------------------------------------------------------------------
// Process: crash → resume; crash again → terminal (skip-guarded)
// ---------------------------------------------------------------------------

interface GateContext {
  readonly root: string;
  readonly engine1: SpawnedEngineHandle;
  readonly extras: SpawnedEngineHandle[];
  readonly registry: Map<string, SpawnedEngineHandle>;
  readonly gate: ReturnType<typeof createInMemoryResumeGate>;
  checkpointRevision: number;
  savePath: string;
  resumed: { sessionId: string; toRevision: number } | null;
}

let ctx: GateContext | undefined;

const gateCtx = (): GateContext => {
  if (ctx === undefined) {
    throw new Error("gate context not initialised (beforeAll failed)");
  }
  return ctx;
};

const spawnReplacement = async (): Promise<{ sessionId: string; organizationId: string }> => {
  const handle = await spawnDrillEngine(gateCtx().root);
  gateCtx().extras.push(handle);
  const sessionId = `replacement-${gateCtx().registry.size + 1}`;
  gateCtx().registry.set(sessionId, handle);
  return { sessionId, organizationId: ORG_ID };
};

const clientOfReplacement = (sessionId: string): SpawnedEngineHandle["client"] => {
  const handle = gateCtx().registry.get(sessionId);
  if (handle === undefined) {
    throw new Error(`no replacement engine for session ${sessionId}`);
  }
  return handle.client;
};

const refusingSpawn = async (): Promise<{ sessionId: string; organizationId: string }> => {
  throw new Error("the resume-ONCE gate must block before any engine restart");
};

describe.skipIf(mockEntry === null)("§3.4 resume-ONCE gate — crash, resume, crash again", () => {
  beforeAll(async () => {
    const root = makeSpineRoot();
    const engine1 = await spawnDrillEngine(root);
    const committed = await establishCheckpoint(engine1.client, {
      savePath: "resume-gate/checkpoint.pcraft",
      name: "Resume Gate",
      headline: "One resume only",
    });
    ctx = {
      root,
      engine1,
      extras: [],
      registry: new Map(),
      gate: createInMemoryResumeGate(),
      checkpointRevision: committed.checkpointRevision,
      savePath: committed.savePath,
      resumed: null,
    };
  }, 30_000);

  afterAll(async () => {
    await gateCtx().engine1.client.close();
    await gateCtx().engine1.mock.stop();
    for (const handle of gateCtx().extras) {
      await handle.client.close();
      await handle.mock.stop();
    }
    cleanupSpineRoot(gateCtx().root);
  }, 30_000);

  it(
    "crash → resume: the gate's single attempt replays the measured WAL onto a REAL replacement (35 s decision ≤ 60 s)",
    async () => {
      const run = await executeScriptedRun(gateCtx().engine1.client, {
        documentId: DOC_ID,
        baseRevision: gateCtx().checkpointRevision,
        count: 3,
        layerPrefix: "Gate Step",
      });
      const death = await killNine(gateCtx().engine1.mock);
      expect(death.signal).toBe("SIGKILL");
      await mutatingCallAgainstDeadEngine(gateCtx().engine1.client);

      // §3.4 routing: a crash-class failure within the queue budget resumes.
      expect(MAX_RESUME_ATTEMPTS_PER_RUN).toBe(1);
      expect(shouldResume(1, "engine_crash")).toBe(true);

      const clock = new FakeClock();
      detectCrashUnderFakeClock(clock);
      const pool = new RecordingPool(clock, spawnReplacement);
      const attach = new ProcessAttachExecutor(clock, gateCtx().savePath, clientOfReplacement);
      const refund = new FakeRefundLedger(clock, TIER_CREDITS);
      const outcome = await recoverRun(
        { runId: RUN_A, documentId: DOC_ID, organizationId: ORG_ID, crashCause: "pool" },
        {
          wal: new RecordingWalReader(run.rows, clock),
          checkpoint: { revision: gateCtx().checkpointRevision },
          pool,
          attach,
          gate: gateCtx().gate,
          budget: { maxReplayedCommands: RESUME_REPLAY_CAP },
          runManager: new RecordingRunManager(clock),
          refund,
        },
      );
      expect(outcome.kind).toBe("resumed");
      if (outcome.kind !== "resumed") {
        return;
      }
      expect(outcome.replayedCount).toBe(3);
      expect(outcome.toRevision).toBe(run.revisionAfterLast);
      expect(outcome.resumeAttempts).toBe(1); // the single §3.4 attempt, spent
      expect(gateCtx().gate.attempts(RUN_A)).toBe(1);

      // §20 #13: the resume decision is inside the 60 s gate (fake clock).
      expect(clock.nowMs()).toBe(expectedResumeDecisionMs());
      expect(expectedResumeDecisionMs()).toBeLessThanOrEqual(DECISION_BUDGET_MS);

      // The replay really happened (§5.6 verbatim, on the replacement).
      const journal = attach.journal.at(-1);
      if (journal === undefined) {
        throw new Error("the resume replay never ran");
      }
      expect(journal.appliedCommands).toBe(3);
      const replacement = clientOfReplacement(outcome.sessionId);
      const resumed = await rawInspect(replacement);
      expect(resumed.revision).toBe(journal.openBaselineRevision + 3);
      expect(sortedLayerNames(resumed)).toContain("Gate Step 03");

      // A resumed run is not refunded; the loop continues (queue completes).
      expect(refund.releases).toHaveLength(0);
      expect(recoveryActionForJob(outcome)).toBe("continue");

      gateCtx().resumed = { sessionId: outcome.sessionId, toRevision: outcome.toRevision };
    },
    30_000,
  );

  it(
    "crash again → terminal fail-clean: no WAL read, no reallocate, no replay (no ping-pong), refund once",
    async () => {
      const resumed = gateCtx().resumed;
      if (resumed === null) {
        throw new Error("the first crash never resumed (previous test failed)");
      }
      // The resumed run crashes again — the replacement engine dies too.
      const handle = gateCtx().registry.get(resumed.sessionId);
      if (handle === undefined) {
        throw new Error("the replacement engine was never registered");
      }
      const death = await killNine(handle.mock);
      expect(death.signal).toBe("SIGKILL");

      // Routing still allows a redelivered attempt to reach recovery — the
      // GATE is the limiter, not the queue budget.
      expect(shouldResume(2, "engine_crash")).toBe(true);

      const clock = new FakeClock();
      detectCrashUnderFakeClock(clock);
      const wal = new RecordingWalReader([], clock); // must never be read
      const pool = new RecordingPool(clock, refusingSpawn); // must never spawn
      const attach = new ProcessAttachExecutor(clock, gateCtx().savePath, clientOfReplacement);
      const runManager = new RecordingRunManager(clock);
      const refund = new FakeRefundLedger(clock, TIER_CREDITS);
      const request = {
        runId: RUN_A,
        documentId: DOC_ID,
        organizationId: ORG_ID,
        crashCause: "pool" as const,
      };
      const deps = {
        wal,
        checkpoint: { revision: gateCtx().checkpointRevision },
        pool,
        attach,
        gate: gateCtx().gate,
        budget: { maxReplayedCommands: RESUME_REPLAY_CAP },
        runManager,
        refund,
      };

      const outcome = await recoverRun(request, deps);
      expect(outcome.kind).toBe("failed_clean");
      if (outcome.kind !== "failed_clean") {
        return;
      }
      expect(outcome.reason).toBe("resume_already_attempted");
      expect(outcome.error.code).toBe("engine_session_lost");
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.error.hint).toContain("Refund");
      expect(outcome.documentRevision).toBe(gateCtx().checkpointRevision);
      expect(outcome.resumeAttempts).toBe(1);

      // NO PING-PONG: the second crash never reached the engine layer.
      expect(wal.calls).toHaveLength(0); // not even a WAL read
      expect(pool.calls).toHaveLength(0); // no replacement engine
      expect(attach.journal).toHaveLength(0); // no replay
      expect(gateCtx().gate.attempts(RUN_A)).toBe(1); // still exactly one spend

      // The terminal decision is cheap and inside the §20 #13 gate (the
      // expected sum omits even the WAL read — that is the point).
      expect(clock.nowMs()).toBe(expectedResumeExhaustedDecisionMs());
      expect(expectedResumeExhaustedDecisionMs()).toBeLessThanOrEqual(DECISION_BUDGET_MS);

      // §3.3 step 7: failed_clean row update + idempotent refund.
      const failedClean = runManager.failedCleanCalls.at(-1);
      if (failedClean === undefined) {
        throw new Error("the run was never marked failed_clean");
      }
      expect(failedClean.documentRevision).toBe(gateCtx().checkpointRevision);
      expect(failedClean.error.code).toBe("engine_session_lost");
      expect(refund.releases).toHaveLength(1);
      expect(outcome.refund?.duplicate).toBe(false);
      expect(refund.totalRefunded(RUN_A)).toBe(TIER_CREDITS);

      // Terminal failed_clean COMPLETES the job — BullMQ must not burn the
      // remaining attempts on a dead run (§3.4, recovery-contract.md).
      expect(recoveryActionForJob(outcome)).toBe("complete_failed");

      // A redelivered attempt hits the same gate, fails clean again and
      // refunds NOTHING more (`${runId}:refund` never double-applies, §14.2).
      const redelivered = await recoverRun(request, deps);
      expect(redelivered.kind).toBe("failed_clean");
      expect(redelivered.refund?.duplicate).toBe(true);
      expect(refund.totalRefunded(RUN_A)).toBe(TIER_CREDITS);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Pure: per-run gate + BullMQ attempt mapping (W6-M tables)
// ---------------------------------------------------------------------------

describe("§3.4 resume-ONCE gate — per-run, at the decision level", () => {
  const gate = createInMemoryResumeGate();

  const drive = async (runId: string, rows: ReturnType<typeof chainedRows>) => {
    const clock = new FakeClock();
    return recoverRun(
      { runId, documentId: DOC_ID, organizationId: ORG_ID, crashCause: "pool" },
      {
        wal: new RecordingWalReader(rows, clock),
        checkpoint: { revision: rows.at(0)?.revisionBefore ?? 0 },
        pool: new RecordingPool(clock, async () => ({
          sessionId: `session-${runId}`,
          organizationId: ORG_ID,
        })),
        attach: new FakeAttachExecutor(clock),
        gate,
        budget: { maxReplayedCommands: RESUME_REPLAY_CAP },
        runManager: new RecordingRunManager(clock),
        refund: new FakeRefundLedger(clock, TIER_CREDITS),
      },
    );
  };

  it("another crashed run still gets its single resume on the SAME gate — then not a second one", async () => {
    const rowsB = chainedRows(DOC_ID, 4, [
      { commandName: "layer.new.layer", params: { name: "Gate B 1" } },
      { commandName: "layer.new.layer", params: { name: "Gate B 2" } },
    ]);
    const first = await drive(RUN_B, rowsB);
    expect(first.kind).toBe("resumed");
    if (first.kind === "resumed") {
      expect(first.replayedCount).toBe(2);
      expect(gate.attempts(RUN_B)).toBe(1);
    }

    const again = await drive(RUN_B, rowsB);
    expect(again.kind).toBe("failed_clean");
    if (again.kind === "failed_clean") {
      expect(again.reason).toBe("resume_already_attempted");
    }

    // PER RUN: a different crashed run is not starved by RUN_B's spent gate.
    const rowsC = chainedRows(DOC_ID, 9, [
      { commandName: "layer.new.layer", params: { name: "Gate C 1" } },
    ]);
    const other = await drive(RUN_C, rowsC);
    expect(other.kind).toBe("resumed");
    expect(gate.attempts(RUN_C)).toBe(1);
  });
});

describe("§3.4 BullMQ attempt mapping — shouldResume routing table (W6-M)", () => {
  const routingRows = JOB_FAILURE_CAUSES.flatMap((cause) =>
    [1, 2, 3, 4].map((attempt) => ({
      attempt,
      cause,
      expected: cause === "engine_crash" && attempt <= MAX_JOB_ATTEMPTS,
    })),
  );

  it.each(routingRows)(
    "shouldResume(attempt $attempt, cause $cause) → $expected",
    ({ attempt, cause, expected }) => {
      expect(shouldResume(attempt, cause)).toBe(expected);
    },
  );

  it("never resumes past the queue budget: attempt > 3 is terminal (mark failed + alert)", () => {
    const plan = classifyJobAttempt(4);
    expect(plan.action).toBe("terminal");
    expect(plan.exhausted).toBe(true);
    expect(plan.remainingRetries).toBe(0);
    expect(shouldResume(4, "engine_crash")).toBe(false);
  });
});

describe("§3.4 BullMQ attempt mapping — classification, backoff, jobId, outcome→action", () => {
  it("classifies attempts 1–3 as execute with exponential backoff 5 s / 10 s", () => {
    expect(MAX_JOB_ATTEMPTS).toBe(3);
    expect(RETRY_BACKOFF_BASE_MS).toBe(5_000);
    expect(RETRY_BACKOFF_TYPE).toBe("exponential");
    expect(backoffDelayMsAfter(1)).toBe(5_000);
    expect(backoffDelayMsAfter(2)).toBe(10_000);
    expect(backoffDelayMsAfter(3)).toBe(20_000); // after the final allowed attempt

    const first = classifyJobAttempt(1);
    expect(first.action).toBe("execute");
    expect(first.backoffBeforeMs).toBeUndefined();
    expect(first.remainingRetries).toBe(2);
    expect(first.exhausted).toBe(false);

    const second = classifyJobAttempt(2);
    expect(second.action).toBe("execute");
    expect(second.backoffBeforeMs).toBe(5_000);
    expect(second.remainingRetries).toBe(1);

    const third = classifyJobAttempt(3);
    expect(third.action).toBe("execute");
    expect(third.backoffBeforeMs).toBe(10_000);
    expect(third.remainingRetries).toBe(0);
    expect(third.exhausted).toBe(false);
  });

  it("rejects non-1-based attempt numbers (programmer error, fail loud)", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => classifyJobAttempt(bad)).toThrow(InvalidJobAttemptError);
      expect(() => shouldResume(bad, "engine_crash")).toThrow(InvalidJobAttemptError);
    }
  });

  it("maps jobId to the run's idempotency key (§3.3 step 2 — retries never double-apply)", () => {
    expect(runJobId(RUN_A)).toBe(RUN_A);
    expect(() => runJobId("")).toThrow(InvalidRunJobIdError);
  });

  it("maps recovery outcomes to BullMQ actions (terminal failed_clean completes)", () => {
    const resumed: RunRecoveryOutcome = {
      kind: "resumed",
      reason: "pool_crash_replayed",
      crashCause: "pool",
      sessionId: "session-1",
      fromRevision: 4,
      toRevision: 7,
      replayedCount: 3,
      revision: 7,
      resumeAttempts: 1,
    };
    const retryable: RunRecoveryOutcome = {
      kind: "failed_clean",
      reason: "reallocate_failed",
      crashCause: "pool",
      resumeAttempts: 0,
      documentRevision: 4,
      error: {
        ok: false,
        code: "engine_session_lost",
        message: "A replacement engine session could not be started",
        hint: "The queue-level retry (backoff ×3) may succeed; the resume attempt is not consumed (§3.4).",
        retryable: true,
      },
    };
    const terminal: RunRecoveryOutcome = {
      kind: "failed_clean",
      reason: "resume_already_attempted",
      crashCause: "pool",
      resumeAttempts: 1,
      documentRevision: 4,
      error: {
        ok: false,
        code: "engine_session_lost",
        message: "The engine session was already resumed once for this run",
        retryable: false,
      },
    };
    expect(recoveryActionForJob(resumed)).toBe("continue");
    expect(recoveryActionForJob(retryable)).toBe("throw_for_retry");
    expect(recoveryActionForJob(terminal)).toBe("complete_failed");
  });
});
