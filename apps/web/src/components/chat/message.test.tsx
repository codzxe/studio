/**
 * ChatMessageView tests (M4-F) — user vs assistant presentation (no avatars),
 * the streaming caret + "Thinking…" skeleton, and the inline credits notice.
 * Deterministic; no network; jsdom.
 */

import type { ChatUiMessage, ToolCardState } from "@/lib/chat/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMessageView } from "./message";

const user = (text: string): ChatUiMessage => ({
  id: "u1",
  role: "user",
  text,
  toolCards: [],
});

const assistant = (overrides: Partial<ChatUiMessage> = {}): ChatUiMessage => ({
  id: "a1",
  role: "assistant",
  text: "Working on it",
  runId: "run-1",
  toolCards: [],
  ...overrides,
});

describe("ChatMessageView — roles (ECUX §3.3: no avatars)", () => {
  it("renders a user message with the You label on a raised surface", () => {
    render(<ChatMessageView message={user("Make the headline pop")} isStreaming={false} />);
    const message = screen.getByTestId("chat-message");
    expect(message).toHaveAttribute("data-role", "user");
    expect(screen.getByTestId("chat-message-label")).toHaveTextContent("You");
    expect(screen.getByText("Make the headline pop")).toBeInTheDocument();
    // The user surface: subtle raised --bg-elevated bubble, 72ch max.
    expect(message.innerHTML).toContain("bg-elevated");
    expect(message.innerHTML).toContain("max-w-[72ch]");
    expect(message.innerHTML).toContain("rounded-[var(--chat-message-radius)]");
    // §9 letter-spec (W2-09): surface + radius ONLY — no border-subtle hairline.
    expect(message.innerHTML).not.toContain("border-subtle");
    expect(message.innerHTML).not.toContain("border border");
    // NO avatars anywhere.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders an assistant message with the sparkle Agent label, plain on the panel background", () => {
    render(<ChatMessageView message={assistant()} isStreaming={false} />);
    const message = screen.getByTestId("chat-message");
    expect(message).toHaveAttribute("data-role", "assistant");
    expect(screen.getByTestId("chat-message-label")).toHaveTextContent("✦ Agent");
    expect(screen.getByText("Working on it")).toBeInTheDocument();
    // Assistant text is left-aligned, plain (no bubble surface), 72ch max.
    expect(message.innerHTML).toContain("max-w-[72ch]");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders markdown in the message text", () => {
    render(<ChatMessageView message={assistant({ text: "**Done.**" })} isStreaming={false} />);
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.getByText("Done.").tagName).toBe("STRONG");
  });
});

describe("ChatMessageView — streaming", () => {
  it("shows the caret on a streaming assistant message and none otherwise", () => {
    const streaming = render(<ChatMessageView message={assistant()} isStreaming />);
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
    streaming.unmount();

    const idle = render(<ChatMessageView message={assistant()} isStreaming={false} />);
    expect(screen.queryByTestId("chat-caret")).not.toBeInTheDocument();
    idle.unmount();

    // A "streaming" user message can never show a caret (guard).
    render(<ChatMessageView message={user("steer")} isStreaming />);
    expect(screen.queryByTestId("chat-caret")).not.toBeInTheDocument();
  });

  it("shows the live Thinking indicator (with elapsed clock) while the assistant text is still empty", () => {
    render(<ChatMessageView message={assistant({ text: "" })} isStreaming />);
    // ROUND 13: the static "Thinking…" string became a LIVE indicator — pulsing
    // dot + "Thinking" + a ticking elapsed clock (jsdom: no startedAt → no
    // clock span yet; the dot + label still prove the alive state).
    expect(screen.getByTestId("chat-thinking")).toHaveTextContent("Thinking");
    expect(screen.getByTestId("chat-thinking-dot")).toBeInTheDocument();
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
  });

  it("streams reasoning tokens into the collapsible thinking bar (round 13 live thinking)", () => {
    render(
      <ChatMessageView
        message={assistant({
          text: "",
          reasoning: "Plan: one composition, then a text layer.",
          reasoningStartedAt: Date.now() - 4_000,
        })}
        isStreaming
      />,
    );
    // The bar replaces the indicator line while thinking tokens stream: open
    // by default with the live text + caret, header shows the live clock.
    const bar = screen.getByTestId("chat-reasoning");
    expect(bar).toBeInTheDocument();
    expect(screen.queryByTestId("chat-thinking")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-reasoning-body")).toHaveTextContent(
      "Plan: one composition, then a text layer.",
    );
    expect(screen.getByTestId("chat-reasoning-caret")).toBeInTheDocument();
    expect(screen.getByTestId("chat-reasoning-header")).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses the thinking bar to 'Thought for Ns' once the answer text starts", () => {
    render(
      <ChatMessageView
        message={assistant({
          text: "Building it now.",
          reasoning: "Plan: one composition.",
          reasoningStartedAt: Date.now() - 4_000,
          reasoningEndedAt: Date.now() - 1_000,
        })}
        isStreaming
      />,
    );
    expect(screen.getByTestId("chat-reasoning-done")).toHaveTextContent("Thought for 3s");
    expect(screen.queryByTestId("chat-reasoning-body")).not.toBeInTheDocument();
    // One click re-expands (the user's toggle wins).
    fireEvent.click(screen.getByTestId("chat-reasoning-header"));
    expect(screen.getByTestId("chat-reasoning-body")).toBeInTheDocument();
  });

  it("shows no Thinking line once text arrives, even while streaming", () => {
    render(<ChatMessageView message={assistant({ text: "partial answer" })} isStreaming />);
    expect(screen.queryByTestId("chat-thinking")).not.toBeInTheDocument();
    expect(screen.getByText("partial answer")).toBeInTheDocument();
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
  });
});

