// @studio/gateway — manual command execution service (§13.1 commands/undo/redo,
// §13.4 the public API is the agent API, §5.6 command-log WAL, §6.1 compact-reply
// rule, §25-5 manual surface ≠ agent transaction surface). Owner: W4-K.
//
// Spec anchors:
//   §13.1 POST /v1/documents/:id/commands — "Manual command execution (the same
//          allowlist as tools; for the UI and API users)"; POST /:id/undo and
//          /:id/redo — "One step (agent runs undo as one step)".
//   §13.4 everything the agent does goes through this same commands surface;
//          manual rows land in the WAL with run_id NULL (schema/content.ts).
//   §5.6   the `commands` table IS the WAL: one row per executed engine command,
//          appended only, seq is the strict per-document order for replay;
//          revision_before/after are the monotonic counters every command carries.
//   §6.1   results mirror what the user needs next — { summary, warnings,
//          revision }, never a raw engine dump (§25-11 token discipline).
//   §25-5  raw engine commands are allowlisted + authorized; agent-transaction
//          control (agent.begin/commit/rollback) and tool-compiled composites
//          (template.fill) never cross onto the manual surface.
//   §3.4   idempotency: the same key never double-applies a mutating command
//          ("edits are never automatically resent"); replay is recorded once.
//   §12.2  every query is composite (org + id); a foreign document id is a 404.
//
// SEAMS (all injectable; HTTP mapping lives in routes/commands.ts):
//   EngineLike / EngineSessionLike — one live engine session attached to an
//          open document (the worker-attached session). @studio/engine-client is
//          NOT a gateway dependency (W2-G/W4-F fleet precedent for local
//          structural mirrors — services/documents.ts header), so the session
//          contract is mirrored here: a real worker-side adapter satisfies it
//          structurally. §25-4: one session, one tenant — never shared.
//   SessionResolver — { getSession(documentId) } returns the attached session
//          or null; null maps to the typed engine_session_unavailable error.
//   CommandsStore — §12.2 composite document lookup + the §5.6 WAL append
//          (seq assigned atomically; the drizzle impl also advances the
//          documents.current_revision pointer in the same transaction).
//   IdempotencyStore — claim/complete over the §12.1 idempotency_keys table
//          (unique(key, scope) is the §3.4 backstop under concurrency).
//   allowlist — REQUIRED_ENGINE_COMMANDS (packages/engine-client/src/commands.ts,
//          §2.2 registry-verified list; "the same allowlist as tools"). Injected
//          by the composition root because @studio/engine-client is not a
//          gateway dependency: the wiring wave passes REQUIRED_ENGINE_COMMANDS
//          (or re-exports it) — NEVER a hand-copied list (§2.2: the live
//          registry stays authoritative; ids are never hardcoded blindly).

import type { ErrorCode } from "@studio/config";
import {
  commands,
  documents,
  idempotencyKeys,
  type CommandLogEntry,
  type Db,
} from "@studio/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "./runs.js";

// ---------------------------------------------------------------------------
// Policy constants (single values, cited; §13.3 discipline)
// ---------------------------------------------------------------------------

/** Engine command ids are short dotted identifiers (registry-verified, §2.2). */
export const MAX_COMMAND_ID_LENGTH = 200;

/**
 * Compact-command budget: the serialized params a manual command may carry.
 * Commands are single, surgical operations — not scene-graph transport
 * (§25-11 token discipline; route-level Zod enforces the same cap).
 */
export const MAX_COMMAND_PARAMS_BYTES = 16 * 1024;

/** Upper bound on distinct param keys (defense against key-count DoS). */
export const MAX_COMMAND_PARAM_KEYS = 64;

/** §13.1: undo/redo are ONE step each; the WAL row records that intent. */
export const UNDO_COMMAND = "edit.undo";
export const REDO_COMMAND = "edit.redo";
/** WAL params for the one-step undo/redo rows (the engine command takes none). */
export const UNDO_WAL_PARAMS: Readonly<Record<string, unknown>> = { steps: 1 };
export const REDO_WAL_PARAMS: Readonly<Record<string, unknown>> = { steps: 1 };

/**
 * §3.4 idempotency scope for the manual command surface. One logical class:
 * "one manual engine command executed against one document" (commands, undo
 * and redo share it; the client-generated key distinguishes operations).
 */
export const MANUAL_COMMAND_IDEMPOTENCY_SCOPE = "documents:manual-command";

