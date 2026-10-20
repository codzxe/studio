// @studio/engine-client — typed builders for doc.render / doc.save (W2-C).
//
// Sources (vendor pinned 872748fb — verified):
//   - rpc.rs `doc.render`: {index?, maxSide? (default 1024, 0 = full size), path?} →
//     {path, bytes} to a file, else {mime, base64}.
//   - budgets.rs: preview side ceiling 2048, PNG ≤ 5 MiB, source ≤ 64 MiB px — the engine
//     rejects oversized requests; these builders fail fast with the same ceilings.
//   - rpc.rs `doc.save`: {path?, format?, quality?, index?, tiffLayers?, tgaBits?,
//     ddsCompression?, ddsMipmaps?, dpxBits?} → {path, warnings}. `.pcraft` is the layered
//     native form; anything else exports by extension. Without `path`, only a document that
//     holds in its own PSD/PSB/`.pcraft`/OpenRaster file is written back.
//   - Studio §6 render_preview: model/critic previews render ≤1024 px; budgets.ts (W2-B)
//     clamps previews to the 2048 engine ceiling — `clampPreviewMaxSide` implements that
//     clamp for callers; the builder itself only validates.

import { z } from "zod";
import {
  type BuiltMethodCall,
  MAX_PNG_BYTES,
  MAX_PREVIEW_SIDE,
  PROTOCOL_METHODS,
  WRITE_ROOT_PATH,
  buildCall,
} from "./protocol.js";

const nonNegativeInt = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// doc.render — PNG preview, file or inline base64
// ---------------------------------------------------------------------------

export const DOC_RENDER_PARAMS = z
  .object({
    index: nonNegativeInt.optional(),
    /** Preview edge in pixels; 0 = full size (still refused above the 2048 ceiling in
     *  untrusted automation). Omitted = 1024 (rpc.rs). */
    maxSide: z.number().int().min(0).max(MAX_PREVIEW_SIDE).optional(),
    /** Write the PNG here (beneath the write root) instead of returning base64. */
    path: WRITE_ROOT_PATH.optional(),
  })
  .strict();

export type DocRenderParams = z.infer<typeof DOC_RENDER_PARAMS>;
export type DocRenderInput = DocRenderParams;

/** `doc.render {path}` → the written file path and its byte count (rpc.rs). */
export const RENDER_TO_FILE_RESULT = z
  .object({ path: z.string(), bytes: nonNegativeInt })
  .passthrough();

/** `doc.render` without `path` → inline PNG (rpc.rs). */
export const RENDER_INLINE_RESULT = z
  .object({ mime: z.literal("image/png"), base64: z.string() })
  .passthrough();

export const RENDER_RESULT = z.union([RENDER_TO_FILE_RESULT, RENDER_INLINE_RESULT]);

export type RenderToFile = z.infer<typeof RENDER_TO_FILE_RESULT>;
export type RenderInline = z.infer<typeof RENDER_INLINE_RESULT>;
export type RenderResult = z.infer<typeof RENDER_RESULT>;

export function docRender(
  input: DocRenderInput = {},
): BuiltMethodCall<DocRenderParams, RenderResult> {
  return buildCall(PROTOCOL_METHODS.docRender, DOC_RENDER_PARAMS, input, RENDER_RESULT);
}

/** Preview clamp for budgets.ts (W2-B): cap any requested side to the engine's 2048 px
 *  ceiling, floor at 0 (full size). Non-finite input propagates as NaN. */
export function clampPreviewMaxSide(maxSide: number): number {
  return Math.min(MAX_PREVIEW_SIDE, Math.max(0, Math.trunc(maxSide)));
}

/** The engine refuses encoded PNGs above 5 MiB (budgets.rs `check_png`); budget callers
 *  check locally before moving bytes around. */
export function pngWithinBudget(pngBytes: number): boolean {
  return Number.isFinite(pngBytes) && pngBytes >= 0 && pngBytes <= MAX_PNG_BYTES;
}

// ---------------------------------------------------------------------------
// doc.save — layered `.pcraft` / format save under the write root
// ---------------------------------------------------------------------------

export const DOC_SAVE_PARAMS = z
  .object({
    /** Target beneath the automation write root; omit to write back to the document's own
     *  layered file (rpc.rs: anything else is an error and the file is left unchanged). */
    path: WRITE_ROOT_PATH.optional(),
    format: z.string().optional(),
    /** JPEG/WebP quality; the engine clamps 1..100 — rejected here so callers never rely
     *  on a silent clamp (rpc.rs). */
    quality: z.number().int().min(1).max(100).optional(),
    index: nonNegativeInt.optional(),
    /** Keep TIFF layers instead of exporting a flattened TIFF. */
    tiffLayers: z.boolean().optional(),
    tgaBits: z.union([z.literal(24), z.literal(32)]).optional(),
    ddsCompression: z.enum(["none", "bc1", "bc2", "bc3"]).optional(),
    ddsMipmaps: z.boolean().optional(),
    dpxBits: z.union([z.literal(8), z.literal(10), z.literal(12), z.literal(16)]).optional(),
  })
  .strict();

export type DocSaveParams = z.infer<typeof DOC_SAVE_PARAMS>;
export type DocSaveInput = DocSaveParams;

export const DOC_SAVE_RESULT = z
  .object({ path: z.string(), warnings: z.array(z.string()) })
  .passthrough();

export type DocSaveResult = z.infer<typeof DOC_SAVE_RESULT>;

export function docSave(input: DocSaveInput): BuiltMethodCall<DocSaveParams, DocSaveResult> {
  return buildCall(PROTOCOL_METHODS.docSave, DOC_SAVE_PARAMS, input, DOC_SAVE_RESULT);
}
