// @studio/engine-client — transport-level errors. Owner: W2-A (src/transport/** only).
//
// Protocol truth (pinned vendor revision, read-only):
//   - docs/control-protocol.md §Methods (first-frame auth), §MCP bridge, §Transport limits
//   - crates/automation/src/security.rs (token shape, ceilings, AUTH_DEADLINE, ConnectionLimiter)
//
// Codes are stable strings (add-only, never rename or reuse):
//   connection_refused            The TCP connection could not be established, or failed before
//                                 the protocol was ready. Nothing was sent: the doc reports
//                                 this as "the request was not sent" (§MCP bridge).
//   auth_rejected                 The engine refused `auth` (wrong token), or no auth reply
//                                 arrived before the deadline (security.rs AUTH_DEADLINE, 10 s).
//   connection_dropped_mid_call    Transport failed while a request was in flight. The doc
//                                 mandates the semantics: the operation MAY have completed —
//                                 "inspect the document before retrying an edit". Edits are
//                                 never automatically resent (#1007).
//   reply_timeout                 No reply within the client call timeout (55 s, strictly below
//                                 the engine's 60 s reply deadline, so this error — not a late
//                                 engine reply — is what callers see).
//   frame_too_large               A line exceeded its wire ceiling: 1 MiB requests, 8 MiB
//                                 replies including the newline (§Transport limits).
//   protocol_violation             The peer broke framing/auth ordering, or the caller used the
//                                 transport against the protocol's rules (e.g. a second
//                                 concurrent call, connect() on a live connection).
//
// AGENTS.md style: never throw strings; never leak stack traces, absolute paths or internal
// ids. The client layer (retry/errors/client.ts owner) turns these into result envelopes via
// transportFailure(); transport code throws only TransportError.

import { z } from "zod";

export const TRANSPORT_ERROR_CODES = [
  "connection_refused",
  "auth_rejected",
  "connection_dropped_mid_call",
  "reply_timeout",
  "frame_too_large",
  "protocol_violation",
] as const satisfies readonly string[];

export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** Zod enum for the code field at API boundaries (AGENTS.md: Zod at every boundary). */
export const TRANSPORT_ERROR_CODE_SCHEMA = z.enum(TRANSPORT_ERROR_CODES);

export interface TransportErrorOptions {
  /** Actionable follow-up; must not leak stack traces, absolute paths or internal ids. */
  readonly hint?: string;
  /**
   * Whether re-establishing the transport and retrying is reasonable. Defaults are set by the
   * factories below; callers may override. Retryable never means "auto-resend an edit" —
   * that decision belongs to the client layer and the doc forbids automatic resends (#1007).
   */
  readonly retryable?: boolean;
  /**
   * True only when an in-flight request may have been applied by the engine. Doc §MCP bridge:
   * a transport failure while sending a request or waiting for its reply "reports that the
   * operation may have completed; inspect the document before retrying an edit".
   */
  readonly mayHaveCompleted?: boolean;
  /** Original error/socket detail. Kept for callers, never surfaced in message or hint. */
  readonly cause?: unknown;
}

/** The only error type thrown by this transport layer. */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly mayHaveCompleted: boolean;
  readonly cause: unknown;

  constructor(code: TransportErrorCode, message: string, options: TransportErrorOptions = {}) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.mayHaveCompleted = options.mayHaveCompleted === true;
    this.cause = options.cause;
  }
}

export function isTransportError(error: unknown): error is TransportError {
  return error instanceof TransportError;
}

/** Doc-mandated wording for any failure where an in-flight request may have been applied. */
export const MAY_HAVE_COMPLETED_HINT =
  "The operation may have completed; inspect the document before retrying an edit. " +
  "Edits are never automatically resent (#1007); a pure read may be retried once on a fresh " +
  "connection.";

/** Pre-auth/connect-phase failure. Nothing was sent, so nothing was applied. Retryable. */
export function connectionRefused(
  message: string,
  options: TransportErrorOptions = {},
): TransportError {
  return new TransportError("connection_refused", message, {
    retryable: options.retryable ?? true,
    mayHaveCompleted: false,
    hint: options.hint,
    cause: options.cause,
  });
}

/**
 * Authentication did not succeed. Explicit server rejections are not retryable; a missed
 * auth deadline is (retry on a fresh connection). mayHaveCompleted is always false: the
 * `auth` frame has no document side effects.
 */
export function authRejected(message: string, options: TransportErrorOptions = {}): TransportError {
  return new TransportError("auth_rejected", message, {
    retryable: options.retryable ?? false,
    mayHaveCompleted: false,
    hint: options.hint,
    cause: options.cause,
  });
}

/**
 * Transport failed while a request was in flight (or being written). Not retryable by
 * default — the doc forbids automatic resends — and mayHaveCompleted defaults true: the
 * request was already on the wire when the transport failed.
 */
export function connectionDroppedMidCall(
  message: string,
  options: TransportErrorOptions = {},
): TransportError {
  return new TransportError("connection_dropped_mid_call", message, {
    retryable: options.retryable ?? false,
    mayHaveCompleted: options.mayHaveCompleted ?? true,
    hint: options.hint ?? MAY_HAVE_COMPLETED_HINT,
    cause: options.cause,
  });
}

/**
 * The client call timeout elapsed with no reply. mayHaveCompleted defaults true: the
 * command was dispatched and may still be running (doc §Methods, the 60 s "no reply" case).
 */
export function replyTimeout(message: string, options: TransportErrorOptions = {}): TransportError {
  return new TransportError("reply_timeout", message, {
    retryable: options.retryable ?? false,
    mayHaveCompleted: options.mayHaveCompleted ?? true,
    hint: options.hint ?? MAY_HAVE_COMPLETED_HINT,
    cause: options.cause,
  });
}

/**
 * A line exceeded its wire ceiling (§Transport limits). Not retryable: the same payload is
 * oversized again. mayHaveCompleted defaults false (encode-side rejections send nothing);
 * call sites override it for an oversized INCOMING reply, which the doc says "may have
 * completed".
 */
export function frameTooLarge(
  message: string,
  options: TransportErrorOptions = {},
): TransportError {
  return new TransportError("frame_too_large", message, {
    retryable: options.retryable ?? false,
    mayHaveCompleted: options.mayHaveCompleted ?? false,
    hint: options.hint,
    cause: options.cause,
  });
}

/** Framing/auth-order/caller-rule violations. Pre-dispatch by nature: nothing was applied. */
export function protocolViolation(
  message: string,
  options: TransportErrorOptions = {},
): TransportError {
  return new TransportError("protocol_violation", message, {
    retryable: options.retryable ?? false,
    mayHaveCompleted: options.mayHaveCompleted ?? false,
    hint: options.hint,
    cause: options.cause,
  });
}

/** Failure envelope per AGENTS.md: { ok:false, code, message, hint?, retryable? }. */
export interface TransportFailure {
  readonly ok: false;
  readonly code: TransportErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  /** Present only when the operation may have completed (edit-safety signal). */
  readonly mayHaveCompleted?: boolean;
}

/** Converts a TransportError into the flat result envelope used across the repo. */
export function transportFailure(error: TransportError): TransportFailure {
  const failure: {
    ok: false;
    code: TransportErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
    mayHaveCompleted?: boolean;
  } = { ok: false, code: error.code, message: error.message };
  if (error.hint !== undefined) {
    failure.hint = error.hint;
  }
  if (error.retryable) {
    failure.retryable = true;
  }
  if (error.mayHaveCompleted) {
    failure.mayHaveCompleted = true;
  }
  return failure;
}
