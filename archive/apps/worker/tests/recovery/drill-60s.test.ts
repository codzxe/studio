// apps/worker/tests/recovery/drill-60s.test.ts — the §20 #13 beta-gate drill at
// process level (W10-D):
//
//   "A run killed mid-execution (engine killed) recovers within 60 s or fails
//    cleanly with a refund, leaving the document consistent."
//
// Layering (why this suite exists next to its siblings):
//   - infra/tests/chaos/kill-engine-midrun.mjs (W9-L) is the OPERATOR drill —
//     CLI script, printed report, runbook cross-links;
//   - tests/spine/recovery-spine.test.ts (W2-J) pins the §3.4 envelope contract
//     of ONE crashed engine.execute (may-have-completed semantics);
//   - THIS suite is the WORKER drill: the real recoverRun decision code
//     (../../src/recovery/run-recovery.ts, W6-M) driving a REAL spawned
//     mock-engine replacement, with the §20 #13 latency asserted under
//     fake-clock acceleration — production envelopes, zero sleeping.
//
// Scenario A (recovers within 60 s): doc.new → pre-run batch → doc.save pins
// the checkpoint → a scripted 50-command run, kill -9 after 25 replies →
// recoverRun resumes: doc.open + ONE batch replay of the 25 measured WAL rows
// onto a real replacement engine. Decision latency (fake clock):
//     crash-detection polls      3 × 2 000  =  6 000
//   + WAL slice read                        =  2 000
//   + replacement cold start                = 15 000
//   + doc.open + inspect + replay batch     = 12 000  (3 × 4 000)
//   = 35 000 ms in-process  ≤ 60 000, and 50 000 ms ≤ 60 000 via the worst-case
//   §3.4 queue route (BullMQ backoff 5 s + 10 s before the recovery attempt —
//   real constants from src/recovery/job-retry.ts). The ≤50-command slice is
//   ONE round trip because the engine applies batches in-process (mock
//   contract); §5.2's resume budget caps the slice at 50 (scenario C).
//
// Scenario B (fails cleanly with a refund): the crash tore the command log (a
// WAL gap) → verifyWALSinceCheckpoint refuses to replay → failed_clean +
// refund. The idempotent ledger means a redelivered attempt refunds nothing
// more; NO replacement engine is started for a broken log; the document is
// proven consistent at the pre-run revision by replaying the committed WAL on
// a fresh engine and inspecting it (the W9-L drill's rollback move, asserted).
//
// Scenario C (§5.2 hard cap): a 51-command slice is refused (fail-clean +
// refund, no engine); a FULL 50-command slice replays inside the same 35 s
// decision budget — "replay of ≤50 commands" at the cap, on a real engine.
//
// Skip-guard: same as the spine suites (apps/mock-engine entry must exist).

import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineClient } from "@studio/engine-client";
import { backoffDelayMsAfter } from "../../src/recovery/job-retry.js";
import type { ReplacementSession } from "../../src/recovery/run-recovery.js";
import { createInMemoryResumeGate, recoverRun } from "../../src/recovery/run-recovery.js";
import {
  type CommittedState,
  type ScriptedRunResult,
  type SpawnedEngineHandle,
  DECISION_BUDGET_MS,
  FakeClock,
  FakeRefundLedger,
  ProcessAttachExecutor,
  RecordingPool,
  RecordingRunManager,
  RecordingWalReader,
  RESUME_REPLAY_CAP,
  TIER_CREDITS,
  detectCrashUnderFakeClock,
  establishCheckpoint,
  executeScriptedRun,
  expectedFailCleanDecisionMs,
  expectedResumeDecisionMs,
  killNine,
  mutatingCallAgainstDeadEngine,
  replayableSlice,
  replayCommittedPreRunState,
  sortedLayerNames,
  spawnDrillEngine,
} from "./drill-harness.js";
import {
  cleanupSpineRoot,
  makeSpineRoot,
  mockEngineEntry,
  rawInspect,
  unwrapOutcome,
} from "../spine/harness.js";

const mockEntry = mockEngineEntry();

const ORG_ID = "org_w10d_drill";
const DOC_ID_A = "doc_drill_a";
const RUN_A = "run_drill_a";
const DOC_ID_B = "doc_drill_b";
const RUN_B = "run_drill_b";
const RUN_C_OVER = "run_drill_c_over";
const RUN_C_FULL = "run_drill_c_full";

