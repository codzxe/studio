import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../src/components/button.js";

// data-testid convention (see README): kebab-case `ui-<component>[-<qualifier>]`.
describe("Button", () => {
  it("renders its label and is reachable as a button by name", () => {
    render(<Button data-testid="ui-button-save">Save layer</Button>);
    expect(screen.getByTestId("ui-button-save")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save layer" })).toBeDefined();
  });

  it('defaults to type="button" (never accidentally submits forms)', () => {
    render(<Button data-testid="ui-button-default-type">Cancel</Button>);
    expect(screen.getByTestId("ui-button-default-type")).toHaveProperty("type", "button");
  });

  it('respects an explicit type="submit"', () => {
    render(
      <Button type="submit" data-testid="ui-button-submit">
        Create
      </Button>,
    );
    expect(screen.getByTestId("ui-button-submit")).toHaveProperty("type", "submit");
  });

  it("applies variant and size classes (cva), consumer className wins conflicts", () => {
    render(
      <Button
        variant="destructive"
        size="icon"
        aria-label="Delete layer"
        data-testid="ui-button-icon"
        className="h-8 w-8"
      />,
    );
    const el = screen.getByTestId("ui-button-icon");
    expect(el.className).toContain("bg-destructive");
    expect(el.className).toContain("rounded-md");
    // tailwind-merge: later h-8/w-8 utilities replace size-9
    expect(el.className).toContain("h-8");
    expect(el.className).not.toContain("size-9");
  });

  it("disabled state is inert for pointer, keyboard and screen readers", () => {
    render(
      <Button disabled data-testid="ui-button-disabled">
        Export
      </Button>,
    );
    const el = screen.getByTestId("ui-button-disabled");
    expect(el).toBeDisabled();
    expect(el.className).toContain("disabled:pointer-events-none");
    expect(el.className).toContain("disabled:opacity-50");
  });

  it("asChild renders the child element with classes + props merged onto it", () => {
    render(
      <Button asChild variant="outline" data-testid="ui-button-link">
        <a href="#layers">Layers</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Layers" });
    expect(link).toBeDefined();
    expect(link.className).toContain("border");
    expect(screen.getByTestId("ui-button-link")).toBe(link);
  });
});
