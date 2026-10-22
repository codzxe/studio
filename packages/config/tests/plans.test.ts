import { describe, expect, it } from "vitest";
import {
  ENABLED_RENDER_FORMATS,
  MICROCREDITS_PER_CREDIT,
  PLAN_CATALOG,
  PLAN_MODEL_IDS,
  PLAUSIBLE_PLAN_IDS,
  PRICING_PAGE_PLANS,
  RENDER_FORMATS,
  StudioError,
  creditsToMicrocredits,
  entitlementsFor,
  getPlan,
  isPaidPlan,
  isPlausiblePlanId,
  isRenderFormatEnabled,
  maxModelTier,
  microcreditsToCredits,
  parseStripePriceIds,
  stripePriceIdFor,
} from "../src/index.js";
import type { PlanDescriptor, PlanId } from "../src/index.js";

// The canonical env-example map from packages/config/src/env.ts — every paid
// plan's stripePriceKey must resolve against this shape.
const CANONICAL_PRICE_MAP = '{"starter":"price_starter","pro":"price_pro","studio":"price_studio"}';

// MODEL_CATALOG ids (packages/contracts/src/models.ts) — pinned here because
// @studio/config deliberately has no dependency on @studio/contracts; this is
// the no-drift seam the models route relies on.
const MODEL_CATALOG_IDS: readonly string[] = ["studio-fast", "studio-smart", "studio-vision"];

const EXPECTED_TIERS: readonly PlanId[] = ["trial", "starter", "pro", "studio"];

const EVERY_FIELD: readonly (keyof PlanDescriptor)[] = [
  "id",
  "name",
  "seats",
  "models",
  "maxProjects",
  "storageBytes",
  "renderMinutesPerMonth",
  "monthlyCreditAllowance",
  "trialDays",
  "monthlyPriceCents",
  "stripePriceKey",
];

describe("plans: catalog completeness", () => {
  it("covers exactly the four tiers, in order, in catalog and plausible list", () => {
    expect(PLAUSIBLE_PLAN_IDS).toEqual(EXPECTED_TIERS);
    expect(Object.keys(PLAN_CATALOG)).toEqual(EXPECTED_TIERS);
  });

  it("every tier defines every field with the right primitive type", () => {
    for (const id of EXPECTED_TIERS) {
      const plan = PLAN_CATALOG[id];
      expect(plan).toBeDefined();
      for (const field of EVERY_FIELD) {
        expect(plan, `${id}.${field} must be present`).toHaveProperty(field);
      }
      expect(plan.id).toBe(id);
      expect(plan.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(plan.seats)).toBe(true);
      expect(Array.isArray(plan.models)).toBe(true);
      expect(plan.models.length).toBeGreaterThan(0);
      expect(Number.isInteger(plan.maxProjects)).toBe(true);
      expect(Number.isInteger(plan.storageBytes)).toBe(true);
      expect(Number.isInteger(plan.renderMinutesPerMonth)).toBe(true);
      expect(Number.isInteger(plan.monthlyPriceCents)).toBe(true);
      expect(plan.trialDays === null || Number.isInteger(plan.trialDays)).toBe(true);
    }
  });

  it("encodes the exact M6 tier table (seats, storage, render minutes, µc)", () => {
    expect(PLAN_CATALOG.trial).toMatchObject({
      seats: 1,
      models: ["studio-fast"],
      maxProjects: 3,
      storageBytes: 1024 ** 3,
      renderMinutesPerMonth: 5,
      monthlyCreditAllowance: 50_000_000,
      trialDays: 14,
      monthlyPriceCents: 0,
      stripePriceKey: null,
    });
    expect(PLAN_CATALOG.starter).toMatchObject({
      seats: 2,
      models: ["studio-fast", "studio-smart"],
      maxProjects: 10,
      storageBytes: 20 * 1024 ** 3,
      renderMinutesPerMonth: 60,
      monthlyCreditAllowance: 500_000_000,
      trialDays: null,
      monthlyPriceCents: 1200,
      stripePriceKey: "starter",
    });
    expect(PLAN_CATALOG.pro).toMatchObject({
      seats: 5,
      models: ["studio-fast", "studio-smart"],
      maxProjects: 50,
      storageBytes: 200 * 1024 ** 3,
      renderMinutesPerMonth: 600,
      monthlyCreditAllowance: 2_000_000_000,
      trialDays: null,
      monthlyPriceCents: 3900,
      stripePriceKey: "pro",
    });
    expect(PLAN_CATALOG.studio).toMatchObject({
      seats: 15,
      models: ["studio-fast", "studio-smart"],
      maxProjects: 200,
      storageBytes: 1024 ** 4,
      renderMinutesPerMonth: 3000,
      monthlyCreditAllowance: 10_000_000_000,
      trialDays: null,
      monthlyPriceCents: 9900,
      stripePriceKey: "studio",
    });
  });

  it("entitlements grow (never shrink) from trial to studio", () => {
    const ladder: readonly [PlanId, PlanId][] = [
      ["trial", "starter"],
      ["starter", "pro"],
      ["pro", "studio"],
    ];
    for (const [lower, higher] of ladder) {
      for (const field of [
        "seats",
        "maxProjects",
        "storageBytes",
        "renderMinutesPerMonth",
        "monthlyCreditAllowance",
      ] as const) {
        expect(PLAN_CATALOG[higher][field]).toBeGreaterThanOrEqual(PLAN_CATALOG[lower][field]);
      }
    }
  });

  it("isPlausiblePlanId narrows exactly the catalog ids", () => {
    for (const id of EXPECTED_TIERS) {
      expect(isPlausiblePlanId(id)).toBe(true);
    }
    expect(isPlausiblePlanId("enterprise")).toBe(false);
    expect(isPlausiblePlanId("")).toBe(false);
    expect(isPlausiblePlanId("Trial")).toBe(false); // machine ids are lowercase
  });
});

