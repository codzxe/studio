// Request correlation middleware (§22 observability: `request_id` → workspace → run).
//
// Accepts a client-supplied `X-Request-Id` (validated — length/charset — so we
// never echo header-injection noise into logs) or generates a uuid. The id is
// stored on the Hono context for the logger and echoed on every response.

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../types.js";

export const REQUEST_ID_HEADER = "x-request-id";

// Keep it strict but friendly to common trace-id formats (no spaces, no control chars).
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Generate or adopt the request id and echo it back on the response. */
export function requestId(): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER) ?? "";
    const id = REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    c.set("requestId", id);
    // Set before next() so every response — including errors — carries the id.
    c.header(REQUEST_ID_HEADER, id);
    await next();
  });
}