/** The scripted long run: N commands, killed at step k (§20 #13 "killed mid-execution"). */
const SCRIPTED_RUN_COMMANDS = 50;
const KILL_AT = 25;

interface DrillContext {
  readonly root: string;
  engine1: SpawnedEngineHandle;
  committed: CommittedState | null;
  run: ScriptedRunResult | null;
  extras: SpawnedEngineHandle[];
  registry: Map<string, SpawnedEngineHandle>;
}

let ctx: DrillContext | undefined;

const drill = (): DrillContext => {
  if (ctx === undefined) {
    throw new Error("drill context not initialised (beforeAll failed)");
  }
  return ctx;
};

/** Spawns a REAL replacement engine (the pool's §3.4 restart) and registers it. */
const spawnReplacement = async (): Promise<ReplacementSession> => {
  const handle = await spawnDrillEngine(drill().root);
  drill().extras.push(handle);
  const sessionId = `replacement-${drill().registry.size + 1}`;
  drill().registry.set(sessionId, handle);
  return { sessionId, organizationId: ORG_ID };
};

const clientOfReplacement = (sessionId: string): EngineClient => {
  const handle = drill().registry.get(sessionId);
  if (handle === undefined) {
    throw new Error(`no spawned replacement engine for session ${sessionId}`);
  }
  return handle.client;
};

/** A pool spawn that must never run (torn log / over-budget slice → no engine). */
const refusingSpawn = async (): Promise<ReplacementSession> => {
  throw new Error("no replacement engine may be started for this outcome");
};

