// @studio/tools — layer_ops (§6 row 9): create/group/duplicate/rename/reorder/
// align/show-hide/lock, all as ONE transactional engine batch. Owner: W5-H.
//
// Every op compiles to §2.2 command ids, pinned verbatim from
// @studio/engine-client commands.ts LAYER_COMMANDS (never invented — §2.2 keeps
// the live registry authoritative; the vendor truth is crates/engine/src/
// commands.rs + layer_multi_cmds.rs):
//
//   create_group → layer.new.group            (+ layer.select when parent given)
//   group        → layer.select × n           + layer.groupLayers
//   duplicate    → layer.duplicate
//   rename       → layer.setProps {name}      (§10.2-checked before anything mutates)
//   reorder      → layer.arrange.{bringToFront|sendToBack|bringForward|sendBackward}
//   align        → layer.select × n           + layer.align.<mode> {to:"layers"}
//   set_props    → layer.setProps {visible?,opacity?,locked?}
//
// The engine's align/group commands act on the SELECTION, so multi-layer ops
// select their targets first (replace, then add). The model never sees command
// ids (§6): summaries describe the edit, errors name the fix. Layer refs resolve
// against the compact tree (ctx.engine.listLayers) BEFORE mutating, so an
// unknown or ambiguous name is an actionable error with candidates (§6.1)
// instead of a silent edit of the wrong layer.

