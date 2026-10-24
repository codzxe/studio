// @studio/gateway — invites (§7.2, §7.1): Better Auth organization
// invitation API; roles are wire-stable (owner|admin|editor|viewer); every
// invite is audited. Accepting is scoped to the invitation's recipient.
//
// M6 seat enforcement (W1-e, AUD-3 gap 3a): the plan catalog's `seats` is
// the server-side limit on invite creation — see `assertSeatAvailable`.

import { Hono } from "hono";

import {
  ACCEPT_INVITE_SCHEMA,
  type AcceptedInvite,
  INVITE_MEMBER_SCHEMA,
  type Invite,
} from "@studio/contracts";

import { entitlementsFor, isPaidPlan } from "@studio/config";

import type { AppBindings, AppContext, GatewayDeps, WorkspaceContext } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireAuth, resolveWorkspaceContext } from "../middleware.js";
import { resolvePlan } from "../plan.js";
import { countPendingInvites } from "./billing.js";

/**
 * The M6 invite-time seat gate (the sibling of billing.ts's checkout
 * pre-check — that route's comment is now true).
 *
 * Catalog semantics (packages/config/src/plans.ts): `seats` is ONE flat
 * number per plan — every member role counts (owner|admin|editor|viewer;
 * there is no paid-role carve-out), and a pending invite holds its seat
 * reserved, so the gate compares members + non-expired pending invites
 * against the allowance and refuses when no seat is free for the NEW
 * invite (`usage >= seats` → 429 SEATS_EXCEEDED, add-only in errors.ts).
 *
 * PAID plans only: a trial-state workspace (no subscription row, trialing,
 * or terminal-unpaid — `effectivePlan` "trial" in plan.ts) is pre-checkout;
 * its growth is policed at CONVERSION (billing.ts refuses a paid plan
 * smaller than members + pending invites), so every member a workspace
 * actually BUYS a plan for stays inside that plan's seats. Trials keep the
 * invite flows the whole fleet builds on (collab/comments/presence tests
 * invite on fresh trial workspaces).
 *
 * ACCEPT is deliberately not gated: the invitee is not yet a member, so
 * every member-list surface (including better-auth's own endpoints) 404s
 * for them pre-accept — there is no honest pre-accept member count. The
 * invariant doesn't need it: accepts convert a pending invite into a
 * member one-for-one, and creation + checkout together keep that sum
 * inside the paid allowance.
 */
async function assertSeatAvailable(
  deps: GatewayDeps,
  c: AppContext,
  context: WorkspaceContext,
): Promise<void> {
  const plan = await resolvePlan(context.id);
  if (!isPaidPlan(plan)) {
    return; // trial-state workspace — policed at checkout conversion
  }
  const seats = entitlementsFor(plan).seats;
  const pending = await countPendingInvites(deps, c.req.raw.headers, context.id);
  if (context.members.length + pending >= seats) {
    throw new GatewayError("SEATS_EXCEEDED", "This workspace is at its plan's seat limit.", {
      status: 429,
      hint: "Upgrade the plan, or remove a member, before inviting more people.",
      requestId: c.get("requestId"),
    });
  }
}

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

    // M6: the seat gate runs BEFORE any invite row is minted (a refused
    // invite must not consume a seat or send mail).
    await assertSeatAvailable(deps, c, context);

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
