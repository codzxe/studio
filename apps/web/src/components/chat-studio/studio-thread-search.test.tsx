/**
 * StudioThreadSearch tests — the in-conversation search bar. Covers the
 * pure matcher (`findMatches`: case-insensitivity, thread order, dedupe,
 * empty query) and the presentational bar: mount-on-open + autofocus,
 * results-come-from-the-parent (typing only feeds the input; the counter
 * follows props), prev/next stepping with wrap-around, the index resets
 * (reopen / result-count change), and Escape / ✕ dismissal.
 * Deterministic; no network; jsdom.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  StudioThreadSearch,
  type StudioThreadSearchProps,
  findMatches,
} from "./studio-thread-search";

const MESSAGES = [
  { id: "m1", text: "Alpha cut of the launch film" },
  { id: "m2", text: "beta CUT — tighter" },
  { id: "m3", text: "Nothing to see here" },
] as const;

function bar(overrides: Partial<StudioThreadSearchProps> = {}) {
  return (
    <StudioThreadSearch open onClose={vi.fn()} messageIds={[]} onJump={vi.fn()} {...overrides} />
  );
}

describe("findMatches (pure)", () => {
  it("matches case-insensitively and preserves thread order", () => {
    expect(findMatches(MESSAGES, "CUT")).toEqual(["m1", "m2"]);
    expect(findMatches(MESSAGES, "cut")).toEqual(["m1", "m2"]);
    // Substring, not whole-word:
    expect(findMatches(MESSAGES, "lph")).toEqual(["m1"]);
  });

  it("returns [] for an empty or whitespace-only query", () => {
    expect(findMatches(MESSAGES, "")).toEqual([]);
    expect(findMatches(MESSAGES, "   ")).toEqual([]);
  });

  it("dedupes repeated ids while keeping first-seen thread order", () => {
    const duplicated = [
      { id: "m1", text: "hello" },
      { id: "m2", text: "hello again" },
      { id: "m1", text: "hello once more" },
    ] as const;
    expect(findMatches(duplicated, "hello")).toEqual(["m1", "m2"]);
  });

  it("matches nothing when no text contains the query", () => {
    expect(findMatches(MESSAGES, "zzz")).toEqual([]);
  });
});

describe("StudioThreadSearch — presence", () => {
  it("renders the floating bar only while open, and autofocuses the input", () => {
    const { rerender } = render(bar({ open: false }));
    expect(screen.queryByTestId("studio-thread-search")).not.toBeInTheDocument();

    rerender(bar({ open: true }));
    expect(screen.getByTestId("studio-thread-search")).toBeInTheDocument();
    expect(screen.getByTestId("studio-thread-search-input")).toHaveFocus();
  });

  it("leaves matching to the parent — typing feeds the input only; the counter follows props", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const { rerender } = render(bar({ messageIds: [], onJump }));

    expect(screen.getByTestId("studio-thread-search-count")).toHaveTextContent("No matches");

    await user.type(screen.getByTestId("studio-thread-search-input"), "cut");
    expect(screen.getByTestId("studio-thread-search-input")).toHaveValue("cut");
    expect(screen.getByTestId("studio-thread-search-count")).toHaveTextContent("No matches");
    expect(onJump).not.toHaveBeenCalled();

    // The parent computes matches (findMatches) and passes the ids down:
    rerender(bar({ messageIds: ["m2"], onJump }));
    expect(screen.getByTestId("studio-thread-search-count")).toHaveTextContent("1 result");

    rerender(bar({ messageIds: ["m1", "m2"], onJump }));
    expect(screen.getByTestId("studio-thread-search-count")).toHaveTextContent("2 results");
  });
});

describe("StudioThreadSearch — stepping", () => {
  it("steps next through every match and wraps to the first", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(bar({ messageIds: ["m1", "m2", "m3"], onJump }));

    const next = screen.getByTestId("studio-thread-search-next");
    await user.click(next);
    expect(onJump).toHaveBeenLastCalledWith("m1");
    await user.click(next);
    expect(onJump).toHaveBeenLastCalledWith("m2");
    await user.click(next);
    expect(onJump).toHaveBeenLastCalledWith("m3");
    await user.click(next); // wraps
    expect(onJump).toHaveBeenLastCalledWith("m1");
  });

  it("steps prev with wrap-around to the last match", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(bar({ messageIds: ["m1", "m2", "m3"], onJump }));

    const prev = screen.getByTestId("studio-thread-search-prev");
    await user.click(prev); // fresh open: wraps straight to the last match
    expect(onJump).toHaveBeenLastCalledWith("m3");
    await user.click(prev);
    expect(onJump).toHaveBeenLastCalledWith("m2");
    await user.click(prev);
    expect(onJump).toHaveBeenLastCalledWith("m1");
    await user.click(prev); // wraps
    expect(onJump).toHaveBeenLastCalledWith("m3");
  });

  it("resets the moving index when the result count changes (not on same-count swaps)", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const { rerender } = render(bar({ messageIds: ["m1", "m2", "m3"], onJump }));

    await user.click(screen.getByTestId("studio-thread-search-next"));
    await user.click(screen.getByTestId("studio-thread-search-next")); // index → 1 ("m2")

    // Same count, different ids: the index survives (spec: reset on COUNT change).
    rerender(bar({ messageIds: ["p1", "p2", "p3"], onJump }));
    await user.click(screen.getByTestId("studio-thread-search-next"));
    expect(onJump).toHaveBeenLastCalledWith("p3");

    // Count change (3 → 2): the index resets, next lands on the first match.
    rerender(bar({ messageIds: ["q1", "q2"], onJump }));
    await user.click(screen.getByTestId("studio-thread-search-next"));
    expect(onJump).toHaveBeenLastCalledWith("q1");
  });

  it("resets the moving index when the bar reopens", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const { rerender } = render(bar({ messageIds: ["m1", "m2", "m3"], onJump }));

    await user.click(screen.getByTestId("studio-thread-search-next"));
    expect(onJump).toHaveBeenLastCalledWith("m1");

    rerender(bar({ open: false, messageIds: ["m1", "m2", "m3"], onJump }));
    rerender(bar({ open: true, messageIds: ["m1", "m2", "m3"], onJump }));

    await user.click(screen.getByTestId("studio-thread-search-next"));
    expect(onJump).toHaveBeenLastCalledWith("m1"); // fresh start, not "m2"
  });

  it("disables stepping while there are no matches", () => {
    const onJump = vi.fn();
    render(bar({ messageIds: [], onJump }));
    expect(screen.getByTestId("studio-thread-search-prev")).toBeDisabled();
    expect(screen.getByTestId("studio-thread-search-next")).toBeDisabled();
    expect(screen.getByTestId("studio-thread-search-count")).toHaveTextContent("No matches");
    expect(onJump).not.toHaveBeenCalled();
  });

  it("plays the full contract: findMatches output drives the bar", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(bar({ messageIds: findMatches(MESSAGES, "CUT"), onJump }));

    expect(screen.getByTestId("studio-thread-search-count")).toHaveTextContent("2 results");
    await user.click(screen.getByTestId("studio-thread-search-next"));
    expect(onJump).toHaveBeenLastCalledWith("m1");
  });
});

describe("StudioThreadSearch — closing", () => {
  it("closes on Escape from the input and via the ✕ affordance", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(bar({ onClose, messageIds: ["m1"] }));

    fireEvent.keyDown(screen.getByTestId("studio-thread-search-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    await user.click(screen.getByTestId("studio-thread-search-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close on other keys", () => {
    const onClose = vi.fn();
    render(bar({ onClose }));
    fireEvent.keyDown(screen.getByTestId("studio-thread-search-input"), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
