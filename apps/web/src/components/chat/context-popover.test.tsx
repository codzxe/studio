/**
 * ContextPopover tests (M4-H) — deterministic RTL, real timers, no network.
 *
 * The popover is a Radix modal popover portalled to document.body (focus trap,
 * Esc + outside-click dismissal, background aria-hidden come from Radix — the
 * same machinery the repo's dialog tests already exercise). Assertions target
 * the observable contract: rows/estimates, callback args, pinned chips, and
 * that `block.data` (untrusted project state) is never rendered.
 */

import type { ContextBlock } from "@/lib/chat/context";
import type { ContextSelection, PinnedContextItem } from "@studio/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextPopover } from "./context-popover";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The first block carries a data sentinel: nothing from `data` may ever reach
 * the DOM (untrusted project state — labels and estimates only).
 */
const BLOCKS: readonly ContextBlock[] = [
  {
    kind: "projectSummary",
    label: "Project summary",
    tokenEstimate: 420,
    data: { project: "RENDERED-DATA-MUST-NOT-APPEAR" },
  },
  { kind: "activeComp", label: "Comp: Main", tokenEstimate: 180 },
  { kind: "playhead", label: "Playhead 00:03.1", tokenEstimate: 20 },
  { kind: "recentCommands", label: "Recent commands", tokenEstimate: 1234 },
];

/** 420 + 180 + 20 + 1234 — formatTokenEstimate(1854) === "~1.9k tokens". */
const TOTAL = 1854;

/** Lazy frame block: the tool executor renders it on demand, data stays undefined. */
const FRAME_BLOCK: ContextBlock = {
  kind: "currentFrame",
  label: "Frame preview",
  tokenEstimate: 0,
};

