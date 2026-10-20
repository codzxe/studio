// W2-B — engine budget awareness: reply/request/PNG frames, preview clamping,
// plan-gated canvas ceilings. Mirrors vendor crates/automation/src/budgets.rs
// and security.rs transport limits + studio §2.2/§5.1/§14.1.
import { describe, expect, it } from "vitest";
import { planLimits } from "@studio/config";
import {
  AGENT_OBSERVE_PREVIEW_PX,
  checkCanvasMegapixels,
  clampPreviewSide,
  ENGINE_MAX_BATCH_STEPS,
  ENGINE_MAX_CANVAS_MEGAPIXELS,
  ENGINE_MAX_RENDER_SOURCE_PIXELS,
  ENGINE_PNG_MAX_BYTES,
  ENGINE_PREVIEW_MAX_PX,
  ENGINE_REPLY_MAX_BYTES,
  ENGINE_REQUEST_MAX_BYTES,
  frameByteLength,
  previewCeiling,
  validatePngSize,
  validateReplySize,
  validateRequestSize,
  type PlanId,
  type PreviewPurpose,
} from "../src/budgets.js";

describe("budgets: constants match the engine (budgets.rs / security.rs / §2.2)", () => {
  it("transport and output ceilings are exact", () => {
    expect(ENGINE_REPLY_MAX_BYTES).toBe(8 * 1024 * 1024); // budgets.rs MAX_RESPONSE_BYTES (8 << 20)
    expect(ENGINE_PNG_MAX_BYTES).toBe(5 * 1024 * 1024); // budgets.rs MAX_PNG_BYTES (5 << 20)
    expect(ENGINE_PREVIEW_MAX_PX).toBe(2048); // budgets.rs MAX_PREVIEW_SIDE
    expect(ENGINE_MAX_RENDER_SOURCE_PIXELS).toBe(64 << 20); // 67,108,864 px
    expect(ENGINE_REQUEST_MAX_BYTES).toBe(1 << 20); // security.rs MAX_REQUEST_BYTES
    expect(ENGINE_MAX_BATCH_STEPS).toBe(256); // security.rs MAX_BATCH_STEPS
    expect(AGENT_OBSERVE_PREVIEW_PX).toBe(1024); // §5.1 observe preview
    expect(ENGINE_MAX_CANVAS_MEGAPIXELS).toBe(64); // §2.2 hard ceiling
  });

  it("plan canvas ceilings are the §14.1 32/64/128 MP ladder from @studio/config", () => {
    expect(planLimits("starter").maxCanvasMegapixels).toBe(32);
    expect(planLimits("pro").maxCanvasMegapixels).toBe(64);
    expect(planLimits("business").maxCanvasMegapixels).toBe(128);
  });

  it("frameByteLength counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(frameByteLength("é".repeat(10))).toBe(20);
    expect(frameByteLength(new Uint8Array([1, 2, 3]))).toBe(3);
  });
});

describe("budgets: validateReplySize → frame_too_large (8 MiB reply budget)", () => {
  it("accepts frames up to and including the ceiling", () => {
    expect(validateReplySize("")).toEqual({ ok: true, value: { bytes: 0 } });
    expect(validateReplySize("x".repeat(ENGINE_REPLY_MAX_BYTES))).toEqual({
      ok: true,
      value: { bytes: ENGINE_REPLY_MAX_BYTES },
    });
    expect(validateReplySize(new Uint8Array(ENGINE_REPLY_MAX_BYTES))).toEqual({
      ok: true,
      value: { bytes: ENGINE_REPLY_MAX_BYTES },
    });
  });

  it("rejects one byte over the ceiling with §2.2 semantics", () => {
    const result = validateReplySize("x".repeat(ENGINE_REPLY_MAX_BYTES + 1));
    expect(result).toMatchObject({ ok: false, code: "frame_too_large", retryable: false });
    if (!result.ok) {
      expect(result.message).toContain(`${ENGINE_REPLY_MAX_BYTES}`);
      expect(result.hint ?? "").toMatch(/may already have completed/);
    }
  });
});

describe("budgets: validateRequestSize → frame_too_large (1 MiB request line)", () => {
  it("accepts a request up to and including the ceiling", () => {
    expect(validateRequestSize("{}")).toEqual({ ok: true, value: { bytes: 2 } });
    expect(validateRequestSize("x".repeat(ENGINE_REQUEST_MAX_BYTES)).ok).toBe(true);
  });

  it("rejects an oversized request — the engine closes the TCP connection", () => {
    const result = validateRequestSize("x".repeat(ENGINE_REQUEST_MAX_BYTES + 1));
    expect(result).toMatchObject({ ok: false, code: "frame_too_large", retryable: false });
    if (!result.ok) {
      expect(result.hint ?? "").toMatch(/closes a TCP connection/);
    }
  });
});

