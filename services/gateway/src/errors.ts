// @studio/gateway — error boundary mapping (§7.3 envelope, §8.9 semantics).
//
// Every /v1 failure is rendered as the §7.3 Err envelope:
//   { error: { code, message, hint?, retryable, requestId } }
// Never leak stack traces, absolute paths, upstream URLs or raw provider
// errors. `@studio/config`'s catalog is the source of truth for product
// codes; DbError codes from @studio/db and a few gateway-only codes
// (NOT_FOUND, CONFLICT, SERVICE_UNAVAILABLE, …) are mapped here. Codes are
// add-only strings on the wire.

import { StudioError, type StudioErrorCode } from "@studio/config";
import { type DbError, isDbError } from "@studio/db";

/** §7.3 Err envelope (structurally identical to @studio/contracts Err). */
export interface ErrEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
    readonly retryable: boolean;
    readonly requestId: string;
  };
}

/** HTTP status per code — add-only; mirrors §8.9 + @studio/db's table. */
const STATUS_BY_CODE: Record<string, number> = {
  // @studio/config catalog
  PROJECT_VERSION_CONFLICT: 409,
  INSUFFICIENT_CREDITS: 402,
  LEASE_HELD: 409,
  LEASE_EXPIRED: 409,
  RUN_MODEL_UNAVAILABLE: 502,
  RUN_INVALID_TOOL: 400,
  RUN_INVALID_COMMAND: 400,
  RUN_BATCH_ROLLED_BACK: 500,
  RUN_CANCELLED: 409,
  EDITOR_DISCONNECTED: 503,
  // M8-G rows — the 9 new render codes (M8-B catalog doc comments are the
  // intended-status authority; see @studio/config/src/errors.ts):
  //   415 declared-but-disabled format (D-2 gate) · 429 monthly render minutes
  //   · 429 workspace concurrency cap · 409 user-cancelled render · 400 the
  //   project snapshot failed render validation · 400 a needed asset is gone
  //   · 500 the CLI binary is missing · 500 the CLI exited non-zero · 500 the
  //   render pipeline failed unexpectedly. RENDER_TIMEOUT/RENDER_FAILED (the
  //   two pre-existing render codes) stay at 504/500 above.
  RENDER_UNSUPPORTED_FORMAT: 415,
  RENDER_QUOTA_EXCEEDED: 429,
  RENDER_CONCURRENCY_LIMIT: 429,
  RENDER_CANCELLED: 409,
  RENDER_PROJECT_INVALID: 400,
  RENDER_ASSET_MISSING: 400,
  RENDER_CLI_MISSING: 500,
  RENDER_CLI_FAILED: 500,
  RENDER_INTERNAL: 500,
  RENDER_TIMEOUT: 504,
  RENDER_FAILED: 500,
  ASSET_TOO_LARGE: 413,
  ASSET_REJECTED: 415,
  QUOTA_EXCEEDED: 429,
  WORKSPACE_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  THREAD_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  MODEL_NOT_ENTITLED: 403,
  VALIDATION_FAILED: 400,
  INTERNAL: 500,
  // gateway-only wire codes (outside the config catalog; safe add-only)
  NOT_FOUND: 404,
  CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  RUN_NOT_ACTIVE: 409,
  // W1-c (§M2.2 verify-by-head): magic-byte sniff on the uploaded head
  // contradicts the declared MIME — 415, upload rejected.
  ASSET_TYPE_MISMATCH: 415,
  ASSET_NOT_FOUND: 404,
  RENDER_NOT_FOUND: 404,
  COMMENT_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  INVITE_RECIPIENT_MISMATCH: 403,
  BILLING_NOT_CONFIGURED: 400,
  SHA256_MISMATCH: 400,
  // W1-e (AUD-3 gap 3a): the plan-catalog seat limit hit on invite creation
  // — a quota-shaped refusal (mirrors QUOTA_EXCEEDED/RENDER_QUOTA_EXCEEDED).
  SEATS_EXCEEDED: 429,
};

/** HTTP status for a wire code (default: 500 INTERNAL — never leak details). */
export function httpStatusFor(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Typed gateway error for codes outside the @studio/config catalog. */
export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly requestId: string;
  /** Server-side only; never serialized. */
  readonly cause: unknown;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number;
      hint?: string;
      retryable?: boolean;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = options.status ?? httpStatusFor(code);
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId ?? "req_unknown";
    this.cause = options.cause;
  }

  toEnvelope(): ErrEnvelope {
    const body: {
      code: string;
      message: string;
      retryable: boolean;
      requestId: string;
      hint?: string;
    } = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requestId: this.requestId,
    };
    if (this.hint !== undefined) body.hint = this.hint;
    return { error: body };
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

