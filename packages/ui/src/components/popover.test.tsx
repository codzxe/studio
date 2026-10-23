import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

function renderPopover() {
  const onOpenChange = vi.fn();
  render(
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="secondary">Export settings</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Export settings">
        <p>Choose an export format below.</p>
      </PopoverContent>
    </Popover>,
  );
  return { onOpenChange };
}

describe("Popover (§7.6)", () => {
  it("opens on click and renders its content in the elevated surface", async () => {
    const user = userEvent.setup();
    renderPopover();
    expect(screen.queryByText("Choose an export format below.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export settings" }));
    const content = screen
      .getByText("Choose an export format below.")
      .closest("[data-radix-popper-content-wrapper]");
    const panel = screen.getByText("Choose an export format below.").parentElement;
    expect(panel?.className).toContain("bg-elevated");
    expect(panel?.className).toContain("rounded-md");
    expect(panel?.className).toContain("border-border");
    expect(panel?.className).toContain("p-2"); // §7.6: 8px padding
    expect(content ?? panel).not.toBeNull();
  });

  it("reports open state through data-state (§15)", async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole("button", { name: "Export settings" }));
    const panel = screen.getByText("Choose an export format below.").parentElement;
    expect(panel).toHaveAttribute("data-state", "open");
  });

  it("Escape closes and announces the change (§12: no keyboard traps)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();
    await user.click(screen.getByRole("button", { name: "Export settings" }));
    expect(screen.getByText("Choose an export format below.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Choose an export format below.")).not.toBeInTheDocument();
  });

  it("focus starts inside the opened popover so keyboard users are not stranded", async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(screen.getByRole("button", { name: "Export settings" }));
    const panel = screen.getByText("Choose an export format below.").parentElement;
    expect(panel).toContain(document.activeElement);
  });
});
