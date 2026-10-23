/**
 * ChatMessageView tests (M4-F) — user vs assistant presentation (no avatars),
 * the streaming caret + "Thinking…" skeleton, and the inline credits notice.
 * Deterministic; no network; jsdom.
 */

import type { ChatUiMessage, ToolCardState } from "@/lib/chat/types";
import { render, screen } from "@testing-library/react";
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

  it("shows the Thinking… skeleton while the active assistant text is still empty", () => {
    render(<ChatMessageView message={assistant({ text: "" })} isStreaming />);
    expect(screen.getByTestId("chat-thinking")).toHaveTextContent("Thinking…");
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
  });

  it("shows no Thinking… line once text arrives, even while streaming", () => {
    render(<ChatMessageView message={assistant({ text: "partial answer" })} isStreaming />);
    expect(screen.queryByTestId("chat-thinking")).not.toBeInTheDocument();
    expect(screen.getByText("partial answer")).toBeInTheDocument();
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
  });
});

describe("ChatMessageView — cards, plan and credits", () => {
  it("renders the message's tool cards", () => {
    const cards: ToolCardState[] = [
      { toolCallId: "tc_1", name: "studio.list_layers", status: "done", result: { layers: 3 } },
    ];
    render(<ChatMessageView message={assistant({ toolCards: cards })} isStreaming={false} />);
    expect(screen.getByTestId("tool-card")).toHaveAttribute("data-tool", "studio.list_layers");
    expect(screen.getByText("List layers")).toBeInTheDocument();
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
});
