// @studio/tools — component_set_vars (§6 row 13; §8.3 command surface; §8.4 rules).
// Owner: W5-L.
//
// Overrides one placed component instance's variables — text, colour, visibility
// — without ever touching the master (§8.4: placing never mutates the master).
// Flow:
//   1. Resolve the instance ref against the compact layer tree (§6.1: layer_id
//      first, then exact name, then the engine-style case-insensitive fallback;
//      ambiguity is an error with the candidate ids listed).
//   2. Resolve the instance RECORD (which master the group was placed from)
//      through the ctx.components seam, then preflight the vars against the
//      CURRENT component manifest — §8.4 "instance variables are schema-checked":
//      unknown names are errors with the allowed list attached, kinds and text
//      maxChars are enforced, colours are narrowed to the engine's hex. The
//      engine re-checks against the same manifest (component_cmds.rs
//      set_vars_core → load_manifest, current version, NOT the placed one), so
//      the preflight only fails BEFORE any mutation.
//   3. engine.execute(component.setVars { instance, vars }) — ONE mutating
//      command. It MERGES into the per-instance state (setVars never replaces:
//      unset variables keep their values), recolours the bound layers and
//      applies text/visibility through the instance's data set (§8.3).
//   4. reapply (§8.4 opt-in, default false — "component updates across instances
//      are opt-in (never silently restyle a user's document)"): when true, ALSO
//      engine.execute(component.updateInstance { instance }), which pulls the
//      latest master version while KEEPING the just-set variables and reporting
//      edits outside the declared variables as userChanges. A reapply failure is
//      a WARNING, never an error: the setVars mutation already succeeded and
//      stands (documented choice per §8.4 — the opt-in pull is best-effort).
//
// Seams declared HERE because types.ts keeps ctx minimal (W5-F precedent):
//   - `ComponentRegistryLike` (`ctx.components`): types.ts has NO component seam
//     (checked first, per task). The worker wraps the engine's component library
//     (engine-patches/component_cmds): listInstances() exposes the per-document
//     instance records (the `cmpn` state component.place records on the group —
//     the engine surface has no query command for them, so the worker tracks
//     placements or queries the session), getManifest() the §8.2 manifests.
//   - The vars value union (string | boolean) matches W5-K's component_place
//     `vars` surface; declared locally until W5-K lands (parallel wave).
//
// Budget: 1 mutating command, +1 when reapply pulls an update; charged together
// before any mutation so a boundary hit stops cleanly (§5.2).

import { z } from "zod";
import {
  type LayerRef,
  MAX_ARG_STRING_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNINGS,
  MAX_WARNING_CHARS,
  ToolError,
  cappedRecord,
  cappedString,
  defineTool,
  err,
  isValidColor,
  ok,
  strictObject,
  zLayerRef,
} from "../kit.js";
import type {
  EngineCommandReport,
  EngineFailure,
  EngineLayerSummary,
  Tool,
  ToolContext,
  ToolErr,
} from "../types.js";
import { resolveLayerRef } from "./layer-ops.js";

/** The single engine command underneath (§6 row 13); the model never sees ids. */
export const COMPONENT_SET_VARS_COMMAND = "component.setVars";
/** §8.4 opt-in update pull; component.updateInstance { instance }. */
export const COMPONENT_UPDATE_INSTANCE_COMMAND = "component.updateInstance";

/** Task cap: ≤ 20 variable overrides per call (the engine's own MAX_VARS is 64). */
export const MAX_COMPONENT_VARS = 20;
/** Manifest variable names are 1..64 chars (component_manifest.rs); mirrored at the schema. */
const MAX_VAR_NAME_CHARS = 64;
/**
 * component_manifest.rs MAX_VAR_CHARS: the longest a text variable may run when
 * the manifest sets no maxChars. The boundary caps strings at 2000 (§6.2), so
 * this default is effectively unreachable through the schema — kept for parity.
 */
const ENGINE_DEFAULT_MAX_VAR_CHARS = 4096;
/**
 * Colour variables reach the engine as hex only (component_manifest.rs
 * parse_hex): #RGB, #RGBA, #RRGGBB, #RRGGBBAA. The tool schema accepts the wider
 * §6.1 set via isValidColor; the manifest preflight narrows with an actionable
 * error instead of a cryptic engine BadColor.
 */
const ENGINE_COMPONENT_HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// ---------------------------------------------------------------------------
// Component registry seam (declared here; types.ts lacks it — see header)
// ---------------------------------------------------------------------------

