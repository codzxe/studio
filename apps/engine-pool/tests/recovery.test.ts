// RecoveryCoordinator + WAL cursor — §3.4 crash recovery (resume ONCE / fail clean)
// and §5.6 replay (slices, contiguity, monotonic revisions). Fakes only: no engine
// process, no database, no timers.

import { describe, expect, it } from "vitest";

import {
  type AttachPlan,
  type EngineReplayOutcome,
  MAX_RESUME_ATTEMPTS_PER_RUN,
  type PoolLike,
  type ReallocationRequest,
  type RecoverDeps,
  RecoveryCoordinator,
  type RecoveryOutcome,
  type RecoverySession,
  type ReplayEngine,
  classifyCrash,
} from "../src/recovery.js";
import type { EngineSession } from "../src/types.js";
import {
  type WalCursor,
  type WalEntry,
  type WalProvider,
  type WalSlice,
  sliceCount,
  sliceForReplay,
  verifyContiguity,
  verifyMonotonicRevisions,
  verifyReplaySlice,
} from "../src/wal.js";

const DOC = "doc-1";
const ORG = "org-1";

/** Local guard: indexed fixture access must never hand `undefined` to assertions. */
function fail(): never {
  throw new Error("test fixture access failed");
}

/** Canonical mutating WAL under the §5.6 contract: seq i advances revision i-1 → i. */
const makeEntries = (documentId: string, fromSeq: number, toSeq: number): WalEntry[] => {
  const entries: WalEntry[] = [];
  for (let seq = fromSeq; seq <= toSeq; seq += 1) {
    entries.push({
      documentId,
      seq,
      commandName: `cmd_${seq}`,
      params: { n: seq },
      revisionBefore: seq - 1,
      revisionAfter: seq,
    });
  }
  return entries;
};

/** In-memory stand-in for the packages/db `commands` table reads. */
class FakeWalProvider implements WalProvider {
  entries: WalEntry[];
  failTotalSeq = false;
  failReadSlice = false;

  constructor(entries: readonly WalEntry[] = []) {
    this.entries = [...entries];
  }

  async totalSeq(documentId: string): Promise<number> {
    if (this.failTotalSeq) throw new Error("fake: db unavailable");
    return this.entries
      .filter((entry) => entry.documentId === documentId)
      .reduce((max, entry) => Math.max(max, entry.seq), 0);
  }

  async readSlice(slice: WalSlice): Promise<readonly WalEntry[]> {
    if (this.failReadSlice) throw new Error("fake: db unavailable");
    return this.entries
      .filter(
        (entry) =>
          entry.documentId === slice.documentId &&
          entry.seq >= slice.fromSeq &&
          entry.seq <= slice.toSeq,
      )
      .sort((a, b) => a.seq - b.seq);
  }
}

/** Pool seam: hands out one replacement session per reallocate call. */
class FakePool implements PoolLike {
  readonly calls: ReallocationRequest[] = [];
  fail = false;

  async reallocate(request: ReallocationRequest): Promise<EngineSession> {
    this.calls.push(request);
    if (this.fail) throw new Error("fake: no engine capacity");
    return {
      sessionId: `fresh-${request.runId}-${this.calls.length}`,
      organizationId: request.organizationId,
      documentId: request.documentId,
      // §3.2: fresh 256-bit token per process; never leaves the worker side.
      token: "f".repeat(64),
      startedAt: 0,
      lastActivityAt: 0,
      state: "attached",
    };
  }
}

/** Engine seam: records the checkpoint load and every replayed command. */
class FakeReplayEngine implements ReplayEngine {
  readonly loaded: Array<{ session: EngineSession; checkpoint: WalCursor }> = [];
  readonly applied: WalEntry[] = [];
  failLoad = false;
  failAtSeq: number | undefined;
  /** Skew added to the revision the engine claims after each applied command. */
  reportRevisionOffset = 0;

