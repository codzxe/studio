/**
 * ChatFooter tests (M4-G2 + M6-H) — the §3.5 status line: model label, credit
 * estimate (with the metering tooltip), the M6-H CURRENT-balance segment
 * (UNITS PIN w3-b01: the §7.4 `credits` event carries whole-credit DISPLAY
 * units — formatted directly; the host prop carries RAW µc (D-12) — converted
 * once; unknown on both sides renders NO segment, never "0.00 credits left")
 * and the shortcut hint.
 */

import { ChatApiContext, type ChatContextApi } from "@/lib/chat/provider";
import { applyUserMessage, createInitialChatUiState, foldEvent } from "@/lib/chat/run-state";
import type { ChatUiState } from "@/lib/chat/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFooter, type ChatFooterProps, formatMicrocredits } from "./footer";

afterEach(() => {
  cleanup();
});

/**
 * One thread state whose last assistant message carries a REAL §7.4 credits
 * snapshot (whole-credit display units — the gateway emitter's documented
 * units, e.g. 42.5 for a 42.50-credit balance).
 */
function snapshotWithCredits(balanceCredits: number): ChatUiState {
  return {
    ...createInitialChatUiState(),
    phase: "done",
    activeRunId: "run_credits",
    lastSeq: 9,
    messages: [
      { id: "msg_user_1", role: "user", text: "Pop the title.", toolCards: [] },
      {
        id: "run_credits",
        role: "assistant",
        text: "Done.",
        runId: "run_credits",
        toolCards: [],
        credits: { reserved: 2, committed: 1, balance: balanceCredits },
      },
    ],
  };
}

/**
 * A COMPLETED round-12 turn run, folded through the REAL reducer: run.started
 * → message.delta → turn.completed (`credits: { committed }` — NO balance on
 * the wire) → run.completed. The fold marks the balance UNKNOWN (NaN) — the
 * shape every production turn run produces today (w3-b01 regression base).
 */
function foldedCompletedTurnRun(): ChatUiState {
  const runId = "run_turn_wire";
  let state = applyUserMessage(createInitialChatUiState(), {
    id: "msg_user_1",
    text: "Pop the title.",
  });
  state = foldEvent(state, { type: "run.started", runId, seq: 0, model: "studio-fast" });
  state = foldEvent(state, { type: "message.delta", runId, seq: 1, delta: "Done." });
  state = foldEvent(state, {
    type: "turn.completed",
    runId,
    seq: 2,
    stepIndex: 0,
    finishReason: "stop",
    usage: { inputTokens: 90, outputTokens: 12 },
    credits: { committed: 1 },
    assistantText: "Done.",
    toolCalls: [],
  });
  return foldEvent(state, { type: "run.completed", runId, seq: 3 });
}

/**
 * Minimal fake chat api — ChatFooter reads `snapshot` only (documented in
 * footer.tsx); the one cast keeps the harness honest about that seam.
 */
function fakeChatApi(snapshot: ChatUiState): ChatContextApi {
  return { snapshot } as unknown as ChatContextApi;
}

type FooterProps = Pick<ChatFooterProps, "modelLabel" | "creditEstimate" | "shortcutHint"> & {
  credits?: ChatFooterProps["credits"];
};

type FooterView = ReturnType<typeof render>;

function renderFooter(props: FooterProps, snapshot: ChatUiState | null = null): FooterView {
  return render(
    <ChatApiContext.Provider value={snapshot === null ? null : fakeChatApi(snapshot)}>
      <ChatFooter {...props} />
    </ChatApiContext.Provider>,
  );
}

describe("ChatFooter", () => {
  it("renders all three M4 segments joined by '·' on one muted line", () => {
    renderFooter({
      modelLabel: "Smart",
      creditEstimate: "~12 credits",
      shortcutHint: "⌘↵ to send",
    });
    const footer = screen.getByTestId("chat-footer");
    expect(screen.getByTestId("chat-footer-model")).toHaveTextContent("Smart");
    expect(screen.getByTestId("chat-footer-credits")).toHaveTextContent("~12 credits");
    expect(screen.getByTestId("chat-footer-shortcut")).toHaveTextContent("⌘↵ to send");
    expect(footer).toHaveTextContent("Smart · ~12 credits · ⌘↵ to send");
    expect(footer.className).toContain("h-7");
    expect(footer.className).toContain("text-muted");
  });

  it("carries the metering tooltip on the credit estimate", () => {
    renderFooter({
      modelLabel: "Fast",
      creditEstimate: "~2 credits",
      shortcutHint: "Ctrl+↵ to send",
    });
    expect(screen.getByTestId("chat-footer-credits")).toHaveAttribute(
      "title",
      "Estimate; actual usage is metered",
    );
    expect(screen.getByTestId("chat-footer")).toHaveTextContent(
      "Fast · ~2 credits · Ctrl+↵ to send",
    );
  });
});

