"use client";

/**
 * <AriaLive> (W8-S) — screen-reader announcement region for async UI: toasts,
 * SSE run-status lines, background saves. Wrap the message content; content
 * changes are announced per `politeness`:
 *
 *   <AriaLive politeness="polite">{runStatus}</AriaLive>
 *   <AriaLive politeness="assertive">{errorMessage}</AriaLive>
 *
 * - "polite" (default) waits for the reader to idle — status/toasts.
 * - "assertive" interrupts — errors that block the user's work.
 *
 * Mount the region eagerly and stream content into it: regions created at the
 * same instant as their first message can be missed by some screen readers.
 * To clear, render no children. The region is visually hidden but never
 * `display:none` (hidden regions are never announced) — see
 * lib/a11y/a11y-checklist.md for the full page contract.
 */

import type { CSSProperties, ReactNode } from "react";

/** Visually-hidden style for screen-reader-only regions (never display:none). */
export const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: "0",
  margin: "-1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: "0",
};

export type AriaLivePoliteness = "polite" | "assertive";

export type AriaLiveProps = {
  /** aria-live politeness; default "polite". */
  politeness?: AriaLivePoliteness;
  /**
   * Announce the region as a whole on change (default true — status lines
   * replace their text rather than append to it).
   */
  atomic?: boolean;
  /** aria-relevant; omit for the browser default ("additions text"). */
  relevant?: "additions" | "additions text" | "all" | "removals" | "text";
  /** Optional id — hook point for tests and aria-details references. */
  id?: string;
  /** The announced content; null/undefined clears without announcing. */
  children?: ReactNode;
};

export function AriaLive({
  politeness = "polite",
  atomic = true,
  relevant,
  id,
  children,
}: AriaLiveProps) {
  return (
    <div
      aria-live={politeness}
      aria-atomic={atomic}
      aria-relevant={relevant}
      id={id}
      style={VISUALLY_HIDDEN_STYLE}
    >
      {children}
    </div>
  );
}
