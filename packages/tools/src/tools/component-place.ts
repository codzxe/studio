// @studio/tools — component_place (§6 row 12; engine `component.inspect` +
// `component.place`, §8.3/§8.4). Reusable components: versioned, variable-driven
// layer groups; placing NEVER mutates the master and instances share the
// master's smart-object contents (§8.1).
//
// Flow:
//   1. Parse the `component` id@version pin (schema-verified shape).
//   2. `component.inspect {id, version}` → the §8.2 manifest (variable specs).
//      A failed inspect triggers ONE diagnostic `component.list` hop: an id
//      absent from the library → unknown_component (candidates: id@version
//      pins); a present id whose pinned version is not the library's current
//      one → the same error naming the available pin; anything else passes the
//      engine failure through untouched.
//   3. `vars` are validated against the manifest BEFORE any mutation (§8.4):
//      unknown names get the allowed list; kinds are checked (text `maxChars`,
//      colour hex, visibility boolean). The engine re-validates everything
//      (component_cmds.rs `check_var`) — the tool check is the actionable
//      first line of defence; when the manifest is unreadable, the values pass
//      through and the engine stays the authority (warning on the ok path).
//   4. anchor→bounds math (9-point), see ANCHOR_FRACTIONS below.
//   5. §5.2 budget charge for the ONE mutating command, then
//      engine.execute('component.place', …) → ok({ summary, documentRevision,
//      warnings }) with summary { instanceId, component: id@version,
//      variablesApplied }.
//
// Anchor formula (9-point). A component placed at frame (x', y', w, h) has its
// anchor point at (x' + fx·w, y' + fy·h) for the anchor's fractions
// (fx, fy) ∈ {0, ½, 1}². Solving "the component's anchor point lands at the
// bounds origin (x, y)" for the frame:
//
//     x' = x − fx·w        y' = y − fy·h        (w and h are unchanged)
//
// e.g. anchor "topRight" (1, 0) with bounds [900, 72, 180, 180] places the
// frame at [720, 72, 180, 180], so the frame's top-right corner — the badge's
// anchor point — lands exactly on (900, 72). The engine takes explicit bounds
// as the literal target frame (component_cmds.rs `target_rect` ignores `anchor`
// in that branch), so the tool sends the ADJUSTED frame and does NOT re-send
// the anchor (that would be ambiguous double-application). Without bounds the
// anchor travels as [fx, fy] fractions and the engine parks the design box at
// the canvas's matching point (`anchored_rect`) — fractions are accepted even
// when the manifest declares no anchor of that name.

import { z } from "zod";
import {
  MAX_ARG_STRING_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNINGS,
  MAX_WARNING_CHARS,
  cappedRecord,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
  zIdempotencyKey,
  zLayerRef,
} from "../kit.js";
import type { LayerRef } from "../kit.js";
import type { EngineCommandReport, Tool, ToolErr, ToolErrorCode } from "../types.js";
import {
  COMPONENT_LIST_COMMAND,
  candidatePins,
  engineFailureErr,
  readComponentList,
} from "./component-list.js";
import { capText, fieldOf, probeFields } from "./template-list.js";

// ---------------------------------------------------------------------------
// Contract limits (engine component_cmds.rs + §6.1 tool caps)
// ---------------------------------------------------------------------------

/** The manifest-inspect engine command (query, §8.3); the model never sees ids. */
export const COMPONENT_INSPECT_COMMAND = "component.inspect";
/** The single mutating engine command (§6 row 12). */
export const COMPONENT_PLACE_COMMAND = "component.place";

/** §8.4 per-call variable cap; the tool stays tighter than the engine's 64. */
export const MAX_PLACE_VARS = 20;
/** Bounds origin sanity cap (the vendor's canvas space; asset-place precedent). */
export const MAX_ORIGIN_PX = 300_000;
/** Per-side placement cap (engine MAX_TARGET_SIDE, §2.3). */
export const MAX_TARGET_SIDE = 16_384;
/** 64 MP placement ceiling (engine MAX_TARGET_PIXELS, spec §2.3). */
export const MAX_TARGET_PIXELS = 64_000_000;
/** Component ids: a-z, 0-9, -, starting alnum, ≤64 chars (engine id rule). */
export const MAX_COMPONENT_ID_CHARS = 64;
/** Versions are u32 on the engine (component_cmds.rs `version_param`). */
export const MAX_COMPONENT_VERSION = 4_294_967_295;