describe("plans: D-4 — trial is a state, not a paid plan", () => {
  it("the pricing display list is exactly starter/pro/studio", () => {
    expect([...PRICING_PAGE_PLANS]).toEqual(["starter", "pro", "studio"]);
    expect(PRICING_PAGE_PLANS).not.toContain("trial");
  });

  it("isPaidPlan: paid tiers true, trial and unknowns false", () => {
    expect(isPaidPlan("starter")).toBe(true);
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("studio")).toBe(true);
    expect(isPaidPlan("trial")).toBe(false);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan("")).toBe(false);
  });

  it("trial has no price and no Stripe price key; paid keys equal their machine ids", () => {
    expect(PLAN_CATALOG.trial.monthlyPriceCents).toBe(0);
    expect(PLAN_CATALOG.trial.stripePriceKey).toBeNull();
    for (const id of PRICING_PAGE_PLANS) {
      expect(PLAN_CATALOG[id].stripePriceKey).toBe(id);
    }
  });

  it("trialDays is 14 on trial and null on every paid tier", () => {
    expect(PLAN_CATALOG.trial.trialDays).toBe(14);
    for (const id of PRICING_PAGE_PLANS) {
      expect(PLAN_CATALOG[id].trialDays).toBeNull();
    }
  });

  it("every paid plan's stripePriceKey resolves in the canonical env map", () => {
    const parsed = parseStripePriceIds(CANONICAL_PRICE_MAP);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      for (const id of PRICING_PAGE_PLANS) {
        expect(parsed.priceIds[PLAN_CATALOG[id].stripePriceKey ?? ""]).toBe(`price_${id}`);
      }
    }
  });
});

describe("plans: model gates per tier (D-8, models-route parity)", () => {
  it("PLAN_MODEL_IDS mirrors the MODEL_CATALOG ids exactly", () => {
    expect([...PLAN_MODEL_IDS]).toEqual(MODEL_CATALOG_IDS);
  });

  it("trial ⇒ exactly [studio-fast], through catalog and helper", () => {
    expect(PLAN_CATALOG.trial.models).toEqual(["studio-fast"]);
    expect([...entitlementsFor("trial").models]).toEqual(["studio-fast"]);
    for (const model of MODEL_CATALOG_IDS) {
      expect(maxModelTier("trial", model)).toBe(model === "studio-fast");
    }
  });

  it("maxModelTier matrix: fast everywhere, smart on paid tiers, vision nowhere", () => {
    expect(maxModelTier("trial", "studio-smart")).toBe(false);
    for (const id of PRICING_PAGE_PLANS) {
      expect(maxModelTier(id, "studio-fast")).toBe(true);
      expect(maxModelTier(id, "studio-smart")).toBe(true);
      expect(maxModelTier(id, "studio-vision")).toBe(false); // D-8
    }
  });

  it("every catalog models entry is a MODEL_CATALOG id (no unknown model strings)", () => {
    for (const id of EXPECTED_TIERS) {
      for (const model of PLAN_CATALOG[id].models) {
        expect(MODEL_CATALOG_IDS).toContain(model);
      }
    }
  });

  it("fails closed on unknown plan or model ids", () => {
    expect(maxModelTier("enterprise", "studio-fast")).toBe(false);
    expect(maxModelTier("trial", "gpt-neo")).toBe(false);
    expect(maxModelTier("", "studio-fast")).toBe(false);
  });
});

