import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd } from "./kbd";

describe("Kbd (§4.2/§7.6 — keyboard hint chip)", () => {
  it("renders its key label", () => {
    render(<Kbd>K</Kbd>);
    expect(screen.getByText("K")).toBeInTheDocument();
  });

  it("uses mono at hint scale with radius-xs (§4.2: 11px is keyboard-hint territory)", () => {
    render(<Kbd>K</Kbd>);
    const className = screen.getByText("K").className;
    expect(className).toContain("font-mono");
    expect(className).toContain("text-hint");
    expect(className).toContain("rounded-xs");
  });

  it("keeps a fixed 20px chip height so shortcuts align in rows", () => {
    render(<Kbd>esc</Kbd>);
    const className = screen.getByText("esc").className;
    expect(className).toContain("h-5");
    expect(className).toContain("min-w-5");
    expect(className).toContain("items-center");
    expect(className).toContain("justify-center");
  });
});
