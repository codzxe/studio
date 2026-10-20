// layout-apply.ts — §6 row 11 `layout_apply`: the declarative-layout bridge.
//
// Constraints, not coordinates (§9.1): the model describes STRUCTURE (stacks, rows,
// grids, centering, fit modes, safe areas); the engine solves geometry. This tool is
// a thin, contract-enforcing forwarder to the engine's `layout.apply` (§9.4):
//
//   - The args schema mirrors the engine's serde node model EXACTLY — field names,
//     enums and ranges come from engine-patches/layout_cmds/layout_apply.rs
//     (StackNode/RowNode/…/DividerNode + the flattened Sizing struct) and
//     engine-patches/docs/commands.md §`layout.apply`. A tree the tool accepts is a
//     tree the engine accepts; a tree the engine rejects is rejected here first,
//     as an actionable `invalid_args` (§6.1) instead of a raw engine bad_params.
//   - The model never emits raw coordinates: `x`/`y` exist ONLY on children of an
//     `absolute` node (required there), `dx`/`dy` only on `center` children (§9.2).
//   - Tool-side caps are tighter than the engine's (§9.5): depth ≤ 32 (engine 64),
//     ≤ 256 nodes (engine 4096), ≤ 200 children per container (the kit's §6.1
//     array ceiling; the engine allows 512). Breaching either is "layout too
//     complex" — reported through the schema, so the boundary owns it.
//   - §9.5 finite law: every numeric is checked for NaN/±Infinity before the engine
//     is called (JSON `1e999` arrives as Infinity and dies here).
//
// Engine-reply channels (the EngineLike seam is structural, types.ts keeps it
// minimal): `layout.apply` returns `{ moved, warnings }`. The runtime adapter may
// hand it to the tool either spread onto the EngineCommandReport (structurally —
// extra fields are legal) or JSON-stringified into `message`. parseLayoutApplyReport
// reads both; when neither carries the payload the mutation is NOT failed — the tool
// reports `moved: 0` plus a verify warning (§6.1: results mirror the next step).

import { z } from "zod";
import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  MAX_WARNING_CHARS,
  MAX_WARNINGS,
  cappedArray,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
  zIdempotencyKey,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import {
  type EngineCommand,
  type EngineCommandReport,
  type EngineFailure,
  TOOL_ERROR_CODE_SCHEMA,
  type ToolErr,
} from "../types.js";

// ---------------------------------------------------------------------------
// §9.5 limits — tool caps first (tighter), then the engine's own ranges
// ---------------------------------------------------------------------------

/** Tool-level recursion cap (the engine's panic-hunt bound is 64, §9.5). */
export const LAYOUT_MAX_DEPTH = 32;
/** Tool-level node-count cap (the engine allows 4096, §9.5). */
export const LAYOUT_MAX_NODES = 256;
/**
 * Children per container: the kit's §6.1 array ceiling (the engine allows 512).
 * A tree with one 201-child container still fits 256 nodes, but the model should
 * compose groups instead — the cap keeps every array argument model-scale.
 */
export const LAYOUT_MAX_CHILDREN_PER_NODE = 200;
/** §9.5: gaps 0–256 px. */
export const LAYOUT_MAX_GAP_PX = 256;
/** §9.5: padding / safe-area sides 0–2048 px. */
export const LAYOUT_MAX_SIDE_PX = 2048;
/** §9.5: grid columns 1–24. */
export const LAYOUT_MAX_COLUMNS = 24;
/** Any single dimension in px (engine MAX_PX; also bounds x/y/dx/dy magnitude). */
export const LAYOUT_MAX_PX = 1_048_576;
/** Grow weights and aspect ratios are capped (engine MAX_GROW). */
export const LAYOUT_MAX_GROW = 1_000_000;
/** Tool cap for `options.safeArea` (§6 row 11; the engine would allow 2048). */
export const LAYOUT_MAX_SAFE_AREA_PX = 512;
/** How many moved-layer examples the compact summary keeps (§6.1 small replies). */
export const MAX_MOVED_EXAMPLES = 3;

/** §2.2: the live registry is authoritative — this is the engine-patch fix path. */
export const ENGINE_PATCH_HINT =
  "The engine registry does not serve layout.apply. Apply this repo's engine patches " +
  "(engine-patches/scripts/apply-engine-patches.sh) so layout_cmds registers layout.apply, " +
  "restart the engine, and retry; the live registry stays authoritative (§2.2).";