  async loadCheckpoint(
    session: EngineSession,
    checkpoint: WalCursor,
  ): Promise<EngineReplayOutcome> {
    this.loaded.push({ session, checkpoint });
    if (this.failLoad) {
      return { ok: false, code: "checkpoint_missing", message: "fake: snapshot missing" };
    }
    return { ok: true, revision: checkpoint.revision };
  }

  async applyCommand(session: EngineSession, entry: WalEntry): Promise<EngineReplayOutcome> {
    if (entry.seq === this.failAtSeq) {
      return { ok: false, code: "command_rejected", message: "fake: engine refused the command" };
    }
    this.applied.push(entry);
    return { ok: true, revision: entry.revisionAfter + this.reportRevisionOffset };
  }
}

interface Harness {
  readonly coordinator: RecoveryCoordinator;
  readonly pool: FakePool;
  readonly engine: FakeReplayEngine;
  readonly wal: FakeWalProvider;
}

interface DepsOverrides {
  readonly attachPlan?: AttachPlan;
  readonly maxReplayedCommands?: number;
}

const makeHarness = (totalSeq: number): Harness => {
  const wal = new FakeWalProvider(makeEntries(DOC, 1, totalSeq));
  const pool = new FakePool();
  const engine = new FakeReplayEngine();
  return { coordinator: new RecoveryCoordinator({ pool }), pool, engine, wal };
};

const makeDeps = (
  harness: Pick<Harness, "wal" | "engine">,
  overrides: DepsOverrides = {},
): RecoverDeps => ({
  walProvider: harness.wal,
  engine: harness.engine,
  attachPlan: overrides.attachPlan ?? "replay",
  budget: { maxReplayedCommands: overrides.maxReplayedCommands ?? 32 },
});

const crashedSession = (overrides: Partial<RecoverySession> = {}): RecoverySession => ({
  runId: "run-1",
  sessionId: "dead-1",
  organizationId: ORG,
  documentId: DOC,
  state: "crashed",
  checkpoint: { documentId: DOC, seq: 10, revision: 10 },
  ...overrides,
});

const asResumed = (outcome: RecoveryOutcome) => (outcome.kind === "resumed" ? outcome : undefined);
const asFailed = (outcome: RecoveryOutcome) =>
  outcome.kind === "failed_clean" ? outcome : undefined;

describe("WalCursor — slicing (pure, §5.6)", () => {
  it.each([
    { fromRevision: 10, totalSeq: 12, fromSeq: 11, toSeq: 12, count: 2 },
    { fromRevision: 0, totalSeq: 5, fromSeq: 1, toSeq: 5, count: 5 },
    { fromRevision: 12, totalSeq: 12, fromSeq: 13, toSeq: 12, count: 0 },
  ])(
    "sliceForReplay($fromRevision, $totalSeq) → seq $fromSeq..$toSeq ($count commands)",
    ({ fromRevision, totalSeq, fromSeq, toSeq, count }) => {
      const sliced = sliceForReplay(DOC, fromRevision, totalSeq);
      expect(sliced.ok).toBe(true);
      if (sliced.ok) {
        expect(sliced.slice).toEqual({ documentId: DOC, fromSeq, toSeq });
        expect(sliceCount(sliced.slice)).toBe(count);
      }
    },
  );

  it.each([
    { fromRevision: 13, totalSeq: 12, code: "wal_slice_mismatch" },
    { fromRevision: -1, totalSeq: 5, code: "wal_invalid_input" },
    { fromRevision: 1.5, totalSeq: 5, code: "wal_invalid_input" },
    { fromRevision: 0, totalSeq: -3, code: "wal_invalid_input" },
  ])("rejects ($fromRevision, $totalSeq) with $code", ({ fromRevision, totalSeq, code }) => {
    const sliced = sliceForReplay(DOC, fromRevision, totalSeq);
    expect(sliced.ok).toBe(false);
    if (!sliced.ok) {
      expect(sliced.code).toBe(code);
      expect(sliced.retryable).toBe(false);
    }
  });

  it("rejects an empty document id", () => {
    const sliced = sliceForReplay("", 0, 5);
    expect(sliced.ok).toBe(false);
    if (!sliced.ok) expect(sliced.code).toBe("wal_invalid_input");
  });
});

