"use client";

/**
 * IdleCommentsRegion (round-13 LCP/INP fix) — the page-level comments slot
 * behind an idle deferral.
 *
 * WHY: the comments region (toggle + slide-over panel) was statically
 * imported by the editor RSC page, which pulled ~160KB of chunks (the panel
 * UI, Radix tooltips, its api-client usage) into the editor route's critical
 * path. Those chunks competed for the main thread with React hydration and
 * the engine boot — the DevTools trace showed 229ms of Compile Script tasks
 * and 93ms/78ms long tasks delaying the LCP paint. Comments are secondary
 * chrome (a slide-over opened by a button): they mount when the browser goes
 * idle after first paint, and the toggle appears a beat later.
 *
 * The wrapper owns NO product behavior — every prop passes straight through
 * to the real `CommentsRegion` (M7-F semantics unchanged; its own tests
 * cover it directly). A failed dynamic import just leaves the slot empty:
 * the region is optional chrome and must never break the editor page.
 */

import { type ComponentType, type ReactElement, useEffect, useState } from "react";

import type { CommentsRegionProps } from "./comments-region";

/** Idle fallback for engines without requestIdleCallback (older Safari). */
const FALLBACK_IDLE_TIMEOUT_MS = 1500;

export function IdleCommentsRegion(props: CommentsRegionProps): ReactElement | null {
  const [Region, setRegion] = useState<ComponentType<CommentsRegionProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void import("./comments-region").then(
        (module) => {
          if (!cancelled) setRegion(() => module.CommentsRegion);
        },
        () => {
          // Optional chrome: a failed load leaves the slot empty, silently.
        },
      );
    };
    const idle = (
      window as Window & {
        requestIdleCallback?: (callback: () => void) => number;
        cancelIdleCallback?: (handle: number) => void;
      }
    ).requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(load);
      return () => {
        cancelled = true;
        (window as Window & { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback?.(
          handle,
        );
      };
    }
    const timer = setTimeout(load, FALLBACK_IDLE_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (Region === null) return null;
  return <Region {...props} />;
}
