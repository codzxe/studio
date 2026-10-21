// @studio/gateway — /v1/projects/:id/comments (§7.2, §9.1, §11):
// comp/layer/time-anchored review notes. Commenting is a viewer-level
// capability (ADR-0003 RBAC), so every member can read AND post.

import { Hono } from "hono";

import { COMMENTS_QUERY_SCHEMA, CREATE_COMMENT_SCHEMA, type Comment as CommentDto } from "@studio/contracts";

import { ok, page, pathParam } from "../http.js";
import { GatewayError } from "../errors.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { audit } from "./projects.js";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import type { Comment } from "@studio/db";

export function commentsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  const toDto = (comment: Comment): CommentDto => ({
    id: comment.id,
    projectId: comment.projectId,
    compId: comment.compId,
    layerId: comment.layerId,
    timeTicks: comment.timeTicks,
    body: comment.body,
    authorId: comment.authorId,
    resolvedAt: comment.resolvedAt !== null ? comment.resolvedAt.toISOString() : null,
    createdAt: comment.createdAt.toISOString(),
  });

  app.get("/v1/projects/:id/comments", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const parsed = COMMENTS_QUERY_SCHEMA.safeParse({
      compId: c.req.query("compId"),
      resolved: c.req.query("resolved"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Check the query parameters.",
        requestId: c.get("requestId"),
      });
    }
    const workspaceId = c.get("workspace").id;
    const result = await deps.repos.comments.list(workspaceId, pathParam(c, "id"), {
      resolved: parsed.data.resolved,
      cursor: parsed.data.cursor ?? null,
      limit: parsed.data.limit,
    });
    // NOTE: compId filtering is client-side in v1 (the repo paginates the
    // whole project thread — projects are small in practice).
    const items = parsed.data.compId === undefined ? result.items : result.items.filter((comment) => comment.compId === parsed.data.compId);
    return page(c, items.map(toDto), result.nextCursor);
  });

  app.post("/v1/projects/:id/comments", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    const parsed = CREATE_COMMENT_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Anchor the comment to a compId and write 1-2000 characters.",
        requestId: c.get("requestId"),
      });
    }
    const comment = await deps.repos.comments.create(workspace.id, {
      projectId: pathParam(c, "id"),
      compId: parsed.data.compId,
      layerId: parsed.data.layerId ?? null,
      timeTicks: parsed.data.timeTicks ?? null,
      body: parsed.data.body,
      authorId: c.get("auth").user.id,
    });
    await audit(deps, c, workspace.id, "comment.created", comment.projectId, { commentId: comment.id });
    return ok(c, toDto(comment), 201);
  });

  return app;
}