/**
 * §8.3's dedicated code for an unknown component id is `unknown_component`; the
 * shared §13.3 catalog is add-only and does not carry it yet, so the tool emits
 * the catalog's unknown-id code with candidate pins in the hint (W5-E/W5-B
 * fleet precedent). Swap this one line when the catalog adopts the code.
 */
export const UNKNOWN_COMPONENT_CODE: ToolErrorCode = "not_found";

/**
 * Same for §8.4's unknown-variable refusal (`unknown_component_vars`): the
 * catalog carries no component-specific code, so the generic §13.3 validation
 * code carries the §8.4 allowed list in the hint. One-line swap when adopted.
 */
export const UNKNOWN_COMPONENT_VARS_CODE: ToolErrorCode = "validation_failed";

// ---------------------------------------------------------------------------
// Error builders (§6.1: actionable, allowed lists attached)
// ---------------------------------------------------------------------------

function truncateStr(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Join names with ", ", capped to `budget` chars ("(+N more)" tail). */
function joinCapped(items: readonly string[], budget: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const item of items) {
    const addition = parts.length === 0 ? truncateStr(item, 80) : `, ${truncateStr(item, 80)}`;
    if (parts.length > 0 && used + addition.length > budget) {
      return `${parts.join("")} (+${items.length - parts.length} more)`;
    }
    parts.push(addition);
    used += addition.length;
  }
  return parts.join("");
}

/** §8.4: unknown component id — candidates are `id@version` pins (§7.2 pins). */
export function unknownComponentErr(component: string, candidates: readonly string[]): ToolErr {
  return err(
    UNKNOWN_COMPONENT_CODE,
    `No component matches "${truncateStr(component, 60)}" in the library`,
    {
      hint:
        candidates.length > 0
          ? `component_list shows the library; candidates: ${candidates.slice(0, 8).join(", ")}`
          : "component_list shows this workspace's components.",
      retryable: false,
    },
  );
}

/** §8.4: unknown variable names — the allowed list travels in the hint. */
export function unknownComponentVarsErr(
  component: string,
  unknown: readonly string[],
  allowed: readonly string[],
): ToolErr {
  return err(
    UNKNOWN_COMPONENT_VARS_CODE,
    `unknown component variable(s): ${joinCapped(unknown, 400)}`,
    {
      hint: `variables of ${truncateStr(component, 60)}: ${joinCapped(allowed, 400)}`,
      retryable: false,
    },
  );
}

/** The 9-point anchor would push the component frame off the canvas top/left. */
function offCanvasErr(anchor: string, placed: PlaceBounds): ToolErr {
  const fmt = (value: number): string => String(Number(value.toFixed(2)));
  return err(
    "validation_failed",
    `The ${anchor} anchor would place the component at (${fmt(placed[0])}, ${fmt(placed[1])}) — off the canvas (§8.3 refuses negative placement)`,
    {
      hint: "The anchor point must sit far enough from the top/left edge for the component's size; move the bounds origin or choose a different anchor.",
      retryable: false,
    },
  );
}

// ---------------------------------------------------------------------------
// Anchor math (9-point, pure — table-tested)
// ---------------------------------------------------------------------------

/** The 9-point anchor names (task-pinned order). */
export const COMPONENT_ANCHORS = [
  "center",
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomCenter",
  "bottomRight",
  "topCenter",
  "middleLeft",
  "middleRight",
] as const;

export type ComponentAnchor = (typeof COMPONENT_ANCHORS)[number];

/** Each anchor's fractions (fx, fy) of the placed frame (§8.3 9-point grid). */
export const ANCHOR_FRACTIONS: Readonly<Record<ComponentAnchor, readonly [number, number]>> = {
  center: [0.5, 0.5],
  topLeft: [0, 0],
  topRight: [1, 0],
  bottomLeft: [0, 1],
  bottomCenter: [0.5, 1],
  bottomRight: [1, 1],
  topCenter: [0.5, 0],
  middleLeft: [0, 0.5],
  middleRight: [1, 0.5],
};

export type PlaceBounds = readonly [number, number, number, number];

/**
 * Adjusts bounds so the component's anchor point lands on the bounds origin:
 * `x' = x − fx·w`, `y' = y − fy·h` (see the module header). Size is unchanged;
 * the ADJUSTED frame is what `component.place` receives.
 */
