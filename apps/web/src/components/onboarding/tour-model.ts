// components/onboarding/tour-model.ts — pure model for the guided spotlight
// tour (§19 Phase 4 onboarding): 3 tooltips (composer → timeline → layers),
// persisted state so the tour survives cross-page navigation, and pure CSS
// positioning math — the overlay is plain fixed-position rectangles computed
// from the target's data-tour bounding box; no positioning library.

import type { SafeStorage } from "./onboarding-storage";

export const TOUR_STORAGE_KEY = "onboarding.tour.v1";

/** Pages must add these attributes; see README.md for the mount contract. */
export const TOUR_TARGET_IDS = ["composer", "timeline", "layers"] as const;

export type TourTargetId = (typeof TOUR_TARGET_IDS)[number];

export interface TourStepDef {
  /** Matches the data-tour attribute the host page puts on the target box. */
  readonly target: TourTargetId;
  readonly title: string;
  readonly body: string;
  /** Route where the target lives — used when the target isn't on this page. */
  readonly href: string;
  readonly linkLabel: string;
}

export const DEFAULT_TOUR_STEPS: readonly TourStepDef[] = [
  {
    target: "composer",
    title: "Describe what you want",
    body: "Type one sentence — headline, mood, the photo you want. The agent turns it into a full layered layout.",
    href: "/compose",
    linkLabel: "Open the composer",
  },
  {
    target: "timeline",
    title: "Watch it build",
    body: "Every step streams here — the plan, the edits, live previews. One undo reverts a whole run.",
    // The timeline lives on the run page (/runs/[id]); the fallback link
    // starts a run, which is how you get there.
    href: "/compose",
    linkLabel: "Start a run",
  },
  {
    target: "layers",
    title: "Everything stays editable",
    body: "Real layers and groups — click any element to tweak it, then export a PNG or the layered file.",
    href: "/documents",
    linkLabel: "Open a document",
  },
];

export type TourStatus = "idle" | "active" | "done";

export interface TourState {
  readonly status: TourStatus;
  readonly stepIndex: number;
  readonly dismissedAt: number | null;
  readonly completedAt: number | null;
}

export const INITIAL_TOUR_STATE: TourState = {
  status: "idle",
  stepIndex: 0,
  dismissedAt: null,
  completedAt: null,
};

/** Guarded parse: junk degrades to the initial state, never throws. */
export function parseTourState(raw: string | null): TourState {
  if (raw === null) return INITIAL_TOUR_STATE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return INITIAL_TOUR_STATE;
    }
    const source = parsed as Record<string, unknown>;
    const status: TourStatus =
      source.status === "active" || source.status === "done" ? source.status : "idle";
    const rawIndex = source.stepIndex;
    const stepIndex =
      typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0
        ? rawIndex
        : 0;
    const ts = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      status,
      stepIndex,
      dismissedAt: ts(source.dismissedAt),
      completedAt: ts(source.completedAt),
    };
  } catch {
    return INITIAL_TOUR_STATE;
  }
}

export function serializeTourState(state: TourState): string {
  return JSON.stringify(state);
}

export function readTourState(storage: SafeStorage | null): TourState {
  return parseTourState(storage?.getItem(TOUR_STORAGE_KEY) ?? null);
}

export function writeTourState(
  storage: SafeStorage | null,
  state: TourState,
): void {
  storage?.setItem(TOUR_STORAGE_KEY, serializeTourState(state));
}

// ---------------------------------------------------------------------------
// Spotlight geometry (pure; the component only feeds in a measured box)
// ---------------------------------------------------------------------------

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export const TOOLTIP_WIDTH = 320;
/** Enough room for a ~6-line tooltip; used for above/below placement only. */
export const TOOLTIP_EST_HEIGHT = 170;
export const TOOLTIP_GAP = 12;
export const VIEWPORT_PADDING = 16;
/** Poll interval while a target hasn't appeared on the page yet. */
export const TARGET_POLL_MS = 1200;

export type TooltipArrow = "up" | "down" | "none";

export interface SpotlightLayout {
  /** Four fixed-position dim rectangles that leave the hole see-through. */
  readonly shades: {
    readonly top: Box;
    readonly right: Box;
    readonly bottom: Box;
    readonly left: Box;
  };
  readonly hole: Box;
  readonly tooltip: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly arrow: TooltipArrow;
  };
}