/** Repo-layer NOT_FOUND → the nearest catalog code from the entity name. */
function notFoundCode(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("workspace")) return "WORKSPACE_NOT_FOUND";
  if (lower.includes("project")) return "PROJECT_NOT_FOUND";
  if (lower.includes("version")) return "VERSION_NOT_FOUND";
  if (lower.includes("thread")) return "THREAD_NOT_FOUND";
  if (lower.includes("run")) return "RUN_NOT_FOUND";
  if (lower.includes("asset")) return "ASSET_NOT_FOUND";
  if (lower.includes("render")) return "RENDER_NOT_FOUND";
  if (lower.includes("comment")) return "COMMENT_NOT_FOUND";
  return "NOT_FOUND";
}

/** DbError codes that exist verbatim in the §7.3/§8.9 product catalog. */
const DB_CODE_PASSTHROUGH = new Set<string>([
  "PROJECT_VERSION_CONFLICT",
  "INSUFFICIENT_CREDITS",
  "QUOTA_EXCEEDED",
  "RUN_MODEL_UNAVAILABLE",
  "RUN_INVALID_TOOL",
  "RUN_INVALID_COMMAND",
  "RUN_BATCH_ROLLED_BACK",
  "EDITOR_DISCONNECTED",
  "RENDER_TIMEOUT",
  "VALIDATION_FAILED",
  "FORBIDDEN",
  "RATE_LIMITED",
]);

/** Connection-level Postgres failures the process can observe pre-pool. */
const CONNECTION_ERROR_CODES = new Set<string>([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "57P01", // admin shutdown
]);

export function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    (message.includes("ECONNREFUSED") ||
      message.includes("connection terminated") ||
      message.includes("Connection refused"))
  );
}

/**
 * Map ANY thrown value to a safe §7.3 Err envelope + HTTP status.
 * Original failures are preserved server-side via `cause` only.
 */
export function toErrorEnvelope(
  error: unknown,
  requestId: string,
): {
  status: number;
  envelope: ErrEnvelope;
} {
  if (error instanceof StudioError) {
    const envelope = error.toEnvelope();
    const status = httpStatusFor(error.code);
    return {
      status,
      envelope: requestId === error.requestId ? envelope : withRequestId(envelope, requestId),
    };
  }
  if (isGatewayError(error)) {
    const envelope =
      error.requestId === requestId
        ? error.toEnvelope()
        : withRequestId(error.toEnvelope(), requestId);
    return { status: error.status, envelope };
  }
  if (isDbError(error)) {
    return { status: dbStatus(error), envelope: dbEnvelope(error, requestId) };
  }
  // Zod validation failures at a boundary (defensive — routes use zValidator).
  if (
    typeof error === "object" &&
    error !== null &&
    Array.isArray((error as { issues?: unknown }).issues)
  ) {
    return {
      status: 400,
      envelope: catalogEnvelope("VALIDATION_FAILED", requestId),
    };
  }
  if (isConnectionFailure(error)) {
    // Routes that need the database but cannot reach it — typed 503.
    // FLEET NOTE: SERVICE_UNAVAILABLE is not yet in @studio/config's catalog;
    // ask the config owner to add it (hint text mirrors §14 degraded boot).
    return {
      status: 503,
      envelope: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The database is not reachable right now.",
          hint: "The gateway booted without a live database. Try again once it is up.",
          retryable: true,
          requestId,
        },
      },
    };
  }
  return { status: 500, envelope: catalogEnvelope("INTERNAL", requestId) };
}

function withRequestId(envelope: ErrEnvelope, requestId: string): ErrEnvelope {
  return { error: { ...envelope.error, requestId } };
}

function catalogEnvelope(code: StudioErrorCode, requestId: string): ErrEnvelope {
  return new StudioError(code, { requestId }).toEnvelope();
}

function dbStatus(error: DbError): number {
  if (DB_CODE_PASSTHROUGH.has(error.code)) return error.status;
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "UNAUTHORIZED":
      return 401;
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function dbEnvelope(error: DbError, requestId: string): ErrEnvelope {
  let code: string = error.code;
  let message = error.message;
  let hint = error.hint;
  let retryable = error.retryable;

  switch (error.code) {
    case "NOT_FOUND":
      code = notFoundCode(error.message);
      break;
    case "UNAUTHORIZED":
      code = "AUTH_REQUIRED";
      break;
    case "CONFLICT":
      // keep the repo's safe message ("slug already taken in this workspace")
      break;
    case "VALIDATION_FAILED":
      message = "That request didn't look right.";
      hint = hint ?? "Check the input and try again.";
      break;
    default:
      if (!DB_CODE_PASSTHROUGH.has(error.code)) {
        code = "INTERNAL";
        message = "Something went wrong on our side.";
        hint = "We're on it. Try again in a moment.";
        retryable = true;
      }
  }

  const body: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    hint?: string;
  } = {
    code,
    message,
    retryable,
    requestId,
  };
  if (hint !== undefined) body.hint = hint;
  return { error: body };
}

/** Thrown by handlers to short-circuit with a catalog error. */
export function fail(
  code: StudioErrorCode,
  options?: { message?: string; hint?: string; retryable?: boolean },
): never {
  throw new StudioError(code, options);
}
