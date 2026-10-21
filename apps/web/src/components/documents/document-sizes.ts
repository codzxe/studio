// apps/web — document creation sizing (W8-C, §13.1 POST /v1/documents).
//
// Canvas presets + client-side validation for the create-document modal. The
// gateway is authoritative; this module mirrors its gates so the modal can
// reject impossible canvases BEFORE a round-trip and show the same wording.
//
// SYNC NOTE (do not import the sources — see src/lib/api.ts "hermetic by
// design"): the mirrored truth lives in
//   - apps/gateway/src/services/documents.ts — MAX_DOCUMENT_SIDE_PX = 65535
//     (engine raster dims are u16) + validateCanvasMegapixels() gate order:
//     positive ints → per-plan MP ceiling → engine 64 MP ceiling.
//   - packages/config/src/constants/limits.ts — PLAN_LIMITS max canvas
//     32/64/128 MP (§14.1) + ENGINE_MAX_CANVAS_MEGAPIXELS = 64 (§2.2).
// Update both sides if any cap moves (checked in document-sizes.test.ts).

/** §14.1 decimal megapixel: 1 MP = 1,000,000 px (service `MP` mirror). */
export const MEGAPIXEL = 1_000_000;

/** Mirror: hard per-side cap (service MAX_DOCUMENT_SIDE_PX; raster u16). */
export const MAX_DOCUMENT_SIDE_PX = 65_535;

/** Mirror: engine hard canvas ceiling, 64 MP (§2.2 — binds even above plans). */
export const ENGINE_MAX_CANVAS_MEGAPIXELS = 64;

/**
 * Mirror: PLAN_LIMITS maxCanvasMegapixels per plan (§14.1).
 * Client-side create validation only — the server enforces the real ceiling
 * for the caller's workspace (402 `plan_limit`, services/documents.ts).
 */
export const PLAN_CANVAS_CEILINGS_MP = {
  starter: 32,
  pro: 64,
  business: 128,
} as const satisfies Readonly<Record<string, number>>;

/**
 * Conservative default ceiling until `GET /v1/me` (contract-only today) ships
 * the workspace plan summary: the lowest plan's ceiling, 32 MP. Passing the
 * real value from the shell/dashboard narrows client validation only — the
 * server always re-validates.
 */
export const DEFAULT_PLAN_CEILING_MP: number = PLAN_CANVAS_CEILINGS_MP.starter;

/** One selectable canvas preset in the create modal. */
export interface DocumentSizePreset {
  readonly id: string;
  readonly label: string;
  /** "1080 × 1080" style caption (U+00D7 multiplication sign). */
  readonly caption: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Create-modal presets (W8-C task contract): square 1080, 1280 × 720 HD,
 * 1920 × 1080 Full HD. All pass the starter ceiling (see tests).
 */
export const DOCUMENT_SIZE_PRESETS: readonly DocumentSizePreset[] = [
  { id: "square-1080", label: "Square post", caption: "1080 × 1080", width: 1080, height: 1080 },
  { id: "hd-1280x720", label: "HD landscape", caption: "1280 × 720", width: 1280, height: 720 },
  { id: "full-hd-1920x1080", label: "Full HD", caption: "1920 × 1080", width: 1920, height: 1080 },
] as const;

/** Radio value selecting custom width/height entry in the modal. */
export const CUSTOM_SIZE_PRESET_ID = "custom";

/**
 * Client mirror of the gateway's canvas gate (services/documents.ts
 * validateCanvasMegapixels) — same order, same stable codes (§13.3):
 * positive integers → per-side cap → plan ceiling → engine ceiling.
 * `ok:false` shapes are display-ready envelopes (message + hint, never internals).
 */
export type CanvasSizeCheck =
  | { readonly ok: true; readonly megapixels: number }
  | {
      readonly ok: false;
      readonly code: "validation_failed" | "plan_limit";
      readonly message: string;
      readonly hint: string;
    };

export function validateCanvasSize(
  width: number,
  height: number,
  planCeilingMegapixels: number = DEFAULT_PLAN_CEILING_MP,
): CanvasSizeCheck {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return {
      ok: false,
      code: "validation_failed",
      message: "Canvas dimensions must be positive whole numbers of pixels.",
      hint: "Enter whole pixels, e.g. 1920 by 1080.",
    };
  }
  if (width > MAX_DOCUMENT_SIDE_PX || height > MAX_DOCUMENT_SIDE_PX) {
    return {
      ok: false,
      code: "validation_failed",
      message: `Neither canvas side may exceed ${MAX_DOCUMENT_SIDE_PX.toLocaleString("en")} px.`,
      hint: "For very large canvases, create at print scale or contact support.",
    };
  }
  const pixels = width * height; // ≤ 65535² — safe without BigInt (service note)
  const ceilingPx = planCeilingMegapixels * MEGAPIXEL;
  if (pixels > ceilingPx) {
    return {
      ok: false,
      code: "plan_limit",
      message: `Canvas exceeds the ${planCeilingMegapixels} megapixel limit of the current plan.`,
      hint: "Upgrade the workspace plan or use a smaller canvas.",
    };
  }
  if (pixels > ENGINE_MAX_CANVAS_MEGAPIXELS * MEGAPIXEL) {
    return {
      ok: false,
      code: "plan_limit",
      message: "Canvas exceeds the rendering engine's 64 megapixel ceiling.",
      hint: "Use a smaller canvas for now.",
    };
  }
  return { ok: true, megapixels: pixels / MEGAPIXEL };
}

/**
 * Strict dimension-text parser for the modal's custom inputs: only plain
 * integers (optionally padded with spaces) parse; "1e3", "19.5", "abc" and
 * "" reject as null rather than guessing (no silent parseInt truncation).
 */
export function parseSizeInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

/**
 * Client-side search predicate (W8-C placeholder until the gateway list
 * endpoint accepts a server-side `q` — its schema is strict over
 * {cursor, limit, include_archived} today, routes/documents.ts). Case
 * insensitive, trimmed substring match; an empty query matches everything.
 * Null/undefined fields (e.g. `template_id`) are skipped, never matched.
 */
export function matchesQuery(
  query: string,
  ...fields: readonly (string | null | undefined)[]
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return fields.some((field) => field?.toLowerCase().includes(needle) === true);
}
