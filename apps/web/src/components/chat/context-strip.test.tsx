/**
 * ContextStrip tests (M4-H) — deterministic RTL, real timers, no network.
 *
 * The narrow-collapse branch (§3.2) is driven by a controllable
 * ResizeObserver: jsdom has no layout, and the shared vitest setup installs a
 * no-op observer, so every unmocked render deterministically takes the
 * "expanded" branch (no measurement yet). Tests that need the collapsed
 * branch install a width-firing observer and restore the original after.
 */

import type { ContextBlock } from "@/lib/chat/context";
import type { ContextSelection, PinnedContextItem } from "@studio/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextStrip } from "./context-strip";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BLOCKS: readonly ContextBlock[] = [
  { kind: "projectSummary", label: "Project summary", tokenEstimate: 420 },
  { kind: "activeComp", label: "Comp: Main", tokenEstimate: 180 },
  { kind: "playhead", label: "Playhead 00:03.1", tokenEstimate: 20 },
];

/** 420 + 180 + 20 — formatTokenEstimate(620) === "~620 tokens". */
const TOTAL = 620;

const FRAME_PIN: PinnedContextItem = { kind: "frame", label: "Frame 00:03.1" };
const COMP_PIN: PinnedContextItem = { kind: "composition", label: "Comp: Side" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface StripHandlers {
  readonly onRemoveBlock: ReturnType<typeof makeRemoveBlockSpy>;
  readonly onAddContext: ReturnType<typeof makeAddContextSpy>;
}

function makeRemoveBlockSpy() {
  return vi.fn<(kind: keyof ContextSelection) => void>();
}

function makeAddContextSpy() {
  return vi.fn<() => void>();
}

function renderStrip(
  overrides: {
    readonly blocks?: readonly ContextBlock[];
    readonly pinned?: readonly PinnedContextItem[];
    readonly totalTokenEstimate?: number;
  } = {},
): StripHandlers {
  const handlers: StripHandlers = {
    onRemoveBlock: makeRemoveBlockSpy(),
    onAddContext: makeAddContextSpy(),
  };
  render(
    <ContextStrip
      blocks={overrides.blocks ?? BLOCKS}
      totalTokenEstimate={overrides.totalTokenEstimate ?? TOTAL}
      onRemoveBlock={handlers.onRemoveBlock}
      onAddContext={handlers.onAddContext}
      pinned={overrides.pinned}
    />,
  );
  return handlers;
}

/** Install a ResizeObserver whose observe() reports one fixed width. */
function installWidthObserver(width: number): void {
  class WidthObserver implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      const entry = { target, contentRect: { width } } as unknown as ResizeObserverEntry;
      this.callback([entry], this);
    }
    unobserve(_target: Element): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = WidthObserver;
}

const realObserver = window.ResizeObserver;

afterEach(() => {
  window.ResizeObserver = realObserver;
});

// ---------------------------------------------------------------------------
// Chips + callbacks
// ---------------------------------------------------------------------------

