"use client";

/**
 * Context popover (M4-H, EDITOR_CHAT_UX §5.3) — "Context for this message":
 * shows exactly what will be sent with the next message, with ~token
 * estimates, and lets the user trim it before sending.
 *
 * - One row per passed block: checkbox + label + `~N tokens`
 *   (`formatTokenEstimate(block.tokenEstimate)` — never re-formatted here).
 *   The lazy frame block (`currentFrame`, `data === undefined`) shows
 *   "1 image" instead of a token estimate (it renders on demand, §5.1).
 * - Rows start checked (the parent passes active blocks) and toggle
 *   optimistically: `onToggleBlock(kind, on)` fires immediately and the row
 *   stays visible (unchecked) until the parent stops passing the block — so
 *   on↔off is instant and reversible within one open popover. Pending
 *   unchecks are pruned on every props change (re-added blocks come back
 *   checked — parent state is the truth, this state is only presentation).
 * - Optional pinned section (§5.2): chips with their kind glyph + ✕ calling
 *   `onRemovePinned(index)`. Display-only when `onRemovePinned` is omitted.
 * - Footer: `~N tokens total` + [Remove all] (quiet) + [Done] (primary).
 * - Esc and outside/overlay click dismiss (→ `onDone`). Focus is trapped
 *   inside the popover while open (Radix modal popover), and the first
 *   focusable row receives initial focus. Esc is stopped here so a panel
 *   listener never collapses the chat on the same keystroke (§9 ordering:
 *   popovers close first).
 *
 * MOUNTING CONTRACT (M4-J): render this as a child of the chat panel's
 * positioned root, next to the strip. The anchor span pins the card to the
 * panel's top-right (below the 48px header, 12px inset) and Radix portals +
 * collision-flips the card from there. `block.data` is untrusted project
 * state — only labels and estimates are ever rendered.
 */

import type { ContextBlock } from "@/lib/chat/context";
import { formatTokenEstimate } from "@/lib/chat/tokens";
import type { ContextSelection, PinnedContextItem, PinnedContextKind } from "@studio/contracts";
import { Badge, Button, Popover, PopoverAnchor, PopoverContent } from "@studio/ui";
import { X } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";

/**
 * Pinned chip glyphs (§5.2). Mirrored in context-strip.tsx — M4-H owns
 * exactly two component files, so a shared module would need a third path.
 * Keep both maps in sync.
 */
const PINNED_GLYPHS: Record<PinnedContextKind, string> = {
  frame: "▣",
  selection: "◉",
  composition: "▤",
  asset: "⬡",
  comment: "✎",
};

export interface ContextPopoverProps {
  /** Active auto-context blocks (one row each, all rendered checked). */
  readonly blocks: readonly ContextBlock[];
  /** `snapshot.totalTokenEstimate` — the footer's `~N tokens total` line. */
  readonly totalTokenEstimate: number;
  /** Toggle one block on/off for the next message (row checkbox). */
  onToggleBlock(kind: keyof ContextSelection, on: boolean): void;
  /** Uncheck every block at once (footer button). */
  onRemoveAll(): void;
  /** Dismiss the popover (Done, Esc, outside/overlay click). */
  onDone(): void;
  /** Pinned chips (§5.2), optional — rendered as their own section. */
  readonly pinned?: readonly PinnedContextItem[];
  /** Remove one pinned chip by index (its ✕). Optional: chips without it are display-only. */
  onRemovePinned?(index: number): void;
}

