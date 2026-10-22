/**
 * QuickActions tests (M5-I; EDITOR_CHAT_UX §4.4, BUILD_PLAN §M5.7).
 *
 * Pure builders + a presentational chip row:
 * - `buildQuickActions` — the exact §4.4 list, templated with the current
 *   selection context, selection-gated.
 * - `selectionNamesOf` — tolerant reads of the provider's context snapshot.
 * - `QuickActions` — click = `onSeed(prompt)`, nothing else: the component
 *   holds no bridge, no send path and no window dispatch, so it structurally
 *   cannot mutate the editor (law #6/#7).
 */

import {
  CHAT_SEED_COMPOSER_EVENT,
  QuickActions,
  buildQuickActions,
  selectionNamesOf,
} from "@/components/chat/quick-actions";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("buildQuickActions (§4.4)", () => {
  it("builds the full §4.4 list with the selection names templated in", () => {
    const actions = buildQuickActions(true, ["Headline", "Subhead"]);
    expect(actions.map((a) => a.label)).toEqual([
      "Animate in",
      "Animate out",
      "Make it pop",
      "Match brand colors",
      "Clean up layers",
      "Explain this comp",
      "Render a preview",
    ]);
    expect(actions[0]?.prompt).toBe("Animate “Headline”, “Subhead” in with a smooth entrance.");
    expect(actions[1]?.prompt).toBe("Animate “Headline”, “Subhead” out with a clean exit.");
    expect(actions[3]?.prompt).toBe("Match “Headline”, “Subhead” to the brand colors.");
    // Composition-level chips never mention the selection.
    expect(actions[4]?.prompt).toBe("Clean up the layers of this composition.");
    expect(actions[5]?.prompt).toBe("Explain what this composition does.");
    expect(actions[6]?.prompt).toBe("Render a preview of the current composition.");
  });

  it("degrades to “the current selection” when a selection exists but names are unknown", () => {
    const actions = buildQuickActions(true, null);
    expect(actions).toHaveLength(7);
    expect(actions[0]?.prompt).toBe("Animate “the current selection” in with a smooth entrance.");
  });

  it("renders NO composer-row chips without a selection (the §4.4 “after a selection” surface)", () => {
    expect(buildQuickActions(false, ["Headline"])).toEqual([]);
  });

  it("round-trips hostile layer names as data inside the templated prompt", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const actions = buildQuickActions(true, [hostile]);
    // The name is embedded verbatim as a string — it is data, never markup.
    expect(actions[0]?.prompt).toBe(`Animate “${hostile}” in with a smooth entrance.`);
  });
});

describe("selectionNamesOf", () => {
  it("reads the selection block's layer names in order", () => {
    const context = {
      blocks: [
        { kind: "projectSummary", data: {} },
        {
          kind: "selection",
          data: { layers: [{ name: "Headline" }, null, { name: "Subhead" }, { id: 3 }] },
        },
      ],
    };
    expect(selectionNamesOf(context)).toEqual(["Headline", "Subhead"]);
  });

  it("tolerates missing blocks, junk shapes and null contexts", () => {
    expect(selectionNamesOf(null)).toBeNull();
    expect(selectionNamesOf(undefined)).toBeNull();
    expect(selectionNamesOf({ blocks: [] })).toBeNull();
    expect(selectionNamesOf({ blocks: [{ kind: "selection", data: undefined }] })).toBeNull();
    expect(selectionNamesOf({ blocks: [{ kind: "playhead", data: { time: 0 } }] })).toBeNull();
    expect(
      selectionNamesOf({ blocks: [{ kind: "selection", data: { layers: "nope" } }] }),
    ).toBeNull();
    // Nameless nodes degrade to "no names", not a crash.
    expect(
      selectionNamesOf({ blocks: [{ kind: "selection", data: { layers: [{ id: 1 }] } }] }),
    ).toBeNull();
  });
});

describe("QuickActions (the chip row)", () => {
  const actions = buildQuickActions(true, ["Headline"]);

  it("renders one token chip per action and seeds the parent on click", () => {
    const onSeed = vi.fn();
    render(<QuickActions actions={actions} onSeed={onSeed} />);
    const row = screen.getByTestId("chat-quick-actions");
    const chips = screen.getAllByTestId("chat-quick-action-chip");
    expect(chips).toHaveLength(7);
    expect(row).toContainElement(chips[0] as HTMLElement);

    fireEvent.click(screen.getByText("Animate in"));
    expect(onSeed).toHaveBeenCalledTimes(1);
    expect(onSeed).toHaveBeenCalledWith("Animate “Headline” in with a smooth entrance.");
  });

  it("dispatches NO window events itself — the slot owns the seed/send seam", () => {
    const onSeed = vi.fn();
    const seedSpy = vi.fn();
    const quickSpy = vi.fn();
    window.addEventListener(CHAT_SEED_COMPOSER_EVENT, seedSpy);
    window.addEventListener("studio:chat-quick-action", quickSpy);
    render(<QuickActions actions={actions} onSeed={onSeed} />);
    fireEvent.click(screen.getByText("Make it pop"));
    window.removeEventListener(CHAT_SEED_COMPOSER_EVENT, seedSpy);
    window.removeEventListener("studio:chat-quick-action", quickSpy);

    expect(onSeed).toHaveBeenCalledTimes(1);
    expect(seedSpy).not.toHaveBeenCalled();
    expect(quickSpy).not.toHaveBeenCalled();
  });

  it("renders nothing for an empty action list (the no-selection composer stays clean)", () => {
    const { container } = render(<QuickActions actions={[]} onSeed={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("chat-quick-actions")).not.toBeInTheDocument();
  });
});