export const LAYOUT_APPLY_COMMAND_ID = "layout.apply";

// ---------------------------------------------------------------------------
// Numeric atoms (§9.5 finite law — NaN/±Infinity are errors, never defaults)
// ---------------------------------------------------------------------------

const FINITE_MESSAGE = "must be a finite number (NaN and ±Infinity are rejected, §9.5)";

/** z.number() alone admits NaN and ±Infinity through min/max gaps — the refine closes it. */
function finiteRange(minimum: number, maximum: number, what: string) {
  return z
    .number()
    .min(minimum, { message: `${what} must be ≥ ${minimum}` })
    .max(maximum, { message: `${what} must be ≤ ${maximum}` })
    .refine((value) => Number.isFinite(value), { message: `${what} ${FINITE_MESSAGE}` });
}

/** A finite px dimension, 0..LAYOUT_MAX_PX (width/height/min*/max*/spacer size). */
const zDimension = finiteRange(0, LAYOUT_MAX_PX, "this dimension");
/** A signed finite coordinate, |v| ≤ LAYOUT_MAX_PX (x, y, dx, dy, within-rect sides). */
const zCoordinate = z
  .number()
  .refine((value) => Number.isFinite(value) && Math.abs(value) <= LAYOUT_MAX_PX, {
    message: `coordinates must be finite and within ±${LAYOUT_MAX_PX} px (§9.5)`,
  });
/** Any finite number (engine-result box sides; validation only). */
const zFiniteNumber = z
  .number()
  .refine((value) => Number.isFinite(value), { message: `numbers ${FINITE_MESSAGE}` });

const zGap = finiteRange(0, LAYOUT_MAX_GAP_PX, "`gap`");
const zSide = finiteRange(0, LAYOUT_MAX_SIDE_PX, "each `padding` side");
const zSafeArea = finiteRange(0, LAYOUT_MAX_SAFE_AREA_PX, "`options.safeArea`");
/** Whole columns 1–24 (§9.5): 2.0 is fine, 2.5 and NaN are not. */
const zColumns = finiteRange(1, LAYOUT_MAX_COLUMNS, "`columns`").refine(
  (value) => Number.isInteger(value),
  { message: "`columns` must be a whole number" },
);
/** §9.2 sizing: `true` = weight 1, `false`/0 = does not grow, numbers ≥ 0. */
const zGrow = z.union([z.boolean(), finiteRange(0, LAYOUT_MAX_GROW, "`grow`")]);
const zPercent = z
  .number()
  .refine((value) => Number.isFinite(value) && value > 0 && value <= 100, {
    message: "`percent` is a share of the parent's main axis (1–100)",
  });
const zAspect = z
  .number()
  .refine((value) => Number.isFinite(value) && value > 0 && value <= LAYOUT_MAX_GROW, {
    message: "`aspect` must be a positive finite w/h ratio",
  });

/** `padding`: one side (all four) or CSS order [t, r, b, l] with 1, 2 or 4 sides. */
const zSides = z.union([
  zSide,
  z
    .array(zSide)
    .refine((sides) => sides.length === 1 || sides.length === 2 || sides.length === 4, {
      message: "`padding` must be one number or an array of 2 or 4 numbers",
    }),
]);

/** `layer`: the engine's raw id-or-name value (resolve_layer: u64 or non-empty name). */
const zNodeLayer = z.union([z.number().int().nonnegative(), cappedString(200, 1)]);

/** §9.2 `within`: a layer (its content bounds are the box) or an explicit rect. */
const zWithin = z.union([
  strictObject({ layer: zNodeLayer }),
  z
    .array(zCoordinate)
    .length(4)
    .refine(
      (rect) =>
        rect[2] !== undefined && rect[3] !== undefined && rect[2] >= 0 && rect[3] >= 0,
      { message: "`within` width and height must be ≥ 0" },
    ),
]);

/** 9-point anchors plus `baseline` (§9.2). Physical names, engine-serde camelCase. */
const zAnchor = z.enum([
  "topLeft",
  "top",
  "topRight",
  "left",
  "center",
  "right",
  "bottomLeft",
  "bottom",
  "bottomRight",
  "baseline",
]);
/** Cross-axis alignment is logical start/end only (§9.5 RTL/CJK rule). */
const zAlign = z.enum(["start", "center", "end", "stretch"]);
const zDirection = z.enum(["vertical", "horizontal"]);
const zFlowDir = z.enum(["ltr", "rtl"]);
const zFit = z.enum(["contain", "cover", "fill"]);

