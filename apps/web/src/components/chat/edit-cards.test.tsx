/**
 * Edit cards tests (M5-I; EDITOR_CHAT_UX §6.4 + contracts §8.6 "clarify").
 *
 * Law #1 is the error card's whole job: typed failures render human, actionable
 * copy — NEVER a stack trace, absolute path, object key or internal id. Every
 * string renders as data (React text nodes; no innerHTML, no raw code).
 */

import {
  ClarifyCard,
  EDIT_ERROR_GENERIC_COPY,
  EditErrorCard,
  clarifyAnswerPrompt,
  humanizeEditError,
} from "@/components/chat/edit-cards";
import type { EditPlan } from "@studio/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One valid plan step (the §8.6 shape the M4-L/M5-G fixtures use). */
const STEP = {
  title: "Restyle the target layer",
  tool: "studio.plan_edit",
  args: {},
  batch: { label: "Agent: restyle", steps: [{ command: "prop.set", params: {} }] },
};

function clarifyPlan(
  summary: string,
  names: string[],
  intent: EditPlan["intent"] = "clarify",
): EditPlan {
  return {
    intent,
    summary,
    risk: "low",
    requiresApproval: false,
    affectedLayers: names.map((name) => ({ name, change: "restyle" })),
    estimatedCredits: 1,
    steps: [STEP],
  };
}

// ---------------------------------------------------------------------------
// humanizeEditError — the law #1 mapping
// ---------------------------------------------------------------------------

describe("humanizeEditError", () => {
  it("maps known codes to curated copy and never renders the code", () => {
    expect(humanizeEditError({ code: "RUN_PAUSED" })).toBe(
      "The run paused. Check your connection and retry.",
    );
    expect(humanizeEditError({ code: "INSUFFICIENT_CREDITS" })).toBe(
      "You're out of credits for this run. Top up to continue.",
    );
    expect(humanizeEditError({ code: "VERSION_CONFLICT" })).toBe(
      "This project changed elsewhere. Reload to compare versions.",
    );
  });

  it("shows a short human message for unknown codes", () => {
    expect(humanizeEditError({ code: "SOMETHING_ELSE", message: "Which layer should I change?" })).toBe(
      "Which layer should I change?",
    );
  });

  it("degrades machine-shaped payloads to the generic line (law #1)", () => {
    const hostile = [
      'at compile (/home/z/plan.rs:44:3) {"secret": true}',
      "Error: node_modules/foo/index.ts:22 blew up",
      "failed: /Users/dev/secret-project/x.tsx:1:1",
      `{"error":"TOOL_FAILED","raw":"0xdeadbeef"}`,
      "at fn (0x7ffee4c0b8f8)",
    ];
    for (const message of hostile) {
      expect(humanizeEditError({ code: "TOOL_X", message })).toBe(EDIT_ERROR_GENERIC_COPY);
    }
  });

  it("degrades over-long or empty messages to the generic line", () => {
    expect(humanizeEditError({ code: "X", message: "x".repeat(500) })).toBe(EDIT_ERROR_GENERIC_COPY);
    expect(humanizeEditError({ code: "X", message: "   " })).toBe(EDIT_ERROR_GENERIC_COPY);
    expect(humanizeEditError({ code: "X" })).toBe(EDIT_ERROR_GENERIC_COPY);
  });
});

// ---------------------------------------------------------------------------
// EditErrorCard
// ---------------------------------------------------------------------------

describe("EditErrorCard", () => {
  it("renders as an alert with the human copy, retry and dismiss wired", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(
      <EditErrorCard
        failure={{ code: "RATE_LIMITED" }}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByTestId("edit-error-card")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("edit-error-copy")).toHaveTextContent(
      "Too many requests in a row. Wait a moment and retry.",
    );

    fireEvent.click(screen.getByTestId("edit-error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("edit-error-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers no retry and no dismiss when the seams are absent", () => {
    render(<EditErrorCard failure={{ code: "RUN_PAUSED" }} />);
    expect(screen.queryByTestId("edit-error-retry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("edit-error-dismiss")).not.toBeInTheDocument();
  });

  it("never leaks internals: hostile messages, paths and codes stay out of the DOM", () => {
    const hostileMessage =
      'at plan (/home/z/studio/services/gateway/src/plan-compiler.rs:9:13) {"batch":{"steps":[{"command":"layer.delete"}]}}';
    const hostileCode = '</section><script>alert("x")</script>';
    render(
      <EditErrorCard failure={{ code: hostileCode, message: hostileMessage }} onRetry={() => undefined} />,
    );
    const dom = document.body.textContent ?? "";
    expect(dom).not.toContain("/home/z");
    expect(dom).not.toContain("plan-compiler.rs");
    expect(dom).not.toContain("layer.delete");
    expect(dom).not.toContain("<script>");
    expect(dom).not.toContain(hostileCode);
    expect(screen.getByTestId("edit-error-copy")).toHaveTextContent(EDIT_ERROR_GENERIC_COPY);
  });
});

// ---------------------------------------------------------------------------
// ClarifyCard
// ---------------------------------------------------------------------------

describe("ClarifyCard", () => {
  it("renders the model's question plus one answer chip per candidate layer", () => {
    const onAnswer = vi.fn();
    render(
      <ClarifyCard
        plan={clarifyPlan("Which text layer should I change?", ["Headline", "Subhead", "Badge"])}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByTestId("edit-clarify-question")).toHaveTextContent(
      "Which text layer should I change?",
    );
    const chips = screen.getAllByTestId("edit-clarify-answer");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Headline", "Subhead", "Badge"]);

    fireEvent.click(chips[0] as HTMLElement);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(clarifyAnswerPrompt("Headline"));
    expect(clarifyAnswerPrompt("Headline")).toBe("Go with “Headline”.");
  });

  it("caps the answer chips at four candidates", () => {
    render(
      <ClarifyCard
        plan={clarifyPlan("Which layer?", ["A", "B", "C", "D", "E", "F"])}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getAllByTestId("edit-clarify-answer")).toHaveLength(4);
  });

  it("renders the composer hint when the plan carries no candidates, and dismisses on demand", () => {
    const onDismiss = vi.fn();
    render(
      <ClarifyCard plan={clarifyPlan("Should I continue?", [])} onAnswer={() => undefined} onDismiss={onDismiss} />,
    );
    expect(screen.queryByTestId("edit-clarify-answer")).not.toBeInTheDocument();
    expect(screen.getByTestId("edit-clarify-hint")).toHaveTextContent(
      "Answer with the composer below.",
    );
    fireEvent.click(screen.getByTestId("edit-clarify-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for a non-clarify plan (the mounter's guard is doubled here)", () => {
    const { container } = render(
      <ClarifyCard plan={clarifyPlan("Edit all the layers", ["A"], "edit")} onAnswer={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders hostile model output as data — never markup", () => {
    const hostileSummary = '<img src=x onerror="alert(1)"> — which layer?';
    const hostileName = "<b>Bold</b>";
    render(
      <ClarifyCard
        plan={clarifyPlan(hostileSummary, [hostileName])}
        onAnswer={() => undefined}
      />,
    );
    // The question and the chip label appear as literal TEXT.
    expect(screen.getByTestId("edit-clarify-question")).toHaveTextContent(hostileSummary);
    expect(screen.getByTestId("edit-clarify-answer")).toHaveTextContent(hostileName);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });
});
