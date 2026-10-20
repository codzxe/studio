// @studio/tools — image_generate (§6 row 7; §5.2 image tiers; §5.3 image routes).
// Owner: W5-F.
//
// Generate a raster image (draft/final) from a prompt and place it as a
// smart-object layer named "Photo — Generated" (§10.2). Flow (§6 row 7):
//   charge credits (§5.2: draft 1 / final 2) → external image API (injected
//   provider seam; §5.3 routing happens in the WORKER, never here) → PNG magic
//   validation → persist inside the workspace capability root → the SAME place
//   mechanics as asset_place (W5-E, §6 row 6): `doc.place` at the box centre →
//   `edit.transform` for the cover fit → rename → `layer.smartObjects.
//   convertToSmartObject` (best effort — doc.place already embeds a smart
//   object, so a refusal is a warning, never a failure).
//
// Seams declared HERE because types.ts keeps ctx minimal (see worklog):
//   - `CreditSpender` (`ctx.credits`): types.ts `ctx.budgets` (BudgetTracker)
//     has NO `spendCredits(amount, reason)` member — the §14.2 ledger worker
//     conforms to the seam declared in this file. Reported for types.ts.
//   - `ImageProviderLike` (`ctx.imageProvider`): the worker wires §5.3 —
//     drafts → Flux 2 Schnell (`imageDrafts`), finals → Gemini 3 Pro Image
//     (`imageFinals`). Paid endpoints only (§1.5-6: customer content never
//     flows through free LLM tiers). §15.3: the provider sees workspace data
//     NO further than the prompt string — never document contents, layer
//     data, brand tokens, or tenant ids.
//   - `GeneratedImageSinkLike` (`ctx.generatedImages`): doc.place reads files
//     by capability-scoped path only (§3.2, §15.1), so the worker persists the
//     returned bytes inside the workspace root and hands back the path.
//
// Budget: 1 tool call per image-tier run (§5.2, executor-enforced); the tool
// charges the command meter once, for exactly what it batches.

