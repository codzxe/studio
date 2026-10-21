// @studio/gateway — /v1/projects/:id/lease (§7.2, §9.3, §11): the
// single-writer lease. Acquire = renew (same body); the loser opens
// read-only until the lease is released or expires (2-min heartbeat,
// 5-min TTL from @studio/db lease-logic).

import { Hono } from "hono";

import { ACQUIRE_LEASE_SCHEMA } from "@studio/contracts";

import { ok, pathParam } from "../http.js";
import { GatewayError } from "../errors.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { audit } from "./projects.js";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";

export function leasesRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  app.post("/v1/projects/:id/lease", requireWorkspace("editor"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    const parsed = ACQUIRE_LEASE_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Send the editor session id (8-128 chars) as sessionId.",
        requestId: c.get("requestId"),
      });
    }

    const result = await deps.repos.leases.acquire(workspace.id, pathParam(c, "id"), {
      userId: c.get("auth").user.id,
      sessionId: parsed.data.sessionId,
      ttlMs: deps.env.lease.ttlMs,
    });

    const holderName =
      result.holderId === c.get("auth").user.id
        ? c.get("auth").user.name
        : (workspace.members.find((member) => member.userId === result.holderId)?.userName ?? result.holderId);

    if (result.acquired) {
      await audit(deps, c, workspace.id, "lease.acquired", pathParam(c, "id"), {
        expiresAt: result.expiresAt.toISOString(),
      });
    }
    return ok(c, {
      acquired: result.acquired,
      holderName,
      expiresAt: result.expiresAt.toISOString(),
      // §9.3: a refused acquire means the caller opens read-only.
      readOnly: !result.acquired,
    });
  });

  app.delete("/v1/projects/:id/lease", requireWorkspace("editor"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    const result = await deps.repos.leases.release(workspace.id, pathParam(c, "id"), {
      userId: c.get("auth").user.id,
    });
    if (result.released) {
      await audit(deps, c, workspace.id, "lease.released", pathParam(c, "id"));
    }
    return ok(c, { released: result.released });
  });

  return app;
}