import { z } from "zod";
import {
  type LayerRef,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  ambiguousLayerErr,
  cappedArray,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
  zLayerRef,
} from "../kit.js";
import {
  type EngineBatchReport,
  type EngineCommand,
  type EngineFailure,
  type EngineLayerSummary,
  TOOL_ERROR_CODE_SCHEMA,
  type Tool,
  type ToolContext,
  type ToolErr,
  type ToolErrorCode,
  type ToolResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// §6 row 9 argument surface — a discriminated union on `op`
// ---------------------------------------------------------------------------

/** §6 row 9 align modes; the command ids below share the exact same casing. */
export const ALIGN_MODES = [
  "leftEdges",
  "horizontalCenters",
  "rightEdges",
  "topEdges",
  "verticalCenters",
  "bottomEdges",
] as const;

export type AlignMode = (typeof ALIGN_MODES)[number];

/** §6 row 9 reorder positions: ends jump the stack, the others step one place. */
export const REORDER_POSITIONS = ["front", "back", "forward", "backward"] as const;

export type ReorderPosition = (typeof REORDER_POSITIONS)[number];

/** §10.1: more than ~7 loose top-level layers means a group is needed. */
export const LOOSE_LAYER_LIMIT = 7;

/** §10.1: engine-generated placeholders ("Layer 1", "Group 3") are never agent names. */
const AUTO_NAME_RE = /^(?:Layer|Group) \d+$/;

const zLayerName = cappedString(200, 1);
const zRefs = (min: number) => cappedArray(50, zLayerRef).min(min);

const CREATE_GROUP_OP = strictObject({
  op: z.literal("create_group"),
  name: zLayerName,
  parent: zLayerRef.optional(),
});

const DUPLICATE_OP = strictObject({
  op: z.literal("duplicate"),
  layer: zLayerRef,
});

const RENAME_OP = strictObject({
  op: z.literal("rename"),
  layer: zLayerRef,
  name: zLayerName,
});

const REORDER_OP = strictObject({
  op: z.literal("reorder"),
  layer: zLayerRef,
  position: z.enum(REORDER_POSITIONS),
});

const ALIGN_OP = strictObject({
  op: z.literal("align"),
  layers: zRefs(1),
  mode: z.enum(ALIGN_MODES),
});

const SET_PROPS_OP = strictObject({
  op: z.literal("set_props"),
  layer: zLayerRef,
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
});

const GROUP_OP = strictObject({
  op: z.literal("group"),
  layers: zRefs(2),
  name: zLayerName.optional(),
});

/** args.op is the whole call (§6 row 9): one op, its operands, nothing else. */
export type LayerOpsArgs =
  | { readonly op: "create_group"; readonly name: string; readonly parent?: LayerRef }
  | { readonly op: "duplicate"; readonly layer: LayerRef }
  | { readonly op: "rename"; readonly layer: LayerRef; readonly name: string }
  | { readonly op: "reorder"; readonly layer: LayerRef; readonly position: ReorderPosition }
  | { readonly op: "align"; readonly layers: readonly LayerRef[]; readonly mode: AlignMode }
  | {
      readonly op: "set_props";
      readonly layer: LayerRef;
      readonly visible?: boolean;
      readonly opacity?: number;
      readonly locked?: boolean;
    }
  | { readonly op: "group"; readonly layers: readonly LayerRef[]; readonly name?: string };

const LAYER_OPS_ARGS: z.ZodType<LayerOpsArgs, z.ZodTypeDef, unknown> = z.discriminatedUnion("op", [
  CREATE_GROUP_OP,
  DUPLICATE_OP,
  RENAME_OP,
  REORDER_OP,
  ALIGN_OP,
  SET_PROPS_OP,
  GROUP_OP,
]);

// ---------------------------------------------------------------------------
// The exact §2.2 command ids this tool may emit (tests grep-check them against
// LAYER_COMMANDS in @studio/engine-client — the studio-side §2.2 registry)
// ---------------------------------------------------------------------------

export const LAYER_OPS_COMMANDS = Object.freeze({
  select: "layer.select",
  newGroup: "layer.new.group",
  groupLayers: "layer.groupLayers",
  duplicate: "layer.duplicate",
  setProps: "layer.setProps",
  align: Object.freeze({
    leftEdges: "layer.align.leftEdges",
    horizontalCenters: "layer.align.horizontalCenters",
    rightEdges: "layer.align.rightEdges",
    topEdges: "layer.align.topEdges",
    verticalCenters: "layer.align.verticalCenters",
    bottomEdges: "layer.align.bottomEdges",
  }),
  arrange: Object.freeze({
    front: "layer.arrange.bringToFront",
    back: "layer.arrange.sendToBack",
    forward: "layer.arrange.bringForward",
    backward: "layer.arrange.sendBackward",
  }),
});

// ---------------------------------------------------------------------------
// §10.2 naming (checked before a single engine command is built)
// ---------------------------------------------------------------------------

/** Is this an engine placeholder name §10.1 forbids ("Layer 1", "Group 3")? */
export function isAutoLayerName(name: string): boolean {
  return AUTO_NAME_RE.test(name);
}

const ROLE_HINT =
  "use a §10.2 role name — Headline, Subhead, Body, Caption, CTA, Logo, Badge, Watermark, Background; groups: Content, Brand, Effects";

/**
 * §10.2 name check shared by rename, create_group and group: names are semantic
 * (§10.1 "Named layers, always"), never engine placeholders. Returns the typed
 * error to hand back, or undefined when the name is fine.
 */
export function checkLayerName(name: string): ToolErr | undefined {
  if (name.trim().length === 0) {
    return err("validation_failed", "Layer name must not be empty", {
      hint: ROLE_HINT,
      retryable: false,
    });
  }
  if (AUTO_NAME_RE.test(name)) {
    return err(
      "validation_failed",
      `"${name}" is an engine placeholder name (§10.1: no "Layer 1", no "Group 3")`,
      { hint: `Give the layer a semantic name; ${ROLE_HINT}`, retryable: false },
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// §6.1 layer reference resolution — against the compact tree, before mutating
// ---------------------------------------------------------------------------

type ResolveOutcome = { readonly ok: true; readonly layer: EngineLayerSummary } | ToolErr;
type ResolveAllOutcome =
  | { readonly ok: true; readonly layers: readonly EngineLayerSummary[] }
  | ToolErr;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function layerLabel(layer: EngineLayerSummary): string {
  return `${quote(layer.name)} (id ${layer.layerId})`;
}

/**
 * Candidate layers for "no layer matched" hints (§6.1): compact enough that the
 * assembled hint stays under the kit's 500-char cap even for 50-layer documents.
 */
function candidateHint(layers: readonly EngineLayerSummary[]): string {
  if (layers.length === 0) {
    return "the document has no layers";
  }
  const shown = layers
    .slice(0, 8)
    .map((layer) => `${layer.name.slice(0, 32)} (id ${layer.layerId})`)
    .join(", ");
  const extra = layers.length > 8 ? ` (+${layers.length - 8} more)` : "";
  return `existing layers: ${shown}${extra}`;
}

/**
 * Resolves one §6.1 reference: layer_id first, then an exact layer_name, then
 * the engine's case-insensitive fallback (which would otherwise pick the topmost
 * of that name). Ambiguity lists candidate ids; a miss lists the document's layers.
 */
export function resolveLayerRef(
  ref: LayerRef,
  layers: readonly EngineLayerSummary[],
): ResolveOutcome {
  if ("layerId" in ref) {
    const byId = layers.find((layer) => layer.layerId === ref.layerId);
    if (byId === undefined) {
      return err("layer_not_found", "No layer matched this reference", {
        hint: clip(
          `Check the layer tree with workspace_snapshot; ${candidateHint(layers)}`,
          MAX_HINT_CHARS,
        ),
        retryable: false,
      });
    }
    return { ok: true, layer: byId };
  }
  const name = ref.layerName;
  const matches = layers.some((layer) => layer.name === name)
    ? layers.filter((layer) => layer.name === name)
    : layers.filter((layer) => layer.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) {
    return err("layer_not_found", "No layer matched this reference", {
      hint: clip(`No layer is named ${quote(name)}; ${candidateHint(layers)}`, MAX_HINT_CHARS),
      retryable: false,
    });
  }
  if (matches.length > 1) {
    // The name is the same on every match by construction — candidates are ids.
    return ambiguousLayerErr(
      name,
      matches.map((layer) => `id ${layer.layerId}`),
    );
  }
  const layer = matches.at(0);
  return layer === undefined
    ? err("internal_error", "The layer reference could not be resolved")
    : { ok: true, layer };
}

/** Resolves refs in order; the same layer twice is a rejected input, not a dedup. */
export function resolveLayerRefs(
  refs: readonly LayerRef[],
  layers: readonly EngineLayerSummary[],
): ResolveAllOutcome {
  const resolved: EngineLayerSummary[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const outcome = resolveLayerRef(ref, layers);
    if (!outcome.ok) {
      return outcome;
    }
    if (seen.has(outcome.layer.layerId)) {
      return err("validation_failed", "The same layer is referenced more than once", {
        hint: "Reference each layer once — the align/group lists hold unique layers.",
        retryable: false,
      });
    }
    seen.add(outcome.layer.layerId);
    resolved.push(outcome.layer);
  }
  return { ok: true, layers: resolved };
}

// ---------------------------------------------------------------------------
// Command building (§2.2 ids only; params verified against the vendor registry)
// ---------------------------------------------------------------------------

/**
 * Engine ids are u64s (LayerId); the compact tree stringifies them. A non-numeric
 * id falls back to the layer's name — unique in the document by the time we get
 * here, because ambiguity was resolved (or rejected) against the tree above.
 */
function layerParam(layer: EngineLayerSummary): number | string {
  return /^\d+$/.test(layer.layerId) ? Number(layer.layerId) : layer.name;
}

function selectCmd(layer: EngineLayerSummary, mode: "replace" | "add"): EngineCommand {
  return { id: LAYER_OPS_COMMANDS.select, params: { layer: layerParam(layer), mode } };
}

/** layer.align.* / layer.groupLayers act on the selection, so select the targets first. */
function selectAllCmds(layers: readonly EngineLayerSummary[]): readonly EngineCommand[] {
  const [first, ...rest] = layers;
  if (first === undefined) {
    return [];
  }
  return [selectCmd(first, "replace"), ...rest.map((layer) => selectCmd(layer, "add"))];
}

/** ≤ 5 labels + a count, keeping summaries inside the §6.1 2000-char cap. */
function nameList(layers: readonly EngineLayerSummary[]): string {
  const shown = layers.slice(0, 5).map(layerLabel).join(", ");
  const extra = layers.length > 5 ? `, +${layers.length - 5} more` : "";
  return `${shown}${extra}`;
}

/**
 * §10.1 "Group before you multiply": more than ~7 loose layers after a create
 * means the document needs grouping. The compact tree is flat, so "loose" counts
 * every non-group layer wherever it sits — an over-approximation, which is the
 * safe side for an advisory warning (the exact warning text the surface pins).
 */
function countLooseLayers(layers: readonly EngineLayerSummary[]): number {
  return layers.filter((layer) => layer.kind !== "Group").length;
}

/** The one group with this name, if the post-batch tree has exactly one. */
function findGroupId(layers: readonly EngineLayerSummary[], name: string): string | undefined {
  const matches = layers.filter((layer) => layer.name === name && layer.kind === "Group");
  return matches.length === 1 ? matches.at(0)?.layerId : undefined;
}

/**
 * Engine-seam failures are values, not throws (§6.1). The code is echoed only
 * when it belongs to the tool catalog — anything else (facade-internal codes
 * like "engine_command_failed") degrades to engine_unavailable rather than
 * reaching err(), which throws on unknown codes by kit contract.
 */
function engineFailureErr(failure: EngineFailure, verb: string): ToolErr {
  const code: ToolErrorCode = TOOL_ERROR_CODE_SCHEMA.safeParse(failure.code).success
    ? failure.code
    : "engine_unavailable";
  const message =
    failure.message.trim().length > 0
      ? clip(failure.message, MAX_ERROR_MESSAGE_CHARS)
      : `The engine could not ${verb}`;
  return err(code, message, {
    hint: failure.hint === undefined ? undefined : clip(failure.hint, MAX_HINT_CHARS),
    retryable: failure.retryable,
  });
}

async function readTree(
  ctx: ToolContext,
): Promise<{ readonly ok: true; readonly layers: readonly EngineLayerSummary[] } | ToolErr> {
  const listing = await ctx.engine.listLayers();
  if (!listing.ok) {
    return engineFailureErr(listing, "read the layer tree");
  }
  return { ok: true, layers: listing.value };
}

/** Post-batch relist; advisory only — a failure here never fails the mutation. */
async function readTreeAfter(ctx: ToolContext): Promise<readonly EngineLayerSummary[] | undefined> {
  const listing = await ctx.engine.listLayers();
  return listing.ok ? listing.value : undefined;
}

async function runBatch(
  ctx: ToolContext,
  cmds: readonly EngineCommand[],
  verb: string,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly report: EngineBatchReport } | ToolErr> {
  // One transactional batch (§6.2 ctx.engine): a failed command rolls the document
  // back to the batch's start revision, so the caller never sees a partial edit.
  const outcome = await ctx.engine.batch(cmds, { transaction: true, signal });
  if (!outcome.ok) {
    return engineFailureErr(outcome, verb);
  }
  const failed = outcome.value.outcomes.find((command) => !command.ok);
  if (failed !== undefined) {
    ctx.logger.warn("layer_ops batch command failed", { commandId: failed.commandId });
    return err("internal_error", `The engine could not ${verb}`, {
      hint: "The transactional batch rolled back — inspect with workspace_snapshot, then retry with corrected layer references.",
      retryable: false,
    });
  }
  return { ok: true, report: outcome.value };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const POSITION_PHRASES = {
  front: "to the front of its siblings",
  back: "to the back of its siblings",
  forward: "one step forward in the stack",
  backward: "one step backward in the stack",
} as const satisfies Record<ReorderPosition, string>;

export const layerOpsTool: Tool<LayerOpsArgs> = defineTool({
  name: "layer_ops",
  description:
    "Create, group, duplicate, rename, reorder, align, show/hide, lock or unlock document layers as one atomic edit.",
  args: LAYER_OPS_ARGS,
  async run(ctx, args, signal): Promise<ToolResult> {
    ctx.logger.debug("layer_ops invoked", { op: args.op });
    // Resolve against the tree first (§6.1); a parentless create_group needs no refs.
    const skipTree = args.op === "create_group" && args.parent === undefined;
    let before: readonly EngineLayerSummary[] = [];
    if (!skipTree) {
      const tree = await readTree(ctx);
      if (!tree.ok) {
        return tree;
      }
      before = tree.layers;
    }
    switch (args.op) {
      case "create_group": {
        const { name, parent } = args;
        const nameCheck = checkLayerName(name);
        if (nameCheck !== undefined) {
          return nameCheck;
        }
        const cmds: EngineCommand[] = [];
        if (parent !== undefined) {
          const target = resolveLayerRef(parent, before);
          if (!target.ok) {
            return target;
          }
          // layer.new.group inserts above the engine's ACTIVE layer, so selecting
          // the parent first puts the new group directly above it. The §2.2 command
          // set has no insert-into-group id; the `group` op gathers existing layers.
          cmds.push(selectCmd(target.layer, "replace"));
        }
        cmds.push({ id: LAYER_OPS_COMMANDS.newGroup, params: { name } });
        const batch = await runBatch(ctx, cmds, "create the group", signal);
        if (!batch.ok) {
          return batch;
        }
        const after = await readTreeAfter(ctx);
        const groupId = after === undefined ? undefined : findGroupId(after, name);
        const idPart = groupId === undefined ? "" : ` (id ${groupId})`;
        const warnings: string[] = [];
        if (after !== undefined && countLooseLayers(after) > LOOSE_LAYER_LIMIT) {
          warnings.push("document needs grouping");
        }
        return ok({
          summary: `Created group ${quote(name)}${idPart}`,
          documentRevision: batch.report.revision,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      }
      case "duplicate": {
        const source = resolveLayerRef(args.layer, before);
        if (!source.ok) {
          return source;
        }
        const cmds: EngineCommand[] = [
          { id: LAYER_OPS_COMMANDS.duplicate, params: { layer: layerParam(source.layer) } },
        ];
        const batch = await runBatch(ctx, cmds, "duplicate the layer", signal);
        if (!batch.ok) {
          return batch;
        }
        const after = await readTreeAfter(ctx);
        const warnings = [
          `the copy keeps the name ${quote(source.layer.name)} — rename it to keep document names unique (§10.1)`,
        ];
        if (after !== undefined && countLooseLayers(after) > LOOSE_LAYER_LIMIT) {
          warnings.push("document needs grouping");
        }
        return ok({
          summary: `Duplicated ${layerLabel(source.layer)}; the copy sits directly above it`,
          documentRevision: batch.report.revision,
          warnings,
        });
      }
      case "rename": {
        const { layer: ref, name } = args;
        const nameCheck = checkLayerName(name);
        if (nameCheck !== undefined) {
          return nameCheck;
        }
        const source = resolveLayerRef(ref, before);
        if (!source.ok) {
          return source;
        }
        const cmds: EngineCommand[] = [
          { id: LAYER_OPS_COMMANDS.setProps, params: { layer: layerParam(source.layer), name } },
        ];
        const batch = await runBatch(ctx, cmds, "rename the layer", signal);
        if (!batch.ok) {
          return batch;
        }
        return ok({
          summary: `Renamed ${layerLabel(source.layer)} to ${quote(name)}`,
          documentRevision: batch.report.revision,
        });
      }
      case "reorder": {
        // §10.1 z-order sanity: the stack reads bottom→top as background →
        // photos → decoration → text → brand, text on top of what it labels.
        // front/back jump the ends of the stack; forward/backward step one place.
        // The tool stays mechanical — the summary names the direction so the
        // planner can re-check §10.1 order on the next workspace_snapshot.
        const source = resolveLayerRef(args.layer, before);
        if (!source.ok) {
          return source;
        }
        const cmds: EngineCommand[] = [
          {
            id: LAYER_OPS_COMMANDS.arrange[args.position],
            params: { layer: layerParam(source.layer) },
          },
        ];
        const batch = await runBatch(ctx, cmds, "reorder the layer", signal);
        if (!batch.ok) {
          return batch;
        }
        return ok({
          summary: `Moved ${layerLabel(source.layer)} ${POSITION_PHRASES[args.position]}`,
          documentRevision: batch.report.revision,
        });
      }
      case "align": {
        const targets = resolveLayerRefs(args.layers, before);
        if (!targets.ok) {
          return targets;
        }
        // to:"layers" pins the alignment basis to the targets' combined bounds —
        // the deterministic Photoshop behaviour for a semantic align call
        // (an active pixel selection would otherwise hijack "auto").
        const cmds: EngineCommand[] = [
          ...selectAllCmds(targets.layers),
          { id: LAYER_OPS_COMMANDS.align[args.mode], params: { to: "layers" } },
        ];
        const batch = await runBatch(ctx, cmds, "align the layers", signal);
        if (!batch.ok) {
          return batch;
        }
        const count = targets.layers.length;
        const what = count === 1 ? "layer" : "layers";
        const warnings: string[] = [];
        if (count === 1) {
          warnings.push(
            "aligning a single layer to its own combined bounds is a no-op — pass 2 or more layers",
          );
        }
        return ok({
          summary: `Aligned ${count} ${what} (${nameList(targets.layers)}) by ${args.mode}`,
          documentRevision: batch.report.revision,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      }
      case "set_props": {
        const keys = ["visible", "opacity", "locked"] as const;
        const given = keys.filter((key) => args[key] !== undefined);
        if (given.length === 0) {
          const hint =
            "Pass visible (show/hide), opacity (0–1) or locked (lock/unlock) — nothing to apply otherwise.";
          return err(
            "validation_failed",
            "set_props needs at least one of visible, opacity, locked",
            { hint, retryable: false },
          );
        }
        const source = resolveLayerRef(args.layer, before);
        if (!source.ok) {
          return source;
        }
        const params: Record<string, unknown> = { layer: layerParam(source.layer) };
        const described: string[] = [];
        for (const key of given) {
          const value = args[key];
          params[key] = value;
          described.push(`${key}=${String(value)}`);
        }
        const batch = await runBatch(
          ctx,
          [{ id: LAYER_OPS_COMMANDS.setProps, params }],
          "update the layer",
          signal,
        );
        if (!batch.ok) {
          return batch;
        }
        return ok({
          summary: `Updated ${layerLabel(source.layer)}: ${described.join(", ")}`,
          documentRevision: batch.report.revision,
        });
      }
      case "group": {
        const { name } = args;
        const nameCheck = name === undefined ? undefined : checkLayerName(name);
        if (nameCheck !== undefined) {
          return nameCheck;
        }
        const members = resolveLayerRefs(args.layers, before);
        if (!members.ok) {
          return members;
        }
        const cmds: EngineCommand[] = [
          ...selectAllCmds(members.layers),
          { id: LAYER_OPS_COMMANDS.groupLayers, params: name === undefined ? {} : { name } },
        ];
        const batch = await runBatch(ctx, cmds, "group the layers", signal);
        if (!batch.ok) {
          return batch;
        }
        // Grouping is the §10.1 fix, not a violation — no loose-layer warning here.
        const warnings: string[] = [];
        if (name === undefined) {
          warnings.push(
            "the engine auto-named the group — rename it to a §10.2 role name such as Content or Brand",
          );
        }
        const after = name === undefined ? undefined : await readTreeAfter(ctx);
        const groupId =
          name === undefined || after === undefined ? undefined : findGroupId(after, name);
        const into = name === undefined ? "" : ` into ${quote(name)}`;
        const idPart = groupId === undefined ? "" : ` (id ${groupId})`;
        const count = members.layers.length;
        const listed = nameList(members.layers);
        return ok({
          summary: `Grouped ${count} layers (${listed})${into}${idPart}`,
          documentRevision: batch.report.revision,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      }
    }
  },
});
