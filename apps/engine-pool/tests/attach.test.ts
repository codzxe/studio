// SessionAttach — §3.4 replay decision table, forced strategies, and the §3.2
// orchestration through fakes. No engine process, no store, no network.

import { describe, expect, it } from "vitest";

import {
  SessionAttach,
  decideAttachPlan,
  executeAttachPlan,
  replayableEntries,
  type AttachErrorCode,
  type AttachExecutor,
  type AttachOptions,
  type AttachPlan,
  type AttachStateProvider,
  type AttachStrategy,
  type BatchStep,
  type CapabilityStager,
  type CheckpointObjectReader,
  type CheckpointState,
  type EngineCall,
  type EngineClientLike,
  type WalCommandEntry,
} from "../src/attach.js";
import type { EngineSession } from "../src/types.js";

// ---------------------------------------------------------------------------
// Deterministic fakes (this suite's own; tests/fakes.js is owned by W1-J)
// ---------------------------------------------------------------------------

const session = (): EngineSession => ({
  sessionId: "s-1",
  organizationId: "org-1",
  documentId: "doc-1",
  token: "0".repeat(64),
  startedAt: 0,
  lastActivityAt: 0,
  state: "allocated",
});

const entry = (seq: number, overrides: Partial<WalCommandEntry> = {}): WalCommandEntry => ({
  seq,
  commandName: `command.${seq}`,
  params: { n: seq },
  revisionBefore: seq - 1,
  revisionAfter: seq,
  result: { ok: true },
  ...overrides,
});

const checkpoint = (revision: number, storageKey?: string): CheckpointState => ({
  revision,
  storageKey: storageKey ?? `cp/rev-${revision}.pcraft`,
  checkpointRef: { kind: "doc.save", path: `checkpoints/s-1/rev-${revision}.pcraft`, savedAt: 0 },
});

class FakeProvider implements AttachStateProvider {
  checkpoint: CheckpointState | null = null;
  entries: WalCommandEntry[] = [];
  fail = false;
  readonly calls: string[] = [];

  async latestCheckpoint(documentId: string, organizationId: string): Promise<CheckpointState | null> {
    this.calls.push(`cp:${documentId}:${organizationId}`);
    if (this.fail) throw new Error("fake: store down (postgres://secret@internal)");
    return this.checkpoint;
  }

  async commandsAfterRevision(
    documentId: string,
    organizationId: string,
    afterRevision: number,
  ): Promise<readonly WalCommandEntry[]> {
    this.calls.push(`wal:${documentId}:${afterRevision}`);
    if (this.fail) throw new Error("fake: store down (postgres://secret@internal)");
    return this.entries.filter((row) => row.revisionBefore >= afterRevision);
  }
}

type EngineBehavior = "ok" | "reject" | "throw";

class FakeEngine implements EngineClientLike {
  readonly calls: Array<{ method: string; path?: string; steps?: readonly BatchStep[] }> = [];
  createBehavior: EngineBehavior = "ok";
  openBehavior: EngineBehavior = "ok";
  batchBehavior: EngineBehavior = "ok";

  async createDocument(): Promise<EngineCall> {
    this.calls.push({ method: "doc.new" });
    return this.#act(this.createBehavior);
  }

  async openDocument(_session: EngineSession, path: string): Promise<EngineCall> {
    this.calls.push({ method: "doc.open", path });
    return this.#act(this.openBehavior);
  }

  async applyBatch(_session: EngineSession, steps: readonly BatchStep[]): Promise<EngineCall> {
    this.calls.push({ method: "batch", steps });
    return this.#act(this.batchBehavior);
  }

  #act(behavior: EngineBehavior): EngineCall {
    if (behavior === "reject") {
      return { ok: false, code: "engine_error", message: "rejected by fake", retryable: false };
    }
    if (behavior === "throw") {
      throw new Error("fake: engine socket closed (/var/run/secret.sock)");
    }
    return { ok: true };
  }
}

class MemoryObjects implements CheckpointObjectReader {
  readonly files = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  getBehavior: "ok" | "throw" = "ok";

  async get(key: string): Promise<Uint8Array | undefined> {
    this.reads.push(key);
    if (this.getBehavior === "throw") {
      throw new Error("fake: object store unreachable (arn:aws:s3:internal)");
    }
    return this.files.get(key);
  }
}

