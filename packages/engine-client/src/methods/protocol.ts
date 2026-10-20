// @studio/engine-client — shared control-protocol surface for the typed method builders (W2-C).
//
// Protocol truth (vendor pinned 872748fb, read-only — verify here, never invent):
//   - `vendor/photocraft/docs/control-protocol.md` §Headless server (method table),
//     §Command list replies, §Background jobs, §Transport limits, §Methods.
//   - `vendor/photocraft/crates/automation/src/rpc.rs` — `METHODS` dispatch, `respond()`
//     envelope, `batch()` semantics.
//   - `vendor/photocraft/crates/automation/src/security.rs` — request/connection/step caps.
//   - `vendor/photocraft/crates/automation/src/budgets.rs` — reply/preview/PNG caps.
//   - Studio spec: docs/BUILD_PROMPT.md Appendix B (the surface this package must cover).
//
// Wire envelope — rpc.rs `respond` (verified: engine errors are PLAIN STRINGS under `error`,
// never objects):
//   {"id": <request id | null>, "ok": true,  "result": <json value>}
//   {"id": <request id | null>, "ok": false, "error": "<message string>"}

import { z } from "zod";
import type { ZodError, ZodType, ZodTypeDef } from "zod";

// ---------------------------------------------------------------------------
// Method names — exact ids from rpc.rs `METHODS` (registry order)
// ---------------------------------------------------------------------------

/** Every method the headless server dispatches, in rpc.rs `METHODS` order. */
export const SERVED_METHODS = [
  "engine.execute",
  "jobs.list",
  "jobs.cancel",
  "engine.commands",
  "session.list",
  "doc.open",
  "doc.place",
  "doc.new",
  "doc.save",
  "doc.exportLayers",
  "doc.exportDataSets",
  "doc.importDataSets",
  "doc.inspect",
  "doc.render",
  "doc.select",
  "doc.close",
  "batch",
  "methods",
] as const;

export type ServedMethodName = (typeof SERVED_METHODS)[number];

/**
 * The method names spec Appendix B assigns to this client (studio docs/BUILD_PROMPT.md
 * Appendix B). Call sites never repeat string literals; tests pin parity with
 * `SERVED_METHODS`.
 */
export const PROTOCOL_METHODS = {
  methods: "methods",
  sessionList: "session.list",
  docNew: "doc.new",
  docOpen: "doc.open",
  docPlace: "doc.place",
  docSave: "doc.save",
  docRender: "doc.render",
  docInspect: "doc.inspect",
  docSelect: "doc.select",
  docClose: "doc.close",
  docExportLayers: "doc.exportLayers",
  docExportDataSets: "doc.exportDataSets",
  docImportDataSets: "doc.importDataSets",
  engineExecute: "engine.execute",
  engineCommands: "engine.commands",
  batch: "batch",
} as const;

/** Background-job methods (rpc.rs `METHODS`; §Background jobs #210) — polled via jobs.list. */
export const JOB_METHODS = {
  jobsList: "jobs.list",
  jobsCancel: "jobs.cancel",
} as const;

// ---------------------------------------------------------------------------
// Engine limits (security.rs / budgets.rs / rpc.rs defaults — verified constants)
// ---------------------------------------------------------------------------

/** Maximum encoded request line (security.rs `MAX_REQUEST_BYTES`, 1 MiB). */
export const MAX_REQUEST_BYTES = 1 << 20;
/** Maximum encoded reply including its newline (budgets.rs `MAX_RESPONSE_BYTES`, 8 MiB). */
export const MAX_RESPONSE_BYTES = 8 << 20;
/** Simultaneously serviced connections per listener (security.rs `MAX_CONNECTIONS`). */
export const MAX_CONNECTIONS = 16;
/** Steps per headless `batch` request (security.rs `MAX_BATCH_STEPS`). */
export const MAX_BATCH_STEPS = 256;
/**
 * Maximum requested preview edge in pixels; `maxSide: 0` still means full size within it
 * (budgets.rs `MAX_PREVIEW_SIDE`). Aligns budgets.ts (W2-B) with the engine ceiling.
 */
