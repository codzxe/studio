// @studio/tools — asset_place (§6 row 6): place a workspace image asset into a layer or slot.
//
// Flow (W5-E, spec §6 row 6): resolve the asset through the `ctx.assets` seam →
// resolve the target layer (layer tree) or slot (TemplateCatalogLike layer map,
// §7.2) → `doc.place` inside the workspace capability root (§15.1 / §25 rule 6:
// the asset key space of packages/storage/src/keys.ts) → `edit.transform` for
// the fit/focal math → smart-object conversion per §6 → compact ok().
//
// Engine param shapes are the pinned vendor's, verified against its sources:
//   - doc.place {path, scale? (%), center? [x,y], smartObject?} — headless doc
//     place → file_cmds.rs place_bytes: `scale` is a percent, `center` is the
//     layer centre, and the placed layer becomes the ACTIVE layer; place embeds
//     a Smart Object ("Always Create Smart Objects When Placing", on by default
//     — passing smartObject:true pins it and keeps the original asset reference).
//   - edit.transform relative form (transform_cmds.rs): `scaleX`/`scaleY` in
//     PERCENT about the frame's centre, then `dx`/`dy` in pixels — exactly how
//     a Photoshop action records a Free Transform. Omitting `layer` targets the
//     active layer, which doc.place just set to the placed one.
//   - layer.smartObjects.convertToSmartObject {layer?} — best-effort follow-up:
//     doc.place already embeds a smart object, so the engine reports the
//     expected "already a smart object" refusal; that is a warning, never a
//     failure (the placement itself is committed and keeps the asset reference).

