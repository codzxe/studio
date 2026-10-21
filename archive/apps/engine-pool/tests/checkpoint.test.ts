// CheckpointManager — §3.3 finalization save, §3.2 idle-timeout flow, LocalCheckpointStorage.
// All seams are in-memory fakes: no engine process, no filesystem, no network.

import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_ACTOR,
  CheckpointManager,
  type CheckpointManagerOptions,
  type CheckpointRequest,
  type CheckpointStore,
  type CheckpointVersionRow,
  type DocSaveResult,
  type EngineDocumentIo,
  type FsLike,
  LocalCheckpointStorage,
  type StorageLike,
  checkpointVersionLabel,
  defaultCheckpointStorageKey,
  defaultSnapshotPath,
  splitStorageKey,
} from "../src/checkpoint.js";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../src/constants.js";
import type { EngineSession } from "../src/types.js";
import { ManualClock } from "./fakes.js";

// ---------------------------------------------------------------------------
// Deterministic fakes (this suite's own; tests/fakes.js is owned by W1-J)
// ---------------------------------------------------------------------------

const session = (overrides: Partial<EngineSession> = {}): EngineSession => ({
  sessionId: "s-1",
  organizationId: "org-1",
  documentId: "doc-1",
  token: "0".repeat(64),
  startedAt: 0,
  lastActivityAt: 0,
  state: "attached",
  ...overrides,
});

class FakeEngineIo implements EngineDocumentIo {
  readonly #ops: string[];
  readonly savedPaths: string[] = [];
  saveBehavior: "ok" | "fail" = "ok";
  readBehavior: "ok" | "fail" = "ok";
  snapshotBytes = new Uint8Array([9, 8, 7]);

  constructor(ops: string[] = []) {
    this.#ops = ops;
  }

  async saveDocument(current: EngineSession, path: string): Promise<DocSaveResult> {
    this.#ops.push(`save:${current.sessionId}:${path}`);
    this.savedPaths.push(path);
    if (this.saveBehavior === "fail") {
      throw new Error("fake: engine busy (internal path /opt/secret/engine)");
    }
    return { path, warnings: [] };
  }

  async readRootFile(current: EngineSession, path: string): Promise<Uint8Array> {
    this.#ops.push(`read:${path}`);
    if (this.readBehavior === "fail") {
      throw new Error("fake: readback failed (/ws/org-1/write)");
    }
    return this.snapshotBytes.slice();
  }
}

class MemoryStorage implements StorageLike {
  readonly #ops: string[];
  readonly files = new Map<string, Uint8Array>();
  putBehavior: "ok" | "fail" = "ok";