export const MAX_PREVIEW_SIDE = 2048;
/** `doc.render` default when `maxSide` is omitted (rpc.rs). */
export const RENDER_DEFAULT_MAX_SIDE = 1024;
/** Maximum PNG bytes before base64 encoding or writing a rendered file (budgets.rs, 5 MiB). */
export const MAX_PNG_BYTES = 5 << 20;
/** Maximum source pixels processed by a headless preview (budgets.rs, 64 MiB = 67108864). */
export const MAX_RENDER_SOURCE_PIXELS = 64 << 20;
/**
 * Server reply deadline (control-protocol.md: a request still queued at the deadline is
 * rejected before dispatch).
 */
export const REPLY_DEADLINE_MS = 60_000;

// ---------------------------------------------------------------------------
// Reply envelope — exactly what rpc.rs `respond` writes
// ---------------------------------------------------------------------------

/** Client-chosen request id, echoed back; null for replies to malformed frames. */
export type RequestId = number | string | null;

export const WIRE_OK_REPLY_SCHEMA = z
  .object({
    id: z.union([z.number(), z.string(), z.null()]),
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const WIRE_ERR_REPLY_SCHEMA = z
  .object({
    id: z.union([z.number(), z.string(), z.null()]),
    ok: z.literal(false),
    error: z.string(),
  })
  .strict();

/** `{"id","ok","result"}` vs `{"id","ok","error"}` — the discriminated wire envelope. */
export const WIRE_REPLY_SCHEMA = z.discriminatedUnion("ok", [
  WIRE_OK_REPLY_SCHEMA,
  WIRE_ERR_REPLY_SCHEMA,
]);

export type WireOkReply = z.infer<typeof WIRE_OK_REPLY_SCHEMA>;
export type WireErrReply = z.infer<typeof WIRE_ERR_REPLY_SCHEMA>;
export type WireReply = WireOkReply | WireErrReply;

/** Compact issue summary — paths and messages only, never echo values (no leaks). */
export function summarizeIssues(error: ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
  const extra = error.issues.length - issues.length;
  return extra > 0 ? `${issues.join("; ")}; +${extra} more` : issues.join("; ");
}

export type ReplyOutcome<TResult> =
  | { readonly ok: true; readonly result: TResult }
  | { readonly ok: false; readonly error: string };

/**
 * Parse one wire reply against a method's result schema. Never throws: an engine error,
 * a non-envelope reply and a schema mismatch all come back as `{ ok: false, error }`
 * (house rule: typed envelopes, never thrown strings). The engine's own error string is
 * preserved verbatim — retry classification (retry/errors) keys on it.
 */
export function parseEngineReply<TResult>(
  reply: unknown,
  resultSchema: ZodType<TResult, ZodTypeDef, unknown>,
  method?: string,
): ReplyOutcome<TResult> {
  const wire = WIRE_REPLY_SCHEMA.safeParse(reply);
  if (!wire.success) {
    return { ok: false, error: `reply is not a protocol envelope: ${summarizeIssues(wire.error)}` };
  }
  if (!wire.data.ok) {
    return { ok: false, error: wire.data.error };
  }
  const parsed = resultSchema.safeParse(wire.data.result);
  if (!parsed.success) {
    const who = method === undefined ? "engine result" : `engine result for \`${method}\``;
    return { ok: false, error: `${who} failed schema validation: ${summarizeIssues(parsed.error)}` };
  }
  return { ok: true, result: parsed.data };
}

/** Parse the reply of a built call (see `MethodCall`) with method context in errors. */
export function parseCallReply<TResult>(
  call: MethodCall<unknown, TResult>,
  reply: unknown,
): ReplyOutcome<TResult> {
  return parseEngineReply(reply, call.resultSchema, call.method);
}

// ---------------------------------------------------------------------------
// Method calls — typed request builder output
// ---------------------------------------------------------------------------

/**
 * One validated protocol call: the method id, exact wire params, and the Zod schema the
 * transport must run on the reply's `result`. `ok: true` makes it discriminated against
 * `MethodBuildFailure` (house envelope shape, AGENTS.md).
 */
export interface MethodCall<TParams, TResult> {
  readonly ok: true;
  readonly method: string;
  readonly params: TParams;
  readonly resultSchema: ZodType<TResult, ZodTypeDef, unknown>;
}

export type BuildErrorCode = "invalid_params" | "engine_limit" | "unsupported";

/** Typed builder failure (house envelope: { ok:false, code, message, hint?, retryable? }). */
export interface MethodBuildFailure {
  readonly ok: false;
  readonly code: BuildErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: false;
}

export type BuiltMethodCall<TParams, TResult> = MethodCall<TParams, TResult> | MethodBuildFailure;

export function isMethodCall<TParams, TResult>(
  built: BuiltMethodCall<TParams, TResult>,
): built is MethodCall<TParams, TResult> {
  return built.ok;
}

export function buildFailure(code: BuildErrorCode, message: string, hint?: string): MethodBuildFailure {
  return hint === undefined ? { ok: false, code, message } : { ok: false, code, message, hint };
}

/**
 * Validate builder input against the method's param schema and produce a `MethodCall`.
 * Client-side fail fast: param typos and out-of-range values are typed failures here,
 * not engine round trips.
 */
export function buildCall<TParams, TResult>(
  method: string,
  paramSchema: ZodType<TParams, ZodTypeDef, unknown>,
  input: unknown,
  resultSchema: ZodType<TResult, ZodTypeDef, unknown>,
): BuiltMethodCall<TParams, TResult> {
  const parsed = paramSchema.safeParse(input);
  if (!parsed.success) {
    return buildFailure("invalid_params", `\`${method}\`: ${summarizeIssues(parsed.error)}`);
  }
  return { ok: true, method, params: parsed.data, resultSchema };
}

// ---------------------------------------------------------------------------
// Capability-root paths (light, protocol-level; full containment is capabilities.ts)
// ---------------------------------------------------------------------------

/**
 * The engine refuses `..` path segments ("parent traversal", rpc.rs doc.place tests) and
 * anything resolving outside the automation root. Builders reject traversal up front;
 * root containment (absolute vs relative, symlink escape) is the workspace capability's
 * job (capabilities.ts) and the engine's own check.
 */
export function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]/).includes("..");
}

