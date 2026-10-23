import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { EmptyState } from "./empty-state";

describe("EmptyState (§7.12)", () => {
  it("renders exactly one clear sentence as the message (§14: sentence case, no exclamation)", () => {
    render(<EmptyState title="No projects yet." />);
    const message = screen.getByText("No projects yet.");
    expect(message.tagName).toBe("P");
    expect(message.className).toContain("text-balance");
  });

  it("carries one primary action and one secondary link (§7.12)", () => {
    render(
      <EmptyState
        title="No projects yet. Start from a composition or import an .ecproj."
        action={<Button>New project</Button>}
        secondaryLink={{ label: "Import a project", href: "/w/import" }}
      />,
    );
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Import a project" });
    expect(link).toHaveAttribute("href", "/w/import");
  });

  it("the primary action is interactive", async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    render(
      <EmptyState title="No renders yet." action={<Button onClick={onNew}>New render</Button>} />,
    );
    await user.click(screen.getByRole("button", { name: "New render" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("shows the default geometric 1px illustration (no 3D characters, no emoji)", () => {
    const { container } = render(<EmptyState title="No comments yet." />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // Decorative: the message text carries the meaning (§12 alt-text rules).
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("withIllustration=false drops the illustration entirely", () => {
    const { container } = render(<EmptyState title="No comments yet." withIllustration={false} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("accepts a custom illustration in place of the default mark", () => {
    const { container } = render(
      <EmptyState title="No renders yet." illustration={<em data-testid="custom-mark" />} />,
    );
    expect(container.querySelector('[data-testid="custom-mark"]')).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});