class FakeStager implements CapabilityStager {
  readonly staged: Array<{ sessionId: string; relativePath: string; bytes: number }> = [];
  fail = false;

  async stage(
    current: EngineSession,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<string> {
    if (this.fail) throw new Error("fake: capability root full (/ws/org-1/read)");
    this.staged.push({ sessionId: current.sessionId, relativePath, bytes: bytes.byteLength });
    return `/staged/${relativePath}`;
  }
}

interface Harness {
  readonly attach: SessionAttach;
  readonly provider: FakeProvider;
  readonly engine: FakeEngine;
  readonly storage: MemoryObjects;
  readonly stager: FakeStager;
}

const makeAttach = (): Harness => {
  const provider = new FakeProvider();
  const engine = new FakeEngine();
  const storage = new MemoryObjects();
  const stager = new FakeStager();
  const attach = new SessionAttach({ provider, engine, storage, stager });
  return { attach, provider, engine, storage, stager };
};

const deps = (h: Harness): AttachExecutor => ({
  provider: h.provider,
  engine: h.engine,
  storage: h.storage,
  stager: h.stager,
});

const storeCheckpoint = (h: Harness, cp: CheckpointState): void => {
  h.provider.checkpoint = cp;
  h.storage.files.set(cp.storageKey, new Uint8Array([1, 1, 2, 3, 5]));
};

// ---------------------------------------------------------------------------
// Pure decision table (§3.4: command log is the WAL; checkpoint is the replay base)
// ---------------------------------------------------------------------------

describe("decideAttachPlan (§3.4 decision table)", () => {
  it.each([
    {
      name: "new document: no checkpoint, empty WAL",
      checkpoint: null,
      entries: [] as WalCommandEntry[],
      plan: { kind: "fresh", fromRevision: 0, commandCount: 0 },
    },
    {
      name: "checkpoint @5, WAL fully covered",
      checkpoint: checkpoint(5),
      entries: [] as WalCommandEntry[],
      plan: { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
    },
    {
      name: "checkpoint @5, two committed commands after it",
      checkpoint: checkpoint(5),
      entries: [entry(6), entry(7)],
      plan: { kind: "replay", fromRevision: 5, commandCount: 2 },
    },
    {
      name: "no checkpoint, two committed commands (full replay)",
      checkpoint: null,
      entries: [entry(1), entry(2)],
      plan: { kind: "replay", fromRevision: 0, commandCount: 2 },
    },
    {
      name: "only failed commands → nothing committed → fresh",
      checkpoint: null,
      entries: [entry(1, { result: null })],
      plan: { kind: "fresh", fromRevision: 0, commandCount: 0 },
    },
    {
      name: "failed commands after the checkpoint are not replayed",
      checkpoint: checkpoint(5),
      entries: [entry(6, { result: null })],
      plan: { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
    },
    {
      name: "mixed committed/failed after the checkpoint",
      checkpoint: checkpoint(5),
      entries: [entry(6), entry(7, { result: null }), entry(8)],
      plan: { kind: "replay", fromRevision: 5, commandCount: 2 },
    },
  ])("$name", ({ checkpoint: cp, entries, plan }) => {
    expect(decideAttachPlan(cp, entries)).toEqual(plan);
  });

  it("replayableEntries filters failures and orders by seq (strict WAL order)", () => {
    const sorted = replayableEntries([
      entry(4),
      entry(2, { result: null }),
      entry(1),
      entry(3, { result: null }),
      entry(5),
    ]);
    expect(sorted.map((row) => row.seq)).toEqual([1, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// attachDocument — decision without execution
// ---------------------------------------------------------------------------

interface ForcedRow {
  readonly name: string;
  readonly strategy: AttachStrategy;
  readonly arrange: (h: Harness) => void;
  readonly code: AttachErrorCode;
}

const forcedRows: readonly ForcedRow[] = [
  {
    name: "fresh is forced on a document with history",
    strategy: "fresh",
    arrange: (h: Harness): void => {
      storeCheckpoint(h, checkpoint(5));
    },
    code: "strategy_unavailable",
  },
  {
    name: "checkpoint is forced with no checkpoint",
    strategy: "checkpoint",
    arrange: (h: Harness): void => {
      h.provider.entries = [entry(1)];
    },
    code: "strategy_unavailable",
  },
  {
    name: "replay is forced with nothing to replay",
    strategy: "replay",
    arrange: (h: Harness): void => {
      storeCheckpoint(h, checkpoint(5));
    },
    code: "strategy_unavailable",
  },
];

describe("SessionAttach.attachDocument", () => {
  it("auto-decides via the injected state provider (no engine calls)", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    h.provider.entries = [entry(6), entry(7)];
    const outcome = await h.attach.attachDocument(session(), "doc-1");
    expect(outcome).toEqual({
      ok: true,
      plan: { kind: "replay", fromRevision: 5, commandCount: 2 },
    });
    expect(h.provider.calls).toEqual(["cp:doc-1:org-1", "wal:doc-1:5"]);
    expect(h.engine.calls).toEqual([]);
  });

  it.each(forcedRows)("rejects when $name", async ({ strategy, arrange, code }) => {
    const h = makeAttach();
    arrange(h);
    const outcome = await h.attach.attachDocument(session(), "doc-1", { strategy });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe(code);
    expect(outcome.hint).toBeDefined();
    expect(outcome.retryable).toBe(false);
  });

  it("honors feasible forced strategies even when they differ from the auto plan", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    h.provider.entries = [entry(6)];
    // Auto would replay; the caller explicitly wants the checkpoint-only state.
    const forced = await h.attach.attachDocument(session(), "doc-1", { strategy: "checkpoint" });
    expect(forced).toEqual({
      ok: true,
      plan: { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
    });
    const auto = await h.attach.attachDocument(session(), "doc-1");
    expect(auto).toEqual({
      ok: true,
      plan: { kind: "replay", fromRevision: 5, commandCount: 1 },
    });
  });

  it("maps a provider failure to a typed envelope without leaking internals", async () => {
    const h = makeAttach();
    h.provider.fail = true;
    const outcome = await h.attach.attachDocument(session(), "doc-1");
    expect(outcome).toMatchObject({
      ok: false,
      code: "attach_state_unavailable",
      retryable: true,
    });
    expect(JSON.stringify(outcome)).not.toContain("postgres://");
  });

  it("rejects invalid requests before reading state", async () => {
    const h = makeAttach();
    const noDocumentId = await h.attach.attachDocument(session(), "");
    expect(noDocumentId).toMatchObject({ ok: false, code: "invalid_attach_request" });
    const bogusOptions: Record<string, unknown> = { strategy: "fresh", force: true };
    const unknownOption = await h.attach.attachDocument(
      session(),
      "doc-1",
      bogusOptions as AttachOptions,
    );
    expect(unknownOption).toMatchObject({ ok: false, code: "invalid_attach_request" });
    expect(h.provider.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executeAttachPlan — orchestration through the seams
// ---------------------------------------------------------------------------

describe("executeAttachPlan (§3.2 attach + §3.4 replay)", () => {
  it("kind fresh creates an empty document and applies nothing", async () => {
    const h = makeAttach();
    const result = await executeAttachPlan(session(), "doc-1", { kind: "fresh", fromRevision: 0, commandCount: 0 }, deps(h));
    expect(result).toEqual({ ok: true, kind: "fresh", fromRevision: 0, appliedCommands: 0 });
    expect(h.engine.calls).toEqual([{ method: "doc.new" }]);
  });

  it("kind checkpoint restores the .pcraft from object storage and opens it", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
      deps(h),
    );
    expect(result).toEqual({
      ok: true,
      kind: "checkpoint",
      fromRevision: 5,
      appliedCommands: 0,
      restoredFrom: "cp/rev-5.pcraft",
    });
    expect(h.storage.reads).toEqual(["cp/rev-5.pcraft"]);
    expect(h.stager.staged).toEqual([
      { sessionId: "s-1", relativePath: "restore/s-1/rev-5.pcraft", bytes: 5 },
    ]);
    expect(h.engine.calls).toEqual([
      { method: "doc.open", path: "/staged/restore/s-1/rev-5.pcraft" },
    ]);
  });

  it("fails with checkpoint_object_missing when the object is absent", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    h.storage.files.clear();
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
      deps(h),
    );
    expect(result).toMatchObject({ ok: false, code: "checkpoint_object_missing" });
    expect(h.engine.calls).toEqual([]);
  });

  it("still classifies a throwing object store as checkpoint_object_missing (retryable)", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    h.storage.getBehavior = "throw";
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
      deps(h),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "checkpoint_object_missing",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("arn:aws");
  });

  it("fails with strategy_unavailable when the checkpoint vanished before execution", async () => {
    const h = makeAttach();
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
      deps(h),
    );
    expect(result).toMatchObject({ ok: false, code: "strategy_unavailable", retryable: true });
  });

  it("maps a staging failure to engine_attach_failed", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    h.stager.fail = true;
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
      deps(h),
    );
    expect(result).toMatchObject({ ok: false, code: "engine_attach_failed" });
    expect(h.engine.calls).toEqual([]);
  });

  it("kind replay restores the checkpoint base, then applies the WAL slice as one batch", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    h.provider.entries = [
      entry(8),
      entry(6),
      entry(7, { result: null }), // failed command: audited, never replayed
    ];
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "replay", fromRevision: 5, commandCount: 2 },
      deps(h),
    );
    expect(result).toEqual({
      ok: true,
      kind: "replay",
      fromRevision: 5,
      appliedCommands: 2,
      restoredFrom: "cp/rev-5.pcraft",
    });
    const batch = h.engine.calls.at(-1);
    if (!batch || batch.method !== "batch") throw new Error("expected a batch call");
    expect(batch.steps).toEqual([
      { command: "command.6", params: { n: 6 } },
      { command: "command.8", params: { n: 8 } },
    ]);
    expect(h.engine.calls.map((call) => call.method)).toEqual(["doc.open", "batch"]);
  });

  it("kind replay with no checkpoint is a full replay: doc.new then the whole WAL", async () => {
    const h = makeAttach();
    h.provider.entries = [entry(1), entry(2, { result: null }), entry(3)];
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "replay", fromRevision: 0, commandCount: 2 },
      deps(h),
    );
    expect(result).toEqual({
      ok: true,
      kind: "replay",
      fromRevision: 0,
      appliedCommands: 2,
    });
    expect(h.engine.calls.map((call) => call.method)).toEqual(["doc.new", "batch"]);
  });

  it.each([
    { name: "engine rejects the batch", behavior: "reject" as EngineBehavior, retryable: false },
    { name: "engine throws on the batch", behavior: "throw" as EngineBehavior, retryable: true },
  ])("kind replay maps $name to engine_replay_failed", async ({ behavior, retryable }) => {
    const h = makeAttach();
    h.provider.entries = [entry(1)];
    h.engine.batchBehavior = behavior;
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "replay", fromRevision: 0, commandCount: 1 },
      deps(h),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "engine_replay_failed",
      retryable,
    });
    expect(JSON.stringify(result)).not.toContain("/var/run");
  });

  it("maps an engine createDocument throw to engine_attach_failed", async () => {
    const h = makeAttach();
    h.engine.createBehavior = "throw";
    const result = await executeAttachPlan(
      session(),
      "doc-1",
      { kind: "fresh", fromRevision: 0, commandCount: 0 },
      deps(h),
    );
    expect(result).toMatchObject({ ok: false, code: "engine_attach_failed", retryable: true });
  });

  it("validates the plan and document id (runtime callers can send anything)", async () => {
    const h = makeAttach();
    const bogusPlan = { kind: "bogus", fromRevision: 0, commandCount: 0 } as unknown as AttachPlan;
    const badPlan = await executeAttachPlan(session(), "doc-1", bogusPlan, deps(h));
    expect(badPlan).toMatchObject({ ok: false, code: "invalid_attach_request" });
    const badDocumentId = await executeAttachPlan(
      session(),
      "",
      { kind: "fresh", fromRevision: 0, commandCount: 0 },
      deps(h),
    );
    expect(badDocumentId).toMatchObject({ ok: false, code: "invalid_attach_request" });
    expect(h.engine.calls).toEqual([]);
  });

  it("the SessionAttach method wires its constructor seams", async () => {
    const h = makeAttach();
    storeCheckpoint(h, checkpoint(5));
    const result = await h.attach.executeAttachPlan(
      session(),
      "doc-1",
      { kind: "checkpoint", fromRevision: 5, commandCount: 0 },
    );
    expect(result).toMatchObject({ ok: true, restoredFrom: "cp/rev-5.pcraft" });
  });
});
