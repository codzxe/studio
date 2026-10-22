// @studio/gateway — /v1/projects/:id/activity + /audit-export (§7.1, §7.2,
// §9.1 audit_log): the user-facing project feed and the admin-only export.
//
// FEED (viewer): every audit row recorded against the project OR any of its
// versions — project-targeted events (project.*, version.uploaded,
// run.applied, comment.*) plus version-targeted events (version.restored,
// version.labeled) resolved through the version join
// (repos/audit.listForProject). Each entry carries actor name, action, target
// and time; internal data (emails, metadata, ips) never crosses into it.
//
// EXPORT (admin only): the raw audit_log surface for this project as a bounded
// JSON download (Content-Disposition: attachment). Law-#1 nuance: ids, actor
// emails, recorded metadata and request ips are allowed HERE — an audit export
// is compliance DATA for workspace admins, not UI copy.

import { Hono } from "hono";

import {
  type ActivityEntry,
  type AuditExportRow,
  PAGINATION_QUERY_SCHEMA,
} from "@studio/contracts";

import type { Repos } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";

/** Audit feed row as returned by `repos.audit.listForProject` (through Repos). */
type AuditFeedPage = Awaited<ReturnType<Repos["audit"]["listForProject"]>>;
type AuditFeedRow = AuditFeedPage["items"][number];

export function activityRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  /**
   * Feed entry (M7 task 4). `projectId` is the project whose feed was
   * requested — every merged row is scoped to it by the repo's union (rows
   * targeting the project itself, or rows targeting one of its versions).
   */
  const toDto = (entry: AuditFeedRow, projectId: string): ActivityEntry => ({
    id: entry.id,
    projectId,
    actorId: entry.actorId ?? "",
    actorName: entry.actorName,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    createdAt: entry.createdAt.toISOString(),
  });

  /** Export row (M7 task 4): the raw audit surface — admin-only data. */
  const toExportRow = (entry: AuditFeedRow): AuditExportRow => ({
    id: entry.id,
    actorId: entry.actorId,
    actorName: entry.actorName,
    // Law-#1 nuance: emails are compliance data in the admin EXPORT, never UI copy.
    actorEmail: entry.actorEmail,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? null,
    ip: entry.ip,
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
      const projectId = pathParam(c, "id");
      // The project must exist in this workspace (repo: cross-tenant → 404).
      await deps.repos.projects.get(workspaceId, projectId);
      const result = await deps.repos.audit.listForProject(workspaceId, projectId, {
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      return page(
        c,
        result.items.map((entry) => toDto(entry, projectId)),
        result.nextCursor,
      );
    },
  );

  app.get(
    "/v1/projects/:id/audit-export",
    requireWorkspace("admin"),
    async (c: AppContext): Promise<Response> => {
      const workspaceId = c.get("workspace").id;
      const projectId = pathParam(c, "id");
      // Tenant gate before any export row is read (§12.1: cross-tenant → 404).
      await deps.repos.projects.get(workspaceId, projectId);
      const result = await deps.repos.audit.exportForProject(workspaceId, projectId);
      const rows = result.rows.map(toExportRow);
      // Bounded, newest-first download. The filename carries the project id —
      // allowed in this admin-only surface, and sanitized against header
      // injection from hostile path params.
      const safeFileId = projectId.replace(/[^a-zA-Z0-9_-]/g, "") || "project";
      c.header("content-disposition", `attachment; filename="studio-audit-${safeFileId}.json"`);
      return ok(c, {
        projectId,
        generatedAt: new Date().toISOString(),
        maxRows: result.maxRows,
        rowCount: rows.length,
        truncated: result.truncated,
        rows,
      });
    },
  );

  return app;
}
