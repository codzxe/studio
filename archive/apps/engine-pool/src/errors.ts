// @studio/engine-pool — typed errors (§4 conventions: `{ ok:false, code, message, hint }`).
// Never throw strings; never leak stack traces, absolute paths, or internal ids in
// user-facing messages. A `cause` may carry internals for logging, but is never included
// in the envelope.

export type EnginePoolErrorCode =
  | "engine_unavailable"
  | "session_limit_reached"
  | "session_not_found"
  | "spawn_failed"
  | "watchdog_timeout";

export interface ErrorEnvelope {
  readonly ok: false;
  readonly code: EnginePoolErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export interface EnginePoolErrorOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/** The single error type thrown by this package; carries a stable machine-readable code. */
export class EnginePoolError extends Error {
  readonly code: EnginePoolErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: EnginePoolErrorCode,
    message: string,
    options?: EnginePoolErrorOptions,
  ) {
    super(message, { cause: options?.cause });
    this.name = "EnginePoolError";
    this.code = code;
    this.hint = options?.hint;
    this.retryable = options?.retryable ?? false;
  }

  /** Wire shape for gateways/SSE: no stack, no cause, no internals (§4). */
  toEnvelope(): ErrorEnvelope {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
    };
  }
}

export function isEnginePoolError(error: unknown): error is EnginePoolError {
  return error instanceof EnginePoolError;
}

/** Convert anything thrown into a safe envelope; unknown errors stay generic (§4). */
export function toEnvelope(error: unknown): ErrorEnvelope {
  if (isEnginePoolError(error)) {
    return error.toEnvelope();
  }
  return {
    ok: false,
    code: "engine_unavailable",
    message: "Engine session operation failed",
    hint: "Retry; if the problem persists, contact support.",
    retryable: true,
  };
}

/** The engine runtime cannot serve this request right now (shutting down, missing binary). */
export function engineUnavailable(options?: {
  message?: string;
  hint?: string;
  cause?: unknown;
}): EnginePoolError {
  return new EnginePoolError(
    "engine_unavailable",
    options?.message ?? "The engine runtime is not available",
    {
      hint: options?.hint ?? "Retry shortly; if this persists, check engine deployment health.",
      retryable: true,
      cause: options?.cause,
    },
  );
}

/** The tenant reached its plan's concurrent-session cap (§3.2 plan limit). */
export function sessionLimitReached(limit: number, active: number): EnginePoolError {
  return new EnginePoolError(
    "session_limit_reached",
    `Organization engine-session limit reached (${active}/${limit} active)`,
    {
      hint: "Wait for a session to go idle, release one, or upgrade the plan.",
      retryable: true,
    },
  );
}

/**
 * Unknown session id — and the SAME error for cross-tenant lookups, so a foreign
 * organization can never even learn that a session exists (§15.1 isolation, §25 rule 4).
 */
export function sessionNotFound(options?: { hint?: string }): EnginePoolError {
  return new EnginePoolError(
    "session_not_found",
    "Engine session not found for this organization",
    { hint: options?.hint ?? "Check the session id and organization scope." },
  );
}

/** The engine process could not be spawned or never became ready. */
export function spawnFailed(cause: unknown): EnginePoolError {
  return new EnginePoolError("spawn_failed", "Engine process failed to start", {
    hint: "Verify the engine runtime, capability roots, and port availability.",
    retryable: true,
    cause,
  });
}

/** A session ignored the graceful-stop signal within the grace window (watchdog). */
export function watchdogTimeout(graceMs: number): EnginePoolError {
  return new EnginePoolError(
    "watchdog_timeout",
    `Engine session did not stop within the ${graceMs} ms grace window`,
    {
      hint: "The session is marked crashed; escalate the kill and replay from the last checkpoint (§3.4).",
      retryable: false,
    },
  );
}
