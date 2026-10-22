// @studio/gateway — /v1/projects/:id/activity (§7.2, §7.1 audit_log):
// the user-facing project feed. actorName is null in v1 (the audit table
// stores actor ids; a user join lands with the observability wave).

import { Hono } from "hono";

import { type ActivityEntry, PAGINATION_QUERY_SCHEMA } from "@studio/contracts";

import type { AuditLogEntry } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { page, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";

export function activityRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  const toDto = (entry: AuditLogEntry): ActivityEntry => ({
    id: entry.id,
    projectId: entry.targetType === "project" ? entry.targetId : null,
    actorId: entry.actorId ?? "",
    actorName: null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    createdAt: entry.createdAt.toISOString(),
  });

  app.get(
    "/v1/projects/:id/activity",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const parsed = PAGINATION_QUERY_SCHEMA.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Check the pagination parameters.",
          requestId: c.get("requestId"),
        });
      }
      const workspaceId = c.get("workspace").id;
      // The project must exist in this workspace (repo: cross-tenant → 404).
      await deps.repos.projects.get(workspaceId, pathParam(c, "id"));
      const result = await deps.repos.audit.list(workspaceId, {
        targetId: pathParam(c, "id"),
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      return page(c, result.items.map(toDto), result.nextCursor);
    },
  );

  return app;
}