/** What a variable drives (§8.2: `text | color | visibility`). */
export type ComponentVarKind = "text" | "color" | "visibility";

/** One declared variable (§8.2 manifest shape; camelCase like the wire format). */
export interface ComponentVariableSpec {
  readonly kind: ComponentVarKind;
  readonly default?: string | boolean;
  readonly maxChars?: number;
}

/** The parts of a §8.2 component manifest this tool needs for validation. */
export interface ComponentManifestLike {
  readonly id: string;
  readonly version: number;
  readonly variables: Readonly<Record<string, ComponentVariableSpec>>;
}

/** The engine's per-instance record (§8.3): the group a component.place created. */
export interface ComponentInstanceRecord {
  /** The instance group's layer id in THIS document. */
  readonly layerId: string;
  /** Which master the instance was placed from. */
  readonly component: string;
  /** The placed master version (informational; validation uses the current one). */
  readonly version: number;
}

/**
 * The workspace component library, worker-wired on ctx. Tenant-scoped like every
 * other seam (§15.1): it only ever answers for the current document/workspace.
 */
export interface ComponentRegistryLike {
  /** Placed component instances in the current document (§8.3 instance records). */
  listInstances(): Promise<readonly ComponentInstanceRecord[]>;
  /** The CURRENT manifest of a component (mirrors set_vars_core's load_manifest). */
  getManifest(componentId: string): Promise<ComponentManifestLike | undefined>;
}

/** What component_set_vars runs against: the base context + the component seam. */
export interface ComponentSetVarsContext extends ToolContext {
  readonly components: ComponentRegistryLike;
}

function isComponentSetVarsContext(value: ToolContext): value is ComponentSetVarsContext {
  const candidate = value as Partial<ComponentSetVarsContext>;
  return candidate.components !== undefined;
}