describe("ChatMessageView — cards, plan and credits", () => {
  it("renders the tool calls under the collapsible bar: folded when settled, one click opens the cards (round 13)", () => {
    const cards: ToolCardState[] = [
      { toolCallId: "tc_1", name: "studio.list_layers", status: "done", result: { layers: 3 } },
    ];
    render(<ChatMessageView message={assistant({ toolCards: cards })} isStreaming={false} />);
    // Settled run ⇒ the summary line, cards folded.
    const header = screen.getByTestId("chat-tools-header");
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header.textContent).toContain("Used 1 tool call");
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
    // One click opens the full cards.
    fireEvent.click(header);
    expect(screen.getByTestId("tool-card")).toHaveAttribute("data-tool", "studio.list_layers");
    expect(screen.getByText("List layers")).toBeInTheDocument();
  });

  it("keeps the tool bar OPEN while the run streams (live activity, round 13)", () => {
    const cards: ToolCardState[] = [
      { toolCallId: "tc_1", name: "studio.create_text", status: "running" },
      { toolCallId: "tc_2", name: "studio.set_properties", status: "done", result: { ok: true } },
    ];
    render(<ChatMessageView message={assistant({ toolCards: cards })} isStreaming />);
    expect(screen.getByTestId("chat-tools-header")).toHaveAttribute("aria-expanded", "true");
    // Every tool is labelled (write tools no longer render raw studio.* ids).
    // The header names the RUNNING call, so labels can appear twice.
    expect(screen.getAllByTestId("tool-card")).toHaveLength(2);
    expect(screen.getAllByText("Create text layer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Set properties").length).toBeGreaterThan(0);
    expect(screen.getByTestId("chat-tools-spinner")).toBeInTheDocument();
  });

  it("renders the message's plan as the M4 informational card", () => {
    render(
      <ChatMessageView
        message={assistant({
          plan: {
            intent: "edit",
            summary: "Bump the headline size",
            risk: "low",
            requiresApproval: false,
            affectedLayers: [{ name: "Headline", change: "font size" }],
            estimatedCredits: 3,
            steps: [
              {
                title: "Set font size 72",
                tool: "studio.plan_edit",
                args: {},
                batch: {
                  label: "Agent: bump headline",
                  steps: [{ command: "prop.set", params: {} }],
                },
              },
            ],
          },
        })}
        isStreaming={false}
      />,
    );
    expect(screen.getByTestId("plan-card")).toBeInTheDocument();
    expect(screen.getByText("Bump the headline size")).toBeInTheDocument();
  });

  it("renders the credits snapshot as a system-style inline line", () => {
    render(
      <ChatMessageView
        message={assistant({ credits: { reserved: 12, committed: 7, balance: 42 } })}
        isStreaming={false}
      />,
    );
    expect(screen.getByTestId("chat-credits")).toHaveTextContent("7 credits used · balance 42");
  });

  it("renders credits-used WITHOUT a balance when the balance is unknown — the round-12 turn wire (w3-b01)", () => {
    // turn.completed carries `credits: { committed }` only; the fold marks
    // reserved/balance UNKNOWN (NaN). The old render printed the fabricated
    // "balance 0" under every reply — the unknown balance must render nothing.
    render(
      <ChatMessageView
        message={assistant({
          credits: { reserved: Number.NaN, committed: 7, balance: Number.NaN },
        })}
        isStreaming={false}
      />,
    );
    const credits = screen.getByTestId("chat-credits");
    expect(credits).toHaveTextContent("7 credits used");
    expect(credits).not.toHaveTextContent("balance");
  });
});