describe("ContextStrip — chips", () => {
  it("renders one removable chip per active block with the collector labels", () => {
    renderStrip();
    for (const block of BLOCKS) {
      const chip = screen.getByTestId(`context-chip-${block.kind}`);
      expect(chip).toHaveTextContent(block.label);
    }
    expect(screen.queryByTestId("context-strip-summary")).not.toBeInTheDocument();
    // The total estimate is surfaced through the group's accessible name.
    expect(
      screen.getByRole("group", { name: "Chat context, ~620 tokens total" }),
    ).toBeInTheDocument();
  });

  it("renders only the blocks it is given — the parent owns removal state", () => {
    const onlySummary = BLOCKS[0] as ContextBlock;
    renderStrip({ blocks: [onlySummary] });
    expect(screen.getByTestId("context-chip-projectSummary")).toBeInTheDocument();
    expect(screen.queryByTestId("context-chip-activeComp")).not.toBeInTheDocument();
  });

  it("a chip ✕ removes exactly its block kind", () => {
    const handlers = renderStrip();
    const remove = screen.getByTestId("context-chip-remove-activeComp");
    expect(remove).toHaveAccessibleName("Remove Comp: Main from context");
    fireEvent.click(remove);
    expect(handlers.onRemoveBlock).toHaveBeenCalledTimes(1);
    expect(handlers.onRemoveBlock).toHaveBeenCalledWith("activeComp");
  });

  it("the + chip opens the picker via onAddContext", () => {
    const handlers = renderStrip();
    const add = screen.getByTestId("context-strip-add");
    expect(add).toHaveAccessibleName("Add context");
    fireEvent.click(add);
    expect(handlers.onAddContext).toHaveBeenCalledTimes(1);
  });

  it("renders display-only pinned chips with their kind glyphs", () => {
    renderStrip({ pinned: [FRAME_PIN, COMP_PIN] });
    const frame = screen.getByTestId("context-pinned-0");
    expect(frame).toHaveTextContent("Frame 00:03.1");
    expect(frame).toHaveTextContent("▣");
    const comp = screen.getByTestId("context-pinned-1");
    expect(comp).toHaveTextContent("Comp: Side");
    expect(comp).toHaveTextContent("▤");
    for (const index of [0, 1]) {
      const chip = screen.getByTestId(`context-pinned-${index}`);
      expect(within(chip).queryByRole("button")).not.toBeInTheDocument();
    }
    // blocks + pinned + the trailing "+" chip.
    const strip = screen.getByTestId("context-strip");
    const chips = within(strip).getAllByTestId(/^context-(chip-|pinned-|strip-add)/);
    expect(chips).toHaveLength(BLOCKS.length + 2 + 1);
  });

  it("renders pinned chips even with no blocks", () => {
    renderStrip({ blocks: [], pinned: [FRAME_PIN] });
    expect(screen.getByTestId("context-pinned-0")).toBeInTheDocument();
    expect(screen.getByTestId("context-strip-add")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Null rules (§3.2)
// ---------------------------------------------------------------------------

describe("ContextStrip — empty state", () => {
  it("renders null with no blocks and no pinned items", () => {
    renderStrip({ blocks: [] });
    expect(screen.queryByTestId("context-strip")).not.toBeInTheDocument();
  });

  it("renders null with no blocks and an empty pinned array", () => {
    renderStrip({ blocks: [], pinned: [] });
    expect(screen.queryByTestId("context-strip")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Narrow collapse (§3.2 "Context N")
// ---------------------------------------------------------------------------

describe("ContextStrip — narrow collapse", () => {
  it("collapses to 'Context N' below 480px container width", () => {
    installWidthObserver(360);
    renderStrip({ pinned: [FRAME_PIN] });
    const summary = screen.getByTestId("context-strip-summary");
    expect(summary).toHaveTextContent("Context 4"); // 3 blocks + 1 pinned
    expect(screen.queryByTestId("context-chip-activeComp")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-pinned-0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-strip-add")).not.toBeInTheDocument();
    // The collapsed summary keeps the picker reachable and carries the total.
    expect(summary).toHaveAttribute("title", "~620 tokens total");
    expect(
      screen.getByRole("group", { name: "Chat context, ~620 tokens total" }),
    ).toBeInTheDocument();
  });

  it("the collapsed summary routes to onAddContext (picker stays reachable)", () => {
    installWidthObserver(360);
    const handlers = renderStrip({ pinned: [FRAME_PIN] });
    fireEvent.click(screen.getByTestId("context-strip-summary"));
    expect(handlers.onAddContext).toHaveBeenCalledTimes(1);
  });

  it("treats exactly 480px as expanded (strict < 480)", () => {
    installWidthObserver(480);
    renderStrip();
    expect(screen.getByTestId("context-chip-projectSummary")).toBeInTheDocument();
    expect(screen.queryByTestId("context-strip-summary")).not.toBeInTheDocument();
  });

  it("stays expanded when no measurement has arrived yet", () => {
    renderStrip(); // the shared setup's no-op observer never fires.
    expect(screen.getByTestId("context-chip-projectSummary")).toBeInTheDocument();
    expect(screen.queryByTestId("context-strip-summary")).not.toBeInTheDocument();
  });
});