// ---------------------------------------------------------------------------
// Failure surface — fleet envelope shape (docs/AGENTS.md), self-contained like
// packages/engine-client/src/commands.ts CommandsFailure: structurally
// compatible with @studio/config Failure, plus this surface's own codes.
// ---------------------------------------------------------------------------

/** Commands-surface error codes. Add-only, stable strings (§13.3 discipline). */
export const COMMAND_EXEC_ERROR_CODES = [
  /** The command id is not on the manual allowlist (§13.1/§25-5). */
  "command_not_allowlisted",
  /** No engine session is attached to the document — open it first (§13.1). */
  "engine_session_unavailable",
  /** The engine refused the command (bad params) — a compile error (§6.3). */
  "engine_command_failed",
] as const satisfies readonly string[];

export type CommandExecLocalCode = (typeof COMMAND_EXEC_ERROR_CODES)[number];

/** Any failure code this surface can produce (catalog + local codes). */
export type CommandExecErrorCode = ErrorCode | CommandExecLocalCode;

/** Typed failure envelope; superset-compatible with @studio/config Failure. */
export interface CommandExecFailure {
  readonly ok: false;
  readonly code: CommandExecErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

export type CommandExecResult<T> = { readonly ok: true; readonly value: T } | CommandExecFailure;

/** Builds a local-code failure envelope. */
function localFailure(
  code: CommandExecLocalCode,
  message: string,
  options: { readonly hint?: string; readonly retryable?: boolean } = {},
): CommandExecFailure {
  return {
    ok: false,
    code,
    message,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    retryable: options.retryable ?? false,
  };
}

/** Builds a catalog-code failure envelope with a concrete retryable value. */
function catalogFailure(
  code: ErrorCode,
  message: string,
  options: { readonly hint?: string; readonly retryable?: boolean } = {},
): CommandExecFailure {
  return {
    ok: false,
    code,
    message,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    retryable: options.retryable ?? false,
  };
}

// ---------------------------------------------------------------------------
// §25-5 rejection reasons — why known agent-internal ids are refused
// ---------------------------------------------------------------------------

/**
 * The §25-5 reasons a known agent-internal or composite id is refused on the
 * manual surface. Every id here is ALSO simply absent from
 * REQUIRED_ENGINE_COMMANDS (§2.2) — the allowlist is the gate; this table only
 * upgrades the hint so the error says WHY (manual surface ≠ agent transaction
 * surface), per the W4-K contract. engine-patches §2.3 ids (agent.*,
 * template.*, component.*, layout.*) are likewise not manual-surface ids.
 */
export const COMMAND_REJECTION_REASONS: Readonly<Record<string, string>> = {
  "agent.begin":
    "Agent transaction control is internal to run execution (§5.6); the manual surface is not the agent transaction surface (§25-5). Open a run to edit inside a transaction.",
  "agent.commit":
    "Agent transaction control is internal to run execution (§5.6); the manual surface is not the agent transaction surface (§25-5). Open a run to edit inside a transaction.",
  "agent.rollback":
    "Agent transaction control is internal to run execution (§5.6); the manual surface is not the agent transaction surface (§25-5). Open a run to edit inside a transaction.",
  "template.fill":
    "template.fill is a composite compiled by the template_fill tool into allowlisted primitives (§6); fill slots through the tool or issue the individual commands.",
  batch:
    "Engine-level batch orchestration is a transport method, not a command (§25-5); send one allowlisted command per call.",
};

/** The §25-5 reason for a known-rejected id, when one is recorded. */
export function rejectionReasonFor(command: string): string | undefined {
  return COMMAND_REJECTION_REASONS[command];
}

// ---------------------------------------------------------------------------
// Engine session seam — the worker-attached session (structural mirror)
// ---------------------------------------------------------------------------

/** One command execution request handed to the session. */
export interface EngineCommandRequest {
  /** Registry-verified engine command id (§2.2). */
  readonly command: string;
  /** Command params: a JSON object, never an array/scalar (rpc.rs engine.execute). */
  readonly params: Record<string, unknown>;
}

/**
 * One executed command's reply: the §5.6 monotonic revision counters carried
 * by every command, plus the command's own opaque result object (or null when
 * it produces none). The worker-attached session adapter derives these from
 * the engine exchange (e.g. `session.list` revision + the engine.execute reply).
 */
export interface EngineCommandReply {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly result: Record<string, unknown> | null;
}

/** Failure codes the session seam can report (transport/refusal classes). */
export const ENGINE_SESSION_ERROR_CODES = [
  "engine_command_failed",
  "engine_timeout",
  "engine_unavailable",
  "engine_crashed",
] as const satisfies readonly string[];

export type EngineSessionErrorCode = (typeof ENGINE_SESSION_ERROR_CODES)[number];

/** The session's typed outcome for one executed command (never throws). */
export type EngineExecution =
  | { readonly ok: true; readonly reply: EngineCommandReply }
  | {
      readonly ok: false;
      readonly code: EngineSessionErrorCode;
      readonly message: string;
      readonly hint?: string;
      readonly retryable: boolean;
    };

/**
 * A live engine session attached to one open document — the worker-attached
 * session (§25-4: one session, one tenant; sessions are never shared across
 * tenants). A @studio/engine-client-backed worker adapter satisfies this
 * structurally (execute → engine.execute {command, params}).
 */
export interface EngineLike {
  execute(request: EngineCommandRequest): Promise<EngineExecution>;
}

/** Alias naming the seam's role (W4-K task contract vocabulary). */
export type EngineSessionLike = EngineLike;

/**
 * Resolves the session attached to `documentId`, or null when no document is
 * open. Callers MUST verify the document belongs to their organization FIRST
 * (§12.2 composite lookup) — the resolver itself is tenant-trusted, being
 * keyed by an already-scoped document id.
 */
export interface SessionResolver {
  getSession(documentId: string): Promise<EngineLike | null>;
}

// ---------------------------------------------------------------------------
// Command store seam — §12.2 document lookup + §5.6 WAL append
// ---------------------------------------------------------------------------

/** What the executor needs to know about the document row (§12.2 scoping). */
export interface CommandDocumentRef {
  /** §12.2 soft archive — archived documents are read-only. */
  readonly archived: boolean;
}

/** One WAL append; the store assigns id + seq atomically (strict order, §5.6). */
export interface CommandWalAppend {
  readonly documentId: string;
  readonly organizationId: string;
  /** run_id is NULL for manual/API commands (§13.4). */
  readonly runId: null;
  readonly commandName: string;
  readonly params: Record<string, unknown>;
  /** The §6.1 result summary record — never a raw engine dump. */
  readonly result: Record<string, unknown>;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
}

/** Typed queries over documents + the command log (§12.2 composite scoping). */
export interface CommandsStore {
  /**
   * Composite (org + document) lookup, §12.2: a foreign or unknown id resolves
   * to null — lookups stay 404, never find-then-check.
   */
  findDocument(
    organizationId: string,
    documentId: string,
  ): Promise<CommandDocumentRef | null>;
  /**
   * Appends one §5.6 WAL row with the NEXT per-document seq and advances
   * documents.current_revision to revisionAfter (the schema contract: "the
   * monotonic counter advanced by every committed mutating command") in ONE
   * transaction. Implementations MAY throw (e.g. unique(document_id, seq) under
   * a concurrent race); the executor maps any throw to a typed storage_error.
   */
  appendCommand(row: CommandWalAppend): Promise<CommandLogEntry>;
}

/**
 * Drizzle-backed CommandsStore (production). The seq assignment runs inside
 * the same transaction as the insert + the pointer bump, and the
 * unique(document_id, seq) index (W1-D) is the strict-order backstop.
 */
export function drizzleCommandsStore(db: Db): CommandsStore {
  return {
    async findDocument(organizationId, documentId) {
      const rows = await db
        .select({ archivedAt: documents.archivedAt })
        .from(documents)
        .where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : { archived: row.archivedAt !== null };
    },

    async appendCommand(row) {
      return db.transaction(async (tx) => {
        const maxRows = await tx
          .select({ maxSeq: sql`max(${commands.seq})`.mapWith(Number) })
          .from(commands)
          .where(eq(commands.documentId, row.documentId));
        const nextSeq = (maxRows[0]?.maxSeq ?? 0) + 1;
        const inserted = await tx
          .insert(commands)
          .values({
            documentId: row.documentId,
            organizationId: row.organizationId,
            runId: row.runId,
            seq: nextSeq,
            commandName: row.commandName,
            params: row.params,
            result: row.result,
            revisionBefore: row.revisionBefore,
            revisionAfter: row.revisionAfter,
          })
          .returning();
        const entry = inserted[0];
        if (entry === undefined) {
          throw new Error("commands WAL insert returned no row");
        }
        await tx
          .update(documents)
          .set({ currentRevision: row.revisionAfter })
          .where(
            and(
              eq(documents.organizationId, row.organizationId),
              eq(documents.id, row.documentId),
            ),
          );
        return entry;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Idempotency seam — §3.4 replay over the idempotency_keys table (§12.1)
// ---------------------------------------------------------------------------

/** Result of probing one (key, scope) pair. */
export type IdempotencyLookup =
  | { readonly status: "new" }
  /** A claim exists but has no recorded outcome yet (a request is in flight). */
  | { readonly status: "open" }
  /** (key, scope) is taken by another organization — never replayed across tenants (§15). */
  | { readonly status: "foreign" }
  /** A completed outcome exists: `result` replays to safe retries (§3.4). */
  | { readonly status: "completed"; readonly result: Record<string, unknown> };

/**
 * Claim/complete protocol over idempotency_keys (§12.1): claim() inserts the
 * open row and MUST return false when unique(key, scope) rejects a duplicate —
 * that index is the §3.4 backstop under concurrency; complete() stamps the
 * outcome. Once an engine exchange happened (success OR failure), the claim is
 * completed, never released: a mutating command must never re-execute under
 * the same key ("edits are never automatically resent", §3.4).
 */
export interface IdempotencyStore {
  lookup(key: string, scope: string, organizationId: string): Promise<IdempotencyLookup>;
  /** True when this caller now owns the claim; false when (key, scope) is taken. */
  claim(key: string, scope: string, organizationId: string): Promise<boolean>;
  /** Stamps the outcome payload on the caller's own claim row. */
  complete(
    key: string,
    scope: string,
    organizationId: string,
    result: Record<string, unknown>,
  ): Promise<void>;
}

/** Drizzle-backed IdempotencyStore (production, §12.1 idempotency_keys). */
export function drizzleIdempotencyStore(db: Db): IdempotencyStore {
  return {
    async lookup(key, scope, organizationId) {
      const rows = await db
        .select({
          organizationId: idempotencyKeys.organizationId,
          result: idempotencyKeys.result,
        })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, scope)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return { status: "new" };
      }
      if (row.organizationId !== organizationId) {
        return { status: "foreign" };
      }
      if (row.result === null) {
        return { status: "open" };
      }
      return { status: "completed", result: row.result };
    },

    async claim(key, scope, organizationId) {
      try {
        await db.insert(idempotencyKeys).values({ key, scope, organizationId, result: null });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // unique(key, scope) — the §3.4 backstop; another request owns it.
          return false;
        }
        throw error;
      }
    },

    async complete(key, scope, organizationId, result) {
      await db
        .update(idempotencyKeys)
        .set({ result })
        .where(
          and(
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.scope, scope),
            eq(idempotencyKeys.organizationId, organizationId),
          ),
        );
    },
  };
}

// ---------------------------------------------------------------------------
// §6.1 compact-reply rule — summarize, never dump
// ---------------------------------------------------------------------------

/** Upper bounds of the compact summary (§6.1/§25-11 token discipline). */
export const MAX_SUMMARY_FIELDS = 6;
export const MAX_SUMMARY_VALUE_LENGTH = 120;
export const MAX_SUMMARY_KEY_LENGTH = 64;
export const MAX_SUMMARY_WARNINGS = 5;
export const MAX_SUMMARY_WARNING_LENGTH = 200;

/** The compact result record: what the WAL row stores and the reply carries. */
export interface CommandResultSummary {
  /** Human one-liner, e.g. `layer.new.layer: layer=3, name="Badge"`. */
  readonly summary: string;
  /** Engine warnings surfaced verbatim (capped + truncated, §5.7 data rule). */
  readonly warnings: readonly string[];
  /** The small scalar projection kept from the engine result (§6.1 mirror). */
  readonly fields: Record<string, unknown>;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Compacts one engine command result per the §6.1 rule ("results mirror what
 * the user needs next, not everything the engine returned"): top-level scalars
 * only (≤ MAX_SUMMARY_FIELDS, each value truncated), arrays as item counts,
 * nested objects dropped entirely — the raw dump never reaches the reply or
 * the WAL row. Pure and total: any junk shape degrades to a terse summary,
 * it never throws.
 */
export function summarizeCommandResult(
  command: string,
  revisionBefore: number,
  revisionAfter: number,
  result: Record<string, unknown> | null,
): CommandResultSummary {
  const fields: Record<string, unknown> = {};
  const parts: string[] = [];
  const warnings: string[] = [];

  if (result !== null && typeof result === "object") {
    for (const [rawKey, rawValue] of Object.entries(result)) {
      if (rawKey === "warnings" && Array.isArray(rawValue)) {
        for (const rawWarning of rawValue.slice(0, MAX_SUMMARY_WARNINGS)) {
          if (typeof rawWarning === "string") {
            warnings.push(truncate(rawWarning, MAX_SUMMARY_WARNING_LENGTH));
          }
        }
        continue;
      }
      if (parts.length >= MAX_SUMMARY_FIELDS) {
        break;
      }
      if (rawKey.length > MAX_SUMMARY_KEY_LENGTH) {
        continue;
      }
      if (typeof rawValue === "string") {
        fields[rawKey] = truncate(rawValue, MAX_SUMMARY_VALUE_LENGTH);
        parts.push(`${rawKey}="${fields[rawKey]}"`);
      } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
        fields[rawKey] = rawValue;
        parts.push(`${rawKey}=${String(rawValue)}`);
      } else if (Array.isArray(rawValue)) {
        parts.push(`${rawKey}=<${rawValue.length} items>`);
      }
      // Nested objects and nulls are dropped — never dumped (§25-11).
    }
  }

  const unchanged = revisionAfter === revisionBefore;
  const head = parts.length > 0 ? `${command}: ${parts.join(", ")}` : `${command} ok`;
  return {
    summary: unchanged ? `${head} (no revision change)` : head,
    warnings,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Execution context + input
// ---------------------------------------------------------------------------

/** §22 logger slice (pino's Logger satisfies this structurally). */
export interface CommandExecLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The per-request execution context: tenant root, actor, §22 correlation. */
export interface CommandExecutionContext {
  /** §12.2 tenant root — scopes every store query. */
  readonly organizationId: string;
  /** §22 actor — the WAL row's provenance (run_id stays null, §13.4). */
  readonly userId: string;
  /** §22 request id — logged with every denial/unavailability. */
  readonly requestId: string;
  /** Optional logger slice; production passes the request-scoped child. */
  readonly logger?: CommandExecLogger;
}

/** One manual command execution request (§13.1). */
export interface ManualCommandInput {
  /** Engine command id — must be on the injected §2.2 allowlist. */
  readonly command: string;
  /** Command params (JSON object, rpc.rs engine.execute). */
  readonly params: Record<string, unknown>;
  /** §13 preamble: required on every mutating endpoint; replay dedupes. */
  readonly idempotencyKey: string;
}

/** The compact §6.1 outcome the routes serialize. */
export interface ExecutedCommand {
  /** WAL position (1-based per document, §5.6). */
  readonly seq: number;
  readonly command: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly summary: string;
  readonly warnings: readonly string[];
  /** True when this response was replayed from the §3.4 idempotency record. */
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Stored outcome schema — the idempotency replay payload is untrusted jsonb
// (§5.7: Zod at every boundary; garbage degrades to internal_error, never
// replays a malformed envelope).
// ---------------------------------------------------------------------------

const STORED_SUCCESS_SCHEMA = z
  .object({
    ok: z.literal(true),
    seq: z.number().int().nonnegative(),
    command: z.string(),
    summary: z.string(),
    warnings: z.array(z.string()),
    revisionBefore: z.number().int().nonnegative(),
    revisionAfter: z.number().int().nonnegative(),
  })
  .strict();

const STORED_FAILURE_SCHEMA = z
  .object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    retryable: z.boolean(),
  })
  .strict();

const STORED_OUTCOME_SCHEMA = z.discriminatedUnion("ok", [
  STORED_SUCCESS_SCHEMA,
  STORED_FAILURE_SCHEMA,
]);

// ---------------------------------------------------------------------------
// ManualCommandExecutor
// ---------------------------------------------------------------------------

/** Injected dependencies (see the SEAMS note in the header). */
export interface ManualCommandDeps {
  readonly sessions: SessionResolver;
  readonly store: CommandsStore;
  readonly idempotency: IdempotencyStore;
  /**
   * The §13.1 manual allowlist — REQUIRED_ENGINE_COMMANDS
   * (packages/engine-client/src/commands.ts, §2.2 registry-verified). Injected
   * by the composition root: @studio/engine-client is not a gateway
   * dependency, and the live list must never be hand-copied here (§2.2).
   */
  readonly allowlist: readonly string[];
}

/** The service surface (W4-K contract; HTTP mapping lives in the routes). */
export interface ManualCommandExecutor {
  /** §13.1 POST /v1/documents/:id/commands — one allowlisted engine command. */
  executeManualCommand(
    ctx: CommandExecutionContext,
    documentId: string,
    input: ManualCommandInput,
  ): Promise<CommandExecResult<ExecutedCommand>>;
  /** §13.1 POST /v1/documents/:id/undo — exactly one step (edit.undo). */
  undoOneStep(
    ctx: CommandExecutionContext,
    documentId: string,
    idempotencyKey: string,
  ): Promise<CommandExecResult<ExecutedCommand>>;
  /** §13.1 POST /v1/documents/:id/redo — exactly one step (edit.redo). */
  redoOneStep(
    ctx: CommandExecutionContext,
    documentId: string,
    idempotencyKey: string,
  ): Promise<CommandExecResult<ExecutedCommand>>;
}

/** One internal run: engine call and WAL row may intentionally diverge (undo). */
interface RunInput {
  readonly command: string;
  readonly engineParams: Record<string, unknown>;
  readonly walCommandName: string;
  readonly walParams: Record<string, unknown>;
  readonly idempotencyKey: string;
}

/**
 * Builds the ManualCommandExecutor. Pure factory: every dependency is
 * injectable, nothing is constructed here (buildApp/index.ts owns wiring).
 */
export function createManualCommandExecutor(deps: ManualCommandDeps): ManualCommandExecutor {
  const allowlist = new Set(deps.allowlist);

  /** §22 warn helper — denials are correlated but never leak values. */
  function warn(ctx: CommandExecutionContext, event: string, fields: Record<string, unknown>): void {
    ctx.logger?.warn({ request_id: ctx.requestId, ...fields }, event);
  }

  /** Minimal input re-validation (route Zod is the boundary; §5.7 defense). */
  function validateInput(
    command: string,
    params: Record<string, unknown>,
  ): CommandExecFailure | null {
    if (
      typeof command !== "string" ||
      command.trim().length === 0 ||
      command.length > MAX_COMMAND_ID_LENGTH
    ) {
      return catalogFailure("validation_failed", "The command id is missing or too long.", {
        hint: `Pass a registry command id (1–${MAX_COMMAND_ID_LENGTH} characters).`,
        retryable: true,
      });
    }
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return catalogFailure("validation_failed", "Command params must be a JSON object.", {
        hint: 'rpc.rs engine.execute: "params must be a JSON object", omitted or null — never an array or scalar.',
        retryable: true,
      });
    }
    return null;
  }

  /** §13.1/§25-5 gate: the SAME allowlist as tools; denials say why. */
  function checkAllowlist(
    ctx: CommandExecutionContext,
    command: string,
  ): CommandExecFailure | null {
    if (allowlist.has(command)) {
      return null;
    }
    warn(ctx, "command_not_allowlisted", {
      workspace_id: ctx.organizationId,
      user_id: ctx.userId,
    });
    const reason = rejectionReasonFor(command);
    return localFailure(
      "command_not_allowlisted",
      `Command "${command}" is not on the manual allowlist.`,
      {
        hint:
          reason ??
          "Manual execution accepts the §2.2 required engine commands only (the same allowlist as tools); see the command palette or the API reference for the list.",
        retryable: false,
      },
    );
  }

  /** Wraps a store/idempotency throw into a typed storage_error (§13.3). */
  async function guarded<T>(work: () => Promise<T>, what: string): Promise<CommandExecResult<T>> {
    try {
      return { ok: true, value: await work() };
    } catch {
      return catalogFailure("storage_error", `The ${what} is temporarily unavailable.`, {
        hint: "Nothing was executed; retry with the same idempotency key once the store recovers (§3.4).",
        retryable: true,
      });
    }
  }

  /** Replays a completed idempotency record (§3.4) — never touches the engine. */
  function replayStoredOutcome(
    ctx: CommandExecutionContext,
    stored: Record<string, unknown>,
  ): CommandExecResult<ExecutedCommand> {
    const parsed = STORED_OUTCOME_SCHEMA.safeParse(stored);
    if (!parsed.success) {
      warn(ctx, "idempotency_record_unreadable", { workspace_id: ctx.organizationId });
      return catalogFailure("internal_error", "The recorded idempotent outcome could not be read.", {
        hint: "Retry with a fresh idempotency key (§3.4).",
        retryable: false,
      });
    }
    const outcome = parsed.data;
    if (!outcome.ok) {
      return {
        ok: false,
        code: outcome.code as CommandExecErrorCode,
        message: outcome.message,
        ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
        retryable: outcome.retryable,
      };
    }
    return {
      ok: true,
      value: {
        seq: outcome.seq,
        command: outcome.command,
        revisionBefore: outcome.revisionBefore,
        revisionAfter: outcome.revisionAfter,
        summary: outcome.summary,
        warnings: outcome.warnings,
        replayed: true,
      },
    };
  }

  /**
   * The shared one-command pipeline (§13.1): validate → allowlist → idempotency
   * probe → tenant-scoped document → session → claim → execute → summarize →
   * WAL append → record outcome. Once the engine exchange happens the claim is
   * ALWAYS completed (success or failure): a mutating command never re-executes
   * under the same key (§3.4 "edits are never automatically resent").
   */
  async function runOne(
    ctx: CommandExecutionContext,
    documentId: string,
    input: RunInput,
  ): Promise<CommandExecResult<ExecutedCommand>> {
    const invalid = validateInput(input.command, input.engineParams);
    if (invalid !== null) {
      return invalid;
    }
    const denied = checkAllowlist(ctx, input.command);
    if (denied !== null) {
      return denied;
    }

    // §3.4 probe before any side effect: a completed record replays verbatim.
    const probed = await guarded(
      () =>
        deps.idempotency.lookup(
          input.idempotencyKey,
          MANUAL_COMMAND_IDEMPOTENCY_SCOPE,
          ctx.organizationId,
        ),
      "idempotency store",
    );
    if (!probed.ok) {
      return probed;
    }
    const lookup = probed.value;
    if (lookup.status === "completed") {
      return replayStoredOutcome(ctx, lookup.result);
    }
    if (lookup.status === "open") {
      return catalogFailure(
        "conflict",
        "An identical request with this idempotency key is still in progress.",
        {
          hint: "Wait for it to finish and retry with the same key (§3.4).",
          retryable: true,
        },
      );
    }
    if (lookup.status === "foreign") {
      // (key, scope) is taken by another workspace — never replay across
      // tenants (§15) and never confirm whose it is (§13.3).
      return catalogFailure("conflict", "This idempotency key is already in use.", {
        hint: "Generate a fresh idempotency key.",
        retryable: false,
      });
    }

    // §12.2 composite lookup: unknown AND cross-tenant ids are both 404.
    const found = await guarded(
      () => deps.store.findDocument(ctx.organizationId, documentId),
      "document store",
    );
    if (!found.ok) {
      return found;
    }
    const document = found.value;
    if (document === null) {
      return catalogFailure("not_found", "Document not found.", {
        hint: "Check the document id and the workspace you are calling against.",
        retryable: false,
      });
    }
    if (document.archived) {
      return catalogFailure("conflict", "The document is archived and read-only.", {
        hint: "Unarchive the document before running commands (§12.2 soft archive).",
        retryable: false,
      });
    }

    // §13.1: commands run on the worker-attached session for the open document.
    const session = await deps.sessions.getSession(documentId);
    if (session === null) {
      warn(ctx, "engine_session_unavailable", {
        workspace_id: ctx.organizationId,
        user_id: ctx.userId,
      });
      return localFailure(
        "engine_session_unavailable",
        "No engine session is attached to this document.",
        {
          hint: "Open the document first — commands execute on its live engine session.",
          retryable: true,
        },
      );
    }

    // §3.4 claim: the unique(key, scope) index backstops concurrent duplicates.
    const claimed = await guarded(
      () =>
        deps.idempotency.claim(
          input.idempotencyKey,
          MANUAL_COMMAND_IDEMPOTENCY_SCOPE,
          ctx.organizationId,
        ),
      "idempotency store",
    );
    if (!claimed.ok) {
      return claimed;
    }
    if (!claimed.value) {
      return catalogFailure(
        "conflict",
        "An identical request with this idempotency key is still in progress.",
        {
          hint: "A concurrent request claimed the same key; wait for its outcome and retry with it (§3.4).",
          retryable: true,
        },
      );
    }

    /** Records a post-exchange failure so the same key never re-executes. */
    const recordFailure = async (failure: CommandExecFailure): Promise<CommandExecFailure> => {
      const recorded = await guarded(
        () =>
          deps.idempotency.complete(
            input.idempotencyKey,
            MANUAL_COMMAND_IDEMPOTENCY_SCOPE,
            ctx.organizationId,
            {
              ok: false,
              code: failure.code,
              message: failure.message,
              ...(failure.hint === undefined ? {} : { hint: failure.hint }),
              retryable: failure.retryable,
            },
          ),
        "idempotency store",
      );
      if (!recorded.ok) {
        warn(ctx, "idempotency_outcome_unrecorded", { request_id: ctx.requestId });
      }
      return failure;
    };

    const execution = await session.execute({
      command: input.command,
      params: input.engineParams,
    });
    if (!execution.ok) {
      warn(ctx, "engine_command_failed", {
        workspace_id: ctx.organizationId,
        user_id: ctx.userId,
        engine_code: execution.code,
      });
      return recordFailure({
        ok: false,
        code: execution.code,
        message: execution.message,
        ...(execution.hint === undefined ? {} : { hint: execution.hint }),
        retryable: execution.retryable,
      });
    }

    const { reply } = execution;
    const summary = summarizeCommandResult(
      input.walCommandName,
      reply.revisionBefore,
      reply.revisionAfter,
      reply.result,
    );

    // §5.6 append: seq + params + result summary + the carried counters.
    const appended = await guarded(
      () =>
        deps.store.appendCommand({
          documentId,
          organizationId: ctx.organizationId,
          runId: null, // §13.4: manual/API commands are not run commands.
          commandName: input.walCommandName,
          params: input.walParams,
          result: {
            summary: summary.summary,
            warnings: summary.warnings,
            fields: summary.fields,
          },
          revisionBefore: reply.revisionBefore,
          revisionAfter: reply.revisionAfter,
        }),
      "command log",
    );
    if (!appended.ok) {
      // The engine already applied the edit but the WAL row is missing — the
      // client must NOT blind-retry (that would double-apply, §3.4).
      warn(ctx, "command_wal_append_failed", {
        workspace_id: ctx.organizationId,
        user_id: ctx.userId,
      });
      return recordFailure(
        catalogFailure(
          "storage_error",
          "The command was applied but its log entry could not be recorded.",
          {
            hint: "Inspect the document state before issuing further commands; retry with a fresh idempotency key (§5.6).",
            retryable: false,
          },
        ),
      );
    }

    const executed: ExecutedCommand = {
      seq: appended.value.seq,
      command: input.walCommandName,
      revisionBefore: reply.revisionBefore,
      revisionAfter: reply.revisionAfter,
      summary: summary.summary,
      warnings: summary.warnings,
      replayed: false,
    };

    // §3.4 record the success payload for replay; a recording failure keeps
    // the claim open (future same-key calls answer "open" → conflict), it
    // never rewinds the executed command.
    const recorded = await guarded(
      () =>
        deps.idempotency.complete(
          input.idempotencyKey,
          MANUAL_COMMAND_IDEMPOTENCY_SCOPE,
          ctx.organizationId,
          {
            ok: true,
            seq: executed.seq,
            command: executed.command,
            summary: executed.summary,
            warnings: [...executed.warnings],
            revisionBefore: executed.revisionBefore,
            revisionAfter: executed.revisionAfter,
          },
        ),
      "idempotency store",
    );
    if (!recorded.ok) {
      warn(ctx, "idempotency_outcome_unrecorded", { request_id: ctx.requestId });
    }

    return { ok: true, value: executed };
  }

  /** Builds the one-step undo/redo bound method (§13.1 "one step"). */
  function oneStepCommand(
    command: string,
    walParams: Readonly<Record<string, unknown>>,
  ): (
    ctx: CommandExecutionContext,
    documentId: string,
    idempotencyKey: string,
  ) => Promise<CommandExecResult<ExecutedCommand>> {
    return async (ctx, documentId, idempotencyKey) =>
      runOne(ctx, documentId, {
        command, // allowlisted engine command (§2.2 UTILITY_COMMANDS)
        engineParams: {}, // vendor edit.undo/edit.redo take no params (commands.rs:580–581)
        walCommandName: command,
        walParams: { ...walParams }, // the WAL row records the one-step intent
        idempotencyKey,
      });
  }

  const undoOneStep = oneStepCommand(UNDO_COMMAND, UNDO_WAL_PARAMS);
  const redoOneStep = oneStepCommand(REDO_COMMAND, REDO_WAL_PARAMS);

  return {
    async executeManualCommand(ctx, documentId, input) {
      return runOne(ctx, documentId, {
        command: input.command,
        engineParams: input.params,
        walCommandName: input.command,
        walParams: input.params,
        idempotencyKey: input.idempotencyKey,
      });
    },
    undoOneStep,
    redoOneStep,
  };
}