describe("WalCursor — verification (never silently skip, §5.6)", () => {
  it("verifyContiguity accepts contiguous runs and empty batches", () => {
    expect(verifyContiguity(makeEntries(DOC, 11, 13)).ok).toBe(true);
    expect(verifyContiguity([]).ok).toBe(true);
  });

  it("verifyContiguity flags gaps and repeated seqs", () => {
    const gap = verifyContiguity([...makeEntries(DOC, 11, 12), ...makeEntries(DOC, 14, 15)]);
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect(gap.code).toBe("wal_gap_detected");
      expect(gap.message).toContain("expected seq 13");
    }

    const first = makeEntries(DOC, 11, 12)[0] ?? fail();
    const repeated = verifyContiguity([first, first]);
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.code).toBe("wal_gap_detected");
  });

  it("verifyMonotonicRevisions accepts a chained slice and flags violations", () => {
    expect(verifyMonotonicRevisions(makeEntries(DOC, 11, 12)).ok).toBe(true);

    // Chain break: the second command rewinds behind the first command's revision.
    const chained = makeEntries(DOC, 11, 12);
    const rewound: WalEntry = { ...(chained[1] ?? fail()), revisionBefore: 10, revisionAfter: 11 };
    const chainBroken = verifyMonotonicRevisions([chained[0] ?? fail(), rewound]);
    expect(chainBroken.ok).toBe(false);
    if (!chainBroken.ok) expect(chainBroken.code).toBe("wal_monotonicity_violation");

    // No advance: a "mutating" command that leaves the revision untouched.
    const stalled: WalEntry = {
      documentId: DOC,
      seq: 12,
      commandName: "c",
      params: {},
      revisionBefore: 11,
      revisionAfter: 11,
    };
    const noAdvance = verifyMonotonicRevisions([...makeEntries(DOC, 11, 11), stalled]);
    expect(noAdvance.ok).toBe(false);
    if (!noAdvance.ok) expect(noAdvance.code).toBe("wal_monotonicity_violation");
  });

  it("verifyReplaySlice verifies bounds, completeness and checkpoint coherence", () => {
    const slice: WalSlice = { documentId: DOC, fromSeq: 11, toSeq: 12 };
    const ok = verifyReplaySlice({
      slice,
      entries: makeEntries(DOC, 11, 12),
      checkpointRevision: 10,
    });
    expect(ok.ok).toBe(true);

    const cases: ReadonlyArray<{
      name: string;
      entries: readonly WalEntry[];
      checkpointRevision: number;
      code: string;
    }> = [
      {
        name: "head gap: first expected seq missing",
        entries: makeEntries(DOC, 12, 12),
        checkpointRevision: 10,
        code: "wal_gap_detected",
      },
      {
        name: "tail gap: last expected seq missing",
        entries: makeEntries(DOC, 11, 11),
        checkpointRevision: 10,
        code: "wal_gap_detected",
      },
      {
        name: "empty batch for a non-empty slice",
        entries: [],
        checkpointRevision: 10,
        code: "wal_gap_detected",
      },
      {
        name: "entries before the slice start",
        entries: makeEntries(DOC, 10, 12),
        checkpointRevision: 10,
        code: "wal_slice_mismatch",
      },
      {
        name: "entries past the slice end",
        entries: makeEntries(DOC, 11, 13),
        checkpointRevision: 10,
        code: "wal_slice_mismatch",
      },
      {
        name: "checkpoint does not precede the slice",
        entries: makeEntries(DOC, 11, 12),
        checkpointRevision: 9,
        code: "wal_slice_mismatch",
      },
      {
        name: "entry from another document",
        entries: makeEntries("doc-other", 11, 12),
        checkpointRevision: 10,
        code: "wal_slice_mismatch",
      },
      {
        name: "revision chain violation inside the slice",
        entries: [
          ...makeEntries(DOC, 11, 11),
          {
            documentId: DOC,
            seq: 12,
            commandName: "c",
            params: {},
            revisionBefore: 5,
            revisionAfter: 6,
          },
        ],
        checkpointRevision: 10,
        code: "wal_monotonicity_violation",
      },
    ];
    for (const { name, entries, checkpointRevision, code } of cases) {
      const result = verifyReplaySlice({ slice, entries, checkpointRevision });
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(result.code, name).toBe(code);
        expect(result.retryable, name).toBe(false);
      }
    }
  });
});

