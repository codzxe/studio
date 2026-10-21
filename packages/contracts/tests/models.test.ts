import { describe, expect, it } from "vitest";

import {
  MODEL_CATALOG,
  MODEL_IDS,
  MODEL_ID_SCHEMA,
  type ModelId,
  PAID_PLAN_IDS,
  PAID_PLAN_ID_SCHEMA,
  PLAN_IDS,
  PLAN_MODEL_ENTITLEMENTS,
  allowedModelsForPlan,
  defaultModelForPlan,
  modelAllowedForPlan,
} from "../src/models.js";

describe("models: §8.2 aliases", () => {
  it("exposes exactly the three stable aliases", () => {
    expect([...MODEL_IDS]).toEqual(["studio-fast", "studio-smart", "studio-vision"]);
    expect(MODEL_ID_SCHEMA.safeParse("studio-fast").success).toBe(true);
    expect(MODEL_ID_SCHEMA.safeParse("gpt-4o").success).toBe(false);
  });

  it("catalog is complete: one descriptor per id, positive metered rates", () => {
    for (const id of MODEL_IDS) {
      const descriptor = MODEL_CATALOG[id];
      expect(descriptor.id).toBe(id);
      expect(descriptor.creditsPer1kInput).toBeGreaterThan(0);
      expect(descriptor.creditsPer1kOutput).toBeGreaterThan(0);
      expect(descriptor.allowedPlans.every((plan) => PLAN_IDS.includes(plan))).toBe(true);
    }
    expect(Object.keys(MODEL_CATALOG)).toHaveLength(MODEL_IDS.length);
  });

  it("tiers line up with §8.2 uses", () => {
    expect(MODEL_CATALOG["studio-fast"].use).toMatch(/planning/i);
    expect(MODEL_CATALOG["studio-smart"].use).toMatch(/multi-step/i);
    expect(MODEL_CATALOG["studio-vision"].use).toMatch(/frame/i);
  });
});

describe("models: §10.1 plan entitlements", () => {
  it("trial→fast, starter→fast, pro→fast+smart, studio→all (§8.2/§10.1)", () => {
    expect([...PLAN_IDS]).toEqual(["trial", "starter", "pro", "studio"]);
    expect(PLAN_MODEL_ENTITLEMENTS.trial).toEqual(["studio-fast"]);
    expect(PLAN_MODEL_ENTITLEMENTS.starter).toEqual(["studio-fast"]);
    expect(PLAN_MODEL_ENTITLEMENTS.pro).toEqual(["studio-fast", "studio-smart"]);
    expect(PLAN_MODEL_ENTITLEMENTS.studio).toEqual([
      "studio-fast",
      "studio-smart",
      "studio-vision",
    ]);
  });

  it("modelAllowedForPlan gates each alias per plan", () => {
    const expectations: Record<ModelId, boolean[]> = {
      "studio-fast": [true, true, true, true],
      "studio-smart": [false, false, true, true],
      "studio-vision": [false, false, false, true],
    };
    PLAN_IDS.forEach((plan, planIndex) => {
      for (const model of MODEL_IDS) {
        expect(modelAllowedForPlan(model, plan), `${model} on ${plan}`).toBe(
          expectations[model][planIndex],
        );
      }
    });
  });

  it("allowedModelsForPlan mirrors the entitlements map; default = most capable", () => {
    expect(allowedModelsForPlan("pro")).toEqual(["studio-fast", "studio-smart"]);
    expect(defaultModelForPlan("trial")).toBe("studio-fast");
    expect(defaultModelForPlan("studio")).toBe("studio-vision");
  });

  it("paid plans exclude trial (checkout never sells a trial, §10.1)", () => {
    expect([...PAID_PLAN_IDS]).toEqual(["starter", "pro", "studio"]);
    expect(PAID_PLAN_ID_SCHEMA.safeParse("trial").success).toBe(false);
    expect(PAID_PLAN_ID_SCHEMA.safeParse("pro").success).toBe(true);
  });
});