export function anchorAdjustedBounds(anchor: ComponentAnchor, bounds: PlaceBounds): PlaceBounds {
  const [x, y, w, h] = bounds;
  const [fx, fy] = ANCHOR_FRACTIONS[anchor];
  return [x - fx * w, y - fy * h, w, h];
}

// ---------------------------------------------------------------------------
// Argument schema (§6.1 strict: additionalProperties false, caps, guards)
// ---------------------------------------------------------------------------

const finitePx = z.number().refine((value) => Number.isFinite(value), {
  message: "bounds must be finite numbers (NaN and ±Infinity are rejected)",
});

/** [x, y, w, h]: finite; origin on-canvas; size ≥1px, ≤ engine caps (§2.3). */
export const zPlaceBounds = z
  .tuple([finitePx, finitePx, finitePx, finitePx])
  .refine(
    ([x, y, w, h]) =>
      x >= 0 &&
      y >= 0 &&
      x <= MAX_ORIGIN_PX &&
      y <= MAX_ORIGIN_PX &&
      w >= 1 &&
      h >= 1 &&
      w <= MAX_TARGET_SIDE &&
      h <= MAX_TARGET_SIDE &&
      w * h <= MAX_TARGET_PIXELS,
    {
      message: `bounds are [x, y, w, h]: x,y in 0..${MAX_ORIGIN_PX}, w,h in 1..${MAX_TARGET_SIDE} px and at most 64 MP (§2.3)`,
    },
  );

/** `id@version` pin — ids are a-z0-9- (engine id rule), versions u32 ≥ 1. */
export const zComponentRef = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}@[1-9][0-9]{0,9}$/, {
    message: 'must be component@version, e.g. "offer-badge@2" (§8)',
  })
  .refine((ref) => Number(ref.slice(ref.indexOf("@") + 1)) <= MAX_COMPONENT_VERSION, {
    message: `version must be at most ${MAX_COMPONENT_VERSION} (u32)`,
  });

export interface ComponentRef {
  readonly id: string;
  readonly version: number;
}