import { z } from "zod";
import {
  type LayerRef,
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
import type {
  EngineCommand,
  EngineFailure,
  EngineLayerSummary,
  Tool,
  ToolContext,
  ToolErr,
} from "../types.js";

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Canvas-space cap (the vendor's doc.new accepts up to 300000 px per side). */
export const MAX_CANVAS_PX = 300_000;
/** §7.3: upscaling a small asset past 125% warns… */
export const UPSCALE_WARN_FACTOR = 1.25;
/** …and past 200% is a hard error. */
export const UPSCALE_ERR_FACTOR = 2;

const PLACE_COMMAND = "doc.place";
const TRANSFORM_COMMAND = "edit.transform";
const SMART_OBJECT_COMMAND = "layer.smartObjects.convertToSmartObject";

// ---------------------------------------------------------------------------
// Argument schema (§6.1 strict: additionalProperties false, caps, guards)
// ---------------------------------------------------------------------------

/** Finite-number guard: z.number() already rejects NaN; Infinity must be refined out. */
const finitePx = z.number().refine((value) => Number.isFinite(value), {
  message: "bounds must be finite numbers (NaN and ±Infinity are rejected)",
});

const inCanvas = (value: number) => value >= 0 && value <= MAX_CANVAS_PX;

/** [x, y, w, h] in canvas pixels: x,y ≥ 0, w,h > 0, each ≤ MAX_CANVAS_PX. */
export const zBounds = z
  .tuple([finitePx, finitePx, finitePx, finitePx])
  .refine(
    ([x, y, w, h]) => inCanvas(x) && inCanvas(y) && w > 0 && h > 0 && inCanvas(w) && inCanvas(h),
    {
      message: `bounds are [x, y, w, h] in canvas pixels: x,y ≥ 0, w,h > 0, each ≤ ${MAX_CANVAS_PX}`,
    },
  );

export type Bounds = z.infer<typeof zBounds>;

/** Focal point of the source image, 0..1 per axis (CSS object-position semantics). */
const zFocal = strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const zTarget = strictObject({
  /** Template slot name; resolved through the catalog's layer map (§7.2). */
  slot: cappedString(120, 1).optional(),
  /** layer_id or layer_name — the kit's §6.1 reference. */
  layer: zLayerRef.optional(),
  /** Explicit destination box; overrides the target layer's own bounds. */
  bounds: zBounds.optional(),
})
  .refine((target) => !(target.slot !== undefined && target.layer !== undefined), {
    message: "target: pass either slot or layer, not both",
  })
  .refine(
    (target) =>
      target.slot !== undefined || target.layer !== undefined || target.bounds !== undefined,
    {
      message: "target: one of slot, layer, or bounds is required",
    },
  );

export const assetPlaceArgs = strictObject({
  asset_id: z.string().uuid(),
  target: zTarget,
  fit: z.enum(["cover", "contain", "fill"]).default("cover"),
  focal: zFocal.optional(),
  idempotency_key: zIdempotencyKey,
});

export type AssetPlaceArgs = z.infer<typeof assetPlaceArgs>;

// ---------------------------------------------------------------------------
// Fit / focal math (pure, table-testable)
// ---------------------------------------------------------------------------

export type FitMode = "cover" | "contain" | "fill";

export interface FitInput {
  readonly boxX: number;
  readonly boxY: number;
  readonly boxW: number;
  readonly boxH: number;
  readonly assetW: number;
  readonly assetH: number;
  readonly fit: FitMode;
  readonly focalX: number;
  readonly focalY: number;
}

export interface FitPlan {
  /** Per-axis scale factors (fill is non-uniform). */
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaledW: number;
  readonly scaledH: number;
  /** edit.transform translate in pixels, applied after the centre-anchored scale. */
  readonly dx: number;
  readonly dy: number;
  /** doc.place centre: the destination box's centre; the image lands there at 100%. */
  readonly placeCenterX: number;
  readonly placeCenterY: number;
  /** Worst-axis scale in whole percent, for the summary and the §7.3 checks. */
  readonly scalePercent: number;
  /** True when no transform is needed (natural size, centred, no focal shift). */
  readonly isIdentity: boolean;
}

/**
 * cover scales by max(boxW/assetW, boxH/assetH) — fills the box, crops the rest;
 * contain scales by min — fits inside, letterboxes; fill stretches per axis.
 * The focal point slides the scaled image inside the box slack (object-position:
 * 0 aligns to the left/top edge, 0.5 centres, 1 to the right/bottom), which
 * after the centre-anchored scale is a pure translation of
 * (focal − 0.5) × (box − scaled) per axis.
 */
export function computeFit(input: FitInput): FitPlan {
  const { boxX, boxY, boxW, boxH, assetW, assetH, fit, focalX, focalY } = input;
  const uniform =
    fit === "cover"
      ? Math.max(boxW / assetW, boxH / assetH)
      : fit === "contain"
        ? Math.min(boxW / assetW, boxH / assetH)
        : undefined;
  const scaleX = uniform ?? boxW / assetW;
  const scaleY = uniform ?? boxH / assetH;
  const scaledW = assetW * scaleX;
  const scaledH = assetH * scaleY;
  const dx = (focalX - 0.5) * (boxW - scaledW);
  const dy = (focalY - 0.5) * (boxH - scaledH);
  const epsilon = 1e-9;
  return {
    scaleX,
    scaleY,
    scaledW,
    scaledH,
    dx,
    dy,
    placeCenterX: boxX + boxW / 2,
    placeCenterY: boxY + boxH / 2,
    scalePercent: Math.round(Math.max(scaleX, scaleY) * 100),
    isIdentity:
      Math.abs(scaleX - 1) < epsilon &&
      Math.abs(scaleY - 1) < epsilon &&
      Math.abs(dx) < epsilon &&
      Math.abs(dy) < epsilon,
  };
}

// ---------------------------------------------------------------------------
// Asset guards (tenancy §15.1, capability roots §25 rule 6)
// ---------------------------------------------------------------------------

/**
 * The engine-visible location must be a relative key inside THIS workspace's
 * asset prefix — the key space of packages/storage/src/keys.ts:
 * assets/organizations/<orgId>/assets/<assetId>[/<filename>]. Absolute paths,
 * URL schemes and traversal never reach doc.place.
 */
export function isPlaceableAssetPath(storageUrl: string, organizationId: string): boolean {
  const prefix = `assets/organizations/${organizationId}/assets/`;
  if (!storageUrl.startsWith(prefix) || storageUrl.length > 1024) {
    return false;
  }
  if (storageUrl.includes("\\") || storageUrl.includes("..") || storageUrl.includes(":")) {
    return false;
  }
  for (let i = 0; i < storageUrl.length; i += 1) {
    const code = storageUrl.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Target resolution (§6.1: ids or names; ambiguity lists candidates)
// ---------------------------------------------------------------------------

interface ResolvedLayer {
  readonly layerId: string;
  readonly name: string;
}

/** ToolErr always carries ok:false; the success shapes never do. */
function isErr<T>(value: T | ToolErr): value is ToolErr {
  return (value as { ok?: unknown }).ok === false;
}

/** layer_id or layer_name against the live tree: not found / ambiguity per §6.1. */
function resolveLayerRef(
  ref: LayerRef,
  layers: readonly EngineLayerSummary[],
): ResolvedLayer | ToolErr {
  if ("layerId" in ref) {
    const found = layers.find((layer) => layer.layerId === ref.layerId);
    return found === undefined
      ? layerNotFoundErr(ref.layerId)
      : { layerId: found.layerId, name: found.name };
  }
  const matches = layers.filter((layer) => layer.name === ref.layerName);
  const [first] = matches;
  if (first === undefined) {
    return layerNotFoundErr(ref.layerName);
  }
  if (matches.length > 1) {
    return ambiguousLayerErr(
      ref.layerName,
      matches.map((layer) => `${layer.name} (${layer.layerId})`),
    );
  }
  return { layerId: first.layerId, name: first.name };
}

/** A §7.2 layer-map entry may be an id or a name; undefined when unresolvable/ambiguous. */
function resolveMappedRef(
  ref: string,
  layers: readonly EngineLayerSummary[],
): ResolvedLayer | undefined {
  const byId = layers.find((layer) => layer.layerId === ref);
  if (byId !== undefined) {
    return { layerId: byId.layerId, name: byId.name };
  }
  const byName = layers.filter((layer) => layer.name === ref);
  const [first] = byName;
  return byName.length === 1 && first !== undefined
    ? { layerId: first.layerId, name: first.name }
    : undefined;
}

/**
 * Slot → layer through the template catalog (§6 row 6, §7.2 layerMap): every
 * manifest defining this image slot contributes a candidate layer ref; the
 * refs are resolved against the live tree and deduped by layer id. Exactly one
 * surviving layer wins; several are an `ambiguous_layer` with candidates.
 */
async function resolveSlotTarget(
  ctx: ToolContext,
  slot: string,
  layers: readonly EngineLayerSummary[],
): Promise<ResolvedLayer | ToolErr> {
  const summaries = await ctx.templates.list();
  const candidateRefs: { template: string; ref: string }[] = [];
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
    const ref = manifest.layerMap?.[slot];
    if (typeof ref === "string" && ref.length > 0) {
      candidateRefs.push({ template: `${manifest.id}@${manifest.version}`, ref });
    }
  }
  if (candidateRefs.length === 0) {
    if (nonImageKind !== undefined) {
      return err("invalid_slots", `Slot "${slot}" is a ${nonImageKind} slot, not an image slot`, {
        hint: "Image assets place into image slots only; inspect the template with template_inspect.",
        retryable: false,
      });
    }
    const known = [...imageSlots].sort().slice(0, 10).join(", ");
    return err("unknown_slots", `No template in the catalog defines an image slot "${slot}"`, {
      hint:
        known.length > 0
          ? `Image slots: ${known}`
          : "No image slots are defined in the catalog; address a layer or a bounds box instead.",
      retryable: false,
    });
  }
  const resolved = new Map<string, string>();
  const mapping: string[] = [];
  for (const candidate of candidateRefs) {
    const layer = resolveMappedRef(candidate.ref, layers);
    mapping.push(`${candidate.template}:${slot}→"${candidate.ref}"`);
    if (layer !== undefined) {
      resolved.set(layer.layerId, layer.name);
    }
  }
  if (resolved.size === 0) {
    return err("layer_not_found", `The layers mapped to slot "${slot}" are not in this document`, {
      hint: `Mapped: ${mapping.slice(0, 5).join("; ")}. Apply the template first, or address a layer directly.`,
      retryable: false,
    });
  }
  if (resolved.size > 1) {
    const candidates = [...resolved.entries()].map(([id, name]) => `${name} (${id})`).slice(0, 10);
    return err("ambiguous_layer", `Slot "${slot}" resolves to ${resolved.size} different layers`, {
      hint: `Address one directly with target.layer.layerId. Candidates: ${candidates.join(", ")}`,
      retryable: false,
    });
  }
  const [entry] = [...resolved.entries()];
  if (entry === undefined) {
    return err("internal_error", "The tool failed unexpectedly");
  }
  return { layerId: entry[0], name: entry[1] };
}

export interface ResolvedTarget {
  readonly boxX: number;
  readonly boxY: number;
  readonly boxW: number;
  readonly boxH: number;
  /** Present when a document layer is the destination (slot or layer ref). */
  readonly layerId?: string;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
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

/** Explicit bounds beat the layer's own box; §7.3 slot bounds otherwise. */
async function resolveTarget(
  ctx: ToolContext,
  target: { readonly slot?: string; readonly layer?: LayerRef; readonly bounds?: Bounds },
  layers: readonly EngineLayerSummary[],
): Promise<ResolvedTarget | ToolErr> {
  let layer: ResolvedLayer | undefined;
  if (target.slot !== undefined) {
    const resolved = await resolveSlotTarget(ctx, target.slot, layers);
    if (isErr(resolved)) {
      return resolved;
    }
    layer = resolved;
  } else if (target.layer !== undefined) {
    const resolved = resolveLayerRef(target.layer, layers);
    if (isErr(resolved)) {
      return resolved;
    }
    layer = resolved;
  }
  if (target.bounds !== undefined) {
    const [x, y, w, h] = target.bounds;
    return { boxX: x, boxY: y, boxW: w, boxH: h, layerId: layer?.layerId };
  }
  if (layer === undefined) {
    // The schema requires one of slot/layer/bounds; a defensive rejection only.
    return err("invalid_args", "Target needs a slot, a layer, or a bounds box");
  }
  const summary = layers.find((candidate) => candidate.layerId === layer.layerId);
  const box = summary !== undefined ? layerBoundsBox(summary) : undefined;
  if (box === undefined) {
    return err("validation_failed", `Target layer "${layer.name}" reports no usable bounds`, {
      hint: "Pass target.bounds [x, y, w, h] explicitly (§7.3 image-slot bounds).",
      retryable: false,
    });
  }
  return { boxX: box.x, boxY: box.y, boxW: box.w, boxH: box.h, layerId: layer.layerId };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** Engine seam failures pass through with their sanitized code (§6.1). */
function engineErr(failure: EngineFailure): ToolErr {
  return err(failure.code, failure.message, { hint: failure.hint, retryable: failure.retryable });
}

export const assetPlaceTool: Tool<AssetPlaceArgs> = defineTool({
  name: "asset_place",
  description:
    "Place a workspace image asset into a layer or template slot with cover, contain or fill fit, focal framing and smart-object placement.",
  args: assetPlaceArgs,
  async run(ctx, args, signal) {
    // 1. Layer tree first: target resolution and the post-batch diff both need it.
    const preLayers = await ctx.engine.listLayers();
    if (!preLayers.ok) {
      return engineErr(preLayers);
    }
    const target = await resolveTarget(ctx, args.target, preLayers.value);
    if (isErr(target)) {
      return target;
    }

    // 2. Asset: an unknown id lists candidates; tenancy and capability-root paths are guarded.
    const asset = await ctx.assets.get(args.asset_id);
    if (asset === undefined) {
      const candidates = await ctx.assets.search("", { limit: 5 });
      const list = candidates
        .slice(0, 5)
        .map((record) => `${record.assetId} (${record.filename})`)
        .join(", ");
      return err("not_found", "This asset is not in the workspace library", {
        hint:
          list.length > 0
            ? `Did you mean: ${list}? Find ids with asset_search.`
            : "Find asset ids with asset_search first.",
        retryable: false,
      });
    }
    if (asset.organizationId !== ctx.workspace.organizationId) {
      return err("cross_tenant_denied", "The asset belongs to another workspace", {
        hint: "Placement stays inside the caller's workspace (§15.1); search this library with asset_search.",
        retryable: false,
      });
    }
    if (!isPlaceableAssetPath(asset.storageUrl, ctx.workspace.organizationId)) {
      return err(
        "invalid_args",
        "The asset's storage location is not a workspace-relative asset key",
        {
          hint: "Expected assets/organizations/<orgId>/assets/<assetId>; absolute paths and URLs never reach the engine (§25 rule 6).",
          retryable: false,
        },
      );
    }

    // 3. Fit/focal math (§7.3): recorded dimensions make it exact; unknown dims place at 100%.
    const warnings: string[] = [];
    const assetW = asset.widthPx;
    const assetH = asset.heightPx;
    const dims =
      typeof assetW === "number" &&
      typeof assetH === "number" &&
      Number.isFinite(assetW) &&
      Number.isFinite(assetH) &&
      assetW > 0 &&
      assetH > 0
        ? { w: assetW, h: assetH }
        : undefined;
    const plan: FitPlan =
      dims !== undefined
        ? computeFit({
            boxX: target.boxX,
            boxY: target.boxY,
            boxW: target.boxW,
            boxH: target.boxH,
            assetW: dims.w,
            assetH: dims.h,
            fit: args.fit,
            focalX: args.focal?.x ?? 0.5,
            focalY: args.focal?.y ?? 0.5,
          })
        : {
            scaleX: 1,
            scaleY: 1,
            scaledW: 0,
            scaledH: 0,
            dx: 0,
            dy: 0,
            placeCenterX: target.boxX + target.boxW / 2,
            placeCenterY: target.boxY + target.boxH / 2,
            scalePercent: 100,
            isIdentity: true,
          };
    if (dims === undefined) {
      warnings.push(
        "Asset dimensions are not recorded; placed at natural size centred in the target — fit/focal not applied.",
      );
    } else {
      const worst = Math.max(plan.scaleX, plan.scaleY);
      if (worst > UPSCALE_ERR_FACTOR) {
        return err(
          "validation_failed",
          `Placing "${asset.filename}" needs ${plan.scalePercent}% — beyond the 200% upscale cap (§7.3)`,
          {
            hint: "Use a larger source asset (asset_search) or a smaller target box.",
            retryable: false,
          },
        );
      }
      if (worst > UPSCALE_WARN_FACTOR) {
        warnings.push(
          `Asset upscaled to ${plan.scalePercent}% of natural size (above the 125% advisory, §7.3); a larger asset would stay sharper.`,
        );
      }
    }

    // 4. Charge the run budget before mutating (§5.2; the executor re-checks afterwards).
    if (!ctx.budgets.charge({ commands: plan.isIdentity ? 2 : 3 })) {
      return err("budget_exceeded", "The run's mutating-command budget is exhausted", {
        hint: "Stop cleanly here; the document keeps what earlier tools placed (§5.2).",
        retryable: false,
      });
    }

    // 5. One transactional batch: place at the box centre, then transform (fit/focal).
    const commands: EngineCommand[] = [
      {
        id: PLACE_COMMAND,
        params: {
          path: asset.storageUrl,
          // 100% pins natural size (the engine's implicit place-time fit is off);
          // centre = the destination box centre; smartObject keeps the source ref.
          scale: 100,
          center: [plan.placeCenterX, plan.placeCenterY],
          smartObject: true,
        },
      },
    ];
    if (!plan.isIdentity) {
      commands.push({
        id: TRANSFORM_COMMAND,
        // No `layer`: doc.place made the placed layer active (file_cmds.rs).
        params: { scaleX: plan.scaleX * 100, scaleY: plan.scaleY * 100, dx: plan.dx, dy: plan.dy },
      });
    }
    const batch = await ctx.engine.batch(commands, { transaction: true, signal });
    if (!batch.ok) {
      return engineErr(batch);
    }
    let revision = batch.value.revision;

    // 6. Confirm the placed layer by tree diff (the seam returns no command results).
    let placedLayerId: string | undefined;
    const postLayers = await ctx.engine.listLayers();
    if (postLayers.ok) {
      const before = new Set(preLayers.value.map((layer) => layer.layerId));
      const added = postLayers.value.filter((layer) => !before.has(layer.layerId));
      const [first] = added;
      if (added.length === 1 && first !== undefined) {
        placedLayerId = first.layerId;
      }
    }
    if (placedLayerId === undefined) {
      warnings.push("The placed layer id could not be confirmed; check the layer tree with workspace_snapshot.");
    } else {
      // 7. Smart-object conversion per §6 — best effort: doc.place already embeds the
      // asset as a smart object, so a refusal is the expected no-op, not a failure.
      const converted = await ctx.engine.execute(
        { id: SMART_OBJECT_COMMAND, params: { layer: placedLayerId } },
        { signal },
      );
      if (converted.ok) {
        revision = converted.value.revision;
      } else {
        warnings.push(
          "Smart-object conversion did not apply; the placed layer keeps the asset's original reference through doc.place's smart-object placement (§6 row 6).",
        );
      }
    }

    const placed = {
      assetId: asset.assetId,
      layerId: placedLayerId ?? null,
      fit: args.fit,
      scalePercent: plan.scalePercent,
    };
    ctx.logger.debug("asset_place", {
      assetId: asset.assetId,
      fit: args.fit,
      scalePercent: plan.scalePercent,
    });
    return ok({
      summary: `{"placed":${JSON.stringify(placed)}}`,
      documentRevision: revision,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  },
});