describe("ChatFooter — M6-H balance segment (D-12 display units, pinned w3-b01)", () => {
  it("shows the run-terminal balance in credits with 2 decimals (§7.4 event display units: 42.5 → 42.50)", () => {
    renderFooter(
      { modelLabel: "Smart", creditEstimate: "~12 credits", shortcutHint: "⌘↵ to send" },
      snapshotWithCredits(42.5),
    );
    const balance = screen.getByTestId("chat-footer-balance");
    expect(balance).toHaveTextContent("42.50 credits left");
    expect(screen.getByTestId("chat-footer")).toHaveTextContent(
      "Smart · ~12 credits · 42.50 credits left · ⌘↵ to send",
    );
    expect(balance).not.toHaveAttribute("data-exhausted");
  });

  it("refreshes after each run settles — a new REAL snapshot re-renders the new balance (display 0 → 0.00, exhausted)", () => {
    const view = renderFooter(
      { modelLabel: "Smart", creditEstimate: "~12 credits", shortcutHint: "⌘↵ to send" },
      snapshotWithCredits(42.5),
    );
    expect(screen.getByTestId("chat-footer-balance")).toHaveTextContent("42.50 credits left");

    view.rerender(
      <ChatApiContext.Provider value={fakeChatApi(snapshotWithCredits(0))}>
        <ChatFooter modelLabel="Smart" creditEstimate="~12 credits" shortcutHint="⌘↵ to send" />
      </ChatApiContext.Provider>,
    );
    const balance = screen.getByTestId("chat-footer-balance");
    expect(balance).toHaveTextContent("0.00 credits left");
    expect(balance).toHaveAttribute("data-exhausted", "true");
  });

  it("a COMPLETED turn run (no §7.4 credits event) never renders a fabricated zero — the host prop's REAL balance shows instead (w3-b01)", () => {
    // The turn wire folds an UNKNOWN (NaN) balance; the old code rendered it
    // as "0.00 credits left" + data-exhausted after EVERY run. With a real
    // host-fetched balance present (42,500,000 µc = 42.50 credits), that is
    // the number that must show.
    renderFooter(
      {
        modelLabel: "Smart",
        creditEstimate: "~12 credits",
        shortcutHint: "⌘↵ to send",
        credits: { balanceMicro: 42_500_000 },
      },
      foldedCompletedTurnRun(),
    );
    const balance = screen.getByTestId("chat-footer-balance");
    expect(balance).toHaveTextContent("42.50 credits left");
    expect(balance).not.toHaveAttribute("data-exhausted");
    expect(screen.getByTestId("chat-footer")).toHaveTextContent(
      "Smart · ~12 credits · 42.50 credits left · ⌘↵ to send",
    );
  });

  it("a COMPLETED turn run with NO host prop renders NO balance segment at all (unknown ≠ 0)", () => {
    renderFooter(
      { modelLabel: "Smart", creditEstimate: "~12 credits", shortcutHint: "⌘↵ to send" },
      foldedCompletedTurnRun(),
    );
    expect(screen.queryByTestId("chat-footer-balance")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-footer")).toHaveTextContent("Smart · ~12 credits · ⌘↵ to send");
  });

  it("renders NO balance segment before a run reported credits (the exact M4 line)", () => {
    renderFooter(
      { modelLabel: "Smart", creditEstimate: "~12 credits", shortcutHint: "⌘↵ to send" },
      createInitialChatUiState(),
    );
    expect(screen.queryByTestId("chat-footer-balance")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-footer")).toHaveTextContent("Smart · ~12 credits · ⌘↵ to send");
  });

  it("fills the balance from the host prop (billingState) with the plan-allowance context", () => {
    renderFooter({
      modelLabel: "Smart",
      creditEstimate: "~12 credits",
      shortcutHint: "⌘↵ to send",
      credits: { balanceMicro: 12_345_678, planAllowanceMicro: 500_000_000 },
    });
    const balance = screen.getByTestId("chat-footer-balance");
    expect(balance).toHaveTextContent("12.35 credits left · 500/mo included");
    expect(balance).toHaveAttribute(
      "title",
      "Current balance — refreshed after each run. Plan includes 500 credits monthly",
    );
  });

  it("the run-terminal balance wins over the host prop (fresher evidence, same display units)", () => {
    renderFooter(
      {
        modelLabel: "Smart",
        creditEstimate: "~12 credits",
        shortcutHint: "⌘↵ to send",
        credits: { balanceMicro: 1_000_000 },
      },
      snapshotWithCredits(42.5),
    );
    expect(screen.getByTestId("chat-footer-balance")).toHaveTextContent("42.50 credits left");
  });

  it("hostile numbers render nothing and hostile labels stay inert text (law #1)", () => {
    const view = renderFooter({
      modelLabel: "<img src=x onerror=alert(1)>",
      creditEstimate: "~12 credits",
      shortcutHint: "⌘↵ to send",
      credits: { balanceMicro: Number.NaN, planAllowanceMicro: -1 },
    });
    expect(screen.queryByTestId("chat-footer-balance")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-footer-model").textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(view.container.querySelector("img")).toBeNull();

    const hostile = renderFooter(
      { modelLabel: "Smart", creditEstimate: "~12 credits", shortcutHint: "⌘↵ to send" },
      snapshotWithCredits(Number.POSITIVE_INFINITY),
    );
    expect(hostile.queryByTestId("chat-footer-balance")).not.toBeInTheDocument();
  });
});

describe("formatMicrocredits (D-12 display conversion — total, never throws)", () => {
  it("converts µc to credits with up to 2 decimals", () => {
    expect(formatMicrocredits(0)).toBe("0.00");
    expect(formatMicrocredits(1)).toBe("0.00");
    expect(formatMicrocredits(999_999)).toBe("1.00"); // rounds up at the hundredth boundary
    expect(formatMicrocredits(2_550_000)).toBe("2.55");
    expect(formatMicrocredits(10_000_000_000)).toBe("10,000.00"); // Studio-plan allowance scale
  });

  it("returns null for hostile input (no fabricated balances)", () => {
    expect(formatMicrocredits(Number.NaN)).toBeNull();
    expect(formatMicrocredits(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatMicrocredits(-5)).toBeNull();
  });
});