/** §9.2 sizing keys every node accepts (the engine's flattened Sizing struct). */
const zSizingFields = {
  width: zDimension.optional(),
  height: zDimension.optional(),
  grow: zGrow.optional(),
  hug: z.boolean().optional(),
  percent: zPercent.optional(),
  aspect: zAspect.optional(),
  minWidth: zDimension.optional(),
  maxWidth: zDimension.optional(),
  minHeight: zDimension.optional(),
  maxHeight: zDimension.optional(),
} as const;

// ---------------------------------------------------------------------------
// Node value types — the hand-written mirror of the engine's serde structs.
// Field names and optionality mirror layout_apply.rs exactly; each union's
// z.ZodType<…> annotation is compile-time checked against these types.
// ---------------------------------------------------------------------------

export type LayoutNodeKind =
  | "stack"
  | "row"
  | "grid"
  | "absolute"
  | "center"
  | "spacer"
  | "text"
  | "image"
  | "component"
  | "divider";
export type LayoutLayerRef = number | string;
export type LayoutWithinRef = { layer: LayoutLayerRef } | number[];
export type LayoutSides = number | number[];
export type LayoutAlign = "start" | "center" | "end" | "stretch";
export type LayoutDirection = "vertical" | "horizontal";
export type LayoutFlowDir = "ltr" | "rtl";
export type LayoutAnchor = z.infer<typeof zAnchor>;
export type LayoutFit = "contain" | "cover" | "fill";

/** §9.2 sizing keys, valid on every node kind. */
export interface LayoutSizingFields {
  readonly width?: number;
  readonly height?: number;
  readonly grow?: boolean | number;
  readonly hug?: boolean;
  readonly percent?: number;
  readonly aspect?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
}

export interface StackNode extends LayoutSizingFields {
  readonly type: "stack";
  readonly layer?: LayoutLayerRef;
  readonly within?: LayoutWithinRef;
  readonly direction?: LayoutDirection;
  readonly gap?: number;
  readonly padding?: LayoutSides;
  readonly align?: LayoutAlign;
  readonly dir?: LayoutFlowDir;
  readonly anchor?: LayoutAnchor;
  readonly children: readonly LayoutNode[];
}
export interface RowNode extends LayoutSizingFields {
  readonly type: "row";
  readonly layer?: LayoutLayerRef;
  readonly within?: LayoutWithinRef;
  readonly gap?: number;
  readonly padding?: LayoutSides;
  readonly align?: LayoutAlign;
  readonly dir?: LayoutFlowDir;
  readonly anchor?: LayoutAnchor;
  readonly children: readonly LayoutNode[];
}
export interface GridNode extends LayoutSizingFields {
  readonly type: "grid";
  readonly layer?: LayoutLayerRef;
  readonly within?: LayoutWithinRef;
  readonly columns: number;
  readonly gap?: number;
  readonly padding?: LayoutSides;
  readonly align?: LayoutAlign;
  readonly dir?: LayoutFlowDir;
  readonly anchor?: LayoutAnchor;
  readonly children: readonly LayoutNode[];
}
export interface AbsoluteNode extends LayoutSizingFields {
  readonly type: "absolute";
  readonly layer?: LayoutLayerRef;
  readonly within?: LayoutWithinRef;
  readonly padding?: LayoutSides;
  readonly dir?: LayoutFlowDir;
  readonly anchor?: LayoutAnchor;
  readonly children: readonly LayoutNode[];
}
export interface CenterNode extends LayoutSizingFields {
  readonly type: "center";
  readonly layer?: LayoutLayerRef;
  readonly within?: LayoutWithinRef;
  readonly padding?: LayoutSides;
  readonly dir?: LayoutFlowDir;
  readonly anchor?: LayoutAnchor;
  readonly children: readonly LayoutNode[];
}
export interface SpacerNode extends LayoutSizingFields {
  readonly type: "spacer";
  readonly anchor?: LayoutAnchor;
  readonly size: number;
}
export interface TextNode extends LayoutSizingFields {
  readonly type: "text";
  readonly anchor?: LayoutAnchor;
  readonly layer: LayoutLayerRef;
}
export interface ImageNode extends LayoutSizingFields {
  readonly type: "image";
  readonly anchor?: LayoutAnchor;
  readonly layer: LayoutLayerRef;
  readonly fit?: LayoutFit;
}
export interface ComponentNode extends LayoutSizingFields {
  readonly type: "component";
  readonly anchor?: LayoutAnchor;
  readonly layer: LayoutLayerRef;
}
export interface DividerNode extends LayoutSizingFields {
  readonly type: "divider";
  readonly anchor?: LayoutAnchor;
  readonly layer?: LayoutLayerRef;
  readonly size?: number;
}

