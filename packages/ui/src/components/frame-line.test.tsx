import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FrameLine } from "./frame-line";

describe("FrameLine (§2.3 signature element)", () => {
  it("renders the timecode label as readable text", () => {
    render(<FrameLine label="00:00:12 — WORKFLOW" />);
    expect(screen.getByText("00:00:12 — WORKFLOW")).toBeInTheDocument();
    // The label uses tabular numerals so the timecode never jitters.
    expect(screen.getByText("00:00:12 — WORKFLOW").className).toContain("tabular");
  });

  it("applies the .frame-line signature utility (§2.3)", () => {
    const { container } = render(<FrameLine label="00:00:12" />);
    expect(container.firstElementChild?.className).toContain("frame-line");
  });

  it("sets data-draw only when draw is requested (§6.3 — 240ms scaleX draw)", () => {
    const { container, rerender } = render(<FrameLine label="00:00:12" />);
    const line = container.firstElementChild as HTMLElement;
    expect(line.hasAttribute("data-draw")).toBe(false);

    rerender(<FrameLine label="00:00:12" draw />);
    expect(line.hasAttribute("data-draw")).toBe(true);
  });
});
