// W6-I — §5.6 transaction manager: begin → trackCommand → commit/rollback over fakes.
//
// The manager owns no infrastructure (DI seams), so every scenario runs against
// deterministic in-memory fakes: an engine implementing the documented agent.* wire
// contract (engine-patches/docs/commands.md), a command-log recorder, an object-storage
// recorder and a checkpoint recorder. Task-contract scenarios:
//   1. begin → commands → commit happy path (WAL rows revision-ordered + checkpoint),
//   2. rollback restores + marks the WAL (history kept, never deleted),
//   3. revision gap detection (wal_gap_detected),
//   4. double-commit error,
//   5. commit-after-rollback error,
//   6. cancel-during-run → rollback path (§3.4 "cancel, rollback, refund").
import { describe, expect, it } from "vitest";
import {
  TransactionManager,
  type CheckpointInput,
  type CheckpointLike,
  type EngineReply,
  type EngineTxLike,
  type StorageLike,
  type TrackedCommand,
  type TransactionFailure,
  type TransactionResult,
  type WalAppendInput,
  type WalAppendLike,
} from "../src/transactions/manager.js";

const RUN_ID = "run-1";
const OTHER_RUN_ID = "run-2";
const DOC_ID = "doc-1";
const DOC_REVISION = 6;

// --- fakes ------------------------------------------------------------------

/**
 * The documented §5.6 engine behavior. The revision only moves when the test says so:
 * `bumpRevision()` stands in for the executor running a real mutating command, so the
 * manager's WAL math is checked against exactly what an engine would echo (§6.1).
 */
class FakeEngine implements EngineTxLike {
  readonly commands: { command: string; params: Record<string, unknown> }[] = [];
  saves = 0;
  revision = DOC_REVISION;
  txnOpen = false;
  transactionId = 1;
  /** Revision applied by agent.commit (0 simulates a nil run, the engine close_nil_run). */
  commitBump = 1;
  /** Revision applied by agent.rollback (0 = nil run, nothing left to clear). */
  rollbackBump = 1;
  bytes = new Uint8Array([0x70, 0x63, 0x72, 0x61, 0x66, 0x74]);
  /** Refuse the next agent.commit/agent.rollback with transaction_busy (retryable). */
  busyOnce = false;
  /** Throw once instead of answering (untyped seam failure). */
  throwOnce = false;

  async bumpRevision(): Promise<void> {
    this.revision += 1;
  }

  async execute(
    command: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<EngineReply<Readonly<Record<string, unknown>>>> {
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error("engine seam exploded");
    }
    this.commands.push({ command, params: { ...params } });
    if (this.busyOnce && command !== "agent.begin") {
      this.busyOnce = false;
      return {
        ok: false,
        code: "transaction_busy",
        message: "transaction_busy: the history can't move while a command is still running",
      };
    }
    if (command === "agent.begin") {
      if (this.txnOpen) {
        return {
          ok: false,
          code: "transaction_already_open",
          message: "transaction_already_open: close it with agent.commit or agent.rollback first",
        };
      }
      this.txnOpen = true;
      return {
        ok: true,
        result: { transaction_id: this.transactionId, revision_before: this.revision },
      };
    }
    if (command === "agent.commit") {
      if (!this.txnOpen) {
        return {
          ok: false,
          code: "transaction_not_open",
          message: "transaction_not_open: no agent transaction is open; call agent.begin first",
        };
      }
      this.txnOpen = false;
      this.revision += this.commitBump;
      return {
        ok: true,
        result: {
          transaction_id: this.transactionId,
          revision_before: DOC_REVISION,
          revision_after: this.revision,
        },
      };
    }
    if (command === "agent.rollback") {
      if (!this.txnOpen) {
        return {
          ok: false,
          code: "transaction_not_open",
          message: "transaction_not_open: no agent transaction is open; call agent.begin first",
        };
      }
      this.txnOpen = false;
      this.revision += this.rollbackBump;
      return {
        ok: true,
        result: {
          transaction_id: this.transactionId,
          revision_before: DOC_REVISION,
          revision_after: this.revision,
          restored: true,
        },
      };
    }
    return { ok: false, code: "bad_command", message: `unknown command ${command}` };
  }

