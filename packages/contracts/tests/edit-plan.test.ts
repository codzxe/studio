import { describe, expect, it } from "vitest";

import {
  AUTO_APPLYABLE_INTENTS,
  EDIT_PLAN_SCHEMA,
  ESTIMATE_BASE_CREDITS,
  ESTIMATE_CREDITS_PER_STEP,
  ESTIMATE_RISK_MULTIPLIERS,
  type EditPlan,
  MAX_PLAN_AFFECTED_LAYERS,
  MAX_PLAN_STEPS,
  MAX_PLAN_SUMMARY_LENGTH,
  PLAN_INTENT_SCHEMA,
  PLAN_RISK_SCHEMA,
  estimateCredits,
  isAutoApplicable,
  isRiskAtLeast,
  needsConfirmCheckbox,
  reserveFor,
} from "../src/edit-plan.js";

function step(title: string): EditPlan["steps"][number] {
  return {
    title,
    tool: "studio.set_properties",
    args: { updates: [] },
    batch: {
      label: `Agent: ${title}`,
      steps: [{ command: "prop.set", params: { path: "transform/opacity", value: 100 } }],
    },
  };
}

function validPlan(): Record<string, unknown> {
  return {
    intent: "animate",
    summary: "Keyframe Scale on the Headline layer",
    risk: "low",
    requiresApproval: true,
    affectedLayers: [{ name: "Headline", change: "add scale keyframes" }],
    estimatedCredits: 2,
    steps: [step("Keyframe scale"), step("Add overshoot")],
  };
}

