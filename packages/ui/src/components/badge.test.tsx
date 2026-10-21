import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, RiskBadge, StatusDot } from "./badge";

describe("Badge (§7.8)", () => {
  it("renders its label — status is never colour-only", () => {
    render(<Badge variant="success">Applied</Badge>);
    expect(screen.getByText("Applied")).toBeInTheDocument();
  });

  it("maps variants to the status palette (11px uppercase chip)", () => {
    const { container } = render(<Badge variant="warning">Draft</Badge>);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-warning");
    expect(badge.className).toContain("uppercase");
  });
});

describe("StatusDot (§2.3/§7.8)", () => {
  it("pairs the decorative dot with a required label (§12 — never colour-only)", () => {
    render(<StatusDot tone="success">Agent applied 3 edits</StatusDot>);
    expect(screen.getByText("Agent applied 3 edits")).toBeInTheDocument();
  });

  it("pulses only when asked (§6.3)", () => {
    const { container, rerender } = render(<StatusDot>Streaming</StatusDot>);
    expect(container.querySelector(".animate-pulse-dot")).toBeNull();
    rerender(<StatusDot pulse>Streaming</StatusDot>);
    expect(container.querySelector(".animate-pulse-dot")).not.toBeNull();
  });
});

describe("RiskBadge (chat risk, §7.8)", () => {
  it("low = neutral, medium = warning, high = danger", () => {
    const { rerender } = render(<RiskBadge level="low" />);
    expect(screen.getByText("Low risk").className).toContain("text-secondary");

    rerender(<RiskBadge level="medium" />);
    expect(screen.getByText("Medium risk").className).toContain("text-warning");

    rerender(<RiskBadge level="high" />);
    expect(screen.getByText("High risk").className).toContain("text-danger");
  });

  it("allows a custom label while keeping the tone", () => {
    render(<RiskBadge level="high" label="Deletes 4 layers" />);
    expect(screen.getByText("Deletes 4 layers").className).toContain("text-danger");
  });
});