  async save(): Promise<EngineReply<{ bytes: Uint8Array }>> {
    this.saves += 1;
    return { ok: true, result: { bytes: this.bytes } };
  }
}

class FakeWal implements WalAppendLike {
  readonly rows: WalAppendInput[] = [];
  failNext = false;

  async append(input: WalAppendInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("command-log insert rejected");
    }
    this.rows.push({ ...input });
  }
}

class FakeStorage implements StorageLike {
  readonly puts: { key: string; bytes: Uint8Array }[] = [];
  failNext = false;

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("object storage put failed");
    }
    this.puts.push({ key, bytes });
  }
}

class FakeCheckpoint implements CheckpointLike {
  readonly saved: CheckpointInput[] = [];
  failNext = false;

  async save(input: CheckpointInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("checkpoint insert rejected");
    }
    this.saved.push({ ...input });
  }
}

interface Harness {
  manager: TransactionManager;
  engine: FakeEngine;
  wal: FakeWal;
  storage: FakeStorage;
  checkpoint: FakeCheckpoint;
}

function makeHarness(maxMutatingCommandsPerRun?: number): Harness {
  const engine = new FakeEngine();
  const wal = new FakeWal();
  const storage = new FakeStorage();
  const checkpoint = new FakeCheckpoint();
  const manager = new TransactionManager({
    engine,
    wal,
    storage,
    checkpoint,
    maxMutatingCommandsPerRun,
  });
  return { manager, engine, wal, storage, checkpoint };
}

// --- helpers ----------------------------------------------------------------

function unwrapOk<T>(result: TransactionResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(`expected ok, got ${result.code}: ${result.message}`);
}

function unwrapFailure<T>(result: TransactionResult<T>): TransactionFailure {
  if (!result.ok) {
    return result;
  }
  throw new Error("expected a typed failure, got ok");
}

/** The executor ran one mutating engine command; report it to the manager. */
async function runCommand(
  h: Harness,
  commandName: string,
  params: Record<string, unknown> = {},
): Promise<TransactionResult<ReturnType<TransactionManager["trackCommand"]> extends Promise<infer O> ? (O extends TransactionResult<infer V> ? V : never) : never>> {
  await h.engine.bumpRevision();
  const cmd: TrackedCommand = {
    runId: RUN_ID,
    commandName,
    params,
    revisionAfter: h.engine.revision,
  };
  return h.manager.trackCommand(cmd);
}

function lastRow(h: Harness): WalAppendInput {
  const row = h.wal.rows.at(-1);
  if (row === undefined) {
    throw new Error("the command log has no rows");
  }
  return row;
}

// --- scenarios --------------------------------------------------------------