describe("plans: µc integers everywhere (D-12)", () => {
  it("every monthlyCreditAllowance is an integer multiple of 1 credit", () => {
    for (const id of EXPECTED_TIERS) {
      const allowance = PLAN_CATALOG[id].monthlyCreditAllowance;
      expect(Number.isInteger(allowance)).toBe(true);
      expect(allowance % MICROCREDITS_PER_CREDIT).toBe(0);
      expect(Number.isInteger(allowance / MICROCREDITS_PER_CREDIT)).toBe(true);
    }
  });

  it("allowances are the round M6 numbers: 50 / 500 / 2,000 / 10,000 credits", () => {
    expect(microcreditsToCredits(PLAN_CATALOG.trial.monthlyCreditAllowance)).toBe(50);
    expect(microcreditsToCredits(PLAN_CATALOG.starter.monthlyCreditAllowance)).toBe(500);
    expect(microcreditsToCredits(PLAN_CATALOG.pro.monthlyCreditAllowance)).toBe(2000);
    expect(microcreditsToCredits(PLAN_CATALOG.studio.monthlyCreditAllowance)).toBe(10_000);
  });

  it("MICROCREDITS_PER_CREDIT is exactly one million", () => {
    expect(MICROCREDITS_PER_CREDIT).toBe(1_000_000);
  });

  it("creditsToMicrocredits converts and rejects sub-µc / negative / non-finite input", () => {
    expect(creditsToMicrocredits(50)).toBe(50_000_000);
    expect(creditsToMicrocredits(0.25)).toBe(250_000);
    expect(creditsToMicrocredits(0.01)).toBe(10_000); // binary-float artifact safe
    expect(creditsToMicrocredits(0)).toBe(0);
    for (const bad of [0.0000001, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => creditsToMicrocredits(bad), `${bad}`).toThrow(StudioError);
    }
  });

  it("microcreditsToCredits converts to ≤2-decimal credits and rejects bad ledger values", () => {
    expect(microcreditsToCredits(50_000_000)).toBe(50);
    expect(microcreditsToCredits(250_000)).toBe(0.25);
    expect(microcreditsToCredits(10_000_000_000)).toBe(10_000);
    expect(microcreditsToCredits(0)).toBe(0);
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => microcreditsToCredits(bad), `${bad}`).toThrow(StudioError);
    }
  });
});

