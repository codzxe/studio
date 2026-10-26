/**
 * MessageActions + the inline edit box tests (ROUND 12 "Chat UI v3" —
 * per-message copy / retry / edit-and-resend), exercised through the real
 * ChatMessageView (the message layer composes the pair).
 */

import { ChatMessageView } from "@/components/chat/message";
import { MessageActions, MessageEditBox } from "@/components/chat/message-actions";
import type { ChatUiMessage } from "@/lib/chat/types";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const USER_MESSAGE: ChatUiMessage = {
  id: "msg_user_1",
  role: "user",
  text: "Make the headline red",
  toolCards: [],
};

function mountMessage(
  message: ChatUiMessage,
  callbacks?: {
    readonly onRetryFrom?: (id: string) => void;
    readonly onEditResend?: (id: string, text: string) => void;
  },
) {
  return render(
    <ChatMessageView
      message={message}
      isStreaming={false}
      onRetryFrom={callbacks?.onRetryFrom}
      onEditResend={callbacks?.onEditResend}
    />,
  );
}

describe("ChatMessageView — per-message actions", () => {
  it("renders the hover action row on USER messages", () => {
    mountMessage(USER_MESSAGE);
    expect(screen.getByTestId("chat-message-actions")).toBeInTheDocument();
    expect(screen.getByTestId("chat-message-copy")).toBeInTheDocument();
  });

  it("hides Retry/Edit on assistant messages (user-only affordances)", () => {
    mountMessage({
      id: "msg_a_1",
      role: "assistant",
      text: "Done.",
      runId: "run_1",
      toolCards: [],
    });
    expect(screen.queryByTestId("chat-message-actions")).not.toBeInTheDocument();
  });

  it("hides Retry + Edit when the host wires nothing (read-only mounts)", () => {
    mountMessage(USER_MESSAGE);
    expect(screen.queryByTestId("chat-message-retry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-message-edit")).not.toBeInTheDocument();
    // Copy always exists.
    expect(screen.getByTestId("chat-message-copy")).toBeInTheDocument();
  });

  it("Retry fires onRetryFrom(messageId)", () => {
    const onRetryFrom = vi.fn();
    mountMessage(USER_MESSAGE, { onRetryFrom });
    fireEvent.click(screen.getByTestId("chat-message-retry"));
    expect(onRetryFrom).toHaveBeenCalledWith("msg_user_1");
  });

  it("Edit swaps the bubble for the inline box; Save fires onEditResend with the new text", async () => {
    const user = userEvent.setup();
    const onEditResend = vi.fn();
    mountMessage(USER_MESSAGE, { onEditResend });
    await user.click(screen.getByTestId("chat-message-edit"));
    const box = screen.getByTestId("chat-message-edit-box");
    const textarea = withinType(box, "textarea");
    await user.clear(textarea);
    await user.type(textarea, "Make the headline blue");
    await user.click(screen.getByTestId("chat-message-edit-save"));
    expect(onEditResend).toHaveBeenCalledWith("msg_user_1", "Make the headline blue");
  });

  it("Edit cancels without firing onEditResend (Escape + Cancel button)", async () => {
    const user = userEvent.setup();
    const onEditResend = vi.fn();
    mountMessage(USER_MESSAGE, { onEditResend });
    await user.click(screen.getByTestId("chat-message-edit"));
    await user.click(screen.getByTestId("chat-message-edit-cancel"));
    expect(screen.queryByTestId("chat-message-edit-box")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("chat-message-edit"));
    fireEvent.keyDown(withinType(screen.getByTestId("chat-message-edit-box"), "textarea"), {
      key: "Escape",
    });
    expect(screen.queryByTestId("chat-message-edit-box")).not.toBeInTheDocument();
    expect(onEditResend).not.toHaveBeenCalled();
  });
});

describe("MessageActions — copy", () => {
  it("copies through navigator.clipboard and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom's `clipboard` is an inherited getter-only Navigator property —
    // define an own configurable stub instead of Object.assign (which throws).
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<MessageActions text="copy me" />);
    // fireEvent, not userEvent: user-event's setup() installs its OWN
    // navigator.clipboard stub (writeToClipboard: false doesn't opt out in
    // v14.6), which would shadow this spy — the copy button's own test must
    // observe OUR clipboard (the file's fireEvent precedent: the Retry test).
    fireEvent.click(screen.getByTestId("chat-message-copy"));
    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(await screen.findByTestId("chat-message-copy")).toHaveAttribute("data-copied", "true");
  });
});

describe("MessageEditBox", () => {
  it("Enter saves, Shift+Enter stays a newline, empty text never saves", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<MessageEditBox initialText="hello" onSave={onSave} onCancel={vi.fn()} />);
    const textarea = screen.getByLabelText("Edit message");
    await user.type(textarea, " there");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("hello there");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSave).toHaveBeenCalledTimes(1); // newline, not a save
    await user.clear(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1); // empty never saves
  });
});

/** Query a descendant element type inside a container (textarea helper). */
function withinType(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (found === null) throw new Error(`No ${selector} inside the edit box`);
  return found as HTMLElement;
}
