import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "./spinner";

describe("Spinner (§7.13 loading indicator)", () => {
  it("announces itself through the implicit status role with the default label", () => {
    render(<Spinner />);
    const spinner = screen.getByRole("status", { name: "Loading" });
    expect(spinner.tagName).toBe("OUTPUT");
  });

  it("takes a context-specific accessible label (§12 — announced to screen readers)", () => {
    render(<Spinner label="Rendering frame 12" />);
    expect(screen.getByRole("status", { name: "Rendering frame 12" })).toBeInTheDocument();
  });

  it("spins and keeps the icon decorative (the label carries the meaning)", () => {
    const { container } = render(<Spinner />);
    const spinner = screen.getByRole("status");
    expect(spinner.className).toContain("animate-spin");
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("accepts the Lucide icon scale 16/20/24 (§10)", () => {
    const { container, rerender } = render(<Spinner size={16} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("16");
    rerender(<Spinner size={20} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("20");
    rerender(<Spinner size={24} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("24");
  });
});
