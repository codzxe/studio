// checklist-model tests — pure logic, table-driven, no DOM, no network.

import { describe, expect, it } from "vitest";
import {
  CHECKLIST_STEPS,
  applyChecklistOverrides,
  checklistProgress,
  checklistStepMeta,
  countCompletedSteps,
  emptyChecklistSteps,
  isChecklistComplete,
  markChecklistStep,
  nextChecklistStep,
  parseChecklistSteps,
  serializeChecklistSteps,
  type ChecklistSteps,
} from "./checklist-model";

const allFalse = emptyChecklistSteps();

const allDone = (): ChecklistSteps =>
  CHECKLIST_STEPS.reduce(
    (acc, step) => markChecklistStep(acc, step.id, true),
    emptyChecklistSteps(),
  );

describe("parseChecklistSteps", () => {
  it.each([
    ["null", null],
    ["not JSON", "{oops"],
    ["JSON array", "[true, true]"],
    ["JSON string literal", '"yes"'],
    ["unknown keys only", '{"bogus": true, "other": 1}'],
    ["non-boolean values", '{"pick-template": "yes", "first-prompt": 1}'],
  ])("degrades %s to nothing done", (_name, raw) => {
    expect(parseChecklistSteps(raw)).toEqual(allFalse);
  });

  it("keeps known boolean keys and drops the rest", () => {
    const parsed = parseChecklistSteps(
      '{"pick-template": true, "export-design": false, "bogus": true, "first-prompt": "x"}',
    );
    expect(parsed["pick-template"]).toBe(true);
    expect(parsed["export-design"]).toBe(false);
    expect(parsed["first-prompt"]).toBe(false);
    expect("bogus" in parsed).toBe(false);
  });
});

describe("serializeChecklistSteps", () => {
  it("stores only true keys, round-trips through parse", () => {
    const steps = markChecklistStep(
      markChecklistStep(emptyChecklistSteps(), "first-prompt"),
      "export-design",
    );
    const raw = serializeChecklistSteps(steps);
    expect(raw).toBe('{"first-prompt":true,"export-design":true}');
    expect(parseChecklistSteps(raw)).toEqual(steps);
  });
});

describe("markChecklistStep", () => {
  it("never mutates its input", () => {
    const base = emptyChecklistSteps();
    const next = markChecklistStep(base, "pick-template");
    expect(base["pick-template"]).toBe(false);
    expect(next["pick-template"]).toBe(true);
    expect(next).not.toBe(base);
  });
});

describe("applyChecklistOverrides", () => {
  it("applies boolean overrides for known ids only", () => {
    const merged = applyChecklistOverrides(allFalse, {
      "trial-grant": true,
      "create-workspace": "no",
      "pick-template": false,
      bogus: true,
    });
    expect(merged["trial-grant"]).toBe(true);
    expect(merged["pick-template"]).toBe(false);
    expect(merged["create-workspace"]).toBe(false);
  });

  it("returns the base map untouched when overrides are absent", () => {
    expect(applyChecklistOverrides(allFalse, undefined)).toEqual(allFalse);
  });
});

describe("progress math", () => {
  it("counts completed steps", () => {
    const two = markChecklistStep(
      markChecklistStep(emptyChecklistSteps(), "trial-grant"),
      "create-workspace",
    );
    expect(countCompletedSteps(two)).toBe(2);
  });

  it("computes done/total/ratio", () => {
    const steps = markChecklistStep(emptyChecklistSteps(), "pick-template");
    const progress = checklistProgress(steps);
    expect(progress.done).toBe(1);
    expect(progress.total).toBe(5);
    expect(progress.ratio).toBeCloseTo(0.2);
  });

  it("is complete only when all five steps are done", () => {
    const done = allDone();
    expect(isChecklistComplete(done)).toBe(true);
    expect(isChecklistComplete(markChecklistStep(done, "trial-grant", false))).toBe(false);
  });
});

describe("nextChecklistStep", () => {
  it("points at the first incomplete step", () => {
    expect(nextChecklistStep(allFalse)?.id).toBe("trial-grant");
  });

  it("skips completed steps", () => {
    const steps = markChecklistStep(
      markChecklistStep(emptyChecklistSteps(), "trial-grant"),
      "create-workspace",
    );
    expect(nextChecklistStep(steps)?.id).toBe("pick-template");
  });

  it("returns null when everything is done", () => {
    expect(nextChecklistStep(allDone())).toBeNull();
  });
});

describe("checklistStepMeta", () => {
  it("finds metadata for a step id", () => {
    expect(checklistStepMeta("pick-template")?.title).toBe("Pick a template");
  });

  it("lists the three user-action steps in spec order", () => {
    const userTitles = CHECKLIST_STEPS.filter((step) => !step.automatic).map(
      (step) => step.title,
    );
    expect(userTitles).toEqual([
      "Pick a template",
      "Write your first prompt",
      "Export your design",
    ]);
  });

  it("gives every step a title, detail and a non-empty href or retry semantics", () => {
    for (const step of CHECKLIST_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.detail.length).toBeGreaterThan(0);
      if (!step.automatic) expect(step.href.length).toBeGreaterThan(0);
    }
  });
});
