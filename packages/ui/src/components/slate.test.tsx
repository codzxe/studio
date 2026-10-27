import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";
import { Slate } from "./slate";

describe("Slate (§2.3 signature element — compact project header)", () => {
  it("renders the project name as the heading with the `duration · comps` line", () => {
    render(<Slate name="Launch film" duration="00:12:04" comps={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Launch film" })).toBeInTheDocument();
    expect(screen.getByText("00:12:04 · 3 comps")).toBeInTheDocument();
  });

  it("appends the relative updated time when provided (§14: “Updated 2h ago”)", () => {
    render(<Slate name="Launch film" duration="00:12:04" comps={3} updated="Updated 2h ago" />);
    expect(screen.getByText("00:12:04 · 3 comps · Updated 2h ago")).toBeInTheDocument();
  });

  it("singularises the comp count (§14 domain language)", () => {
    render(<Slate name="Teaser" duration="00:04" comps={1} />);
    expect(screen.getByText("00:04 · 1 comp")).toBeInTheDocument();
  });

  it("accepts a right-aligned status slot (children)", () => {
    render(
      <Slate name="Launch film" duration="00:12:04" comps={3}>
        <Badge variant="success">Applied</Badge>
      </Slate>,
    );
    expect(screen.getByText("Applied")).toBeInTheDocument();
    // The slot sits in the same row as the name (right-aligned per §2.3).
    expect(screen.getByText("Applied").closest("div")).toBe(
      screen.getByRole("heading").closest("div"),
    );
  });

  it("uses the .slate utility so non-React surfaces can reuse the styling", () => {
    const { container } = render(<Slate name="Launch film" duration="00:12:04" comps={3} />);
    expect(container.firstElementChild?.className).toContain("slate");
  });

  it("keeps long names on one line (truncate, no wrap)", () => {
    render(
      <Slate
        name="A very long production name that would overflow"
        duration="00:12:04"
        comps={3}
      />,
    );
    expect(screen.getByRole("heading").className).toContain("truncate");
  });
});
