// apps/worker/tests/recovery/replay-consistency.test.ts — WAL replay
// DETERMINISM at process level (W10-D), §5.6:
//
//   "the command log (`commands` table) IS the write-ahead log; replay applies
//    logged commands verbatim from the durable checkpoint."
//
// Three claims, three blocks:
//
//   1. DETERMINISM — the same verified slice replayed onto two fresh
//      replacement engines (mock doc.open + batch replay, the §3.4 resume
//      moves) yields IDENTICAL revision advancement and IDENTICAL layer trees.
//      This is the §20 #9 "hash-verified replay" idea pinned as an assertion:
//      same log in → same document out, across processes.
//   2. GAP DETECTION REFUSAL — a torn slice (seq gap: the crash lost rows) is
//      never replayed: verifyWALSinceCheckpoint refuses (table below), and at
//      the decision level recoverRun fails clean WITHOUT ever starting a
//      replacement engine — a broken log is terminal, not retryable guessing.
//   3. ROLLED_BACK EXCLUSION — a fixture WAL carrying §5.6 audit markers
//      (agent.begin / agent.rollback), a `rolled_back`-flagged row and a
//      failed (result-null) row replays ONLY the surviving data rows: the
//      aborted range and the failed command never touch an engine, and the
//      revision chain still verifies (markers vanish from the +1 chain — the
//      W6-I adapter algebra mirrored in run-recovery.ts).
//
// The pure tables run with no engine; the process block skips if the
// mock-engine entry is missing (spine skip-guard convention).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WAL_ROLLED_BACK_FLAG,
  createInMemoryResumeGate,
  filterReplayableRows,
  recoverRun,
  verifyWALSinceCheckpoint,
} from "../../src/recovery/run-recovery.js";
import type { WorkerWalEntry } from "../../src/recovery/run-recovery.js";
import {
  type SpawnedEngineHandle,
  FakeAttachExecutor,
  FakeClock,
  FakeRefundLedger,
  ProcessAttachExecutor,
  RecordingPool,
  RecordingRunManager,
  RecordingWalReader,
  TIER_CREDITS,
  chainedRows,
  establishCheckpoint,
  sortedLayerNames,
  sortedLayerTexts,
  spawnDrillEngine,
  toReplaySteps,
} from "./drill-harness.js";
import {
  cleanupSpineRoot,
  makeSpineRoot,
  mockEngineEntry,
  rawInspect,
  unwrapOutcome,
} from "../spine/harness.js";

const mockEntry = mockEngineEntry();

const DOC_ID = "doc_replay_consistency";
const ORG_ID = "org_w10d_replay";
const BASE = 5; // checkpoint revision for the pure fixture tables

const layerRow = (name: string) => ({ commandName: "layer.new.layer", params: { name } });

/** Re-stamps seqs on a fixture slice (gap/duplicate table construction). */
function withSeqs(rows: readonly WorkerWalEntry[], seqs: readonly number[]): WorkerWalEntry[] {
  return rows.map((row, index) => ({ ...row, seq: seqs[index] ?? row.seq }));
}

// ---------------------------------------------------------------------------
// Pure: gap detection + rolled_back exclusion (fixture WAL, no engine)
// ---------------------------------------------------------------------------

describe("§5.6 WAL verification — gap detection refusal (fixture table)", () => {
  it("accepts a dense, +1-chained slice", () => {
    const dense = chainedRows(DOC_ID, BASE, [layerRow("Dense 1"), layerRow("Dense 2"), layerRow("Dense 3")]);
    const verified = verifyWALSinceCheckpoint(dense, BASE);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.replayable).toHaveLength(3);
    }
  });

  it("accepts a full replay when there is no checkpoint yet (base 0)", () => {
    const full = chainedRows(DOC_ID, 0, [layerRow("Full 1"), layerRow("Full 2")]);
    expect(verifyWALSinceCheckpoint(full, null).ok).toBe(true);
  });

  it.each([
    {
      what: "torn middle — the crash lost seq 3",
      rows: withSeqs(
        chainedRows(DOC_ID, BASE, [layerRow("R1"), layerRow("R2"), layerRow("R3"), layerRow("R4")]),
        [1, 2, 4],
      ),
      expectedSeq: 3,
    },
    {
      what: "torn tail — the crash lost seq 4",
      rows: withSeqs(
        chainedRows(DOC_ID, BASE, [layerRow("R1"), layerRow("R2"), layerRow("R3"), layerRow("R4"), layerRow("R5")]),
        [1, 2, 3, 5],
      ),
      expectedSeq: 4,
    },
    {
      what: "duplicated row — seq runs 1, 2, 2",
      rows: withSeqs(
        chainedRows(DOC_ID, BASE, [layerRow("R1"), layerRow("R2"), layerRow("R2 again")]),
        [1, 2, 2],
      ),
      expectedSeq: 3,
    },
  ])("refuses to replay when $what", ({ rows, expectedSeq }) => {
    const verified = verifyWALSinceCheckpoint(rows, BASE);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("wal_gap_detected");
      // The message must say WHERE the log tore — never silently skip (§5.6).
      expect(verified.message).toContain(`expected seq ${expectedSeq}`);
    }
  });
});

