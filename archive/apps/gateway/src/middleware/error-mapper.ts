// Error mapping middleware — every failure leaves the box as a typed envelope
// (§13.3: stable string codes, human-safe messages, NEVER a stack trace, an
// absolute path or an internal id).
//
// Envelope shape (W1-H task + docs/AGENTS.md code style):
//   { ok: false, code, message, hint?, retryable, docs_url?, details? }
// NOTE(§13.3): the spec's wire example nests these fields under `error: { … }`.
// AGENTS.md mandates the flat `ok:false` shape for repo-wide code style, and
// W1-H was scoped to the flat envelope — the API-contract wave should
// reconcile the two before the public API is documented externally.
//
// HTTP mapping: ZodError → 422 `validation_failed` (per W1-H; §13.3 lists 400
// for validation — reconcile in the contract wave), AppError → its own status,
// Hono HttpException → its status, anything else → 500 `internal_error` with a
// generic message (the real error goes to logs, which already carry stacks).

import type { MiddlewareHandler, NotFoundHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { HttpException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import { ZodError } from "zod";
import type { AppEnv } from "../types.js";

/** One field-level problem from a ZodError. `path` is a field path — never user data. */
export interface ValidationDetail {
  readonly path: string;
  readonly message: string;
}

/** Typed error envelope per AGENTS.md code style (§13.3 codes are stable strings). */
export interface ErrorEnvelope {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly docs_url: string | undefined;
  readonly details: readonly ValidationDetail[] | undefined;
}

/** Error thrown on purpose by gateway code. Routes (W2+) use this for all typed failures. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly docsUrl: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { hint?: string; retryable?: boolean; docsUrl?: string; cause?: unknown }
  ) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.hint = options?.hint;
    this.retryable = options?.retryable ?? false;
    this.docsUrl = options?.docsUrl;
  }
}

/** Stable codes for statuses that can be raised without an AppError (§13.3). */
function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 402:
      return "payment_required";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    case 501:
      return "not_implemented";
    case 503:
      return "service_unavailable";
    default:
      return `http_${status}`;
  }
}

interface MappedError {
  // Hono >=4.5 types JSON status args as a literal union (ContentfulStatusCode),
  // so the mapped status is narrowed to it once, here, at the source.
  readonly status: ContentfulStatusCode;
  readonly envelope: ErrorEnvelope;
}

/** Turn any thrown value into a status + client-safe envelope. */
function mapError(error: unknown): MappedError {
  if (error instanceof AppError) {
    return {
      status: error.status as ContentfulStatusCode,
      envelope: {
        ok: false,
        code: error.code,
        message: error.message,
        hint: error.hint,
        retryable: error.retryable,
        docs_url: error.docsUrl,
        details: undefined
      }
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 422,
      envelope: {
        ok: false,
        code: "validation_failed",
        message: "Request validation failed.",
        hint: "Fix the listed fields and retry.",
        retryable: true,
        docs_url: undefined,
        details: error.issues.map((issue) => ({
          path: issue.path.map((segment) => String(segment)).join("."),
          message: issue.message
        }))
      }
    };
  }
  if (error instanceof HttpException) {
    return {
      status: error.status as ContentfulStatusCode,
      envelope: {
        ok: false,
        code: codeForStatus(error.status),
        // HttpException messages are developer-set (Hono defaults are safe: "Unauthorized" etc.).
        message: error.message,
        hint: undefined,
        retryable: error.status >= 500,
        docs_url: undefined,
        details: undefined
      }
    };
  }
  // Anything else is unexpected: generic message only — details go to logs (§13.3).
  return {
    status: 500,
    envelope: {
      ok: false,
      code: "internal_error",
      message: "Internal server error.",
      hint: undefined,
      retryable: true,
      docs_url: undefined,
      details: undefined
    }
  };
}

/**
 * Catch-all middleware. Register FIRST (outermost) so it also covers failures
 * in the request-id/logger middleware. Full error detail is written to the
 * request logger (which pino serializes with a stack — logs only, §13.3).
 */
export function errorMapper(log: Logger): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    try {
      await next();
    } catch (error) {
      const { status, envelope } = mapError(error);
      const fields = { status, code: envelope.code, method: c.req.method, path: c.req.path };
      if (status >= 500) {
        log.error(fields, "request_failed");
      } else {
        log.warn(fields, "request_failed");
      }
      return c.json(envelope, status);
    }
  });
}

/** 404 envelope for anything that matches no route and no catch-all. */
export function notFoundHandler(log: Logger): NotFoundHandler<AppEnv> {
  return (c) => {
    log.debug({ method: c.req.method, path: c.req.path }, "route_not_found");
    const envelope: ErrorEnvelope = {
      ok: false,
      code: "not_found",
      message: "Route not found.",
      hint: "Check the method and path against the API contract (spec §13.1).",
      retryable: false,
      docs_url: undefined,
      details: undefined
    };
    return c.json(envelope, 404);
  };
}
