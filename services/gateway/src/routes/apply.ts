// services/gateway/src/routes/apply.ts — agent plan apply/undo endpoints
// (BUILD_PLAN §M5.4/§M5.5; M5-SEAMS pinned interface).
//
// STUB — M5-E owns this file in Wave 1 and replaces this content with the
// real implementation. The mount in app.ts is pre-wired (do not re-add).
import { Hono } from "hono";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";

/** POST /v1/runs/:id/apply + POST /v1/runs/:id/undo (M5-SEAMS). */
export function applyRoutes(_deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.all("/v1/runs/:id/apply", (c: AppContext): Response =>
    // M5-E: replace with the real apply flow (stub responds 501 until then).
    c.json({ ok: false, error: { code: "NOT_IMPLEMENTED" } }, 501),
  );
  app.all("/v1/runs/:id/undo", (c: AppContext): Response =>
    c.json({ ok: false, error: { code: "NOT_IMPLEMENTED" } }, 501),
  );
  return app;
}
