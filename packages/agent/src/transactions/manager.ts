// @studio/agent — TransactionManager: one engine transaction per run (§5.6).
// Owner: W6-I (docs/AGENTS.md).
//
// Spec anchors:
//   §5.6   `agent.begin` before the first mutating command; `agent.commit` on success;
//          `agent.rollback` on failure/cancel/validation blocker — the user sees and can
//          undo exactly ONE history entry per run. The command log (`commands` table,
//          packages/db/src/schema/content.ts) IS the write-ahead log: one row per
//          executed command, appended only, revision_before/revision_after monotonic.
//   §3.3   finalization (step 6): engine commit → .pcraft bytes (engine doc.save) →
//          object storage at the documents key → durable checkpoint row in the DB.
//   §3.4   resume seam: after an engine crash the worker replays the WAL onto a fresh
//          session (apps/engine-pool recovery) and the run resumes ONCE; begin() takes
//          the durable cursor so the resumed manager continues the log at the right
//          seq and validates the engine state against it.
//   §1.5 rule 10 — one transaction per document at a time; nested begins are refused.
//   §5.7   every model-proposed command is untrusted: the echoed revision is checked,
//          never trusted, and the total mutating commands per run can be capped.
//   §6.1   engine replies echo the document revision; that echo is the WAL's truth.
//
// WAL row shapes this manager writes (append-only — history is NEVER deleted):
//   - `agent.begin` marker: (R → R) — the checkpoint revision at begin; no content
//     change, so both revision columns carry the engine's `revision_before`.
//   - every tracked mutating command: (R → R+1), chained with its predecessor. A gap
//     or a rewind is a typed error (`wal_gap_detected` / `wal_monotonicity_violation`)
//     and the run must roll back: replaying past a gap would corrupt the document.
//   - `agent.rollback` marker with flag `rolled_back`: the engine reply's
//     (revision_before → revision_after) verbatim. Per engine-patches/docs/commands.md
//     the rollback reply's `revision_before` is the CHECKPOINT revision (the content
//     returns to it) while `revision_after` keeps the monotonic climb, so marker rows
//     intentionally do NOT carry the +1 chain.
//
// Replay contract for the WAL adapter (wiring layer, NOT this module): `agent.*` rows
// and any flagged row are markers, never replayed content — the engine derives the
// run's collapse from history again. readSlice-style consumers must filter them out,
// exactly like the engine-pool WalProvider filters to replayable rows.
//
// This module owns NO infrastructure: the engine, the command log, object storage and
// the checkpoint row are injected seams (DI everywhere, like the §3.4 recovery
// coordinator in apps/engine-pool). The worker wires the real adapters.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants (wire ids verified against engine-patches/docs/commands.md, W3-F)
// ---------------------------------------------------------------------------

/** The three §5.6 transaction commands this manager drives. */
export const AGENT_TX_COMMANDS = [
  "agent.begin",
  "agent.commit",
  "agent.rollback",
] as const satisfies readonly string[];

export type AgentTxCommand = (typeof AGENT_TX_COMMANDS)[number];

/** Engine `agent.begin` name cap (MAX_NAME_CHARS in engine-patches/agent_cmds.rs). */
export const MAX_TX_NAME_CHARS = 256;

/** Engine refusal codes that mean the engine transaction is CLOSED (not busy). */
const ENGINE_TX_CLOSED_CODES = ["transaction_checkpoint_gone", "transaction_not_open"] as const;

const ENGINE_TX_BUSY_CODE = "transaction_busy";

/** Audit markers on WAL rows. The log is append-only: flags mark rows, never rewrite. */
export const WAL_ROW_FLAGS = ["rolled_back"] as const satisfies readonly string[];

export type WalRowFlag = (typeof WAL_ROW_FLAGS)[number];

/**
 * Object-storage key for a committed .pcraft (§3.3 step 6, "the documents key").
 * Default is document-relative; wiring should inject the tenant-scoped builder
 * (packages/storage keys.ts: `documents/organizations/<orgId>/documents/<docId>/…`).
 */
