import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ProjectCard,
} from "./card";

describe("Card (§7.3)", () => {
  it("renders a panel surface: bg-panel, 1px border, radius-md, 24px padding", () => {
    render(
      <Card>
        <p>Quiet chrome</p>
      </Card>,
    );
    const card = screen.getByText("Quiet chrome").closest("div");
    expect(card?.className).toContain("bg-panel");
    expect(card?.className).toContain("rounded-md");
    expect(card?.className).toContain("border-border");
    expect(card?.className).toContain("p-6");
  });

  it("has no drop shadow at rest and raises border/background on hover (§7.3)", () => {
    render(<Card>Rest</Card>);
    const className = screen.getByText("Rest").closest("div")?.className ?? "";
    expect(className).not.toContain("shadow-");
    expect(className).toContain("hover:border-border-strong");
    expect(className).toContain("hover:bg-elevated");
  });

  it("composes header (17px title, 12px metadata), content and footer", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Render minutes</CardTitle>
          <CardDescription>Current cycle · Starter plan</CardDescription>
        </CardHeader>
        <CardContent>12 of 30 minutes used.</CardContent>
        <CardFooter>
          <Button size="sm" variant="secondary">
            View invoices
          </Button>
        </CardFooter>
      </Card>,
    );
    // Title is a real heading (16–18px medium → text-body-l).
    const title = screen.getByRole("heading", { level: 3, name: "Render minutes" });
    expect(title.className).toContain("text-body-l");
    expect(screen.getByText("Current cycle · Starter plan").className).toContain("text-caption");
    expect(screen.getByText("12 of 30 minutes used.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View invoices" })).toBeInTheDocument();
  });
});

describe("ProjectCard (§7.3/§8.4 — thumbnail dominates, metadata below)", () => {
  const base = {
    name: "Launch film",
    duration: "00:12",
    comps: 3,
    updated: "Updated 2h ago",
  };

  it("renders the name as the heading plus the `duration · comps` metadata line", () => {
    render(<ProjectCard {...base} />);
    expect(screen.getByRole("heading", { level: 3, name: "Launch film" })).toBeInTheDocument();
    expect(screen.getByText("00:12 · 3 comps")).toBeInTheDocument();
    expect(screen.getByText("Updated 2h ago")).toBeInTheDocument();
  });

  it("singularises the comp count for single-composition projects (§14)", () => {
    render(<ProjectCard {...base} name="Teaser" comps={1} />);
    expect(screen.getByText("00:12 · 1 comp")).toBeInTheDocument();
  });

  it("falls back to a decorative geometric slate when no thumbnail is given (§7.12/§10)", () => {
    const { container } = render(<ProjectCard {...base} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("thumbnail keeps the 16/9 frame and honours the slate stagger (§6.3)", () => {
    const { container } = render(<ProjectCard {...base} stagger={40} />);
    const frame = container.querySelector(".aspect-video");
    expect(frame).not.toBeNull();
    const reveal = container.querySelector(".animate-slate-in") as HTMLElement | null;
    expect(reveal?.style.animationDelay).toBe("40ms");
  });

  it("reveals Open / Duplicate / ⋯ actions over the thumbnail and fires callbacks", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDuplicate = vi.fn();
    const onMore = vi.fn();
    render(<ProjectCard {...base} onOpen={onOpen} onDuplicate={onDuplicate} onMore={onMore} />);

    // The icon-only ⋯ button carries its own accessible name (§7.1/§12).
    const more = screen.getByRole("button", { name: "More actions for Launch film" });
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Duplicate" }));
    await user.click(more);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onMore).toHaveBeenCalledTimes(1);

    // Actions are keyboard-reachable too (focus-within reveals the overlay).
    expect(more.tagName).toBe("BUTTON");
  });
});
