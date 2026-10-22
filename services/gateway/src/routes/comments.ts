// @studio/gateway — comments (§7.2, §9.1, §11; BUILD_PLAN §M7 task 1):
//   GET  /v1/projects/:id/comments   — flat threaded list (D-15: compId,
//                                       resolved, cursor, limit query params)
//   POST /v1/projects/:id/comments   — create (member)
//   POST /v1/comments/:id/replies    — reply (member; depth ≤ 3)
//   POST /v1/comments/:id/resolve    — resolve/reopen (member; idempotent)
// Commenting is a viewer-level capability (ADR-0003 RBAC): every member can
// read, post, reply and resolve. The PUBLIC guest surface lives on M7-E's
// share routes — `createGuestComment` below is the handler M7-E mounts.

import { Hono } from "hono";

import { StudioError } from "@studio/config";
import {
  COMMENT_REPLY_SCHEMA,
  COMMENTS_QUERY_SCHEMA,
  CREATE_COMMENT_SCHEMA,
  GUEST_COMMENT_SCHEMA,
  RESOLVE_COMMENT_SCHEMA,
  type Comment as CommentDto,
} from "@studio/contracts";

import type { Comment } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { clientIp, requireAuth, requireWorkspace } from "../middleware.js";
import type { RouteClass } from "../rate-limit.js";
import { audit } from "./projects.js";

/** DB row → §7.2 DTO (guest rows keep null authorId + the guest fields). */
function toDto(comment: Comment): CommentDto {
  return {
    id: comment.id,
    projectId: comment.projectId,
    compId: comment.compId,
    layerId: comment.layerId,
    timeTicks: comment.timeTicks,
    parentCommentId: comment.parentId,
    body: comment.body,
    authorId: comment.authorId,
    guestName: comment.guestName,
    guestEmail: comment.guestEmail,
    resolvedAt: comment.resolvedAt !== null ? comment.resolvedAt.toISOString() : null,
    resolvedBy: comment.resolvedBy,
    createdAt: comment.createdAt.toISOString(),
  };
}

export function commentsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());
  app.use("/v1/comments/*", requireAuth());

  app.get(
    "/v1/projects/:id/comments",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
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
      // D-15: the compId filter is a SERVER-side query parameter (the repo
      // filters before pagination; the list stays a flat thread view).
      const result = await deps.repos.comments.listThreaded(workspaceId, pathParam(c, "id"), {
        compId: parsed.data.compId,
        resolved: parsed.data.resolved,
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      return page(c, result.items.map(toDto), result.nextCursor);
    },
  );

  app.post(
    "/v1/projects/:id/comments",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
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
      await audit(deps, c, workspace.id, "comment.created", comment.projectId, {
        commentId: comment.id,
      });
      return ok(c, toDto(comment), 201);
    },
  );

  app.post(
    "/v1/comments/:id/replies",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const parsed = COMMENT_REPLY_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Write a reply of 1-2000 characters.",
          requestId: c.get("requestId"),
        });
      }
      const commentId = pathParam(c, "id");
      const reply = await deps.repos.comments.createReply(workspace.id, {
        commentId,
        body: parsed.data.body,
        authorId: c.get("auth").user.id,
      });
      await audit(deps, c, workspace.id, "comment.replied", reply.projectId, {
        commentId: reply.id,
        parentCommentId: reply.parentId,
      });
      return ok(c, toDto(reply), 201);
    },
  );

  app.post(
    "/v1/comments/:id/resolve",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const commentId = pathParam(c, "id");
      const parsed = RESOLVE_COMMENT_SCHEMA.safeParse(
        (await c.req.json().catch(() => null)) ?? {},
      );
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Send an empty body to resolve, or { \"resolved\": false } to reopen.",
          requestId: c.get("requestId"),
        });
      }
      const comment = parsed.data.resolved
        ? await deps.repos.comments.resolve(workspace.id, {
            commentId,
            resolvedBy: c.get("auth").user.id,
          })
        : await deps.repos.comments.unresolve(workspace.id, commentId);
      await audit(
        deps,
        c,
        workspace.id,
        parsed.data.resolved ? "comment.resolved" : "comment.reopened",
        comment.projectId,
        { commentId: comment.id },
      );
      return ok(c, toDto(comment));
    },
  );

  return app;
}

