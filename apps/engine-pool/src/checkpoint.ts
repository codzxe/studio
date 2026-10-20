// @studio/engine-pool — CheckpointManager: the "save checkpoint" leg of the session
// lifecycle (§3.2: allocate → attach → run → idle timeout → save checkpoint → recycle)
// and the §3.3 finalization step 6 (engine snapshot → .pcraft to object storage →
// checkpoint row in DB). The Postgres command log is the WAL (§3.4/§5.6): a checkpoint
// is only a REPLAY BASE — recovery re-applies every committed command after its
// revision, so `revision` below must be the document's committed revision counter
// (documents.current_revision, content schema).
//
// Every dependency is an injectable structural seam (no imports from sibling packages):
//   • StorageLike      — object storage for .pcraft bytes. A local-fs impl is included
//                        for dev/single-box; the real S3/R2 backend lands in
//                        packages/storage (W2-M) — see the reconciliation note on
//                        StorageLike below.
//   • CheckpointStore  — the DB append (document_versions row, §10.4).
//   • EngineDocumentIo — the two engine control methods a checkpoint needs (Appendix B).
//
// §3.3 finalization calls `saveCheckpoint` directly and synchronously; the idle flow
// (`saveIdleCheckpoint`) runs from the pool watchdog sweep AFTER a run finished, so a
// checkpoint save can never block a run's completion path. NOTHING in this file
// throws: every failure is a typed result envelope (§4), which is what makes the
// watchdog-fired idle path safe — a failed checkpoint degrades to "recycle anyway",
// and the WAL still holds every committed command for replay (§3.4).

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { DEFAULT_IDLE_TIMEOUT_MS } from "./constants.js";
import type { EngineSession } from "./types.js";

/** Actor recorded on checkpoint version rows (`document_versions.created_by`). */
export const CHECKPOINT_ACTOR = "system:engine-pool";

/** Object-storage keys/paths never exceed this (S3 ceiling is far higher; keep tight). */
const MAX_KEY_LENGTH = 1024;

// ---------------------------------------------------------------------------
// StorageLike — object storage seam (§3.1 `objects` service: S3/R2)
// ---------------------------------------------------------------------------

/**
 * Minimal structural object-storage seam for checkpoint bytes.
 *
 * RECONCILIATION (packages/storage, W2-M): the real S3/R2 client must satisfy this
 * shape — `put(key, data)`, `get(key)` resolving `undefined` for missing objects,
 * idempotent `delete` — or be adapted at the composition root. Do NOT widen this
 * interface here; keys are plain `/`-separated strings (no leading slash, no `..`).
 * `LocalCheckpointStorage` below is the dev/single-box adapter (compose volume),
 * not the production object store.
 */
export interface StorageLike {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

/** Filesystem subset `LocalCheckpointStorage` needs; injectable for deterministic tests. */
export interface FsLike {
  mkdir(path: string, options: { readonly recursive: true }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<unknown>;
  readFile(path: string): Promise<Uint8Array>;
  unlink(path: string): Promise<unknown>;
}

const nodeFs: FsLike = {
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data) => writeFile(path, data),
  readFile: (path) => readFile(path),
  unlink: (path) => unlink(path),
};

/** Node errno code of a thrown error, if any — used to treat ENOENT as "absent". */
const errorCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

/**
 * Split a storage key into validated path segments: non-empty, no leading `/`,
 * no `..`/empty segments, no NUL/backslash. Throws on violation — callers convert
 * to a typed envelope; the local impl must never let a key escape its root.
 */
export const splitStorageKey = (key: string): readonly string[] => {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new Error("invalid storage key: must be a non-empty string of at most 1024 chars");
  }
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new Error("invalid storage key: must be a relative slash-separated path");
  }
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("invalid storage key: empty, '.' or '..' segments are not allowed");
  }
  return segments;
};

/**
 * Local-filesystem StorageLike (dev/single-box, compose volume). Keys map 1:1 to
 * files under `rootDir`; `get` of a missing key resolves `undefined` and `delete` is
 * idempotent, mirroring S3 semantics so callers cannot tell the backends apart.
 */
export class LocalCheckpointStorage implements StorageLike {
  readonly #rootDir: string;
  readonly #fs: FsLike;

