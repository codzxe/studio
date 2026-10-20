// @studio/engine-client — the §2.2 required-command registry + startup discovery.
// Owner: W2-D (src/{commands,index}.ts).
//
// Spec §2.2 ("Verified agent-ready engine commands — starter set; never hardcode
// blindly", docs/BUILD_PROMPT.md): the appendix-style list MAY drift, the LIVE
// registry (`engine.commands`, rpc.rs) is authoritative, and "the implementation must
// discover commands at startup and fail loudly if a required command is missing".
// This module is that contract: the ids the product relies on, each verified
// against the pinned vendor (872748fb…) command registry, plus the discovery check.
//
// Where each id is registered — the registry is assembled from ~80 module `specs()`
// lists (crates/engine/src/commands.rs `build()`), so the citation per group is the
// file that registers it (grep target, read-only verification — never invented):
//   - commands.rs            file.new, edit.*, select.all/deselect/inverse/rect,
//                            layer.{new.layer,new.group,groupLayers,duplicate,
//                            delete,select,setProps, arrange.*}, layer.layerMask.{revealAll,
//                            hideAll,revealSelection,delete}, layer.newFillLayer.*,
//                            document.activate/inspect/move/pixel, command.list,
//                            layer.newAdjustmentLayer.<kind> + image.adjustments.<kind>
//                            (built from the ADJ table: levels, curves, hueSaturation,
//                            brightnessContrast, … — exact id casing from that table)
//   - layer_multi_cmds.rs    layer.arrange.reverse, layer.align.* (spec! registrations)
//   - group_view_cmds.rs     layer.setExpanded
//   - artboard_cmds.rs       layer.new.artboard, layer.new.artboardFromGroup,
//                            layer.new.artboardFromLayers
//   - type_cmds.rs           type.create, type.edit
//   - edit_cmds.rs           edit.fill, edit.undo, edit.redo (re-exported starters)
//   - solid_fill_cmds.rs     layer.fill.solidColor.set
//   - pattern_fill_cmds.rs   layer.fill.pattern.set
//   - paint_cmds.rs          paint.bucket, paint.gradient; commands.rs: paint.stroke
//   - image_cmds.rs          image.crop, image.imageSize, image.canvasSize
//   - smart_cmds.rs          layer.smartObjects.{convertToSmartObject,editContents,
//                            saveContents,updateModifiedContent}
//   - layer_style.rs         layer.layerStyle.<kind> (style_cmd! concat!, incl. replace
//                            and clear)
//   - extra_cmds.rs          layer.layerMask.enabled, layer.layerMask.linked
//   - layer_mask_props_cmds.rs layer.layerMask.edit
//   - variables_cmds.rs      image.variables.define, image.variables.dataSets,
//                            image.applyDataSet, variables.list
//   - comps_cmds.rs          layerComp.{new,update,apply,duplicate,rename,delete}
//   - presets/shapes.rs      shape.presets.list, shape.presets.place (via presets::specs())
//   - document_preset_cmds.rs document.presets.{list,get,save,delete}
//   - export_preset_cmds.rs  file.export.presets.{list,get,save,delete}
//   - notes_cmds.rs          notes.{add,set,delete,list}
//   - actions_cmds.rs        actions.{record,stop,play,list,get}
//   - prefs.rs               prefs.set
//   - filters.rs             filter.blur.gaussianBlur (the §6 tools starter)
//
// Deliberately NOT in the required list (still usable, just not load-bearing):
//   - layerComp.list does not exist as a command — layer comps are listed by the
//     `document.inspect` reply's `layerComps` row (crates/engine/src/inspect.rs);
//     §2.2's "list" wording is served by that.
//   - layer.layerStyle.makeDefault / defaultFor (per-style defaults, §2.2 lists only
//     the effect kinds + replace + clear).
//   - engine-patches §2.3 command families (template.*, component.*, layout.*,
//     agent.*, document.diff) land in their own wave; §2.2 keeps THIS list
//     engine-native so worker startup verifies only what the pinned engine serves.

import { COMMAND_LIST_RESULT, type CommandEntry } from "./methods/engine-commands.js";

// ---------------------------------------------------------------------------
// §2.2 groups — every id below was grepped in the pinned engine registry.
// ---------------------------------------------------------------------------

/** Layer creation/grouping/stacking/alignment/artboards (§2.2 "Layer ops"). */
export const LAYER_COMMANDS = [
  "layer.new.layer",
  "layer.new.group",
  "layer.groupLayers",
  "layer.duplicate",
  "layer.delete",
  "layer.select",
  "layer.setProps",
  "layer.arrange.bringForward",
  "layer.arrange.sendBackward",
  "layer.arrange.bringToFront",
  "layer.arrange.sendToBack",
  "layer.arrange.reverse",
  "layer.align.leftEdges",
  "layer.align.horizontalCenters",
  "layer.align.rightEdges",
  "layer.align.topEdges",
  "layer.align.verticalCenters",
  "layer.align.bottomEdges",
  "layer.setExpanded",
  "layer.new.artboard",
  "layer.new.artboardFromGroup",
  "layer.new.artboardFromLayers",
] as const satisfies readonly string[];

