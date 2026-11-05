/**
 * ChatThread tests (M4-F) — message rendering, caret-per-phase, system banners
 * (reconnecting / RUN_PAUSED / retryable mapping), credits, the empty state
 * quick-action CustomEvent contract, >50-message windowing and scroll
 * anchoring. Deterministic; no network; jsdom.
 */

import type { ChatUiMessage, RunPhase } from "@/lib/chat/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_QUICK_ACTION_EVENT, ChatThread, type ChatThreadProps } from "./thread";

const onRetry = vi.fn();
const QUICK_ACTIONS = [
  { label: "Explain this comp", prompt: "Explain what's on this comp" },
  { label: "Render a preview", prompt: "Render a preview of this comp" },
];

function baseProps(overrides: Partial<ChatThreadProps> = {}): ChatThreadProps {
  return {
    messages: [],
    phase: "idle",
    activeRunId: null,
    onRetry,
    emptyQuickActions: QUICK_ACTIONS,
    ...overrides,
  };
}

const user = (id: string, text: string): ChatUiMessage => ({
  id,
  role: "user",
  text,
  toolCards: [],
});

const assistant = (
  id: string,
  runId: string,
  text = "",
  overrides: Partial<ChatUiMessage> = {},
): ChatUiMessage => ({ id, role: "assistant", text, runId, toolCards: [], ...overrides });

afterEach(() => {
  onRetry.mockClear();
});

