/**
 * RunProgressStrip tests (ROUND 12 "Chat UI v3" — the live progress strip).
 * The strip folds from the EXISTING store state (tool cards) and must stay
 * resilient to every absent-data shape (no active run, no tool cards, an
 * authoritative turnCount override).
 */

import { RunProgressStrip, deriveRunProgress } from "@/components/chat/progress-strip";
import type { ChatUiMessage, ChatUiState, ToolCardState } from "@/lib/chat/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function card(toolCallId: string, name: string, status: ToolCardState["status"]): ToolCardState {
  return { toolCallId, name, status };
}

function stateOf(messages: readonly ChatUiMessage[], activeRunId: string | null): ChatUiState {
  return { messages, phase: "streaming", activeRunId, lastSeq: 3 };
}

describe("deriveRunProgress", () => {
  it("folds the live assistant message's tool cards into chips", () => {
    const snapshot = stateOf(
      [
        { id: "m_u", role: "user", text: "make it glow", toolCards: [] },
        {
          id: "m_a",
          role: "assistant",
          text: "",
          runId: "run_1",
          toolCards: [
            card("tc_1", "studio.get_context", "done"),
            card("tc_2", "studio.render_preview", "running"),
            card("tc_3", "studio.plan_edit", "failed"),
            card("tc_4", "studio.list_layers", "queued"),
          ],
        },
      ],
      "run_1",
    );
    expect(deriveRunProgress(snapshot)).toEqual({
      chips: [
        { toolCallId: "tc_1", name: "studio.get_context", status: "done" },
        { toolCallId: "tc_2", name: "studio.render_preview", status: "running" },
        { toolCallId: "tc_3", name: "studio.plan_edit", status: "error" },
        { toolCallId: "tc_4", name: "studio.list_layers", status: "pending" },
      ],
      step: 3, // two terminal cards + the in-flight one
    });
  });

  it("is resilient: no messages, no active run, or no cards ⇒ empty chips, step 1", () => {
    expect(deriveRunProgress(stateOf([], null))).toEqual({ chips: [], step: 1 });
    expect(
      deriveRunProgress(stateOf([{ id: "m_u", role: "user", text: "", toolCards: [] }], null)),
    ).toEqual({
      chips: [],
      step: 1,
    });
    expect(
      deriveRunProgress(stateOf([{ id: "m_a", role: "assistant", text: "", toolCards: [] }], null)),
    ).toEqual({ chips: [], step: 1 });
  });

  it("uses the ACTIVE run's message only (older runs never leak chips)", () => {
    const snapshot = stateOf(
      [
        {
          id: "m_old",
          role: "assistant",
          text: "",
          runId: "run_old",
          toolCards: [card("tc_old", "studio.get_context", "done")],
        },
        { id: "m_a", role: "assistant", text: "", runId: "run_1", toolCards: [] },
      ],
      "run_1",
    );
    expect(deriveRunProgress(snapshot).chips).toEqual([]);
  });
});

describe("RunProgressStrip", () => {
  it("renders nothing unless the phase is live", () => {
    const { container, rerender } = render(<RunProgressStrip phase="idle" chips={[]} />);
    expect(container.firstChild).toBeNull();
    rerender(<RunProgressStrip phase="done" chips={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the honest Working state + step + per-tool chips", () => {
    render(
      <RunProgressStrip
        phase="streaming"
        chips={[
          { toolCallId: "tc_1", name: "studio.get_context", status: "done" },
          { toolCallId: "tc_2", name: "studio.render_preview", status: "running" },
          { toolCallId: "tc_3", name: "studio.plan_edit", status: "error" },
        ]}
      />,
    );
    expect(screen.getByTestId("chat-progress-strip")).toBeInTheDocument();
    expect(screen.getByTestId("chat-progress-step").textContent).toContain("step 3");
    const chips = screen.getAllByTestId("chat-progress-tool");
    expect(chips.map((chip) => chip.dataset.status)).toEqual(["done", "running", "error"]);
    expect(chips[0]?.textContent).toContain("context"); // friendly labels
  });

  it("uses the authoritative turnCount when provided (i4's future fold)", () => {
    render(<RunProgressStrip phase="sending" chips={[]} turnCount={5} />);
    expect(screen.getByTestId("chat-progress-step").textContent).toContain("step 5");
  });

  it("shows Reconnecting in the reconnecting phase (never a fake Working)", () => {
    render(<RunProgressStrip phase="reconnecting" chips={[]} />);
    expect(screen.getByTestId("chat-progress-strip").textContent).toContain("Reconnecting");
  });
});