/** Splits a schema-verified pin; ids cannot contain "@" (engine id rule). */
export function parseComponentRef(ref: string): ComponentRef {
  const at = ref.indexOf("@");
  return { id: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

/** What a variable drives (§8.2 `text | color | visibility`). */
export type ComponentVarKind = "text" | "color" | "visibility";
/** Variable values: strings for text/colour, booleans for visibility (§8.2). */
export type ComponentVarValue = string | boolean;

export interface ComponentVariableSpec {
  readonly kind: ComponentVarKind;
  /** Text variables only: the manifest's `maxChars` (§8.2/§8.4). */
  readonly maxChars?: number;
}

/** The manifest's variable schema: names in manifest order + readable specs. */
export interface ComponentVarSchema {
  readonly names: readonly string[];
  readonly specs: Readonly<Record<string, ComponentVariableSpec>>;
}

const VARIABLE_SPEC_FIELDS = {
  kind: z.enum(["text", "color", "visibility"]),
  maxChars: z.number().int().min(1).max(4096),
} as const satisfies Readonly<Record<string, z.ZodTypeAny>>;

/**
 * Reads the §8.2 `variables` record off the inspected manifest. A name whose
 * spec is unreadable stays DECLARED (it keeps its place in `names`) but gets no
 * local kind check — the engine validates every value anyway (§8.4 authority).
 * Returns undefined when the whole record is unreadable (degraded mode).
 */
export function readComponentVarSchema(manifest: unknown): ComponentVarSchema | undefined {
  const raw = fieldOf(manifest, "variables");
  if (typeof raw !== "object" || raw === null) return undefined;
  const names: string[] = [];
  const specs: Record<string, ComponentVariableSpec> = {};
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (name.length === 0 || name.length > 64) continue; // manifest name cap
    names.push(name);
    const probed = probeFields(spec, VARIABLE_SPEC_FIELDS);
    const kind: unknown = probed.kind;
    if (kind === "text" || kind === "color" || kind === "visibility") {
      const variable: { kind: ComponentVarKind; maxChars?: number } = { kind };
      if (typeof probed.maxChars === "number") variable.maxChars = probed.maxChars;
      specs[name] = variable;
    }
  }
  return { names, specs };
}

/**
 * The engine's colour contract for component variables (component_manifest.rs
 * `parse_hex`): `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. The §6.1 tool schema
 * is wider (rgb()/hsl() strings pass it); values are narrowed here with an
 * actionable error instead of a cryptic engine BadParams (W5-D precedent).
 */
const ENGINE_VAR_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Unicode scalar count, mirroring the engine's `chars().count()`. */
function countChars(value: string): number {
  return [...value].length;
}

function kindErr(name: string, expected: string, got: string, hint: string): ToolErr {
  return err(
    "validation_failed",
    `Variable "${truncateStr(name, 64)}" must be ${expected}, got ${got}`,
    {
      hint,
      retryable: false,
    },
  );
}

/** One declared variable's value vs its §8.2 spec; undefined when it passes. */
function varKindErr(
  name: string,
  spec: ComponentVariableSpec,
  value: ComponentVarValue,
): ToolErr | undefined {
  switch (spec.kind) {
    case "text": {
      if (typeof value !== "string") {
        return kindErr(
          name,
          "a string (text variable)",
          typeof value,
          "component_list shows the variable names; the manifest declares each one's kind (§8.2).",
        );
      }
      const max = spec.maxChars;
      if (max !== undefined && countChars(value) > max) {
        return err(
          "validation_failed",
          `Variable "${truncateStr(name, 64)}" is ${countChars(value)} characters; the manifest caps it at ${max}`,
          {
            hint: `Shorten "${truncateStr(name, 64)}" to at most ${max} characters (§8.4 maxChars).`,
            retryable: false,
          },
        );
      }
      return undefined;
    }
    case "color": {
      if (typeof value !== "string") {
        return kindErr(
          name,
          "a colour string",
          typeof value,
          "Colour variables take #rgb/#rrggbb/#rrggbbaa hex (§8.2).",
        );
      }
      if (!ENGINE_VAR_COLOR_RE.test(value)) {
        return err(
          "validation_failed",
          `Variable "${truncateStr(name, 64)}": colour must be #rgb, #rrggbb or #rrggbbaa hex`,
          {
            hint: "Components read hex colours (§8.2); rgb()/hsl() pass the tool schema but the engine wants hex — e.g. #D96C3B.",
            retryable: false,
          },
        );
      }
      return undefined;
    }
    case "visibility": {
      if (typeof value !== "boolean") {
        return kindErr(
          name,
          "true or false (visibility variable)",
          typeof value,
          "Visibility variables toggle a layer on or off (§8.2).",
        );
      }
      return undefined;
    }
  }
}

export type VarsValidation = { readonly ok: true; readonly applied: readonly string[] } | ToolErr;

/**
 * Validates `vars` against the manifest's variable schema (§8.4): unknown names
 * are refused with the allowed list (all of them, in manifest order); declared
 * names are kind-checked in manifest order so failures are deterministic. On
 * success `applied` lists the override names in manifest order.
 */
export function validateComponentVars(input: {
  readonly component: string;
  readonly schema: ComponentVarSchema;
  readonly vars: Readonly<Record<string, ComponentVarValue>>;
}): VarsValidation {
  const declared = new Set(input.schema.names);
  const unknown = Object.keys(input.vars).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    return unknownComponentVarsErr(input.component, unknown, input.schema.names);
  }
  const applied: string[] = [];
  for (const name of input.schema.names) {
    if (!Object.hasOwn(input.vars, name)) continue;
    const spec = input.schema.specs[name];
    const value = input.vars[name];
    if (spec !== undefined && value !== undefined) {
      const bad = varKindErr(name, spec, value);
      if (bad !== undefined) return bad;
    }
    applied.push(name);
  }
  return { ok: true, applied };
}

