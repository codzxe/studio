// @studio/gateway — chat model entitlement seam (BUILD_PLAN §M4.2,
// PRODUCT_ARCHITECTURE §8.2 "Plan gating", §10.1).
//
// M6 (billing/entitlements) owns real plan storage (subscriptions). Until it
// lands, every workspace is on `trial` — the chat route must still call this
// seam (never `defaultModelForPlan("trial")` inline) so M6 swaps storage in
// ONE place. Pinned in docs/phases/M4-SEAMS.md Seam 1.

import type { PlanId } from "@studio/contracts";

/**
 * Resolve the plan that gates chat model selection for a workspace.
 *
 * TODO(M6): read the workspace's active subscription from the database
 * (subscription table owned by the billing wave); keep the signature.
 */
export async function resolvePlan(_workspaceId: string): Promise<PlanId> {
  return "trial";
}