import { ENGINE_PNG_MAX_BYTES } from "@studio/config";
import { z } from "zod";
import {
  ToolError,
  ambiguousLayerErr,
  cappedString,
  defineTool,
  err,
  layerNotFoundErr,
  ok,
  strictObject,
  zIdempotencyKey,
  zLayerRef,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import type {
  EngineCommand,
  EngineLayerSummary,
  EngineOutcome,
  Tool,
  ToolContext,
  ToolErr,
} from "../types.js";
import {
  UPSCALE_ERR_FACTOR,
  UPSCALE_WARN_FACTOR,
  computeFit,
  zBounds,
  type FitPlan,
} from "./asset-place.js";

// ---------------------------------------------------------------------------
// Constants (§5.2 credit table, §10.2 naming, task prompt cap)
// ---------------------------------------------------------------------------

/** §5.2 image tiers: each 1024² draft = 1 credit, HD/final = 2 credits. */
export const IMAGE_CREDIT_COST = { draft: 1, final: 2 } as const;

/** §10.2 Photo pattern with the generated-image subject (task-pinned name). */
export const GENERATED_PHOTO_LAYER_NAME = "Photo — Generated";

/** Task cap: prompts are ≤ 1500 chars (and sanitized below, §15.3). */
export const MAX_PROMPT_CHARS = 1500;

const PLACE_COMMAND = "doc.place";
const TRANSFORM_COMMAND = "edit.transform";
const RENAME_COMMAND = "layer.setProps";
const SMART_OBJECT_COMMAND = "layer.smartObjects.convertToSmartObject";

// ---------------------------------------------------------------------------
// Argument schema (§6.1: strict, capped; §6.2 shape)
// ---------------------------------------------------------------------------

export const IMAGE_SIZE_SCHEMA = z.enum(["1024x1024", "1792x1024", "1024x1792"]);
export type ImageSize = z.output<typeof IMAGE_SIZE_SCHEMA>;

export const IMAGE_QUALITY_SCHEMA = z.enum(["draft", "final"]);
export type ImageQuality = z.output<typeof IMAGE_QUALITY_SCHEMA>;

// Same target semantics as asset_place (W5-E): slot XOR layer; explicit bounds
// may override either; none of the three places above the active layer.
const zTarget = strictObject({
  /** Template slot name; resolved through the catalog's image-slot layer maps (§7.2). */
  slot: cappedString(120, 1).optional(),
  /** layer_id or layer_name — the kit's §6.1 reference. */
  layer: zLayerRef.optional(),
  /** Explicit [x, y, w, h] destination box; overrides the target layer's bounds. */
  bounds: zBounds.optional(),
}).refine((target) => !(target.slot !== undefined && target.layer !== undefined), {
  message: "target: pass either slot or layer, not both",
});

export const imageGenerateArgsSchema = strictObject({
  prompt: cappedString(MAX_PROMPT_CHARS, 1),
  /** Money path: mutating tools carry an idempotency key (§14.2, tools README). */
  idempotencyKey: zIdempotencyKey,
  size: IMAGE_SIZE_SCHEMA.default("1024x1024"),
  quality: IMAGE_QUALITY_SCHEMA.default("draft"),
  target: zTarget,
});

export type ImageGenerateArgs = z.output<typeof imageGenerateArgsSchema>;

// ---------------------------------------------------------------------------
// Worker-injected seams (declared here; the runtime conforms structurally)
// ---------------------------------------------------------------------------

/** What an image provider returns: raw PNG bytes plus their MIME type. */
export interface ImageProviderResult {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/**
 * The external image API seam (§6 row 7). The WORKER wires this per §5.3 via
 * the model router — drafts: Flux 2 Schnell, finals: Gemini 3 Pro Image —
 * never inside the tool. Paid API keys only (§1.5-6). §15.3: the provider
 * receives workspace data no further than the prompt string handed to
 * `generate`; `store: false` / no-training settings are the worker's duty.
 */
export interface ImageProviderLike {
  generate(
    prompt: string,
    size: ImageSize,
    quality: ImageQuality,
    signal: AbortSignal,
  ): Promise<ImageProviderResult>;
}

/**
 * Credit settlement seam (§5.2 tier costs, §14.2 ledger). The reason embeds
 * the tool's idempotency key so the ledger can settle exactly-once:
 * `image_generate:<quality>:<key>`. Failure values, never throws; the worker
 * refunds on run failure per policy — the tool does NOT refund.
 */
export interface CreditSpender {
  spendCredits(amount: number, reason: string): Promise<EngineOutcome<{ charged: number }>>;
}

/**
 * Persists generated bytes inside the run's workspace capability root and
 * returns the engine-visible path for `doc.place` (§3.2, §15.1 — doc.place
 * only reads beneath its read root, so bytes cannot go straight to the engine).
 */
export interface GeneratedImageSinkLike {
  put(bytes: Uint8Array, fileName: string): Promise<EngineOutcome<{ readonly path: string }>>;
}

/**
 * The context the worker must assemble for `image_generate`: the base
 * `ToolContext` plus the three seams above (slot targets resolve through the
 * existing `ctx.templates` catalog seam, exactly like asset_place).
 */
export interface ImageGenerateContext extends ToolContext {
  readonly credits: CreditSpender;
  readonly imageProvider: ImageProviderLike;
  readonly generatedImages: GeneratedImageSinkLike;
}

function isImageGenerateContext(value: ToolContext): value is ImageGenerateContext {
  const candidate = value as Partial<ImageGenerateContext>;
  return (
    candidate.credits !== undefined &&
    candidate.imageProvider !== undefined &&
    candidate.generatedImages !== undefined
  );
}

function requireImageGenerateContext(ctx: ToolContext): ImageGenerateContext {
  if (!isImageGenerateContext(ctx)) {
    throw new ToolError(
      "internal_error",
      "image_generate requires the credit, image-provider and generated-image seams on ctx",
      {
        hint: "The agent runtime wires ctx.credits, ctx.imageProvider and ctx.generatedImages (§5.2, §5.3, §14.2).",
        retryable: false,
      },
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for table-driven tests)
// ---------------------------------------------------------------------------

const CONTROL_CHARS_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g;

/**
 * §15.3 output safety: cap strings (schema) and strip control characters.
 * Keeps newlines/tabs (legitimate prompt structure), normalises CRLF→LF,
 * strips zero-width/bidi tricks, trims ends.
 */
export function sanitizePrompt(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_RE, "")
    .trim();
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type PngCheck =
  | { readonly ok: true; readonly widthPx: number; readonly heightPx: number }
  | {
      readonly ok: false;
      readonly reason:
        | "empty"
        | "truncated"
        | "bad_magic"
        | "bad_ihdr"
        | "degenerate"
        | "too_large";
    };

/**
 * PNG magic + IHDR validation and dimension read (big-endian, offsets 16/24).
 * The size cap mirrors the engine's own PNG budget (§2.2, @studio/config).
 */
export function validatePng(bytes: Uint8Array, maxBytes: number = ENGINE_PNG_MAX_BYTES): PngCheck {
  if (bytes.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (bytes.length < 8) {
    return { ok: false, reason: "truncated" };
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return { ok: false, reason: "bad_magic" };
    }
  }
  if (bytes.length < 24) {
    return { ok: false, reason: "truncated" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isIhdr =
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (!isIhdr) {
    return { ok: false, reason: "bad_ihdr" };
  }
  const widthPx = view.getUint32(16, false);
  const heightPx = view.getUint32(20, false);
  if (widthPx === 0 || heightPx === 0) {
    return { ok: false, reason: "degenerate" };
  }
  if (bytes.length > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, widthPx, heightPx };
}

/**
 * The sink path must be a plain workspace-relative key: no absolute paths,
 * URL schemes, traversal or control characters — nothing that could steer
 * doc.place outside the run's capability root (§3.2, §15.1, §6.1).
 */
export function isPlaceableGeneratedPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/")) {
    return false;
  }
  if (path.includes("\\") || path.includes("..") || path.includes(":")) {
    return false;
  }
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** The single layer `doc.place` added; undefined when the tree diff is not exactly one. */
function diffNewLayerId(
  before: readonly EngineLayerSummary[],
  after: readonly EngineLayerSummary[],
): string | undefined {
  const seen = new Set(before.map((layer) => layer.layerId));
  const fresh = after.filter((layer) => !seen.has(layer.layerId));
  return fresh.length === 1 ? fresh[0].layerId : undefined;
}

function shortName(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

// ---------------------------------------------------------------------------
// Target resolution (same semantics as asset_place, W5-E)
// ---------------------------------------------------------------------------

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where the generated image goes: a destination box + a §6.1 summary fragment. */
export interface ResolvedTarget {
  readonly box: Box | undefined;
  readonly summaryAnchor: string;
}

function layerBoundsBox(layer: EngineLayerSummary): Box | undefined {
  const bounds = layer.bounds;
  if (
    bounds === undefined ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return undefined;
  }
  return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
}

function isErr(value: unknown): value is ToolErr {
  return (value as { ok?: unknown }).ok === false;
}

/** layer_id or layer_name against the live tree; §6.1 errors from the kit. */
function resolveLayer(
  ref: { readonly layerId?: string; readonly layerName?: string },
  layers: readonly EngineLayerSummary[],
): EngineLayerSummary | ToolErr {
  const id = ref.layerId;
  if (id !== undefined) {
    const found = layers.find((layer) => layer.layerId === id);
    return found === undefined ? layerNotFoundErr(id) : found;
  }
  const name = ref.layerName ?? "";
  const matches = layers.filter((layer) => layer.name === name);
  const [first] = matches;
  if (first === undefined) {
    return layerNotFoundErr(name);
  }
  if (matches.length > 1) {
    return ambiguousLayerErr(name, matches.map((layer) => `${layer.name} (${layer.layerId})`));
  }
  return first;
}

/**
 * Slot → layer through the template catalog, mirroring asset_place (W5-E):
 * every manifest defining this IMAGE slot contributes a candidate layer ref;
 * refs resolve against the live tree and dedupe by layer id — exactly one
 * survivor wins. Generated photos go into image slots only (§7.2).
 */
async function resolveImageSlot(
  ctx: ToolContext,
  slot: string,
  layers: readonly EngineLayerSummary[],
): Promise<EngineLayerSummary | ToolErr> {
  const summaries = await ctx.templates.list();
  const candidateRefs: string[] = [];
  const imageSlots = new Set<string>();
  let nonImageKind: string | undefined;
  for (const summary of summaries) {
    const manifest = await ctx.templates.get(`${summary.id}@${summary.version}`);
    if (manifest === undefined) {
      continue;
    }
    for (const [name, spec] of Object.entries(manifest.slots)) {
      if (spec.kind === "image") {
        imageSlots.add(name);
      }
    }
    const spec = manifest.slots[slot];
    if (spec === undefined) {
      continue;
    }
    if (spec.kind !== "image") {
      nonImageKind = spec.kind;
      continue;
    }
    const mapped = manifest.layerMap?.[slot];
    if (typeof mapped === "string" && mapped.length > 0) {
      candidateRefs.push(mapped);
    }
  }
  if (candidateRefs.length === 0) {
    if (nonImageKind !== undefined) {
      return err(
        "invalid_slots",
        `Slot "${shortName(slot)}" is a ${nonImageKind} slot, not an image slot`,
        {
          hint: "Generated images place into image slots only; inspect the template with template_inspect.",
          retryable: false,
        },
      );
    }
    const known = [...imageSlots].sort().slice(0, 10).join(", ");
    return err(
      "unknown_slots",
      `No template in the catalog defines an image slot "${shortName(slot)}"`,
      {
        hint:
          known.length > 0
            ? `Image slots: ${known}`
            : "No image slots are defined in the catalog; pass target.layer or target.bounds instead.",
        retryable: false,
      },
    );
  }
  const resolved = new Map<string, EngineLayerSummary>();
  for (const ref of candidateRefs) {
    let candidate = layers.find((layer) => layer.layerId === ref);
    if (candidate === undefined) {
      const byName = layers.filter((layer) => layer.name === ref);
      if (byName.length === 1) {
        candidate = byName[0];
      }
    }
    if (candidate !== undefined) {
      resolved.set(candidate.layerId, candidate);
    }
  }
  if (resolved.size === 0) {
    return err(
      "layer_not_found",
      `The layers mapped to slot "${shortName(slot)}" are not in this document`,
      {
        hint: "Apply the template first, or address a layer directly with target.layer.",
        retryable: false,
      },
    );
  }
  if (resolved.size > 1) {
    const candidates = [...resolved.entries()]
      .map(([id, layer]) => `${layer.name} (${id})`)
      .slice(0, 10);
    return err(
      "ambiguous_layer",
      `Slot "${shortName(slot)}" resolves to ${resolved.size} different layers`,
      {
        hint: `Address one directly with target.layer.layerId. Candidates: ${candidates.join(", ")}`,
        retryable: false,
      },
    );
  }
  const [winner] = [...resolved.values()];
  return winner === undefined ? layerNotFoundErr(slot) : winner;
}

/**
 * Resolves `target` to a destination box (§7.3): explicit bounds beat the
 * slot/layer's own bounds; no anchor at all places above the active layer at
 * natural size. Failures are values, never throws.
 */
export async function resolveTarget(
  ctx: ToolContext,
  target: ImageGenerateArgs["target"],
  layers: readonly EngineLayerSummary[],
): Promise<ResolvedTarget | ToolErr> {
  let anchor: EngineLayerSummary | undefined;
  let summaryAnchor: string;
  if (target.slot !== undefined) {
    const slotLayer = await resolveImageSlot(ctx, target.slot, layers);
    if (isErr(slotLayer)) {
      return slotLayer;
    }
    anchor = slotLayer;
    summaryAnchor = `into slot "${shortName(target.slot)}"`;
  } else if (target.layer !== undefined) {
    const layer = resolveLayer(target.layer, layers);
    if (isErr(layer)) {
      return layer;
    }
    anchor = layer;
    summaryAnchor = `over layer "${shortName(layer.name)}"`;
  } else {
    summaryAnchor = "above the active layer";
  }
  if (target.bounds !== undefined) {
    const [x, y, w, h] = target.bounds;
    return { box: { x, y, w, h }, summaryAnchor };
  }
  if (anchor === undefined) {
    return { box: undefined, summaryAnchor };
  }
  const box = layerBoundsBox(anchor);
  if (box === undefined) {
    return err("validation_failed", `Target layer "${anchor.name}" reports no usable bounds`, {
      hint: "Pass target.bounds [x, y, w, h] explicitly (§7.3 image-slot bounds).",
      retryable: false,
    });
  }
  return { box, summaryAnchor };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

function parseRequestedSize(size: ImageSize): { width: number; height: number } {
  const [width, height] = size.split("x");
  return { width: Number(width), height: Number(height) };
}

export const imageGenerateTool: Tool<ImageGenerateArgs> = defineTool({
  name: TOOLS.image_generate,
  description:
    "Generate a raster image (draft or final quality) from a prompt and place it as a smart-object layer named \"Photo — Generated\"; charges 1 credit (draft) or 2 (final).",
  args: imageGenerateArgsSchema,

  async run(ctx, args, signal) {
    const ictx = requireImageGenerateContext(ctx);

    // §15.3: strip control characters before anything leaves the tool.
    const prompt = sanitizePrompt(args.prompt);
    if (prompt.length === 0) {
      return err("invalid_args", "The prompt is empty after sanitisation", {
        hint: "Control characters are stripped (§15.3); provide plain descriptive text of at most 1500 characters.",
        retryable: false,
      });
    }

    // §5.2: charge BEFORE generating (draft 1, final 2). The reason embeds the
    // idempotency key so the ledger settles exactly-once (§14.2). The worker
    // refunds on failure via policy — this tool never refunds.
    const cost = IMAGE_CREDIT_COST[args.quality];
    const spend = await ictx.credits.spendCredits(
      cost,
      `image_generate:${args.quality}:${args.idempotencyKey}`,
    );
    if (!spend.ok) {
      return err(spend.code, spend.message, {
        hint: spend.hint,
        retryable: spend.retryable,
      });
    }

    let generated: Awaited<ReturnType<ImageProviderLike["generate"]>>;
    try {
      generated = await ictx.imageProvider.generate(prompt, args.size, args.quality, signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error; // §3.4 deadline — the defineTool boundary maps engine_timeout.
      }
      ictx.logger.error("image_generate: provider call failed", {
        quality: args.quality,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return err("image_provider_error", "The image provider failed for this request", {
        hint: "Retry the same idempotency_key once; charged credits are refunded by the failure policy (§14.2).",
        retryable: true,
      });
    }

    if (generated.mime !== "image/png") {
      ictx.logger.error("image_generate: provider returned a non-PNG mime", {
        mime: generated.mime,
      });
      return err("image_provider_error", "The image provider must return PNG images", {
        hint: "Retry the same idempotency_key once; charged credits are refunded by the failure policy (§14.2).",
        retryable: true,
      });
    }
    const check = validatePng(generated.bytes);
    if (!check.ok) {
      ictx.logger.error("image_generate: provider returned invalid PNG", {
        reason: check.reason,
      });
      return err(
        "image_provider_error",
        `The image provider returned an unusable image (${check.reason})`,
        {
          hint: "Retry the same idempotency_key once; charged credits are refunded by the failure policy (§14.2).",
          retryable: true,
        },
      );
    }

    // doc.place reads only beneath its capability root (§3.2, §15.1): the sink
    // persists the bytes and returns the engine-visible relative path.
    const stored = await ictx.generatedImages.put(
      generated.bytes,
      `${args.idempotencyKey}.png`,
    );
    if (!stored.ok) {
      return err(stored.code, "The generated image could not be stored for placement", {
        hint: stored.hint,
        retryable: stored.retryable,
      });
    }
    if (!isPlaceableGeneratedPath(stored.value.path)) {
      ictx.logger.error("image_generate: sink returned a non-placeable path");
      return err("internal_error", "The generated image was stored outside the workspace scope", {
        hint: "The sink must return a workspace-relative key; absolute paths never reach the engine (§15.1).",
        retryable: false,
      });
    }

    // 1. Layer tree first: target resolution and the post-batch diff both need it.
    const preLayers = await ictx.engine.listLayers();
    if (!preLayers.ok) {
      return err(preLayers.code, preLayers.message, {
        hint: preLayers.hint,
        retryable: preLayers.retryable,
      });
    }
    const resolved = await resolveTarget(ictx, args.target, preLayers.value);
    if (isErr(resolved)) {
      return resolved;
    }

    // 2. Cover-fit plan (§7.3 default fit) whenever a destination box exists.
    const warnings: string[] = [];
    const plan: FitPlan | undefined =
      resolved.box === undefined
        ? undefined
        : computeFit({
            boxX: resolved.box.x,
            boxY: resolved.box.y,
            boxW: resolved.box.w,
            boxH: resolved.box.h,
            assetW: check.widthPx,
            assetH: check.heightPx,
            fit: "cover",
            focalX: 0.5,
            focalY: 0.5,
          });
    if (plan !== undefined) {
      const worst = Math.max(plan.scaleX, plan.scaleY);
      // §7.3 upscale caps, same thresholds as asset_place: >125% warns, >200%
      // is a hard error the model can act on (re-run at a larger size).
      if (worst > UPSCALE_ERR_FACTOR) {
        return err(
          "validation_failed",
          `Placing the generated image needs ${plan.scalePercent}% — beyond the 200% upscale cap (§7.3)`,
          {
            hint: "Re-run image_generate with a larger size, or target a smaller bounds box.",
            retryable: false,
          },
        );
      }
      if (worst > UPSCALE_WARN_FACTOR) {
        warnings.push(
          `Generated image upscaled to ${plan.scalePercent}% of natural size (above the 125% advisory, §7.3); a larger size would stay sharper.`,
        );
      }
    }

    // 3. Charge the command meter once, for exactly what will be batched
    // (§5.2): place + transform? + rename + smart-object conversion.
    const commands: EngineCommand[] = [
      {
        id: PLACE_COMMAND,
        params: {
          path: stored.value.path,
          // 100% pins natural size (place-time implicit fit is off); the box
          // centre anchors the layer; smartObject:true pins the smart-object
          // embedding exactly like asset_place (W5-E, file_cmds.rs).
          scale: 100,
          smartObject: true,
          ...(plan !== undefined
            ? { center: [plan.placeCenterX, plan.placeCenterY] }
            : {}),
        },
      },
    ];
    if (plan !== undefined && !plan.isIdentity) {
      commands.push({
        id: TRANSFORM_COMMAND,
        // No `layer`: doc.place made the placed layer active (file_cmds.rs).
        params: {
          scaleX: plan.scaleX * 100,
          scaleY: plan.scaleY * 100,
          dx: plan.dx,
          dy: plan.dy,
        },
      });
    }
    const totalCommands = commands.length + 2; // + rename + convertToSmartObject
    if (!ictx.budgets.charge({ commands: totalCommands })) {
      return err("budget_exceeded", "The run's mutating-command budget is exhausted", {
        hint: "Stop cleanly here; the worker settles at most a partial charge (§5.2).",
        retryable: false,
      });
    }
    const placed = await ictx.engine.batch(commands, { transaction: true, signal });
    if (!placed.ok) {
      return err(placed.code, placed.message, {
        hint: placed.hint,
        retryable: placed.retryable,
      });
    }
    let revision = placed.value.revision;

    // 4. Confirm the placed layer by tree diff (the seam returns no command
    //    results); §10.2 naming needs the id, so a failed diff is a hard stop.
    const postLayers = await ictx.engine.listLayers();
    if (!postLayers.ok) {
      return err(postLayers.code, postLayers.message, {
        hint: postLayers.hint,
        retryable: postLayers.retryable,
      });
    }
    const placedLayerId = diffNewLayerId(preLayers.value, postLayers.value);
    if (placedLayerId === undefined) {
      return err("internal_error", "The placed layer could not be identified after placement", {
        hint: "The document changed unexpectedly; render a preview and retry once.",
        retryable: false,
      });
    }

    // 5. §10.2 naming (validator-enforced): "Photo — Generated".
    const renamed = await ictx.engine.batch(
      [
        {
          id: RENAME_COMMAND,
          params: { layer: placedLayerId, name: GENERATED_PHOTO_LAYER_NAME },
        },
      ],
      { transaction: true, signal },
    );
    if (!renamed.ok) {
      return err(renamed.code, renamed.message, {
        hint: renamed.hint,
        retryable: renamed.retryable,
      });
    }
    revision = renamed.value.revision;

    // 6. §6 row 7 chain: the explicit smart-object conversion, best effort
    // (asset_place pattern): doc.place already embeds a smart object, so a
    // refusal is the expected no-op — a warning, never a failure.
    const converted = await ictx.engine.execute(
      { id: SMART_OBJECT_COMMAND, params: { layer: placedLayerId } },
      { signal },
    );
    if (converted.ok) {
      revision = converted.value.revision;
    } else {
      ictx.logger.warn("image_generate: explicit convertToSmartObject refused", {
        layerId: placedLayerId,
      });
      warnings.push(
        'Smart-object conversion did not apply; doc.place already placed the image as a smart object (§6 row 7).',
      );
    }

    const requested = parseRequestedSize(args.size);
    if (requested.width !== check.widthPx || requested.height !== check.heightPx) {
      warnings.push(
        `The provider returned ${check.widthPx}×${check.heightPx} instead of ${args.size}; placement used the returned dimensions.`,
      );
    }

    ictx.logger.info("image_generate: placed", {
      quality: args.quality,
      size: args.size,
      bytes: generated.bytes.length,
      layerId: placedLayerId,
      revision,
      credits: cost,
    });

    return ok({
      summary:
        `Generated a ${args.quality} ${check.widthPx}×${check.heightPx} image and placed it as smart-object ` +
        `layer "${GENERATED_PHOTO_LAYER_NAME}" ${resolved.summaryAnchor}. ` +
        (args.quality === "draft"
          ? 'Next: render_preview to check composition, then re-run with quality "final" for the HD pass.'
          : "Next: render_preview to confirm the final image sits correctly in the composition."),
      documentRevision: revision,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  },
});
