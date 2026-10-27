// mergeEditPlans tests — the round-12 pure merge (contracts port of the
// gateway's mergedCarrierPlan, services/gateway/src/litellm/runner.ts). These
// mirror the gateway's litellm-runner.test.ts merge suite ONE FOR ONE (same
// fixtures, same expectations) so the client port and the server original can
// never disagree; extra contracts-side cases cover the summary clamp.

import { describe, expect, it } from "vitest";

import {
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  MAX_PLAN_STEPS,
  MAX_PLAN_SUMMARY_LENGTH,
  estimateCredits,
  mergeEditPlans,
} from "../src/edit-plan.js";

/** A minimal one-step carrier for a given tool (the gateway's carrier shape). */
function carrier(overrides: Partial<EditPlan> = {}): EditPlan {
  const base: EditPlan = {
    intent: "create",
    summary: 'Add text layer "Headline"',
    risk: "low",
    requiresApproval: false,
    affectedLayers: [{ name: "Headline", change: "add text" }],
    estimatedCredits: 1.5,
    steps: [
      {
        title: 'Add text layer "Headline"',
        tool: "studio.create_text",
        args: { text: "Hello", name: "Headline" },
        batch: {
          label: 'Agent: Add text layer "Headline"',
          steps: [{ command: "create_text", params: { text: "Hello", name: "Headline" } }],
        },
      },
    ],
  };
  return { ...base, ...overrides };
}

const CREATE_COMP_CARRIER = carrier({
  intent: "create",
  summary: 'Create composition "Main"',
  risk: "medium",
  affectedLayers: [],
  steps: [
    {
      title: 'Create composition "Main"',
      tool: "studio.create_composition",
      args: { name: "Main", width: 1920, height: 1080 },
      batch: {
        label: 'Agent: Create composition "Main"',
        steps: [{ command: "create_composition", params: { name: "Main" } }],
      },
    },
  ],
});

const SET_PROPS_CARRIER = carrier({
  intent: "edit",
  summary: "Set 1 property on 2 layers",
  risk: "low",
  affectedLayers: [
    { name: "Headline", change: "Set 1 property" },
    { name: "Sub", change: "Set 1 property" },
  ],
  steps: [
    {
      title: "Set 1 property on 2 layers",
      tool: "studio.set_properties",
      args: { layers: [{ name: "Headline" }, { name: "Sub" }] },
      batch: {
        label: "Agent: Set 1 property on 2 layers",
        steps: [{ command: "set_properties", params: {} }],
      },
    },
  ],
});

const UNDO_CARRIER = carrier({
  intent: "organize",
  summary: "Undo the most recent applied agent run",
  risk: "medium",
  affectedLayers: [],
  steps: [
    {
      title: "Undo the most recent applied agent run",
      tool: "studio.undo_run",
      args: {},
      batch: {
        label: "Agent: undo",
        steps: [{ command: "undo_run", params: {} }],
      },
    },
  ],
});

describe("mergeEditPlans (round 12 — mergedCarrierPlan parity)", () => {
  it("one create_text carrier: create intent, low risk, no approval, 1.5 credits", () => {
    const merged = mergeEditPlans([carrier()]);
    if (merged === null) throw new Error("merge returned null");
    expect(merged.intent).toBe("create");
    expect(merged.summary).toBe('Add text layer "Headline"');
    expect(merged.risk).toBe("low");
    expect(merged.requiresApproval).toBe(false); // exact server semantics — always false
    expect(merged.estimatedCredits).toBe(1.5);
    expect(merged.steps).toHaveLength(1);
    expect(merged.steps[0]?.tool).toBe("studio.create_text");
  });

  it("create_composition + create_text: risk is the MAX (medium), same intent kept, summary notes the rest", () => {
    const merged = mergeEditPlans([CREATE_COMP_CARRIER, carrier()]);
    if (merged === null) throw new Error("merge returned null");
    expect(merged.intent).toBe("create");
    expect(merged.risk).toBe("medium");
    expect(merged.summary).toBe('Create composition "Main" (+1 more changes)');
    expect(merged.requiresApproval).toBe(false);
    expect(merged.steps).toHaveLength(2);
    expect(EDIT_PLAN_SCHEMA.safeParse(merged).success).toBe(true);
  });

  it("mixed intents collapse to edit; affected layers dedupe by name", () => {
    const merged = mergeEditPlans([SET_PROPS_CARRIER, carrier()]);
    if (merged === null) throw new Error("merge returned null");
    expect(merged.intent).toBe("edit"); // edit + create ⇒ edit
    expect(merged.affectedLayers.map((layer) => layer.name)).toEqual(["Headline", "Sub"]);
  });

  it("high risk wins over medium (the §6.2 ladder position of the whole change)", () => {
    const high = carrier({ risk: "high", summary: "Replace footage everywhere" });
    const merged = mergeEditPlans([CREATE_COMP_CARRIER, high]);
    if (merged === null) throw new Error("merge returned null");
    expect(merged.risk).toBe("high");
    const mergedLow = mergeEditPlans([carrier(), carrier({ summary: "Second" })]);
    if (mergedLow === null) throw new Error("merge returned null");
    expect(mergedLow.risk).toBe("low");
  });

  it("undo_run carriers are excluded — null when nothing else remains", () => {
    expect(mergeEditPlans([UNDO_CARRIER])).toBeNull();
    expect(mergeEditPlans([])).toBeNull(); // fail-closed, exact server semantics
    const mixed = mergeEditPlans([UNDO_CARRIER, carrier()]);
    if (mixed === null) throw new Error("merge returned null");
    expect(mixed.steps.map((step) => step.tool)).toEqual(["studio.create_text"]);
  });

  it("breadth is capped at MAX_PLAN_STEPS (§8.6: 20)", () => {
    const many = Array.from({ length: MAX_PLAN_STEPS + 5 }, (_, index) =>
      carrier({ summary: `Change ${index}` }),
    );
    const merged = mergeEditPlans(many);
    if (merged === null) throw new Error("merge returned null");
    expect(merged.steps).toHaveLength(MAX_PLAN_STEPS);
  });

  it("summary concatenation is clamped to MAX_PLAN_SUMMARY_LENGTH with an ellipsis", () => {
    const long = carrier({ summary: "y".repeat(MAX_PLAN_SUMMARY_LENGTH) });
    const merged = mergeEditPlans([long, carrier()]);
    if (merged === null) throw new Error("merge returned null");
    expect(merged.summary.length).toBe(MAX_PLAN_SUMMARY_LENGTH);
    expect(merged.summary.endsWith("…")).toBe(true);
    expect(merged.summary.startsWith("y".repeat(MAX_PLAN_SUMMARY_LENGTH - 30))).toBe(true);
  });

  it("credits are recomputed from the merged shape (never summed from carriers)", () => {
    const merged = mergeEditPlans([CREATE_COMP_CARRIER, carrier()]);
    if (merged === null) throw new Error("merge returned null");
    const expected = estimateCredits({ risk: merged.risk, steps: merged.steps });
    expect(merged.estimatedCredits).toBe(expected);
    expect(merged.estimatedCredits).not.toBe(
      CREATE_COMP_CARRIER.estimatedCredits + carrier().estimatedCredits,
    );
  });
});
