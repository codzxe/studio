// @studio/gateway — GET /health + /v1/health (§14 degraded boot).
//
// Always 200 with capability flags: { status: "ok", db: boolean, version }.
// The gateway boots without a reachable database; routes that need it
// return the typed SERVICE_UNAVAILABLE envelope.

import { Hono } from "hono";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";

export function healthRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  async function health(c: AppContext): Promise<Response> {
    let db = false;
    try {
      db = await deps.dbHealth();
    } catch {
      db = false;
    }
    return c.json({ status: "ok", db, version: deps.version });
  }

  app.get("/health", (c) => health(c));
  app.get("/v1/health", (c) => health(c));
  return app;
}