describe("transactions: §5.6 begin → commands → commit (happy path)", () => {
  it("writes a begin marker, chained revision-ordered WAL rows and one durable checkpoint", async () => {
    const h = makeHarness();

    // begin before the first mutating command (§5.6) — engine checkpoint + marker row.
    const begun = unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    expect(begun).toEqual({ transactionId: 1, revisionBefore: DOC_REVISION, seq: 1 });
    expect(h.wal.rows.length).toBe(1);
    const marker = lastRow(h);
    expect(marker).toMatchObject({
      documentId: DOC_ID,
      seq: 1,
      commandName: "agent.begin",
      revisionBefore: DOC_REVISION,
      revisionAfter: DOC_REVISION,
    });
    expect(marker.params).toEqual({ name: "Restyle headline" });
    expect(marker.flag).toBeUndefined();

    // three mutating commands, each advancing the revision by exactly one (§5.6).
    const first = unwrapOk(await runCommand(h, "type.edit", { text: "Fresh roast" }));
    unwrapOk(await runCommand(h, "layer.fill.solidColor.set", { color: "#D96C3B" }));
    const third = unwrapOk(await runCommand(h, "edit.transform", { x: 8 }));
    expect(first).toEqual({ seq: 2, revisionBefore: 6, revisionAfter: 7 });
    expect(third).toEqual({ seq: 4, revisionBefore: 8, revisionAfter: 9 });

    // the WAL rows are revision-ordered and chained: a replay slice reproduces the run.
    expect(h.wal.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(h.wal.rows.map((row) => row.revisionBefore)).toEqual([6, 6, 7, 8]);
    expect(h.wal.rows.map((row) => row.revisionAfter)).toEqual([6, 7, 8, 9]);

    // commit folds the run into ONE undoable entry + §3.3 step 6 durable artifacts.
    const committed = unwrapOk(await h.manager.commit(RUN_ID));
    expect(committed).toEqual({
      transactionId: 1,
      revisionBefore: 6,
      revisionAfter: 10,
      commandCount: 3,
      storageKey: "documents/doc-1/revisions/10.pcraft",
      checkpoint: { seq: 4, revision: 10 },
    });

    // the user sees ONE undoable entry: exactly one begin + one commit reached the
    // engine; the run's commands were executed by the executor, never by the manager.
    expect(h.engine.commands.map((call) => call.command)).toEqual([
      "agent.begin",
      "agent.commit",
    ]);
    expect(h.engine.saves).toBe(1);

    const put = h.storage.puts.at(0);
    if (put === undefined) {
      throw new Error("the .pcraft was never written to object storage");
    }
    expect(put.key).toBe("documents/doc-1/revisions/10.pcraft");
    expect(put.bytes).toBe(h.engine.bytes);
    expect(h.checkpoint.saved).toEqual([
      {
        documentId: DOC_ID,
        runId: RUN_ID,
        seq: 4,
        revision: 10,
        storageKey: "documents/doc-1/revisions/10.pcraft",
        checkpointRef: { engineSnapshotId: 1 },
      },
    ]);
    expect(h.manager.status(RUN_ID)).toBe("committed");
    expect(h.manager.openRunForDocument(DOC_ID)).toBeNull();
  });

  it("keeps the document's log contiguous across runs on the same instance", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "First run"));
    unwrapOk(await runCommand(h, "type.edit"));
    unwrapOk(await h.manager.commit(RUN_ID));

    const second = unwrapOk(await h.manager.begin(OTHER_RUN_ID, DOC_ID, "Second run"));
    expect(second.seq).toBe(4); // seq 3 was the first run's command row
    expect(second.revisionBefore).toBe(8); // 6 + one command + the commit fold bump
    const tracked = unwrapOk(await runCommand(h, "layer.new.pixel"));
    expect(tracked.seq).toBe(5);
    expect(tracked.revisionBefore).toBe(8);
  });

  it("commits a nil run without command rows; the checkpoint covers the begin marker", async () => {
    const h = makeHarness();
    h.engine.commitBump = 0; // nothing changed: no revision bump (engine close_nil_run)
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Touch nothing"));
    const committed = unwrapOk(await h.manager.commit(RUN_ID));
    expect(committed.revisionAfter).toBe(DOC_REVISION);
    expect(committed.commandCount).toBe(0);
    expect(committed.checkpoint).toEqual({ seq: 1, revision: DOC_REVISION });
    expect(h.wal.rows.length).toBe(1); // the begin marker only
    expect(h.storage.puts.length).toBe(1);
  });
});

