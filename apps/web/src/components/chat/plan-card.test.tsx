/**
 * PlanCard tests (M4-F) — the M4-informational plan card: header/intent/steps/
 * affected/credits/note, risk badge mapping, high-risk chrome, and the
 * read-only guarantee (NO Apply/Cancel). Deterministic; jsdom.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EditPlan } from "@studio/contracts";
import { PlanCard } from "./plan-card";

function plan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    intent: "animate",
    summary: "Animate the headline scale with a springy overshoot",
    risk: "low",
    requiresApproval: true,
    affectedLayers: [
      { name: "Headline", change: "Keyframe Scale" },
      { name: "Subhead", change: "Delay 0.2s" },
    ],
    estimatedCredits: 12,
    steps: [
      {
        title: "Keyframe Scale 20% → 110% → 100%",
        tool: "studio.plan_edit",
        args: {},
        batch: { label: "Agent: animate headline", steps: [{ command: "prop.set", params: {} }] },
      },
      {
        title: "Add overshoot at 0.45s",
        tool: "studio.plan_edit",
        args: {},
        batch: { label: "Agent: overshoot", steps: [{ command: "prop.set", params: {} }] },
      },
    ],
    ...overrides,
  };
}

describe("PlanCard — §6.2 informational layout", () => {
  it("renders the ✦ Plan · <summary> header, intent chip and risk badge", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(plan().summary)).toBeInTheDocument();
    expect(screen.getByTestId("plan-intent")).toHaveTextContent("Animate");
    expect(screen.getByTestId("plan-risk")).toHaveTextContent("Low risk");
  });

  it("renders numbered steps (titles only) in order", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    const steps = within(screen.getByTestId("plan-steps")).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent("1.");
    expect(steps[0]).toHaveTextContent("Keyframe Scale 20% → 110% → 100%");
    expect(steps[1]).toHaveTextContent("2.");
    expect(steps[1]).toHaveTextContent("Add overshoot at 0.45s");
  });

  it("renders the affected layers line and the credit estimate", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByTestId("plan-affected")).toHaveTextContent("Affected: Headline, Subhead");
    expect(screen.getByTestId("plan-credits")).toHaveTextContent("≈ 12 credits");
  });

  it("omits the Affected line when the plan touches no layers", () => {
    render(<PlanCard plan={plan({ affectedLayers: [] })} applied={false} />);
    expect(screen.queryByTestId("plan-affected")).not.toBeInTheDocument();
  });

  it("carries the pinned M4 note by default and honours a custom note", () => {
    const first = render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByTestId("plan-note")).toHaveTextContent(
      "Apply arrives with M5 — this plan is a preview.",
    );
    first.unmount();

    render(<PlanCard plan={plan()} applied={false} note="Custom note." />);
    expect(screen.getByTestId("plan-note")).toHaveTextContent("Custom note.");
    expect(screen.getByTestId("plan-note")).not.toHaveTextContent("M5");
  });
});

describe("PlanCard — risk badges (§6.2)", () => {
  it("low renders the success tone", () => {
    render(<PlanCard plan={plan({ risk: "low" })} applied={false} />);
    const badge = screen.getByTestId("plan-risk");
    expect(badge).toHaveTextContent("Low risk");
    expect(badge.className).toContain("text-success");
    expect(screen.getByTestId("plan-card").className).toContain("border-strong");
  });

  it("medium renders the amber tone", () => {
    render(<PlanCard plan={plan({ risk: "medium" })} applied={false} />);
    const badge = screen.getByTestId("plan-risk");
    expect(badge).toHaveTextContent("Medium risk");
    expect(badge.className).toContain("text-warning");
  });

  it("high renders red, the stronger border AND the explicit confirmation line", () => {
    render(<PlanCard plan={plan({ risk: "high" })} applied={false} />);
    const badge = screen.getByTestId("plan-risk");
    expect(badge).toHaveTextContent("High risk");
    expect(badge.className).toContain("text-danger");
    expect(screen.getByTestId("plan-card").className).toContain("border-danger");
    expect(screen.getByTestId("plan-requires-confirmation")).toHaveTextContent(
      /requires confirmation/i,
    );
  });

  it("renders every intent as a chip", () => {
    for (const intent of [
      "create",
      "edit",
      "animate",
      "style",
      "organize",
      "render",
      "explain",
      "clarify",
    ] as const) {
      const rendered = render(<PlanCard plan={plan({ intent })} applied={false} />);
      expect(screen.getByTestId("plan-intent")).toHaveTextContent(
        intent.charAt(0).toUpperCase() + intent.slice(1),
      );
      expect(screen.getByTestId("plan-card")).toHaveAttribute("data-intent", intent);
      rendered.unmount();
    }
  });
});

describe("PlanCard — read-only in M4 (no apply path)", () => {
  it("renders NO buttons at all — no Apply, no Cancel, no Preview", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Apply")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("stamps applied=false for M4-J (data attribute for the M5 widening)", () => {
    render(<PlanCard plan={plan()} applied={false} />);
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-applied", "false");
    expect(screen.getByTestId("plan-card")).toHaveAttribute("data-requires-approval", "true");
  });
});
