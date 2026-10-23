import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Ellipsis } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import {
  TOOLTIP_DELAY_MS,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

function renderTooltip(label = "More actions") {
  return render(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="iconSm" variant="ghost" aria-label={label}>
            <Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>More project actions</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe("Tooltip (§7.6)", () => {
  it("shows on hover and exposes role=tooltip", async () => {
    const user = userEvent.setup();
    renderTooltip();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("More project actions");
  });

  it("is never the only source of an accessible name (§7.6/§12)", async () => {
    const user = userEvent.setup();
    renderTooltip();
    // Accessible name resolves BEFORE the tooltip opens (aria-label on trigger).
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
  });

  it("closes on Escape — keyboard users are never stuck with it open (§12)", async () => {
    const user = userEvent.setup();
    renderTooltip();
    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // jsdom cannot replay Radix's pointerleave close path; Escape is the
    // deterministic keyboard close (the pointer journey is covered by e2e).
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("uses the ink-4-style elevated surface at caption size (§7.6: 12px, quiet)", async () => {
    const user = userEvent.setup();
    renderTooltip();
    await user.hover(screen.getByRole("button", { name: "More actions" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.className).toContain("text-caption");
    expect(tooltip.className).toContain("rounded-xs");
    expect(tooltip.className).toContain("bg-input");
  });

  it("ships the 250ms app default delay (§7.6)", () => {
    expect(TOOLTIP_DELAY_MS).toBe(250);
  });
});