// ---------------------------------------------------------------------------
// PUBLIC guest surface (§M7 task 1: guest comments on share links)
// ---------------------------------------------------------------------------

/**
 * Verified-share context M7-E's share routes resolve BEFORE calling the guest
 * handler: the token is live/unrevoked, and workspace/project come from the
 * token row — never from guest input.
 */
export interface GuestCommentShareContext {
  /** Workspace that owns the shared project. */
  readonly workspaceId: string;
  /** Project the share token exposes. */
  readonly projectId: string;
  /** Verified share-token row id (recorded on the comment row). */
  readonly shareTokenId: string;
}

/**
 * Handler M7-E mounts on the PUBLIC share surface, e.g.
 *   const handler = createGuestComment(deps);
 *   app.post("/v1/shares/:token/comments", async (c) => {
 *     const share = await resolveVerifiedShare(c); // M7-E's token check
 *     return handler(c, share);
 *   });
 *
 * Contract: validates the guest body (GUEST_COMMENT_SCHEMA: anchor + name ≤ 80
 * + email ≤ 200 + body ≤ 2000), enforces the per-IP rate-limit bucket, then
 * persists via repos.comments.createGuest (authorId null; name/email recorded
 * as guest fields; shareTokenId stamped). The comment is NOT attributable to
 * any member and never leaks internal ids beyond the row itself.
 */
export type GuestCommentHandler = (
  c: AppContext,
  share: GuestCommentShareContext,
) => Promise<Response>;

/**
 * Build the guest-comment handler for the share routes (pinned name).
 *
 * Rate-limit seam (§M7 task 1 "guest abuse limits"): the handler consults the
 * app limiter with a per-IP bucket BEFORE touching the repo. `routeClass`
 * selects the (ip, class) bucket — it defaults to "auth" (the tightest
 * existing per-IP class: 10/min) until rate-limit.ts grows a dedicated
 * "share" class; M7-E can pass its own class when it wires the route. The
 * app-level rateLimitMiddleware still runs first (its own bucket).
 */
export function createGuestComment(
  deps: GatewayDeps,
  options: { readonly routeClass?: RouteClass } = {},
): GuestCommentHandler {
  const routeClass: RouteClass = options.routeClass ?? "auth";
  return async (c, share) => {
    const decision = deps.limiter.check(clientIp(c), routeClass);
    if (!decision.allowed) {
      c.header("retry-after", String(decision.retryAfterSeconds));
      throw new StudioError("RATE_LIMITED", {
        requestId: c.get("requestId") ?? "req_unknown",
        retryable: true,
      });
    }

    const parsed = GUEST_COMMENT_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Anchor the comment to a compId, add your name and email, and write 1-2000 characters.",
        requestId: c.get("requestId") ?? "req_unknown",
      });
    }

    const comment = await deps.repos.comments.createGuest(share.workspaceId, {
      shareTokenId: share.shareTokenId,
      projectId: share.projectId,
      compId: parsed.data.compId,
      layerId: parsed.data.layerId ?? null,
      timeTicks: parsed.data.timeTicks ?? null,
      body: parsed.data.body,
      guestName: parsed.data.guestName,
      guestEmail: parsed.data.guestEmail,
    });

    // §7.1 audit trail: no member actor — the token id + ip identify the
    // source; the guest's email never lands in audit metadata.
    try {
      await deps.repos.audit.append(share.workspaceId, {
        actorId: null,
        action: "comment.guest_created",
        targetType: "project",
        targetId: comment.projectId,
        metadata: { commentId: comment.id, shareTokenId: share.shareTokenId },
        ip: clientIp(c),
      });
    } catch (error) {
      // An audit hiccup must not fail the guest's comment.
      deps.logger.warn("audit_failed", {
        action: "comment.guest_created",
        workspaceId: share.workspaceId,
        detail: error instanceof Error ? error.message : "unknown",
      });
    }

    return ok(c, toDto(comment), 201);
  };
}