describe("§5.6 WAL filtering — rolled_back / marker / failed rows are never replay content", () => {
  // The fixture story (§5.6 + W6-I manager contract): a committed layer, an
  // aborted agent transaction (begin → mutating row → rollback, flagged
  // rolled_back), a FAILED command (result IS NULL, no state change), then the
  // next committed layer. Marker rows carry their revisions verbatim and are
  // excluded BEFORE the +1 chain check, so the surviving data rows must chain
  // densely across the excluded range (the adapter's logical-chain algebra).
  const fixture = chainedRows(DOC_ID, BASE, [
    layerRow("Kept A"),
    { commandName: "agent.begin", params: {}, revisionBefore: BASE + 1, revisionAfter: BASE + 1 },
    {
      commandName: "layer.new.layer",
      params: { name: "Aborted Backdrop" },
      revisionBefore: BASE + 1,
      revisionAfter: BASE + 2,
      flag: WAL_ROLLED_BACK_FLAG,
    },
    {
      commandName: "agent.rollback",
      params: {},
      revisionBefore: BASE + 2,
      revisionAfter: BASE + 2,
      flag: WAL_ROLLED_BACK_FLAG,
    },
    {
      commandName: "layer.new.layer",
      params: { name: "Failed Ghost" },
      revisionBefore: BASE + 2,
      revisionAfter: BASE + 2,
      result: null,
    },
    {
      commandName: "layer.new.layer",
      params: { name: "Kept B" },
      revisionBefore: BASE + 1,
      revisionAfter: BASE + 2,
    },
  ]);

  it("pins the audit flag name the §5.6 markers carry", () => {
    expect(WAL_ROLLED_BACK_FLAG).toBe("rolled_back");
  });

  it("filters to the surviving data rows only, in seq order", () => {
    const replayable = filterReplayableRows(fixture);
    expect(replayable.map((row) => row.seq)).toEqual([1, 6]);
    expect(replayable.map((row) => row.params.name)).toEqual(["Kept A", "Kept B"]);
  });

  it("still verifies: the surviving rows chain +1 across the excluded range", () => {
    const verified = verifyWALSinceCheckpoint(fixture, BASE);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.replayable).toHaveLength(2);
      const first = verified.replayable[0];
      const last = verified.replayable.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error("the surviving slice is empty");
      }
      expect(first.revisionBefore).toBe(BASE);
      expect(last.revisionAfter).toBe(BASE + 2);
    }
  });
});

// ---------------------------------------------------------------------------
// Process: real mock doc.open + batch replay (skip-guarded)
// ---------------------------------------------------------------------------

interface ReplayContext {
  readonly root: string;
  readonly extras: SpawnedEngineHandle[];
  committed: { savePath: string; checkpointRevision: number } | null;
}

let ctx: ReplayContext | undefined;

const replayCtx = (): ReplayContext => {
  if (ctx === undefined) {
    throw new Error("replay context not initialised (beforeAll failed)");
  }
  return ctx;
};

async function spawnExtra(): Promise<SpawnedEngineHandle> {
  const handle = await spawnDrillEngine(replayCtx().root);
  replayCtx().extras.push(handle);
  return handle;
}

/** doc.open the checkpoint + return the synthesized baseline revision. */
async function openAtCheckpoint(handle: SpawnedEngineHandle, savePath: string): Promise<number> {
  const opened = unwrapOutcome(
    await handle.client.call("doc.open", { path: savePath }, { kind: "mutate" }),
  );
  expect(opened !== null && typeof opened === "object").toBe(true);
  return (await rawInspect(handle.client)).revision;
}

