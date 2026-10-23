import { z } from "zod";
/**
 * `GET /v1/models` → Ok<ModelsResponse> (§8.2 "Plan gating" + §10.1):
 * the caller's workspace `plan` and the `models` selectable on it, each with
 * its §8.2 alias, tier, use line and illustrative metered rates. Entitlement
 * filtering is server-side (`allowedModelsForPlan` in ../models.js); this
 * schema only fixes what the browser sees.
 */
export declare const MODELS_RESPONSE_SCHEMA: z.ZodObject<{
    plan: z.ZodEnum<{
        trial: "trial";
        starter: "starter";
        pro: "pro";
        studio: "studio";
    }>;
    models: z.ZodArray<z.ZodObject<{
        id: z.ZodEnum<{
            "studio-fast": "studio-fast";
            "studio-smart": "studio-smart";
            "studio-vision": "studio-vision";
        }>;
        tier: z.ZodEnum<{
            fast: "fast";
            smart: "smart";
            vision: "vision";
        }>;
        use: z.ZodString;
        creditsPer1kInput: z.ZodNumber;
        creditsPer1kOutput: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ModelsResponse = z.infer<typeof MODELS_RESPONSE_SCHEMA>;
