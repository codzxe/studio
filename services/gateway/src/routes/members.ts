// @studio/gateway — /v1/workspaces/:id/members seam stub (M1.2 gap fix W1-a).
// Integrator pre-mounted this router so W1-a can own the file end-to-end
// without touching the shared app.ts. W1-a REPLACES this stub with the real
// member-management surface (list, role change, remove, transfer ownership)
// and the audit events for role changes/removals. AUD-1: these routes were
// missing entirely from M1.

import { Hono } from "hono";

import type { AppBindings, GatewayDeps } from "../context.js";

export function membersRoutes(_deps: GatewayDeps): Hono<AppBindings> {
  return new Hono<AppBindings>();
}
