// @studio/gateway — invites (§7.2, §7.1): Better Auth organization
// invitation API; roles are wire-stable (owner|admin|editor|viewer); every
// invite is audited. Accepting is scoped to the invitation's recipient.

import { Hono } from "hono";

import {
  ACCEPT_INVITE_SCHEMA,
  type AcceptedInvite,
  INVITE_MEMBER_SCHEMA,
  type Invite,
} from "@studio/contracts";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireAuth, resolveWorkspaceContext } from "../middleware.js";

export function invitesRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/invites/*", requireAuth());
  app.use("/v1/workspaces/*", requireAuth());

  app.post("/v1/workspaces/:id/invites", async (c: AppContext): Promise<Response> => {
    const candidate = pathParam(c, "id");
    const context = await resolveWorkspaceContext(c, candidate, "admin");

    const parsed = INVITE_MEMBER_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Invite with a valid email and a role of owner, admin, editor or viewer.",
        requestId: c.get("requestId"),
      });
    }

    const invite = await deps.auth.inviteMember(c.req.raw.headers, {
      organizationId: context.id,
      email: parsed.data.email,
      role: parsed.data.role,
    });

    const body: Invite = {
      id: invite.id,
      workspaceId: invite.organizationId || context.id,
      email: invite.email,
      role: parsed.data.role,
      status:
        invite.status === "accepted" || invite.status === "revoked" ? invite.status : "pending",
      expiresAt: invite.expiresAt,
      createdAt: new Date().toISOString(),
    };

    try {
      await deps.repos.audit.append(context.id, {
        actorId: c.get("auth").user.id,
        action: "member.invited",
        targetType: "workspace",
        targetId: context.id,
        metadata: { email: parsed.data.email, role: parsed.data.role, inviteId: invite.id },
      });
    } catch {
      // see workspaces.ts: audit must not fail the mutation
    }
    return ok(c, body, 201);
  });

  app.post("/v1/invites/:token/accept", async (c: AppContext): Promise<Response> => {
    const token = pathParam(c, "token");
    ACCEPT_INVITE_SCHEMA.safeParse({});
    const accepted = await deps.auth.acceptInvitation(c.req.raw.headers, token);

    const body: AcceptedInvite = {
      inviteId: accepted.inviteId,
      workspaceId: accepted.organizationId,
      role:
        accepted.role === "owner" || accepted.role === "admin" || accepted.role === "editor"
          ? accepted.role
          : "viewer",
    };
    try {
      await deps.repos.audit.append(accepted.organizationId, {
        actorId: c.get("auth").user.id,
        action: "member.joined",
        targetType: "workspace",
        targetId: accepted.organizationId,
        metadata: { inviteId: accepted.inviteId, role: body.role },
      });
    } catch {
      // see above
    }
    return ok(c, body);
  });

  return app;
}
