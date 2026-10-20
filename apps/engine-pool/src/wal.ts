// @studio/engine-pool — WalCursor: the replay model over the `commands` table (§5.6).
//
// The command log IS the write-ahead log: after an engine crash the worker replays
// commands from the last checkpoint (§3.2, §3.4). This module owns the pure cursor
// algebra — slicing and verification, no I/O. Log access is behind the injected
// `WalProvider` seam (the real implementation reads packages/db `commands`).
//
// WAL contract enforced here (built on packages/db/src/schema/content.ts):
//   - `seq` is the 1-based per-document position; unique(document_id, seq) gives
//     the strict total order for replay.
//   - Only replayable commands appear in a replay slice: successful mutating
//     commands (result non-null). Failed commands are audited via agent_steps and
//     are never replayed (§5.6).
//   - Every replayed command advances the document revision by exactly one and
//     chains with its neighbour (§5.6 "monotonic counters"), so the revision counts
//     applied commands: a checkpoint at revision R has durably captured seq 1..R,
//     and replay for that checkpoint is seq R+1..totalSeq.
//   - Any deviation — a gap, a rewind, a mismatch against the checkpoint — is a
//     typed error. Recovery fails clean; it NEVER silently skips commands.

/** A position in the command log: the durable checkpoint (§3.3 step 7). */
export interface WalCursor {
  readonly documentId: string;
  /** Last seq durably captured by the checkpoint; 0 = empty log. */
  readonly seq: number;
  /** Document revision at that seq (== `seq` under the WAL contract above). */
  readonly revision: number;
}

/** A contiguous run of logged commands to replay (§5.6). */
export interface WalSlice {
  readonly documentId: string;
  /** First seq to replay, inclusive; `toSeq + 1` when the slice is empty. */
  readonly fromSeq: number;
  /** Last seq to replay, inclusive; `fromSeq - 1` when the slice is empty. */
  readonly toSeq: number;
}

/** One replayable command row (the `commands` table contract, packages/db). */
export interface WalEntry {
  readonly documentId: string;
  readonly seq: number;
  readonly commandName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
}

export type WalErrorCode =
  | "wal_invalid_input"
  | "wal_gap_detected"
  | "wal_monotonicity_violation"
  | "wal_slice_mismatch";

/** Typed result envelope (§4 conventions); WAL verification is never retryable. */
export interface WalError {
  readonly ok: false;
  readonly code: WalErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: false;
}

export type WalSliceResult = { readonly ok: true; readonly slice: WalSlice } | WalError;

export type WalVerifyResult = { readonly ok: true } | WalError;

/**
 * Injected read access to the command log. The real implementation reads
 * packages/db `commands` ordered by seq and filters to replayable rows.
 */
export interface WalProvider {
  /** Seq of the newest logged command for the document (0 when the log is empty). */
  totalSeq(documentId: string): Promise<number>;
  /** Read the slice [fromSeq, toSeq] ascending; must return only replayable rows. */
  readSlice(slice: WalSlice): Promise<readonly WalEntry[]>;
}

const INVALID_SLICE_HINT =
  "The WAL cursor and the command log are inconsistent; refuse to replay rather than skip commands (§5.6).";

function walError(
  code: WalErrorCode,
  message: string,
  hint: string = INVALID_SLICE_HINT,
): WalError {
  return { ok: false, code, message, hint, retryable: false };
}

const WAL_OK: WalVerifyResult = { ok: true };

/**
 * Compute the replay slice after a durable checkpoint (§5.6).
 *
 * The pure core is the (fromRevision, totalSeq) → seq-bounds mapping: a checkpoint
 * at revision R captured seq 1..R, so replay covers seq R+1..totalSeq. When the
 * checkpoint is at the log head the slice is empty (`fromSeq = toSeq + 1`).
 */
export function sliceForReplay(
  documentId: string,
  fromRevision: number,
  totalSeq: number,
): WalSliceResult {
  if (documentId.length === 0) {
    return walError("wal_invalid_input", "WAL slice requested without a document");
  }
  if (!Number.isInteger(fromRevision) || fromRevision < 0) {
    return walError("wal_invalid_input", `Invalid checkpoint revision ${fromRevision}`);
  }
  if (!Number.isInteger(totalSeq) || totalSeq < 0) {
    return walError("wal_invalid_input", `Invalid WAL length ${totalSeq}`);
  }
  if (fromRevision > totalSeq) {
    return walError(
      "wal_slice_mismatch",
      `Checkpoint revision ${fromRevision} is ahead of the command log (length ${totalSeq})`,
    );
  }
  return {
    ok: true,
    slice: { documentId, fromSeq: fromRevision + 1, toSeq: totalSeq },
  };
}

/** Number of commands a slice covers (0 for an empty slice). */
export function sliceCount(slice: WalSlice): number {
  return Math.max(0, slice.toSeq - slice.fromSeq + 1);
}