describe("budgets: validatePngSize (5 MiB PNG cap)", () => {
  it("accepts the exact ceiling and rejects one byte more", () => {
    expect(validatePngSize(ENGINE_PNG_MAX_BYTES)).toEqual({ ok: true, value: { bytes: ENGINE_PNG_MAX_BYTES } });
    const result = validatePngSize(ENGINE_PNG_MAX_BYTES + 1);
    expect(result).toMatchObject({ ok: false, code: "png_too_large" });
  });

  it("rejects nonsense byte counts", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validatePngSize(bad)).toMatchObject({ ok: false, code: "invalid_png_size" });
    }
  });
});

describe("budgets: preview clamping (§5.1 agent previews; 2048 hard cap)", () => {
  const table: Array<{ requested: number; purpose?: PreviewPurpose; maxSide: number; clamped: boolean }> = [
    // Agent observe previews request ≤1024 px (§5.1).
    { requested: 0, maxSide: 1024, clamped: true }, // 0 means FULL SIZE to the engine — never send it
    { requested: 0.5, maxSide: 1024, clamped: true },
    { requested: 1, maxSide: 1, clamped: false },
    { requested: 512, maxSide: 512, clamped: false },
    { requested: 1024, maxSide: 1024, clamped: false },
    { requested: 1025, maxSide: 1024, clamped: true },
    { requested: 2048, maxSide: 1024, clamped: true },
    { requested: 1024.7, maxSide: 1024, clamped: true }, // floored, then compared
    // Interactive previews may use the hard engine cap (2048).
    { requested: 1025, purpose: "interactive", maxSide: 1025, clamped: false },
    { requested: 2048, purpose: "interactive", maxSide: 2048, clamped: false },
    { requested: 2049, purpose: "interactive", maxSide: 2048, clamped: true },
    { requested: 4096, purpose: "interactive", maxSide: 2048, clamped: true },
    { requested: 0, purpose: "interactive", maxSide: 2048, clamped: true },
  ];

  it("clamps every row of the requested/purpose table", () => {
    for (const row of table) {
      const result = clampPreviewSide(row.requested, row.purpose ?? "agent");
      expect(result, JSON.stringify(row)).toEqual({ ok: true, value: { maxSide: row.maxSide, clamped: row.clamped } });
    }
  });

  it("defaults to the agent purpose (§5.1 smallest render that answers the question)", () => {
    expect(clampPreviewSide(1500)).toEqual({ ok: true, value: { maxSide: 1024, clamped: true } });
    expect(previewCeiling("agent")).toBe(1024);
    expect(previewCeiling("interactive")).toBe(2048);
  });

  it("rejects non-finite and negative requests", () => {
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clampPreviewSide(bad)).toMatchObject({ ok: false, code: "invalid_preview_side" });
    }
  });
});

describe("budgets: canvas megapixel ceilings (§14.1 plans; §2.2 engine cap)", () => {
  const table: Array<{ w: number; h: number; plan: PlanId; code?: string; megapixels?: number }> = [
    { w: 5000, h: 4000, plan: "starter", megapixels: 20 },
    { w: 8000, h: 8000, plan: "pro", megapixels: 64 }, // exactly the 64 MP plan ceiling
    { w: 8192, h: 8192, plan: "business", megapixels: 67.108864 }, // exactly the 64 MiPx engine ceiling
    { w: 8001, h: 8000, plan: "pro", code: "canvas_exceeds_plan_limit" },
    { w: 8000, h: 8000, plan: "starter", code: "canvas_exceeds_plan_limit" }, // 64 MP > starter 32 MP
    { w: 8192, h: 8192, plan: "pro", code: "canvas_exceeds_plan_limit" }, // plan gate fires before the engine gate
    // Business allows up to 128 MP (§14.1) but the engine refuses > 64 MiPx (§2.2).
    { w: 10000, h: 7000, plan: "business", code: "canvas_exceeds_engine_limit" },
    { w: 8193, h: 8192, plan: "business", code: "canvas_exceeds_engine_limit" }, // budgets.rs parity: one pixel over
  ];

  it("accepts or rejects every row with the right code", () => {
    for (const row of table) {
      const result = checkCanvasMegapixels(row.w, row.h, row.plan);
      if (row.code === undefined) {
        expect(result, JSON.stringify(row)).toEqual({
          ok: true,
          value: { pixels: row.w * row.h, megapixels: row.megapixels },
        });
      } else {
        expect(result, JSON.stringify(row)).toMatchObject({ ok: false, code: row.code, retryable: false });
      }
    }
  });

  it("says the engine budget must be raised when the plan allows more than the engine", () => {
    const result = checkCanvasMegapixels(10000, 7000, "business");
    expect(result).toMatchObject({ ok: false, code: "canvas_exceeds_engine_limit" });
    if (!result.ok) {
      expect(result.hint ?? "").toMatch(/engine budget must be raised/);
    }
  });

  it("rejects non-positive and non-integer dimensions", () => {
    const bad: Array<[number, number]> = [
      [0, 100],
      [100, 0],
      [-5, 100],
      [100.5, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 1],
    ];
    for (const [w, h] of bad) {
      expect(checkCanvasMegapixels(w, h, "pro")).toMatchObject({ ok: false, code: "invalid_canvas_dimensions" });
    }
  });
});
