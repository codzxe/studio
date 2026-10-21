// @studio/api-client — typed failure for every client call (PRODUCT_ARCHITECTURE §7.3).
//
// The server speaks the §7.3 envelope: Err = { error: { code, message, hint?,
// retryable, requestId } }. `ApiError` is the client-side materialization of
// that body (plus the HTTP status). Beyond the wire codes, the client adds a
// small, documented set of CLIENT-LOCAL codes for failures that never got a
// §7.3 body (network down, non-envelope body, client-side request validation,
// signed-URL upload):
//
//   NETWORK_ERROR       fetch rejected before a response arrived (status 0)
//   MALFORMED_RESPONSE  2xx body was not a §7.3 envelope or failed schema
//                       validation (status = the HTTP status)
//   UPLOAD_FAILED       direct PUT to a signed URL failed (storage, not enveloped)
//   VALIDATION_FAILED   request rejected client-side before sending (status 0)
//
// Safety (§7.3): raw response text NEVER reaches `message`/`hint` — only the
// parsed envelope fields are surfaced; unparseable bodies map to generic,
// safe strings. `cause` keeps the original failure for logging, and `toJSON()`
// serializes the safe fields only.

import { type Err, isErr } from "@studio/contracts";

/** HTTP status `0` marks a client-local failure (no §7.3 body exists). */
export const CLIENT_SIDE_STATUS = 0;

/** Everything needed to raise a typed API failure. */
export interface ApiErrorInit {
  /** Stable §7.3 wire code or one of the documented client-local codes. */
  readonly code: string;
  /** Human message, safe to show. */
  readonly message: string;
  /** HTTP status; `0` for client-local failures. */
  readonly status: number;
  /** Actionable next step, safe to show. */
  readonly hint?: string;
  /** Safe to retry the same request (after a pause)? Default `false`. */
  readonly retryable?: boolean;
  /** Correlation id; generated when absent. */
  readonly requestId?: string;
  /** Original failure — for logs only, never serialized. */
  readonly cause?: unknown;
}

/** Minimal `Response` surface `fromResponse` needs (works with fakes). */
export interface ApiHttpResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly text: () => Promise<string>;
}

/** Request id shape mirrors @studio/config `newRequestId()` (`req_` + 32 hex). */
function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Typed error thrown by every api-client call (and surfaced by the SSE reader). */
export class ApiError extends Error {
  /** Stable error code (§7.3 wire code or a documented client-local code). */
  readonly code: string;
  /** Actionable next step, safe to show. */
  readonly hint: string | undefined;
  /** Safe to retry the same request (after a pause)? */
  readonly retryable: boolean;
  /** Correlates with server logs (from the envelope, or client-generated). */
  readonly requestId: string;
  /** HTTP status; `0` for client-local failures. */
  readonly status: number;

  constructor(init: ApiErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "ApiError";
    this.code = init.code;
    this.hint = init.hint;
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId ?? newRequestId();
    this.status = init.status;
  }

  /**
   * Safe serialization for logs/telemetry: the §7.3 body plus `status`.
   * Stack, cause and raw response text are never included.
   */
  toJSON(): {
    code: string;
    message: string;
    hint?: string;
    retryable: boolean;
    requestId: string;
    status: number;
  } {
    const out: {
      code: string;
      message: string;
      hint?: string;
      retryable: boolean;
      requestId: string;
      status: number;
    } = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requestId: this.requestId,
      status: this.status,
    };
    if (this.hint !== undefined) out.hint = this.hint;
    return out;
  }
}

/** Type guard for `ApiError` at call sites and boundaries. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Status → generic code mapping (used only when the body is not a §7.3 Err)
// ---------------------------------------------------------------------------

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "PROJECT_VERSION_CONFLICT",
  429: "RATE_LIMITED",
};

const STATUS_MESSAGES: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: "That request didn't look right.",
  UNAUTHORIZED: "Sign in to continue.",
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: "Not found.",
  PROJECT_VERSION_CONFLICT: "This changed while you were working.",
  RATE_LIMITED: "Too many requests. Slow down for a moment, then retry.",
  INTERNAL_ERROR: "Something went wrong on our side.",
};

const GENERIC_HINTS: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: "Check the input and try again.",
  UNAUTHORIZED: "Your session may have expired.",
  FORBIDDEN: "Ask a workspace admin for access.",
  NOT_FOUND: "Check the link, or refresh the list.",
  PROJECT_VERSION_CONFLICT: "Open the latest version, or restore yours from history.",
  RATE_LIMITED: "Slow down for a moment, then retry.",
  INTERNAL_ERROR: "We're on it. Try again in a moment.",
};

function genericCodeFor(status: number): string {
  return STATUS_CODES[status] ?? "INTERNAL_ERROR";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Builds the typed failure from an HTTP response. Prefers the §7.3 `error`
 * body verbatim (code/message/hint/retryable/requestId); falls back to a
 * generic, safe mapping when the body is missing, unparseable or not an
 * envelope — raw body text is never included.
 */
export async function fromResponse(response: ApiHttpResponse): Promise<ApiError> {
  const { status } = response;
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  let parsed: unknown = undefined;
  if (bodyText !== "") {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
  }

  if (parsed !== undefined && isErr(parsed)) {
    const error: Err["error"] = parsed.error;
    return new ApiError({
      code: error.code,
      message: error.message,
      hint: error.hint,
      retryable: error.retryable,
      requestId: error.requestId,
      status,
      cause: parsed,
    });
  }

  const code = genericCodeFor(status);
  return new ApiError({
    code,
    message: STATUS_MESSAGES[code] ?? STATUS_MESSAGES.INTERNAL_ERROR ?? "",
    hint: GENERIC_HINTS[code],
    retryable: isRetryableStatus(status),
    status,
    cause: bodyText === "" ? undefined : { unparsed: true },
  });
}

// ---------------------------------------------------------------------------
// Client-local constructors (internal surfaces; documented codes)
// ---------------------------------------------------------------------------

/** fetch rejected before a response arrived — never a §7.3 body on the wire. */
export function networkError(cause: unknown): ApiError {
  return new ApiError({
    code: "NETWORK_ERROR",
    message: "Could not reach the server.",
    hint: "Check your connection, then try again.",
    retryable: true,
    status: CLIENT_SIDE_STATUS,
    cause,
  });
}

/** 2xx body was not a §7.3 envelope, or envelope data failed schema validation. */
export function malformedResponseError(status: number, cause?: unknown): ApiError {
  return new ApiError({
    code: "MALFORMED_RESPONSE",
    message: "The server returned a malformed response.",
    hint: "Try again in a moment.",
    retryable: true,
    status,
    cause,
  });
}

/** Request body failed client-side validation — never sent. */
export function invalidRequestError(cause: unknown): ApiError {
  return new ApiError({
    code: "VALIDATION_FAILED",
    message: "That request didn't look right.",
    hint: "Check the input and try again.",
    retryable: false,
    status: CLIENT_SIDE_STATUS,
    cause,
  });
}

/** The direct PUT to a signed upload URL failed (object storage, not enveloped). */
export function uploadFailedError(status: number, cause?: unknown): ApiError {
  return new ApiError({
    code: "UPLOAD_FAILED",
    message: "The upload did not complete.",
    hint: "Retry the upload; the server keeps it idempotent.",
    retryable: true,
    status,
    cause,
  });
}
