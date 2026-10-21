import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders an accessible button", () => {
    render(<Button>Create project</Button>);
    expect(screen.getByRole("button", { name: "Create project" })).toBeInTheDocument();
  });

  it("primary variant uses the signal fill with signal-ink text (§7.1)", () => {
    render(<Button variant="primary">Deploy</Button>);
    const button = screen.getByRole("button", { name: "Deploy" });
    expect(button.className).toContain("bg-signal");
    expect(button.className).toContain("text-signal-ink");
  });

  it("secondary variant uses an elevated fill with a 1px border (§7.1)", () => {
    render(<Button variant="secondary">Share</Button>);
    const button = screen.getByRole("button", { name: "Share" });
    expect(button.className).toContain("bg-elevated");
    expect(button.className).toContain("border");
  });

  it("sizes map to 28/36/44 heights (§7.1)", () => {
    const { rerender } = render(<Button size="sm">A</Button>);
    expect(screen.getByRole("button", { name: "A" }).className).toContain("h-7");
    rerender(<Button size="md">A</Button>);
    expect(screen.getByRole("button", { name: "A" }).className).toContain("h-9");
    rerender(<Button size="lg">A</Button>);
    expect(screen.getByRole("button", { name: "A" }).className).toContain("h-11");
  });

  it("icon-only size renders 32px and requires an accessible name (§7.1)", () => {
    render(
      <Button size="iconSm" aria-label="Close">
        ×
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Close" });
    expect(button.className).toContain("h-8");
    expect(button.className).toContain("w-8");
  });

  it("loading keeps the width, shows Working… and reports busy (§7.1)", () => {
    render(<Button loading>Deploy</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Working…")).toBeInTheDocument();
    // Original label stays in the DOM (invisible) so the width is preserved.
    expect(screen.getByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("Deploy").className).toContain("invisible");
  });

  it("disabled: opacity .45, aria-disabled, and not clickable (§7.1)", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Deploy
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Deploy" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.className).toContain("opacity-45");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires clicks when enabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Deploy</Button>);
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