function clamp(value: number, min: number, max: number): number {
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, min), upper);
}

function zeroBox(): Box {
  return { top: 0, left: 0, width: 0, height: 0 };
}

function fullBox(viewport: Viewport): Box {
  return { top: 0, left: 0, width: viewport.width, height: viewport.height };
}

/** Viewport-relative box for an element (the overlay is position:fixed). */
export function boxFromRect(rect: DOMRect): Box {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * Compute the spotlight geometry. `target === null` (target not on this page)
 * dims the whole viewport and centers the tooltip. Partially off-screen
 * targets are clamped so the shades never invert.
 */
export function computeSpotlightLayout(
  target: Box | null,
  viewport: Viewport,
): SpotlightLayout {
  const tooltipWidth = clamp(
    Math.min(TOOLTIP_WIDTH, viewport.width - VIEWPORT_PADDING * 2),
    1,
    Math.max(1, viewport.width - VIEWPORT_PADDING * 2),
  );

  if (target === null) {
    return {
      shades: {
        top: fullBox(viewport),
        right: zeroBox(),
        bottom: zeroBox(),
        left: zeroBox(),
      },
      hole: zeroBox(),
      tooltip: {
        top: clamp(
          (viewport.height - TOOLTIP_EST_HEIGHT) / 2,
          VIEWPORT_PADDING,
          Math.max(VIEWPORT_PADDING, viewport.height - TOOLTIP_EST_HEIGHT - VIEWPORT_PADDING),
        ),
        left: clamp(
          (viewport.width - tooltipWidth) / 2,
          VIEWPORT_PADDING,
          Math.max(VIEWPORT_PADDING, viewport.width - tooltipWidth - VIEWPORT_PADDING),
        ),
        width: tooltipWidth,
        arrow: "none",
      },
    };
  }

  const left = clamp(target.left, 0, viewport.width);
  const top = clamp(target.top, 0, viewport.height);
  const right = clamp(target.left + target.width, 0, viewport.width);
  const bottom = clamp(target.top + target.height, 0, viewport.height);
  const hole: Box = {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };

  const shadeTop: Box = { top: 0, left: 0, width: viewport.width, height: hole.top };
  const shadeBottom: Box = {
    top: hole.top + hole.height,
    left: 0,
    width: viewport.width,
    height: Math.max(0, viewport.height - (hole.top + hole.height)),
  };
  const shadeLeft: Box = {
    top: hole.top,
    left: 0,
    width: hole.left,
    height: hole.height,
  };
  const shadeRight: Box = {
    top: hole.top,
    left: hole.left + hole.width,
    width: Math.max(0, viewport.width - (hole.left + hole.width)),
    height: hole.height,
  };

  const fit = TOOLTIP_EST_HEIGHT + TOOLTIP_GAP + VIEWPORT_PADDING;
  const spaceBelow = viewport.height - (hole.top + hole.height);
  let arrow: TooltipArrow;
  let tooltipTop: number;
  if (spaceBelow >= fit) {
    arrow = "up"; // tooltip sits below the hole, pointing up at it
    tooltipTop = hole.top + hole.height + TOOLTIP_GAP;
  } else if (hole.top >= fit) {
    arrow = "down"; // tooltip sits above the hole, pointing down at it
    tooltipTop = hole.top - TOOLTIP_GAP - TOOLTIP_EST_HEIGHT;
  } else {
    // Cramped screen: park it below with clamping, no arrow.
    arrow = "none";
    tooltipTop = clamp(
      hole.top + hole.height + TOOLTIP_GAP,
      VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, viewport.height - TOOLTIP_EST_HEIGHT - VIEWPORT_PADDING),
    );
  }

  const tooltipLeft = clamp(
    hole.left + hole.width / 2 - tooltipWidth / 2,
    VIEWPORT_PADDING,
    Math.max(VIEWPORT_PADDING, viewport.width - tooltipWidth - VIEWPORT_PADDING),
  );

  return {
    shades: { top: shadeTop, right: shadeRight, bottom: shadeBottom, left: shadeLeft },
    hole,
    tooltip: { top: tooltipTop, left: tooltipLeft, width: tooltipWidth, arrow },
  };
}
