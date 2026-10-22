/**
 * ChatConfirmDialog tests (M5-G) — the high-risk confirm modal: accessible
 * role/name/aria-modal, the Radix focus trap (focus starts inside and never
 * leaves), Escape = cancel, the action pair wiring (Cancel → onOpenChange,
 * Confirm → onConfirm only) and the tokens-only style law. Deterministic; jsdom.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatConfirmDialog } from "./confirm-dialog";

/** Any hex-looking literal in a class or style attribute (raw-hex law, #8). */
const HEX = /#[0-9a-f]{3,8}/i;

function setup(overrides: Partial<Parameters<typeof ChatConfirmDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ChatConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Apply this high-risk plan?"
      description="This plan is marked high risk. Apply only if you mean it."
      confirmLabel="Apply"
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onOpenChange, onConfirm };
}

describe("ChatConfirmDialog", () => {
  it("renders an accessible modal: role=dialog, accessible name, aria-modal", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Apply this high-risk plan?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("chat-confirm-description")).toHaveTextContent(
      "This plan is marked high risk. Apply only if you mean it.",
    );
  });

  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-confirm-dialog")).not.toBeInTheDocument();
  });

  it("traps focus: focus starts inside and Tab never leaves the dialog", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = screen.getByTestId("chat-confirm-dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("Escape = cancel: onOpenChange(false), never onConfirm", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onConfirm } = setup();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("the Cancel button cancels; the labelled ✕ does too", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onConfirm } = setup({ cancelLabel: "Not now" });
    const cancel = screen.getByTestId("chat-confirm-cancel");
    expect(cancel).toHaveTextContent("Not now");
    await user.click(cancel);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Confirm fires onConfirm ONLY — closing stays the parent's job", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onConfirm } = setup();
    await user.click(screen.getByTestId("chat-confirm-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("the destructive confirm renders on --danger", () => {
    setup({ danger: true });
    expect(screen.getByTestId("chat-confirm-confirm").className).toContain("bg-danger");
  });

  it("busy keeps the confirm non-interactive (spinner + data-loading)", () => {
    const handler = vi.fn();
    render(
      <ChatConfirmDialog
        open
        onOpenChange={handler}
        title="Working"
        confirmLabel="Apply"
        onConfirm={handler}
        busy
      />,
    );
    const confirm = screen.getByTestId("chat-confirm-confirm");
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("data-loading", "true");
    expect(within(confirm).getByTestId("button-loading")).toBeInTheDocument();
  });

  it("danger=false renders the primary (signal) confirm", () => {
    setup({ danger: false });
    expect(screen.getByTestId("chat-confirm-confirm").className).toContain("bg-signal");
  });

  it("is tokens-only: no hex color in any class or inline style across the portal", () => {
    setup({ danger: true, description: undefined });
    for (const element of document.querySelectorAll("*")) {
      const className = element.getAttribute("class");
      if (className !== null) {
        expect(className).not.toMatch(HEX);
      }
      const style = element.getAttribute("style");
      if (style !== null) {
        expect(style).not.toMatch(HEX);
      }
    }
    // The dialog portaled to body — the sweep above saw it.
    expect(
      within(screen.getByTestId("chat-confirm-dialog")).getByTestId("chat-confirm-title"),
    ).toHaveTextContent("Apply this high-risk plan?");
  });
});
