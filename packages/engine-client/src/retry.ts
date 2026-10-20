// @studio/engine-client — call retry policy. Owner: W2-D (src/{errors,retry,client,index}.ts).
//
// Implements the doc semantics EXACTLY (vendor/photocraft/docs/control-protocol.md):
//   - §MCP bridge: "The MCP server opts its pure-read tools … into ONE automatic retry on
//     a fresh connection, since a read applies nothing." Mutating calls are the opposite:
//     "a transport failure while sending a request or waiting for its reply … reports
//     that the operation may have completed; inspect the document before retrying an
//     edit. Edits are never automatically resent (#1007)."
//   - §MCP bridge: "a connection that could not be established is reported as 'the
//     request was not sent'" — establishing a connection applies nothing, so CONNECT
//     attempts retry with exponential backoff for every kind (docs/BUILD_PROMPT.md §3.4
//     "queue job retried with backoff ×3").
//   - §MCP bridge: an oversized incoming reply "is dropped without automatically
//     retrying" — frame_too_large is never auto-retried, even for reads.
//
// Pure module: no I/O, no clock, no globals — the client injects time and randomness.

import { engineError, type EngineErrorEnvelope, type EngineErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** A read applies nothing (one auto-retry); a mutation may have completed (never resent). */
export type CallKind = "read" | "mutate";

// ---------------------------------------------------------------------------
// Connect-phase backoff (§3.4: backoff ×3)
// ---------------------------------------------------------------------------

/** Maximum connection attempts per connect cycle — initial + 2 retries (§3.4 "backoff ×3"). */
export const MAX_CONNECT_ATTEMPTS = 3;

export interface BackoffPolicy {
  /** First delay; doubles each attempt (default 250 ms). */
  readonly baseMs?: number;
  /** Upper bound per delay (default 4 000 ms). */
  readonly capMs?: number;
  /** Jitter fraction in [0, 1]: 0 waits the full delay, 1 scales it into [0, delay) (default 0.5). */
  readonly jitter?: number;
  /** Injectable randomness for deterministic tests (default Math.random). */
  readonly random?: () => number;
}

const DEFAULT_BASE_MS = 250;
const DEFAULT_CAP_MS = 4_000;
const DEFAULT_JITTER = 0.5;

/**
 * Exponential backoff delay after `failures` failed connect attempts:
 * min(cap, base × 2^failures), jittered multiplicatively into
 * [delay × (1 − jitter), delay]. Pure and deterministic with `random` injected.
 */
export function backoffDelayMs(failures: number, policy: BackoffPolicy = {}): number {
  const baseMs = policy.baseMs ?? DEFAULT_BASE_MS;
  const capMs = policy.capMs ?? DEFAULT_CAP_MS;
  const jitter = clampNumber(policy.jitter ?? DEFAULT_JITTER, 0, 1);
  const random = policy.random ?? Math.random;
  const exponent = Math.max(0, failures);
  const raw = Math.min(capMs, baseMs * 2 ** exponent);
  return Math.max(0, raw * (1 - jitter * random()));
}

/**
 * The wait before connect attempt `failures + 1`, or null when the cycle is exhausted
 * (MAX_CONNECT_ATTEMPTS attempts already made). The caller then surfaces the last failure.
 */
export function connectAttemptPlan(failures: number, policy: BackoffPolicy = {}): number | null {
  if (failures >= MAX_CONNECT_ATTEMPTS - 1) {
    return null;
  }
  return backoffDelayMs(failures, policy);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Read retry budget (§MCP bridge: one automatic retry on a fresh connection)
// ---------------------------------------------------------------------------

/** Pure reads may auto-retry exactly ONCE on a fresh connection. */
export const READ_RETRY_BUDGET = 1;

/**
 * Codes for which a fresh-connection read retry is safe and useful. All arise while a
 * request is in flight (or provably was not sent): engine_unavailable (request not
 * sent), reply_timeout, engine_crashed and connection_dropped_mid_call (may have
 * completed — harmless for a read). Deliberately NOT frame_too_large (the doc drops
 * oversized replies "without automatically retrying"), auth_rejected, or engine-level
 * error replies (deterministic server answers).
 */
export const READ_RETRY_CODES: ReadonlySet<EngineErrorCode> = new Set([
  "engine_unavailable",
  "reply_timeout",
  "engine_crashed",
  "connection_dropped_mid_call",
]);

/**
 * Whether the client loop should auto-retry: reads only, transport-class failures
 * only, at most READ_RETRY_BUDGET times, each on a FRESH connection. Mutations never
 * auto-resend — the caller inspects and decides (§MCP bridge #1007).
 */
export function shouldAutoRetry(
  kind: CallKind,
  code: EngineErrorCode,
  readRetriesUsed: number,
): boolean {
  return kind === "read" && READ_RETRY_CODES.has(code) && readRetriesUsed < READ_RETRY_BUDGET;
}

// ---------------------------------------------------------------------------
// Mutating-call failures (never auto-resend)
// ---------------------------------------------------------------------------

/**
 * A mutating call whose transport failed while in flight never auto-resends; the
 * facade returns connection_dropped_mid_call with the inspect-before-retry hint and
 * the underlying failure preserved in `data` (§MCP bridge, transport/errors.ts
 * MAY_HAVE_COMPLETED_HINT wording).
 */
export function mutateMidCallFailure(cause: {
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly data?: unknown;
}): EngineErrorEnvelope {
  return engineError("connection_dropped_mid_call", {
    data: { source: "mid_call", code: cause.code, message: cause.message, cause: cause.data },
  });
}

/**
 * The facade-level outcome for an aborted call: pre-dispatch aborts never sent anything
 * (retryable); an abort after dispatch drops the connection first, so a mutating call
 * keeps its may-have-completed semantics (connection_dropped_mid_call), while a read
 * reports call_aborted (a fresh read is always safe).
 */
export function abortOutcome(kind: CallKind, dispatched: boolean): EngineErrorEnvelope {
  if (!dispatched) {
    return engineError("call_aborted");
  }
  if (kind === "mutate") {
    return engineError("connection_dropped_mid_call", {
      message: "the call was aborted while a mutating request was in flight",
      data: { source: "abort", dispatched: true },
    });
  }
  return engineError("call_aborted", {
    hint: "the connection was dropped at abort time; a read may have run, but a fresh call is still safe",
    data: { source: "abort", dispatched: true },
  });
}