describe("transactions: §5.6 rollback restores and marks the WAL", () => {
  it("keeps every row and appends one rolled_back marker carrying the engine reply", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await runCommand(h, "type.edit", { text: "A" }));
    unwrapOk(await runCommand(h, "type.edit", { text: "B" }));

    const rolledBack = unwrapOk(await h.manager.rollback(RUN_ID));
    expect(rolledBack).toEqual({
      transactionId: 1,
      revisionBefore: 6,
      revisionAfter: 9,
      restored: true,
      commandCount: 2,
      markerSeq: 4,
    });

    // history is kept — never deleted (§5.6): marker + 2 commands + rollback marker.
    expect(h.wal.rows.map((row) => row.commandName)).toEqual([
      "agent.begin",
      "type.edit",
      "type.edit",
      "agent.rollback",
    ]);
    // the marker carries the reply verbatim: checkpoint revision → monotonic climb.
    const marker = lastRow(h);
    expect(marker).toMatchObject({
      seq: 4,
      commandName: "agent.rollback",
      flag: "rolled_back",
      revisionBefore: 6,
      revisionAfter: 9,
    });
    expect(marker.params).toEqual({});
    expect(h.engine.commands.map((call) => call.command)).toEqual([
      "agent.begin",
      "agent.rollback",
    ]);
    expect(h.manager.status(RUN_ID)).toBe("rolled_back");
    // the rollback path writes no durable commit artifacts (§3.3 step 7 instead).
    expect(h.engine.saves).toBe(0);
    expect(h.storage.puts.length).toBe(0);
    expect(h.checkpoint.saved.length).toBe(0);
  });

  it("errs transaction_not_open on commit after rollback", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await h.manager.rollback(RUN_ID));

    const failed = unwrapFailure(await h.manager.commit(RUN_ID));
    expect(failed.code).toBe("transaction_not_open");
    expect(failed.message).toContain("rolled_back");
    // nothing reached the engine and nothing durable was written twice.
    expect(h.engine.commands.map((call) => call.command)).toEqual([
      "agent.begin",
      "agent.rollback",
    ]);
    expect(h.storage.puts.length).toBe(0);
  });

  it("takes the rollback path on cancel mid-run (§3.4: cancel → rollback)", async () => {
    const h = makeHarness();
    h.engine.rollbackBump = 0; // nil run: the restore keeps the revision counter
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Quick edit"));

    const cancelled = unwrapOk(await h.manager.rollback(RUN_ID));
    expect(cancelled.restored).toBe(true);
    expect(cancelled.revisionAfter).toBe(DOC_REVISION);
    expect(cancelled.commandCount).toBe(0);
    expect(cancelled.markerSeq).toBe(2);

    const marker = lastRow(h);
    expect(marker).toMatchObject({
      seq: 2,
      commandName: "agent.rollback",
      flag: "rolled_back",
      revisionBefore: DOC_REVISION,
      revisionAfter: DOC_REVISION,
    });
    expect(h.wal.rows.length).toBe(2); // begin marker + rollback marker
  });

  it("errs transaction_not_open on double commit", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await runCommand(h, "layer.new.pixel"));
    unwrapOk(await h.manager.commit(RUN_ID));

    const failed = unwrapFailure(await h.manager.commit(RUN_ID));
    expect(failed.code).toBe("transaction_not_open");
    expect(failed.message).toContain("committed");
    // the second commit reached nothing: one begin, one commit, one save — total.
    expect(h.engine.commands.map((call) => call.command)).toEqual([
      "agent.begin",
      "agent.commit",
    ]);
    expect(h.engine.saves).toBe(1);
    expect(h.checkpoint.saved.length).toBe(1);
  });
});

