/**
 * Normalized bridge errors (task W1-d).
 *
 * Every failure surfaced by this package is a `BridgeError` with a stable code, so
 * product code can branch on `err.code` instead of parsing editor error strings.
 */

export type BridgeErrorCode =
  /** A call exceeded its timeout (default 15 s, batch cap 60 s). Always retryable. */
  | "EDITOR_TIMEOUT"
  /** The editor answered with an error (command failed, bad params, parse mismatch). */
  | "EDITOR_CALL_FAILED"
  /** `window.effectcraft` missing / not yet started, or a "not ready" rejection persisted after retry. */
  | "EDITOR_NOT_READY"
  /** The editor's wasm failed to boot: the host page set `effectcraftLoad.error` (dist `index.html`). Not retryable by the bridge — reload the iframe. */
  | "EDITOR_LOAD_FAILED"
  /** The iframe's window is gone (navigated away, removed, or the bridge was disposed). */
  | "EDITOR_DISCONNECTED";

const CODES: readonly BridgeErrorCode[] = [
  "EDITOR_TIMEOUT",
  "EDITOR_CALL_FAILED",
  "EDITOR_NOT_READY",
  "EDITOR_LOAD_FAILED",
  "EDITOR_DISCONNECTED",
];

export interface BridgeErrorOptions {
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  // `declare`: the field is set by `super(message, { cause })` — a real field
  // declaration would overwrite it with `undefined` (useDefineForClassFields).
  declare readonly cause?: unknown;

  constructor(code: BridgeErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, { cause });
    this.name = "BridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}

export function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === "string" && (CODES as readonly string[]).includes(value);
}

/** Extract a message from upstream rejections, which are plain strings (api.rs rejects with a `JsValue::from_str`). */
export function messageOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && "message" in value) {
    const m = (value as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