describe.skipIf(mockEntry === null)("§20 #13 drill — kill -9 mid-run, 60 s decision gate", () => {
  beforeAll(async () => {
    const root = makeSpineRoot();
    const engine1 = await spawnDrillEngine(root);
    ctx = {
      root,
      engine1,
      committed: null,
      run: null,
      extras: [],
      registry: new Map(),
    };
  }, 30_000);

  afterAll(async () => {
    await drill().engine1.client.close();
    await drill().engine1.mock.stop();
    for (const handle of drill().extras) {
      await handle.client.close();
      await handle.mock.stop();
    }
    cleanupSpineRoot(drill().root);
  }, 30_000);

  it(
    "checkpoints, runs 25 of 50 scripted commands, and is kill -9'd at step 25 (SIGKILL evidence)",
    async () => {
      const committed = await establishCheckpoint(drill().engine1.client, {
        savePath: "drill-60s/checkpoint-a.pcraft",
        name: "Drill 60s A",
        headline: "Fresh roasted, every morning",
      });
      // The checkpoint pins the committed pre-run state (§3.3 step 6).
      expect(committed.preRunLayers).toContain("Pre-run Base");
      expect(committed.preRunRevision).toBe(committed.docNewBaseRevision + 2);
      drill().committed = committed;

      const run = await executeScriptedRun(drill().engine1.client, {
        documentId: DOC_ID_A,
        baseRevision: committed.checkpointRevision,
        count: KILL_AT, // killed at step k — commands 26..50 never ran
        layerPrefix: "Drill A",
      });
      expect(run.rows).toHaveLength(KILL_AT);
      expect(run.revisionAfterLast).toBe(committed.checkpointRevision + KILL_AT);
      drill().run = run;

      // kill -9 (the §21 chaos move) and prove the death landed.
      const death = await killNine(drill().engine1.mock);
      expect(death.signal).toBe("SIGKILL");
      await mutatingCallAgainstDeadEngine(drill().engine1.client);
    },
    30_000,
  );

  it(
    "recovers within 60 s: fake-clock decision 35 s (50 s via the §3.4 queue route) → resumed with 25 commands replayed on a REAL replacement",
    async () => {
      const committed = drill().committed;
      const run = drill().run;
      if (committed === null || run === null) {
        throw new Error("scenario A prerequisites missing (previous test failed)");
      }

      const clock = new FakeClock();
      detectCrashUnderFakeClock(clock);
      const wal = new RecordingWalReader(run.rows, clock);
      const pool = new RecordingPool(clock, spawnReplacement);
      const attach = new ProcessAttachExecutor(clock, committed.savePath, clientOfReplacement);
      const gate = createInMemoryResumeGate();
      const runManager = new RecordingRunManager(clock);
      const refund = new FakeRefundLedger(clock, TIER_CREDITS);

      const realStart = Date.now();
      const outcome = await recoverRun(
        { runId: RUN_A, documentId: DOC_ID_A, organizationId: ORG_ID, crashCause: "pool" },
        {
          wal,
          checkpoint: { revision: committed.checkpointRevision },
          pool,
          attach,
          gate,
          budget: { maxReplayedCommands: RESUME_REPLAY_CAP },
          runManager,
          refund,
        },
      );
      const realMs = Date.now() - realStart;

      // §3.4 (c): resumed — the agent loop continues on the replacement session.
      expect(outcome.kind).toBe("resumed");
      if (outcome.kind !== "resumed") {
        return; // narrows for the assertions below
      }
      expect(outcome.reason).toBe("pool_crash_replayed");
      expect(outcome.fromRevision).toBe(committed.checkpointRevision);
      expect(outcome.toRevision).toBe(run.revisionAfterLast);
      expect(outcome.replayedCount).toBe(KILL_AT);
      expect(outcome.resumeAttempts).toBe(1); // §3.4 resume ONCE
      expect(outcome.replayedCount).toBeLessThanOrEqual(RESUME_REPLAY_CAP); // §5.2 hard cap

      // §20 #13: the CODE PATH latency under fake-clock acceleration.
      const expectedMs = expectedResumeDecisionMs();
      expect(clock.nowMs()).toBe(expectedMs);
      expect(expectedMs).toBeLessThanOrEqual(DECISION_BUDGET_MS);
      const queueRouteMs = expectedMs + backoffDelayMsAfter(1) + backoffDelayMsAfter(2);
      expect(queueRouteMs).toBeLessThanOrEqual(DECISION_BUDGET_MS);
      // Sanity bound: the real drill decision must also fit the gate (it ran
      // in milliseconds — the fake clock carries the production-budget claim).
      expect(realMs, `real decision latency ${realMs} ms`).toBeLessThan(DECISION_BUDGET_MS);

      // Exactly one restart, at the right adapter boundary (no ping-pong).
      expect(pool.calls).toHaveLength(1);
      expect(wal.calls).toEqual([
        { documentId: DOC_ID_A, fromRevision: committed.checkpointRevision },
      ]);

      // The REAL replay happened on the REAL replacement engine (§5.6 verbatim).
      const journal = attach.journal.at(-1);
      if (journal === undefined) {
        throw new Error("the attach executor never ran");
      }
      expect(journal.planKind).toBe("replay");
      expect(journal.fromRevision).toBe(committed.checkpointRevision);
      expect(journal.appliedCommands).toBe(KILL_AT);
      const replacement = clientOfReplacement(outcome.sessionId);
      const resumed = await rawInspect(replacement);
      expect(resumed.revision).toBe(journal.openBaselineRevision + KILL_AT);
      expect(sortedLayerNames(resumed)).toContain("Drill A 01");
      expect(sortedLayerNames(resumed)).toContain(`Drill A ${String(KILL_AT).padStart(2, "0")}`);

      // The run completes despite the crash: persist the resumed state (§3.3 step 6).
      const saved = unwrapOutcome(
        await replacement.saveDocument({ path: "drill-60s/resumed-a.pcraft" }),
      );
      expect(saved.path).toBe("drill-60s/resumed-a.pcraft");
      const onDisk = path.join(
        drill().root,
        ...["drill-60s", "resumed-a.pcraft"],
      );
      expect(existsSync(onDisk), "the resumed state must persist").toBe(true);

      // No refund for a resumed run (§3.3 step 7 refunds failures only).
      expect(refund.releases).toHaveLength(0);
    },
    30_000,
  );

  it(
    "fails cleanly with a refund when the crash tore the log: no engine, idempotent refund, document consistent at the pre-run revision",
    async () => {
      // A second, shorter run on its own engine — killed the same way.
      const engineB = await spawnDrillEngine(drill().root);
      drill().extras.push(engineB);
      const committedB = await establishCheckpoint(engineB.client, {
        savePath: "drill-60s/checkpoint-b.pcraft",
        name: "Drill 60s B",
        headline: "Torn log, clean refund",
      });
      const runB = await executeScriptedRun(engineB.client, {
        documentId: DOC_ID_B,
        baseRevision: committedB.checkpointRevision,
        count: 4,
        layerPrefix: "Torn B",
      });
      const death = await killNine(engineB.mock);
      expect(death.signal).toBe("SIGKILL");

      // The crash lost seq 3 — a torn command log must never be replayed (§5.6).
      const tornRows = runB.rows.filter((row) => row.seq !== 3);
      expect(tornRows.map((row) => row.seq)).toEqual([1, 2, 4]);

      const clock = new FakeClock();
      detectCrashUnderFakeClock(clock);
      const wal = new RecordingWalReader(tornRows, clock);
      const pool = new RecordingPool(clock, refusingSpawn);
      const attach = new ProcessAttachExecutor(clock, committedB.savePath, clientOfReplacement);
      const gate = createInMemoryResumeGate();
      const runManager = new RecordingRunManager(clock);
      const refund = new FakeRefundLedger(clock, TIER_CREDITS);
      const deps = {
        wal,
        checkpoint: { revision: committedB.checkpointRevision },
        pool,
        attach,
        gate,
        budget: { maxReplayedCommands: RESUME_REPLAY_CAP },
        runManager,
        refund,
      };
      const request = {
        runId: RUN_B,
        documentId: DOC_ID_B,
        organizationId: ORG_ID,
        crashCause: "pool" as const,
      };

      const outcome = await recoverRun(request, deps);
      expect(outcome.kind).toBe("failed_clean");
      if (outcome.kind !== "failed_clean") {
        return;
      }
      expect(outcome.reason).toBe("wal_gap_detected");
      expect(outcome.error.code).toBe("wal_gap_detected");
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.documentRevision).toBe(committedB.checkpointRevision);
      expect(outcome.resumeAttempts).toBe(0); // the gate was never consumed

      // §20 #13 fail-clean branch is ALSO inside the 60 s budget — and it is
      // far cheaper: no engine was ever started for a broken log.
      const expectedMs = expectedFailCleanDecisionMs();
      expect(clock.nowMs()).toBe(expectedMs);
      expect(expectedMs).toBeLessThanOrEqual(DECISION_BUDGET_MS);
      expect(expectedMs + backoffDelayMsAfter(1) + backoffDelayMsAfter(2)).toBeLessThanOrEqual(
        DECISION_BUDGET_MS,
      );
      expect(pool.calls).toHaveLength(0);
      expect(attach.journal).toHaveLength(0);

      // §3.3 step 7: refund the reservation — the ledger key is idempotent.
      expect(refund.releases).toHaveLength(1);
      expect(outcome.refund?.ok).toBe(true);
      expect(outcome.refund?.duplicate).toBe(false);

      // A redelivered attempt (§3.4 backoff ×3) fails clean again and refunds
      // NOTHING more — `${runId}:refund` never double-applies (§14.2).
      const redelivered = await recoverRun(request, deps);
      expect(redelivered.kind).toBe("failed_clean");
      expect(redelivered.refund?.duplicate).toBe(true);
      expect(refund.totalRefunded(RUN_B)).toBe(TIER_CREDITS);

      const failedClean = runManager.failedCleanCalls.at(-1);
      if (failedClean === undefined) {
        throw new Error("the run was never marked failed_clean");
      }
      expect(failedClean.documentRevision).toBe(committedB.checkpointRevision);
      expect(failedClean.error.code).toBe("wal_gap_detected");

      // Document consistent at the pre-run revision (assert via mock inspect):
      // replay ONLY the committed WAL on a fresh engine — the rollback move.
      const engineC = await spawnDrillEngine(drill().root);
      drill().extras.push(engineC);
      const rolled = await replayCommittedPreRunState(engineC.client, committedB);
      // The committed WAL reproduces the original advancement exactly.
      expect(rolled.revision - rolled.docNewBaseRevision).toBe(
        committedB.preRunRevision - committedB.docNewBaseRevision,
      );
      // Canary (spine pattern): absolute revision equality once the mock's
      // doc.new baseline is stable across processes.
      if (rolled.docNewBaseRevision === committedB.docNewBaseRevision) {
        expect(rolled.revision).toBe(committedB.preRunRevision);
      }
      expect([...rolled.layers]).toEqual([...committedB.preRunLayers]);
      expect([...rolled.texts]).toEqual([...committedB.preRunTexts]);
      // The killed run's uncommitted layers did not survive (§3.4 rollback).
      expect(rolled.layers.some((name) => name.startsWith("Torn B"))).toBe(false);
    },
    30_000,
  );

  it(
    "enforces the §5.2 resume cap: 51 replay commands are refused (no engine); a full 50 replay inside the same 35 s decision",
    async () => {
      const committedA = drill().committed;
      if (committedA === null) {
        throw new Error("scenario A prerequisites missing (first test failed)");
      }

      // 51 rows: one over the hard cap → terminal, refund, no engine.
      const overCap = replayableSlice(DOC_ID_A, 9, RESUME_REPLAY_CAP + 1, "Over Cap");
      const clockOver = new FakeClock();
      detectCrashUnderFakeClock(clockOver);
      const poolOver = new RecordingPool(clockOver, refusingSpawn);
      const attachOver = new FakeAttachExecutor(clockOver);
      const refundOver = new FakeRefundLedger(clockOver, TIER_CREDITS);
      const outcomeOver = await recoverRun(
        { runId: RUN_C_OVER, documentId: DOC_ID_A, organizationId: ORG_ID, crashCause: "pool" },
        {
          wal: new RecordingWalReader(overCap, clockOver),
          checkpoint: { revision: 9 },
          pool: poolOver,
          attach: attachOver,
          gate: createInMemoryResumeGate(),
          budget: { maxReplayedCommands: RESUME_REPLAY_CAP },
          runManager: new RecordingRunManager(clockOver),
          refund: refundOver,
        },
      );
      expect(outcomeOver.kind).toBe("failed_clean");
      if (outcomeOver.kind !== "failed_clean") {
        return;
      }
      expect(outcomeOver.reason).toBe("resume_budget_exceeded");
      expect(outcomeOver.error.retryable).toBe(false);
      expect(poolOver.calls).toHaveLength(0); // hard cap: no engine, no replay
      expect(attachOver.calls).toHaveLength(0);
      expect(refundOver.totalRefunded(RUN_C_OVER)).toBe(TIER_CREDITS);
      expect(clockOver.nowMs()).toBe(expectedFailCleanDecisionMs());

      // Exactly at the cap: a full 50-command slice resumes — ONE replay batch
      // inside the same 35 s decision, on a REAL replacement engine.
      const atCap = replayableSlice(DOC_ID_A, 7, RESUME_REPLAY_CAP, "Cap Fifty");
      const clockFull = new FakeClock();
      detectCrashUnderFakeClock(clockFull);
      const poolFull = new RecordingPool(clockFull, spawnReplacement);
      const attachFull = new ProcessAttachExecutor(
        clockFull,
        committedA.savePath,
        clientOfReplacement,
      );
      const refundFull = new FakeRefundLedger(clockFull, TIER_CREDITS);
      const outcomeFull = await recoverRun(
        { runId: RUN_C_FULL, documentId: DOC_ID_A, organizationId: ORG_ID, crashCause: "pool" },
        {
          wal: new RecordingWalReader(atCap, clockFull),
          checkpoint: { revision: 7 },
          pool: poolFull,
          attach: attachFull,
          gate: createInMemoryResumeGate(),
          budget: { maxReplayedCommands: RESUME_REPLAY_CAP },
          runManager: new RecordingRunManager(clockFull),
          refund: refundFull,
        },
      );
      expect(outcomeFull.kind).toBe("resumed");
      if (outcomeFull.kind !== "resumed") {
        return;
      }
      expect(outcomeFull.replayedCount).toBe(RESUME_REPLAY_CAP);
      expect(clockFull.nowMs()).toBe(expectedResumeDecisionMs()); // 35 000 ≤ 60 000
      expect(expectedResumeDecisionMs()).toBeLessThanOrEqual(DECISION_BUDGET_MS);

      const journal = attachFull.journal.at(-1);
      if (journal === undefined) {
        throw new Error("the full-cap replay never ran");
      }
      expect(journal.appliedCommands).toBe(RESUME_REPLAY_CAP);
      const replacement = clientOfReplacement(outcomeFull.sessionId);
      const resumed = await rawInspect(replacement);
      expect(resumed.revision).toBe(journal.openBaselineRevision + RESUME_REPLAY_CAP);
      const names = sortedLayerNames(resumed);
      expect(names).toContain("Cap Fifty 01");
      expect(names).toContain(`Cap Fifty ${String(RESUME_REPLAY_CAP).padStart(2, "0")}`);
      // The refused over-cap slice never touched any engine.
      expect(names.some((name) => name.startsWith("Over Cap"))).toBe(false);
    },
    30_000,
  );
});