/** A non-empty path under the automation read root (forward slashes; may be absolute). */
export const READ_ROOT_PATH = z.string().min(1).refine((path) => !hasParentTraversal(path), {
  message: "path must stay inside the automation read root (no `..` segments)",
});

/** A non-empty path under the automation write root. */
export const WRITE_ROOT_PATH = z.string().min(1).refine((path) => !hasParentTraversal(path), {
  message: "path must stay inside the automation write root (no `..` segments)",
});

// ---------------------------------------------------------------------------
// Transport seam (src/transport implements this; methods never import the transport)
// ---------------------------------------------------------------------------

/** Sends one protocol frame and resolves the raw reply value (the full wire envelope). */
export type WireSender = (request: {
  readonly method: string;
  readonly params: unknown;
}) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Timeout classification (control-protocol.md §replies — the two `timeout` errors)
// ---------------------------------------------------------------------------

/** Any reply-timeout error (both variants start with `timeout`). */
export function isReplyTimeout(error: string): boolean {
  return error.startsWith("timeout");
}

/**
 * "timeout: not run" — the request was still queued at the deadline and never dispatched,
 * so it is safe to re-send. Every other timeout may have been applied: inspect the
 * document before re-sending (control-protocol.md; consumed by retry/errors).
 */
export function isNotRunTimeout(error: string): boolean {
  return error.startsWith("timeout: not run");
}