  constructor(rootDir: string, fs: FsLike = nodeFs) {
    this.#rootDir = rootDir;
    this.#fs = fs;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.#fileFor(key);
    await this.#fs.mkdir(dirname(file), { recursive: true });
    await this.#fs.writeFile(file, data);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return await this.#fs.readFile(this.#fileFor(key));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#fs.unlink(this.#fileFor(key));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }

  #fileFor(key: string): string {
    return join(this.#rootDir, ...splitStorageKey(key));
  }
}

// ---------------------------------------------------------------------------
// EngineDocumentIo — the control-method subset a checkpoint needs (Appendix B)
// ---------------------------------------------------------------------------

/** Reply of `doc.save` (Appendix B): the path written + any export warnings. */
export interface DocSaveResult {
  readonly path: string;
  readonly warnings: readonly string[];
}

/**
 * Engine seam for checkpoints; the real JSON-RPC client lives in
 * packages/engine-client (W2) and adapts to these at the composition root.
 * Method ids verified against vendor crates/automation/src/rpc.rs and
 * docs/control-protocol.md — `doc.save` writes under the session's capability
 * WRITE root and the engine refuses ambient paths in automation mode (§5.7),
 * which is why `path` is capability-root-relative.
 */
export interface EngineDocumentIo {
  /** `doc.save { path }` — persist the active document as .pcraft under the write root. */
  saveDocument(session: EngineSession, path: string): Promise<DocSaveResult>;
  /** Read a capability-write-root-relative file back (the "copy to storage" leg). */
  readRootFile(session: EngineSession, path: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// CheckpointStore — the DB append (§3.3 step 6, §10.4)
// ---------------------------------------------------------------------------

/**
 * One `document_versions` append (packages/db content schema): label / revision /
 * checkpoint_ref (jsonb) / storage_key / created_by, with unique(document_id,
 * revision). A duplicate revision must reject — revisions are monotonic (§5.6).
 */
export interface CheckpointVersionRow {
  readonly documentId: string;
  readonly organizationId: string;
  readonly label: string;
  readonly revision: number;
  /** Opaque engine snapshot ref — `document_versions.checkpoint_ref` jsonb (§10.4). */
  readonly checkpointRef: Record<string, unknown>;
  readonly storageKey: string;
  readonly createdBy: string;
}

/** The DB side of a checkpoint: exactly one immutable version-row append. */
export interface CheckpointStore {
  appendVersion(row: CheckpointVersionRow): Promise<{ readonly id: string }>;
}

// ---------------------------------------------------------------------------
// Request validation (§4: Zod at every boundary)
// ---------------------------------------------------------------------------

/** Capability-root-relative path: no leading `/`, no `..` segments, no NUL. */
export const isCapabilityRelativePath = (path: string): boolean =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !path.split("/").some((segment) => segment === "..");

const capabilityPath = z
  .string()
  .min(1)
  .max(MAX_KEY_LENGTH)
  .refine(isCapabilityRelativePath, "path must be capability-root relative");

/**
 * Opaque engine-side snapshot reference persisted in `checkpoint_ref`. `kind`
 * names the capture mechanism so recovery (W2-I) can evolve it without a
 * migration; `path` is where the engine wrote the .pcraft inside the write root.
 */
export const ENGINE_SNAPSHOT_REF_SCHEMA = z
  .object({
    kind: z.literal("doc.save"),
    path: capabilityPath,
    /** Epoch ms the snapshot was taken at (injectable clock, §22). */
    savedAt: z.number().int().nonnegative(),
    /** Optional byte size of the saved .pcraft, for dashboards only. */
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type EngineSnapshotRef = z.infer<typeof ENGINE_SNAPSHOT_REF_SCHEMA>;

export const CHECKPOINT_REQUEST_SCHEMA = z
  .object({
    /** Document revision the snapshot captures; replay resumes after it (§5.6). */
    revision: z.number().int().nonnegative(),
    /** Object-storage key for the .pcraft (§3.1 objects service). */
    storageKey: z.string().min(1).max(MAX_KEY_LENGTH),
    engineSnapshotRef: ENGINE_SNAPSHOT_REF_SCHEMA,
  })
  .strict();
export type CheckpointRequest = z.infer<typeof CHECKPOINT_REQUEST_SCHEMA>;

/** Idle-flow overrides; defaults come from the policy builders below. */
export interface IdleCheckpointOptions {
  /** Committed revision the idle snapshot captures (caller reads the document row). */
  readonly revision: number;
  /** Storage-key override; default `checkpoints/<org>/<doc>/rev-<R>.pcraft`. */
  readonly storageKey?: string;
  /** Snapshot-path override; default `checkpoints/<sessionId>/rev-<R>.pcraft`. */
  readonly snapshotPath?: string;
}

// ---------------------------------------------------------------------------
// Policy defaults (pure; injectable via CheckpointManagerOptions)
// ---------------------------------------------------------------------------

/** Object-storage key for a document's .pcraft checkpoint at `revision`. */
export const defaultCheckpointStorageKey = (
  organizationId: string,
  documentId: string,
  revision: number,
): string => `checkpoints/${organizationId}/${documentId}/rev-${revision}.pcraft`;

/** Capability-write-root-relative path the engine saves the idle snapshot to. */
export const defaultSnapshotPath = (sessionId: string, revision: number): string =>
  `checkpoints/${sessionId}/rev-${revision}.pcraft`;

/** Version-row label for system checkpoints (§10.4 named versions). */
export const checkpointVersionLabel = (revision: number): string => `checkpoint r${revision}`;

// ---------------------------------------------------------------------------
// Outcomes — typed envelopes, never throws (§4)
// ---------------------------------------------------------------------------

export type CheckpointErrorCode =
  | "invalid_checkpoint_request"
  | "session_not_attached"
  | "engine_save_failed"
  | "snapshot_read_failed"
  | "storage_write_failed"
  | "checkpoint_store_failed";

export interface CheckpointFailure {
  readonly ok: false;
  readonly code: CheckpointErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** A checkpoint that reached storage AND the version row. */
export interface CheckpointSaved {
  readonly ok: true;
  readonly versionId: string;
  readonly revision: number;
  readonly storageKey: string;
  readonly snapshotPath: string;
  readonly bytesStored: number;
}

export type CheckpointOutcome = CheckpointSaved | CheckpointFailure;

const failure = (
  code: CheckpointErrorCode,
  message: string,
  options?: { readonly hint?: string; readonly retryable?: boolean },
): CheckpointFailure => ({
  ok: false,
  code,
  message,
  hint: options?.hint,
  retryable: options?.retryable ?? false,
});

/** Safe, non-echoing description of Zod issues (§5.7: never echo values). */
const describeIssues = (issues: readonly z.ZodIssue[]): string => {
  const parts = issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`);
  const extra = issues.length > parts.length ? ` (+${issues.length - parts.length} more)` : "";
  return parts.join("; ") + extra;
};

// ---------------------------------------------------------------------------
// CheckpointManager
// ---------------------------------------------------------------------------

export interface CheckpointManagerOptions {
  readonly engine: EngineDocumentIo;
  readonly storage: StorageLike;
  readonly store: CheckpointStore;
  /**
   * Idle-timeout for `isIdleDue`; defaults to the spec's per-session 15 minutes
   * (§3.4), shared with the pool watchdog (constants.DEFAULT_IDLE_TIMEOUT_MS).
   */
  readonly idleTimeoutMs?: number;
  /** Injectable clock (epoch ms) so idle math and `savedAt` are deterministic. */
  readonly clock?: () => number;
  /** Storage-key policy override (default: `defaultCheckpointStorageKey`). */
  readonly storageKeyFor?: (input: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly revision: number;
  }) => string;
  /** Snapshot-path policy override (default: `defaultSnapshotPath`). */
  readonly snapshotPathFor?: (session: EngineSession, revision: number) => string;
  /** Optional structured logger (§22); defaults to a silent sink, like the pool. */
  readonly logger?: { warn(message: string, data?: Record<string, unknown>): void };
}

export class CheckpointManager {
  readonly #options: CheckpointManagerOptions;
  readonly #idleTimeoutMs: number;
  readonly #clock: () => number;
  readonly #logger: { warn(message: string, data?: Record<string, unknown>): void };

  constructor(options: CheckpointManagerOptions) {
    this.#options = options;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#clock = options.clock ?? Date.now;
    this.#logger = options.logger ?? { warn: (): void => undefined };
  }

  /**
   * Pure idle test for the watchdog sweep: a session is idle-checkpoint-eligible
   * once its last activity is at least `idleTimeoutMs` ago (§3.4 per-session idle,
   * 15 min default). Registry eviction candidates use the same clock discipline.
   */
  isIdleDue(session: EngineSession, now?: number): boolean {
    const at = now ?? this.#clock();
    return at - session.lastActivityAt >= this.#idleTimeoutMs;
  }

  /**
   * §3.3 step 6 flow, shared by finalization and the idle path:
   * 1. `doc.save` the active document to the capability write root (Appendix B);
   * 2. copy the bytes to object storage under `storageKey`;
   * 3. append the checkpoint version row (CheckpointStore).
   *
   * Never throws and holds no shared mutable state, so concurrent calls (e.g. a
   * finalizing run and a watchdog sweep) are safe and a failure can never block a
   * run's completion — the caller decides whether to retry or recycle.
   */
  async saveCheckpoint(
    session: EngineSession,
    request: CheckpointRequest,
  ): Promise<CheckpointOutcome> {
    const parsed = CHECKPOINT_REQUEST_SCHEMA.safeParse(request);
    if (!parsed.success) {
      return failure(
        "invalid_checkpoint_request",
        `Checkpoint request rejected: ${describeIssues(parsed.error.issues)}`,
      );
    }
    const documentId = session.documentId;
    if (documentId === undefined) {
      return failure("session_not_attached", "Engine session is not attached to a document", {
        hint: "Attach the session to a document before checkpointing (§3.2).",
      });
    }
    const { revision, storageKey, engineSnapshotRef } = parsed.data;

    let saved: DocSaveResult;
    try {
      saved = await this.#options.engine.saveDocument(session, engineSnapshotRef.path);
    } catch (error) {
      this.#logger.warn("engine-pool: checkpoint doc.save failed", {
        sessionId: session.sessionId,
        code: "engine_save_failed",
        error: String(error),
      });
      return failure("engine_save_failed", "Engine failed to save the document snapshot", {
        hint: "The engine may be busy; retry before recycling the session.",
        retryable: true,
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.#options.engine.readRootFile(session, saved.path);
    } catch (error) {
      this.#logger.warn("engine-pool: checkpoint snapshot read failed", {
        sessionId: session.sessionId,
        code: "snapshot_read_failed",
        error: String(error),
      });
      return failure(
        "snapshot_read_failed",
        "Snapshot file could not be read back from the capability root",
        {
          hint: "The save succeeded; the read-back raced with a recycle. Retry before recycling.",
          retryable: true,
        },
      );
    }

    try {
      await this.#options.storage.put(storageKey, bytes);
    } catch (error) {
      this.#logger.warn("engine-pool: checkpoint storage put failed", {
        sessionId: session.sessionId,
        code: "storage_write_failed",
        error: String(error),
      });
      return failure(
        "storage_write_failed",
        "Checkpoint bytes could not be written to object storage",
        {
          hint: "Object storage may be briefly unavailable; retry the checkpoint at the same revision.",
          retryable: true,
        },
      );
    }

    let versionId: string;
    try {
      const row: CheckpointVersionRow = {
        documentId,
        organizationId: session.organizationId,
        label: checkpointVersionLabel(revision),
        revision,
        checkpointRef: { ...engineSnapshotRef },
        storageKey,
        createdBy: CHECKPOINT_ACTOR,
      };
      const appended = await this.#options.store.appendVersion(row);
      versionId = appended.id;
    } catch (error) {
      this.#logger.warn("engine-pool: checkpoint version append failed", {
        sessionId: session.sessionId,
        code: "checkpoint_store_failed",
        error: String(error),
      });
      return failure("checkpoint_store_failed", "Checkpoint version row could not be appended", {
        hint: "The .pcraft object was stored; the next checkpoint at a newer revision will retry the row append.",
        retryable: true,
      });
    }

    return {
      ok: true,
      versionId,
      revision,
      storageKey,
      snapshotPath: saved.path,
      bytesStored: bytes.byteLength,
    };
  }

  /**
   * §3.2 idle-timeout flow (15 min default): on an idle session the watchdog saves
   * the current document state so the process can be recycled without losing more
   * than the WAL replay window. Runs OFF the run-completion path — only the
   * watchdog calls this for sessions idle past the timeout; every failure is a
   * returned envelope (never a throw), so a failed idle checkpoint degrades to
   * "recycle anyway; replay from the previous checkpoint" (§3.4).
   */
  async saveIdleCheckpoint(
    session: EngineSession,
    options: IdleCheckpointOptions,
  ): Promise<CheckpointOutcome> {
    const documentId = session.documentId;
    if (documentId === undefined) {
      return failure("session_not_attached", "Engine session is not attached to a document", {
        hint: "Only attached sessions are checkpointed on idle (§3.2).",
      });
    }
    const { revision } = options;
    const snapshotPath =
      options.snapshotPath ??
      this.#options.snapshotPathFor?.(session, revision) ??
      defaultSnapshotPath(session.sessionId, revision);
    const storageKey =
      options.storageKey ??
      this.#options.storageKeyFor?.({
        organizationId: session.organizationId,
        documentId,
        revision,
      }) ??
      defaultCheckpointStorageKey(session.organizationId, documentId, revision);
    return this.saveCheckpoint(session, {
      revision,
      storageKey,
      engineSnapshotRef: { kind: "doc.save", path: snapshotPath, savedAt: this.#clock() },
    });
  }
}
