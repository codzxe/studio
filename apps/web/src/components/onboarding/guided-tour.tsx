// components/onboarding/guided-tour.tsx — spotlight overlay for the
// 3-tooltip tour: composer → timeline → layers (§19 Phase 4).
//
// CONTRACT (pages must add):
//   - Put data-tour="composer" on the composer box on /compose
//   - Put data-tour="timeline" on the run timeline on /runs/[id]
//   - Put data-tour="layers"  on the layers tree in the document editor
//   - Mount <GuidedTour /> on those routes (or once in the app layout) —
//     persisted state lets the tour resume across client-side navigation.
//
// Positioning is pure CSS: fixed-position rectangles computed from the
// target's bounding box (tour-model.ts) — no positioning library. The tour
// is fully keyboard accessible (Esc dismisses, ←/→ navigate, focus is trapped
// in the tooltip and restored on close) and its dismissal persists.

"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { getBrowserStorage, type SafeStorage } from "./onboarding-storage";
import {
  DEFAULT_TOUR_STEPS,
  TARGET_POLL_MS,
  boxFromRect,
  computeSpotlightLayout,
  readTourState,
  writeTourState,
  type Box,
  type SpotlightLayout,
  type TourStepDef,
  type TourState,
} from "./tour-model";

export interface GuidedTourProps {
  /** Defaults to the composer → timeline → layers steps. */
  steps?: readonly TourStepDef[];
  storage?: SafeStorage | null;
  /** Start when no tour has ever run (default true). */
  autoStart?: boolean;
  /** "always": also restart after a finished/dismissed tour (a "Show me around" button). */
  startPolicy?: "auto" | "always";
  /** Fired when the tour ends, one way or the other. */
  onFinish?: (outcome: "completed" | "dismissed") => void;
  className?: string;
}

function boxStyle(box: Box): CSSProperties {
  return {
    position: "fixed",
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
  };
}

export function GuidedTour({
  steps = DEFAULT_TOUR_STEPS,
  storage,
  autoStart = true,
  startPolicy = "auto",
  onFinish,
  className = "",
}: GuidedTourProps) {
  const store = useMemo<SafeStorage | null>(
    () => (storage !== undefined ? storage : getBrowserStorage()),
    [storage],
  );

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<SpotlightLayout | null>(null);
  const [targetFound, setTargetFound] = useState(false);

  const startedRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const skipRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const finishRef = useRef(onFinish);
  useEffect(() => {
    finishRef.current = onFinish;
  }, [onFinish]);

  // Mount: resume an in-flight tour, or start one if allowed.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (steps.length === 0) return;
    const persisted = readTourState(store);
    const resume = (stepIndex: number) => {
      setIndex(Math.min(stepIndex, steps.length - 1));
      setOpen(true);
    };
    if (persisted.status === "active") {
      resume(persisted.stepIndex);
    } else if (autoStart || startPolicy === "always") {
      writeTourState(store, {
        status: "active",
        stepIndex: 0,
        dismissedAt: persisted.dismissedAt,
        completedAt: persisted.completedAt,
      });
      resume(0);
    }
  }, [autoStart, startPolicy, steps.length, store]);

  const dismiss = useCallback(() => {
    const prev = readTourState(store);
    const next: TourState = {
      status: "done",
      stepIndex: 0,
      dismissedAt: Date.now(),
      completedAt: prev.completedAt,
    };
    writeTourState(store, next);
    setOpen(false);
    finishRef.current?.("dismissed");
  }, [store]);

  const advance = useCallback(() => {
    if (index >= steps.length - 1) {
      writeTourState(store, {
        status: "done",
        stepIndex: index,
        dismissedAt: null,
        completedAt: Date.now(),
      });
      setOpen(false);
      finishRef.current?.("completed");
      return;
    }
    const next = index + 1;
    writeTourState(store, {
      status: "active",
      stepIndex: next,
      dismissedAt: null,
      completedAt: null,
    });
    setIndex(next);
  }, [index, steps.length, store]);

  const back = useCallback(() => {
    const prev = Math.max(0, index - 1);
    writeTourState(store, {
      status: "active",
      stepIndex: prev,
      dismissedAt: null,
      completedAt: null,
    });
    setIndex(prev);
  }, [index, store]);

  // Measure the spotlight: re-query the target so late-mounting elements are
  // picked up (poll until found), and re-measure on any resize/scroll.
  useEffect(() => {
    if (!open) return;
    const step = steps.at(index);
    if (!step) return;
    let stopped = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const measure = () => {
      if (stopped) return;
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      setTargetFound(el !== null);
      setLayout(
        computeSpotlightLayout(
          el ? boxFromRect(el.getBoundingClientRect()) : null,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
      if (el && poll) {
        clearInterval(poll);
        poll = null;
      }
    };
    measure();
    const foundInitially = document.querySelector(`[data-tour="${step.target}"]`) !== null;
    if (!foundInitially) poll = setInterval(measure, TARGET_POLL_MS);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      stopped = true;
      if (poll) clearInterval(poll);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, index, steps]);

  // Focus management: focus the primary button on open/step change, restore
  // focus to the pre-tour element on close.
  useEffect(() => {
    if (open) {
      if (restoreFocusRef.current === null) {
        restoreFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      nextRef.current?.focus();
      return;
    }
    restoreFocusRef.current?.focus();
    restoreFocusRef.current = null;
  }, [open, index]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      advance();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      back();
      return;
    }
    if (event.key === "Tab") {
      const first = skipRef.current;
      const last = nextRef.current;
      if (!first || !last) return;
      event.preventDefault();
      if (event.shiftKey) {
        (document.activeElement === first ? last : first).focus();
      } else {
        (document.activeElement === last ? first : last).focus();
      }
    }
  };

  if (!open) return null;

  const step = steps.at(index);
  if (!step || !layout) return null;

  const isLast = index >= steps.length - 1;
  const titleId = `guided-tour-${step.target}-title`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
      className={`fixed inset-0 z-[80] ${className}`}
    >
      <div aria-hidden="true" className="absolute inset-0">
        <div style={boxStyle(layout.shades.top)} className="bg-zinc-950/60" />
        <div style={boxStyle(layout.shades.right)} className="bg-zinc-950/60" />
        <div style={boxStyle(layout.shades.bottom)} className="bg-zinc-950/60" />
        <div style={boxStyle(layout.shades.left)} className="bg-zinc-950/60" />
      </div>
      {targetFound ? (
        <div
          aria-hidden="true"
          style={boxStyle(layout.hole)}
          className="pointer-events-none fixed rounded-lg ring-2 ring-amber-400/90 transition-all duration-200 motion-reduce:transition-none"
        />
      ) : null}
      <div
        style={{
          position: "fixed",
          top: layout.tooltip.top,
          left: layout.tooltip.left,
          width: layout.tooltip.width,
        }}
        className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        {layout.tooltip.arrow === "up" ? (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-white dark:bg-zinc-900"
          />
        ) : null}
        {layout.tooltip.arrow === "down" ? (
          <span
            aria-hidden="true"
            className="absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-white dark:bg-zinc-900"
          />
        ) : null}
        <p id={titleId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {step.title}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          {step.body}
        </p>
        {!targetFound ? (
          <div className="mt-2">
            <Link
              href={step.href}
              className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 transition-colors hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
            >
              {step.linkLabel}
              <span aria-hidden="true">→</span>
            </Link>
            <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
              The tour picks back up on that page.
            </p>
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
            {index + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              ref={skipRef}
              type="button"
              onClick={dismiss}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              Skip tour
            </button>
            <button
              ref={nextRef}
              type="button"
              onClick={advance}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