describe("transactions: §5.6 revision math (monotonic enforcement)", () => {
  it("detects a revision gap: wal_gap_detected, no row appended, run stays open", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await runCommand(h, "type.edit")); // revision 7

    h.engine.revision = 9; // an untracked command mutated the document
    const gapped = unwrapFailure(
      await h.manager.trackCommand({
        runId: RUN_ID,
        commandName: "layer.new.pixel",
        params: {},
        revisionAfter: 9,
      }),
    );
    expect(gapped.code).toBe("wal_gap_detected");
    expect(gapped.message).toContain("8");
    expect(gapped.retryable).toBeFalsy();
    // the broken row is NOT appended — replay must never cross a gap.
    expect(h.wal.rows.length).toBe(2);
    expect(h.manager.status(RUN_ID)).toBe("open");
  });

  it("still rolls back after a detected gap: the marker keeps the reply verbatim", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await runCommand(h, "type.edit")); // revision 7, last tracked
    h.engine.revision = 9; // gap: untracked mutation

    const rolledBack = unwrapOk(await h.manager.rollback(RUN_ID));
    expect(rolledBack.restored).toBe(true);
    expect(rolledBack.revisionAfter).toBe(10); // restore bump past the gap revision
    const marker = lastRow(h);
    expect(marker).toMatchObject({
      commandName: "agent.rollback",
      flag: "rolled_back",
      revisionBefore: 6,
      revisionAfter: 10,
    });
    expect(h.manager.status(RUN_ID)).toBe("rolled_back");
  });

  it("errs wal_monotonicity_violation for a non-advancing or rewinding command", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));

    const stale = unwrapFailure(
      await h.manager.trackCommand({
        runId: RUN_ID,
        commandName: "layer.list",
        params: {},
        revisionAfter: DOC_REVISION, // queries never advance the revision — never logged
      }),
    );
    expect(stale.code).toBe("wal_monotonicity_violation");
    expect(stale.message).toContain("did not advance");

    unwrapOk(await runCommand(h, "type.edit")); // revision 7
    const rewind = unwrapFailure(
      await h.manager.trackCommand({
        runId: RUN_ID,
        commandName: "type.edit",
        params: {},
        revisionAfter: 6,
      }),
    );
    expect(rewind.code).toBe("wal_monotonicity_violation");
    expect(h.wal.rows.length).toBe(2); // marker + first command only
  });

  it("enforces the §5.7 mutating-command cap when one is configured", async () => {
    const h = makeHarness(1);
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Capped run"));
    unwrapOk(await runCommand(h, "type.edit")); // revision 7 — the cap

    const capped = unwrapFailure(
      await h.manager.trackCommand({
        runId: RUN_ID,
        commandName: "layer.new.pixel",
        params: {},
        revisionAfter: 8,
      }),
    );
    expect(capped.code).toBe("mutating_command_cap_exceeded");
    expect(capped.retryable).toBeFalsy();
  });
});

describe("transactions: §5.6 guards (begin before the first mutating command)", () => {
  it("refuses tracking before begin, a second begin, and a concurrent begin on the document", async () => {
    const h = makeHarness();

    const noTxn = unwrapFailure(
      await h.manager.trackCommand({
        runId: RUN_ID,
        commandName: "type.edit",
        params: {},
        revisionAfter: 7,
      }),
    );
    expect(noTxn.code).toBe("transaction_not_open");

    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    const second = unwrapFailure(
      await h.manager.begin(RUN_ID, DOC_ID, "Begin again"),
    );
    expect(second.code).toBe("transaction_already_open");

    // §1.5 rule 10: one transaction per document at a time.
    const concurrent = unwrapFailure(
      await h.manager.begin(OTHER_RUN_ID, DOC_ID, "Concurrent run"),
    );
    expect(concurrent.code).toBe("transaction_already_open");
    expect(h.manager.openRunForDocument(DOC_ID)).toBe(RUN_ID);
  });

  it("refuses a name over the engine's 256-character cap", async () => {
    const h = makeHarness();
    const failed = unwrapFailure(
      await h.manager.begin(RUN_ID, DOC_ID, "x".repeat(257)),
    );
    expect(failed.code).toBe("transaction_invalid_input");
    expect(h.engine.commands.length).toBe(0); // refused before reaching the engine
  });
});