describe("ChatThread — messages", () => {
  it("renders user and assistant messages with labels and NO avatars", () => {
    render(
      <ChatThread
        {...baseProps({
          messages: [user("u1", "Make the headline pop"), assistant("a1", "run-1", "Done")],
        })}
      />,
    );
    const messages = screen.getAllByTestId("chat-message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveAttribute("data-role", "user");
    expect(messages[1]).toHaveAttribute("data-role", "assistant");
    expect(screen.getByText("Make the headline pop")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    const labels = screen.getAllByTestId("chat-message-label");
    expect(labels[0]).toHaveTextContent("You");
    expect(labels[1]).toHaveTextContent("✦ Agent");

    // No avatars, and text is capped at the 72ch measure (§3.3).
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-thread").innerHTML).toContain("max-w-[72ch]");
  });

  it("renders the credits line on messages that carry a snapshot", () => {
    render(
      <ChatThread
        {...baseProps({
          messages: [
            assistant("a1", "run-1", "Done", {
              credits: { reserved: 12, committed: 7, balance: 42 },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId("chat-credits")).toHaveTextContent("7 credits used · balance 42");
  });

  it("is an aria-live=polite log region", () => {
    render(<ChatThread {...baseProps({ messages: [user("u1", "hi")] })} />);
    const region = screen.getByTestId("chat-thread-scroll");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("role", "log");
  });
});

describe("ChatThread — streaming caret (per phase)", () => {
  const messages = [assistant("a1", "run-1", "Working on it")];

  it("shows the caret while streaming/reconnecting on the active run only", () => {
    const { rerender } = render(
      <ChatThread {...baseProps({ messages, phase: "streaming", activeRunId: "run-1" })} />,
    );
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();

    rerender(
      <ChatThread {...baseProps({ messages, phase: "reconnecting", activeRunId: "run-1" })} />,
    );
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();

    // A different active run: the older assistant message never shows a caret.
    rerender(
      <ChatThread {...baseProps({ messages, phase: "streaming", activeRunId: "run-other" })} />,
    );
    expect(screen.queryByTestId("chat-caret")).not.toBeInTheDocument();

    // Terminal/idle phases never show the caret.
    for (const phase of ["idle", "sending", "done", "cancelled"] as RunPhase[]) {
      rerender(<ChatThread {...baseProps({ messages, phase, activeRunId: "run-1" })} />);
      expect(screen.queryByTestId("chat-caret")).not.toBeInTheDocument();
    }
  });

  it("shows the Thinking… skeleton while the active run has produced no text", () => {
    render(
      <ChatThread
        {...baseProps({
          messages: [assistant("a1", "run-1")],
          phase: "streaming",
          activeRunId: "run-1",
        })}
      />,
    );
    // ROUND 13: the static string became the LIVE thinking indicator.
    expect(screen.getByTestId("chat-thinking")).toHaveTextContent("Thinking");
    expect(screen.getByTestId("chat-thinking-dot")).toBeInTheDocument();
    expect(screen.getByTestId("chat-caret")).toBeInTheDocument();
  });
});

describe("ChatThread — system banners", () => {
  const messages = [assistant("a1", "run-1", "partial")];

  it("shows the inline Reconnecting… info banner in phase reconnecting only", () => {
    const { rerender } = render(
      <ChatThread {...baseProps({ messages, phase: "reconnecting", activeRunId: "run-1" })} />,
    );
    const banner = screen.getByTestId("chat-banner");
    expect(banner).toHaveAttribute("data-kind", "info");
    expect(banner).toHaveTextContent("Reconnecting…");

    for (const phase of ["idle", "streaming", "done"] as RunPhase[]) {
      rerender(<ChatThread {...baseProps({ messages, phase, activeRunId: "run-1" })} />);
      expect(screen.queryByTestId("chat-banner")).not.toBeInTheDocument();
    }
  });

  it("maps a RUN_PAUSED error to the RunPausedBanner with Retry", () => {
    render(
      <ChatThread
        {...baseProps({
          messages,
          phase: "failed",
          activeRunId: "run-1",
          error: {
            code: "RUN_PAUSED",
            message: "Run paused. Check your connection.",
            retryable: true,
          },
        })}
      />,
    );
    expect(screen.getByTestId("chat-banner-run-paused")).toHaveTextContent(
      "Run paused. Check your connection.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("maps retryable errors to an error banner with a Retry action", () => {
    render(
      <ChatThread
        {...baseProps({
          messages,
          phase: "failed",
          activeRunId: "run-1",
          error: {
            code: "RUN_MODEL_UNAVAILABLE",
            message: "The model is unavailable.",
            retryable: true,
          },
        })}
      />,
    );
    const banner = screen.getByTestId("chat-banner");
    expect(banner).toHaveAttribute("data-kind", "error");
    expect(banner).toHaveTextContent("The model is unavailable.");
    fireEvent.click(screen.getByTestId("chat-banner-action"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("maps non-retryable errors to an error banner WITHOUT a retry action", () => {
    render(
      <ChatThread
        {...baseProps({
          messages,
          phase: "failed",
          activeRunId: "run-1",
          error: {
            code: "RUN_STEP_LIMIT",
            message: "This run hit its step limit.",
            retryable: false,
          },
        })}
      />,
    );
    expect(screen.getByTestId("chat-banner")).toHaveTextContent("This run hit its step limit.");
    expect(screen.queryByTestId("chat-banner-action")).not.toBeInTheDocument();
  });
});

describe("ChatThread — empty state quick actions", () => {
  it("greets with 'What should we build?' and dispatches chip prompts as the pinned CustomEvent", () => {
    const heard: string[] = [];
    const listener = (event: Event) => {
      heard.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener(CHAT_QUICK_ACTION_EVENT, listener);

    render(<ChatThread {...baseProps({ messages: [] })} />);
    expect(screen.getByTestId("chat-empty-state")).toHaveTextContent("What should we build?");

    const chips = screen.getAllByTestId("chat-quick-action");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-prompt", "Explain what's on this comp");

    fireEvent.click(chips[0] as HTMLElement);
    expect(heard).toEqual(["Explain what's on this comp"]);
    expect(CHAT_QUICK_ACTION_EVENT).toBe("studio:chat-quick-action");

    window.removeEventListener(CHAT_QUICK_ACTION_EVENT, listener);
  });

  it("does not render quick actions once the thread has messages", () => {
    render(<ChatThread {...baseProps({ messages: [user("u1", "hi")] })} />);
    expect(screen.queryByTestId("chat-quick-action")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-empty-state")).not.toBeInTheDocument();
  });
});

describe("ChatThread — virtualization (>50 messages)", () => {
  it("renders only the last 40 messages plus the top spacer when the thread exceeds 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => user(`m${i}`, `message number ${i}`));
    render(<ChatThread {...baseProps({ messages: many })} />);

    expect(screen.queryByText("message number 0")).not.toBeInTheDocument();
    expect(screen.queryByText("message number 19")).not.toBeInTheDocument();
    expect(screen.getByText("message number 20")).toBeInTheDocument();
    expect(screen.getByText("message number 59")).toBeInTheDocument();

    const spacer = screen.getByTestId("chat-window-spacer");
    expect(spacer).toHaveAttribute("data-hidden-count", "20");
    expect(screen.getAllByTestId("chat-message")).toHaveLength(40);
  });

  it("renders everything at exactly 50 messages (no windowing, no spacer)", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => user(`m${i}`, `fifty number ${i}`));
    render(<ChatThread {...baseProps({ messages: fifty })} />);
    expect(screen.getByText("fifty number 0")).toBeInTheDocument();
    expect(screen.getByText("fifty number 49")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-window-spacer")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("chat-message")).toHaveLength(50);
  });
});

describe("ChatThread — scroll anchoring (§3.3: only while already at the bottom)", () => {
  it("appends without jumping when the user has scrolled up, and anchors when at the bottom", () => {
    const { rerender } = render(
      <ChatThread
        {...baseProps({
          messages: [user("u1", "one"), assistant("a1", "run-1")],
          phase: "streaming",
          activeRunId: "run-1",
        })}
      />,
    );
    const scroller = screen.getByTestId("chat-thread-scroll");
    // jsdom has no layout: pin deterministic metrics on the scroll container.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });

    // The user scrolled UP (100 < 600 above the bottom threshold).
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    rerender(
      <ChatThread
        {...baseProps({
          messages: [user("u1", "one"), assistant("a1", "run-1"), user("u3", "three")],
          phase: "streaming",
          activeRunId: "run-1",
        })}
      />,
    );
    expect(scroller.scrollTop).toBe(100); // append did NOT jump

    // Back at the bottom (600 = scrollHeight - clientHeight): appends anchor.
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    rerender(
      <ChatThread
        {...baseProps({
          messages: [
            user("u1", "one"),
            assistant("a1", "run-1"),
            user("u3", "three"),
            user("u4", "four"),
          ],
          phase: "streaming",
          activeRunId: "run-1",
        })}
      />,
    );
    expect(scroller.scrollTop).toBe(1000); // anchored to the bottom

    // A streamed text delta (same message count) re-anchors while at the bottom.
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    rerender(
      <ChatThread
        {...baseProps({
          messages: [
            user("u1", "one"),
            assistant("a1", "run-1", "longer answer"),
            user("u3", "three"),
            user("u4", "four"),
          ],
          phase: "streaming",
          activeRunId: "run-1",
        })}
      />,
    );
    expect(scroller.scrollTop).toBe(1000);
  });
});

describe("ChatThread — scroll-to-bottom pill (chat-first opt-in)", () => {
  function pinMetrics(scroller: HTMLElement): void {
    // jsdom has no layout: pin deterministic metrics on the scroll container.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
  }

  it("is hidden by default (the editor panel keeps its exact M4 behavior)", () => {
    render(
      <ChatThread {...baseProps({ messages: [user("u1", "one"), assistant("a1", "run-1")] })} />,
    );
    const scroller = screen.getByTestId("chat-thread-scroll");
    pinMetrics(scroller);
    scroller.scrollTop = 100; // scrolled up…
    fireEvent.scroll(scroller); // …but the pill is opt-in
    expect(screen.queryByTestId("chat-scroll-to-bottom")).not.toBeInTheDocument();
  });

  it("appears when scrolled up and scrolls back down on click", () => {
    render(
      <ChatThread
        {...baseProps({
          messages: [user("u1", "one"), assistant("a1", "run-1")],
          scrollButton: true,
        })}
      />,
    );
    const scroller = screen.getByTestId("chat-thread-scroll");
    pinMetrics(scroller);

    // At the bottom: no pill.
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId("chat-scroll-to-bottom")).not.toBeInTheDocument();

    // Scrolled up: the pill appears.
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    const pill = screen.getByTestId("chat-scroll-to-bottom");
    expect(pill).toHaveAttribute("aria-label", "Scroll to bottom");

    // Click scrolls to the bottom and hides the pill.
    const scrollTo = vi.fn();
    (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    fireEvent.click(pill);
    expect(scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: "smooth",
    });
    expect(screen.queryByTestId("chat-scroll-to-bottom")).not.toBeInTheDocument();
  });
});