describe("RecoveryCoordinator — §3.4 resume once / fail clean", () => {
  it("allows exactly one engine resume per run (§3.4)", () => {
    expect(MAX_RESUME_ATTEMPTS_PER_RUN).toBe(1);
  });

  it("replays the WAL after the checkpoint and resumes ONCE (crash at 12, checkpoint at 10)", async () => {
    const h = makeHarness(12);
    const outcome = await h.coordinator.recover(crashedSession(), makeDeps(h));

    const resumed = asResumed(outcome);
    expect(resumed).toBeDefined();
    if (!resumed) return;
    expect(resumed.reason).toBe("pool_crash_replayed");
    expect(resumed.crashCause).toBe("pool");
    expect(resumed.fromSeq).toBe(11);
    expect(resumed.toSeq).toBe(12);
    expect(resumed.replayedCount).toBe(2);
    expect(resumed.revision).toBe(12);
    expect(resumed.resumeAttempts).toBe(1);
    expect(h.engine.applied.map((entry) => entry.seq)).toEqual([11, 12]);
    expect(h.engine.loaded).toHaveLength(1);
    expect(h.engine.loaded.at(0)?.checkpoint.revision).toBe(10);
    expect(h.pool.calls).toEqual([{ organizationId: ORG, documentId: DOC, runId: "run-1" }]);
    // §15.1: the fresh session's token never leaves the worker side.
    expect(Object.keys(resumed)).not.toContain("token");
  });

  it("a second crash fails clean — no second resume, no reallocate, no replay", async () => {
    const h = makeHarness(12);
    const deps = makeDeps(h);
    expect(asResumed(await h.coordinator.recover(crashedSession(), deps))).toBeDefined();

    // The engine crashed again mid-run; the durable checkpoint is still revision 10.
    const second = await h.coordinator.recover(crashedSession(), deps);
    const failed = asFailed(second);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("resume_already_attempted");
    expect(failed.error.code).toBe("engine_session_lost");
    expect(failed.error.retryable).toBe(false);
    expect(failed.error.hint).toMatch(/[Rr]efund/);
    expect(failed.documentRevision).toBe(10);
    expect(failed.resumeAttempts).toBe(1);
    // Ping-pong prevention: nothing was re-allocated or re-applied (§3.4).
    expect(h.pool.calls).toHaveLength(1);
    expect(h.engine.applied).toHaveLength(2);
  });

  it("a WAL gap fails clean without spawning a replacement session", async () => {
    const h = makeHarness(12);
    // The row for seq 11 vanished — the log has a hole inside the replay slice.
    h.wal.entries = h.wal.entries.filter((entry) => entry.seq !== 11);

    const outcome = await h.coordinator.recover(crashedSession(), makeDeps(h));
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("wal_gap_detected");
    expect(failed.error.code).toBe("wal_gap_detected");
    expect(failed.documentRevision).toBe(10);
    expect(failed.resumeAttempts).toBe(0);
    expect(h.pool.calls).toHaveLength(0);
    expect(h.engine.applied).toHaveLength(0);
  });

  it("a revision-monotonicity violation fails clean without spawning", async () => {
    const h = makeHarness(12);
    h.wal.entries = h.wal.entries.map((entry) =>
      entry.seq === 12 ? { ...entry, revisionBefore: 5, revisionAfter: 6 } : entry,
    );

    const outcome = await h.coordinator.recover(crashedSession(), makeDeps(h));
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("wal_monotonicity_violation");
    expect(failed.error.code).toBe("wal_monotonicity_violation");
    expect(h.pool.calls).toHaveLength(0);
  });

  it("a checkpoint ahead of the log fails clean (slice unavailable)", async () => {
    const h = makeHarness(12);
    const outcome = await h.coordinator.recover(
      crashedSession({ checkpoint: { documentId: DOC, seq: 13, revision: 13 } }),
      makeDeps(h),
    );
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("wal_slice_unavailable");
    expect(failed.error.code).toBe("wal_slice_mismatch");
    expect(h.pool.calls).toHaveLength(0);
  });

  it("replaying past the resume budget fails clean (§5.2 hard caps)", async () => {
    const h = makeHarness(12);
    const outcome = await h.coordinator.recover(
      crashedSession(),
      makeDeps(h, { maxReplayedCommands: 1 }),
    );
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("resume_budget_exceeded");
    expect(failed.error.code).toBe("resume_budget_exceeded");
    expect(failed.resumeAttempts).toBe(0);
    expect(h.pool.calls).toHaveLength(0);
  });

  it("attachPlan 'checkpoint' refuses pending commands but resumes a clean head", async () => {
    const h = makeHarness(12);
    const refused = await h.coordinator.recover(
      crashedSession(),
      makeDeps(h, { attachPlan: "checkpoint" }),
    );
    const refusedFailed = asFailed(refused);
    expect(refusedFailed).toBeDefined();
    if (!refusedFailed) return;
    expect(refusedFailed.reason).toBe("invalid_attach_plan");
    expect(h.pool.calls).toHaveLength(0);

    // Nothing pending: the checkpoint sits at the head of the log — no replay needed.
    const atHead = await h.coordinator.recover(
      crashedSession({ checkpoint: { documentId: DOC, seq: 12, revision: 12 } }),
      makeDeps(h, { attachPlan: "checkpoint" }),
    );
    const resumed = asResumed(atHead);
    expect(resumed).toBeDefined();
    if (!resumed) return;
    expect(resumed.replayedCount).toBe(0);
    expect(resumed.revision).toBe(12);
    expect(h.engine.applied).toHaveLength(0);
    expect(h.engine.loaded).toHaveLength(1);
  });

  it("a failed reallocate is queue-retryable and does NOT consume the resume", async () => {
    const h = makeHarness(12);
    h.pool.fail = true;
    const first = await h.coordinator.recover(crashedSession(), makeDeps(h));
    const failed = asFailed(first);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("reallocate_failed");
    expect(failed.error.retryable).toBe(true);
    expect(failed.resumeAttempts).toBe(0);

    // The queue retried (backoff ×3) and capacity came back — the resume is still available.
    h.pool.fail = false;
    const second = await h.coordinator.recover(crashedSession(), makeDeps(h));
    expect(asResumed(second)).toBeDefined();
    expect(h.coordinator.resumeAttempts("run-1")).toBe(1);
  });

  it("WAL provider failures are queue-retryable and do not consume the resume", async () => {
    const h = makeHarness(12);
    h.wal.failTotalSeq = true;
    const first = asFailed(await h.coordinator.recover(crashedSession(), makeDeps(h)));
    expect(first?.reason).toBe("wal_provider_failed");
    expect(first?.error.retryable).toBe(true);

    h.wal.failTotalSeq = false;
    h.wal.failReadSlice = true;
    const second = asFailed(await h.coordinator.recover(crashedSession(), makeDeps(h)));
    expect(second?.reason).toBe("wal_provider_failed");

    h.wal.failReadSlice = false;
    const third = await h.coordinator.recover(crashedSession(), makeDeps(h));
    expect(asResumed(third)).toBeDefined();
    expect(h.coordinator.resumeAttempts("run-1")).toBe(1);
  });

  it("a rejected replay command fails clean and SPENDS the resume", async () => {
    const h = makeHarness(12);
    h.engine.failAtSeq = 12;
    const first = await h.coordinator.recover(crashedSession(), makeDeps(h));
    const failed = asFailed(first);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("replay_command_failed");
    expect(failed.error.code).toBe("engine_session_lost");
    expect(failed.error.hint).toMatch(/[Rr]efund/);
    expect(failed.resumeAttempts).toBe(1);
    expect(failed.documentRevision).toBe(10);
    expect(h.engine.applied.map((entry) => entry.seq)).toEqual([11]);

    // Even with the engine fixed, the gate holds: resume ONCE (§3.4).
    h.engine.failAtSeq = undefined;
    const second = await h.coordinator.recover(crashedSession(), makeDeps(h));
    const gateFailed = asFailed(second);
    expect(gateFailed?.reason).toBe("resume_already_attempted");
    expect(h.engine.applied).toHaveLength(1);
  });

  it("a failed checkpoint load fails clean", async () => {
    const h = makeHarness(12);
    h.engine.failLoad = true;
    const outcome = await h.coordinator.recover(crashedSession(), makeDeps(h));
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("checkpoint_load_failed");
    expect(failed.resumeAttempts).toBe(1);
  });

  it("an engine revision that disagrees with the log fails clean", async () => {
    const h = makeHarness(12);
    h.engine.reportRevisionOffset = 5;
    const outcome = await h.coordinator.recover(crashedSession(), makeDeps(h));
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("replay_revision_mismatch");
    expect(failed.resumeAttempts).toBe(1);
  });

  it("only crashed sessions enter recovery", async () => {
    const h = makeHarness(12);
    const outcome = await h.coordinator.recover(crashedSession({ state: "idle" }), makeDeps(h));
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("session_not_crashed");
    expect(h.pool.calls).toHaveLength(0);
  });

  it("a checkpoint from another document fails clean", async () => {
    const h = makeHarness(12);
    const outcome = await h.coordinator.recover(
      crashedSession({ checkpoint: { documentId: "doc-other", seq: 10, revision: 10 } }),
      makeDeps(h),
    );
    const failed = asFailed(outcome);
    expect(failed).toBeDefined();
    if (!failed) return;
    expect(failed.reason).toBe("wal_invalid_input");
    expect(h.pool.calls).toHaveLength(0);
  });

  it("classifies watchdog, pool and manual crash causes (§3.4 step a)", async () => {
    expect(classifyCrash(crashedSession())).toBe("pool");
    const watchdog = crashedSession({ crash: { source: "watchdog", detail: "memory breach" } });
    expect(classifyCrash(watchdog)).toBe("watchdog");
    const manual = crashedSession({ crash: { source: "manual", detail: "operator drain" } });
    expect(classifyCrash(manual)).toBe("manual");

    const h = makeHarness(12);
    const resumedWatchdog = asResumed(await h.coordinator.recover(watchdog, makeDeps(h)));
    expect(resumedWatchdog?.reason).toBe("watchdog_crash_replayed");
    expect(resumedWatchdog?.crashCause).toBe("watchdog");

    // A manual stop with nothing pending fails nothing — it resumes too (§3.4 restart).
    const manualAtHead = crashedSession({
      runId: "run-2",
      checkpoint: { documentId: DOC, seq: 12, revision: 12 },
      crash: { source: "manual", detail: "operator drain" },
    });
    const resumedManual = asResumed(await h.coordinator.recover(manualAtHead, makeDeps(h)));
    expect(resumedManual?.reason).toBe("manual_stop_replayed");
  });
});
