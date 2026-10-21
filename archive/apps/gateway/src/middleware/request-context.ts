// RequestContext middleware — §22 correlation + prompt-log redaction policy.
//
// §22: every log line for a request carries `request_id` → workspace → run.
// This middleware binds request_id + organization_id + user_id into a
// per-request pino child (replacing the W1-H request logger with a correlated
// one) and exposes `reqCtx` on the Hono context for route handlers.
//
// §22/§15.3 redaction: "log redaction for prompts unless the workspace opts
// in". The workspace opt-in source (workspace settings, §15.3 retention
// preferences) does not exist yet, so `RequestContextOptions.promptLogPolicy`
// is the placeholder seam — the default is fail-closed ("redacted" for every
// workspace). `redactPromptish` is the helper routes must pass bodies through
// before logging (the root logger's static redact paths cover header-level
// secrets; this covers prompt-ish payloads per workspace policy).
//
// Ordering: mount AFTER `requireAuth` (auth-context.ts) so the session's ids
// are available; it still works pre-auth (ids omitted) for health-style routes.
// RECONCILIATION: `src/types.ts` (W1-H) should eventually declare `reqCtx` (and
// `auth`) in `AppEnv.Variables`; until then `RequestCtxAppEnv` is the wiring
// contract.

import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.js";
import type { AuthAppEnv, SessionContext } from "./auth-context.js";

/** Prompt-logging mode per §22: fail-closed "redacted", or opted-in "raw". */
export type PromptLoggingMode = "redacted" | "raw";

/** Correlation + redaction context bound to the request (§22). */
export interface RequestContext {
  readonly request_id: string;
  readonly organization_id: string | undefined;
  readonly user_id: string | undefined;
  /** Redaction policy resolved for this request (§22 / §15.3 placeholder). */
  readonly prompt_logging: PromptLoggingMode;
}

/** Hono env with the `reqCtx` variable that `requestContext()` sets. */
export type RequestCtxAppEnv = AppEnv & {
  Variables: {
    reqCtx: RequestContext;
  };
};

export interface RequestContextOptions {
  /**
   * PLACEHOLDER (§15.3): resolves a workspace's prompt-log opt-in. Defaults to
   * "redacted" for everyone — §22 "unless the workspace opts in", fail-closed.
   * Replace the default with the workspace-settings lookup when §15.3 lands.
   */
  readonly promptLogPolicy?: (session: SessionContext | undefined) => PromptLoggingMode;
}

const defaultPromptLogPolicy: NonNullable<RequestContextOptions["promptLogPolicy"]> = () =>
  "redacted";

/**
 * Bind §22 correlation ids into the per-request logger child and expose
 * `reqCtx`. Runs after `requireAuth`; reads the session defensively so it also
 * suits unauthenticated routes (organization_id/user_id then stay undefined).
 */
export function requestContext<E extends RequestCtxAppEnv>(
  options: RequestContextOptions = {}
): MiddlewareHandler<E> {
  const promptLogPolicy = options.promptLogPolicy ?? defaultPromptLogPolicy;
  return createMiddleware<E>(async (c, next) => {
    const request_id = c.get("requestId");
    // Set by requireAuth (auth-context.ts). The double cast is needed only
    // because `reqCtx` and `auth` live in different env declarations; once
    // `src/types.ts` declares both, this is a plain `c.get("auth")`.
    const authContext = c as unknown as Context<AuthAppEnv>;
    const session: SessionContext | undefined = authContext.get("auth");
    const organization_id = session?.organizationId;
    const user_id = session?.userId;
    const bindings: Record<string, string> = { request_id };
    if (organization_id !== undefined) {
      bindings.organization_id = organization_id;
    }
    if (user_id !== undefined) {
      bindings.user_id = user_id;
    }
    c.set("logger", c.get("logger").child(bindings));
    c.set("reqCtx", {
      request_id,
      organization_id,
      user_id,
      prompt_logging: promptLogPolicy(session)
    });
    await next();
  });
}

/** Marker substituted for prompt-ish field values (§22 redaction). */
export const REDACTED_MARKER = "[redacted]";

/** Marker for values deeper than the redaction recursion cap (cycle-safe). */
const TRUNCATED_MARKER = "[truncated]";

/**
 * Prompt-ish keys redacted from logs (§22). Exact-matched, case-insensitive,
 * and intentionally over-broad: strings like `text`/`content` catch command
 * payloads whose strings are user data (§5.7 "user text is data"). Matched
 * fields are redacted whole — over-redaction is the safe direction (§15.2:
 * secrets never in logs).
 */
export const PROMPTISH_KEYS: readonly string[] = [
  "prompt",
  "system_prompt",
  "system",
  "instructions",
  "instruction",
  "brief",
  "message",
  "messages",
  "input",
  "content",
  "contents",
  "text",
  "query",
  "attachment",
  "attachments",
  "negative_prompt",
  "image_prompt"
];

const PROMPTISH_KEY_SET = new Set(PROMPTISH_KEYS.map((key) => key.toLowerCase()));
const MAX_REDACT_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-redact prompt-ish fields from a JSON-shaped value (§22). Returns a
 * sanitized copy — the input is never mutated. In "raw" mode (workspace
 * opted in) the value passes through untouched. Exotic instances (Date etc.)
 * pass through as-is; the depth cap makes cyclic values cycle-safe.
 */
export function redactPromptish<T>(value: T, mode: PromptLoggingMode): T {
  if (mode === "raw") {
    return value;
  }
  return redactNode(value, 0) as T;
}

function redactNode(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return TRUNCATED_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = PROMPTISH_KEY_SET.has(key.toLowerCase())
        ? REDACTED_MARKER
        : redactNode(child, depth + 1);
    }
    return out;
  }
  return value;
}
