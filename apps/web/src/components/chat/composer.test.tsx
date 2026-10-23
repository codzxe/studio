/**
 * ChatComposer component tests (M4-G) — ECUX §3.4/§9/§12 semantics against the
 * pinned wave-2 contract (docs/phases/M4-SEAMS.md): Enter/Cmd-Ctrl+Enter send
 * with trim + focus retention, Shift+Enter newline, IME-safe Enter, Stop while
 * streaming (with §3.4 steer still enabled), credits/plan/editor disabled
 * states, quick-action chips (window events), deterministic 1–6 row auto-grow
 * and the 8'000-character CHAT_MESSAGE_SCHEMA guard.
 *
 * Pattern: editor-host.test.tsx (RTL + fireEvent; user-event only where the
 * textarea's default action — the Shift+Enter newline insertion — must run).
 * Deterministic, no network, no fake timers; jsdom has no layout so auto-grow
 * is asserted via the `rows` attribute (the scrollHeight path is real-browser
 * only and no-ops in jsdom).
 */

import { ChatApiContext, type ChatContextApi } from "@/lib/chat/provider";
import { createInitialChatUiState } from "@/lib/chat/run-state";
import type { ChatUiState } from "@/lib/chat/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, autoGrowCapPx } from "./composer";
import type { ChatComposerProps } from "./composer";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ComposerHarness {
  readonly onSend: ReturnType<typeof vi.fn>;
  readonly onStop: ReturnType<typeof vi.fn>;
  readonly rerender: (snapshot: ChatUiState | null, overrides?: Partial<ChatComposerProps>) => void;
  readonly unmount: () => void;
}

/** Minimal fake chat api — the composer's M6-H block reads `snapshot` only. */
function fakeChatApi(snapshot: ChatUiState): ChatContextApi {
  return { snapshot } as unknown as ChatContextApi;
}

function renderComposer(overrides: Partial<ChatComposerProps> = {}): ComposerHarness {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const view = render(
    <ChatComposer streaming={false} onSend={onSend} onStop={onStop} {...overrides} />,
  );
  return {
    onSend,
    onStop,
    rerender: (_snapshot, nextOverrides = {}) => {
      view.rerender(
        <ChatComposer
          streaming={false}
          onSend={onSend}
          onStop={onStop}
          {...overrides}
          {...nextOverrides}
        />,
      );
    },
    unmount: view.unmount,
  };
}

/** Provider-wrapped mount — the M6-H evidence rides the ChatProvider context. */
function renderComposerInChat(
  snapshot: ChatUiState,
  overrides: Partial<ChatComposerProps> = {},
): ComposerHarness {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const view = render(
    <ChatApiContext.Provider value={fakeChatApi(snapshot)}>
      <ChatComposer streaming={false} onSend={onSend} onStop={onStop} {...overrides} />
    </ChatApiContext.Provider>,
  );
  return {
    onSend,
    onStop,
    rerender: (nextSnapshot, nextOverrides = {}) => {
      view.rerender(
        <ChatApiContext.Provider value={nextSnapshot === null ? null : fakeChatApi(nextSnapshot)}>
          <ChatComposer
            streaming={false}
            onSend={onSend}
            onStop={onStop}
            {...overrides}
            {...nextOverrides}
          />
        </ChatApiContext.Provider>,
      );
    },
    unmount: view.unmount,
  };
}

function box(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Message the agent" }) as HTMLTextAreaElement;
}

function sendButton(): HTMLElement {
  return screen.getByRole("button", { name: "Send" });
}

const CREDITS_LOCKED: NonNullable<ChatComposerProps["disabled"]> = {
  reason: "credits",
  message: "You're out of credits.",
};

// ---------------------------------------------------------------------------
// M6-H snapshot fixtures (the ChatProvider evidence the block region reads)
// ---------------------------------------------------------------------------

function baseSnapshot(overrides: Partial<ChatUiState>): ChatUiState {
  return { ...createInitialChatUiState(), ...overrides };
}

/** The typed 402 block (run-state's chat.error fold). */
function snapshotBlocked402(message = "This workspace is out of credits."): ChatUiState {
  return baseSnapshot({
    phase: "failed",
    blocked: { reason: "insufficient-credits", message },
    error: { code: "INSUFFICIENT_CREDITS", message, retryable: false },
  });
}