/**
 * Verify that entries form one contiguous seq run (never silently skip, §5.6).
 * Any missing or repeated position inside the returned batch is a gap error.
 */
export function verifyContiguity(entries: readonly WalEntry[]): WalVerifyResult {
  const first = entries.at(0);
  if (first === undefined) return WAL_OK;
  let expected = first.seq;
  for (const entry of entries) {
    if (entry.seq !== expected) {
      return walError(
        "wal_gap_detected",
        `Command-log gap: expected seq ${expected}, found seq ${entry.seq} — a replay slice must be contiguous`,
        "Fetch the missing rows or fail the run clean; replaying past a gap would corrupt the document.",
      );
    }
    expected += 1;
  }
  return WAL_OK;
}

/**
 * Verify the §5.6 monotonic revision counters: every replayed command advances the
 * revision by exactly one and chains with its predecessor. A rewind or a skip means
 * the log does not describe a linear history — refuse it.
 */
export function verifyMonotonicRevisions(entries: readonly WalEntry[]): WalVerifyResult {
  let previous: WalEntry | undefined;
  for (const entry of entries) {
    if (entry.revisionAfter !== entry.revisionBefore + 1) {
      return walError(
        "wal_monotonicity_violation",
        `Revision counter must advance by exactly one per replayed command (seq ${entry.seq}: ${entry.revisionBefore}→${entry.revisionAfter})`,
        "The log is not a linear mutating history; refuse to replay it (§5.6).",
      );
    }
    if (previous !== undefined && entry.revisionBefore !== previous.revisionAfter) {
      return walError(
        "wal_monotonicity_violation",
        `Revision chain broken between seq ${previous.seq} (→${previous.revisionAfter}) and seq ${entry.seq} (from ${entry.revisionBefore})`,
        "A command was lost or inserted between the two entries; refuse to replay (§5.6).",
      );
    }
    previous = entry;
  }
  return WAL_OK;
}

export interface ReplaySliceVerification {
  /** The slice the entries were fetched for. */
  readonly slice: WalSlice;
  /** The fetched entries, in the order the provider returned them. */
  readonly entries: readonly WalEntry[];
  /** Revision of the durable checkpoint the slice replays from. */
  readonly checkpointRevision: number;
}

/**
 * Full pre-replay verification: entries must cover the slice exactly — right count,
 * right bounds, no gaps, monotonic chained revisions — and must pick up exactly
 * where the checkpoint left off. This is the last gate before any command is
 * applied to a fresh engine session; a failure here means recovery fails clean.
 */
export function verifyReplaySlice(input: ReplaySliceVerification): WalVerifyResult {
  const { slice, entries, checkpointRevision } = input;
  if (slice.fromSeq < 1 || slice.toSeq < slice.fromSeq - 1) {
    return walError(
      "wal_invalid_input",
      `Malformed WAL slice (seq ${slice.fromSeq}..${slice.toSeq})`,
    );
  }
  for (const entry of entries) {
    if (entry.documentId !== slice.documentId) {
      return walError(
        "wal_slice_mismatch",
        "A WAL entry in the slice belongs to a different document",
      );
    }
  }
  const expected = sliceCount(slice);
  const first = entries.at(0);
  if (first === undefined) {
    if (expected === 0) return WAL_OK;
    return walError(
      "wal_gap_detected",
      `Replay slice requires ${expected} command(s) (seq ${slice.fromSeq}..${slice.toSeq}), but the command log returned none`,
    );
  }
  const last = entries.at(-1);
  if (last === undefined) return WAL_OK; // unreachable (first is defined), keeps narrowing total
  if (first.seq < slice.fromSeq) {
    return walError(
      "wal_slice_mismatch",
      `WAL returned seq ${first.seq}, which precedes the slice start ${slice.fromSeq}`,
    );
  }
  if (first.seq > slice.fromSeq) {
    return walError(
      "wal_gap_detected",
      `Head gap: the slice starts at seq ${slice.fromSeq} but the command log starts at seq ${first.seq}`,
    );
  }
  if (last.seq > slice.toSeq) {
    return walError(
      "wal_slice_mismatch",
      `WAL returned seq ${last.seq}, which is past the slice end ${slice.toSeq}`,
    );
  }
  if (last.seq < slice.toSeq) {
    return walError(
      "wal_gap_detected",
      `Tail gap: the slice ends at seq ${slice.toSeq} but the command log stops at seq ${last.seq}`,
    );
  }
  const contiguous = verifyContiguity(entries);
  if (!contiguous.ok) return contiguous;
  const monotonic = verifyMonotonicRevisions(entries);
  if (!monotonic.ok) return monotonic;
  if (first.revisionBefore !== checkpointRevision) {
    return walError(
      "wal_slice_mismatch",
      `The checkpoint (revision ${checkpointRevision}) does not immediately precede the slice — its first command starts at revision ${first.revisionBefore}`,
    );
  }
  return WAL_OK;
}