describe("transactions: §3.3 step 6 durability failures", () => {
  it("errs wal_append_failed on a rejected append and keeps the seq reusable", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    h.wal.failNext = true;

    const failed = unwrapFailure(await runCommand(h, "type.edit"));
    expect(failed.code).toBe("wal_append_failed");
    expect(failed.retryable).toBe(true);
    expect(h.wal.rows.length).toBe(1); // only the begin marker

    // the row never landed, so the retry reuses the same seq (idempotent retry).
    const retried = unwrapOk(await runCommand(h, "type.edit"));
    expect(retried.seq).toBe(2);
  });

  it("treats a busy engine as retryable and keeps the transaction open", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await runCommand(h, "type.edit")); // revision 7

    h.engine.busyOnce = true;
    const busy = unwrapFailure(await h.manager.commit(RUN_ID));
    expect(busy.code).toBe("engine_command_failed");
    expect(busy.retryable).toBe(true);
    expect(h.manager.status(RUN_ID)).toBe("open");

    const committed = unwrapOk(await h.manager.commit(RUN_ID));
    expect(committed.revisionAfter).toBe(8);
    expect(h.manager.status(RUN_ID)).toBe("committed");
  });

  it("maps a seam throw to a typed engine_command_failed (values, not throws)", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    h.engine.throwOnce = true;

    const failed = unwrapFailure(await h.manager.rollback(RUN_ID));
    expect(failed.code).toBe("engine_command_failed");
    expect(failed.retryable).toBe(true);
    expect(h.manager.status(RUN_ID)).toBe("open"); // unknown engine state: stay open
  });

  it("errs checkpoint_write_failed after the engine committed (retry the writes, not commit)", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await runCommand(h, "type.edit"));
    h.storage.failNext = true;

    const failed = unwrapFailure(await h.manager.commit(RUN_ID));
    expect(failed.code).toBe("checkpoint_write_failed");
    expect(failed.retryable).toBe(true);
    expect(failed.message).toContain("object storage");
    // the engine transaction is closed — the run is committed, a re-commit is refused.
    expect(h.manager.status(RUN_ID)).toBe("committed");
    const again = unwrapFailure(await h.manager.commit(RUN_ID));
    expect(again.code).toBe("transaction_not_open");
    expect(h.engine.saves).toBe(1); // doc.save ran once; commit never re-sent
    expect(h.checkpoint.saved.length).toBe(0);
  });

  it("errs checkpoint_write_failed when only the checkpoint row fails (pcraft is durable)", async () => {
    const h = makeHarness();
    unwrapOk(await h.manager.begin(RUN_ID, DOC_ID, "Restyle headline"));
    unwrapOk(await runCommand(h, "type.edit"));
    h.checkpoint.failNext = true;

    const failed = unwrapFailure(await h.manager.commit(RUN_ID));
    expect(failed.code).toBe("checkpoint_write_failed");
    expect(h.storage.puts.length).toBe(1); // the .pcraft already durable
    expect(h.checkpoint.saved.length).toBe(0);
    expect(h.manager.status(RUN_ID)).toBe("committed");
  });
});

describe("transactions: §3.4 resume seam", () => {
  it("continues the WAL at the caller-supplied cursor and validates the engine revision", async () => {
    const h = makeHarness();
    h.engine.revision = 40; // replay restored the document to revision 40

    const begun = unwrapOk(
      await h.manager.begin(RUN_ID, DOC_ID, "Resumed run", { seq: 39, revision: 40 }),
    );
    expect(begun.seq).toBe(40);
    expect(h.wal.rows.map((row) => row.seq)).toEqual([40]);

    const tracked = unwrapOk(
      await h.manager.trackCommand({
        runId: RUN_ID,
        commandName: "type.edit",
        params: {},
        revisionAfter: 41,
      }),
    );
    expect(tracked).toEqual({ seq: 41, revisionBefore: 40, revisionAfter: 41 });
  });

  it("rejects a resume cursor that does not match the engine state (wal_slice_mismatch)", async () => {
    const h = makeHarness(); // engine at revision 6
    const failed = unwrapFailure(
      await h.manager.begin(RUN_ID, DOC_ID, "Resumed run", { seq: 9, revision: 5 }),
    );
    expect(failed.code).toBe("wal_slice_mismatch");
    expect(h.wal.rows.length).toBe(0); // nothing logged on a refused resume
    expect(h.engine.txnOpen).toBe(true); // engine-side txn exists; caller rolls back
  });
});
