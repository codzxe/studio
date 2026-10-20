// Request logging middleware (§22 observability).
//
// Every log line carries the request id (child logger) plus method/path/status/
// duration. Redaction is configured once at the root logger (bootstrap) using
// this exported path list: §22 "log redaction for prompts unless the workspace
// opts in", and §15.2 "secrets … never in logs". Paths that don't exist on a
// given log line are simply skipped by pino's redactor.

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { Logger } from "pino";
import type { AppEnv } from "../types.js";

/** pino `redact.paths` for the root gateway logger (§22 prompts, §15.2 secrets). */
export const REQUEST_LOG_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["x-idempotency-key"]',
  'req.headers["stripe-signature"]',
  "prompt",
  "req.body.prompt",
  "body.prompt",
  "attachments",
  "req.body.attachments"
];

/**
 * Attach a request-scoped child logger (requestId bound, §22 correlation) and
 * emit one line per completed request.
 */
export function requestLogger(root: Logger): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const start = performance.now();
    const log = root.child({ request_id: c.get("requestId") });
    c.set("logger", log);
    await next();
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    // c.req.path excludes the query string — never log query params (tokens/ids).
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: durationMs
    };
    if (c.res.status >= 500) {
      log.error(fields, "http_request");
    } else {
      log.info(fields, "http_request");
    }
  });
}