/** The legacy error-only path (no typed block — same wire code). */
function snapshotError402(): ChatUiState {
  return baseSnapshot({
    phase: "failed",
    error: {
      code: "INSUFFICIENT_CREDITS",
      message: "This workspace is out of credits.",
      retryable: false,
    },
  });
}

/** A drained wallet: the terminal credits event says balance 0 µc, no error. */
function snapshotZeroBalance(): ChatUiState {
  return baseSnapshot({
    phase: "done",
    activeRunId: "run_drained",
    lastSeq: 4,
    messages: [
      {
        id: "run_drained",
        role: "assistant",
        text: "Done.",
        runId: "run_drained",
        toolCards: [],
        credits: { reserved: 2, committed: 2, balance: 0 },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Basics (§3.4 anatomy, §10 button size, a11y)
// ---------------------------------------------------------------------------

describe("ChatComposer — basics", () => {
  it("renders the labelled textarea with the §3.4 placeholder and a compact disabled send button", () => {
    renderComposer();
    const textarea = box();
    expect(textarea).toHaveAttribute(
      "placeholder",
      "Ask for an edit, or describe what you want to build…",
    );
    expect(screen.getByTestId("chat-composer")).toBeInTheDocument();
    // No chips and no bottom-row hint unless the parent passes them.
    expect(screen.queryByTestId("chat-composer-quick-action")).not.toBeInTheDocument();
    expect(screen.queryByText("Smart · ~12 credits")).not.toBeInTheDocument();
    // §10 compact buttons (28–32px): iconSm = h-8 w-8 (32px).
    const send = sendButton();
    expect(send).toHaveClass("h-8", "w-8");
    expect(send).toBeDisabled();
  });

  it("renders the creditHint hint line only when provided", () => {
    const first = renderComposer({ creditHint: "Smart · ~12 credits" });
    expect(screen.getByText("Smart · ~12 credits")).toBeInTheDocument();
    first.unmount();

    renderComposer();
    expect(screen.queryByText("Smart · ~12 credits")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Send semantics (§3.4 / §9)
// ---------------------------------------------------------------------------

describe("ChatComposer — send semantics", () => {
  it("Enter sends the trimmed message, clears the draft and keeps focus", () => {
    const harness = renderComposer();
    const textarea = box();
    fireEvent.change(textarea, { target: { value: "  make the title pop  " } });
    expect(sendButton()).toBeEnabled();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(harness.onSend).toHaveBeenCalledWith("make the title pop");
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveFocus();

    // Second Enter on the cleared draft sends nothing.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter inserts a newline and never sends (the default action is left alone)", async () => {
    const harness = renderComposer();
    const textarea = box();
    textarea.focus();
    const user = userEvent.setup();
    await user.type(textarea, "line1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.keyboard("line2");

    expect(textarea).toHaveValue("line1\nline2");
    expect(harness.onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveAttribute("rows", "2");

    // Deterministic core of the pin: the handler must NOT preventDefault the
    // Shift+Enter keydown (that is what lets the browser insert the newline).
    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("Cmd+Enter and Ctrl+Enter send from the composer's own textarea (§9.1)", () => {
    const harness = renderComposer();
    const textarea = box();

    fireEvent.change(textarea, { target: { value: "from cmd" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(harness.onSend).toHaveBeenCalledWith("from cmd");

    fireEvent.change(textarea, { target: { value: "from ctrl" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(harness.onSend).toHaveBeenCalledTimes(2);
    expect(harness.onSend).toHaveBeenCalledWith("from ctrl");
  });

  it("Enter during IME composition does not send; Enter after composition does", () => {
    const harness = renderComposer();
    const textarea = box();
    fireEvent.change(textarea, { target: { value: "コンポジションの説明" } });

    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    expect(composingEnter.isComposing).toBe(true);
    textarea.dispatchEvent(composingEnter);

    expect(harness.onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("コンポジションの説明");
    // The composer leaves the Enter to the IME (no preventDefault).
    expect(composingEnter.defaultPrevented).toBe(false);

    // Composition finished → plain Enter sends normally.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(harness.onSend).toHaveBeenCalledWith("コンポジションの説明");
  });

  it("empty or whitespace-only drafts never send", () => {
    const harness = renderComposer();
    const textarea = box();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).not.toHaveBeenCalled();
    expect(sendButton()).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton()).toBeEnabled();
  });

  it("Escape does nothing inside the composer (dismissal order is M4-E/M4-J's)", () => {
    const harness = renderComposer();
    const textarea = box();
    fireEvent.change(textarea, { target: { value: "draft" } });
    textarea.focus();

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(textarea).toHaveValue("draft");
    expect(textarea).toHaveFocus();
    expect(harness.onSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Streaming (§3.4 right button becomes stop; steer stays enabled)
// ---------------------------------------------------------------------------

describe("ChatComposer — streaming", () => {
  it("the button becomes Stop (onStop on click, no onSend); Enter still steers (§3.4)", () => {
    const harness = renderComposer({ streaming: true });
    const textarea = box();
    // §3.4: the composer stays enabled while streaming for steer messages.
    expect(textarea).toBeEnabled();

    const stop = screen.getByRole("button", { name: "Stop streaming" });
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    fireEvent.click(stop);
    expect(harness.onStop).toHaveBeenCalledTimes(1);
    expect(harness.onSend).not.toHaveBeenCalled();

    // Steer: Enter during a live run appends to the queue (M4-J maps this).
    fireEvent.change(textarea, { target: { value: "actually use brand red" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(harness.onSend).toHaveBeenCalledWith("actually use brand red");
    expect(harness.onStop).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// M6-H — the zero-balance block (§8.8/§12; BUILD_PLAN §M6 task 4)
// ---------------------------------------------------------------------------

describe("ChatComposer — M6-H credits block", () => {
  it("the typed 402 block locks the composer with the LowCreditBanner + /w/billing CTA", () => {
    const harness = renderComposerInChat(snapshotBlocked402());
    const textarea = box();
    expect(textarea).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByTestId("chat-credits-block")).toHaveAttribute(
      "data-block-source",
      "http-402",
    );
    expect(screen.getByTestId("low-credit-banner")).toBeInTheDocument();
    expect(screen.getByTestId("low-credit-topup")).toHaveAttribute("href", "/w/billing");
    expect(screen.getByText("This workspace is out of credits.")).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "draft while broke" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    fireEvent.click(sendButton());
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("zero balance WITHOUT a 402: the terminal credits event alone blocks the send (§8.8)", () => {
    const harness = renderComposerInChat(snapshotZeroBalance());
    expect(box()).toBeDisabled();
    expect(screen.getByTestId("chat-credits-block")).toHaveAttribute(
      "data-block-source",
      "zero-balance",
    );
    expect(screen.getByText("You're out of credits.")).toBeInTheDocument();
    expect(screen.getByTestId("low-credit-topup")).toHaveAttribute("href", "/w/billing");

    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("the 402 on snapshot.error (pre-block legacy path) blocks the same way with the §7.3 message", () => {
    const harness = renderComposerInChat(snapshotError402());
    expect(box()).toBeDisabled();
    expect(screen.getByTestId("chat-credits-block")).toHaveAttribute(
      "data-block-source",
      "http-402",
    );
    expect(screen.getByText("This workspace is out of credits.")).toBeInTheDocument();
    expect(screen.getByTestId("low-credit-banner")).toBeInTheDocument();
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("the banner CTA re-arms the composer (re-check = the next send; server re-enforces)", () => {
    const harness = renderComposerInChat(snapshotBlocked402());
    expect(box()).toBeDisabled();

    fireEvent.click(screen.getByTestId("low-credit-topup"));

    // The banner is gone and sends re-arm — the next POST is the re-check.
    expect(screen.queryByTestId("chat-credits-block")).not.toBeInTheDocument();
    expect(box()).toBeEnabled();

    fireEvent.change(box(), { target: { value: "try again" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(harness.onSend).toHaveBeenCalledWith("try again");
  });

  it("fresh 402 evidence re-blocks after a re-arm (no permanent lock, no stale unblock)", () => {
    const harness = renderComposerInChat(snapshotBlocked402());
    fireEvent.click(screen.getByTestId("low-credit-topup"));
    expect(screen.queryByTestId("chat-credits-block")).not.toBeInTheDocument();

    // A NEW 402 (fresh evidence object) — the block re-arms honestly.
    harness.rerender(snapshotBlocked402());
    expect(screen.getByTestId("chat-credits-block")).toBeInTheDocument();
    expect(box()).toBeDisabled();
  });

  it("streaming + credits block: Stop outranks the lock (§8.3) and steer stays dead", () => {
    const harness = renderComposerInChat(snapshotZeroBalance(), { streaming: true });
    expect(screen.getByRole("button", { name: "Stop streaming" })).toBeInTheDocument();
    expect(screen.getByTestId("chat-credits-block")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop streaming" }));
    expect(harness.onStop).toHaveBeenCalledTimes(1);
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("a hostile blocked message renders as inert text (law #1: strings are data)", () => {
    const hostile = snapshotBlocked402("<img src=x onerror=alert(1)>");
    renderComposerInChat(hostile);
    expect(document.body.querySelector("img")).toBeNull();
    expect(screen.getByTestId("chat-credits-block")).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Disabled states (§12 + §3.4 credits → LowCreditBanner + Top-up CTA)
// ---------------------------------------------------------------------------

describe("ChatComposer — disabled states", () => {
  it("credits prop lock: textarea disabled, §12 message shown, banner + /w/billing CTA, no send", () => {
    const harness = renderComposer({ disabled: CREDITS_LOCKED });
    const textarea = box();
    expect(textarea).toBeDisabled();
    expect(screen.getByText("You're out of credits.")).toBeInTheDocument();
    expect(screen.getByTestId("low-credit-banner")).toBeInTheDocument();
    expect(screen.getByTestId("low-credit-topup")).toHaveAttribute("href", "/w/billing");
    // The retired M4 Upgrade placeholder is gone for good.
    expect(screen.queryByRole("button", { name: "Upgrade" })).not.toBeInTheDocument();

    // Keyboard paths are dead while locked.
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(harness.onSend).not.toHaveBeenCalled();
    expect(harness.onStop).not.toHaveBeenCalled();

    // The CTA click re-arms the prop lock too (the server re-checks).
    fireEvent.click(screen.getByTestId("low-credit-topup"));
    expect(screen.queryByTestId("chat-credits-block")).not.toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "rearmed" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(harness.onSend).toHaveBeenCalledWith("rearmed");
  });

  it("editor reason: the §12 message shows under the composer and nothing sends", () => {
    const harness = renderComposer({
      disabled: { reason: "editor", message: "Editor disconnected. Reconnect to continue." },
    });
    const textarea = box();
    expect(screen.getByText("Editor disconnected. Reconnect to continue.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade" })).not.toBeInTheDocument();

    const send = sendButton();
    expect(textarea).toBeDisabled();
    expect(send).toBeDisabled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.click(send);
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("plan reason behaves like the editor lock (message + disabled send, no Upgrade)", () => {
    const harness = renderComposer({
      disabled: { reason: "plan", message: "Your plan doesn't include this model." },
    });
    expect(screen.getByText("Your plan doesn't include this model.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade" })).not.toBeInTheDocument();
    expect(sendButton()).toBeDisabled();

    const textarea = box();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("while streaming, Stop outranks the credits lock (the user can always cancel, §8.3)", () => {
    const harness = renderComposer({ streaming: true, disabled: CREDITS_LOCKED });
    expect(screen.getByRole("button", { name: "Stop streaming" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade" })).not.toBeInTheDocument();
    // Locked → still no steering.
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(harness.onSend).not.toHaveBeenCalled();
    expect(harness.onStop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Quick actions (§4.4 — chips render above the textarea, coordinate via props)
// ---------------------------------------------------------------------------

describe("ChatComposer — quick actions", () => {
  it("renders the chips above the textarea only when provided; a click dispatches the prompt and focuses", () => {
    const bare = renderComposer();
    expect(screen.queryByTestId("chat-composer-quick-action")).not.toBeInTheDocument();
    bare.unmount();

    const prompts: string[] = [];
    const listener = (event: Event) => {
      prompts.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("studio:chat-quick-action", listener);
    const harness = renderComposer({
      quickActions: [
        { label: "Animate in", prompt: "Animate the selected layers in" },
        { label: "Explain this comp", prompt: "Explain what this comp does" },
      ],
    });
    try {
      const chips = screen.getAllByTestId("chat-composer-quick-action");
      expect(chips).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Animate in" })).toBeInTheDocument();

      // Chips sit ABOVE the textarea (textarea follows the chips in DOM order).
      const firstChip = screen.getByRole("button", { name: "Animate in" });
      const textarea = box();
      expect(
        firstChip.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);

      textarea.blur();
      expect(textarea).not.toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Explain this comp" }));
      expect(prompts).toEqual(["Explain what this comp does"]);
      expect(textarea).toHaveFocus();
      expect(harness.onSend).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("studio:chat-quick-action", listener);
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-grow (§3.4: 1–6 rows, then scroll) — deterministic `rows` math
// ---------------------------------------------------------------------------

describe("ChatComposer — auto-grow", () => {
  it("grows with newline count, caps at 6 rows, then resets after a send", () => {
    const harness = renderComposer();
    const textarea = box();
    expect(textarea).toHaveAttribute("rows", "1");

    fireEvent.change(textarea, { target: { value: "one\ntwo\nthree" } });
    expect(textarea).toHaveAttribute("rows", "3");

    fireEvent.change(textarea, { target: { value: "1\n2\n3\n4\n5\n6\n7\n8" } });
    expect(textarea).toHaveAttribute("rows", "6"); // capped (§3.4)
    expect(textarea).toHaveClass("overflow-y-auto"); // then it scrolls internally

    fireEvent.change(textarea, { target: { value: "a\nb" } });
    expect(textarea).toHaveAttribute("rows", "2");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveAttribute("rows", "1"); // cleared draft → one row
  });

  it("carries the §9 96–160px envelope tokens on the composer box (W2-09)", () => {
    renderComposer();
    // The min/max ride the design-system tokens (tokens.css:140-141) — jsdom
    // has no layout, so the CLASSES are the testable truth here (the computed
    // clamp path no-ops in jsdom; see the unit test below).
    const textarea = box();
    expect(textarea).toHaveClass("min-h-[var(--chat-composer-min-h)]");
    expect(textarea).toHaveClass("max-h-[var(--chat-composer-max-h)]");
  });

  it("autoGrowCapPx clamps the §3.4 rows cap inside the §9 envelope (unit; jsdom no-op documented)", () => {
    // Real-browser shape: 21px line-height, 16px vertical padding → the 6-row
    // cap would be 142px, inside the 160px envelope.
    expect(autoGrowCapPx(21, 16, 160)).toBe(142);
    // A roomier font (28px) would push the rows cap to 184px — clamped to the
    // --chat-composer-max-h token (160px).
    expect(autoGrowCapPx(28, 16, 160)).toBe(160);
    // Padding that is unavailable (NaN — no computed style) is treated as 0.
    expect(autoGrowCapPx(25, Number.NaN, 160)).toBe(150);
    // Envelope unresolved (NaN / non-positive — jsdom's computed max-height is
    // empty): the §3.4 rows cap stands alone (the token class still caps the
    // box via CSS; this is exactly the jsdom no-op path).
    expect(autoGrowCapPx(21, 16, Number.NaN)).toBe(142);
    expect(autoGrowCapPx(21, 16, 0)).toBe(142);
    // No line-height at all (jsdom: getComputedStyle().lineHeight === "") →
    // null: the mount effect must NOT write an inline max-height.
    expect(autoGrowCapPx(Number.NaN, 16, 160)).toBeNull();
    expect(autoGrowCapPx(0, 16, 160)).toBeNull();
  });

  it("jsdom no-op: no computed line-height → no inline max-height written (token classes carry the envelope)", () => {
    renderComposer();
    const textarea = box();
    // jsdom reports no computed line-height, so the mount effect returns the
    // null cap and leaves the inline style untouched — the §9 envelope rides
    // the min-h/max-h token classes asserted above.
    expect(textarea.style.maxHeight).toBe("");
    // The token classes are present regardless of the no-op.
    expect(textarea).toHaveClass("min-h-[var(--chat-composer-min-h)]");
    expect(textarea).toHaveClass("max-h-[var(--chat-composer-max-h)]");
  });
});

// ---------------------------------------------------------------------------
// Length guard (CHAT_MESSAGE_SCHEMA max 8000 — block, never slice)
// ---------------------------------------------------------------------------

describe("ChatComposer — length guard", () => {
  it("8000 characters send; 8001 disable send and show the Message too long hint", () => {
    const harness = renderComposer();
    const textarea = box();

    fireEvent.change(textarea, { target: { value: "a".repeat(8000) } });
    expect(sendButton()).toBeEnabled();
    expect(screen.queryByText(/Message too long/)).not.toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "a".repeat(8001) } });
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Message too long — 8,000 characters max.")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(harness.onSend).not.toHaveBeenCalled();

    // Trimming back under the bound re-enables the send.
    fireEvent.change(textarea, { target: { value: "a".repeat(8000) } });
    expect(sendButton()).toBeEnabled();
    expect(screen.queryByText(/Message too long/)).not.toBeInTheDocument();
  });
});