describe("plans: entitlements and immutability", () => {
  it("entitlementsFor returns the frozen six-field bundle with catalog values", () => {
    const ent = entitlementsFor("starter");
    expect(ent).toEqual({
      seats: 2,
      models: ["studio-fast", "studio-smart"],
      maxProjects: 10,
      storageBytes: 20 * 1024 ** 3,
      renderMinutesPerMonth: 60,
      monthlyCreditAllowance: 500_000_000,
    });
    expect(Object.isFrozen(ent)).toBe(true);
  });

  it("the catalog, its descriptors and their model arrays are all frozen", () => {
    expect(Object.isFrozen(PLAN_CATALOG)).toBe(true);
    for (const id of EXPECTED_TIERS) {
      expect(Object.isFrozen(PLAN_CATALOG[id])).toBe(true);
      expect(Object.isFrozen(PLAN_CATALOG[id].models)).toBe(true);
    }
  });

  it("mutating an entitlements object or its models array throws", () => {
    const ent = entitlementsFor("pro");
    expect(() => {
      (ent as { seats: number }).seats = 99;
    }).toThrow();
    expect(() => {
      (ent.models as unknown as string[]).push("studio-vision");
    }).toThrow();
    expect(ent.seats).toBe(5);
    expect(ent.models).toEqual(["studio-fast", "studio-smart"]);
  });

  it("getPlan returns the catalog descriptor by reference", () => {
    expect(getPlan("studio")).toBe(PLAN_CATALOG.studio);
    expect(getPlan("trial").id).toBe("trial");
  });

  it("unknown plan ids throw a typed StudioError that never echoes the id", () => {
    for (const bad of ["enterprise", "free", ""]) {
      let thrown: unknown;
      try {
        getPlan(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(StudioError);
      const studioError = thrown as StudioError;
      expect(studioError.code).toBe("VALIDATION_FAILED");
      const envelope = JSON.stringify(studioError.toEnvelope());
      expect(envelope).not.toContain(bad === "" ? '""' : bad);
      expect(() => entitlementsFor(bad)).toThrow(StudioError);
    }
  });
});

describe("plans: Stripe price-id map parsing", () => {
  it("resolves every paid plan from the canonical map", () => {
    for (const id of PRICING_PAGE_PLANS) {
      const lookup = stripePriceIdFor(id, CANONICAL_PRICE_MAP);
      expect(lookup.ok).toBe(true);
      if (lookup.ok) {
        expect(lookup.priceId).toBe(`price_${id}`);
      }
    }
  });

  it("missing or empty env values are typed missing-env problems", () => {
    for (const envValue of [undefined, "", "   "]) {
      const lookup = stripePriceIdFor("starter", envValue);
      expect(lookup).toEqual({
        ok: false,
        problem: { kind: "missing-env", message: "STRIPE_PRICE_IDS is not set." },
      });
    }
  });

  it("invalid JSON is a typed invalid-json problem", () => {
    const lookup = stripePriceIdFor("pro", "{oops}");
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.problem.kind).toBe("invalid-json");
      expect(lookup.problem.message).toContain("JSON");
    }
  });

  it("valid JSON that is not a plan→price object is an invalid-map problem", () => {
    for (const envValue of ['["price_1"]', '"price_1"', "42", "null"]) {
      const lookup = stripePriceIdFor("pro", envValue);
      expect(lookup.ok).toBe(false);
      if (!lookup.ok) {
        expect(lookup.problem.kind).toBe("invalid-map");
      }
    }
  });

  it("non-string or empty price values are invalid-map problems", () => {
    for (const envValue of ['{"starter":42}', '{"starter":""}', '{"starter":null}']) {
      const lookup = stripePriceIdFor("starter", envValue);
      expect(lookup.ok).toBe(false);
      if (!lookup.ok) {
        expect(lookup.problem.kind).toBe("invalid-map");
      }
    }
  });

  it("a valid map without the plan's key is a typed plan-without-price problem", () => {
    const lookup = stripePriceIdFor("studio", '{"starter":"price_starter"}');
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.problem.kind).toBe("plan-without-price");
      expect(lookup.problem.message).toContain("studio");
    }
  });

  it("trial lookups are plan-not-purchasable (D-4); unknown ids are unknown-plan", () => {
    const trial = stripePriceIdFor("trial", CANONICAL_PRICE_MAP);
    expect(trial.ok).toBe(false);
    if (!trial.ok) {
      expect(trial.problem.kind).toBe("plan-not-purchasable");
      expect(trial.problem.message).toContain("DECISIONS D-4");
    }
    const unknown = stripePriceIdFor("enterprise", CANONICAL_PRICE_MAP);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.problem.kind).toBe("unknown-plan");
    }
  });

  it("parseStripePriceIds returns a frozen map and never throws", () => {
    const parsed = parseStripePriceIds(CANONICAL_PRICE_MAP);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.isFrozen(parsed.priceIds)).toBe(true);
      expect(parsed.priceIds.starter).toBe("price_starter");
      expect(() => {
        (parsed.priceIds as Record<string, string>).starter = "price_evil";
      }).toThrow();
    }
    expect(parseStripePriceIds(undefined).ok).toBe(false);
    expect(parseStripePriceIds("nope").ok).toBe(false);
  });

  it("the raw env value is never echoed in problem messages", () => {
    const lookup = stripePriceIdFor("starter", "definitely-not-json");
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.problem.message).not.toContain("definitely-not-json");
    }
  });
});

describe("plans: render formats (D-2)", () => {
  it("declares the contracts wire ids, with MP4 + PNG sequence enabled only", () => {
    expect(RENDER_FORMATS.map((format) => format.id)).toEqual([
      "mp4",
      "png-seq",
      "prores",
      "gif",
      "wav",
    ]);
    expect([...ENABLED_RENDER_FORMATS]).toEqual(["mp4", "png-seq"]);
    for (const format of RENDER_FORMATS) {
      expect(format.label.length).toBeGreaterThan(0);
      if (format.id === "mp4" || format.id === "png-seq") {
        expect(format.enabled).toBe(true);
      } else {
        expect(format.enabled, `${format.id} stays disabled (D-2)`).toBe(false);
      }
    }
  });

  it("isRenderFormatEnabled fails closed on disabled and unknown ids", () => {
    expect(isRenderFormatEnabled("mp4")).toBe(true);
    expect(isRenderFormatEnabled("png-seq")).toBe(true);
    expect(isRenderFormatEnabled("prores")).toBe(false);
    expect(isRenderFormatEnabled("gif")).toBe(false);
    expect(isRenderFormatEnabled("wav")).toBe(false);
    expect(isRenderFormatEnabled("exe")).toBe(false);
    expect(isRenderFormatEnabled("")).toBe(false);
  });

  it("the format catalog and the enabled list are frozen", () => {
    expect(Object.isFrozen(RENDER_FORMATS)).toBe(true);
    expect(Object.isFrozen(ENABLED_RENDER_FORMATS)).toBe(true);
    expect(() => {
      (ENABLED_RENDER_FORMATS as unknown as string[]).push("prores");
    }).toThrow();
  });
});
