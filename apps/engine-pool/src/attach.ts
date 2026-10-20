// @studio/engine-pool — SessionAttach: the "attach to document" leg of the session
// lifecycle (§3.2) plus the replay decision of crash recovery (§3.4: "replay the
// command log from the last checkpoint"; the command log IS the WAL). Pure decision
// logic first — `decideAttachPlan` turns (checkpoint, WAL slice) into an AttachPlan
// WITHOUT executing anything — then `executeAttachPlan` runs the chosen plan through
// an injected EngineClientLike (packages/engine-client, W2, adapts at the composition
// root; method ids verified against Appendix B and vendor
// crates/automation/src/rpc.rs: doc.new, doc.open, batch).
//
// Decision table (§5.6 revision counters; failed commands — result IS NULL — are
// audited via agent_steps and never replayed, per the content schema):
//
//   document state                        | plan
//   -------------------------------------+-------------------------------------
//   new doc: no checkpoint, empty WAL     | fresh     { fromRevision: 0, 0 }
//   checkpoint @R, WAL entries after R    | replay    { fromRevision: R, n }
//   checkpoint @R, nothing after R        | checkpoint{ fromRevision: R, 0 }
//   no checkpoint, WAL non-empty          | replay    { fromRevision: 0, all } (full)
//
// A caller may FORCE a strategy via AttachOptions.strategy; an infeasible force is a
// typed `strategy_unavailable` envelope, never a throw (§4).

import { z } from "zod";

import type { EngineSession } from "./types.js";

export type AttachStrategy = "checkpoint" | "replay" | "fresh";

/** Strategy selection; omit `strategy` for the automatic decision above. */
export interface AttachOptions {
  readonly strategy?: AttachStrategy;
}

/** The decision output — deliberately execution-free (the executor takes it later). */
export interface AttachPlan {
  readonly kind: AttachStrategy;
  /** Revision the engine starts from: the checkpoint base, 0 for fresh/full replay. */
  readonly fromRevision: number;
  /** Committed WAL entries the executor must apply after the base (§5.6). */
  readonly commandCount: number;
}

/**
 * The latest persisted checkpoint for a document. RECONCILIATION: structurally the
 * `document_versions` row (content schema): revision + storage_key + checkpoint_ref.
 */
export interface CheckpointState {
  readonly revision: number;
  readonly storageKey: string;
  readonly checkpointRef: Record<string, unknown> | null;
}

/**
 * One WAL row. RECONCILIATION: structurally the `commands` table row (content
 * schema W1-D) — seq gives the strict total order for replay (unique(document_id,
 * seq)); `result: null` marks a command that failed before producing state and is
 * never replayed; revision_before/revision_after are the §5.6 monotonic counters.
 */
export interface WalCommandEntry {
  readonly seq: number;
  readonly commandName: string;
  readonly params: Record<string, unknown>;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly result: Record<string, unknown> | null;
}

/** Injected read model: latest checkpoint + the WAL slice after a revision. */
export interface AttachStateProvider {
  latestCheckpoint(documentId: string, organizationId: string): Promise<CheckpointState | null>;
  /**
   * Committed WAL entries applied at/after `afterRevision`, in seq order. A null
   * result marks a failed command (never replayed) — implementations may filter.
   */
  commandsAfterRevision(
    documentId: string,
    organizationId: string,
    afterRevision: number,
  ): Promise<readonly WalCommandEntry[]>;
}

// ---------------------------------------------------------------------------
// Engine seams — structural, satisfied by packages/engine-client (W2)
// ---------------------------------------------------------------------------

/** Result of one engine call: a §4-shaped envelope, never a throw at the seam. */
export type EngineCall =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly retryable?: boolean;
    };

