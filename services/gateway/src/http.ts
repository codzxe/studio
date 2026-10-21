// @studio/gateway — HTTP helpers: Ok envelope responses, path-param
// extraction and Zod validation at the boundary (§7.2: every route is
// Zod-validated; schemas come from @studio/contracts).

import { okEnvelope, StudioError } from "@studio/config";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { z } from "zod";

import type { AppBindings, AppContext } from "./context.js";
import { GatewayError } from "./errors.js";

/** Respond with the §7.3 Ok envelope. */
export function ok<T>(c: AppContext, data: T, status: 200 | 201 = 200): Response {
  return c.json(okEnvelope(data), status);
}

/**
 * Path params on a plain Context are `string | undefined` (they exist only
 * for the registered route pattern); missing means a routing bug — 404.
 */
export function pathParam(c: AppContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") {
    throw new GatewayError("NOT_FOUND", "Not found.", {
      status: 404,
      requestId: c.get("requestId"),
    });
  }
  return value;
}

/**
 * Zod validation middleware via @hono/zod-validator: on failure the request
 * never reaches the handler — the error boundary renders VALIDATION_FAILED
 * (generic message; the invalid input is never echoed, §7.3).
 */
export function validate<S extends z.ZodType, Target extends "json" | "query">(target: Target, schema: S) {
  return zValidator(target, schema, (result, context) => {
    if (!result.success) {
      const c = context as unknown as Context<AppBindings>;
      throw new StudioError("VALIDATION_FAILED", {
        requestId: c.get("requestId") ?? "req_unknown",
      });
    }
  });
}

/** Cursor-paginated Ok envelope: { data: { items, nextCursor } } (§7.2). */
export function page<T>(c: AppContext, items: readonly T[], nextCursor: string | null): Response {
  return ok(c, { items, nextCursor });
}
