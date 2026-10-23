/**
 * BulkActionsBar tests (W2-04, §8.5) — the presentational bulk strip:
 * zero-selection renders nothing, the count line, Archive vs Restore by
 * window, the viewer (canEdit false) read-only arm, busy disabling, and the
 * action callbacks. The view's own tests pin the port wiring.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BulkActionsBar } from "./bulk-actions-bar";

type Handlers = {
  onArchiveOrRestore: ReturnType<typeof vi.fn>;
  onDuplicate: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
  onClear: ReturnType<typeof vi.fn>;
};

function handlers(): Handlers {
  return {
    onArchiveOrRestore: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
  };
}

function bar(
  props: Partial<Parameters<typeof BulkActionsBar>[0]> & { selectedCount?: number },
  calls?: Handlers,
) {
  const h = calls ?? handlers();
  render(
    <BulkActionsBar
      selectedCount={props.selectedCount ?? 2}
      archivedWindow={props.archivedWindow ?? false}
      canEdit={props.canEdit ?? true}
      busy={props.busy ?? false}
      onArchiveOrRestore={h.onArchiveOrRestore}
      onDuplicate={h.onDuplicate}
      onDelete={h.onDelete}
      onClear={h.onClear}
    />,
  );
  return h;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BulkActionsBar (§8.5)", () => {
  it("renders nothing when nothing is selected", () => {
    bar({ selectedCount: 0 });
    expect(screen.queryByTestId("projects-bulk-bar")).not.toBeInTheDocument();
  });

  it("shows the selection count with Archive/Duplicate/Delete/Clear (active window)", async () => {
    const user = userEvent.setup();
    const h = bar({ selectedCount: 3 });
    expect(screen.getByTestId("projects-bulk-count")).toHaveTextContent("3 projects selected");
    expect(screen.getByTestId("projects-bulk-archive")).toHaveTextContent("Archive");
    expect(screen.getByTestId("projects-bulk-duplicate")).toHaveTextContent("Duplicate");
    expect(screen.getByTestId("projects-bulk-delete")).toHaveTextContent("Delete");

    await user.click(screen.getByTestId("projects-bulk-archive"));
    expect(h.onArchiveOrRestore).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("projects-bulk-duplicate"));
    expect(h.onDuplicate).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("projects-bulk-delete"));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(h.onClear).toHaveBeenCalledTimes(1);
  });

  it("labels the single-project count and the Archived-window action Restore", () => {
    bar({ selectedCount: 1, archivedWindow: true });
    expect(screen.getByTestId("projects-bulk-count")).toHaveTextContent("1 project selected");
    const restore = screen.getByTestId("projects-bulk-archive");
    expect(restore).toHaveTextContent("Restore");
    expect(screen.getByTestId("projects-bulk-bar")).toHaveAttribute("data-archived-window", "true");
  });

  it("viewers get no mutation actions (the gateway re-checks regardless)", () => {
    bar({ selectedCount: 2, canEdit: false });
    expect(screen.getByTestId("projects-bulk-count")).toHaveTextContent("2 projects selected");
    expect(screen.queryByTestId("projects-bulk-archive")).not.toBeInTheDocument();
    expect(screen.queryByTestId("projects-bulk-duplicate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("projects-bulk-delete")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeInTheDocument();
  });

  it("disables every action while a bulk mutation is busy", () => {
    bar({ selectedCount: 2, busy: true });
    expect(screen.getByTestId("projects-bulk-archive")).toBeDisabled();
    expect(screen.getByTestId("projects-bulk-duplicate")).toBeDisabled();
    expect(screen.getByTestId("projects-bulk-delete")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled();
  });
});