export function ContextPopover({
  blocks,
  totalTokenEstimate,
  onToggleBlock,
  onRemoveAll,
  onDone,
  pinned = [],
  onRemovePinned,
}: ContextPopoverProps): ReactElement {
  // Optimistic pending-uncheck presentation layer (see file header). Pruned
  // against the incoming kinds so parent state always wins once it lands.
  const [unchecked, setUnchecked] = useState<ReadonlySet<keyof ContextSelection>>(() => new Set());
  const activeKinds = useMemo(() => new Set(blocks.map((block) => block.kind)), [blocks]);
  const pending = useMemo(() => {
    const next = new Set<keyof ContextSelection>();
    for (const kind of unchecked) {
      if (activeKinds.has(kind)) next.add(kind);
    }
    return next;
  }, [unchecked, activeKinds]);

  const toggle = (block: ContextBlock): void => {
    // `pending` = locally unchecked rows: a pending row toggles back ON, a
    // (still checked) row toggles OFF.
    const on = pending.has(block.kind);
    onToggleBlock(block.kind, on);
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(block.kind);
      else next.add(block.kind);
      return next;
    });
  };

  const removeAll = (): void => {
    onRemoveAll();
    setUnchecked(() => new Set(blocks.map((block) => block.kind)));
  };

  return (
    <Popover open modal onOpenChange={(open) => (!open ? onDone() : undefined)}>
      {/* Anchor: panel top-right, just under the header (see mounting contract). */}
      <PopoverAnchor asChild>
        <span aria-hidden="true" className="pointer-events-none absolute top-12 right-3 h-0 w-0" />
      </PopoverAnchor>
      <PopoverContent
        aria-label="Chat context"
        data-testid="context-popover"
        align="end"
        sideOffset={8}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        className="w-72 p-0"
      >
        <div className="p-3 pb-2">
          <div className="text-body-s font-medium text-primary">Context for this message</div>
        </div>

        {pinned.length > 0 ? (
          <div data-testid="context-pinned-list" className="px-3 pb-3">
            <Badge variant="neutral" className="mb-1.5">
              Pinned
            </Badge>
            <div className="flex flex-wrap gap-1.5">
              {pinned.map((item, index) => (
                <span
                  key={`${item.kind}-${index}`}
                  data-testid={`context-pinned-${index}`}
                  className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-signal/30 bg-signal/10 pl-1.5 pr-1 text-body-s text-signal"
                >
                  <span aria-hidden="true" className="text-caption leading-none">
                    {PINNED_GLYPHS[item.kind]}
                  </span>
                  <span className="whitespace-nowrap">{item.label}</span>
                  {onRemovePinned ? (
                    <button
                      type="button"
                      data-testid={`context-pinned-remove-${index}`}
                      aria-label={`Remove ${item.label} from context`}
                      onClick={() => onRemovePinned(index)}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-xs text-muted transition-colors duration-120 ease-out hover:text-danger"
                    >
                      <X size={11} strokeWidth={2} aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <ul className="max-h-72 overflow-y-auto px-3 scrollbar-thin">
          {blocks.map((block) => (
            <li
              key={block.kind}
              data-testid={`context-row-${block.kind}`}
              className="flex items-center gap-2 py-1"
            >
              <input
                type="checkbox"
                checked={!pending.has(block.kind)}
                onChange={() => toggle(block)}
                aria-label={block.label}
                data-testid={`context-toggle-${block.kind}`}
                className="h-4 w-4 shrink-0 rounded-xs accent-signal"
              />
              <span
                className="min-w-0 flex-1 truncate text-body-s text-primary"
                title={block.label}
              >
                {block.label}
              </span>
              <span className="shrink-0 text-caption text-muted">{estimateLabel(block)}</span>
            </li>
          ))}
          {blocks.length === 0 ? (
            <li className="py-1 text-caption text-muted">No context will be sent.</li>
          ) : null}
        </ul>

        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-subtle p-3">
          <span data-testid="context-total" className="text-caption text-secondary">
            {formatTokenEstimate(totalTokenEstimate)} total
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="context-remove-all"
              onClick={removeAll}
            >
              Remove all
            </Button>
            <Button variant="primary" size="sm" data-testid="context-done" onClick={onDone}>
              Done
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * §5.3 estimate column: `~N tokens` via tokens.ts, except the lazy frame
 * block (rendered on demand by the tool executor → `data` undefined) which
 * reports "1 image". Never re-formats; never reads `data` beyond definedness.
 */
function estimateLabel(block: ContextBlock): string {
  if (block.kind === "currentFrame" && block.data === undefined) return "1 image";
  return formatTokenEstimate(block.tokenEstimate);
}
