/**
 * InlineEditBar tests (M5-I; EDITOR_CHAT_UX §4.2, DECISIONS.md D-5).
 *
 * The compact Cmd/Ctrl+K bar: single input, Enter submits through the
 * `InlineEditSubmit` seam (tagged `inlineEdit: true`), Escape closes without
 * reaching the panel's own Esc dismissal (§9 layering), focus is managed on
 * open/re-trigger and trapped inside the bar (a11y), and the credits/plan lock
 * disables submission with the §12 message.
 */

import { InlineEditBar } from "@/components/editor-host/inline-edit";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const PROPS = {
  open: true,
  scopeLabel: null as string | null,
  lockMessage: null as string | null,
  focusSeq: 0,
  onSubmit: vi.fn(),
  onClose: vi.fn(),
} as const;

function mountBar(overrides: Partial<typeof PROPS> = {}) {
  const props = { ...PROPS, ...overrides };
  return render(<InlineEditBar {...props} />);
}

const input = (): HTMLInputElement =>
  screen.getByLabelText("Inline edit request") as HTMLInputElement;

describe("InlineEditBar — open/close + focus management", () => {
  it("renders nothing while closed", () => {
    mountBar({ open: false });
    expect(screen.queryByTestId("chat-inline-edit")).not.toBeInTheDocument();
  });

  it("renders a labelled dialog and focuses the input on open", () => {
    mountBar();
    const dialog = screen.getByTestId("chat-inline-edit");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-label", "Inline edit");
    expect(screen.getByTestId("chat-inline-edit-scope")).toHaveTextContent(
      "Editing: the active composition",
    );
    expect(input()).toHaveFocus();
  });

  it("shows the §4.2 scope (selection names, else the active comp)", () => {
    mountBar({ scopeLabel: "Headline, Subhead" });
    expect(screen.getByTestId("chat-inline-edit-scope")).toHaveTextContent(
      "Editing: Headline, Subhead",
    );
  });

  it("re-focuses on a repeated Cmd/Ctrl+K (focusSeq) without clearing the draft", () => {
    const view = mountBar();
    fireEvent.change(input(), { target: { value: "make this warmer" } });
    // Focus wanders (e.g. the user clicked the editor)…
    (screen.getByTestId("chat-inline-edit-send") as HTMLElement).blur();
    expect(input()).not.toHaveFocus();
    // A repeated shortcut only re-focuses; the draft survives.
    view.rerender(
      <InlineEditBar
        open={true}
        scopeLabel={null}
        lockMessage={null}
        focusSeq={1}
        onSubmit={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(input()).toHaveFocus();
    expect(input()).toHaveValue("make this warmer");
  });
});

describe("InlineEditBar — submit seam", () => {
  it("Enter submits the trimmed request tagged inlineEdit: true", () => {
    const onSubmit = vi.fn();
    mountBar({ onSubmit });
    fireEvent.change(input(), { target: { value: "  make this text 20% larger  " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      message: "make this text 20% larger",
      inlineEdit: true,
    });
  });

  it("never submits an empty request", () => {
    const onSubmit = vi.fn();
    mountBar({ onSubmit });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves Enter to the IME mid-composition (§3.4 safety)", () => {
    const onSubmit = vi.fn();
    mountBar({ onSubmit });
    fireEvent.change(input(), { target: { value: "コンポジション" } });
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    input().dispatchEvent(composingEnter);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(composingEnter.defaultPrevented).toBe(false);
  });

  it("the Send button submits too (pointer parity with Enter)", () => {
    const onSubmit = vi.fn();
    mountBar({ onSubmit });
    fireEvent.change(input(), { target: { value: "make it pop" } });
    fireEvent.click(screen.getByTestId("chat-inline-edit-send"));
    expect(onSubmit).toHaveBeenCalledWith({ message: "make it pop", inlineEdit: true });
  });

  it("locks submission behind the §12 message (credits/plan)", () => {
    const onSubmit = vi.fn();
    mountBar({ onSubmit, lockMessage: "You're out of credits." });
    expect(input()).toBeDisabled();
    expect(screen.getByTestId("chat-inline-edit-locked")).toHaveTextContent(
      "You're out of credits.",
    );
    expect(screen.getByTestId("chat-inline-edit-send")).toBeDisabled();
    fireEvent.keyDown(input(), { key: "Enter" }); // disabled inputs emit no keydown, so assert the seam:
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("InlineEditBar — keyboard a11y (§9)", () => {
  it("Escape closes and stops there (the panel must not ALSO collapse)", () => {
    const onClose = vi.fn();
    const parentSpy = vi.fn();
    render(
      <div onKeyDown={parentSpy} data-testid="inline-parent">
        <InlineEditBar
          open={true}
          scopeLabel={null}
          lockMessage={null}
          focusSeq={0}
          onSubmit={() => undefined}
          onClose={onClose}
        />
      </div>,
    );
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(escape);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    expect(parentSpy).not.toHaveBeenCalled(); // stopPropagation held at the bar
  });

  it("traps Tab inside the bar: input → send → input, Shift+Tab wraps back", () => {
    mountBar();
    const el = input();
    const send = screen.getByTestId("chat-inline-edit-send") as HTMLElement;

    fireEvent.keyDown(el, { key: "Tab" });
    expect(send).toHaveFocus();
    fireEvent.keyDown(send, { key: "Tab" });
    expect(el).toHaveFocus();
    fireEvent.keyDown(el, { key: "Shift+Tab" });
    expect(send).toHaveFocus();
  });
});