describe.skipIf(mockEntry === null)(
  "§5.6 replay determinism — real mock doc.open + batch replay",
  () => {
    beforeAll(async () => {
      const root = makeSpineRoot();
      ctx = { root, extras: [], committed: null };
      // The fixture SOURCE: a committed checkpoint whose revision the WAL
      // chains from (the ledger view is the worker's own).
      const source = await spawnExtra();
      const committed = await establishCheckpoint(source.client, {
        savePath: "replay-consistency/source.pcraft",
        name: "Replay Consistency",
        headline: "Consistency Anchor",
      });
      replayCtx().committed = {
        savePath: committed.savePath,
        checkpointRevision: committed.checkpointRevision,
      };
    }, 30_000);

    afterAll(async () => {
      for (const handle of replayCtx().extras) {
        await handle.client.close();
        await handle.mock.stop();
      }
      cleanupSpineRoot(replayCtx().root);
    }, 30_000);

    it(
      "the same slice replayed twice (two fresh replacement engines) → identical revisions and layer trees",
      async () => {
        const committed = replayCtx().committed;
        if (committed === null) {
          throw new Error("checkpoint source missing (beforeAll failed)");
        }
        const slice = chainedRows(DOC_ID, committed.checkpointRevision, [
          layerRow("Replay Backdrop"),
          { commandName: "type.create", params: { text: "First Replay Text", x: 100, y: 200, size: 24 } },
          layerRow("Replay Middle"),
          { commandName: "type.create", params: { text: "Second Replay Text", x: 300, y: 400, size: 32 } },
          layerRow("Replay Foreground"),
          { commandName: "edit.fill", params: { contents: "color", color: "#f5ede3" } },
        ]);
        expect(verifyWALSinceCheckpoint(slice, committed.checkpointRevision).ok).toBe(true);

        const replayOnce = async (): Promise<{
          base: number;
          revision: number;
          layers: string[];
          texts: string[];
        }> => {
          const handle = await spawnExtra();
          const base = await openAtCheckpoint(handle, committed.savePath);
          const batch = unwrapOutcome(
            await handle.client.runBatch({ steps: toReplaySteps(slice) }),
          );
          expect(batch.failed).toBe(0);
          expect(batch.completed).toBe(slice.length);
          const after = await rawInspect(handle.client);
          return {
            base,
            revision: after.revision,
            layers: sortedLayerNames(after),
            texts: sortedLayerTexts(after),
          };
        };

        const first = await replayOnce();
        const second = await replayOnce();

        // Identical advancement: exactly the slice, twice (§5.6 verbatim replay).
        expect(first.revision - first.base).toBe(slice.length);
        expect(second.revision - second.base).toBe(slice.length);
        // Identical layer trees — the §20 #9 hash-verified replay idea.
        expect(second.layers).toEqual(first.layers);
        expect(second.texts).toEqual(first.texts);
        expect(first.layers).toContain("Replay Foreground");
        expect(first.texts).toContain("Second Replay Text");
        // Canary (spine pattern): absolute revision determinism once the
        // synthesized doc.open baseline is stable across processes.
        if (first.base === second.base) {
          expect(second.revision).toBe(first.revision);
        }
      },
      30_000,
    );

    it(
      "refuses a torn slice at the decision level: fail-clean, no replacement engine, refund",
      async () => {
        const committed = replayCtx().committed;
        if (committed === null) {
          throw new Error("checkpoint source missing (beforeAll failed)");
        }
        const torn = withSeqs(
          chainedRows(DOC_ID, committed.checkpointRevision, [
            layerRow("T 1"),
            layerRow("T 2"),
            layerRow("T 3"),
            layerRow("T 4"),
          ]),
          [1, 2, 4], // the crash tore the log — seq 3 is gone
        );

        const clock = new FakeClock();
        const pool = new RecordingPool(clock, async () => {
          throw new Error("a torn log must never start a replacement engine");
        });
        const attach = new FakeAttachExecutor(clock);
        const refund = new FakeRefundLedger(clock, TIER_CREDITS);
        const outcome = await recoverRun(
          {
            runId: "run_replay_gap",
            documentId: DOC_ID,
            organizationId: ORG_ID,
            crashCause: "pool",
          },
          {
            wal: new RecordingWalReader(torn, clock),
            checkpoint: { revision: committed.checkpointRevision },
            pool,
            attach,
            gate: createInMemoryResumeGate(),
            budget: { maxReplayedCommands: 50 },
            runManager: new RecordingRunManager(clock),
            refund,
          },
        );
        expect(outcome.kind).toBe("failed_clean");
        if (outcome.kind !== "failed_clean") {
          return;
        }
        expect(outcome.reason).toBe("wal_gap_detected");
        expect(outcome.error.retryable).toBe(false);
        expect(pool.calls).toHaveLength(0); // no engine for a broken log
        expect(attach.calls).toHaveLength(0); // and no replay
        expect(refund.releases).toHaveLength(1); // §3.3 step 7 refund, once
      },
      30_000,
    );

    it(
      "replays a fixture WAL with rolled_back markers onto a real engine: the aborted range and the failed command never apply",
      async () => {
        const committed = replayCtx().committed;
        if (committed === null) {
          throw new Error("checkpoint source missing (beforeAll failed)");
        }
        const R = committed.checkpointRevision;
        // The §5.6 fixture rebuilt on the live checkpoint revision.
        const fixture = chainedRows(DOC_ID, R, [
          layerRow("Kept A"),
          { commandName: "agent.begin", params: {}, revisionBefore: R + 1, revisionAfter: R + 1 },
          {
            commandName: "layer.new.layer",
            params: { name: "Aborted Backdrop" },
            revisionBefore: R + 1,
            revisionAfter: R + 2,
            flag: WAL_ROLLED_BACK_FLAG,
          },
          {
            commandName: "agent.rollback",
            params: {},
            revisionBefore: R + 2,
            revisionAfter: R + 2,
            flag: WAL_ROLLED_BACK_FLAG,
          },
          {
            commandName: "layer.new.layer",
            params: { name: "Failed Ghost" },
            revisionBefore: R + 2,
            revisionAfter: R + 2,
            result: null,
          },
          {
            commandName: "layer.new.layer",
            params: { name: "Kept B" },
            revisionBefore: R + 1,
            revisionAfter: R + 2,
          },
        ]);

        const clock = new FakeClock();
        const registry = new Map<string, SpawnedEngineHandle>();
        const pool = new RecordingPool(clock, async () => {
          const handle = await spawnExtra();
          const sessionId = `rollback-replay-${registry.size + 1}`;
          registry.set(sessionId, handle);
          return { sessionId, organizationId: ORG_ID };
        });
        const attach = new ProcessAttachExecutor(clock, committed.savePath, (sessionId) => {
          const handle = registry.get(sessionId);
          if (handle === undefined) {
            throw new Error(`no replacement engine for session ${sessionId}`);
          }
          return handle.client;
        });
        const refund = new FakeRefundLedger(clock, TIER_CREDITS);
        const outcome = await recoverRun(
          {
            runId: "run_replay_rollback",
            documentId: DOC_ID,
            organizationId: ORG_ID,
            crashCause: "pool",
          },
          {
            wal: new RecordingWalReader(fixture, clock),
            checkpoint: { revision: R },
            pool,
            attach,
            gate: createInMemoryResumeGate(),
            budget: { maxReplayedCommands: 50 },
            runManager: new RecordingRunManager(clock),
            refund,
          },
        );
        expect(outcome.kind).toBe("resumed");
        if (outcome.kind !== "resumed") {
          return;
        }
        expect(outcome.replayedCount).toBe(2); // only the surviving data rows
        expect(outcome.toRevision).toBe(R + 2);

        const journal = attach.journal.at(-1);
        if (journal === undefined) {
          throw new Error("the rolled-back replay never ran");
        }
        expect(journal.appliedCommands).toBe(2);
        const handle = registry.get(outcome.sessionId);
        if (handle === undefined) {
          throw new Error("the replacement engine was never registered");
        }
        const after = await rawInspect(handle.client);
        expect(after.revision).toBe(journal.openBaselineRevision + 2);
        const names = sortedLayerNames(after);
        expect(names).toContain("Kept A");
        expect(names).toContain("Kept B");
        expect(names).not.toContain("Aborted Backdrop"); // rolled_back row excluded
        expect(names).not.toContain("Failed Ghost"); // failed row never replayed
      },
      30_000,
    );
  },
);
