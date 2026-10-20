// @studio/tools — image_generate (§6 row 7; §5.2 image tiers; §5.3 image routes).
// Owner: W5-F.
//
// Generate a raster image (draft/final) from a prompt and place it as a
// smart-object layer named "Photo — Generated" (§10.2). Flow (§6 row 7):
//   charge credits → external image API (injected provider) → PNG validation
//   → persist inside the workspace capability root → `doc.place`
//   → rename → `layer.smartObjects.convertToSmartObject` (§6 row 7 chain).
//
// Seam notes (types.ts ctx is minimal by design; this tool's extra seams are
// declared here and wired by the agent runtime/worker — see worklog):
//   - `CreditSpender`: types.ts `ctx.budgets` (BudgetTracker) has NO
//     `spendCredits(amount, reason)` member; this file declares the credit
//     seam the §14.2 ledger worker conforms to. Reported for types.ts adoption.
//   - `ImageProviderLike`: the worker wires the §5.3 model router — drafts →
//     `imageDrafts` (Flux 2 Schnell), finals → `imageFinals` (Gemini 3 Pro
//     Image / GPT Image 1.5 HD). Routing NEVER happens inside the tool, and
//     the provider must use paid API keys only (§1.5 constraint 6: customer
//     content never flows through free LLM tiers).
//   - `GeneratedImageSinkLike`: `doc.place` reads files by capability-scoped
//     path (§3.2, §15.1), so the worker persists the returned bytes inside the
//     workspace root and hands back the engine-visible path.
//
// Budget: 1 tool call per image tier run (§5.2); the executor enforces the
// tool-call cap, the tool charges the command meter via `ctx.budgets`.

import { ENGINE_PNG_MAX_BYTES } from "@studio/config";
import { z } from "zod";
import {
  ToolError,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
  zIdempotencyKey,
  zLayerRef,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import type {
  EngineBounds,
  EngineCommand,
  EngineLayerSummary,
  EngineOutcome,
  TemplateManifest,
  Tool,
  ToolContext,
  ToolErr,
} from "../types.js";

// ---------------------------------------------------------------------------
// Constants (§5.2 credit table, §10.2 naming, task prompt cap)
// ---------------------------------------------------------------------------

/** §5.2 image tiers: each 1024² draft = 1 credit, HD/final = 2 credits. */
export const IMAGE_CREDIT_COST = { draft: 1, final: 2 } as const;

/** §10.2 Photo pattern with the generated-image subject (task-pinned name). */
export const GENERATED_PHOTO_LAYER_NAME = "Photo — Generated";

/** Task cap: prompts are ≤ 1500 chars (and sanitized below, §15.3). */
export const MAX_PROMPT_CHARS = 1500;

// ---------------------------------------------------------------------------
// Argument schema (§6.1: strict, capped; §6.2 shape)
// ---------------------------------------------------------------------------

export const IMAGE_SIZE_SCHEMA = z.enum(["1024x1024", "1792x1024", "1024x1792"]);
export type ImageSize = z.output<typeof IMAGE_SIZE_SCHEMA>;

export const IMAGE_QUALITY_SCHEMA = z.enum(["draft", "final"]);
export type ImageQuality = z.output<typeof IMAGE_QUALITY_SCHEMA>;

const zTargetBounds = strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(1),
  height: z.number().finite().min(1),
});

function atMostOneAnchor(target: {
  slot?: unknown;
  layer?: unknown;
  bounds?: unknown;
}): boolean {
  const anchors = [target.slot, target.layer, target.bounds].filter(
    (value) => value !== undefined,
  );
  return anchors.length <= 1;
}

