"use client";

/**
 * QuickActions — EDITOR_CHAT_UX §4.4 (BUILD_PLAN §M5.7, D-5 editor-route UX).
 *
 * Contextual quick-action chips rendered ABOVE the composer (M5-I; the M4
 * empty-thread chips in `ChatThread` stay untouched — same §4.4 list, the
 * composer row is the "after a selection" surface). Quick actions are
 * "shortcuts to prompts, not hidden automation" (§4.4): a click SEEDS the
 * composer with a templated prompt built from the current selection context;
 * nothing is applied, executed or batched by this module — it holds no bridge
 * and no send path, so it structurally cannot mutate the editor (law #6/#7).
 *
 * Seaming contract (M5-I local seam, integrator note):
 * - `QuickActions` itself is presentational: `onSeed(prompt)` hands the built
 *   prompt to the parent (the chat panel slot).
 * - The slot publishes the prompt as the CANCELABLE window CustomEvent
 *   `CHAT_SEED_COMPOSER_EVENT` (`detail: prompt`). A draft-capable composer
 *   CLAIMS the event (`preventDefault()`) and shows the prompt as an editable
 *   draft. Until the composer (M4-G peer) grows that listener the slot falls
 *   back to the M4-pinned `CHAT_QUICK_ACTION_EVENT` send path — which is still
 *   chat-only: a send proposes a plan, it never touches the engine.
 */

import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// The §4.4 list (exact labels from EDITOR_CHAT_UX.md §4.4)
// ---------------------------------------------------------------------------

/**
 * Window CustomEvent a quick action publishes to seed the composer draft
 * (M5-I seam; the composer claims it via `event.preventDefault()`).
 */
export const CHAT_SEED_COMPOSER_EVENT = "studio:chat-seed-composer";

/** How the selection is named inside a templated prompt when names are known. */
function quotedSelection(names: readonly string[]): string {
  return names.map((name) => `“${name}”`).join(", ");
}

/** The §4.4 definitions: label + prompt template per selection state. */
interface QuickActionDefinition {
  readonly id: string;
  readonly label: string;
  /** Selection-dependent chips only build prompts when a selection exists. */
  readonly requiresSelection: boolean;
  readonly build: (selection: string) => string;
}

const QUICK_ACTION_DEFINITIONS: readonly QuickActionDefinition[] = [
  {
    id: "animate-in",
    label: "Animate in",
    requiresSelection: true,
    build: (selection) => `Animate ${selection} in with a smooth entrance.`,
  },
  {
    id: "animate-out",
    label: "Animate out",
    requiresSelection: true,
    build: (selection) => `Animate ${selection} out with a clean exit.`,
  },
  {
    id: "make-it-pop",
    label: "Make it pop",
    requiresSelection: true,
    build: (selection) => `Make ${selection} pop — add punchy emphasis.`,
  },
  {
    id: "match-brand-colors",
    label: "Match brand colors",
    requiresSelection: true,
    build: (selection) => `Match ${selection} to the brand colors.`,
  },
  {
    id: "clean-up-layers",
    label: "Clean up layers",
    requiresSelection: false,
    build: () => "Clean up the layers of this composition.",
  },
  {
    id: "explain-this-comp",
    label: "Explain this comp",
    requiresSelection: false,
    build: () => "Explain what this composition does.",
  },
  {
    id: "render-a-preview",
    label: "Render a preview",
    requiresSelection: false,
    build: () => "Render a preview of the current composition.",
  },
];

// ---------------------------------------------------------------------------
// Selection context (§4.4 "current selection context")
// ---------------------------------------------------------------------------

/**
 * Minimal structural slice of the provider's context snapshot (peer-owned
 * `lib/chat/context.ts`): the quick actions read ONLY the selection block,
 * verbatim editor state, tolerant of every degraded/unavailable shape
 * (missing block, `data: undefined`, non-array `layers`, nameless nodes).
 *
 * Returns the selected layer NAMES in block order, or `null` when the
 * snapshot carries no readable selection names.
 */
export function selectionNamesOf(
  context:
    | { readonly blocks: ReadonlyArray<{ readonly kind?: unknown; readonly data?: unknown }> }
    | null
    | undefined,
): readonly string[] | null {
  if (context === null || context === undefined) return null;
  const block = context.blocks.find((entry) => entry?.kind === "selection");
  const data = block?.data;
  if (typeof data !== "object" || data === null || !Array.isArray((data as { layers?: unknown }).layers)) {
    return null;
  }
  const layers = (data as { layers: readonly unknown[] }).layers;
  const names: string[] = [];
  for (const node of layers) {
    if (typeof node === "object" && node !== null) {
      const name = (node as { name?: unknown }).name;
      if (typeof name === "string" && name.trim() !== "") names.push(name);
    }
  }
  return names.length > 0 ? names : null;
}

/** One built chip: a §4.4 label plus the final templated prompt. */
export interface QuickActionChip {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

/**
 * Build the §4.4 chip list for the current selection state (pure):
 *
 * - With a selection: the four selection actions templated with the layer
 *   names (unknown names degrade to "the current selection"), followed by the
 *   three composition-level actions.
 * - Without a selection: the row is EMPTY — the §4.4 "after a selection"
 *   surface stays hidden and the M4 empty-thread chips keep their case.
 */
export function buildQuickActions(
  hasSelection: boolean,
  selectionNames: readonly string[] | null,
): readonly QuickActionChip[] {
  if (!hasSelection) return [];
  const selection = quotedSelection(selectionNames ?? ["the current selection"]);
  return QUICK_ACTION_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    prompt: definition.build(selection),
  }));
}

// ---------------------------------------------------------------------------
// The chip row (presentational only)
// ---------------------------------------------------------------------------

export interface QuickActionsProps {
  /** Built by `buildQuickActions`; empty renders nothing. */
  readonly actions: readonly QuickActionChip[];
  /**
   * The seed seam: receives the chip's templated prompt. The parent decides
   * how it reaches the composer (window seed event → draft, fallback send).
   */
  readonly onSeed: (prompt: string) => void;
}

export function QuickActions({ actions, onSeed }: QuickActionsProps): ReactElement | null {
  if (actions.length === 0) return null;
  return (
    <div
      data-testid="chat-quick-actions"
      className="flex w-full flex-wrap gap-1.5"
      role="group"
      aria-label="Quick actions"
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-testid="chat-quick-action-chip"
          data-quick-action={action.id}
          title={action.prompt}
          onClick={() => onSeed(action.prompt)}
          // The M4 thread-chip token recipe (§4.4/§10): pill, elevated,
          // border-subtle — tokens only (law #8).
          className="h-8 shrink-0 rounded-pill border border-border bg-elevated px-3 text-body-s text-secondary transition-colors duration-120 hover:border-border-strong hover:text-primary"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
