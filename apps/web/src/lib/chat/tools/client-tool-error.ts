/**
 * ClientToolError — the typed failure every client-executed tool throws
 * (round-12 client-driven loop, research/round12-design.md).
 *
 * The OLD executor never threw: it POSTed `{error, message}` bodies to
 * `/v1/runs/:id/events` and the server runner fed them back to the model.
 * The client-driven loop consumes the tool result DIRECTLY, so the executor's
 * contract flips: the happy path RESOLVES with the result; every failure
 * THROWS this error and the chat controller turns `{code, message}` into the
 * tool_result part of the next turn. `code` is a stable UPPER_SNAKE_CASE
 * string the model can reason about (§8.9 vocabulary; never a stack trace,
 * raw response body or internal path).
 */

/** Stable failure codes the executor emits (add-only, like WIRE_ERROR_CODES). */
export type ClientToolErrorCode =
  | "TOOL_FORBIDDEN"
  | "RUN_INVALID_TOOL"
  | "TOOL_FAILED"
  | "TOOL_TIMEOUT"
  | "EDITOR_DISCONNECTED"
  | "UNKNOWN_COMMAND"
  | "WEB_SEARCH_UNAVAILABLE"
  | "IMAGE_GENERATION_UNAVAILABLE"
  | "RENDER_AUDIO_FAILED"
  | "INSUFFICIENT_CREDITS"
  | "RATE_LIMITED";

/** The typed tool failure: `{ code, message }` (pinned by the chat controller). */
export class ClientToolError extends Error {
  readonly code: string;

  constructor(code: ClientToolErrorCode, message: string) {
    super(message);
    this.name = "ClientToolError";
    this.code = code;
  }
}

/** `true` when `value` is a ClientToolError (never a fallback). */
export function isClientToolError(value: unknown): value is ClientToolError {
  return value instanceof ClientToolError;
}