const zTarget = strictObject({
  /** Template slot name; resolved through the applied template's layer map. */
  slot: cappedString(100, 1).optional(),
  /** Existing layer to place over (id or name; §6.1 XOR enforced by zLayerRef). */
  layer: zLayerRef.optional(),
  /** Explicit rectangle; the image is cover-fitted into it. */
  bounds: zTargetBounds.optional(),
}).refine(atMostOneAnchor, {
  message: "target: provide at most one of slot, layer or bounds; none = place above the active layer",
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
 * the model router — drafts: Flux 2 Schnell (`imageDrafts`), finals: Gemini 3
 * Pro Image (`imageFinals`) — never inside the tool. Paid endpoints only
 * (§1.5-6). §15.3: the provider sees workspace data NO further than the
 * prompt string handed to `generate`; it never receives document contents,
 * layer data, brand tokens, or tenant identifiers, and `store: false` /
 * no-training settings are the implementation's responsibility.
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
 * returns the engine-visible path for `doc.place` (§3.2, §15.1 — `doc.place`
 * only reads beneath its read root, so bytes cannot go straight to the engine).
 */
export interface GeneratedImageSinkLike {
  put(bytes: Uint8Array, fileName: string): Promise<EngineOutcome<{ readonly path: string }>>;
}

/**
 * The context the worker must assemble for `image_generate`: the base
 * `ToolContext` plus the three seams above and (when the run's document came
 * from `template_apply`) the applied template ref, so `target.slot` resolves.
 */
export interface ImageGenerateContext extends ToolContext {
  readonly credits: CreditSpender;
  readonly imageProvider: ImageProviderLike;
  readonly generatedImages: GeneratedImageSinkLike;
  /** `id@version` of the template applied to the active document, if any (§7.2). */
  readonly appliedTemplateRef?: string;
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

/** `doc.place` placement params for cover-fitting an image into a rect (§7.3 default fit). */
export interface PlacementSpec {
  readonly scalePercent?: number;
  readonly center?: readonly [number, number];
}

/** Cover fit: the image fills the rect, centred, aspect preserved (crop-style). */
export function coverPlacement(
  rect: EngineBounds,
  widthPx: number,
  heightPx: number,
): PlacementSpec {
  const scale = Math.max(rect.width / widthPx, rect.height / heightPx);
  return {
    scalePercent: Math.round(scale * 100 * 100) / 100,
    center: [rect.x + rect.width / 2, rect.y + rect.height / 2],
  };
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

/** Where the generated image goes, resolved before any engine command runs. */
export interface ResolvedTarget {
  /** Select this layer first so `doc.place` lands directly above it. */
  readonly aboveLayerId?: string;
  /** Omitted for the default target → natural size above the active layer. */
  readonly placement?: PlacementSpec;
  /** §6.1 small-reply fragment describing the anchor. */
  readonly summaryAnchor: string;
}

function findLayer(
  tree: readonly EngineLayerSummary[],
  idOrName: string,
): { layer: EngineLayerSummary } | { ambiguous: readonly EngineLayerSummary[] } | undefined {
  const byId = tree.find((layer) => layer.layerId === idOrName);
  if (byId !== undefined) {
    return { layer: byId };
  }
  const byName = tree.filter((layer) => layer.name === idOrName);
  if (byName.length === 1) {
    return { layer: byName[0] };
  }
  return byName.length > 1 ? { ambiguous: byName } : undefined;
}

function layerRefString(ref: { readonly layerId?: string; readonly layerName?: string }): string {
  return ref.layerId !== undefined ? ref.layerId : (ref.layerName ?? "");
}

function resolveLayerRect(
  tree: readonly EngineLayerSummary[],
  idOrName: string,
): { rect: EngineBounds; layer: EngineLayerSummary } | ToolErr {
  const found = findLayer(tree, idOrName);
  if (found === undefined) {
    return err("layer_not_found", "No layer matched this reference", {
      hint: `Check the layer tree with workspace_snapshot; got "${shortName(idOrName)}"`,
      retryable: false,
    });
  }
  if ("ambiguous" in found) {
    return err(
      "ambiguous_layer",
      `Layer name "${shortName(idOrName)}" matches ${found.ambiguous.length} layers`,
      {
        hint: `Address one by layer_id instead. Candidates: ${found.ambiguous
          .slice(0, 10)
          .map((layer) => layer.layerId)
          .join(", ")}`,
        retryable: false,
      },
    );
  }
  const { layer } = found;
  if (layer.bounds === undefined) {
    return err("validation_failed", "The target layer has no pixel bounds to place into", {
      hint: "Groups and empty layers have no bounds; pass target.bounds or pick a pixel layer.",
      retryable: false,
    });
  }
  return { rect: layer.bounds, layer };
}

async function resolveSlotTarget(
  ictx: ImageGenerateContext,
  slot: string,
  tree: readonly EngineLayerSummary[],
): Promise<{ rect: EngineBounds; layer: EngineLayerSummary } | ToolErr> {
  const templateRef = ictx.appliedTemplateRef;
  if (templateRef === undefined) {
    return err(
      "unknown_slots",
      "The run's document has no known applied template for slot targets",
      {
        hint: 'Pass target.layer or target.bounds instead of target.slot, or apply a template first (§7).',
        retryable: false,
      },
    );
  }
  const manifest: TemplateManifest | undefined = await ictx.templates.get(templateRef);
  if (manifest === undefined) {
    return err("not_found", "The applied template manifest is unavailable", {
      hint: `The template catalog has no "${shortName(templateRef)}"; pass target.layer or target.bounds instead.`,
      retryable: false,
    });
  }
  const mapped = manifest.layerMap?.[slot];
  if (mapped === undefined) {
    const known = Object.keys(manifest.layerMap ?? {});
    return err(
      "unknown_slots",
      `Slot "${shortName(slot)}" has no layer mapping in the applied template`,
      {
        hint:
          known.length > 0
            ? `Mapped slots: ${known.slice(0, 10).join(", ")}${known.length > 10 ? ` (+${known.length - 10} more)` : ""}`
            : "The manifest has no layer map; pass target.layer or target.bounds instead.",
        retryable: false,
      },
    );
  }
  return resolveLayerRect(tree, mapped);
}

/** Resolves `target` against the layer tree; failures are values, never throws. */
export async function resolveTarget(
  ictx: ImageGenerateContext,
  target: ImageGenerateArgs["target"],
  tree: readonly EngineLayerSummary[],
  imageWidthPx: number,
  imageHeightPx: number,
): Promise<{ readonly ok: true; readonly target: ResolvedTarget } | ToolErr> {
  if (target.bounds !== undefined) {
    return {
      ok: true,
      target: {
        placement: coverPlacement(target.bounds, imageWidthPx, imageHeightPx),
        summaryAnchor: "at the given bounds",
      },
    };
  }
  if (target.slot !== undefined) {
    const slotLayer = await resolveSlotTarget(ictx, target.slot, tree);
    if (!("rect" in slotLayer)) {
      return slotLayer;
    }
    return {
      ok: true,
      target: {
        aboveLayerId: slotLayer.layer.layerId,
        placement: coverPlacement(slotLayer.rect, imageWidthPx, imageHeightPx),
        summaryAnchor: `into slot "${shortName(target.slot)}" (over layer "${shortName(slotLayer.layer.name)}")`,
      },
    };
  }
  if (target.layer !== undefined) {
    const idOrName = layerRefString(target.layer);
    const resolved = resolveLayerRect(tree, idOrName);
    if (!("rect" in resolved)) {
      return resolved;
    }
    return {
      ok: true,
      target: {
        aboveLayerId: resolved.layer.layerId,
        placement: coverPlacement(resolved.rect, imageWidthPx, imageHeightPx),
        summaryAnchor: `over layer "${shortName(resolved.layer.name)}"`,
      },
    };
  }
  return { ok: true, target: { summaryAnchor: "above the active layer" } };
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

    const before = await ictx.engine.listLayers();
    if (!before.ok) {
      return err(before.code, before.message, { hint: before.hint, retryable: before.retryable });
    }

    const resolution = await resolveTarget(
      ictx,
      args.target,
      before.value,
      check.widthPx,
      check.heightPx,
    );
    if (!resolution.ok) {
      return resolution;
    }
    const resolved = resolution.target;

    const placeParams: Record<string, unknown> = { path: stored.value.path };
    if (resolved.placement?.scalePercent !== undefined) {
      placeParams.scale = resolved.placement.scalePercent;
    }
    if (resolved.placement?.center !== undefined) {
      placeParams.center = [...resolved.placement.center];
    }
    const batchA: EngineCommand[] = [];
    if (resolved.aboveLayerId !== undefined) {
      batchA.push({
        id: "layer.select",
        params: { layer: resolved.aboveLayerId, mode: "replace" },
      });
    }
    batchA.push({ id: "doc.place", params: placeParams });

    if (!ictx.budgets.charge({ commands: batchA.length })) {
      return err("budget_exceeded", "The run's mutating-command budget is exhausted", {
        hint: "Stop cleanly here; the worker settles at most a partial charge (§5.2).",
        retryable: false,
      });
    }
    const placed = await ictx.engine.batch(batchA, { transaction: true, signal });
    if (!placed.ok) {
      return err(placed.code, placed.message, {
        hint: placed.hint,
        retryable: placed.retryable,
      });
    }

    const after = await ictx.engine.listLayers();
    if (!after.ok) {
      return err(after.code, after.message, { hint: after.hint, retryable: after.retryable });
    }
    const placedLayerId = diffNewLayerId(before.value, after.value);
    if (placedLayerId === undefined) {
      return err("internal_error", "The placed layer could not be identified after placement", {
        hint: "The document changed unexpectedly; render a preview and retry once.",
        retryable: false,
      });
    }

    // §10.2 naming (validator-enforced): "Photo — Generated".
    if (!ictx.budgets.charge({ commands: 1 })) {
      return err("budget_exceeded", "The run's mutating-command budget is exhausted", {
        hint: "The image is placed but unnamed; stop cleanly and let the worker settle (§5.2).",
        retryable: false,
      });
    }
    const renameCmd: EngineCommand = {
      id: "layer.setProps",
      params: { layer: placedLayerId, name: GENERATED_PHOTO_LAYER_NAME },
    };
    const renamed = await ictx.engine.batch([renameCmd], { transaction: true, signal });
    if (!renamed.ok) {
      return err(renamed.code, renamed.message, {
        hint: renamed.hint,
        retryable: renamed.retryable,
      });
    }

    const warnings: string[] = [];
    let revision = renamed.value.revision;

    // §6 row 7 chain: the explicit smart-object conversion. doc.place already
    // embeds as a smart object (control-protocol), so a refusal here is a
    // warning, never a failure — reported outside the rename transaction so a
    // provider/protocol quirk cannot roll the placement back.
    if (!ictx.budgets.charge({ commands: 1 })) {
      warnings.push(
        "The explicit smart-object conversion was skipped: the command budget ran out (§5.2).",
      );
    } else {
      const convert = await ictx.engine.execute(
        { id: "layer.smartObjects.convertToSmartObject", params: { layer: placedLayerId } },
        { signal },
      );
      if (!convert.ok) {
        ictx.logger.warn("image_generate: explicit convertToSmartObject refused", {
          layerId: placedLayerId,
        });
        warnings.push(
          'The explicit smart-object conversion was skipped; doc.place already placed the image as a smart object (§6 row 7).',
        );
      } else {
        revision = convert.value.revision;
      }
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