export type LayoutNode =
  | StackNode
  | RowNode
  | GridNode
  | AbsoluteNode
  | CenterNode
  | SpacerNode
  | TextNode
  | ImageNode
  | ComponentNode
  | DividerNode;

/** A node under an `absolute` parent: same shape, plus required x/y (§9.2). */
export type LayoutAbsoluteChild = LayoutNode & { readonly x: number; readonly y: number };
/** A node under a `center` parent: same shape, plus optional dx/dy offsets (§9.2). */
export type LayoutCenterChild = LayoutNode & { readonly dx?: number; readonly dy?: number };

// ---------------------------------------------------------------------------
// The recursive node schema — one strictObject per §9.2 kind, discriminated on
// `type`, three child contexts exactly like the engine's keys_for(): `x`/`y`
// only under `absolute` (required), `dx`/`dy` only under `center` (optional),
// neither anywhere else (§9.2 — the model never emits raw coordinates).
// ---------------------------------------------------------------------------

let flowUnionCache: z.ZodType<LayoutNode> | undefined;
let absoluteUnionCache: z.ZodType<LayoutAbsoluteChild> | undefined;
let centerUnionCache: z.ZodType<LayoutCenterChild> | undefined;

// z.lazy defers the union builds to first parse; the caches build them once, so
// per-node parses reuse one discriminated union (and one option-map) ever after.
const flowChildNode: z.ZodType<LayoutNode> = z.lazy(() => {
  if (flowUnionCache === undefined) {
    flowUnionCache = buildFlowUnion();
  }
  return flowUnionCache;
});
const absoluteChildNode: z.ZodType<LayoutAbsoluteChild> = z.lazy(() => {
  if (absoluteUnionCache === undefined) {
    absoluteUnionCache = buildAbsoluteUnion();
  }
  return absoluteUnionCache;
});
const centerChildNode: z.ZodType<LayoutCenterChild> = z.lazy(() => {
  if (centerUnionCache === undefined) {
    centerUnionCache = buildCenterUnion();
  }
  return centerUnionCache;
});

const flowChildren = () =>
  cappedArray(LAYOUT_MAX_CHILDREN_PER_NODE, flowChildNode).min(1, {
    message: "`children` needs at least one node (§9.2)",
  });
const absoluteChildren = () =>
  cappedArray(LAYOUT_MAX_CHILDREN_PER_NODE, absoluteChildNode).min(1, {
    message: "`children` needs at least one node (§9.2)",
  });
const centerChildren = () =>
  cappedArray(LAYOUT_MAX_CHILDREN_PER_NODE, centerChildNode).min(1, {
    message: "`children` needs at least one node (§9.2)",
  });

