"use client";

/**
 * `ChatCollapsedPill` — the collapsed chat affordance (M4-E slice of Seam
 * 7, pinned in docs/phases/M4-SEAMS.md "Wave-2 UI contract"). Shown by M4-J
 * ONLY while `layout.mode === "collapsed"` (the panel itself renders
 * `null` there). Click/keyboard → `onExpand` (M4-J restores the previous
 * mode + geometry through the layout store).
 *
 * - bottom-right 36px pill (pinned; ECUX §2.3's right-edge-center variant
 *   is superseded by the pinned Wave-2 contract);
 * - sparkle mark instead of an avatar (ECUX §10 — no avatars, no raw hex);
 * - while streaming: a signal dot with the §6.3 agent pulse
 *   (`animate-pulse-dot` — CSS-only, tokens-only);
 * - tooltip "Agent" via the design-system tooltip (a tooltip is never the
 *   only accessible name — the button carries `aria-label` itself);
 * - z-[35]: above editor-host chrome (z-20 banners, z-30 project bar),
 *   below the blocking z-40 boot/failure/conflict overlays — see panel.tsx
 *   for the full stacking map.
 */

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@studio/ui";
import { Sparkles } from "lucide-react";
import type { ReactElement } from "react";

export interface ChatCollapsedPillProps {
  onExpand(): void;
  streaming: boolean;
}

export function ChatCollapsedPill({ onExpand, streaming }: ChatCollapsedPillProps): ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Agent"
            data-testid="chat-collapsed-pill"
            data-streaming={streaming}
            onClick={onExpand}
            className="absolute right-4 bottom-4 z-[35] flex h-9 w-9 items-center justify-center rounded-pill border border-border bg-panel text-signal shadow-pop transition-colors duration-120 ease-out hover:bg-elevated hover:text-signal-hover"
          >
            <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
            {streaming ? (
              <span
                data-testid="chat-pill-streaming-dot"
                aria-hidden="true"
                className="animate-pulse-dot absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-signal"
              />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent>Agent</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
