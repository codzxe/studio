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

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./composer";
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
  readonly unmount: () => void;
}

function renderComposer(overrides: Partial<ChatComposerProps> = {}): ComposerHarness {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const view = render(
    <ChatComposer streaming={false} onSend={onSend} onStop={onStop} {...overrides} />,
  );
  return { onSend, onStop, unmount: view.unmount };
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
// Disabled states (§12 + §3.4 credits → Upgrade)
// ---------------------------------------------------------------------------

describe("ChatComposer — disabled states", () => {
  it("credits: textarea disabled, §12 message shown, Upgrade CTA dispatches studio:chat-upgrade, no send", () => {
    const harness = renderComposer({ disabled: CREDITS_LOCKED });
    const textarea = box();
    expect(textarea).toBeDisabled();
    expect(screen.getByText("You're out of credits.")).toBeInTheDocument();

    const upgrade = screen.getByRole("button", { name: "Upgrade" });
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    const heard: CustomEvent[] = [];
    const listener = (event: Event) => {
      heard.push(event as CustomEvent);
    };
    window.addEventListener("studio:chat-upgrade", listener);
    fireEvent.click(upgrade);
    window.removeEventListener("studio:chat-upgrade", listener);

    expect(heard).toHaveLength(1);
    expect(heard[0]?.type).toBe("studio:chat-upgrade");

    // Keyboard paths are dead while locked.
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(harness.onSend).not.toHaveBeenCalled();
    expect(harness.onStop).not.toHaveBeenCalled();
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
