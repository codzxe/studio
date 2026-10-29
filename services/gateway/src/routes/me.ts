// @studio/gateway — GET /v1/me (§7.2): user + memberships + plan summary.
//
// PERF ROUND, PART 2: memberships come from ONE joined SQL
// (`repos.memberships.listForUser`) instead of better-auth's per-org
// `getFullWorkspace` fan-out — the old loop fetched EVERY workspace's full
// member list to find one role, ~3 queries × N workspaces sequential, a
// measured ~2 s on a 30-workspace account (and every shell-wrapped page
// with it). Role coercion and the activeWorkspaceId fallback keep their
// exact pre-fix semantics.
//
// W1-04 stub purge: the plan block is now the SAME truthful derivation the
// other billing reads use — the active workspace's subscription row (M6-D
// subscriptions repo) through the shared pure `effectivePlan` (D-4: a
// trialing row gates as the trial catalog tier; active|grace|past_due gate
// as the row's plan_id; no row = the most restrictive trial tier — exactly
// what GET /v1/billing/state reports for the same workspace), the monthly
// allowance from the @studio/config catalog (entitlementsFor — never a
// route-local table), and the renewal date from the row's
// current_period_end. creditsBalance stays the REAL ledger sum, in integer
// MICROcredits (D-12) — same units as includedCredits and /v1/credits — of
// the active workspace, or the first membership, or 0 for fresh accounts.
//
// Wire-shape note (law #12): PlanSummary (@studio/contracts routes/me.ts)
// carries plan/creditsBalance/includedCredits/renewsAt only. The richer
// lifecycle flags (status, trialEnd, graceEnd) are GET /v1/billing/state
// fields — the ONE billing read the UI consumes — so no contracts change is
// needed or made here.

import { Hono } from "hono";

import { entitlementsFor } from "@studio/config";
import type { MeResponse, Membership } from "@studio/contracts";
import type { Repos, Subscription } from "@studio/db";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { ok } from "../http.js";
import { requireAuth } from "../middleware.js";
import { effectivePlan, isAdminRole } from "../plan.js";

/**
 * Stub boots wire fake repos without the billing tables; absence degrades
 * to the no-row default — never a crash (same guard as routes/billing.ts).
 */
function subscriptionsRepo(repos: Repos): Repos["subscriptions"] | null {
  const candidate = (repos as Repos & { subscriptions?: Repos["subscriptions"] }).subscriptions;
  if (candidate === undefined || typeof candidate.getByOrganization !== "function") return null;
  return candidate;
}

export function meRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/me", requireAuth());

  app.get("/v1/me", async (c: AppContext): Promise<Response> => {
    const { user } = c.get("auth");

    // ONE joined SQL (member × organization) — see the file header. Roles
    // pass through as better-auth stores them; the wire coercion below is
    // the pre-fix one exactly (unknown/default roles read as viewer).
    const rows = await deps.repos.memberships.listForUser(user.id);
    const memberships: Membership[] = [];
    let activeWorkspaceId = c.get("auth").session.activeOrganizationId;
    for (const org of rows) {
      const role = org.role;
      memberships.push({
        workspaceId: org.workspaceId,
        role:
          role === "owner" || role === "admin" || role === "editor" || role === "viewer"
            ? role
            : "viewer",
        workspace: {
          id: org.workspaceId,
          name: org.workspaceName,
          slug: org.workspaceSlug,
        },
      });
      if (activeWorkspaceId === null) activeWorkspaceId = org.workspaceId;
    }

    let creditsBalance = 0;
    if (activeWorkspaceId !== null) {
      try {
        creditsBalance = await deps.repos.ledger.balance(activeWorkspaceId);
      } catch {
        creditsBalance = 0;
      }
    }

    // The active workspace's REAL subscription row → effective plan (D-4) →
    // catalog allowance + the row's period end. A transient repo failure or
    // a stub boot degrades to the no-row default — /v1/me is the session
    // bootstrap read, never a 500 (same policy as the ledger read above and
    // the resolvePlan seam in plan.ts).
    const subscriptions = subscriptionsRepo(deps.repos);
    let subscription: Subscription | null = null;
    if (activeWorkspaceId !== null && subscriptions !== null) {
      try {
        subscription = await subscriptions.getByOrganization(activeWorkspaceId);
      } catch {
        subscription = null;
      }
    }
    // Round 5: a staff admin (role='admin') always reports the top tier —
    // plan.ts applies the same override at every enforcement seam.
    const plan = effectivePlan(subscription, { admin: isAdminRole(user.role) });

    const body: MeResponse = {
      user: { id: user.id, name: user.name, email: user.email, role: user.role ?? null },
      memberships,
      plan: {
        plan,
        creditsBalance,
        includedCredits: entitlementsFor(plan).monthlyCreditAllowance,
        renewsAt: subscription?.currentPeriodEnd?.toISOString() ?? null,
      },
    };
    return ok(c, body);
  });

  return app;
}
