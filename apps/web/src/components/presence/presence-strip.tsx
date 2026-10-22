"use client";

/**
 * `PresenceStrip` — the who-is-here chrome (BUILD_PLAN §M7 task 2; §11
 * "who is viewing"): a compact row of initials avatars for the active
 * viewers, floating OVER the editor (additive chrome only — D-18: the
 * editor itself is never restyled, injected into or occluded; the strip
 * auto-hides when nobody is viewing).
 *
 * Data comes from the shared poller (`./use-presence`) — the beat response
 * IS the viewers list, so this component is a pure view: names as DATA
 * (law #1: React escapes text; long names truncate; no ids in copy), self
 * flag + comp chip from the wire (`PresenceViewer`), "last seen" derived
 * from `lastSeenAgoMs` against `PRESENCE_TTL_MS`.
 */

import type { PresenceViewer } from "@studio/contracts";
import {
  Avatar,
  Badge,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@studio/ui";
import { cn } from "@studio/ui";
import type { ReactNode } from "react";

export interface PresenceStripProps {
  /** The active viewers from the last beat (self entry included). */
  readonly viewers: readonly PresenceViewer[];
  /** Max avatars before the "+N" overflow (default 4). */
  readonly maxDots?: number;
  /** Positioning/extra classes for the floating root. */
  readonly className?: string;
}

/** "last seen" copy from the wire's `lastSeenAgoMs` (fresh entries read "just now"). */
function lastSeenLabel(lastSeenAgoMs: number): string {
  if (lastSeenAgoMs < 10_000) return "just now";
  const seconds = Math.ceil(lastSeenAgoMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m ago`;
}

/** The viewer's active comp chip (their client's choice of id/name; data only). */
function compChip(viewer: PresenceViewer): ReactNode {
  if (viewer.compId === null || viewer.compId === "") return null;
  const label = viewer.compId.length > 18 ? `${viewer.compId.slice(0, 17)}…` : viewer.compId;
  return (
    <span
      data-testid="presence-viewer-comp"
      className="max-w-32 truncate rounded-xs border border-border bg-input px-1 text-hint text-secondary"
    >
      {label}
    </span>
  );
}

function viewerTooltip(viewer: PresenceViewer): ReactNode {
  return (
    <span className="flex flex-col gap-1">
      <span className="max-w-48 truncate font-medium" data-testid="presence-viewer-name">
        {viewer.displayName}
      </span>
      {viewer.self ? (
        <span className="text-hint text-muted">You</span>
      ) : (
        <span className="text-hint text-muted">seen {lastSeenLabel(viewer.lastSeenAgoMs)}</span>
      )}
      {compChip(viewer)}
    </span>
  );
}

export function PresenceStrip({ viewers, maxDots = 4, className }: PresenceStripProps) {
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, maxDots);
  const overflow = viewers.length - shown.length;

  return (
    <output
      data-testid="presence-strip"
      data-viewer-count={viewers.length}
      aria-label={
        viewers.length === 1 ? "1 person is viewing" : `${viewers.length} people are viewing`
      }
      className={cn(
        "pointer-events-none absolute top-3 right-3 z-20 flex items-center gap-1",
        className,
      )}
    >
      <TooltipProvider>
        {shown.map((viewer) => (
          <Tooltip key={viewer.userId}>
            <TooltipTrigger asChild>
              <span
                data-testid="presence-viewer"
                data-self={viewer.self ? "true" : "false"}
                className="pointer-events-auto block"
              >
                <Avatar
                  name={viewer.displayName}
                  size="sm"
                  className={cn(
                    "shadow-pop",
                    viewer.self ? "border-signal text-primary" : "border-border",
                  )}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{viewerTooltip(viewer)}</TooltipContent>
          </Tooltip>
        ))}
        {overflow > 0 ? (
          <Badge data-testid="presence-overflow" variant="neutral" className="pointer-events-auto">
            +{overflow}
          </Badge>
        ) : null}
      </TooltipProvider>
    </output>
  );
}