/** Text layers (§2.2 "Text"). */
export const TEXT_COMMANDS = ["type.create", "type.edit"] as const satisfies readonly string[];

/** Fill and paint operations (§2.2 "Fill/paint"). */
export const FILL_PAINT_COMMANDS = [
  "edit.fill",
  "layer.fill.solidColor.set",
  "layer.fill.pattern.set",
  "paint.stroke",
  "paint.bucket",
  "paint.gradient",
] as const satisfies readonly string[];

/** Canvas/image geometry (§2.2 "Images/canvas"). */
export const IMAGE_COMMANDS = [
  "image.crop",
  "image.imageSize",
  "image.canvasSize",
] as const satisfies readonly string[];

/** Smart objects — the §8 component-instance mechanism (§2.2 "Smart objects"). */
export const SMART_OBJECT_COMMANDS = [
  "layer.smartObjects.convertToSmartObject",
  "layer.smartObjects.editContents",
  "layer.smartObjects.saveContents",
  "layer.smartObjects.updateModifiedContent",
] as const satisfies readonly string[];

/** Layer effects (§2.2 "Effects"; layer_style.rs style_cmd! kinds + replace + clear). */
export const EFFECT_COMMANDS = [
  "layer.layerStyle.dropShadow",
  "layer.layerStyle.stroke",
  "layer.layerStyle.colorOverlay",
  "layer.layerStyle.gradientOverlay",
  "layer.layerStyle.patternOverlay",
  "layer.layerStyle.innerShadow",
  "layer.layerStyle.outerGlow",
  "layer.layerStyle.innerGlow",
  "layer.layerStyle.bevelEmboss",
  "layer.layerStyle.satin",
  "layer.layerStyle.replace",
  "layer.layerStyle.clear",
] as const satisfies readonly string[];

/** Layer masks (§2.2 "Masks"). */
export const MASK_COMMANDS = [
  "layer.layerMask.revealAll",
  "layer.layerMask.hideAll",
  "layer.layerMask.revealSelection",
  "layer.layerMask.delete",
  "layer.layerMask.enabled",
  "layer.layerMask.linked",
  "layer.layerMask.edit",
] as const satisfies readonly string[];

/**
 * Adjustment layers (§2.2 "Adjustments": levels, curves, hue/saturation,
 * brightness/contrast — the ADJ table's exact id casings; the engine also serves
 * exposure, vibrance, colorBalance, blackWhite, photoFilter, channelMixer, invert,
 * posterize, threshold, gradientMap, selectiveColor and colorLookup, discovered at
 * runtime and never hardcoded as required).
 */
export const ADJUSTMENT_COMMANDS = [
  "layer.newAdjustmentLayer.levels",
  "layer.newAdjustmentLayer.curves",
  "layer.newAdjustmentLayer.hueSaturation",
  "layer.newAdjustmentLayer.brightnessContrast",
] as const satisfies readonly string[];

/** Templates/variants: data sets + layer comps (§2.2 "Templates/variants"). */
export const VARIANT_COMMANDS = [
  "image.variables.define",
  "image.variables.dataSets",
  "image.applyDataSet",
  "variables.list",
  "layerComp.new",
  "layerComp.update",
  "layerComp.apply",
  "layerComp.duplicate",
  "layerComp.rename",
  "layerComp.delete",
] as const satisfies readonly string[];

/**
 * Shapes/selection/history/misc (§2.2) plus the §21 fixture-pinned starters
 * (file.new, select.rect, filter.blur.gaussianBlur — tests/drift-check.test.ts keeps
 * them covered even if the pinned registry excerpt shrinks).
 */
export const UTILITY_COMMANDS = [
  "file.new",
  "shape.presets.place",
  "shape.presets.list",
  "select.rect",
  "select.all",
  "select.deselect",
  "select.inverse",
  "edit.undo",
  "edit.redo",
  "document.presets.list",
  "document.presets.get",
  "document.presets.save",
  "document.presets.delete",
  "file.export.presets.list",
  "file.export.presets.get",
  "file.export.presets.save",
  "file.export.presets.delete",
  "notes.add",
  "notes.set",
  "notes.delete",
  "notes.list",
  "actions.record",
  "actions.stop",
  "actions.play",
  "actions.list",
  "actions.get",
  "prefs.set",
  "command.list",
  "filter.blur.gaussianBlur",
] as const satisfies readonly string[];

