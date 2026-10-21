import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type CommandItem, CommandPalette } from "./command-palette";

const items: CommandItem[] = [
  { id: "p1", group: "projects", label: "Launch film", onSelect: vi.fn() },
  { id: "a1", group: "actions", label: "New project", shortcut: "⌘N", onSelect: vi.fn() },
  { id: "n1", group: "navigation", label: "Billing", onSelect: vi.fn() },
  { id: "h1", group: "help", label: "Keyboard shortcuts", onSelect: vi.fn() },
];

function renderPalette(open = true, providedItems: CommandItem[] = items) {
  const onOpenChange = vi.fn();
  render(<CommandPalette open={open} onOpenChange={onOpenChange} items={providedItems} />);
  return { onOpenChange };
}

describe("CommandPalette (§7.10)", () => {
  it("renders grouped results in the fixed group order", () => {
    renderPalette();
    for (const label of ["Projects", "Actions", "Navigation", "Help"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("Launch film")).toBeInTheDocument();
  });

  it("filters results as you type and shows an empty message", async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = screen.getByTestId("command-input");
    await user.type(input, "billing");
    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(screen.queryByText("Launch film")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "zzz");
    expect(screen.getByText("No results.")).toBeInTheDocument();
  });

  it("Enter runs the active item and closes (§7.10)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPalette();
    await user.type(screen.getByTestId("command-input"), "new{Enter}");
    expect(items[1]?.onSelect).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("arrows move the active option; Home/End jump (keyboard-first, §7.10)", async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = screen.getByTestId("command-input");
    await user.click(input);
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining(items[0]?.id ?? ""),
    );

    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining(items[1]?.id ?? ""),
    );

    await user.keyboard("{End}");
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      expect.stringContaining(items[3]?.id ?? ""),
    );
  });

  it("Escape closes (§7.10)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPalette();
    await user.click(screen.getByTestId("command-input"));
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hidden when closed", () => {
    renderPalette(false);
    expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();
  });
});