/** One transactional batch step — the `batch { steps: [{ command, params }] }` shape. */
export interface BatchStep {
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * The engine subset attach needs (Appendix B): `doc.new`, `doc.open { path }`,
 * `batch`. Adapters live at the composition root; this stays structural so the
 * decision and orchestration are testable without a real engine process.
 */
export interface EngineClientLike {
  /** `doc.new` — create an empty document (fresh / full-replay base). */
  createDocument(session: EngineSession): Promise<EngineCall>;
  /** `doc.open { path }` — open the .pcraft staged inside the capability read root. */
  openDocument(session: EngineSession, path: string): Promise<EngineCall>;
  /** `batch` — apply the WAL slice transactionally (§5.6 replay). */
  applyBatch(session: EngineSession, steps: readonly BatchStep[]): Promise<EngineCall>;
}

/** Read side of object storage for .pcraft checkpoints — StorageLike satisfies this. */
export interface CheckpointObjectReader {
  get(key: string): Promise<Uint8Array | undefined>;
}

/** Writes bytes into the session's capability read root; returns the relative path. */
export interface CapabilityStager {
  stage(session: EngineSession, relativePath: string, bytes: Uint8Array): Promise<string>;
}

/** Everything the orchestration needs; all seams, no I/O of its own. */
export interface AttachExecutor {
  readonly provider: AttachStateProvider;
  readonly engine: EngineClientLike;
  readonly storage: CheckpointObjectReader;
  readonly stager: CapabilityStager;
}

// ---------------------------------------------------------------------------
// Outcomes — typed envelopes, never throws (§4)
// ---------------------------------------------------------------------------

export type AttachErrorCode =
  | "invalid_attach_request"
  | "attach_state_unavailable"
  | "strategy_unavailable"
  | "checkpoint_object_missing"
  | "engine_attach_failed"
  | "engine_replay_failed";

export interface AttachFailure {
  readonly ok: false;
  readonly code: AttachErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type AttachPlanOutcome = { readonly ok: true; readonly plan: AttachPlan } | AttachFailure;

export interface AttachSucceeded {
  readonly ok: true;
  readonly kind: AttachStrategy;
  readonly fromRevision: number;
  readonly appliedCommands: number;
  /** Object-storage key the engine state was restored from, when a checkpoint was used. */
  readonly restoredFrom?: string;
}

export type AttachResult = AttachSucceeded | AttachFailure;

const failure = (
  code: AttachErrorCode,
  message: string,
  options?: { readonly hint?: string; readonly retryable?: boolean },
): AttachFailure => ({
  ok: false,
  code,
  message,
  hint: options?.hint,
  retryable: options?.retryable ?? false,
});

const describeIssues = (issues: readonly z.ZodIssue[]): string => {
  const parts = issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`);
  const extra = issues.length > parts.length ? ` (+${issues.length - parts.length} more)` : "";
  return parts.join("; ") + extra;
};

// ---------------------------------------------------------------------------
// Validation schemas (§4: Zod at every boundary)
// ---------------------------------------------------------------------------

const STRATEGIES = ["checkpoint", "replay", "fresh"] as const;

export const ATTACH_OPTIONS_SCHEMA = z.object({ strategy: z.enum(STRATEGIES).optional() }).strict();
export const ATTACH_PLAN_SCHEMA = z
  .object({
    kind: z.enum(STRATEGIES),
    fromRevision: z.number().int().nonnegative(),
    commandCount: z.number().int().nonnegative(),
  })
  .strict();
const DOCUMENT_ID_SCHEMA = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

/**
 * Committed, replayable WAL entries: result non-null (failures are audited, never
 * replayed), ordered by seq — the strict total replay order (§5.6).
 */
export const replayableEntries = (
  entries: readonly WalCommandEntry[],
): readonly WalCommandEntry[] =>
  entries.filter((entry) => entry.result !== null).sort((a, b) => a.seq - b.seq);

/**
 * The §3.4 decision, pure over (checkpoint, WAL slice after the checkpoint base).
 * `entries` are the rows the provider returned for `checkpoint?.revision ?? 0`.
 */
export function decideAttachPlan(
  checkpoint: CheckpointState | null,
  entries: readonly WalCommandEntry[],
): AttachPlan {
  const replayable = replayableEntries(entries);
  if (checkpoint === null) {
    if (replayable.length === 0) return { kind: "fresh", fromRevision: 0, commandCount: 0 };
    return { kind: "replay", fromRevision: 0, commandCount: replayable.length };
  }
  if (replayable.length === 0) {
    return { kind: "checkpoint", fromRevision: checkpoint.revision, commandCount: 0 };
  }
  return { kind: "replay", fromRevision: checkpoint.revision, commandCount: replayable.length };
}

/** Feasibility + plan of a FORCED strategy against the observed document state. */
const forcedPlan = (
  strategy: AttachStrategy,
  checkpoint: CheckpointState | null,
  replayableCount: number,
): AttachPlanOutcome => {
  if (strategy === "fresh") {
    if (checkpoint !== null || replayableCount > 0) {
      return failure(
        "strategy_unavailable",
        "Document already has committed history; a fresh attach would discard it",
        { hint: "Use strategy replay, or checkpoint when the WAL is fully checkpointed." },
      );
    }
    return { ok: true, plan: { kind: "fresh", fromRevision: 0, commandCount: 0 } };
  }
  if (strategy === "checkpoint") {
    if (checkpoint === null) {
      return failure("strategy_unavailable", "No checkpoint exists for this document", {
        hint: "Attach with strategy replay (full WAL), or fresh if the document is new.",
      });
    }
    return {
      ok: true,
      plan: { kind: "checkpoint", fromRevision: checkpoint.revision, commandCount: 0 },
    };
  }
  if (replayableCount === 0) {
    return failure("strategy_unavailable", "Nothing to replay for this document", {
      hint: "Use strategy checkpoint (WAL is covered) or fresh (new document).",
    });
  }
  return {
    ok: true,
    plan: {
      kind: "replay",
      fromRevision: checkpoint?.revision ?? 0,
      commandCount: replayableCount,
    },
  };
};

// ---------------------------------------------------------------------------
// Orchestration (executes an AttachPlan through the seams)
// ---------------------------------------------------------------------------

const callEngine = async (
  call: () => Promise<EngineCall>,
  code: AttachErrorCode,
): Promise<AttachFailure | undefined> => {
  let outcome: EngineCall;
  try {
    outcome = await call();
  } catch {
    // §4: no internals leak — the envelope stays generic; log at the composition root.
    return failure(code, "Engine call failed during attach", { retryable: true });
  }
  if (!outcome.ok) {
    return failure(code, "Engine rejected the attach step", {
      hint: "The engine replied with an error; retry attach from the last checkpoint (§3.4).",
      retryable: outcome.retryable ?? true,
    });
  }
  return undefined;
};

/** Fetch the current state (checkpoint + WAL after it); a provider error is an envelope. */
const readState = async (
  provider: AttachStateProvider,
  documentId: string,
  organizationId: string,
): Promise<
  | {
      readonly ok: true;
      readonly checkpoint: CheckpointState | null;
      readonly entries: readonly WalCommandEntry[];
    }
  | AttachFailure
> => {
  let checkpoint: CheckpointState | null;
  let entries: readonly WalCommandEntry[];
  try {
    checkpoint = await provider.latestCheckpoint(documentId, organizationId);
    entries = await provider.commandsAfterRevision(
      documentId,
      organizationId,
      checkpoint?.revision ?? 0,
    );
  } catch {
    return failure("attach_state_unavailable", "Document state could not be read", {
      hint: "The store was unavailable; retry the attach decision (§3.4).",
      retryable: true,
    });
  }
  return { ok: true, checkpoint, entries };
};

const restoreFromCheckpoint = async (
  session: EngineSession,
  documentId: string,
  organizationId: string,
  deps: AttachExecutor,
): Promise<{ readonly ok: true; readonly storageKey: string } | AttachFailure> => {
  const state = await readState(deps.provider, documentId, organizationId);
  if (!state.ok) return state;
  const { checkpoint } = state;
  if (checkpoint === null) {
    return failure(
      "strategy_unavailable",
      "Checkpoint disappeared between planning and execution",
      {
        retryable: true,
      },
    );
  }
  let bytes: Uint8Array | undefined;
  try {
    bytes = await deps.storage.get(checkpoint.storageKey);
  } catch {
    return failure("checkpoint_object_missing", "Checkpoint object could not be read", {
      hint: "Object storage was unavailable; retry, or replay the full WAL from revision 0.",
      retryable: true,
    });
  }
  if (bytes === undefined) {
    return failure("checkpoint_object_missing", "Checkpoint object not found in object storage", {
      hint: "Re-attach with strategy replay so the full WAL is re-applied.",
    });
  }
  const relativePath = `restore/${session.sessionId}/rev-${checkpoint.revision}.pcraft`;
  let stagedPath: string;
  try {
    stagedPath = await deps.stager.stage(session, relativePath, bytes);
  } catch {
    return failure(
      "engine_attach_failed",
      "Checkpoint could not be staged into the capability root",
      {
        retryable: true,
      },
    );
  }
  const openFailure = await callEngine(
    () => deps.engine.openDocument(session, stagedPath),
    "engine_attach_failed",
  );
  if (openFailure !== undefined) return openFailure;
  return { ok: true, storageKey: checkpoint.storageKey };
};

/**
 * Execute a plan (§3.2 attach → §3.4 replay). Pure decision stays in
 * `decideAttachPlan`; this function re-reads state at execution time and drives
 * the engine: checkpoint kind restores the .pcraft; replay restores the base
 * (or creates an empty document for a full replay) then applies the WAL slice
 * as one transactional `batch` (§5.6).
 */
export async function executeAttachPlan(
  session: EngineSession,
  documentId: string,
  plan: AttachPlan,
  deps: AttachExecutor,
): Promise<AttachResult> {
  const parsedPlan = ATTACH_PLAN_SCHEMA.safeParse(plan);
  if (!parsedPlan.success) {
    return failure(
      "invalid_attach_request",
      `Attach plan rejected: ${describeIssues(parsedPlan.error.issues)}`,
    );
  }
  if (!DOCUMENT_ID_SCHEMA.safeParse(documentId).success) {
    return failure(
      "invalid_attach_request",
      "Attach request rejected: documentId must be a non-empty id",
    );
  }
  const { kind, fromRevision } = parsedPlan.data;

  if (kind === "fresh") {
    const freshFailure = await callEngine(
      () => deps.engine.createDocument(session),
      "engine_attach_failed",
    );
    if (freshFailure !== undefined) return freshFailure;
    return { ok: true, kind, fromRevision, appliedCommands: 0 };
  }

  if (kind === "checkpoint") {
    const restored = await restoreFromCheckpoint(session, documentId, session.organizationId, deps);
    if (!restored.ok) return restored;
    return {
      ok: true,
      kind,
      fromRevision,
      appliedCommands: 0,
      restoredFrom: restored.storageKey,
    };
  }

  // kind === "replay": restore the base, then re-apply the WAL slice (§3.4).
  let baseRestoredFrom: string | undefined;
  const baseState = await readState(deps.provider, documentId, session.organizationId);
  if (!baseState.ok) return baseState;
  if (baseState.checkpoint !== null) {
    const restored = await restoreFromCheckpoint(session, documentId, session.organizationId, deps);
    if (!restored.ok) return restored;
    baseRestoredFrom = restored.storageKey;
  } else {
    const emptyFailure = await callEngine(
      () => deps.engine.createDocument(session),
      "engine_attach_failed",
    );
    if (emptyFailure !== undefined) return emptyFailure;
  }

  const steps: BatchStep[] = replayableEntries(baseState.entries).map((entry) => ({
    command: entry.commandName,
    params: entry.params,
  }));
  const batchFailure = await callEngine(
    () => deps.engine.applyBatch(session, steps),
    "engine_replay_failed",
  );
  if (batchFailure !== undefined) return batchFailure;
  return {
    ok: true,
    kind,
    fromRevision,
    appliedCommands: steps.length,
    restoredFrom: baseRestoredFrom,
  };
}

// ---------------------------------------------------------------------------
// SessionAttach — wires the seams together (composition-root convenience)
// ---------------------------------------------------------------------------

/**
 * Attach facade: `attachDocument` yields the execution-free AttachPlan; the
 * executor (worker, W6) calls `executeAttachPlan` with the plan when it is ready
 * to drive the engine session (§3.2 allocate → attach → run).
 */
export class SessionAttach {
  readonly #deps: AttachExecutor;

  constructor(options: AttachExecutor) {
    this.#deps = options;
  }

  /** Decide how to bring `documentId` up in the engine (never executes anything). */
  async attachDocument(
    session: EngineSession,
    documentId: string,
    options?: AttachOptions,
  ): Promise<AttachPlanOutcome> {
    if (!DOCUMENT_ID_SCHEMA.safeParse(documentId).success) {
      return failure(
        "invalid_attach_request",
        "Attach request rejected: documentId must be a non-empty id",
      );
    }
    const parsedOptions = ATTACH_OPTIONS_SCHEMA.safeParse(options ?? {});
    if (!parsedOptions.success) {
      return failure(
        "invalid_attach_request",
        `Attach request rejected: ${describeIssues(parsedOptions.error.issues)}`,
      );
    }
    const state = await readState(this.#deps.provider, documentId, session.organizationId);
    if (!state.ok) return state;
    const replayableCount = replayableEntries(state.entries).length;
    const strategy = parsedOptions.data.strategy;
    if (strategy === undefined) {
      return { ok: true, plan: decideAttachPlan(state.checkpoint, state.entries) };
    }
    return forcedPlan(strategy, state.checkpoint, replayableCount);
  }

  /** Run a previously decided plan through the injected seams. */
  executeAttachPlan(
    session: EngineSession,
    documentId: string,
    plan: AttachPlan,
  ): Promise<AttachResult> {
    return executeAttachPlan(session, documentId, plan, this.#deps);
  }
}