describe("edit-plan: §8.6 acceptance", () => {
  it("parses a valid plan", () => {
    const parsed = EDIT_PLAN_SCHEMA.safeParse(validPlan());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.intent).toBe("animate");
    expect(parsed.data.steps).toHaveLength(2);
  });

  it("accepts the full intent and risk enums", () => {
    expect(PLAN_INTENT_SCHEMA.options).toEqual([
      "create",
      "edit",
      "animate",
      "style",
      "organize",
      "render",
      "explain",
      "clarify",
    ]);
    expect(PLAN_RISK_SCHEMA.options).toEqual(["low", "medium", "high"]);
  });

  it("rejects bad risk and bad intent", () => {
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), risk: "extreme" }).success).toBe(false);
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), intent: "destroy" }).success).toBe(false);
  });

  it("rejects summaries over 280 chars", () => {
    const summary = "x".repeat(MAX_PLAN_SUMMARY_LENGTH + 1);
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), summary }).success).toBe(false);
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), summary: "x".repeat(280) }).success).toBe(
      true,
    );
  });

  it("rejects empty and >20-step plans", () => {
    const over = {
      ...validPlan(),
      steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => step(`s${i}`)),
    };
    expect(EDIT_PLAN_SCHEMA.safeParse(over).success).toBe(false);
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), steps: [] }).success).toBe(false);
    expect(
      EDIT_PLAN_SCHEMA.safeParse({
        ...validPlan(),
        steps: Array.from({ length: MAX_PLAN_STEPS }, (_, i) => step(`s${i}`)),
      }).success,
    ).toBe(true);
  });

  it("rejects >50 affected layers and negative credits", () => {
    const tooMany = Array.from({ length: MAX_PLAN_AFFECTED_LAYERS + 1 }, () => ({
      name: "L",
      change: "c",
    }));
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), affectedLayers: tooMany }).success).toBe(
      false,
    );
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), estimatedCredits: -0.01 }).success).toBe(
      false,
    );
    expect(EDIT_PLAN_SCHEMA.safeParse({ ...validPlan(), estimatedCredits: 0 }).success).toBe(true);
  });

  it("bounds each step batch to 1..100 commands", () => {
    const tiny: unknown = {
      ...validPlan(),
      steps: [{ ...step("x"), batch: { label: "l", steps: [] } }],
    };
    expect(EDIT_PLAN_SCHEMA.safeParse(tiny).success).toBe(false);
    const commands = Array.from({ length: 101 }, (_, i) => ({ command: `c${i}`, params: {} }));
    const huge: unknown = {
      ...validPlan(),
      steps: [{ ...step("x"), batch: { label: "l", steps: commands } }],
    };
    expect(EDIT_PLAN_SCHEMA.safeParse(huge).success).toBe(false);
  });

  it("allows affected layers with only a name (id optional)", () => {
    const parsed = EDIT_PLAN_SCHEMA.safeParse({
      ...validPlan(),
      affectedLayers: [{ id: 3, name: "Badge", change: "recolor" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("edit-plan: PlanRisk helpers (§6.2, §7.3)", () => {
  it("orders risks and gates UI chrome", () => {
    expect(isRiskAtLeast("high", "medium")).toBe(true);
    expect(isRiskAtLeast("low", "medium")).toBe(false);
    expect(needsConfirmCheckbox("high")).toBe(true);
    expect(needsConfirmCheckbox("medium")).toBe(false);
    expect(needsConfirmCheckbox("low")).toBe(false);
  });

  it("auto-apply (§7.3 v2): approval-free, non-high-risk, create/edit/style/animate", () => {
    const base = validPlan() as EditPlan;
    expect(
      isAutoApplicable({ ...base, risk: "low", requiresApproval: false, intent: "edit" }),
    ).toBe(true);
    // v2: MEDIUM (many layers/effects — normal creation work) passes.
    expect(
      isAutoApplicable({ ...base, risk: "medium", requiresApproval: false, intent: "edit" }),
    ).toBe(true);
    expect(
      isAutoApplicable({ ...base, risk: "medium", requiresApproval: false, intent: "create" }),
    ).toBe(true);
    // HIGH still waits, approval still wins, render/organize still excluded.
    expect(
      isAutoApplicable({ ...base, risk: "high", requiresApproval: false, intent: "edit" }),
    ).toBe(false);
    expect(isAutoApplicable({ ...base, risk: "low", requiresApproval: true, intent: "edit" })).toBe(
      false,
    );
    expect(
      isAutoApplicable({ ...base, risk: "low", requiresApproval: false, intent: "render" }),
    ).toBe(false);
    expect(
      isAutoApplicable({ ...base, risk: "low", requiresApproval: false, intent: "organize" }),
    ).toBe(false);
    expect([...AUTO_APPLYABLE_INTENTS]).toEqual(["create", "edit", "style", "animate"]);
  });
});

describe("edit-plan: deterministic credit estimate (§8.8)", () => {
  it("uses the documented base + per-step formula with risk multipliers", () => {
    const one = { risk: "low" as const, steps: [step("a")] };
    expect(estimateCredits(one)).toBe(
      (ESTIMATE_BASE_CREDITS + ESTIMATE_CREDITS_PER_STEP) * ESTIMATE_RISK_MULTIPLIERS.low,
    );
    const ten = {
      risk: "high" as const,
      steps: Array.from({ length: 10 }, (_, i) => step(`s${i}`)),
    };
    expect(estimateCredits(ten)).toBe(
      (ESTIMATE_BASE_CREDITS + 10 * ESTIMATE_CREDITS_PER_STEP) * ESTIMATE_RISK_MULTIPLIERS.high,
    );
  });

  it("is deterministic and monotonic in steps", () => {
    const p = (n: number) => ({
      risk: "medium" as const,
      steps: Array.from({ length: n }, (_, i) => step(`s${i}`)),
    });
    expect(estimateCredits(p(3))).toBe(estimateCredits(p(3)));
    expect(estimateCredits(p(5))).toBeGreaterThan(estimateCredits(p(4)));
    // rounds to 2 decimals (float noise must not leak onto the wire)
    expect(estimateCredits(p(3))).toBe(Math.round(estimateCredits(p(3)) * 100) / 100);
  });

  it("reserveFor: estimated × 1.2 with a floor of 1 (§8.8)", () => {
    expect(reserveFor(10)).toBe(12);
    expect(reserveFor(0)).toBe(1);
    expect(reserveFor(1.5)).toBe(1.8);
    expect(reserveFor(0.01)).toBe(1); // never reserve below the minimum
  });
});
