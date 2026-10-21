// @studio/gateway — GET /v1/me (§7.2): user + memberships + plan summary.
//
// Plan data is a v1 stub ({ plan: "trial" … }) until the billing wave wires
// the subscription tables; the credits balance is REAL (ledger sum of the
// active workspace, or the first membership, or 0 for fresh accounts).

import { Hono } from "hono";

import type { Membership, MeResponse } from "@studio/contracts";

import { requireAuth } from "../middleware.js";
import { ok } from "../http.js";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";

export function meRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/me", requireAuth());

  app.get("/v1/me", async (c: AppContext): Promise<Response> => {
    const { user } = c.get("auth");
    const headers = c.req.raw.headers;

    const orgs = await deps.auth.listOrganizations(headers);
    const memberships: Membership[] = [];
    let activeWorkspaceId = c.get("auth").session.activeOrganizationId;
    for (const org of orgs) {
      const full = await deps.auth.getFullWorkspace(headers, org.id);
      const role = full?.members.find((member) => member.userId === user.id)?.role ?? "viewer";
      memberships.push({
        workspaceId: org.id,
        role: role === "owner" || role === "admin" || role === "editor" || role === "viewer" ? role : "viewer",
        workspace: { id: org.id, name: org.name, slug: org.slug },
      });
      if (activeWorkspaceId === null) activeWorkspaceId = org.id;
    }

    let creditsBalance = 0;
    if (activeWorkspaceId !== null) {
      try {
        creditsBalance = await deps.repos.ledger.balance(activeWorkspaceId);
      } catch {
        creditsBalance = 0;
      }
    }

    const body: MeResponse = {
      user: { id: user.id, name: user.name, email: user.email },
      memberships,
      plan: {
        plan: "trial",
        creditsBalance,
        includedCredits: 0,
        renewsAt: null,
      },
    };
    return ok(c, body);
  });

  return app;
}
