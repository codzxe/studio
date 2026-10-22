"use client";

/**
 * Context strip (M4-H, EDITOR_CHAT_UX §3.2) — the single-line, horizontally
 * scrollable chip row under the chat header showing exactly what will be sent
 * with the next message.
 *
 * - One removable chip per ACTIVE context block (`[✓ label]` + ✕ →
 *   `onRemoveBlock(kind)`). Removed blocks are ABSENT: the parent passes only
 *   active blocks (trust props — this component keeps no removal state).
 * - Pinned chips (§5.2, optional `pinned` prop) render with their kind glyph
 *   and are display-only here — the Context popover owns pinned removal.
 * - `+` chip → `onAddContext()` (M4-J opens the Context popover from it).
 * - Below 480px container width (ResizeObserver) the strip collapses to a
 *   `Context N` summary (N = blocks + pinned); with no measurement yet it
 *   stays expanded (the observer fires on mount in real browsers).
 * - Renders `null` when there are no blocks AND no pinned items.
 * - `totalTokenEstimate` is surfaced through the list's accessible name
 *   (the popover shows per-block estimates; §5.3).
 *
 * `block.data` is untrusted project state (context.ts contract): this
 * component renders `label` only and never touches `data`.
 */

import type { ContextBlock } from "@/lib/chat/context";
import { formatTokenEstimate } from "@/lib/chat/tokens";
import type { ContextSelection, PinnedContextItem, PinnedContextKind } from "@studio/contracts";
import {
  TOOLTIP_DELAY_MS,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@studio/ui";
import { Check, Plus, X } from "lucide-react";
import { type ReactElement, type RefObject, useEffect, useRef, useState } from "react";

/**
 * Pinned chip glyphs (§5.2). Mirrored in context-popover.tsx — M4-H owns
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

/** §3.2: below this container width the strip collapses to "Context N". */
const STRIP_NARROW_WIDTH = 480;

export interface ContextStripProps {
  /** Active auto-context blocks (one per enabled flag, collector labels). */
  readonly blocks: readonly ContextBlock[];
  /** `snapshot.totalTokenEstimate` — surfaced via the strip's accessible name. */
  readonly totalTokenEstimate: number;
  /** Remove one block from the next message's context (the ✕ on a chip). */
  onRemoveBlock(kind: keyof ContextSelection): void;
  /** Open the context picker/popover (the trailing `+` chip). */
  onAddContext(): void;
  /**
   * Pinned chips (§5.2), optional. Display-only in the strip (pinned removal
   * lives in the Context popover); when omitted the strip shows blocks only.
   */
  readonly pinned?: readonly PinnedContextItem[];
}

/**
 * Track the strip element's width so the §3.2 narrow collapse is driven by the
 * real container (panel width, not viewport). Unknown width (no measurement
 * yet, or no ResizeObserver) keeps the expanded chips.
 */
function useStripWidth(): { ref: RefObject<HTMLUListElement | null>; width: number | null } {
  const ref = useRef<HTMLUListElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function ContextStrip({
  blocks,
  totalTokenEstimate,
  onRemoveBlock,
  onAddContext,
  pinned = [],
}: ContextStripProps): ReactElement | null {
  const { ref, width } = useStripWidth();
  const count = blocks.length + pinned.length;
  // §3.2/§5.1: nothing active and nothing pinned → the strip is absent.
  if (count === 0) return null;

  const narrow = width !== null && width < STRIP_NARROW_WIDTH;
  const ariaLabel = `Chat context, ${formatTokenEstimate(totalTokenEstimate)} total`;
  const totalTitle = `${formatTokenEstimate(totalTokenEstimate)} total`;

  if (narrow) {
    // Collapsed form: a single summary chip keeping the picker reachable.
    return (
      <ul
        ref={ref}
        data-testid="context-strip"
        aria-label={ariaLabel}
        className="flex h-8 w-full items-center px-2"
      >
        <li className="shrink-0">
          <button
            type="button"
            data-testid="context-strip-summary"
            onClick={onAddContext}
            title={totalTitle}
            className="inline-flex h-6 shrink-0 items-center rounded-sm border border-subtle bg-input px-2 text-body-s text-secondary transition-colors duration-120 ease-out hover:border-strong hover:text-primary"
          >
            Context {count}
          </button>
        </li>
      </ul>
    );
  }

  return (
    <ul
      ref={ref}
      data-testid="context-strip"
      aria-label={ariaLabel}
      className="flex h-8 w-full items-center gap-1 overflow-x-auto px-2 scrollbar-thin"
    >
      <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
        {blocks.map((block) => (
          <li key={block.kind} className="shrink-0">
            <BlockChip block={block} onRemove={() => onRemoveBlock(block.kind)} />
          </li>
        ))}
        {pinned.map((item, index) => (
          <li key={`${item.kind}-${index}`} className="shrink-0">
            <PinnedChip item={item} index={index} />
          </li>
        ))}
        <li className="shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="context-strip-add"
                aria-label="Add context"
                onClick={onAddContext}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-dashed border-subtle text-muted transition-colors duration-120 ease-out hover:border-strong hover:text-primary"
              >
                <Plus size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add context to this message</TooltipContent>
          </Tooltip>
        </li>
      </TooltipProvider>
    </ul>
  );
}

/** `[✓ label]` with a full-height ✕ — one chip per active block. */
function BlockChip({ block, onRemove }: { block: ContextBlock; onRemove: () => void }) {
  return (
    <span
      data-testid={`context-chip-${block.kind}`}
      className="inline-flex h-6 items-center gap-1 rounded-sm border border-subtle bg-elevated pl-1.5 text-body-s text-secondary"
    >
      <Check size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-muted" />
      <span className="whitespace-nowrap">{block.label}</span>
      <button
        type="button"
        data-testid={`context-chip-remove-${block.kind}`}
        aria-label={`Remove ${block.label} from context`}
        onClick={onRemove}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted transition-colors duration-120 ease-out hover:bg-input hover:text-danger"
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </span>
  );
}

/** Pinned chip — kind glyph + label, display-only in the strip (§5.2). */
function PinnedChip({ item, index }: { item: PinnedContextItem; index: number }) {
  return (
    <span
      data-testid={`context-pinned-${index}`}
      title="Pinned context — remove it from the context popover"
      className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-signal/30 bg-signal/10 px-1.5 text-body-s text-signal"
    >
      <span aria-hidden="true" className="text-caption leading-none">
        {PINNED_GLYPHS[item.kind]}
      </span>
      <span className="whitespace-nowrap">{item.label}</span>
    </span>
  );
}
