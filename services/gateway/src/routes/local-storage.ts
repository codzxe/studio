// @studio/gateway — /v1/local-storage/:token (LocalFSDriver signing target).
//
// Only mounted when the LocalFS storage driver is active (APP_ENV=local).
// Signed URLs are unguessable random tokens bound to (key, method) with a
// TTL — the §9.2 audience rule in miniature. No cookies, no CORS headers:
// these URLs are consumed directly by the editor/curl, same rules as S3
// presigned URLs.

import { Hono } from "hono";

import type { AppBindings, GatewayDeps } from "../context.js";
import { pathParam } from "../http.js";

export function localStorageRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const local = deps.local;

  app.get("/v1/local-storage/:token", async (c): Promise<Response> => {
    if (local === null) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false, requestId: c.get("requestId") } }, 404);
    }
    const key = local.tokens.consume(pathParam(c, "token"), "GET");
    if (key === null) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false, requestId: c.get("requestId") } }, 404);
    }
    const bytes = await local.read(key);
    if (bytes === null) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false, requestId: c.get("requestId") } }, 404);
    }
    return c.body(new Uint8Array(bytes), 200, { "content-type": "application/octet-stream" });
  });

  app.put("/v1/local-storage/:token", async (c): Promise<Response> => {
    if (local === null) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false, requestId: c.get("requestId") } }, 404);
    }
    const key = local.tokens.consume(pathParam(c, "token"), "PUT");
    if (key === null) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false, requestId: c.get("requestId") } }, 404);
    }
    // Stream the request body straight to disk (no double buffering).
    await local.put(key, c.req.raw.body as ReadableStream<Uint8Array>);
    return c.body(null, 200);
  });

  return app;
}
