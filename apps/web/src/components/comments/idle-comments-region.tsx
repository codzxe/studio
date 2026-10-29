"use client";

/**
 * IdleCommentsRegion (round-13 LCP/INP fix) — the page-level comments slot
 * behind a post-load idle deferral.
 *
 * WHY: the comments region (toggle + slide-over panel) was statically
 * imported by the editor RSC page, which pulled ~160KB of chunks (the panel
 * UI, Radix tooltips, its api-client usage) into the editor route's critical
 * path. Those chunks competed for the main thread with React hydration and
 * the engine boot — the DevTools trace showed 229ms of Compile Script tasks
 * and 93ms/78ms long tasks delaying the LCP paint. Comments are secondary
 * chrome (a slide-over opened by a button): they mount once the browser has
 * finished loading the page, and the toggle appears a beat later.
 *
 * ROUND-13 TAIL — the deferral is now gated behind the WINDOW LOAD EVENT,
 * not just requestIdleCallback. Field trace (4x-throttled machine): the
 * comments chunk (21KB) evaluated for 40ms INSIDE the LCP render-delay
 * window — `requestIdleCallback` with no timeout fires in the first idle
 * gap, and on a slow machine those gaps open while eager scripts are still
 * compiling/evaluating and the LCP element has not painted yet. Scheduling
 * the import only after `load` guarantees every eager script on the route
 * has finished evaluating first, so the comments import can never compete
 * with the LCP paint or first hydration pass. Once scheduled it still rides
 * requestIdleCallback (3s timeout so it always lands) or a 1.5s timer on
 * engines without rIC.
 *
 * The wrapper owns NO product behavior — every prop passes straight through
 * to the real `CommentsRegion` (M7-F semantics unchanged; its own tests
 * cover it directly). A failed dynamic import just leaves the slot empty:
 * the region is optional chrome and must never break the editor page.
 */

import { type ComponentType, type ReactElement, useEffect, useState } from "react";

import type { CommentsRegionProps } from "./comments-region";

/** rIC delivery deadline once scheduled (ms) — idle usually beats it. */
const IDLE_TIMEOUT_MS = 3000;
/** Idle fallback for engines without requestIdleCallback (older Safari). */
const FALLBACK_IDLE_TIMEOUT_MS = 1500;

export function IdleCommentsRegion(props: CommentsRegionProps): ReactElement | null {
  const [Region, setRegion] = useState<ComponentType<CommentsRegionProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Cancellation for whichever stage is currently pending: the load
    // listener (pre-load), the idle callback (post-load, rIC engines) or the
    // fallback timer (post-load, non-rIC engines).
    let cancelScheduled: (() => void) | null = null;

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

    const scheduleIdle = (): void => {
      const idle = (
        window as Window & {
          requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
        }
      ).requestIdleCallback;
      if (typeof idle === "function") {
        const handle = idle(load, { timeout: IDLE_TIMEOUT_MS });
        cancelScheduled = () => {
          (
            window as Window & {
              cancelIdleCallback?: (handle: number) => void;
            }
          ).cancelIdleCallback?.(handle);
        };
        return;
      }
      const timer = setTimeout(load, FALLBACK_IDLE_TIMEOUT_MS);
      cancelScheduled = () => {
        clearTimeout(timer);
      };
    };

    if (document.readyState === "complete") {
      // Everything on the route already evaluated (also the jsdom test
      // environment, where readyState is "complete" from the start).
      scheduleIdle();
    } else {
      // Still loading: the import must NOT be schedulable before the last
      // eager script has evaluated — hence the load-event gate.
      const onLoad = (): void => {
        scheduleIdle();
      };
      window.addEventListener("load", onLoad, { once: true });
      cancelScheduled = () => {
        window.removeEventListener("load", onLoad);
      };
    }

    return () => {
      cancelled = true;
      cancelScheduled?.();
    };
  }, []);

  if (Region === null) return null;
  return <Region {...props} />;
}
