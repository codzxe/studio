// apps/web/src/components/comments — pure comment/pin logic (W8-H).
//
// No React, no DOM, no network: everything here is deterministic and
// unit-tested in comment-utils.test.ts (AGENTS.md: table-driven pure logic,
// <5 s, no network). The React files in this folder (comments-panel.tsx,
// comment-pin.tsx, use-comments.ts) consume these helpers; the README
// repeats the wiring contract for W8-F.
//
// COORDINATE MODEL (defined once, here):
//
//   The DB stores pin positions as CANVAS pixels — `comments.x/y` are int px
//   in the document's canvas space, sized by `documents.width_px/height_px`
//   (packages/db/src/schema/content.ts, §12.1 "comments … x, y … presence-
//   light review"). The overlay renders over the DISPLAYED canvas at any
//   zoom/viewport size, so the only zoom-stable way to position a pin is as a
//   FRACTION of the canvas box, clamped to [0,1], serialized as CSS
//   percentages:
//
//     fraction  f = (pointer − rect.origin) / rect.size     ← pointer math
//     canvas px p = round(f × canvasSize)                   ← wire/DB shape
//     css left%   = f × 100                                 ← pin style
//
//   Round-trip: fractionFromCanvasPoint(canvasPointFromFraction(f)) ≡ f up
//   to int rounding (≤ half a canvas pixel), so pins never drift across
//   zoom, resize or remount. Clamp 0-1 keeps every pin on-canvas even when
//   the pointer leaves the surface or a legacy row overflows the canvas.

/** A point in canvas pixel coordinates — the DB/API wire shape (nonnegative ints). */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/** Canvas size in pixels — `documents.width_px / height_px` (§12.1). */
export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/** Position as a fraction of the canvas box, each axis in [0, 1]. */
export interface PinFraction {
  readonly fx: number;
  readonly fy: number;
}

/** DOMRect subset — decoupled from the DOM so tests feed plain numbers. */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One review comment as the UI holds it (mapped from the wire DTO in
 * use-comments.ts; optimistic stand-ins share the same shape).
 */
export interface CanvasComment {
  readonly id: string;
  readonly authorId: string;
  /** Display name; the gateway is expected to join it server-side (see use-comments.ts). */
  readonly authorName?: string;
  readonly body: string;
  /** Canvas px (not client px) — see the coordinate model above. */
  readonly x: number;
  readonly y: number;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}

/** Hard product cap on a comment body (enforced here, in zod, and in the textarea). */
export const COMMENT_BODY_MAX = 2000;

/** Typed result envelope (AGENTS.md error style) — never thrown. */
export type BodyValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "empty" | "too_long";
      readonly message: string;
    };

/** Validate a composer draft. Whitespace-only is empty; the cap counts raw length. */
export function validateCommentBody(raw: string): BodyValidation {
  if (raw.trim().length === 0) {
    return { ok: false, code: "empty", message: "Write a comment first." };
  }
  if (raw.length > COMMENT_BODY_MAX) {
    return {
      ok: false,
      code: "too_long",
      message: `Comments are limited to ${COMMENT_BODY_MAX} characters.`,
    };
  }
  return { ok: true };
}

/** Clamp to [0, 1]; NaN collapses to 0 (never render a pin at NaN%). */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Pointer event → canvas fraction. `clientX/Y` are CSS px from the pointer
 * event; `rect` is the overlay's bounding rect, which W8-F sizes identically
 * to the displayed canvas, so the ratio is zoom-independent. Degenerate
 * (zero-area) rects collapse to 0 — a pin at the top-left corner, never NaN.
 */
export function fractionFromPointer(
  clientX: number,
  clientY: number,
  rect: RectLike,
): PinFraction {
  const fx = rect.width > 0 ? clamp01((clientX - rect.left) / rect.width) : 0;
  const fy = rect.height > 0 ? clamp01((clientY - rect.top) / rect.height) : 0;
  return { fx, fy };
}

/**
 * Fraction → canvas px (the DB/API shape). Round-to-nearest so a click at
 * mid-canvas lands on the mid pixel; clamp into [0, size] so the stored int
 * is never negative (schema NOT NULL constraint) and never off-canvas.
 * A pin at the extreme edge (x == width) is the point-inclusive edge.
 */
export function canvasPointFromFraction(
  fraction: PinFraction,
  size: CanvasSize,
): CanvasPoint {
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);
  return {
    x: Math.min(width, Math.max(0, Math.round(fraction.fx * width))),
    y: Math.min(height, Math.max(0, Math.round(fraction.fy * height))),
  };
}

/**
 * Canvas px → fraction (render side). Defensively clamps legacy/oversized
 * rows back on-canvas. Degenerate sizes are treated as 1 px, not 0, so the
 * division can never produce NaN/Infinity.
 */
export function fractionFromCanvasPoint(
  point: CanvasPoint,
  size: CanvasSize,
): PinFraction {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  return { fx: clamp01(point.x / width), fy: clamp01(point.y / height) };
}

/** Fraction → CSS `left/top` strings. Three decimals keep sub-pixel drift invisible. */
export function percentStyle(fraction: PinFraction): {
  readonly left: string;
  readonly top: string;
} {
  return {
    left: `${(fraction.fx * 100).toFixed(3)}%`,
    top: `${(fraction.fy * 100).toFixed(3)}%`,
  };
}

/**
 * Thread order: oldest first (a review thread reads top-down; the composer
 * appends at the end). Clone + sort — callers' arrays are never mutated.
 */
export function sortCommentsByCreation(
  comments: readonly CanvasComment[],
): CanvasComment[] {
  return [...comments].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/**
 * Compact relative time for the thread list. Deterministic (no locale data):
 * "just now" < 1 min, "5m ago" < 1 h, "3h ago" < 24 h, "2d ago" < 7 d, then
 * a stable ISO date. Future timestamps (clock skew) render as "just now"
 * rather than a negative age.
 */
export function formatRelativeTime(then: Date, now: Date): string {
  const deltaMs = now.getTime() - then.getTime();
  if (deltaMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return then.toISOString().slice(0, 10);
}