const stackFlowVariant = z.strictObject({
  type: z.literal("stack"),
  ...zSizingFields,
  layer: zNodeLayer.optional(),
  within: zWithin.optional(),
  direction: zDirection.optional(),
  gap: zGap.optional(),
  padding: zSides.optional(),
  align: zAlign.optional(),
  dir: zFlowDir.optional(),
  anchor: zAnchor.optional(),
  children: flowChildren(),
});
const rowFlowVariant = z.strictObject({
  type: z.literal("row"),
  ...zSizingFields,
  layer: zNodeLayer.optional(),
  within: zWithin.optional(),
  gap: zGap.optional(),
  padding: zSides.optional(),
  align: zAlign.optional(),
  dir: zFlowDir.optional(),
  anchor: zAnchor.optional(),
  children: flowChildren(),
});
const gridFlowVariant = z.strictObject({
  type: z.literal("grid"),
  ...zSizingFields,
  layer: zNodeLayer.optional(),
  within: zWithin.optional(),
  columns: zColumns,
  gap: zGap.optional(),
  padding: zSides.optional(),
  align: zAlign.optional(),
  dir: zFlowDir.optional(),
  anchor: zAnchor.optional(),
  children: flowChildren(),
});
// An `absolute` node's children are absolute-context (x/y required); a `center`
// node's children are center-context (dx/dy optional) — the engine's ParentKind.
const absoluteFlowVariant = z.strictObject({
  type: z.literal("absolute"),
  ...zSizingFields,
  layer: zNodeLayer.optional(),
  within: zWithin.optional(),
  padding: zSides.optional(),
  dir: zFlowDir.optional(),
  anchor: zAnchor.optional(),
  children: absoluteChildren(),
});
const centerFlowVariant = z.strictObject({
  type: z.literal("center"),
  ...zSizingFields,
  layer: zNodeLayer.optional(),
  within: zWithin.optional(),
  padding: zSides.optional(),
  dir: zFlowDir.optional(),
  anchor: zAnchor.optional(),
  children: centerChildren(),
});
const spacerFlowVariant = z.strictObject({
  type: z.literal("spacer"),
  ...zSizingFields,
  anchor: zAnchor.optional(),
  size: zDimension,
});
const textFlowVariant = z.strictObject({
  type: z.literal("text"),
  ...zSizingFields,
  anchor: zAnchor.optional(),
  layer: zNodeLayer,
});
const imageFlowVariant = z.strictObject({
  type: z.literal("image"),
  ...zSizingFields,
  anchor: zAnchor.optional(),
  layer: zNodeLayer,
  fit: zFit.optional(),
});
const componentFlowVariant = z.strictObject({
  type: z.literal("component"),
  ...zSizingFields,
  anchor: zAnchor.optional(),
  layer: zNodeLayer,
});
const dividerFlowVariant = z.strictObject({
  type: z.literal("divider"),
  ...zSizingFields,
  anchor: zAnchor.optional(),
  layer: zNodeLayer.optional(),
  size: zDimension.optional(),
});

function buildFlowUnion() {
  return z.discriminatedUnion("type", [
    stackFlowVariant,
    rowFlowVariant,
    gridFlowVariant,
    absoluteFlowVariant,
    centerFlowVariant,
    spacerFlowVariant,
    textFlowVariant,
    imageFlowVariant,
    componentFlowVariant,
    dividerFlowVariant,
  ]);
}

/** Every kind as an absolute child: + required x/y (a container child's own
 *  children stay in their kind's context, exactly like the engine's ParentKind). */
function buildAbsoluteUnion() {
  const xy = { x: zCoordinate, y: zCoordinate };
  return z.discriminatedUnion("type", [
    stackFlowVariant.extend(xy),
    rowFlowVariant.extend(xy),
    gridFlowVariant.extend(xy),
    absoluteFlowVariant.extend(xy),
    centerFlowVariant.extend(xy),
    spacerFlowVariant.extend(xy),
    textFlowVariant.extend(xy),
    imageFlowVariant.extend(xy),
    componentFlowVariant.extend(xy),
    dividerFlowVariant.extend(xy),
  ]);
}

/** Every kind as a center child: + optional dx/dy (engine opt_finite_px → 0). */
function buildCenterUnion() {
  const dxdy = { dx: zCoordinate.optional(), dy: zCoordinate.optional() };
  return z.discriminatedUnion("type", [
    stackFlowVariant.extend(dxdy),
    rowFlowVariant.extend(dxdy),
    gridFlowVariant.extend(dxdy),
    absoluteFlowVariant.extend(dxdy),
    centerFlowVariant.extend(dxdy),
    spacerFlowVariant.extend(dxdy),
    textFlowVariant.extend(dxdy),
    imageFlowVariant.extend(dxdy),
    componentFlowVariant.extend(dxdy),
    dividerFlowVariant.extend(dxdy),
  ]);
}

// ---------------------------------------------------------------------------
// Depth / node-count caps — the iterative walker (bounded, deterministic
// first-violation reporting; §9.5's engine caps stay the backstop).
// ---------------------------------------------------------------------------

interface WalkFrame {
  readonly node: unknown;
  readonly depth: number;
}

function childrenOf(node: unknown): readonly unknown[] | undefined {
  if (typeof node !== "object" || node === null) {
    return undefined;
  }
  const children = (node as { readonly children?: unknown }).children;
  return Array.isArray(children) ? children : undefined;
}

/**
 * The "layout too complex" check (tool caps: depth ≤ 32, ≤ 256 nodes). Pure and
 * iterative: returns the first violation message, or undefined when the tree fits.
 */