/**
 * Every engine command id the studio product requires (spec §2.2, registry-verified).
 * The worker checks the live `engine.commands` reply against this list at startup
 * via discoverRequiredCommands() and refuses to plan when one is missing — ids are
 * never hardcoded blindly elsewhere (§2.2 rule).
 */
export const REQUIRED_ENGINE_COMMANDS = [
  ...LAYER_COMMANDS,
  ...TEXT_COMMANDS,
  ...FILL_PAINT_COMMANDS,
  ...IMAGE_COMMANDS,
  ...SMART_OBJECT_COMMANDS,
  ...EFFECT_COMMANDS,
  ...MASK_COMMANDS,
  ...ADJUSTMENT_COMMANDS,
  ...VARIANT_COMMANDS,
  ...UTILITY_COMMANDS,
] as const satisfies readonly string[];

/** Alias for consumers/tests that pin the list as "the required commands". */
export const REQUIRED_COMMANDS: readonly string[] = REQUIRED_ENGINE_COMMANDS;

// ---------------------------------------------------------------------------
// Failure surface — fleet envelope shape (docs/AGENTS.md), self-contained like
// budgets.ts/capabilities.ts (structurally compatible with @studio/config Failure).
// ---------------------------------------------------------------------------

/** Commands-surface error codes. Add-only, stable strings (§13.3 discipline). */
export const COMMANDS_ERROR_CODES = [
  /** The live registry parsed, but is missing one or more REQUIRED_ENGINE_COMMANDS ids. */
  "missing_required_commands",
  /** The `engine.commands` reply is not a bare array of command rows (rpc.rs #3684). */
  "invalid_command_registry",
] as const satisfies readonly string[];

export type CommandsErrorCode = (typeof COMMANDS_ERROR_CODES)[number];

/** Typed failure envelope; `missing` carries the fail-loud list when applicable. */
export interface CommandsFailure {
  readonly ok: false;
  readonly code: CommandsErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: false;
  /** Sorted required ids the registry did not serve (code: missing_required_commands). */
  readonly missing?: readonly string[];
}

export type CommandsResult<T> = { readonly ok: true; readonly value: T } | CommandsFailure;

// ---------------------------------------------------------------------------
// Startup discovery (§2.2: discover at startup, fail loudly when missing)
// ---------------------------------------------------------------------------

/**
 * The required ids missing from a served-id set. Pure: callers pass the live
 * registry's ids (e.g. from `engine.commands` or a fixture) and get the sorted
 * fail-loud remainder.
 */
export function missingRequiredCommands(
  servedIds: Iterable<string>,
  required: readonly string[] = REQUIRED_ENGINE_COMMANDS,
): readonly string[] {
  const served = servedIds instanceof Set ? servedIds : new Set(servedIds);
  return required.filter((id) => !served.has(id));
}

/**
 * Validates an `engine.commands` reply (a BARE array of command rows, rpc.rs #3684)
 * and checks it against the required list — the §2.2 startup contract:
 *
 *   - ok: true  → the parsed registry rows (CommandEntry[]) for further dispatch checks
 *                 (e.g. `needsDocument` planning, §2.2 note in the fixture).
 *   - ok: false → code "missing_required_commands" with the sorted `missing` ids
 *                 (fail loudly: the worker refuses to plan rather than hardcoding),
 *                 or "invalid_command_registry" when the reply is not a command list.
 *
 * The engine's registry is the only input; nothing is retried or inferred here —
 * a rejected reply is the caller's transport problem (errors.ts/retry.ts own that).
 */
export function discoverRequiredCommands(
  engineCommandsReply: unknown,
  required: readonly string[] = REQUIRED_ENGINE_COMMANDS,
): CommandsResult<readonly CommandEntry[]> {
  const parsed = COMMAND_LIST_RESULT.safeParse(engineCommandsReply);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_command_registry",
      message: "the engine.commands reply is not a bare array of command rows",
      hint: 'Expected the rpc.rs reply shape: [{"id","label","menu","shortcut","params","enabled","disabledReason","needsDocument",…}, …] with no {"commands": …} wrapper (#3684). Re-check the pinned engine revision and the protocol fixtures.',
      retryable: false,
    };
  }
  const commands: CommandEntry[] = parsed.data;
  const missing = missingRequiredCommands(
    commands.map((command) => command.id),
    required,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_required_commands",
      message: `the engine registry is missing ${missing.length} required command(s): ${missing.join(", ")}`,
      hint: "§2.2 keeps the live registry authoritative: this engine build cannot serve the studio command set. Refuse to plan instead of hardcoding a fallback; reconcile the pinned revision (vendor commands.rs) or the required list (src/commands.ts) in one commit.",
      retryable: false,
      missing,
    };
  }
  return { ok: true, value: commands };
}
