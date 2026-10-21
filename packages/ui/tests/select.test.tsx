import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Select, selectVariants } from "../src/components/select.js";

describe("Select (native)", () => {
  it("renders a named combobox with its options (native semantics kept)", () => {
    render(
      <Select aria-label="Sort documents">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Sort documents" });
    expect(select).toBeDefined();
    expect(select.querySelectorAll("option")).toHaveLength(2);
    expect(
      screen.getByRole("option", { name: "Newest first" }).textContent, // jsdom keeps native option roles
    ).toBe("Newest first");
  });

  it("disabled select is inert and styled", () => {
    render(
      <Select disabled aria-label="Project" data-testid="ui-select-project">
        <option value="p1">Project one</option>
      </Select>,
    );
    const select = screen.getByTestId("ui-select-project");
    expect(select).toBeDisabled();
    expect(select.className).toContain("disabled:opacity-50");
  });

  it("applies size variants; consumer className wins conflicts", () => {
    render(
      <Select size="sm" className="h-10" aria-label="Size" data-testid="ui-select-size">
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByTestId("ui-select-size");
    expect(select.className).toContain("h-8");
    expect(select.className).toContain("text-xs");
    // tailwind-merge: later h-10 replaces the variant's h-8
    expect(select.className).toContain("h-10");
    expect(select.className).not.toContain("h-8 ");
  });

  it("aria-invalid drives the destructive error styles (Input convention)", () => {
    render(
      <Select aria-invalid data-testid="ui-select-invalid" aria-label="Tier">
        <option value="quick">Quick edit</option>
      </Select>,
    );
    const select = screen.getByTestId("ui-select-invalid");
    expect(select.className).toContain("aria-invalid:border-destructive");
    expect(select.className).toContain("aria-invalid:focus-visible:ring-destructive");
  });

  it("wrapper owns the chevron: wrapperClassName lands on the wrapper, not the select", () => {
    render(
      <Select
        wrapperClassName="w-40"
        aria-label="Filter"
        data-testid="ui-select-filter"
        className="text-lg"
      >
        <option value="all">All</option>
      </Select>,
    );
    const select = screen.getByTestId("ui-select-filter");
    expect(select.className).toContain("text-lg");
    expect(select.className).not.toContain("w-40");
    const wrapper = select.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain("w-40");
    expect(wrapper?.className).toContain("relative");
    const chevron = wrapper?.querySelector("svg[aria-hidden='true']");
    expect(chevron?.className).toContain("pointer-events-none");
  });

  it("exposes selectVariants for consumers composing their own controls", () => {
    expect(selectVariants({ size: "sm" })).toContain("h-8");
    expect(selectVariants()).toContain("h-9");
  });
});
