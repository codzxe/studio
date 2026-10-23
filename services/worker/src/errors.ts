// @studio/worker — typed render failure codes + sanitized copy (law #1).
//
// The worker NEVER forwards effectcraft-cli error text (it may contain absolute
// paths and engine internals — docs/phases/m8-cli-spike.md §3) or object keys
// across any boundary. Every failure maps to ONE of these codes; the human copy
// comes from @studio/config's ERROR_CATALOG (the same sentences the API
// envelope serves), so the worker's `renders.error` text is already wire-safe.

import { ERROR_CATALOG } from "@studio/config";

/**
 * Failure codes the render pipeline can terminal-transition a job with.
 * All exist in @studio/config's catalog (RENDER_UNSUPPORTED_FORMAT and
 * RENDER_CANCELLED are queue/cancel-time codes used by the API layer; the
 * worker's defensive D-2 format guard reuses the former).
 */
export type RenderFailureCode =
  | "RENDER_UNSUPPORTED_FORMAT"
  | "RENDER_TIMEOUT"
  | "RENDER_CLI_MISSING"
  | "RENDER_CLI_FAILED"
  | "RENDER_PROJECT_INVALID"
  | "RENDER_ASSET_MISSING"
  | "RENDER_INTERNAL";

/**
 * The sanitized human sentence for a failure code — catalog copy, never the
 * underlying cause. Safe to persist on the render row (`renders.error`) and to
 * serve on the wire verbatim.
 */
export function failureText(code: RenderFailureCode): string {
  return ERROR_CATALOG[code].message;
}

/**
 * Typed pipeline failure. `message` is ALWAYS the sanitized catalog sentence;
 * the raw cause (CLI stderr, storage path, …) stays in the worker log via
 * `cause` and is never persisted or returned.
 */
export class RenderJobError extends Error {
  readonly code: RenderFailureCode;
  readonly raw?: string;

  constructor(code: RenderFailureCode, options?: { raw?: string }) {
    super(failureText(code));
    this.name = "RenderJobError";
    this.code = code;
    this.raw = options?.raw;
  }
}

export function isRenderJobError(error: unknown): error is RenderJobError {
  return error instanceof RenderJobError;
}
