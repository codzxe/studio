// @studio/contracts — GET /v1/models (PRODUCT_ARCHITECTURE.md §8.2, §10.1).
//
// The workspace-scoped model-entitlement read behind the chat model picker
// (BUILD_PLAN §M4.2 "Model picker backed by plan entitlements; UI reads
// entitlements, never hardcodes"): the workspace's plan plus the model
// summaries its members may select. The wire item is a CUT-DOWN
// ModelDescriptor — `allowedPlans` is server-side gating knowledge and never
// reaches the browser.
import { z } from "zod";
import { MODEL_ID_SCHEMA, PLAN_ID_SCHEMA } from "../models.js";
/**
 * `GET /v1/models` → Ok<ModelsResponse> (§8.2 "Plan gating" + §10.1):
 * the caller's workspace `plan` and the `models` selectable on it, each with
 * its §8.2 alias, tier, use line and illustrative metered rates. Entitlement
 * filtering is server-side (`allowedModelsForPlan` in ../models.js); this
 * schema only fixes what the browser sees.
 */
export const MODELS_RESPONSE_SCHEMA = z.object({
    plan: PLAN_ID_SCHEMA,
    models: z.array(z.object({
        id: MODEL_ID_SCHEMA,
        tier: z.enum(["fast", "smart", "vision"]),
        use: z.string(),
        creditsPer1kInput: z.number(),
        creditsPer1kOutput: z.number(),
    })),
});
//# sourceMappingURL=models.js.map