function requireComponentSetVarsContext(ctx: ToolContext): ComponentSetVarsContext {
  if (!isComponentSetVarsContext(ctx)) {
    throw new ToolError(
      "internal_error",
      "component_set_vars requires the component registry seam on ctx",
      {
        hint: "The agent runtime wires ctx.components (listInstances + getManifest) over the engine's component library (§8.3).",
        retryable: false,
      },
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Argument schema (§6.1: strict, capped; pinned task shape)
// ---------------------------------------------------------------------------

/**
 * One variable override: text and colour values are strings, visibility values
 * are booleans. The KIND is decided by the component manifest, not the schema —
 * the preflight below enforces it (§8.4 schema-checked).
 */
const componentVarValueSchema = z.union([z.boolean(), cappedString(MAX_ARG_STRING_CHARS)]);

/** The vars value type after parsing (same union as W5-K's component_place vars). */
export type ComponentVarValue = string | boolean;

export interface ComponentSetVarsArgs {
  /** The placed component's group: layer_id or layer_name (§6.1 reference). */
  readonly instance: LayerRef;
  /** Variable overrides, ≤ 20 entries, ≥ 1 (§8.4 schema-checked against the manifest). */
  readonly vars: Record<string, ComponentVarValue>;
  /** §8.4 opt-in: also pull the latest component version. Default false — never silently restyle. */
  readonly reapply?: boolean;
}

export const componentSetVarsArgsSchema = strictObject({
  instance: zLayerRef,
  vars: cappedRecord(MAX_COMPONENT_VARS, componentVarValueSchema).superRefine((entries, ctx) => {
    if (Object.keys(entries).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set at least one variable" });
    }
    for (const name of Object.keys(entries)) {
      if (name.length > MAX_VAR_NAME_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `variable names are 1..${MAX_VAR_NAME_CHARS} characters`,
        });
      }
    }
  }),
  reapply: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Small pure helpers (exported pieces are table-tested; nothing touches the engine)
// ---------------------------------------------------------------------------

function truncateStr(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Clip to the kit's hint/message caps — assembled hints are never trusted to fit. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Join names with ", ", budget-capped with a "(+N more)" tail; each name ≤ 80. */
function joinCapped(items: readonly string[], budget: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const item of items) {
    const piece = truncateStr(item, 80);
    const addition = parts.length === 0 ? piece : `, ${piece}`;
    if (parts.length > 0 && used + addition.length > budget) {
      return `${parts.join("")} (+${items.length - parts.length} more)`;
    }
    parts.push(addition);
    used += addition.length;
  }
  return parts.join("");
}

/**
 * component_cmds.rs `layer_ref` takes a JSON number (layer id) or a string
 * (layer NAME). EngineLayerSummary.layerId is a string, so numeric ids must be
 * converted or the engine would treat "14" as a name; a non-numeric id falls
 * back to the (already uniqueness-checked) layer name.
 */
export function engineInstanceRef(layerId: string, layerName: string): number | string {
  if (/^[0-9]+$/.test(layerId)) {
    const numeric = Number(layerId);
    if (Number.isSafeInteger(numeric)) {
      return numeric;
    }
  }
  return layerName;
}

/** The maxChars cap for a text variable (component_manifest.rs MAX_VAR_CHARS default). */
function textMaxChars(spec: ComponentVariableSpec): number {
  const declared = spec.maxChars;
  return declared !== undefined && Number.isInteger(declared) && declared > 0
    ? declared
    : ENGINE_DEFAULT_MAX_VAR_CHARS;
}

function kindMismatchErr(name: string, expected: string, got: ComponentVarValue): ToolErr {
  const gotDesc = typeof got === "boolean" ? "a boolean" : "a string";
  return err(
    "validation_failed",
    `variable "${truncateStr(name, 80)}" expects ${expected}, got ${gotDesc}`,
    {
      hint: "component variables are schema-checked against the component's manifest (§8.4); component_inspect lists each variable's kind.",
      retryable: false,
    },
  );
}

function colorKindErr(name: string, value: ComponentVarValue): ToolErr {
  const convertible = typeof value === "string" && isValidColor(value);
  return err(
    "validation_failed",
    `variable "${truncateStr(name, 80)}" must be a hex colour (#RGB, #RRGGBB or #RRGGBBAA)`,
    {
      hint: convertible
        ? "rgb()/hsl() colours pass tool schemas but the component engine reads hex only; convert to #RRGGBB first (§8.4)."
        : "Component colour variables are hex strings: #F60, #FF6600 or #FF6600AA (§8.4).",
      retryable: false,
    },
  );
}

export type VarsValidation =
  | { readonly ok: true; readonly vars: Readonly<Record<string, ComponentVarValue>> }
  | ToolErr;

/**
 * Preflights variable overrides against the component manifest (§8.4):
 * unknown names → error with the allowed list attached; kind violations, colour
 * format and text maxChars → actionable errors. Pure and deterministic — args'
 * own key order, first violation wins (the engine checks in the same order).
 */
export function validateVarsAgainstManifest(
  manifest: ComponentManifestLike,
  vars: Readonly<Record<string, ComponentVarValue>>,
): VarsValidation {
  const declared = manifest.variables;
  const known = Object.keys(declared);
  const knownSet = new Set(known);
  const requested = Object.keys(vars);
  const unknown = requested.filter((name) => !knownSet.has(name));
  if (unknown.length > 0) {
    const allowed = known.length > 0 ? joinCapped(known, 400) : "(none)";
    return err("validation_failed", `unknown variables: ${joinCapped(unknown, 400)}`, {
      hint: clip(`allowed variables: ${allowed}`, MAX_HINT_CHARS),
      retryable: false,
    });
  }
  for (const name of requested) {
    const spec = declared[name];
    if (spec === undefined) {
      continue; // unreachable: unknown names were filtered above
    }
    const value = vars[name];
    switch (String(spec.kind)) {
      case "text": {
        if (typeof value !== "string") {
          return kindMismatchErr(name, "a string", value);
        }
        const max = textMaxChars(spec);
        // Code points, not UTF-16 units — matches the engine's chars().count().
        const length = [...value].length;
        if (length > max) {
          return err(
            "validation_failed",
            `variable "${truncateStr(name, 80)}" is ${length} chars, over its maxChars (${max})`,
            { hint: `shorten to ${max} characters or fewer (§8.4)`, retryable: false },
          );
        }
        break;
      }
      case "visibility": {
        if (typeof value !== "boolean") {
          return kindMismatchErr(name, "true or false", value);
        }
        break;
      }
      case "color": {
        if (typeof value !== "string" || !ENGINE_COMPONENT_HEX_RE.test(value)) {
          return colorKindErr(name, value);
        }
        break;
      }
      default: {
        // Seam drift: §8.2 kinds are text | color | visibility only.
        return err(
          "validation_failed",
          `variable "${truncateStr(name, 80)}" has unsupported kind "${String(spec.kind)}"`,
          { hint: "§8.2 variable kinds are text, color and visibility.", retryable: false },
        );
      }
    }
  }
  return { ok: true, vars };
}

// ---------------------------------------------------------------------------
// Engine reply reading — the minimal seam carries rich fields structurally, or
// JSON-encoded in `message` (W5-D's adapter-conformance belt)
// ---------------------------------------------------------------------------

function reportPayload(report: EngineCommandReport): Record<string, unknown> {
  const source = report as EngineCommandReport & Record<string, unknown>;
  const hasStructural =
    source.vars !== undefined ||
    source.warnings !== undefined ||
    source.updated !== undefined ||
    source.userChanges !== undefined ||
    source.from !== undefined ||
    source.to !== undefined;
  if (hasStructural) {
    return source;
  }
  if (typeof report.message === "string") {
    try {
      const parsed: unknown = JSON.parse(report.message);
      if (typeof parsed === "object" && parsed !== null) {
        return { ...source, ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // `message` is prose, not JSON — the structural view stands.
    }
  }
  return source;
}

function plainObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** component.setVars reply: { instance, vars, warnings } — the merged state after the change. */
export interface SetVarsReport {
  /** The merged per-instance state after the change; undefined on minimal replies. */
  readonly vars: Readonly<Record<string, unknown>> | undefined;
  readonly warnings: readonly unknown[];
}

export function readSetVarsReport(report: EngineCommandReport): SetVarsReport {
  const payload = reportPayload(report);
  return {
    vars: plainObject(payload.vars),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
  };
}

/** component.updateInstance reply: { instance, component, from, to, updated, userChanges, warnings, vars }. */
export interface UpdateInstanceReport {
  readonly updated: boolean | undefined;
  readonly from: number | undefined;
  readonly to: number | undefined;
  readonly userChanges: readonly unknown[];
  readonly warnings: readonly unknown[];
}

export function readUpdateInstanceReport(report: EngineCommandReport): UpdateInstanceReport {
  const payload = reportPayload(report);
  return {
    updated: typeof payload.updated === "boolean" ? payload.updated : undefined,
    from: typeof payload.from === "number" ? payload.from : undefined,
    to: typeof payload.to === "number" ? payload.to : undefined,
    userChanges: Array.isArray(payload.userChanges) ? payload.userChanges : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
  };
}

/**
 * One engine soft warning as a compact string. component_cmds.rs shapes are
 * `{"warning": "…"}` and `{"variable": name, "warning": "…"}`; strings pass
 * through; anything else degrades to a fixed marker (§6.1: never an engine dump).
 */
export function renderComponentWarning(entry: unknown): string {
  if (typeof entry === "string") {
    return truncateStr(entry, MAX_WARNING_CHARS);
  }
  const record = plainObject(entry);
  if (record !== undefined) {
    const message =
      typeof record.warning === "string"
        ? record.warning
        : typeof record.message === "string"
          ? record.message
          : typeof record.detail === "string"
            ? record.detail
            : undefined;
    const variable = typeof record.variable === "string" ? record.variable : undefined;
    if (message !== undefined) {
      const head =
        variable !== undefined && !message.includes(variable) ? `variable ${variable}: ` : "";
      return truncateStr(`${head}${message}`, MAX_WARNING_CHARS);
    }
  }
  return "(unrenderable component warning)";
}

/**
 * One §8.4 userChange as a compact string. The engine emits
 * `{"layer", "aspect", "detail"}` (diff_layer) and the docs' older
 * `{"layer", "change"}` shape; both render, strings pass through.
 */
export function renderUserChange(entry: unknown): string {
  if (typeof entry === "string") {
    return truncateStr(entry, MAX_WARNING_CHARS);
  }
  const record = plainObject(entry);
  if (record !== undefined) {
    const layer = typeof record.layer === "string" ? record.layer : undefined;
    const aspect = typeof record.aspect === "string" ? record.aspect : undefined;
    const detail =
      typeof record.detail === "string"
        ? record.detail
        : typeof record.change === "string"
          ? record.change
          : undefined;
    const parts = [
      layer === undefined ? undefined : truncateStr(layer, 60),
      aspect,
      detail === undefined ? undefined : truncateStr(detail, 120),
    ].filter((part): part is string => part !== undefined);
    if (parts.length > 0) {
      return truncateStr(parts.join(": "), MAX_WARNING_CHARS);
    }
  }
  return "(unrenderable user change)";
}

/** §8.4: user edits outside the declared variables are reported, never discarded. */
function reapplyWarningsFor(report: UpdateInstanceReport, component: string): readonly string[] {
  const out: string[] = [];
  const name = truncateStr(component, 64);
  if (report.updated === false) {
    out.push(`[reapply] ${name}: already on the latest version; nothing was pulled`);
  } else {
    const span =
      report.from !== undefined && report.to !== undefined
        ? `v${report.from}→v${report.to}`
        : "the latest version";
    const suffix = report.updated === undefined ? "update pull completed" : `pulled ${span}`;
    out.push(`[reapply] ${name}: ${suffix}`);
  }
  const changes = report.userChanges;
  const shownChanges = Math.min(changes.length, 2);
  for (let index = 0; index < shownChanges; index += 1) {
    out.push(`[user change] ${renderUserChange(changes[index])}`);
  }
  if (changes.length > shownChanges) {
    out.push(`[user change] (+${changes.length - shownChanges} more)`);
  }
  for (const warning of report.warnings) {
    out.push(renderComponentWarning(warning));
  }
  return out;
}

/** Cap the merged warnings at the kit's 20; the tail is noted, never dropped silently. */
function capWarnings(merged: readonly string[]): readonly string[] {
  if (merged.length <= MAX_WARNINGS) {
    return merged;
  }
  const keep = MAX_WARNINGS - 1;
  const omitted = merged.length - keep;
  return [...merged.slice(0, keep), `(+${omitted} more warnings omitted)`];
}

// ---------------------------------------------------------------------------
// §6.1 compact summary — { instance, updated, reapplyApplied } as JSON
// (the kit's envelope carries a string summary; fleet precedent W5-A/W5-D)
// ---------------------------------------------------------------------------

export function summarizeSetVars(input: {
  readonly instance: string;
  readonly updated: readonly string[];
  readonly reapplyApplied: boolean;
}): string {
  const encode = (names: readonly string[], omitted: number): string => {
    const list = omitted > 0 ? [...names, `(+${omitted} more)`] : [...names];
    return JSON.stringify({
      instance: input.instance,
      updated: list,
      reapplyApplied: input.reapplyApplied,
    });
  };
  let out = encode(input.updated, 0);
  if (out.length <= MAX_SUMMARY_CHARS) {
    return out;
  }
  // Long names: shrink each to 32 chars before dropping any (§6.1 compactness).
  const shrunk = input.updated.map((name) => truncateStr(name, 32));
  out = encode(shrunk, 0);
  if (out.length <= MAX_SUMMARY_CHARS) {
    return out;
  }
  // Still too long: drop from the tail, noting the count.
  for (let keep = shrunk.length - 1; keep >= 0; keep -= 1) {
    out = encode(shrunk.slice(0, keep), shrunk.length - keep);
    if (out.length <= MAX_SUMMARY_CHARS) {
      return out;
    }
  }
  return encode([], input.updated.length);
}

// ---------------------------------------------------------------------------
// Error builders (§6.1: actionable, candidates listed)
// ---------------------------------------------------------------------------

/** The layer exists but carries no component instance record (§8.3 `cmpn`). */
function notComponentInstanceErr(
  layer: EngineLayerSummary,
  instances: readonly ComponentInstanceRecord[],
): ToolErr {
  const shown = instances
    .slice(0, 8)
    .map((instance) => `id ${instance.layerId} (${truncateStr(instance.component, 64)})`);
  const extra = instances.length > 8 ? ` (+${instances.length - 8} more)` : "";
  const hint =
    instances.length > 0
      ? `placed component instances: ${shown.join(", ")}${extra}`
      : "the document has no placed component instances; component_place creates one";
  return err(
    "not_found",
    `Layer "${truncateStr(layer.name, 80)}" (id ${layer.layerId}) is not a component instance`,
    {
      hint: clip(hint, MAX_HINT_CHARS),
      retryable: false,
    },
  );
}

/** EngineFailure → ToolErr passthrough (engine text is data §5.7; caps enforced by err()). */
function engineFailureErr(failure: EngineFailure): ToolErr {
  const message =
    failure.message.trim().length > 0
      ? truncateStr(failure.message, MAX_ERROR_MESSAGE_CHARS)
      : "The component command was rejected by the engine";
  return err(failure.code, message, {
    hint: failure.hint === undefined ? undefined : truncateStr(failure.hint, MAX_HINT_CHARS),
    retryable: failure.retryable,
  });
}

// ---------------------------------------------------------------------------
// The tool (§6 row 13)
// ---------------------------------------------------------------------------

export const componentSetVarsTool: Tool<ComponentSetVarsArgs> = defineTool({
  name: "component_set_vars",
  description:
    "Override a placed component instance's variables (text, colour, visibility). " +
    "Variables are schema-checked against the component; newer component versions " +
    "are only pulled when reapply is true (§8.4: never silently restyle).",
  args: componentSetVarsArgsSchema,
  async run(ctx, args, signal) {
    const cctx = requireComponentSetVarsContext(ctx);

    // 1. §6.1 ref resolution against the compact tree, before any mutation.
    const layers = await ctx.engine.listLayers();
    if (!layers.ok) {
      return engineFailureErr(layers);
    }
    const resolved = resolveLayerRef(args.instance, layers.value);
    if (!resolved.ok) {
      return resolved;
    }

    // 2. The instance record: which master this group was placed from (§8.3).
    const instances = await cctx.components.listInstances();
    const record = instances.find((instance) => instance.layerId === resolved.layer.layerId);
    if (record === undefined) {
      return notComponentInstanceErr(resolved.layer, instances);
    }

    // 3. Preflight the vars against the CURRENT manifest (§8.4 schema-checked;
    //    the engine re-checks the same way, so this fails before any mutation).
    const manifest = await cctx.components.getManifest(record.component);
    if (manifest === undefined) {
      return err(
        "not_found",
        `The manifest for component "${truncateStr(record.component, 64)}" is unavailable`,
        {
          hint: "component_list shows the workspace library; if the master was removed, re-place the instance with component_place.",
          retryable: false,
        },
      );
    }
    const validated = validateVarsAgainstManifest(manifest, args.vars);
    if (!validated.ok) {
      return validated;
    }

    // 4. §5.2: charge exactly what is dispatched (setVars, plus the opt-in pull),
    //    before mutating — a boundary hit stops cleanly with nothing dispatched.
    if (!ctx.budgets.charge({ commands: args.reapply === true ? 2 : 1 })) {
      return err(
        "budget_exceeded",
        "The run's command budget ran out before component_set_vars could dispatch",
        {
          hint: "The executor stops cleanly with a partial charge (§5.2); trim the plan or continue on a fresh run.",
          retryable: false,
        },
      );
    }

    // 5. component.setVars — merges into the per-instance state (§8.3).
    const instanceRef = engineInstanceRef(resolved.layer.layerId, resolved.layer.name);
    const setVars = await ctx.engine.execute(
      { id: COMPONENT_SET_VARS_COMMAND, params: { instance: instanceRef, vars: args.vars } },
      { signal },
    );
    if (!setVars.ok) {
      return engineFailureErr(setVars);
    }
    const setVarsReport = readSetVarsReport(setVars.value);

    // 6. §8.4 opt-in update pull. Failure is a WARNING, never an error — the
    //    setVars mutation already succeeded and stands (documented per §8.4).
    let reapplyApplied = false;
    let documentRevision = setVars.value.revision;
    const reapplyLines: string[] = [];
    if (args.reapply === true) {
      const update = await ctx.engine.execute(
        { id: COMPONENT_UPDATE_INSTANCE_COMMAND, params: { instance: instanceRef } },
        { signal },
      );
      if (update.ok) {
        reapplyApplied = true;
        documentRevision = update.value.revision;
        reapplyLines.push(
          ...reapplyWarningsFor(readUpdateInstanceReport(update.value), record.component),
        );
      } else {
        const reason =
          update.message.trim().length > 0
            ? update.message
            : "the engine refused component.updateInstance";
        reapplyLines.push(
          `[reapply] the component update was not pulled: ${truncateStr(reason, MAX_WARNING_CHARS - 48)}`,
        );
      }
    }

    const merged = [...setVarsReport.warnings.map(renderComponentWarning), ...reapplyLines];
    const warnings = capWarnings(merged);
    ctx.logger.debug("component_set_vars applied", {
      instance: resolved.layer.layerId,
      component: record.component,
      updated: Object.keys(args.vars).length,
      reapply: reapplyApplied,
    });
    return ok({
      summary: summarizeSetVars({
        instance: resolved.layer.layerId,
        updated: Object.keys(args.vars),
        reapplyApplied,
      }),
      documentRevision,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  },
});