const FRAME_PIN: PinnedContextItem = { kind: "frame", label: "Frame 00:03.1" };
const COMMENT_PIN: PinnedContextItem = { kind: "comment", label: "Comment: timing" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface PopoverHandlers {
  readonly onToggleBlock: ReturnType<typeof makeToggleSpy>;
  readonly onRemoveAll: ReturnType<typeof makeNoArgSpy>;
  readonly onDone: ReturnType<typeof makeNoArgSpy>;
  readonly onRemovePinned: ReturnType<typeof makePinnedSpy>;
}

function makeToggleSpy() {
  return vi.fn<(kind: keyof ContextSelection, on: boolean) => void>();
}

function makeNoArgSpy() {
  return vi.fn<() => void>();
}

function makePinnedSpy() {
  return vi.fn<(index: number) => void>();
}

function renderPopover(
  overrides: {
    readonly blocks?: readonly ContextBlock[];
    readonly totalTokenEstimate?: number;
    readonly pinned?: readonly PinnedContextItem[];
    readonly withPinnedRemoval?: boolean;
  } = {},
): PopoverHandlers {
  const handlers: PopoverHandlers = {
    onToggleBlock: makeToggleSpy(),
    onRemoveAll: makeNoArgSpy(),
    onDone: makeNoArgSpy(),
    onRemovePinned: makePinnedSpy(),
  };
  render(
    <ContextPopover
      blocks={overrides.blocks ?? BLOCKS}
      totalTokenEstimate={overrides.totalTokenEstimate ?? TOTAL}
      onToggleBlock={handlers.onToggleBlock}
      onRemoveAll={handlers.onRemoveAll}
      onDone={handlers.onDone}
      pinned={overrides.pinned}
      onRemovePinned={overrides.withPinnedRemoval ? handlers.onRemovePinned : undefined}
    />,
  );
  return handlers;
}

// ---------------------------------------------------------------------------
// Structure: dialog, rows, estimates
// ---------------------------------------------------------------------------

describe("ContextPopover — structure", () => {
  it("renders a labelled dialog with one row per block and its estimate", () => {
    renderPopover();
    const dialog = screen.getByRole("dialog", { name: "Chat context" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("context-popover")).toBeInTheDocument();
    expect(within(dialog).getByText("Context for this message")).toBeInTheDocument();

    expect(within(dialog).getByText("Project summary")).toBeInTheDocument();
    expect(within(dialog).getByText("Comp: Main")).toBeInTheDocument();
    expect(within(dialog).getByText("Playhead 00:03.1")).toBeInTheDocument();
    expect(within(dialog).getByText("Recent commands")).toBeInTheDocument();

    // Estimates come from tokens.ts formatTokenEstimate — never re-formatted.
    expect(within(dialog).getByText("~420 tokens")).toBeInTheDocument();
    expect(within(dialog).getByText("~180 tokens")).toBeInTheDocument();
    expect(within(dialog).getByText("~20 tokens")).toBeInTheDocument();
    expect(within(dialog).getByText("~1.2k tokens")).toBeInTheDocument();
  });

  it("shows '1 image' for the lazy frame block instead of a token estimate", () => {
    renderPopover({ blocks: [FRAME_BLOCK, BLOCKS[1] as ContextBlock] });
    const row = screen.getByTestId("context-row-currentFrame");
    expect(within(row).getByText("1 image")).toBeInTheDocument();
    expect(within(row).queryByText(/tokens/)).not.toBeInTheDocument();
  });

  it("renders the token total line via formatTokenEstimate", () => {
    renderPopover();
    expect(screen.getByTestId("context-total")).toHaveTextContent("~1.9k tokens total");
  });

  it("shows the empty-context note when no blocks are passed", () => {
    renderPopover({ blocks: [], totalTokenEstimate: 0 });
    expect(screen.getByText("No context will be sent.")).toBeInTheDocument();
    expect(screen.getByTestId("context-total")).toHaveTextContent("~0 tokens total");
  });

  it("never renders block data — labels and estimates only", () => {
    renderPopover(); // BLOCKS[0].data carries the sentinel.
    expect(screen.queryByText("RENDERED-DATA-MUST-NOT-APPEAR")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("RENDERED-DATA-MUST-NOT-APPEAR");
  });
});

// ---------------------------------------------------------------------------
// Toggling + footer callbacks
// ---------------------------------------------------------------------------

describe("ContextPopover — toggles and callbacks", () => {
  it("toggles a block off then back on with the right callback args", () => {
    const handlers = renderPopover();
    const toggle = screen.getByTestId("context-toggle-activeComp");
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(handlers.onToggleBlock).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    expect(handlers.onToggleBlock).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    expect(handlers.onToggleBlock.mock.calls[0]).toEqual(["activeComp", false]);
    expect(handlers.onToggleBlock.mock.calls[1]).toEqual(["activeComp", true]);
  });

  it("Remove all unchecks every row and reports exactly once", () => {
    const handlers = renderPopover();
    fireEvent.click(screen.getByTestId("context-remove-all"));
    expect(handlers.onRemoveAll).toHaveBeenCalledTimes(1);
    for (const block of BLOCKS) {
      expect(screen.getByTestId(`context-toggle-${block.kind}`)).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
  });

  it("Done dismisses the popover", () => {
    const handlers = renderPopover();
    fireEvent.click(screen.getByTestId("context-done"));
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Dismissal: Esc + outside/overlay click (Radix modal machinery)
// ---------------------------------------------------------------------------

describe("ContextPopover — dismissal", () => {
  it("Escape dismisses via onDone", async () => {
    const user = userEvent.setup();
    const handlers = renderPopover();
    await user.keyboard("{Escape}");
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
  });

  it("an outside (overlay) click dismisses via onDone", async () => {
    const handlers = renderPopover();
    // Radix wires its document pointerdown listener a tick after mount.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(handlers.onDone).toHaveBeenCalledTimes(1));
  });

  it("traps focus inside the dialog (initial focus + Tab wrap both ways)", () => {
    renderPopover();
    const dialog = screen.getByTestId("context-popover");
    // Initial focus lands on the first focusable row control.
    expect(dialog.contains(document.activeElement)).toBe(true);
    const first = document.activeElement as HTMLElement;

    // Shift+Tab from the first focusable wraps to the last (Done).
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("context-done"));

    // Tab from the last focusable wraps back to the first.
    fireEvent.keyDown(screen.getByTestId("context-done"), { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Repeated tabbing never escapes the dialog.
    for (let step = 0; step < 8; step++) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    }
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pinned section (§5.2 — optional props)
// ---------------------------------------------------------------------------

describe("ContextPopover — pinned chips", () => {
  it("renders pinned chips with glyphs and ✕ removal by index", () => {
    const handlers = renderPopover({
      pinned: [FRAME_PIN, COMMENT_PIN],
      withPinnedRemoval: true,
    });
    const section = screen.getByTestId("context-pinned-list");
    expect(within(section).getByText("Pinned")).toBeInTheDocument();
    expect(within(section).getByText("▣")).toBeInTheDocument();
    expect(within(section).getByText("✎")).toBeInTheDocument();
    expect(within(section).getByTestId("context-pinned-1")).toHaveTextContent("Comment: timing");

    const remove = within(section).getByTestId("context-pinned-remove-1");
    expect(remove).toHaveAccessibleName("Remove Comment: timing from context");
    fireEvent.click(remove);
    expect(handlers.onRemovePinned).toHaveBeenCalledTimes(1);
    expect(handlers.onRemovePinned).toHaveBeenCalledWith(1);
  });

  it("pinned chips stay display-only when onRemovePinned is omitted", () => {
    renderPopover({ pinned: [FRAME_PIN] });
    expect(screen.getByTestId("context-pinned-0")).toHaveTextContent("Frame 00:03.1");
    expect(screen.queryByTestId("context-pinned-remove-0")).not.toBeInTheDocument();
  });

  it("renders no pinned section when the list is absent or empty", () => {
    renderPopover();
    expect(screen.queryByTestId("context-pinned-list")).not.toBeInTheDocument();
    renderPopover({ pinned: [] });
    expect(screen.queryByTestId("context-pinned-list")).not.toBeInTheDocument();
  });
});
