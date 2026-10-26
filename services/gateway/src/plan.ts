// @studio/gateway — chat model entitlement seam (BUILD_PLAN §M4.2,
// PRODUCT_ARCHITECTURE §8.2 "Plan gating", §10.1).
//
// M6 (billing/entitlements) landed: the workspace's plan is its subscription
// row (subscriptions repo, M6-D), read through the ONE seam every route keeps
// calling (never `defaultModelForPlan("trial")` inline). The row is installed
// by the billing route factory (routes/billing.ts owns the deps wiring —
// resolvePlan's signature stays workspace-id-only, so models/chat routes are
// untouched); workspaces with no row (legacy/pre-checkout) fall back to
// `trial`, and a missing/stub repo NEVER crashes the picker. Pinned in
// docs/phases/M4-SEAMS.md Seam 1.
//
// D-4 (binding): trial is a subscription STATE on the Starter row — a row in
// `trialing` gates as the TRIAL catalog tier (entitlementsFor("trial")),
// regardless of its plan_id. Unpaid terminal states (`canceled`,
// `incomplete`) also gate as trial: the most restrictive tier, no permanent
// free path (BP §M6 exit criteria). Paid/dunning states (`active`, `grace`,
// `past_due`) gate as the row's plan_id.

import type { PlanId } from "@studio/contracts";
import type { Subscription } from "@studio/db";

/**
 * Staff-admin entitlement (round 5): the TOP catalog tier, granted by USER
 * role — a better-auth user with role='admin' (set via the DB / the admin
 * grant script) always gates as `studio`, in every workspace, regardless of
 * the subscription row. No payment path can ever demote it.
 */
export const TOP_TIER_PLAN: PlanId = "studio";

/** `true` only for the better-auth staff role 'admin'. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin";
}

/** Caller-side override the plan seams accept (admin ⇒ top tier). */
export interface PlanOverride {
  readonly admin?: boolean;
}

/** Reads the workspace's subscription row (repos.subscriptions.getByOrganization). */
export type SubscriptionReader = (workspaceId: string) => Promise<Subscription | null>;

let reader: SubscriptionReader | null = null;

/**
 * Installs the subscription-row reader (called by the billing route factory at
 * buildApp time — every request runs after construction). Passing a non-callable
 * (stub boots without the billing repos) clears the seam; resolvePlan then
 * falls back to `trial`.
 */
export function installSubscriptionReader(candidate: SubscriptionReader | undefined): void {
  reader = typeof candidate === "function" ? candidate : null;
}

/** Reads the installed reader without letting a stub boot crash it. */
async function readSubscription(workspaceId: string): Promise<Subscription | null> {
  const read = reader;
  if (read === null) return null;
  try {
    return await read(workspaceId);
  } catch {
    // Stub boots / transient repo failures never crash the model picker.
    return null;
  }
}

/**
 * The EFFECTIVE plan a subscription row gates as (D-4; see the module header).
 * Pure — also the single source `GET /v1/billing/state` reports as `plan`.
 */
export function effectivePlan(row: Subscription | null, override?: PlanOverride): PlanId {
  if (override?.admin === true) {
    // Staff admin: the top tier, independent of the subscription row.
    return TOP_TIER_PLAN;
  }
  if (row === null) return "trial";
  switch (row.status) {
    case "trialing":
      // D-4: the trial state gates as the trial catalog tier, never the row's
      // plan_id (a trialing Starter row must not unlock studio-smart).
      return "trial";
    case "canceled":
    case "incomplete":
      // Terminal/unpaid: the most restrictive tier — no permanent free path.
      return "trial";
    default:
      // active | grace | past_due: the row's plan.
      return row.planId;
  }
}

/**
 * Resolve the plan that gates chat model selection for a workspace.
 *
 * Reads the workspace's subscription row through the installed seam; a
 * missing row (legacy workspaces) resolves to `trial`. Never throws.
 */
export async function resolvePlan(workspaceId: string, override?: PlanOverride): Promise<PlanId> {
  if (override?.admin === true) return TOP_TIER_PLAN;
  return effectivePlan(await readSubscription(workspaceId));
}
