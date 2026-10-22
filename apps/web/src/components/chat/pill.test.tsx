/**
 * ChatCollapsedPill tests (M4-E) — the collapsed-mode affordance M4-J mounts
 * while the panel renders null: a keyboard-accessible 36px button named
 * "Agent" (tooltip is a hint, never the only name), expand-on-click, and
 * the CSS-only streaming dot (present only while streaming).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatCollapsedPill } from "./pill";

describe("ChatCollapsedPill", () => {
  it("renders a 36px button named 'Agent' (tooltip never the only name)", () => {
    render(<ChatCollapsedPill onExpand={() => {}} streaming={false} />);
    const pill = screen.getByRole("button", { name: "Agent" });
    expect(pill).toBe(screen.getByTestId("chat-collapsed-pill"));
    expect(pill).toHaveClass("h-9", "w-9"); // pinned 36px
    expect(pill).toHaveAttribute("data-streaming", "false");
  });

  it("expands on click (keyboard-activatable native button)", () => {
    const onExpand = vi.fn();
    render(<ChatCollapsedPill onExpand={onExpand} streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("shows the streaming dot only while streaming (CSS-only, tokens-only)", () => {
    const { rerender } = render(<ChatCollapsedPill onExpand={() => {}} streaming />);
    const dot = screen.getByTestId("chat-pill-streaming-dot");
    expect(dot).toHaveClass("animate-pulse-dot", "bg-signal");
    expect(screen.getByTestId("chat-collapsed-pill")).toHaveAttribute("data-streaming", "true");

    rerender(<ChatCollapsedPill onExpand={() => {}} streaming={false} />);
    expect(screen.queryByTestId("chat-pill-streaming-dot")).toBeNull();
  });
});
