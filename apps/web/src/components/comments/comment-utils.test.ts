// Pure-logic tests for comment-utils.ts (W8-H): pointer math, canvas↔fraction
// round-trips, body validation, relative time. Deterministic, table-driven,
// no network, no DOM (AGENTS.md test rules). Runs in vitest's default node
// environment — no jsdom/@testing-library needed (not in @studio/web devDeps).
//
// The React pieces (panel, pins, hooks) are exercised through the typed
// gateway client contract in tests/api.test.ts style once jsdom lands in the
// web app's devDeps (flagged in this folder's README).

import { describe, expect, it } from "vitest";
import {
  COMMENT_BODY_MAX,
  canvasPointFromFraction,
  clamp01,
  formatRelativeTime,
  fractionFromCanvasPoint,
  fractionFromPointer,
  percentStyle,
  sortCommentsByCreation,
  validateCommentBody,
  type CanvasComment,
} from "./comment-utils";

const CANVAS = { width: 1080, height: 1080 } as const;
const RECT = { left: 100, top: 50, width: 540, height: 540 } as const;

describe("clamp01", () => {
  it.each([
    { value: -3, expected: 0 },
    { value: -0.001, expected: 0 },
    { value: 0, expected: 0 },
    { value: 0.42, expected: 0.42 },
    { value: 1, expected: 1 },
    { value: 1.0001, expected: 1 },
    { value: 7, expected: 1 },
  ])("clamp01($value) → $expected", ({ value, expected }) => {
    expect(clamp01(value)).toBe(expected);
  });

  it("collapses NaN to 0 (a pin never renders at NaN%)", () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("fractionFromPointer — pointer → fraction", () => {
  it.each([
    { name: "center", x: 370, y: 320, fx: 0.5, fy: 0.5 },
    { name: "top-left origin", x: 100, y: 50, fx: 0, fy: 0 },
    { name: "bottom-right corner", x: 640, y: 590, fx: 1, fy: 1 },
    { name: "pointer left of rect clamps to 0", x: -50, y: 320, fx: 0, fy: 0.5 },
    { name: "pointer past right edge clamps to 1", x: 9999, y: 320, fx: 1, fy: 0.5 },
    { name: "pointer above rect clamps to 0", x: 370, y: -10, fx: 0.5, fy: 0 },
    { name: "pointer below rect clamps to 1", x: 370, y: 9999, fx: 0.5, fy: 1 },
  ])("$name: ($x, $y) → fx $fx, fy $fy", ({ x, y, fx, fy }) => {
    expect(fractionFromPointer(x, y, RECT)).toEqual({ fx, fy });
  });

  it("degenerate (zero-area) rect collapses to 0, never NaN", () => {
    expect(fractionFromPointer(370, 320, { left: 0, top: 0, width: 0, height: 0 })).toEqual(
      { fx: 0, fy: 0 },
    );
  });
});

describe("canvasPointFromFraction — fraction → canvas px", () => {
  it.each([
    { name: "origin", fx: 0, fy: 0, x: 0, y: 0 },
    { name: "center", fx: 0.5, fy: 0.5, x: 540, y: 540 },
    { name: "extreme edge is point-inclusive", fx: 1, fy: 1, x: 1080, y: 1080 },
    { name: "rounds to nearest", fx: 0.2504, fy: 0.7496, x: 270, y: 810 },
    { name: "negative fractions clamp to 0", fx: -1, fy: -1, x: 0, y: 0 },
    { name: "overflow fractions clamp to size", fx: 2, fy: 3, x: 1080, y: 1080 },
  ])("$name: ($fx, $fy) → ($x, $y)", ({ fx, fy, x, y }) => {
    expect(canvasPointFromFraction({ fx, fy }, CANVAS)).toEqual({ x, y });
  });

  it("non-square canvases scale each axis independently", () => {
    const size = { width: 2000, height: 500 } as const;
    expect(canvasPointFromFraction({ fx: 0.5, fy: 0.5 }, size)).toEqual({ x: 1000, y: 250 });
  });

  it("degenerate canvas collapses to the origin (no negative ints for the schema)", () => {
    expect(canvasPointFromFraction({ fx: 0.5, fy: 0.5 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("fractionFromCanvasPoint — canvas px → fraction (render side)", () => {
  it.each([
    { name: "origin", x: 0, y: 0, fx: 0, fy: 0 },
    { name: "mid canvas", x: 540, y: 540, fx: 0.5, fy: 0.5 },
    { name: "extreme edge", x: 1080, y: 1080, fx: 1, fy: 1 },
    { name: "legacy row off-canvas clamps back on", x: 5000, y: -40, fx: 1, fy: 0 },
  ])("$name: ($x, $y) → fx $fx, fy $fy", ({ x, y, fx, fy }) => {
    expect(fractionFromCanvasPoint({ x, y }, CANVAS)).toEqual({ fx, fy });
  });

  it("round-trips fractions through canvas px within half a canvas pixel", () => {
    const fractions = [0, 0.125, 0.25, 0.333, 0.5, 0.666, 0.75, 0.875, 1] as const;
    for (const fx of fractions) {
      for (const fy of fractions) {
        const point = canvasPointFromFraction({ fx, fy }, CANVAS);
        const back = fractionFromCanvasPoint(point, CANVAS);
        expect(Math.abs(back.fx - fx)).toBeLessThanOrEqual(1 / CANVAS.width + 1e-9);
        expect(Math.abs(back.fy - fy)).toBeLessThanOrEqual(1 / CANVAS.height + 1e-9);
      }
    }
  });

  it("degenerate sizes divide by 1 px, never NaN/Infinity", () => {
    expect(fractionFromCanvasPoint({ x: 0, y: 0 }, { width: 0, height: 0 })).toEqual({
      fx: 0,
      fy: 0,
    });
  });
});

describe("percentStyle", () => {
  it.each([
    { name: "zero", fx: 0, fy: 0, left: "0.000%", top: "0.000%" },
    { name: "center", fx: 0.5, fy: 0.5, left: "50.000%", top: "50.000%" },
    { name: "three decimals", fx: 0.123456, fy: 0.987654, left: "12.346%", top: "98.765%" },
  ])("$name: fx $fx → $left", ({ fx, fy, left, top }) => {
    expect(percentStyle({ fx, fy })).toEqual({ left, top });
  });
});

describe("validateCommentBody", () => {
  it.each([
    { name: "plain text", body: "Move the headline left", ok: true },
    { name: "surrounding whitespace still valid", body: "  trim me  ", ok: true },
    { name: "exactly the cap", body: "x".repeat(COMMENT_BODY_MAX), ok: true },
  ])("accepts: $name", ({ body, ok }) => {
    expect(validateCommentBody(body).ok).toBe(ok);
  });

  it.each([
    { name: "empty", body: "", code: "empty" },
    { name: "whitespace only", body: " \n\t ", code: "empty" },
    { name: "one over the cap", body: "x".repeat(COMMENT_BODY_MAX + 1), code: "too_long" },
  ])("rejects: $name (code $code)", ({ body, code }) => {
    const result = validateCommentBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe("sortCommentsByCreation", () => {
  const comment = (id: string, minutesAgo: number): CanvasComment => ({
    id,
    authorId: `author-${id}`,
    body: `body ${id}`,
    x: 0,
    y: 0,
    resolvedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000),
  });

  it("sorts oldest first without mutating the input", () => {
    const input = [comment("c", 1), comment("a", 30), comment("b", 10)];
    const sorted = sortCommentsByCreation(input);
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(input.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("is stable for equal timestamps (DB-ordered rows keep their order)", () => {
    const at = new Date(Date.UTC(2026, 0, 1));
    const a = { ...comment("a", 0), createdAt: at };
    const b = { ...comment("b", 0), createdAt: at };
    expect(sortCommentsByCreation([b, a]).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("handles the empty list", () => {
    expect(sortCommentsByCreation([])).toEqual([]);
  });
});

describe("formatRelativeTime", () => {
  const NOW = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));

  it.each([
    { name: "seconds ago", offsetMin: -0.5, expected: "just now" },
    { name: "under a minute", offsetMin: -0.99, expected: "just now" },
    { name: "minutes", offsetMin: -5, expected: "5m ago" },
    { name: "just under an hour", offsetMin: -59, expected: "59m ago" },
    { name: "hours", offsetMin: -180, expected: "3h ago" },
    { name: "just under a day", offsetMin: -23 * 60, expected: "23h ago" },
    { name: "days", offsetMin: -2 * 24 * 60, expected: "2d ago" },
    { name: "just under a week", offsetMin: -6 * 24 * 60, expected: "6d ago" },
    { name: "past a week → stable ISO date", offsetMin: -8 * 24 * 60, expected: "2026-06-07" },
    { name: "future (clock skew) never negative", offsetMin: 5, expected: "just now" },
  ])("$name → $expected", ({ offsetMin, expected }) => {
    const then = new Date(NOW.getTime() + offsetMin * 60_000);
    expect(formatRelativeTime(then, NOW)).toBe(expected);
  });
});
