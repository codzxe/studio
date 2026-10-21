import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Dialog, DialogContent, DialogTitle } from "./dialog";

describe("Dialog", () => {
  it("renders title and closes on Escape (Radix focus trap + restore, §7.5)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Share project</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Share project" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("exposes a labelled close control", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Share project</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("ConfirmDialog (destructive, §7.5)", () => {
  function setup(confirmText?: string) {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete project"
        description="This deletes 3 compositions. There is no undo."
        confirmLabel="Delete project"
        confirmText={confirmText}
        onConfirm={onConfirm}
      />,
    );
    return { onConfirm };
  }

  it("without confirmText the action is enabled immediately", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    const confirm = screen.getByTestId("confirm-confirm");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("requires typing the action name before confirming (§7.5)", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup("Delete project");
    const confirm = screen.getByTestId("confirm-confirm");
    const input = screen.getByTestId("confirm-input");
    expect(screen.getByLabelText('Type "Delete project" to confirm')).toBeInTheDocument();

    // Wrong text keeps the destructive action disabled.
    await user.type(input, "delete");
    expect(confirm).toBeDisabled();

    // Exact (case-insensitive) match enables it.
    await user.type(input, " project");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
