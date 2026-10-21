// Pure table-driven tests for the create-canvas validation mirror (W8-C).
// Deterministic, network-free, <5 s (docs/AGENTS.md test law). The contract
// under test is the gateway's canvas gate order (apps/gateway/src/services/
// documents.ts validateCanvasMegapixels + MAX_DOCUMENT_SIDE_PX) mirrored
// client-side in document-sizes.ts — see the SYNC NOTE there.

import { describe, expect, it } from "vitest";
import {
  CUSTOM_SIZE_PRESET_ID,
  DEFAULT_PLAN_CEILING_MP,
  DOCUMENT_SIZE_PRESETS,
  ENGINE_MAX_CANVAS_MEGAPIXELS,
  MAX_DOCUMENT_SIDE_PX,
  MEGAPIXEL,
  PLAN_CANVAS_CEILINGS_MP,
  matchesQuery,
  parseSizeInput,
  validateCanvasSize,
} from "./document-sizes";

describe("document size presets (task contract)", () => {
  it("offers exactly square-1080 / 1280×720 / 1920×1080 plus the custom slot", () => {
    expect(DOCUMENT_SIZE_PRESETS.map((preset) => [preset.width, preset.height])).toEqual([
      [1080, 1080],
      [1280, 720],
      [1920, 1080],
    ]);
    expect(CUSTOM_SIZE_PRESET_ID).toBe("custom");
  });

  it("every preset passes the default (starter) plan ceiling", () => {
    for (const preset of DOCUMENT_SIZE_PRESETS) {
      const check = validateCanvasSize(preset.width, preset.height, DEFAULT_PLAN_CEILING_MP);
      expect(check).toMatchObject({ ok: true });
    }
  });
});

describe("plan ceiling mirror (§14.1 / @studio/config PLAN_LIMITS)", () => {
  it("matches the 32/64/128 MP table", () => {
    expect(PLAN_CANVAS_CEILINGS_MP).toEqual({ starter: 32, pro: 64, business: 128 });
    expect(DEFAULT_PLAN_CEILING_MP).toBe(32);
  });

  it("uses the decimal megapixel convention (1 MP = 1,000,000 px)", () => {
    expect(MEGAPIXEL).toBe(1_000_000);
    expect(ENGINE_MAX_CANVAS_MEGAPIXELS).toBe(64);
    expect(MAX_DOCUMENT_SIDE_PX).toBe(65_535);
  });
});

describe("validateCanvasSize — gate order mirrors the gateway service", () => {
  it.each([
    [0, 100],
    [100, 0],
    [-5, 100],
    [10.5, 100],
    [Number.NaN, 100],
  ])("rejects non-positive / non-integer (%s × %s) as validation_failed", (width, height) => {
    const check = validateCanvasSize(width, height);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.code).toBe("validation_failed");
      expect(check.message.length).toBeGreaterThan(0);
      expect(check.hint.length).toBeGreaterThan(0);
    }
  });

  it("rejects a side above the u16 raster cap before any MP math", () => {
    const check = validateCanvasSize(MAX_DOCUMENT_SIDE_PX + 1, 100);
    expect(check).toMatchObject({ ok: false, code: "validation_failed" });
  });

  it("accepts exactly the plan ceiling boundary (32 MP at starter)", () => {
    // 5000 × 6400 = 32,000,000 px — at the ceiling, not over it.
    expect(validateCanvasSize(5000, 6400, 32)).toMatchObject({ ok: true, megapixels: 32 });
  });

  it("rejects one pixel over the plan ceiling with the plan_limit code", () => {
    const check = validateCanvasSize(5000, 6401, 32);
    expect(check).toMatchObject({ ok: false, code: "plan_limit" });
    if (!check.ok) {
      expect(check.message).toContain("32 megapixel");
    }
  });

  it("allows a bigger canvas on the pro ceiling for the same dimensions", () => {
    expect(validateCanvasSize(6000, 6000, 64)).toMatchObject({ ok: true, megapixels: 36 });
    expect(validateCanvasSize(6000, 6000, 32)).toMatchObject({ ok: false, code: "plan_limit" });
  });

  it("still applies the engine 64 MP ceiling above the business plan", () => {
    // 100 MP: passes the 128 MP plan gate, fails the engine gate — same
    // ordering and code as services/documents.ts (plan_limit for both).
    const check = validateCanvasSize(10_000, 10_000, 128);
    expect(check).toMatchObject({ ok: false, code: "plan_limit" });
    if (!check.ok) {
      expect(check.message).toContain("64 megapixel");
    }
  });

  it("accepts exactly 64 MP (engine boundary is inclusive)", () => {
    // 8000 × 8000 = 64,000,000 px.
    expect(validateCanvasSize(8000, 8000, 64)).toMatchObject({ ok: true, megapixels: 64 });
  });
});

describe("parseSizeInput — strict text→pixels for the custom fields", () => {
  it.each([
    ["1080", 1080],
    [" 1920 ", 1920],
    ["1", 1],
    ["065535", 65535],
    ["999999", 999999],
  ])("parses %j as %s px (per-side gate decides later)", (raw, expected) => {
    expect(parseSizeInput(raw)).toBe(expected);
  });

  it.each(["", "abc", "19.5", "1e3", "10px", "-100", "1234567"])("rejects %j", (raw) => {
    expect(parseSizeInput(raw)).toBeNull();
  });
});

describe("matchesQuery — client-side placeholder filter", () => {
  const document = { name: "Coffee Shop Promo", templateId: "instagram-post@3" };

  it("empty query matches everything", () => {
    expect(matchesQuery("", document.name, document.templateId)).toBe(true);
    expect(matchesQuery("   ", document.name, document.templateId)).toBe(true);
  });

  it("matches case-insensitively, trimmed, on name and template id", () => {
    expect(matchesQuery("coffee", document.name, document.templateId)).toBe(true);
    expect(matchesQuery("  PROMO ", document.name, document.templateId)).toBe(true);
    expect(matchesQuery("instagram-post", document.name, document.templateId)).toBe(true);
  });

  it("misses on both fields", () => {
    expect(matchesQuery("invoice", document.name, document.templateId)).toBe(false);
  });

  it("skips null/undefined fields instead of throwing", () => {
    expect(matchesQuery("promo", undefined, null)).toBe(false);
    expect(matchesQuery("promo", "Promo flyer", null)).toBe(true);
  });
});