export const defaultPcraftStorageKey = (documentId: string, revision: number): string =>
  `documents/${documentId}/revisions/${revision}.pcraft`;

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** One engine refusal, already parsed off the wire string (engine-client adapter's job). */
export interface EngineCommandError {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

/** The engine reply envelope: the control protocol's ok/result vs ok/error split. */
export type EngineReply<T> =
  | { readonly ok: true; readonly result: T }
  | ({ readonly ok: false } & EngineCommandError);

/**
 * The engine surface the transaction manager needs (§5.6): `execute` is used ONLY for
 * the three transaction commands; `save` returns the .pcraft bytes for object storage.
 * Content commands are executed by the executor and afterwards reported via
 * `trackCommand` — this manager never executes them.
 */
export interface EngineTxLike {
  execute(
    command: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<EngineReply<Readonly<Record<string, unknown>>>>;
  /** engine doc.save → the committed document as .pcraft bytes (§3.3 step 6). */
  save(): Promise<EngineReply<{ readonly bytes: Uint8Array }>>;
}

/** One append-only command-log row (packages/db `commands` columns, §5.6). */
export interface WalAppendInput {
  readonly documentId: string;
  /** 1-based per-document position; unique(document_id, seq) gives the replay order. */
  readonly seq: number;
  readonly commandName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  /** Audit marker, e.g. `rolled_back` — history is kept, never deleted (§5.6). */
  readonly flag?: WalRowFlag;
}

/** Injected write access to the command log (the real adapter inserts a row). */
export interface WalAppendLike {
  append(input: WalAppendInput): Promise<void>;
}

/** Minimal object-storage seam; the adapter bridges to @studio/storage (§12.2 tenancy). */
export interface StorageLike {
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/**
 * The durable checkpoint after finalization (§3.3 step 6): the document's replay base.
 * Field names line up with the engine-pool `WalCursor` (seq = last captured row,
 * revision = the engine commit's revision_after) so the wiring can hand it straight
 * to §3.4 recovery.
 */
export interface CheckpointInput {
  readonly documentId: string;
  readonly runId: string;
  /** Last WAL seq durably captured by the committed .pcraft. */
  readonly seq: number;
  /** Document revision at that seq — the engine commit's `revision_after`. */
  readonly revision: number;
  /** Object-storage key of the committed .pcraft. */
  readonly storageKey: string;
  /** Opaque engine snapshot ref (§10.4 checkpoint_ref): this run's transaction id. */
  readonly checkpointRef: Readonly<Record<string, unknown>>;
}

/** Injected persistence for the checkpoint row (document_versions + run row, wiring). */
export interface CheckpointLike {
  save(input: CheckpointInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Typed results (AGENTS.md envelopes; codes are module-local, recovery.ts precedent)
// ---------------------------------------------------------------------------

export const TRANSACTION_ERROR_CODES = [
  // Bad arguments at the manager boundary (ids, name, echoed revisions, cursor).
  "transaction_invalid_input",
  // §1.5 rule 10 / §5.6: a run begins at most one transaction; one per document.
  "transaction_already_open",
  // commit/rollback/track without an open transaction (includes double commit).
  "transaction_not_open",
  // §5.7 cap on total mutating commands per run, when configured.
  "mutating_command_cap_exceeded",
  // §5.6: an untracked command mutated the document — the chain broke upward.
  "wal_gap_detected",
  // §5.6: a logged command did not advance the revision (rewind or no-op).
  "wal_monotonicity_violation",
  // The command-log seam refused the append (durability failure).
  "wal_append_failed",
  // §3.4 resume: the caller-supplied cursor does not match the engine state.
  "wal_slice_mismatch",
  // The engine refused a transaction command (busy / checkpoint gone / no document).
  "engine_command_failed",
  // An ok:true engine reply failed schema or identity validation (protocol violation).
  "engine_reply_invalid",
  // §3.3 step 6: the engine committed but the durable copy failed (retryable).
  "checkpoint_write_failed",
] as const satisfies readonly string[];

export type TransactionErrorCode = (typeof TRANSACTION_ERROR_CODES)[number];

export interface TransactionFailure {
  readonly ok: false;
  readonly code: TransactionErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type TransactionResult<T> = { readonly ok: true; readonly value: T } | TransactionFailure;

export function transactionOk<T>(value: T): TransactionResult<T> {
  return { ok: true, value };
}

export interface TransactionErrOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

export function transactionErr<T = never>(
  code: TransactionErrorCode,
  message: string,
  options: TransactionErrOptions = {},
): TransactionResult<T> {
  const failure: {
    ok: false;
    code: TransactionErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  return failure;
}

export function isTransactionFailure<T>(
  result: TransactionResult<T>,
): result is TransactionFailure {
  return result.ok === false;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** `agent.begin` succeeded: the engine checkpoint is taken and the marker row logged. */
export interface BeginOutcome {
  /** Engine transaction id (the checkpoint snapshot id, never reused per document). */
  readonly transactionId: number;
  /** Document revision at begin — the checkpoint content the run returns to. */
  readonly revisionBefore: number;
  /** WAL seq of the `agent.begin` marker row. */
  readonly seq: number;
}

/** One executed mutating command, reported by the executor right after the engine call. */
export interface TrackedCommand {
  readonly runId: string;
  readonly commandName: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** Document revision echoed by the engine reply (§6.1 document_revision). */
  readonly revisionAfter: number;
}

/** The command was appended to the command log as a chained row. */
export interface TrackOutcome {
  readonly seq: number;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
}

/** §3.3 step 6 complete: one undoable entry, .pcraft durable, checkpoint row saved. */
export interface CommitOutcome {
  readonly transactionId: number;
  /** The run's checkpoint revision (the engine commit reply's revision_before). */
  readonly revisionBefore: number;
  /** Revision after the fold (the engine bumps once: the panel moved, pixels did not). */
  readonly revisionAfter: number;
  /** Mutating commands folded into the ONE undoable history entry. */
  readonly commandCount: number;
  readonly storageKey: string;
  /** Durable replay base written via the checkpoint seam. */
  readonly checkpoint: { readonly seq: number; readonly revision: number };
}

/** `agent.rollback` succeeded: the document is the checkpoint content again. */
export interface RollbackOutcome {
  readonly transactionId: number;
  /** Checkpoint revision — the pre-run content that was restored. */
  readonly revisionBefore: number;
  /** Post-restore revision (monotonic climb; the engine bumps once). */
  readonly revisionAfter: number;
  /** Always true on the rollback path — mirrors the engine reply. */
  readonly restored: true;
  readonly commandCount: number;
  /** WAL seq of the `agent.rollback` marker row (flag `rolled_back`). */
  readonly markerSeq: number;
}

/** Lifecycle of one run's transaction: open → committed | rolled_back | aborted. */
export const TRANSACTION_RUN_STATES = ["open", "committed", "rolled_back", "aborted"] as const;

export type TransactionRunState = (typeof TRANSACTION_RUN_STATES)[number];

/**
 * §3.4 resume cursor: where the durable command log stood when this manager instance
 * took over the run (after crash recovery replayed the WAL onto a fresh session).
 */
export interface WalResume {
  /** Last seq durably in the document's command log (0 = empty log). */
  readonly seq: number;
  /** Document revision the engine must report at `agent.begin` on the resumed session. */
  readonly revision: number;
}

// ---------------------------------------------------------------------------
// Engine reply schemas (Zod at the boundary; shapes pinned by W3-F)
// ---------------------------------------------------------------------------

const REPLY_SHAPE_HINT =
  "Expected the documented agent.* reply {transaction_id, revision_before[, revision_after]" +
  "[, restored]} (engine-patches/docs/commands.md §5.6).";

const AGENT_BEGIN_REPLY_SCHEMA = z
  .object({
    transaction_id: z.number().int().min(1),
    revision_before: z.number().int().min(0),
  })
  .passthrough();

const AGENT_COMMIT_REPLY_SCHEMA = z
  .object({
    transaction_id: z.number().int().min(1),
    revision_before: z.number().int().min(0),
    revision_after: z.number().int().min(0),
  })
  .passthrough()
  .refine((reply) => reply.revision_after >= reply.revision_before, {
    message: "engine commit reply rewound the revision counter",
  });

const AGENT_ROLLBACK_REPLY_SCHEMA = z
  .object({
    transaction_id: z.number().int().min(1),
    revision_before: z.number().int().min(0),
    revision_after: z.number().int().min(0),
    restored: z.literal(true),
  })
  .passthrough()
  .refine((reply) => reply.revision_after >= reply.revision_before, {
    message: "engine rollback reply rewound the revision counter",
  });

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface TransactionManagerOptions {
  readonly engine: EngineTxLike;
  readonly wal: WalAppendLike;
  readonly storage: StorageLike;
  readonly checkpoint: CheckpointLike;
  /**
   * §5.7 cap on total mutating commands per run. Optional by design: the tier
   * budgets (§5.2) own the default policy; the worker injects the tier's cap.
   */
  readonly maxMutatingCommandsPerRun?: number;
  /** Object-storage key builder for a committed .pcraft (§3.3 step 6). */
  readonly storageKeyFor?: (documentId: string, revision: number) => string;
}

/** One run's transaction bookkeeping. */
interface RunTransaction {
  readonly runId: string;
  readonly documentId: string;
  readonly transactionId: number;
  /** Checkpoint revision at `agent.begin`. */
  readonly revisionBefore: number;
  /** Revision after the last successfully tracked command (starts == revisionBefore). */
  lastRevision: number;
  /** Next WAL seq to append for this document. */
  nextSeq: number;
  /** Seq of the last appended row of this run (the begin marker when none tracked). */
  lastSeq: number;
  commandCount: number;
  state: TransactionRunState;
}

const ROLLBACK_AFTER_GAP_HINT =
  "An untracked command mutated the document; roll the run back. Replay must never " +
  "cross a gap (§5.6).";

const NO_RECOMMIT_HINT =
  "The engine transaction is closed; retry the durable save/checkpoint writes instead " +
  "of calling commit again (§3.3 step 6).";

/**
 * Drives the §5.6 transaction of one agent run over injected seams.
 *
 * Usage (worker loop): `begin` before the first mutating command; `trackCommand`
 * after each successful engine execute; `commit` on success; `rollback` on failure,
 * cancellation or a validation blocker. The WAL is appended-only — a rollback keeps
 * every row and appends a `rolled_back` marker, so history is never deleted.
 */
export class TransactionManager {
  readonly #options: TransactionManagerOptions;
  readonly #storageKeyFor: (documentId: string, revision: number) => string;
  /** Run records by run id, kept after closing (double-commit detection). */
  readonly #runs = new Map<string, RunTransaction>();
  /** documentId → runId of the open transaction (§1.5 rule 10: one per document). */
  readonly #openByDocument = new Map<string, string>();
  /** documentId → next WAL seq; survives run close so the log stays contiguous. */
  readonly #docNextSeq = new Map<string, number>();

  constructor(options: TransactionManagerOptions) {
    this.#options = options;
    this.#storageKeyFor = options.storageKeyFor ?? defaultPcraftStorageKey;
  }

  /** Lifecycle state of a run's transaction; null when the run never began one. */
  status(runId: string): TransactionRunState | null {
    return this.#runs.get(runId)?.state ?? null;
  }

  /** The run holding the document's open transaction, if any (§1.5 rule 10). */
  openRunForDocument(documentId: string): string | null {
    return this.#openByDocument.get(documentId) ?? null;
  }

  /**
   * `agent.begin` (§5.6): take the engine checkpoint, append the marker row, open the
   * run's transaction. `resume` continues the log at a durable cursor after a §3.4
   * crash-recovery replay; omit it for a document whose log this instance starts.
   */
  async begin(
    runId: string,
    documentId: string,
    name: string,
    resume?: WalResume,
  ): Promise<TransactionResult<BeginOutcome>> {
    if (runId.trim().length === 0 || documentId.trim().length === 0) {
      return transactionErr(
        "transaction_invalid_input",
        "A transaction needs a run id and a document id",
        { hint: "The worker supplies both ids (§3.3 step 3)." },
      );
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > MAX_TX_NAME_CHARS) {
      return transactionErr(
        "transaction_invalid_input",
        `The transaction name must be 1..${MAX_TX_NAME_CHARS} characters`,
        {
          hint: "The engine labels the run's single undoable history entry with this name (§5.6).",
        },
      );
    }
    if (this.#runs.has(runId)) {
      return transactionErr("transaction_already_open", "The run already opened a transaction", {
        hint:
          "Each run begins at most one transaction (§5.6); a resumed run re-attaches " +
          "through the recovery seam, it never re-begins.",
      });
    }
    const openRun = this.#openByDocument.get(documentId);
    if (openRun !== undefined) {
      return transactionErr(
        "transaction_already_open",
        "Another run has an open transaction on this document",
        { hint: "One agent transaction per document at a time (§1.5 rule 10)." },
      );
    }

    const call = await this.#executeTx("agent.begin", { name: trimmedName });
    if (!call.ok) {
      return call.failure;
    }
    const parsed = AGENT_BEGIN_REPLY_SCHEMA.safeParse(call.result);
    if (!parsed.success) {
      return transactionErr(
        "engine_reply_invalid",
        "The engine reply to agent.begin failed schema validation",
        { hint: REPLY_SHAPE_HINT },
      );
    }
    const { transaction_id: transactionId, revision_before: revisionBefore } = parsed.data;

    if (resume !== undefined) {
      const cursorInvalid =
        !Number.isInteger(resume.seq) ||
        resume.seq < 0 ||
        !Number.isInteger(resume.revision) ||
        resume.revision < 0;
      if (cursorInvalid) {
        return transactionErr("transaction_invalid_input", "The resume cursor is malformed", {
          hint: "A §3.4 cursor is { seq, revision } with non-negative integers.",
        });
      }
      if (resume.revision !== revisionBefore) {
        return transactionErr(
          "wal_slice_mismatch",
          `The resume cursor (revision ${resume.revision}) does not match the engine state ` +
            `(revision ${revisionBefore})`,
          {
            hint:
              "Recovery must replay the WAL up to the engine's current revision before " +
              "the run resumes (§3.4).",
          },
        );
      }
    }

    const seq = this.#docNextSeq.get(documentId) ?? (resume ? resume.seq + 1 : 1);
    const appended = await this.#append({
      documentId,
      seq,
      commandName: "agent.begin",
      params: { name: trimmedName },
      revisionBefore,
      revisionAfter: revisionBefore,
    });
    if (!appended.ok) {
      // The engine transaction IS open, so the caller must roll the run back —
      // register the run first so rollback(runId) can reach the engine. The marker
      // never landed (seam contract: a throw means the row was not persisted), so the
      // seq stays put and the rollback marker can reuse it without a log gap.
      this.#register({ runId, documentId, transactionId, revisionBefore, seq }, false);
      return transactionErr("wal_append_failed", appended.message, {
        hint:
          "The engine transaction opened but its begin marker is not durable; roll the " +
          "run back (§5.6).",
        retryable: false,
      });
    }

    this.#register({ runId, documentId, transactionId, revisionBefore, seq }, true);
    return transactionOk({ transactionId, revisionBefore, seq });
  }

  /**
   * Append one executed mutating command to the command log (§5.6). The revision echo
   * from the engine reply is validated against the chain: a gap or a rewind is a typed
   * error and the run must roll back. Queries are never tracked.
   */
  async trackCommand(cmd: TrackedCommand): Promise<TransactionResult<TrackOutcome>> {
    if (typeof cmd.runId !== "string" || cmd.runId.trim().length === 0) {
      return transactionErr("transaction_invalid_input", "The tracked command needs a run id");
    }
    const txn = this.#runs.get(cmd.runId);
    if (txn === undefined) {
      return transactionErr("transaction_not_open", "The run has no transaction", {
        hint: "agent.begin must precede the first mutating command (§5.6).",
      });
    }
    if (txn.state !== "open") {
      return transactionErr("transaction_not_open", `The run's transaction is already ${txn.state}`, {
        hint: "Commands are tracked only while the transaction is open (§5.6).",
      });
    }
    if (typeof cmd.commandName !== "string" || cmd.commandName.trim().length === 0) {
      return transactionErr("transaction_invalid_input", "The tracked command needs a name");
    }
    if (cmd.commandName.startsWith("agent.")) {
      return transactionErr(
        "transaction_invalid_input",
        "Transaction lifecycle commands are never tracked",
        { hint: "begin/commit/rollback own their own WAL rows (§5.6)." },
      );
    }
    if (!isRecord(cmd.params)) {
      return transactionErr(
        "transaction_invalid_input",
        "The tracked command params must be an object",
      );
    }
    if (!Number.isInteger(cmd.revisionAfter) || cmd.revisionAfter < 0) {
      return transactionErr(
        "transaction_invalid_input",
        "The echoed document revision must be a non-negative integer",
      );
    }
    const cap = this.#options.maxMutatingCommandsPerRun;
    if (cap !== undefined && txn.commandCount >= cap) {
      return transactionErr(
        "mutating_command_cap_exceeded",
        `The run reached its mutating-command cap (${cap})`,
        {
          hint: "§5.7 caps total mutating commands per run; commit or roll back now.",
          retryable: false,
        },
      );
    }

    const revisionBefore = txn.lastRevision;
    if (cmd.revisionAfter <= revisionBefore) {
      return transactionErr(
        "wal_monotonicity_violation",
        `The command '${cmd.commandName}' did not advance the document revision ` +
          `(${revisionBefore} → ${cmd.revisionAfter})`,
        {
          hint:
            "Every logged command advances the revision by exactly one (§5.6); " +
            "queries are never tracked.",
        },
      );
    }
    if (cmd.revisionAfter > revisionBefore + 1) {
      return transactionErr(
        "wal_gap_detected",
        `Revision gap after '${cmd.commandName}': the engine reported revision ` +
          `${cmd.revisionAfter}, but the command log chain expects ${revisionBefore + 1}`,
        { hint: ROLLBACK_AFTER_GAP_HINT },
      );
    }

    const seq = txn.nextSeq;
    const appended = await this.#append({
      documentId: txn.documentId,
      seq,
      commandName: cmd.commandName,
      params: cmd.params,
      revisionBefore,
      revisionAfter: cmd.revisionAfter,
    });
    if (!appended.ok) {
      return transactionErr("wal_append_failed", appended.message, {
        hint:
          "Durability failed before the row landed; roll the run back before doing " +
          "anything else (§5.6).",
        retryable: true,
      });
    }
    txn.nextSeq = seq + 1;
    txn.lastSeq = seq;
    txn.lastRevision = cmd.revisionAfter;
    txn.commandCount += 1;
    return transactionOk({ seq, revisionBefore, revisionAfter: cmd.revisionAfter });
  }

  /**
   * Finalization (§3.3 step 6): `agent.commit` folds the run into ONE undoable entry,
   * the engine saves the .pcraft, storage receives it at the documents key, and the
   * durable checkpoint row records the new replay base. Durability failures after the
   * engine commit return `checkpoint_write_failed` (retryable) — the caller retries
   * the durable writes, never the commit.
   */
  async commit(runId: string): Promise<TransactionResult<CommitOutcome>> {
    const txn = this.#runInState(runId, "agent.commit");
    if (!txn.ok) {
      return txn;
    }
    const run = txn.value;

    const call = await this.#executeTx("agent.commit", {});
    if (!call.ok) {
      if (call.engineCode !== undefined && isClosedEngineCode(call.engineCode)) {
        // The engine transaction is gone; nothing can close it from here.
        run.state = "aborted";
        this.#releaseDocument(run);
      }
      return call.failure;
    }
    const parsed = AGENT_COMMIT_REPLY_SCHEMA.safeParse(call.result);
    if (!parsed.success) {
      run.state = "committed";
      this.#releaseDocument(run);
      return transactionErr(
        "engine_reply_invalid",
        "The engine reply to agent.commit failed schema validation",
        { hint: `${REPLY_SHAPE_HINT} The engine transaction is closed.` },
      );
    }
    const { transaction_id: transactionId, revision_before: revisionBefore } = parsed.data;
    const revisionAfter = parsed.data.revision_after;

    // The engine closed its side from here on — mark it before validating anything else.
    run.state = "committed";
    this.#releaseDocument(run);

    if (transactionId !== run.transactionId || revisionBefore !== run.revisionBefore) {
      return transactionErr(
        "engine_reply_invalid",
        "The engine closed a different transaction than this run's",
        {
          hint: "The engine transaction is closed; reconcile the document from its " +
            "checkpoint (§5.6).",
        },
      );
    }
    // The fold bumps the revision by exactly one; a nil run bumps by zero (or by one
    // when it cleared redo). Anything outside that envelope means the log under-tracks
    // the document — refuse to write a checkpoint that replay cannot reproduce.
    if (revisionAfter < run.lastRevision || revisionAfter > run.lastRevision + 1) {
      return transactionErr(
        revisionAfter > run.lastRevision + 1 ? "wal_gap_detected" : "wal_monotonicity_violation",
        `agent.commit reported revision ${revisionAfter}, which breaks the command log chain ` +
          `(last tracked revision ${run.lastRevision})`,
        { hint: NO_RECOMMIT_HINT },
      );
    }

    const save = await this.#savePcraft();
    if (!save.ok) {
      return save;
    }
    const storageKey = this.#storageKeyFor(run.documentId, revisionAfter);
    const stored = await this.#putBytes(storageKey, save.bytes);
    if (!stored.ok) {
      return stored;
    }
    const checkpointed = await this.#saveCheckpoint({
      documentId: run.documentId,
      runId,
      seq: run.lastSeq,
      revision: revisionAfter,
      storageKey,
      checkpointRef: { engineSnapshotId: run.transactionId },
    });
    if (!checkpointed.ok) {
      return checkpointed;
    }

    return transactionOk({
      transactionId,
      revisionBefore,
      revisionAfter,
      commandCount: run.commandCount,
      storageKey,
      checkpoint: { seq: run.lastSeq, revision: revisionAfter },
    });
  }

  /**
   * `agent.rollback` (§5.6): restore the checkpoint content, keep every WAL row and
   * append one `agent.rollback` marker row flagged `rolled_back` — history is marked,
   * never deleted. The marker carries the engine reply's revisions verbatim (see the
   * header contract). This is also the §3.4 cancel path ("cancel, rollback, refund").
   */
  async rollback(runId: string): Promise<TransactionResult<RollbackOutcome>> {
    const txn = this.#runInState(runId, "agent.rollback");
    if (!txn.ok) {
      return txn;
    }
    const run = txn.value;

    const call = await this.#executeTx("agent.rollback", {});
    if (!call.ok) {
      if (call.engineCode !== undefined && isClosedEngineCode(call.engineCode)) {
        run.state = "aborted";
        this.#releaseDocument(run);
      }
      return call.failure;
    }
    const parsed = AGENT_ROLLBACK_REPLY_SCHEMA.safeParse(call.result);
    if (!parsed.success) {
      run.state = "rolled_back";
      this.#releaseDocument(run);
      return transactionErr(
        "engine_reply_invalid",
        "The engine reply to agent.rollback failed schema validation",
        { hint: `${REPLY_SHAPE_HINT} Write the rolled_back marker before replay (§5.6).` },
      );
    }
    const { transaction_id: transactionId, revision_before: revisionBefore } = parsed.data;
    const revisionAfter = parsed.data.revision_after;
    const restored = parsed.data.restored;

    // The engine restored the document on any ok reply — the run is closed. The
    // revision envelope is deliberately lenient here (climb ≥ checkpoint only): after
    // a detected gap our lastRevision is stale, and the rollback must still succeed —
    // the content is pre-run either way (§5.6).
    run.state = "rolled_back";
    this.#releaseDocument(run);

    if (transactionId !== run.transactionId || revisionBefore !== run.revisionBefore) {
      return transactionErr(
        "engine_reply_invalid",
        "The engine closed a different transaction than this run's",
        {
          hint: "The document is restored; write the rolled_back marker before replay (§5.6).",
        },
      );
    }

    const seq = run.nextSeq;
    const appended = await this.#append({
      documentId: run.documentId,
      seq,
      commandName: "agent.rollback",
      params: {},
      revisionBefore,
      revisionAfter,
      flag: "rolled_back",
    });
    if (!appended.ok) {
      return transactionErr("wal_append_failed", appended.message, {
        hint:
          "The document is restored but the rolled_back marker is not durable; write it " +
          "before any replay on this document (§5.6).",
        retryable: true,
      });
    }
    run.nextSeq = seq + 1;
    run.lastSeq = seq;

    return transactionOk({
      transactionId,
      revisionBefore,
      revisionAfter,
      restored,
      commandCount: run.commandCount,
      markerSeq: seq,
    });
  }

  // --- internals -----------------------------------------------------------

  #register(
    input: {
      runId: string;
      documentId: string;
      transactionId: number;
      revisionBefore: number;
      seq: number;
    },
    markerDurable: boolean,
  ): void {
    const txn: RunTransaction = {
      runId: input.runId,
      documentId: input.documentId,
      transactionId: input.transactionId,
      revisionBefore: input.revisionBefore,
      lastRevision: input.revisionBefore,
      nextSeq: markerDurable ? input.seq + 1 : input.seq,
      lastSeq: input.seq,
      commandCount: 0,
      state: "open",
    };
    this.#runs.set(input.runId, txn);
    this.#openByDocument.set(input.documentId, input.runId);
    if (markerDurable) {
      this.#docNextSeq.set(input.documentId, input.seq + 1);
    }
  }

  #releaseDocument(txn: RunTransaction): void {
    if (this.#openByDocument.get(txn.documentId) === txn.runId) {
      this.#openByDocument.delete(txn.documentId);
    }
  }

  #runInState(runId: string, command: AgentTxCommand): TransactionResult<RunTransaction> {
    if (typeof runId !== "string" || runId.trim().length === 0) {
      return transactionErr("transaction_invalid_input", `${command} needs a run id`);
    }
    const txn = this.#runs.get(runId);
    if (txn === undefined) {
      return transactionErr("transaction_not_open", "The run has no transaction", {
        hint: `Call agent.begin before ${command} (§5.6).`,
      });
    }
    if (txn.state !== "open") {
      return transactionErr("transaction_not_open", `The run's transaction is already ${txn.state}`, {
        hint: `A ${txn.state} transaction never reopens; ${command} is refused (§5.6).`,
      });
    }
    return transactionOk(txn);
  }

  /**
   * One engine.execute for a transaction command. Seam throws are mapped to typed
   * failures; the engine refusal code is surfaced so callers can update bookkeeping
   * (closed codes mean the engine transaction is gone for good).
   */
  async #executeTx(
    command: AgentTxCommand,
    params: Readonly<Record<string, unknown>>,
  ): Promise<
    | { readonly ok: true; readonly result: Readonly<Record<string, unknown>> }
    | {
        readonly ok: false;
        readonly failure: TransactionResult<never>;
        readonly engineCode: string | undefined;
      }
  > {
    let reply: Awaited<ReturnType<EngineTxLike["execute"]>>;
    try {
      reply = await this.#options.engine.execute(command, params);
    } catch {
      return {
        ok: false,
        engineCode: undefined,
        failure: transactionErr(
          "engine_command_failed",
          `The ${command} call failed unexpectedly`,
          {
            hint: "The engine seam threw instead of returning a typed reply (§3.2/§13.3).",
            retryable: true,
          },
        ),
      };
    }
    if (!reply.ok) {
      return {
        ok: false,
        engineCode: reply.code,
        failure: transactionErr(
          "engine_command_failed",
          `The engine refused ${command} (${reply.code})`,
          {
            hint: reply.message,
            retryable: reply.retryable ?? reply.code === ENGINE_TX_BUSY_CODE,
          },
        ),
      };
    }
    return { ok: true, result: reply.result };
  }

  /** Append one row through the WAL seam; never advances seq counters on failure. */
  async #append(input: WalAppendInput): Promise<TransactionResult<true>> {
    try {
      await this.#options.wal.append(input);
    } catch {
      return transactionErr("wal_append_failed", "The command log refused the append");
    }
    this.#docNextSeq.set(input.documentId, input.seq + 1);
    return transactionOk(true);
  }

  async #savePcraft(): Promise<TransactionResult<{ readonly bytes: Uint8Array }>> {
    let reply: Awaited<ReturnType<EngineTxLike["save"]>>;
    try {
      reply = await this.#options.engine.save();
    } catch {
      return transactionErr(
        "checkpoint_write_failed",
        "The committed document could not be saved to .pcraft",
        { hint: NO_RECOMMIT_HINT, retryable: true },
      );
    }
    if (!reply.ok) {
      return transactionErr(
        "checkpoint_write_failed",
        "The engine refused doc.save for the committed document",
        { hint: reply.message, retryable: true },
      );
    }
    return transactionOk({ bytes: reply.result.bytes });
  }

  async #putBytes(storageKey: string, bytes: Uint8Array): Promise<TransactionResult<true>> {
    try {
      await this.#options.storage.put(storageKey, bytes);
    } catch {
      return transactionErr(
        "checkpoint_write_failed",
        "The .pcraft could not be written to object storage",
        { hint: NO_RECOMMIT_HINT, retryable: true },
      );
    }
    return transactionOk(true);
  }

  async #saveCheckpoint(input: CheckpointInput): Promise<TransactionResult<true>> {
    try {
      await this.#options.checkpoint.save(input);
    } catch {
      return transactionErr("checkpoint_write_failed", "The checkpoint row could not be saved", {
        hint: `${NO_RECOMMIT_HINT} The .pcraft is already durable at its storage key.`,
        retryable: true,
      });
    }
    return transactionOk(true);
  }
}

function isClosedEngineCode(code: string): boolean {
  return (ENGINE_TX_CLOSED_CODES as readonly string[]).includes(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
