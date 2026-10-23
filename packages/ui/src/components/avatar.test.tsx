import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./avatar";

describe("Avatar (§8.1 — initials only, no photos in v1)", () => {
  it("exposes the full name as the accessible label of role=img", () => {
    render(<Avatar name="Ada Lovelace" />);
    const avatar = screen.getByRole("img", { name: "Ada Lovelace" });
    expect(avatar).toHaveAttribute("aria-label", "Ada Lovelace");
  });

  // Radix Fallback mounts on a timer (delayMs), so initials appear async.
  it("derives initials from the first two words of the name", async () => {
    render(<Avatar name="Ada Lovelace" />);
    expect(await screen.findByText("AL")).toBeInTheDocument();
  });

  it("uses a single initial for single-word names and skips extra words", async () => {
    const { rerender } = render(<Avatar name="Cher" />);
    expect(await screen.findByText("C")).toBeInTheDocument();

    // Three words → still only the first two initials (compact chips).
    rerender(<Avatar name="Grace Brewster Hopper" />);
    expect(await screen.findByText("GB")).toBeInTheDocument();
  });

  it("falls back to “?” when the name has no usable characters", async () => {
    render(<Avatar name="   " />);
    expect(await screen.findByText("?")).toBeInTheDocument();
  });

  it("sizes map to 24/32/40px chips (§8.1 top-bar avatar is md)", () => {
    const { rerender } = render(<Avatar name="Ada Lovelace" size="sm" />);
    expect(screen.getByRole("img").className).toContain("h-6");
    rerender(<Avatar name="Ada Lovelace" size="md" />);
    expect(screen.getByRole("img").className).toContain("h-8");
    rerender(<Avatar name="Ada Lovelace" size="lg" />);
    expect(screen.getByRole("img").className).toContain("h-10");
  });

  it("uses the pill radius and quiet token surfaces (§7/§3)", () => {
    render(<Avatar name="Ada Lovelace" />);
    const className = screen.getByRole("img").className;
    expect(className).toContain("rounded-pill");
    expect(className).toContain("bg-input");
    expect(className).toContain("border-border");
  });
});