// ---------------------------------------------------------------------------
// Reply reading (defensive, same conformance as component-list)
// ---------------------------------------------------------------------------

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The inspected §8.2 manifest: structural `manifest` field, or message JSON. */
export function readInspectedManifest(report: EngineCommandReport): unknown {
  const direct = fieldOf(report, "manifest");
  if (typeof direct === "object" && direct !== null) return direct;
  if (typeof report.message === "string") {
    const parsed = tryParseObject(report.message);
    const manifest = parsed === undefined ? undefined : fieldOf(parsed, "manifest");
    if (manifest !== undefined) return manifest;
    return parsed;
  }
  return undefined;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** One engine warning ({warning}|{variable,…}|string) as a compact string. */
function renderEngineWarning(entry: unknown): string {
  if (typeof entry === "string") return capText(entry, MAX_WARNING_CHARS);
  if (typeof entry === "object" && entry !== null) {
    const record = entry as Record<string, unknown>;
    const main = firstString(record, ["warning", "message", "error"]);
    const prefix = firstString(record, ["variable", "layer", "code", "slot"]);
    if (main !== undefined) {
      return capText(prefix !== undefined ? `${prefix}: ${main}` : main, MAX_WARNING_CHARS);
    }
    if (prefix !== undefined) return capText(prefix, MAX_WARNING_CHARS);
  }
  return "(unrenderable engine warning)";
}

export interface PlacedInstance {
  /** The instance group's layer id, stringified; null when the reply lacks it. */
  readonly instanceId: string | null;
  readonly warnings: readonly string[];
}

/** Reads `component.place`'s {instance, warnings} off the minimal seam. */
export function readPlacedInstance(report: EngineCommandReport): PlacedInstance {
  type PlaceFields = EngineCommandReport & { instance?: unknown; warnings?: unknown };
  const source = report as PlaceFields;
  let instance = source.instance;
  let warnings = Array.isArray(source.warnings) ? source.warnings : undefined;
  if (instance === undefined && warnings === undefined) {
    const parsed = typeof report.message === "string" ? tryParseObject(report.message) : undefined;
    if (parsed !== undefined && "instance" in parsed) instance = parsed.instance;
    if (parsed !== undefined && Array.isArray(parsed.warnings)) warnings = parsed.warnings;
  }
  const instanceId =
    typeof instance === "number" && Number.isFinite(instance)
      ? String(instance)
      : typeof instance === "string" && instance.length > 0
        ? instance
        : null;
  return { instanceId, warnings: (warnings ?? []).map(renderEngineWarning) };
}

/** zLayerRef → the engine's layerRef: numeric ids become numbers, names pass. */
function engineParentRef(ref: LayerRef): number | string {
  if ("layerId" in ref) {
    return /^\d+$/.test(ref.layerId) ? Number(ref.layerId) : ref.layerId;
  }
  // The engine resolves names; ambiguity is its error with candidates (§6.1).
  return ref.layerName;
}

export interface ComponentPlaceArgs {
  /** `id@version` pin, e.g. "offer-badge@2". */
  readonly component: string;
  /** A group to place into (§8.3 `parent`); default: the active stack position. */
  readonly parent?: LayerRef;
  readonly bounds?: PlaceBounds;
  readonly anchor?: ComponentAnchor;
  readonly vars?: Record<string, ComponentVarValue>;
  /** Accepted for the executor's retry dedupe (§14.2); never engine-forwarded. */
  readonly idempotencyKey?: string;
}

const componentPlaceArgs = strictObject({
  component: zComponentRef,
  parent: zLayerRef.optional(),
  bounds: zPlaceBounds.optional(),
  anchor: z.enum(COMPONENT_ANCHORS).optional(),
  // ≤20 entries (§8.4 per-call cap); values are string|boolean — the manifest
  // decides which (text/colour → string, visibility → boolean).
  vars: cappedRecord(
    MAX_PLACE_VARS,
    z.union([cappedString(MAX_ARG_STRING_CHARS), z.boolean()]),
  ).optional(),
  // §6 says every mutating tool carries one; the executor's journal (§5.6)
  // coalesces retries, so the key is accepted but not engine-forwarded.
  idempotencyKey: zIdempotencyKey.optional(),
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const componentPlaceTool: Tool<ComponentPlaceArgs> = defineTool({
  name: "component_place",
  description:
    "Place a reusable component (id@version pin) into the document, optionally into a parent group, at a bounds box with a 9-point anchor, overriding its variables; the master is never mutated.",
  args: componentPlaceArgs,
  async run(ctx, args, signal) {
    const ref = parseComponentRef(args.component);
    const warnings: string[] = [];

    // 1. Manifest inspect (§8.3): the variable specs for tool-side validation.
    const inspected = await ctx.engine.execute(
      { id: COMPONENT_INSPECT_COMMAND, params: { id: ref.id, version: ref.version } },
      { signal },
    );
    let manifest: unknown;
    if (inspected.ok) {
      manifest = readInspectedManifest(inspected.value);
    } else {
      // 2. Diagnostic list hop (one query): unknown id → candidates; stale
      //    version pin → the available pin; anything else passes through.
      const listed = await ctx.engine.execute(
        { id: COMPONENT_LIST_COMMAND, params: {} },
        { signal },
      );
      if (!listed.ok) return engineFailureErr(inspected);
      const { rows } = readComponentList(listed.value);
      const row = rows.find((candidate) => candidate.id === ref.id);
      if (row === undefined) {
        return unknownComponentErr(args.component, candidatePins(rows));
      }
      if (row.version !== ref.version) {
        return err(
          UNKNOWN_COMPONENT_CODE,
          `No version ${ref.version} of component "${ref.id}" is in the library (current: ${row.version})`,
          {
            hint: `Place ${ref.id}@${row.version}, or component_list to see every component.`,
            retryable: false,
          },
        );
      }
      return engineFailureErr(inspected);
    }

    // 3. Variable validation (§8.4) BEFORE any mutation. Without a readable
    //    variable schema the values pass through and the engine validates.
    const requestedVars = args.vars === undefined ? [] : Object.keys(args.vars);
    let appliedVars: readonly string[] = [];
    if (requestedVars.length > 0) {
      const schema = manifest === undefined ? undefined : readComponentVarSchema(manifest);
      if (schema === undefined) {
        warnings.push(
          "the component's variable schema was not readable in the engine reply; variable names and kinds are validated by the engine only",
        );
        appliedVars = requestedVars;
      } else {
        const checked = validateComponentVars({
          component: args.component,
          schema,
          vars: args.vars ?? {},
        });
        if (!checked.ok) return checked;
        appliedVars = checked.applied;
      }
    }

    // 4. Engine params (§8.3 shapes; the model never sees these keys).
    const params: Record<string, unknown> = { id: ref.id, version: ref.version };
    if (args.parent !== undefined) params.parent = engineParentRef(args.parent);
    if (args.bounds !== undefined) {
      if (args.anchor !== undefined) {
        const placed = anchorAdjustedBounds(args.anchor, args.bounds);
        if (placed[0] < 0 || placed[1] < 0) return offCanvasErr(args.anchor, placed);
        params.bounds = placed; // anchor already baked in (engine uses bounds literally)
      } else {
        params.bounds = [...args.bounds];
      }
    } else if (args.anchor !== undefined) {
      // No box: fractions tell the engine to park the design box at the
      // canvas's matching point (accepted even for undeclared anchor names).
      params.anchor = [...ANCHOR_FRACTIONS[args.anchor]];
    }
    if (requestedVars.length > 0) params.vars = { ...(args.vars ?? {}) };

    // 5. §5.2: charge the one mutating command; stop cleanly at the boundary.
    if (!ctx.budgets.charge({ commands: 1 })) {
      return err(
        "budget_exceeded",
        "The run's command budget ran out before component_place could dispatch",
        {
          hint: "The executor stops cleanly with a partial charge (§5.2); continue on a fresh run.",
          retryable: false,
        },
      );
    }

    // 6. Place (§8.3): the master is copied with fresh ids, never mutated.
    const placed = await ctx.engine.execute({ id: COMPONENT_PLACE_COMMAND, params }, { signal });
    if (!placed.ok) return engineFailureErr(placed);

    // 7. Compact §6.1 reply: { instanceId, component, variablesApplied }.
    const instance = readPlacedInstance(placed.value);
    if (instance.instanceId === null) {
      warnings.push(
        "the engine reply did not identify the placed instance; find the new component group with workspace_snapshot",
      );
    }
    const summary = JSON.stringify({
      instanceId: instance.instanceId,
      component: args.component,
      variablesApplied: appliedVars,
    });
    if (summary.length > MAX_SUMMARY_CHARS) {
      warnings.push("the summary was trimmed to fit the compact-reply budget (§6.1)");
    }
    const merged = [...instance.warnings, ...warnings].slice(0, MAX_WARNINGS);
    ctx.logger.debug("component_place resolved", {
      component: args.component,
      appliedVars: appliedVars.length,
      instanceId: instance.instanceId,
    });
    return ok({
      summary: truncateStr(summary, MAX_SUMMARY_CHARS),
      documentRevision: placed.value.revision,
      warnings: merged.length > 0 ? merged : undefined,
    });
  },
});