  constructor(ops: string[] = []) {
    this.#ops = ops;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    this.#ops.push(`put:${key}`);
    if (this.putBehavior === "fail") {
      throw new Error("fake: object store unavailable (arn:aws:s3:internal)");
    }
    this.files.set(key, data.slice());
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.files.get(key);
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

class FakeCheckpointStore implements CheckpointStore {
  readonly #ops: string[];
  readonly rows: CheckpointVersionRow[] = [];
  behavior: "ok" | "fail" = "ok";

  constructor(ops: string[] = []) {
    this.#ops = ops;
  }

  async appendVersion(row: CheckpointVersionRow): Promise<{ readonly id: string }> {
    this.#ops.push(`append:${row.documentId}:${row.revision}`);
    if (this.behavior === "fail") {
      throw new Error("fake: unique(document_id, revision) violation");
    }
    const id = `v${this.rows.length + 1}`;
    this.rows.push(row);
    return { id };
  }
}

interface Harness {
  readonly manager: CheckpointManager;
  readonly engine: FakeEngineIo;
  readonly storage: MemoryStorage;
  readonly store: FakeCheckpointStore;
  readonly clock: ManualClock;
  readonly ops: string[];
}

const makeManager = (overrides: Partial<CheckpointManagerOptions> = {}): Harness => {
  const ops: string[] = [];
  const engine = new FakeEngineIo(ops);
  const storage = new MemoryStorage(ops);
  const store = new FakeCheckpointStore(ops);
  const clock = new ManualClock(1_000_000);
  const manager = new CheckpointManager({
    engine,
    storage,
    store,
    clock: clock.now,
    ...overrides,
  });
  return { manager, engine, storage, store, clock, ops };
};

const request = (overrides: Partial<CheckpointRequest> = {}): CheckpointRequest => ({
  revision: 42,
  storageKey: "checkpoints/org-1/doc-1/rev-42.pcraft",
  engineSnapshotRef: { kind: "doc.save", path: "checkpoints/s-1/rev-42.pcraft", savedAt: 0 },
  ...overrides,
});

// ---------------------------------------------------------------------------
// saveCheckpoint — the §3.3 step 6 flow: doc.save → copy to storage → version row
// ---------------------------------------------------------------------------

describe("CheckpointManager.saveCheckpoint (§3.3 step 6)", () => {
  it("runs doc.save → read back → storage put → version append, in order", async () => {
    const h = makeManager();
    const outcome = await h.manager.saveCheckpoint(session(), request());
    expect(outcome).toEqual({
      ok: true,
      versionId: "v1",
      revision: 42,
      storageKey: "checkpoints/org-1/doc-1/rev-42.pcraft",
      snapshotPath: "checkpoints/s-1/rev-42.pcraft",
      bytesStored: 3,
    });
    expect(h.ops).toEqual([
      "save:s-1:checkpoints/s-1/rev-42.pcraft",
      "read:checkpoints/s-1/rev-42.pcraft",
      "put:checkpoints/org-1/doc-1/rev-42.pcraft",
      "append:doc-1:42",
    ]);
  });

  it("appends a §10.4 version row carrying the engine snapshot ref", async () => {
    const h = makeManager();
    const outcome = await h.manager.saveCheckpoint(session(), request());
    if (!outcome.ok) throw new Error("expected the checkpoint to succeed");
    const row = h.store.rows.at(0);
    if (!row) throw new Error("expected a version row");
    expect(row).toEqual({
      documentId: "doc-1",
      organizationId: "org-1",
      label: checkpointVersionLabel(42),
      revision: 42,
      checkpointRef: {
        kind: "doc.save",
        path: "checkpoints/s-1/rev-42.pcraft",
        savedAt: 0,
      },
      storageKey: "checkpoints/org-1/doc-1/rev-42.pcraft",
      createdBy: CHECKPOINT_ACTOR,
    });
    expect(h.storage.files.get("checkpoints/org-1/doc-1/rev-42.pcraft")).toEqual(
      new Uint8Array([9, 8, 7]),
    );
  });

  it("rejects an unattached session without touching any seam", async () => {
    const h = makeManager();
    const outcome = await h.manager.saveCheckpoint(session({ documentId: undefined }), request());
    expect(outcome).toEqual({
      ok: false,
      code: "session_not_attached",
      message: "Engine session is not attached to a document",
      hint: "Attach the session to a document before checkpointing (§3.2).",
      retryable: false,
    });
    expect(h.ops).toEqual([]);
  });

  it.each([
    {
      name: "engine doc.save failure",
      arrange: (h: Harness): void => {
        h.engine.saveBehavior = "fail";
      },
      code: "engine_save_failed",
    },
    {
      name: "snapshot readback failure",
      arrange: (h: Harness): void => {
        h.engine.readBehavior = "fail";
      },
      code: "snapshot_read_failed",
    },
    {
      name: "object-storage put failure",
      arrange: (h: Harness): void => {
        h.storage.putBehavior = "fail";
      },
      code: "storage_write_failed",
    },
    {
      name: "version-row append failure",
      arrange: (h: Harness): void => {
        h.store.behavior = "fail";
      },
      code: "checkpoint_store_failed",
    },
  ])("maps '$name' to a typed envelope and never throws", async ({ arrange, code }) => {
    const h = makeManager();
    arrange(h);
    const outcome = await h.manager.saveCheckpoint(session(), request());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe(code);
    expect(outcome.retryable).toBe(true);
    expect(outcome.hint).toBeDefined();
    // §4: envelopes never leak seam internals.
    expect(JSON.stringify(outcome)).not.toMatch(/\/opt\/|arn:aws|unique\(/);
  });

  // Rows are raw values on purpose — runtime callers can send anything (§5.7).
  it.each([
    { name: "negative revision", value: { ...request(), revision: -1 } },
    { name: "fractional revision", value: { ...request(), revision: 1.5 } },
    { name: "empty storage key", value: { ...request(), storageKey: "" } },
    {
      name: "absolute snapshot path",
      value: {
        ...request(),
        engineSnapshotRef: { kind: "doc.save", path: "/etc/passwd", savedAt: 0 },
      },
    },
    {
      name: "escaping snapshot path",
      value: {
        ...request(),
        engineSnapshotRef: { kind: "doc.save", path: "../rev-1.pcraft", savedAt: 0 },
      },
    },
    {
      name: "unknown snapshot kind",
      value: {
        ...request(),
        engineSnapshotRef: { kind: "doc.snapshot", path: "ok.pcraft", savedAt: 0 },
      },
    },
    { name: "unknown request field", value: { ...request(), extra: true } },
  ])("rejects $name before touching the engine", async ({ value }) => {
    const h = makeManager();
    const outcome = await h.manager.saveCheckpoint(session(), value as CheckpointRequest);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("invalid_checkpoint_request");
    expect(outcome.retryable).toBe(false);
    expect(h.ops).toEqual([]);
  });

  it("holds no shared state: concurrent saves both complete (never blocks)", async () => {
    const h = makeManager();
    const second = request({
      revision: 43,
      storageKey: "checkpoints/org-1/doc-1/rev-43.pcraft",
      engineSnapshotRef: { kind: "doc.save", path: "checkpoints/s-1/rev-43.pcraft", savedAt: 0 },
    });
    const outcomes = await Promise.all([
      h.manager.saveCheckpoint(session(), request()),
      h.manager.saveCheckpoint(session(), second),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
    expect(h.store.rows).toHaveLength(2);
    expect(h.storage.files.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isIdleDue — §3.4 per-session idle timeout (15 min default)
// ---------------------------------------------------------------------------

describe("CheckpointManager.isIdleDue (§3.4 idle timeout)", () => {
  it("is due at exactly the 15-minute timeout, and not a minute before", () => {
    const h = makeManager();
    const idleSession = session({ lastActivityAt: 0 });
    expect(h.manager.isIdleDue(idleSession, DEFAULT_IDLE_TIMEOUT_MS - 60_000)).toBe(false);
    expect(h.manager.isIdleDue(idleSession, DEFAULT_IDLE_TIMEOUT_MS)).toBe(true);
  });

  it("honors a custom timeout and the injected clock", () => {
    const h = makeManager({ idleTimeoutMs: 1_000 });
    expect(h.manager.isIdleDue(session({ lastActivityAt: h.clock.now() - 999 }))).toBe(false);
    h.clock.advance(1_000);
    expect(h.manager.isIdleDue(session({ lastActivityAt: 1_000_000 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveIdleCheckpoint — §3.2 idle → save checkpoint → recycle
// ---------------------------------------------------------------------------

describe("CheckpointManager.saveIdleCheckpoint (§3.2 idle-timeout flow)", () => {
  it("checkpoints an idle session with the default key/path policies", async () => {
    const h = makeManager();
    const idleSession = session({ lastActivityAt: 1_000_000 });
    h.clock.advance(DEFAULT_IDLE_TIMEOUT_MS);
    expect(h.manager.isIdleDue(idleSession)).toBe(true);

    const outcome = await h.manager.saveIdleCheckpoint(idleSession, { revision: 7 });
    expect(outcome).toMatchObject({ ok: true, revision: 7 });
    expect(h.engine.savedPaths).toEqual([defaultSnapshotPath("s-1", 7)]);
    expect([...h.storage.files.keys()]).toEqual([defaultCheckpointStorageKey("org-1", "doc-1", 7)]);
    const row = h.store.rows.at(0);
    if (!row) throw new Error("expected a version row");
    expect(row.revision).toBe(7);
    expect(row.checkpointRef).toEqual({
      kind: "doc.save",
      path: "checkpoints/s-1/rev-7.pcraft",
      savedAt: 1_000_000 + DEFAULT_IDLE_TIMEOUT_MS,
    });
    expect(h.ops).toEqual([
      "save:s-1:checkpoints/s-1/rev-7.pcraft",
      "read:checkpoints/s-1/rev-7.pcraft",
      `put:${defaultCheckpointStorageKey("org-1", "doc-1", 7)}`,
      "append:doc-1:7",
    ]);
  });

  it("prefers explicit overrides, then injected policies, over the defaults", async () => {
    const h = makeManager({
      storageKeyFor: ({ organizationId, revision }) =>
        `policy/${organizationId}/r${revision}.pcraft`,
      snapshotPathFor: (attached, revision) => `policy/${attached.sessionId}/r${revision}.pcraft`,
    });
    const explicit = await h.manager.saveIdleCheckpoint(session(), {
      revision: 1,
      storageKey: "explicit/key.pcraft",
      snapshotPath: "explicit/path.pcraft",
    });
    expect(explicit).toMatchObject({
      ok: true,
      storageKey: "explicit/key.pcraft",
      snapshotPath: "explicit/path.pcraft",
    });
    const viaPolicy = await h.manager.saveIdleCheckpoint(session(), { revision: 2 });
    expect(viaPolicy).toMatchObject({
      ok: true,
      storageKey: "policy/org-1/r2.pcraft",
      snapshotPath: "policy/s-1/r2.pcraft",
    });
  });

  it("returns an envelope for an unattached session (idle recycle still proceeds)", async () => {
    const h = makeManager();
    const outcome = await h.manager.saveIdleCheckpoint(session({ documentId: undefined }), {
      revision: 1,
    });
    expect(outcome).toMatchObject({ ok: false, code: "session_not_attached" });
    expect(h.ops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LocalCheckpointStorage — local-fs StorageLike (dev/single-box adapter)
// ---------------------------------------------------------------------------

const enoent = (): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error("not found");
  error.code = "ENOENT";
  return error;
};

class FakeFs implements FsLike {
  readonly dirs = new Set<string>();
  readonly files = new Map<string, Uint8Array>();

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data.slice());
  }

  async readFile(path: string): Promise<Uint8Array> {
    const found = this.files.get(path);
    if (!found) throw enoent();
    return found.slice();
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw enoent();
  }
}

describe("LocalCheckpointStorage", () => {
  it("round-trips a put/get/delete under the root, creating directories", async () => {
    const fs = new FakeFs();
    const storage = new LocalCheckpointStorage("/data", fs);
    const bytes = new Uint8Array([1, 2, 3]);
    await storage.put("checkpoints/org-1/doc-1/rev-1.pcraft", bytes);
    expect(fs.dirs).toContain("/data/checkpoints/org-1/doc-1");
    expect(await storage.get("checkpoints/org-1/doc-1/rev-1.pcraft")).toEqual(bytes);
    await storage.delete("checkpoints/org-1/doc-1/rev-1.pcraft");
    expect(await storage.get("checkpoints/org-1/doc-1/rev-1.pcraft")).toBeUndefined();
  });

  it("get of a missing key resolves undefined and delete is idempotent (S3 semantics)", async () => {
    const storage = new LocalCheckpointStorage("/data", new FakeFs());
    await expect(storage.get("missing.pcraft")).resolves.toBeUndefined();
    await expect(storage.delete("missing.pcraft")).resolves.toBeUndefined();
  });

  it.each([
    "../escape.pcraft",
    "/absolute.pcraft",
    "a//b.pcraft",
    "a/../b.pcraft",
    "a/./b.pcraft",
    "..",
    ".",
    "bad\0key",
    "",
  ])("rejects unsafe key %j on put, get and delete", async (key) => {
    const storage = new LocalCheckpointStorage("/data", new FakeFs());
    await expect(storage.put(key, new Uint8Array())).rejects.toThrow();
    await expect(storage.get(key)).rejects.toThrow();
    await expect(storage.delete(key)).rejects.toThrow();
  });

  it("splitStorageKey validates the same rules synchronously", () => {
    expect(splitStorageKey("checkpoints/org-1/doc-1/rev-1.pcraft")).toEqual([
      "checkpoints",
      "org-1",
      "doc-1",
      "rev-1.pcraft",
    ]);
    expect(() => splitStorageKey("a/../b")).toThrow();
    expect(() => splitStorageKey("/a")).toThrow();
  });

  it("treats a readFile ENOENT from the fs as an absent object, not a throw", async () => {
    const fs = new FakeFs();
    const storage = new LocalCheckpointStorage("/data", fs);
    fs.files.set("/data/x.pcraft", new Uint8Array([1]));
    expect(await storage.get("x.pcraft")).toEqual(new Uint8Array([1]));
    await expect(storage.delete("x.pcraft")).resolves.toBeUndefined();
    await expect(storage.delete("x.pcraft")).resolves.toBeUndefined();
  });
});