export function findLayoutTreeCapsViolation(root: unknown): string | undefined {
  const frames: WalkFrame[] = [{ node: root, depth: 1 }];
  let nodes = 0;
  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) {
      break;
    }
    nodes += 1;
    if (frame.depth > LAYOUT_MAX_DEPTH) {
      return `layout too complex: the node tree nests deeper than ${LAYOUT_MAX_DEPTH} levels`;
    }
    if (nodes > LAYOUT_MAX_NODES) {
      return `layout too complex: the node tree has more than ${LAYOUT_MAX_NODES} nodes`;
    }
    const children = childrenOf(frame.node);
    if (children !== undefined) {
      for (const child of children) {
        frames.push({ node: child, depth: frame.depth + 1 });
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Args schema (§6.1 strict; a mutating tool carries an idempotency key — kit README)
// ---------------------------------------------------------------------------

export const layoutApplyArgsSchema = strictObject({
  idempotencyKey: zIdempotencyKey,
  root: flowChildNode,
  options: strictObject({
    coordinateSpace: z.enum(["document", "parent"]).optional(),
    safeArea: zSafeArea.optional(),
  }).optional(),
}).superRefine((args, addIssue) => {
  const violation = findLayoutTreeCapsViolation(args.root);
  if (violation !== undefined) {
    addIssue({ code: z.ZodIssueCode.custom, path: ["root"], message: violation });
  }
});

export type LayoutApplyArgs = z.output<typeof layoutApplyArgsSchema>;

// ---------------------------------------------------------------------------
// Engine result — layout.apply returns { moved, warnings } (§9.4, commands.md)
// ---------------------------------------------------------------------------

export const LAYOUT_APPLY_RESULT_SCHEMA = z.object({
  moved: z.array(
    z.object({
      layer: z.number().int().nonnegative(),
      from: z.array(zFiniteNumber).length(4),
      to: z.array(zFiniteNumber).length(4),
    }),
  ),
  warnings: z.array(z.string()),
});

export interface LayoutMovedLayer {
  readonly layer: number;
  readonly from: number[];
  readonly to: number[];
}
export type LayoutApplyOutcome = z.infer<typeof LAYOUT_APPLY_RESULT_SCHEMA>;

/**
 * Reads the engine's `{ moved, warnings }` from either seam channel: spread onto
 * the report object (structural passthrough), or JSON-stringified into `message`.
 * Undefined ⇒ neither channel carried a readable payload — never a hard failure:
 * the layout may have applied, so the caller reports a verify warning instead.
 */
export function parseLayoutApplyReport(
  report: EngineCommandReport,
): LayoutApplyOutcome | undefined {
  const direct = LAYOUT_APPLY_RESULT_SCHEMA.safeParse(report);
  if (direct.success) {
    return direct.data;
  }
  if (typeof report.message === "string" && report.message.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(report.message);
    } catch {
      return undefined;
    }
    const viaMessage = LAYOUT_APPLY_RESULT_SCHEMA.safeParse(parsed);
    if (viaMessage.success) {
      return viaMessage.data;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Compact reply (§6.1): moved count + top-3 examples + warnings, stringified in
// the fleet's structured-summary style; warnings clipped to the kit's caps.
// ---------------------------------------------------------------------------

/** The structured summary the model reads (JSON-stringified into `summary`). */
export interface LayoutApplySummaryReport {
  readonly moved: number;
  readonly examples: readonly string[];
  readonly moreMoved?: number;
  readonly warnings: number;
}

export const MISSING_MOVE_REPORT_WARNING =
  "the engine's move report was unreadable; the layout may have applied — verify " +
  "positions with workspace_snapshot";

export interface CompactedLayoutReply {
  readonly summary: string;
  readonly warnings?: readonly string[];
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * Compaction, deterministic: at most 3 "layer N → [x, y, w, h]" examples (the rest
 * counted in `moreMoved`), at most MAX_WARNINGS warnings of ≤ MAX_WARNING_CHARS
 * each (kit caps), and the FULL warning count kept in the summary so nothing is
 * silently dropped. Empty `warnings` keeps the field out of the envelope.
 */
export function compactLayoutApplyReply(
  moved: readonly LayoutMovedLayer[],
  warnings: readonly string[],
): CompactedLayoutReply {
  const shown = warnings.slice(0, MAX_WARNINGS).map((warning) => clip(warning, MAX_WARNING_CHARS));
  const examples = moved
    .slice(0, MAX_MOVED_EXAMPLES)
    .map((entry) => `layer ${entry.layer} → [${entry.to.join(", ")}]`);
  const summaryReport: LayoutApplySummaryReport =
    moved.length > MAX_MOVED_EXAMPLES
      ? {
          moved: moved.length,
          examples,
          moreMoved: moved.length - MAX_MOVED_EXAMPLES,
          warnings: warnings.length,
        }
      : { moved: moved.length, examples, warnings: warnings.length };
  return {
    summary: JSON.stringify(summaryReport),
    warnings: shown.length > 0 ? shown : undefined,
  };
}

// ---------------------------------------------------------------------------
// Engine failure mapping — the seam may carry facade codes beyond the tool
// catalog (engine-client errors.ts); missing-command cases get the patch hint.
// ---------------------------------------------------------------------------

const PATCHABLE_CODES: ReadonlySet<string> = new Set([
  "missing_required_commands",
  "unknown_command",
]);

/** Facade codes (engine-client) → nearest §13.3 catalog code. Mirrors the fleet's
 *  mapping (template-apply / style-apply) so every tool fails the same way. */
const FACADE_TO_CATALOG: Readonly<Record<string, string>> = {
  engine_command_failed: "internal_error",
  reply_timeout: "engine_timeout",
  call_aborted: "engine_timeout",
  frame_too_large: "internal_error",
  auth_rejected: "unauthorized",
  session_limit_reached: "engine_unavailable",
  path_outside_capability_root: "forbidden",
  plan_ceiling_exceeded: "plan_limit",
  connection_dropped_mid_call: "engine_crashed",
};

export function mapLayoutEngineFailure(failure: EngineFailure): ToolErr {
  const rawCode: string = failure.code;
  if (
    PATCHABLE_CODES.has(rawCode) ||
    (failure.message.includes("unknown command") &&
      failure.message.includes(LAYOUT_APPLY_COMMAND_ID))
  ) {
    return err("engine_unavailable", "This engine build cannot serve declarative layout", {
      hint: ENGINE_PATCH_HINT,
      retryable: false,
    });
  }
  const mapped: string = FACADE_TO_CATALOG[rawCode] ?? rawCode;
  const code = TOOL_ERROR_CODE_SCHEMA.safeParse(mapped).success
    ? (mapped as ToolErr["code"])
    : "internal_error";
  return err(code, clip(failure.message, MAX_ERROR_MESSAGE_CHARS), {
    hint: failure.hint === undefined ? undefined : clip(failure.hint, MAX_HINT_CHARS),
    retryable: failure.retryable,
  });
}

// ---------------------------------------------------------------------------
// The tool (§6.2 shape)
// ---------------------------------------------------------------------------

export const layoutApplyTool = defineTool({
  name: TOOLS.layout_apply,
  description:
    "Apply declarative layout: the engine solves geometry from stack, row, grid, " +
    "center, absolute, spacer, text, image, component and divider nodes with fit " +
    "modes and safe areas (§9.1–§9.2) — describe structure, never raw coordinates.",
  args: layoutApplyArgsSchema,
  async run(ctx, args, signal) {
    // §9.4: one command, `{ root, options }` — transactional inside the engine
    // (any invalid child ⇒ nothing moves, §9.5). `options` is always present: an
    // empty object means the engine's defaults (document space, no safe area).
    const command: EngineCommand = {
      id: LAYOUT_APPLY_COMMAND_ID,
      params: { root: args.root, options: args.options ?? {} },
    };
    const outcome = await ctx.engine.execute(command, { signal });
    if (!outcome.ok) {
      return mapLayoutEngineFailure(outcome);
    }
    const report = outcome.value;
    const payload = parseLayoutApplyReport(report);
    if (payload === undefined) {
      ctx.logger.warn("layout.apply reply carried no readable move report", {
        revision: report.revision,
      });
      const compacted = compactLayoutApplyReply([], [MISSING_MOVE_REPORT_WARNING]);
      return ok({
        summary: compacted.summary,
        warnings: compacted.warnings,
        documentRevision: report.revision,
      });
    }
    const compacted = compactLayoutApplyReply(payload.moved, payload.warnings);
    return ok({
      summary: compacted.summary,
      warnings: compacted.warnings,
      documentRevision: report.revision,
    });
  },
});
