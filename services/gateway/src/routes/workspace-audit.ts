// @studio/gateway — GET /v1/workspaces/:id/audit (§7.2, §7.1, §9.1; W3-G2):
// the workspace-wide audit feed behind the M9 settings surface's Audit page.
//
// VIEWER floor — any member reads their workspace's history (§3.3): the same
// resolveWorkspaceContext gate the members/project routes use renders unknown
// workspaces and non-members as 404 (§12.1: existence never leaks; cross-tenant
// is NOT_FOUND, never FORBIDDEN) BEFORE anything repo-shaped runs.
//
// Law #1: this is a UI feed, not compliance data. The repo's joined row
// (repos.audit.listFeed) carries metadata/ip/actorEmail — the DTO mapping here
// strips all three; only AuditEntry fields cross the wire (ids, the actor's
// display name, the action, the target refs and time). Raw rows are the
// admin-only project audit export's surface (routes/activity.ts).
//
// Zod at the boundary: AUDIT_QUERY_SCHEMA (cursor/limit/targetType) parses
// before the repo is touched. The action filter is NOT a wire param (same
// posture as the M7 activity feed — the client filters loaded rows).
//
// Stub-boot degrade: fake-repos boots wire no audit repo — the feed then fails
// with the typed SERVICE_UNAVAILABLE envelope (a silent empty page would look
// like "no history", which is dishonest). Production wires the real repo.

import { Hono } from "hono";

import { AUDIT_QUERY_SCHEMA, type AuditEntry } from "@studio/contracts";
import type { Repos } from "@studio/db";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireAuth, resolveWorkspaceContext } from "../middleware.js";

/** Stub boots wire fake repos without the audit_log table; absence is harness-only. */
function auditRepo(repos: Repos): Repos["audit"] | null {
  const candidate = (repos as Repos & { audit?: Repos["audit"] }).audit;
  if (candidate === undefined || typeof candidate.listFeed !== "function") return null;
  return candidate;
}

/** Feed row as returned by `repos.audit.listFeed` (through Repos). */
type AuditFeedPage = Awaited<ReturnType<Repos["audit"]["listFeed"]>>;
type AuditFeedRow = AuditFeedPage["items"][number];

/** Law-#1 DTO: metadata, ip and actorEmail stay server-side. */
function toDto(entry: AuditFeedRow): AuditEntry {
  return {
    id: entry.id,
    actorId: entry.actorId,
    actorName: entry.actorName,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function workspaceAuditRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/workspaces/*", requireAuth());

  app.get("/v1/workspaces/:id/audit", async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    // §12.1 first: unknown workspace / non-member → 404 before any repo call.
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "viewer");

    const parsed = AUDIT_QUERY_SCHEMA.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
      targetType: c.req.query("targetType") ?? undefined,
    });
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Check the filter and pagination parameters.",
        requestId,
      });
    }

    const audit = auditRepo(deps.repos);
    if (audit === null) {
      throw new GatewayError("SERVICE_UNAVAILABLE", "The audit log is unavailable right now.", {
        status: 503,
        hint: "Try again in a moment.",
        requestId,
      });
    }

    const result = await audit.listFeed(context.id, {
      targetType: parsed.data.targetType,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    return page(c, result.items.map(toDto), result.nextCursor);
  });

  return app;
}
