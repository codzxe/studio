// @studio/gateway — GET /v1/models (§7.2, §8.2, §10.1): the model-entitlement
// read behind the chat model picker (BUILD_PLAN §M4.2).
//
// Workspace-scoped (viewer floor). The plan comes from the ../plan.js seam
// (M6 swaps its storage in ONE place — never inline "trial"), the catalog is
// filtered by allowedModelsForPlan, and descriptors are mapped to the wire
// shape — `allowedPlans` is server-side gating knowledge and never leaves the
// gateway.

import { Hono } from "hono";

import { MODEL_CATALOG, type ModelsResponse, allowedModelsForPlan } from "@studio/contracts";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { ok } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { isAdminRole, resolvePlan } from "../plan.js";

export function modelsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  // `deps` is intentionally unused today: the route reads static catalog data
  // plus the resolvePlan seam. The factory signature stays uniform with every
  // other route (buildApp passes the full dep set), and M6's subscription
  // read lands behind resolvePlan — not behind a route-local dep.
  void deps;

  const app = new Hono<AppBindings>();
  app.use("/v1/models", requireAuth());

  app.get("/v1/models", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const workspaceId = c.get("workspace").id;
    const plan = await resolvePlan(workspaceId, {
      admin: isAdminRole(c.get("auth").user.role),
    });
    const models = allowedModelsForPlan(plan).map((id) => {
      const descriptor = MODEL_CATALOG[id];
      return {
        id: descriptor.id,
        tier: descriptor.tier,
        use: descriptor.use,
        creditsPer1kInput: descriptor.creditsPer1kInput,
        creditsPer1kOutput: descriptor.creditsPer1kOutput,
      };
    });
    const body: ModelsResponse = { plan, models };
    return ok(c, body);
  });

  return app;
}
