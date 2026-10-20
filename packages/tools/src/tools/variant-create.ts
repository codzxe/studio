// @studio/tools — variant_create (§6 row 17): layer-comp snapshots, data sets,
// canvas size variants and language variants. Owner: W5-P.
//
// Spec anchors:
//   §6 row 17  "Create layers/comp variants (sizes, languages, data sets)" over
//              `layerComp.*`, `image.applyDataSet`, `image.variables.*`.
//   §2.2       Templates/variants: image.variables.define,
//              image.variables.dataSets, image.applyDataSet, variables.list,
//              layerComp.{new,update,apply,duplicate,rename,delete} — pinned in
//              @studio/engine-client VARIANT_COMMANDS (the studio-side §2.2
//              registry); image.canvasSize is pinned in IMAGE_COMMANDS.
//   §8.1       Variables + data sets give per-instance text swaps; layer comps
//              give alternative states (light/dark, sizes).
//   §10.2      Variants are named "… — <size/lang>" (spaced em-dash); enforced
//              in comp names: model-provided names are validated + auto-fixed
//              (with a warning), tool-made names are constructed compliant.
//   §5.2       budgets.charge before dispatch; stop cleanly at the boundary.
//
// Vendor truth for every command id + param (read-only, never edited):
//   - comps_cmds.rs     layerComp.new {name, comment?} → {comp};
//                       layerComp.apply {comp: id|name} → {comp, missingLayers};
//                       layerComp.list {} (journal:false) → {comps, lastApplied}.
//   - variables_cmds.rs image.variables.define {defs:[{name, layer:id,
//                       type:"textReplacement"}]} — REPLACES the def list;
//                       image.variables.dataSets {dataSets:[{name, values:[{variable,
//                       kind:"text"|"visibility"|"pixels", value}]}], append?} —
//                       REPLACES the data-set list (append:true only extends and
//                       there is no delete id, so re-using a name under append
//                       strands the older set; merges keep names unique);
//                       image.applyDataSet {name|index} → {applied, index};
//                       variables.list {} (journal:false) → {defs, dataSets}.
//   - image_cmds.rs     image.canvasSize {width, height, anchor} — resizes the
//                       canvas and translates the layers by the anchor delta
//                       (the §6 row 17 "canvas resize"; no raw coordinates or
//                       command ids ever reach the model, §6).
//
// Consequences of those vendor contracts (all table-tested below):
//   - define/dataSets are WHOLE-LIST writes, so ops that touch them first read
//     variables.list and merge: existing rows are kept, same-name rows are
//     replaced (warned) — never a blind clobber of prior variant work.
//   - comps record visibility/position/appearance but NOT text content
//     (comps_cmds.rs apply_comp), so language comps are paired with the data
//     sets that swap the text; the warnings say so explicitly.
//   - the freshly created size baseline is applied BY NAME inside the batch
//     (its id is only known engine-side); the preflight collision check
//     guarantees that name is unique, so the apply can never resolve to an
//     older comp.
//   - sizes replay layout: image.canvasSize only translates layers onto the
//     new canvas; each size comp needs layout_apply re-run before rendering
//     (pinned warning, §9 layout system).
//
// Not registered here — W5-R assembles the registry (§6 surface). No
// idempotency key in args: the shape is pinned to the op union (layer_ops
// precedent) and the executor journals transactional batches (§5.6); this tool
// charges no credits.

import { z } from "zod";
import {
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HINT_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_WARNING_CHARS,
  MAX_WARNINGS,
  ambiguousLayerErr,
  cappedArray,
  cappedString,
  defineTool,
  err,
  ok,
  strictObject,
} from "../kit.js";
import {
  type EngineBatchReport,
  type EngineCommand,
  type EngineCommandReport,
  type EngineFailure,
  type EngineLayerSummary,
  TOOL_ERROR_CODE_SCHEMA,
  type Tool,
  type ToolContext,
  type ToolErr,
  type ToolErrorCode,
  type ToolResult,
} from "../types.js";
import { commandPayload } from "./workspace-snapshot.js";

// ---------------------------------------------------------------------------
// §6 row 17 argument surface — a discriminated union on `op`
// ---------------------------------------------------------------------------

export const MAX_COMP_NAME_CHARS = 120;
export const MAX_DATA_SET_NAME_CHARS = 120;
/** Task-pinned 50 (data set values); above the kit's 40-entry §6.2 default. */
export const MAX_DATA_SET_VALUES = 50;
export const MAX_SIZES = 12;
export const MIN_SIZE_PX = 64;
export const MAX_SIZE_PX = 8192;
export const MAX_LANGUAGES = 10;
export const MAX_LANG_CHARS = 10;
/** §6.2 text slot values cap at 2000 chars; same ceiling for data-set values. */
const MAX_TEXT_CHARS = 2000;
/** Slot keys name layers (§10.2 roles); layer-name scale like kit zLayerRef. */
const MAX_SLOT_NAME_CHARS = 200;
/** Kit record ceiling (MAX_ARG_RECORD_ENTRIES): slots per language. */
export const MAX_SLOTS_PER_LANGUAGE = 40;

/** §10.2 variant pattern: `<base> — <size/lang>` with a spaced em-dash. */
export const VARIANT_SEPARATOR = " — ";
export const VARIANT_COMP_BASE = "Variant";
/** Auto-fix qualifier when a model-named comp carries no variant separator. */
const AUTO_VARIANT_QUALIFIER = "variant";

const zName = (max: number) => cappedString(max, 1);
const zSlotKey = z.string().min(1).max(MAX_SLOT_NAME_CHARS);

const COMP_NEW_OP = strictObject({
  op: z.literal("comp_new"),
  name: zName(MAX_COMP_NAME_CHARS),
  fromCurrent: z.boolean(),
});

const COMP_APPLY_OP = strictObject({
  op: z.literal("comp_apply"),
  name: zName(MAX_COMP_NAME_CHARS),
});

const DATA_SET_NEW_OP = strictObject({
  op: z.literal("data_set_new"),
  name: zName(MAX_DATA_SET_NAME_CHARS),
  values: z
    .record(zSlotKey, z.string().max(MAX_TEXT_CHARS))
    .refine((values) => Object.keys(values).length >= 1, {
      message: "a data set needs at least one value",
    })
    .refine((values) => Object.keys(values).length <= MAX_DATA_SET_VALUES, {
      message: `too many values (max ${MAX_DATA_SET_VALUES})`,
    }),
});

const APPLY_DATA_SET_OP = strictObject({
  op: z.literal("apply_data_set"),
  name: zName(MAX_DATA_SET_NAME_CHARS),
});

const zSizePx = z.number().int().min(MIN_SIZE_PX).max(MAX_SIZE_PX);

const SIZES_OP = strictObject({
  op: z.literal("sizes"),
  sizes: cappedArray(
    MAX_SIZES,
    strictObject({ width: zSizePx, height: zSizePx }),
  ).min(1),
  fromCurrent: z.boolean(),
});

const zLanguageTexts = z
  .record(zSlotKey, z.string().max(MAX_TEXT_CHARS))
  .refine((slots) => Object.keys(slots).length <= MAX_SLOTS_PER_LANGUAGE, {
    message: `too many slots (max ${MAX_SLOTS_PER_LANGUAGE})`,
  });

const LANGUAGES_OP = strictObject({
  op: z.literal("languages"),
  texts: z
    .record(z.string().min(1).max(MAX_LANG_CHARS), zLanguageTexts)
    .refine((langs) => Object.keys(langs).length >= 1, {
      message: "name at least one language",
    })
    .refine((langs) => Object.keys(langs).length <= MAX_LANGUAGES, {
      message: `too many languages (max ${MAX_LANGUAGES})`,
    }),
});

export type VariantCreateArgs =
  | { readonly op: "comp_new"; readonly name: string; readonly fromCurrent: boolean }
  | { readonly op: "comp_apply"; readonly name: string }
  | {
      readonly op: "data_set_new";
      readonly name: string;
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly op: "apply_data_set"; readonly name: string }
  | {
      readonly op: "sizes";
      readonly sizes: readonly { readonly width: number; readonly height: number }[];
      readonly fromCurrent: boolean;
    }
  | { readonly op: "languages"; readonly texts: Readonly<Record<string, Readonly<Record<string, string>>>> };

const VARIANT_CREATE_ARGS: z.ZodType<VariantCreateArgs, z.ZodTypeDef, unknown> =
  z.discriminatedUnion("op", [
    COMP_NEW_OP,
    COMP_APPLY_OP,
    DATA_SET_NEW_OP,
    APPLY_DATA_SET_OP,
    SIZES_OP,
    LANGUAGES_OP,
  ]);

// ---------------------------------------------------------------------------
// The exact engine ids this tool emits (drift-checked against
// @studio/engine-client in tests; never invented — §2.2)
// ---------------------------------------------------------------------------

/**
 * Mutating ids all live in VARIANT_COMMANDS / IMAGE_COMMANDS
 * (@studio/engine-client commands.ts). `variablesList` is the journal:false
 * read from VARIANT_COMMANDS; `compList` is the journal:false
 * `layerComp.list` from the vendor registry (comps_cmds.rs) — commands.ts
 * keeps it out of the REQUIRED list on purpose (comps also ride the
 * document.inspect reply), and workspace-snapshot.ts already reads it via
 * execute; this tool only ever uses it for preflight checks.
 */
export const VARIANT_CREATE_COMMANDS = Object.freeze({
  compNew: "layerComp.new",
  compApply: "layerComp.apply",
  variablesDefine: "image.variables.define",
  variablesDataSets: "image.variables.dataSets",
  applyDataSet: "image.applyDataSet",
  canvasSize: "image.canvasSize",
  variablesList: "variables.list",
  compList: "layerComp.list",
});

// ---------------------------------------------------------------------------
// Pinned warnings (§6.1: the model needs the next step, not a dump)
// ---------------------------------------------------------------------------

/** §6 row 17 + §9: canvas resize translates layers; layout must be replayed. */
export const LAYOUT_REPLAY_WARNING =
  "size variants replay layout — run layout_apply for each size comp to re-fit content; " +
  "image.canvasSize only translates layers onto the new canvas";

const COMPS_KEEP_TEXT_NOTE =
  "layer comps record visibility, position and appearance but not text — " +
  "pair each language comp with its data set when switching";

// ---------------------------------------------------------------------------
// §10.2 comp naming — validate + auto-fix (warned), never silently broken
// ---------------------------------------------------------------------------

/** Does `name` already follow the §10.2 variant pattern "… — <qualifier>"? */
function followsVariantPattern(name: string): boolean {
  if (!name.includes(VARIANT_SEPARATOR)) {
    return false;
  }
  const [base, ...rest] = name.split(VARIANT_SEPARATOR);
  return base.trim().length > 0 && rest.join(VARIANT_SEPARATOR).trim().length > 0;
}

export interface FixedVariantName {
  readonly name: string;
  /** true when the name needed the §10.2 auto-fix (caller warns). */
  readonly fixed: boolean;
}

/**
 * Enforces §10.2's "… — <size/lang>" shape on comp names: a compliant name
 * passes unchanged; an unspaced/unbalanced em-dash is normalized; a name with
 * no variant separator gets the ` — variant` qualifier appended. Pure —
 * table-tested.
 */
export function fixVariantName(name: string): FixedVariantName {
  const trimmed = name.trim();
  if (followsVariantPattern(trimmed)) {
    return { name: trimmed, fixed: false };
  }
  if (trimmed.includes("—")) {
    const normalized = trimmed.replace(/\s*—\s*/g, VARIANT_SEPARATOR).trim();
    if (followsVariantPattern(normalized)) {
      return { name: normalized, fixed: true };
    }
  }
  return { name: `${trimmed} ${VARIANT_SEPARATOR} ${AUTO_VARIANT_QUALIFIER}`, fixed: true };
}

/** "Variant — 1080x1920" — the §10.2 handle for one canvas size variant. */
export function compNameForSize(width: number, height: number): string {
  return `${VARIANT_COMP_BASE} ${VARIANT_SEPARATOR} ${width}x${height}`;
}

/** "Variant — es" — the §10.2 handle for one language variant. */
export function compNameForLanguage(lang: string): string {
  return `${VARIANT_COMP_BASE} ${VARIANT_SEPARATOR} ${lang}`;
}

// ---------------------------------------------------------------------------
// Defensive engine-reply readers (the seam is minimal; adapters attach the
// command's own JSON reply — workspace-snapshot's commandPayload convention)
// ---------------------------------------------------------------------------

type Rec = Readonly<Record<string, unknown>>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function readEngineId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** variables_cmds.rs kind_json types; anything else is unreadable, not guessed. */
const VARIABLE_TYPES: ReadonlySet<string> = new Set([
  "visibility",
  "textReplacement",
  "pixelReplacement",
]);

export interface VariableDefRow {
  readonly name: string;
  /** Engine LayerId (u64); the compact tree stringifies it, we re-numericize. */
  readonly layer: number;
  readonly type: string;
  /** PixelReplacement extras, round-tripped verbatim (variables_cmds.rs). */
  readonly method?: string;
  readonly align?: string;
  readonly clip?: boolean;
}

export interface DataSetValueRow {
  readonly variable: string;
  readonly kind: "text" | "visibility" | "pixels";
  readonly value: string | boolean;
}

export interface DataSetRow {
  readonly name: string;
  readonly values: readonly DataSetValueRow[];
}

export interface VariablesListing {
  readonly defs: readonly VariableDefRow[];
  readonly dataSets: readonly DataSetRow[];
}

export interface CompRow {
  readonly id: number;
  readonly name: string;
}

export interface CompListing {
  readonly comps: readonly CompRow[];
  /** Last applied comp id (comps_cmds.rs list reply); null = none ever applied. */
  readonly lastApplied: number | null;
}

function readDefRow(row: unknown): VariableDefRow | undefined {
  if (!isRec(row)) {
    return undefined;
  }
  const name = readBoundedString(row.name, MAX_SLOT_NAME_CHARS);
  const layer = readEngineId(row.layer);
  const type = readBoundedString(row.type, 40);
  if (name === undefined || layer === undefined || type === undefined) {
    return undefined;
  }
  if (!VARIABLE_TYPES.has(type)) {
    return undefined;
  }
  const def: {
    name: string;
    layer: number;
    type: string;
    method?: string;
    align?: string;
    clip?: boolean;
  } = { name, layer, type };
  if (typeof row.method === "string") {
    def.method = row.method;
  }
  if (typeof row.align === "string") {
    def.align = row.align;
  }
  if (typeof row.clip === "boolean") {
    def.clip = row.clip;
  }
  return def;
}

function readValueRow(row: unknown): DataSetValueRow | undefined {
  if (!isRec(row)) {
    return undefined;
  }
  const variable = readBoundedString(row.variable, MAX_SLOT_NAME_CHARS);
  const kind = readBoundedString(row.kind, 40);
  if (variable === undefined || kind === undefined) {
    return undefined;
  }
  if (kind === "visibility" && typeof row.value === "boolean") {
    return { variable, kind, value: row.value };
  }
  if ((kind === "text" || kind === "pixels") && typeof row.value === "string") {
    return { variable, kind, value: row.value };
  }
  return undefined;
}

function readDataSetRow(row: unknown): DataSetRow | undefined {
  if (!isRec(row)) {
    return undefined;
  }
  const name = readBoundedString(row.name, MAX_DATA_SET_NAME_CHARS);
  if (name === undefined) {
    return undefined;
  }
  const values = Array.isArray(row.values) ? row.values.flatMap(readValueRow) : [];
  return { name, values };
}

/** Parses a `variables.list` reply; undefined when nothing readable attached. */
export function readVariablesListing(report: EngineCommandReport): VariablesListing | undefined {
  const payload = commandPayload(report);
  if (!isRec(payload)) {
    return undefined;
  }
  const defs = Array.isArray(payload.defs) ? payload.defs.flatMap(readDefRow) : [];
  const dataSets = Array.isArray(payload.dataSets)
    ? payload.dataSets.flatMap(readDataSetRow)
    : [];
  return { defs, dataSets };
}

/** Parses a `layerComp.list` reply; undefined when nothing readable attached. */
export function readCompListing(report: EngineCommandReport): CompListing | undefined {
  const payload = commandPayload(report);
  if (!isRec(payload)) {
    return undefined;
  }
  const comps = Array.isArray(payload.comps)
    ? payload.comps.flatMap((row) => {
        if (!isRec(row)) {
          return [];
        }
        const id = readEngineId(row.id);
        const name = readBoundedString(row.name, MAX_COMP_NAME_CHARS);
        return id !== undefined && name !== undefined ? [{ id, name }] : [];
      })
    : [];
  const lastApplied = readEngineId(payload.lastApplied);
  return { comps, lastApplied };
}

// ---------------------------------------------------------------------------
// Data-set value compilation (pure; §6.2's compile-then-dispatch pattern)
// ---------------------------------------------------------------------------

const VISIBILITY_TRUE: ReadonlySet<string> = new Set(["true", "1", "yes", "on", "visible"]);
const VISIBILITY_FALSE: ReadonlySet<string> = new Set(["false", "0", "no", "off", "invisible", "hidden"]);

/**
 * Visibility variables take booleans; the args record is stringly typed
 * (task-pinned), so the vendor's CSV truth set is mirrored — and anything
 * ambiguous is a validation error, never a silent false (variables_cmds.rs's
 * CSV import treats every non-truthy string as false; a mutating tool must
 * not). Pure — table-tested.
 */
export function coerceVisibilityValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (VISIBILITY_TRUE.has(normalized)) {
    return true;
  }
  if (VISIBILITY_FALSE.has(normalized)) {
    return false;
  }
  return undefined;
}

function candidateNames(names: readonly string[], what: string): string {
  if (names.length === 0) {
    return `no ${what} are defined yet — create them first`;
  }
  const shown = names.slice(0, 8).join(", ");
  const extra = names.length > 8 ? ` (+${names.length - 8} more)` : "";
  return `${what}: ${shown}${extra}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Compiles a `data_set_new` values record into engine data-set value rows
 * against the document's variable defs: text vars take `kind:"text"`
 * verbatim, visibility vars parse the vendor truth set, pixel vars are
 * refused (their values are file paths — §6.1 never lets filesystem paths
 * cross the tool boundary). Pure — table-tested.
 */
export function buildDataSetValues(
  values: Readonly<Record<string, string>>,
  defs: readonly VariableDefRow[],
): { readonly rows: readonly DataSetValueRow[] } | ToolErr {
  const byName = new Map(defs.map((def) => [def.name, def] as const));
  const keys = Object.keys(values).sort();
  const unknown = keys.filter((key) => !byName.has(key));
  if (unknown.length > 0) {
    return err("validation_failed", `data set values reference unknown variables: ${unknown.join(", ")}`, {
      hint: candidateNames(defs.map((def) => def.name), "defined variables"),
      retryable: false,
    });
  }
  const rows: DataSetValueRow[] = [];
  for (const key of keys) {
    const def = byName.get(key);
    if (def === undefined) {
      continue; // unreachable: unknown keys returned above
    }
    if (def.type === "pixelReplacement") {
      return err(
        "validation_failed",
        `variable ${quote(key)} is a pixel replacement variable; data_set_new only sets text and visibility`,
        {
          hint: "place the replacement image with asset_place, or re-define the variable as textReplacement",
          retryable: false,
        },
      );
    }
    if (def.type === "visibility") {
      const visible = coerceVisibilityValue(values[key] ?? "");
      if (visible === undefined) {
        return err(
          "validation_failed",
          `visibility variable ${quote(key)} needs "true" or "false"`,
          { hint: `got ${quote(values[key] ?? "")}; accepted: true/1/yes/on/visible, false/0/no/off/invisible/hidden`, retryable: false },
        );
      }
      rows.push({ variable: key, kind: "visibility", value: visible });
      continue;
    }
    rows.push({ variable: key, kind: "text", value: values[key] ?? "" });
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// Engine plumbing — failure mapping, preflight reads, transactional batch
// ---------------------------------------------------------------------------

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Seam failures are values; unmapped facade codes degrade, never leak (§6.1). */
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

/** A load-bearing preflight reply that parsed to nothing: nothing was mutated. */
function unreadableReplyErr(verb: string): ToolErr {
  return err("internal_error", `The engine reply needed to ${verb} was unreadable`, {
    hint: "The seam did not attach the command reply; the document was not mutated. Retry once, then report the conformance gap.",
    retryable: false,
  });
}

function budgetStopErr(): ToolErr {
  return err(
    "budget_exceeded",
    "The run's command budget ran out before variant_create could dispatch",
    {
      hint: "The executor stops cleanly with a partial charge (§5.2); create fewer variants per call or continue on a fresh run.",
      retryable: false,
    },
  );
}

/** §10.2 keeps comp names unique so comp_apply resolves exactly one comp. */
function compCollisionErr(colliding: readonly string[]): ToolErr {
  const shown = colliding.slice(0, 5).map(quote).join(", ");
  const extra = colliding.length > 5 ? ` (+${colliding.length - 5} more)` : "";
  return err("conflict", `layer comp names already exist: ${shown}${extra}`, {
    hint: "apply or rename the existing comp first — §10.2 keeps comp names unique so comp_apply by name is unambiguous",
    retryable: false,
  });
}

function pushWarning(warnings: string[], warning: string): void {
  const text =
    warning.length > MAX_WARNING_CHARS ? `${warning.slice(0, MAX_WARNING_CHARS - 1)}…` : warning;
  warnings.push(text);
}

function capWarnings(warnings: readonly string[]): readonly string[] {
  if (warnings.length <= MAX_WARNINGS) {
    return warnings;
  }
  return [...warnings.slice(0, MAX_WARNINGS - 1), `(+${warnings.length - MAX_WARNINGS + 1} more warnings)`];
}

interface Preflight<T> {
  readonly listing: T | undefined;
  /** Execution failed or the reply parsed to nothing (advisory callers warn). */
  readonly degraded: boolean;
  readonly failure?: ToolErr;
}

/** Executes one journal:false read; load-bearing callers branch on `failure`. */
async function preflightListing<T>(
  ctx: ToolContext,
  commandId: string,
  parse: (report: EngineCommandReport) => T | undefined,
  verb: string,
  signal: AbortSignal,
): Promise<Preflight<T>> {
  const outcome = await ctx.engine.execute({ id: commandId, params: {} }, { signal });
  if (!outcome.ok) {
    return { listing: undefined, degraded: true, failure: engineFailureErr(outcome, verb) };
  }
  const listing = parse(outcome.value);
  if (listing === undefined) {
    return { listing: undefined, degraded: true, failure: unreadableReplyErr(verb) };
  }
  return { listing, degraded: false };
}

async function runBatch(
  ctx: ToolContext,
  cmds: readonly EngineCommand[],
  verb: string,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly report: EngineBatchReport } | ToolErr> {
  // One transactional batch (§6.2 ctx.engine): a failed command rolls the
  // document back to the batch's start revision — never a half-built variant.
  const outcome = await ctx.engine.batch(cmds, { transaction: true, signal });
  if (!outcome.ok) {
    return engineFailureErr(outcome, verb);
  }
  const failed = outcome.value.outcomes.find((command) => !command.ok);
  if (failed !== undefined) {
    ctx.logger.warn("variant_create batch command failed", { commandId: failed.commandId });
    return err("internal_error", `The engine could not ${verb}`, {
      hint: "The transactional batch rolled back — inspect with workspace_snapshot, then retry with corrected names.",
      retryable: false,
    });
  }
  return { ok: true, report: outcome.value };
}

// ---------------------------------------------------------------------------
// Summary builder — the compact §6.1 reply (text-set precedent: warnings
// capped at 3 inline, the full list travels in the envelope's warnings field)
// ---------------------------------------------------------------------------

export interface VariantSummaryFacts {
  /** §10.2-named comps (and data sets) this call created. */
  readonly created: readonly string[];
  /** Data sets / comps this call applied. */
  readonly applied?: readonly string[];
  readonly warnings: readonly string[];
}

export function buildSummary(facts: VariantSummaryFacts): string {
  const shown = facts.warnings.slice(0, 3);
  if (facts.warnings.length > 3) {
    shown.push(`(+${facts.warnings.length - 3} more)`);
  }
  const json = JSON.stringify({
    created: facts.created,
    applied: facts.applied,
    warnings: shown,
  });
  return json.length <= MAX_SUMMARY_CHARS
    ? json
    : JSON.stringify({
        created: facts.created,
        applied: facts.applied,
        warnings: `(${facts.warnings.length} warnings)`,
      });
}

/** The tool-result tail shared by every op: charge, batch, envelope. */
async function dispatch(
  ctx: ToolContext,
  cmds: readonly EngineCommand[],
  verb: string,
  facts: VariantSummaryFacts,
  signal: AbortSignal,
): Promise<ToolResult> {
  // §5.2: charge the exact mutating-command count before dispatching.
  if (!ctx.budgets.charge({ commands: cmds.length })) {
    return budgetStopErr();
  }
  const batch = await runBatch(ctx, cmds, verb, signal);
  if (!batch.ok) {
    return batch;
  }
  const warnings = facts.warnings.length > 0 ? capWarnings(facts.warnings) : undefined;
  return ok({
    summary: buildSummary(facts),
    documentRevision: batch.report.revision,
    warnings,
  });
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const variantCreateTool: Tool<VariantCreateArgs> = defineTool({
  name: "variant_create",
  description:
    "Create document variants: layer-comp snapshots, data sets, canvas size variants and language variants that swap text slots.",
  args: VARIANT_CREATE_ARGS,
  async run(ctx, args, signal): Promise<ToolResult> {
    ctx.logger.debug("variant_create invoked", { op: args.op });
    switch (args.op) {
      // ---------------------------------------------------------------------
      // comp_new: snapshot the current state (or the last applied comp) as a
      // §10.2-named layer comp — layerComp.new, plus layerComp.apply first
      // when the comp must come from the last applied comp instead of the
      // live (possibly drifted) document.
      // ---------------------------------------------------------------------
      case "comp_new": {
        const fixed = fixVariantName(args.name);
        const warnings: string[] = [];
        if (fixed.fixed) {
          pushWarning(
            warnings,
            `comp name ${quote(args.name)} did not follow §10.2 "… — <variant>"; renamed to ${quote(fixed.name)}`,
          );
        }
        const preflight = await preflightListing(
          ctx,
          VARIANT_CREATE_COMMANDS.compList,
          readCompListing,
          "list the layer comps",
          signal,
        );
        if (!args.fromCurrent) {
          // fromCurrent=false: re-capture the LAST APPLIED comp's recorded
          // state (drift discarded) — the listing is load-bearing here.
          if (preflight.failure !== undefined) {
            return preflight.failure;
          }
          const listing = preflight.listing;
          if (listing === undefined || listing.comps.length === 0) {
            return err("not_found", "No layer comp exists to base the new comp on", {
              hint: "create one first (op comp_new with fromCurrent true), or pass fromCurrent true to snapshot the live document",
              retryable: false,
            });
          }
          const source =
            listing.comps.find((comp) => comp.id === listing.lastApplied) ?? listing.comps[0];
          const sourceId = source?.id;
          if (sourceId === undefined) {
            return err("internal_error", "The comp listing carried no usable source comp");
          }
          if (listing.comps.some((comp) => comp.name === fixed.name)) {
            return compCollisionErr([fixed.name]);
          }
          return dispatch(
            ctx,
            [
              { id: VARIANT_CREATE_COMMANDS.compApply, params: { comp: sourceId } },
              { id: VARIANT_CREATE_COMMANDS.compNew, params: { name: fixed.name } },
            ],
            "create the layer comp",
            { created: [fixed.name], warnings },
            signal,
          );
        }
        // fromCurrent=true: layerComp.new captures the live state directly.
        if (preflight.degraded) {
          pushWarning(
            warnings,
            "layer comps could not be listed — the new name was not checked for collisions",
          );
        } else if (preflight.listing?.comps.some((comp) => comp.name === fixed.name) === true) {
          return compCollisionErr([fixed.name]);
        }
        return dispatch(
          ctx,
          [{ id: VARIANT_CREATE_COMMANDS.compNew, params: { name: fixed.name } }],
          "create the layer comp",
          { created: [fixed.name], warnings },
          signal,
        );
      }

      // ---------------------------------------------------------------------
      // comp_apply: layerComp.apply by name (§6.1: candidates on a miss,
      // ambiguity is a conflict — two comps sharing a name would make the
      // name resolve to whichever the engine saw first).
      // ---------------------------------------------------------------------
      case "comp_apply": {
        const warnings: string[] = [];
        const preflight = await preflightListing(
          ctx,
          VARIANT_CREATE_COMMANDS.compList,
          readCompListing,
          "list the layer comps",
          signal,
        );
        if (preflight.degraded) {
          pushWarning(
            warnings,
            `layer comps could not be listed — ${quote(args.name)} was not verified before applying`,
          );
        } else {
          const listing = preflight.listing;
          const matches = listing?.comps.filter((comp) => comp.name === args.name) ?? [];
          if (matches.length === 0) {
            return err("not_found", `No layer comp is named ${quote(args.name)}`, {
              hint: candidateNames(
                (listing?.comps ?? []).map((comp) => comp.name),
                "known comps",
              ),
              retryable: false,
            });
          }
          if (matches.length > 1) {
            return err(
              "conflict",
              `${matches.length} layer comps are named ${quote(args.name)}`,
              {
                hint: `comp ids: ${matches.slice(0, 8).map((comp) => comp.id).join(", ")}`,
                retryable: false,
              },
            );
          }
        }
        // comps_cmds.rs apply → {comp, missingLayers}: layers deleted since
        // the capture are skipped by the engine — a warning, never a failure.
        // §5.2: charge the single mutating command before dispatching.
        if (!ctx.budgets.charge({ commands: 1 })) {
          return budgetStopErr();
        }
        const batch = await runBatch(
          ctx,
          [{ id: VARIANT_CREATE_COMMANDS.compApply, params: { comp: args.name } }],
          "apply the layer comp",
          signal,
        );
        if (!batch.ok) {
          return batch;
        }
        const outcome = batch.report.outcomes.at(0);
        if (outcome !== undefined) {
          const payload = commandPayload(outcome as unknown as EngineCommandReport);
          const missing = isRec(payload) ? readEngineId(payload.missingLayers) : undefined;
          if (missing !== undefined && missing > 0) {
            pushWarning(
              warnings,
              `comp ${quote(args.name)} references ${missing} deleted layer(s); those recorded states were skipped on apply`,
            );
          }
        }
        return ok({
          summary: buildSummary({ applied: [args.name], warnings }),
          documentRevision: batch.report.revision,
          warnings: warnings.length > 0 ? capWarnings(warnings) : undefined,
        });
      }

      // ---------------------------------------------------------------------
      // data_set_new: one image.variables.dataSets whole-list write with the
      // listing merged (existing sets kept, same-name replaced + warned).
      // ---------------------------------------------------------------------
      case "data_set_new": {
        const preflight = await preflightListing(
          ctx,
          VARIANT_CREATE_COMMANDS.variablesList,
          readVariablesListing,
          "list the variables",
          signal,
        );
        if (preflight.failure !== undefined) {
          return preflight.failure;
        }
        const listing = preflight.listing;
        if (listing === undefined) {
          return unreadableReplyErr("list the variables");
        }
        const compiled = buildDataSetValues(args.values, listing.defs);
        if (!compiled.ok) {
          return compiled;
        }
        const warnings: string[] = [];
        const kept = listing.dataSets.filter((set) => set.name !== args.name);
        if (kept.length !== listing.dataSets.length) {
          pushWarning(
            warnings,
            `data set ${quote(args.name)} replaced an existing data set of the same name`,
          );
        }
        const dataSets: DataSetRow[] = [...kept, { name: args.name, values: compiled.rows }];
        return dispatch(
          ctx,
          [{ id: VARIANT_CREATE_COMMANDS.variablesDataSets, params: { dataSets } }],
          "create the data set",
          { created: [args.name], warnings },
          signal,
        );
      }

      // ---------------------------------------------------------------------
      // apply_data_set: image.applyDataSet by name — one history step that
      // swaps the bound layers' visibility/text/pixels (variables_cmds.rs).
      // ---------------------------------------------------------------------
      case "apply_data_set": {
        const warnings: string[] = [];
        const preflight = await preflightListing(
          ctx,
          VARIANT_CREATE_COMMANDS.variablesList,
          readVariablesListing,
          "list the variables",
          signal,
        );
        if (preflight.degraded) {
          pushWarning(
            warnings,
            `data sets could not be listed — ${quote(args.name)} was not verified before applying`,
          );
        } else {
          const listing = preflight.listing;
          const names = listing?.dataSets.map((set) => set.name) ?? [];
          if (!names.includes(args.name)) {
            return err("not_found", `No data set is named ${quote(args.name)}`, {
              hint: candidateNames(names, "known data sets"),
              retryable: false,
            });
          }
        }
        return dispatch(
          ctx,
          [{ id: VARIANT_CREATE_COMMANDS.applyDataSet, params: { name: args.name } }],
          "apply the data set",
          { applied: [args.name], warnings },
          signal,
        );
      }

      // ---------------------------------------------------------------------
      // sizes: one §10.2 comp per canvas size. image.canvasSize translates
      // layers by the anchor delta; the baseline comp (fromCurrent=true) is
      // re-applied before every later resize so each variant derives from
      // the same origin instead of accumulating translations.
      // ---------------------------------------------------------------------
      case "sizes": {
        const seen = new Set<string>();
        const dups: string[] = [];
        for (const size of args.sizes) {
          const key = `${size.width}x${size.height}`;
          if (seen.has(key)) {
            dups.push(key);
          } else {
            seen.add(key);
          }
        }
        if (dups.length > 0) {
          return err("validation_failed", `duplicate sizes: ${dups.join(", ")}`, {
            hint: "each size variant is created exactly once; remove the duplicate entries",
            retryable: false,
          });
        }
        const warnings: string[] = [];
        const cmds: EngineCommand[] = [];
        const created: string[] = [];

        if (args.fromCurrent) {
          const inspect = await ctx.engine.inspect();
          if (!inspect.ok) {
            return engineFailureErr(inspect, "read the canvas size");
          }
          const baselineName = compNameForSize(inspect.value.widthPx, inspect.value.heightPx);
          // Load-bearing preflight: the baseline is applied by NAME inside the
          // batch, so the name must be verifiably unique before dispatch.
          const preflight = await preflightListing(
            ctx,
            VARIANT_CREATE_COMMANDS.compList,
            readCompListing,
            "list the layer comps",
            signal,
          );
          if (preflight.failure !== undefined) {
            return preflight.failure;
          }
          const existing = new Set((preflight.listing?.comps ?? []).map((comp) => comp.name));
          const colliding: string[] = [];
          if (existing.has(baselineName)) {
            colliding.push(baselineName);
          }
          cmds.push({
            id: VARIANT_CREATE_COMMANDS.compNew,
            params: { name: baselineName, comment: "size-variant baseline" },
          });
          created.push(baselineName);
          let resized = false;
          const skipped: string[] = [];
          for (const size of args.sizes) {
            const name = compNameForSize(size.width, size.height);
            if (existing.has(name)) {
              colliding.push(name);
            }
            if (size.width === inspect.value.widthPx && size.height === inspect.value.heightPx) {
              skipped.push(`${size.width}x${size.height}`);
              continue;
            }
            if (resized) {
              cmds.push({ id: VARIANT_CREATE_COMMANDS.compApply, params: { comp: baselineName } });
            }
            cmds.push({
              id: VARIANT_CREATE_COMMANDS.canvasSize,
              params: { width: size.width, height: size.height, anchor: "center" },
            });
            cmds.push({
              id: VARIANT_CREATE_COMMANDS.compNew,
              params: { name, comment: `size variant ${size.width}x${size.height}` },
            });
            created.push(name);
            resized = true;
          }
          if (colliding.length > 0) {
            return compCollisionErr(colliding);
          }
          for (const size of skipped) {
            pushWarning(
              warnings,
              `size ${size} equals the current canvas — the baseline comp ${quote(baselineName)} already captures it`,
            );
          }
        } else {
          // fromCurrent=false: every size derives from the LAST APPLIED
          // comp's recorded state (drift discarded); re-applied before each
          // resize because layerComp.new shifts "last applied" to the new comp.
          const preflight = await preflightListing(
            ctx,
            VARIANT_CREATE_COMMANDS.compList,
            readCompListing,
            "list the layer comps",
            signal,
          );
          if (preflight.failure !== undefined) {
            return preflight.failure;
          }
          const listing = preflight.listing;
          if (listing === undefined || listing.comps.length === 0) {
            return err("not_found", "No layer comp exists to derive size variants from", {
              hint: "create one first (op comp_new), or pass fromCurrent true to size from the live document",
              retryable: false,
            });
          }
          const source =
            listing.comps.find((comp) => comp.id === listing.lastApplied) ?? listing.comps[0];
          const sourceId = source?.id;
          if (sourceId === undefined) {
            return err("internal_error", "The comp listing carried no usable source comp");
          }
          const existing = new Set(listing.comps.map((comp) => comp.name));
          const colliding: string[] = [];
          for (const size of args.sizes) {
            const name = compNameForSize(size.width, size.height);
            if (existing.has(name)) {
              colliding.push(name);
            }
            cmds.push({ id: VARIANT_CREATE_COMMANDS.compApply, params: { comp: sourceId } });
            cmds.push({
              id: VARIANT_CREATE_COMMANDS.canvasSize,
              params: { width: size.width, height: size.height, anchor: "center" },
            });
            cmds.push({
              id: VARIANT_CREATE_COMMANDS.compNew,
              params: { name, comment: `size variant ${size.width}x${size.height}` },
            });
            created.push(name);
          }
          if (colliding.length > 0) {
            return compCollisionErr(colliding);
          }
        }
        // §6 row 17 + §9: sizes replay layout — pinned warning, both modes.
        pushWarning(warnings, LAYOUT_REPLAY_WARNING);
        return dispatch(ctx, cmds, "create the size variants", { created, warnings }, signal);
      }

      // ---------------------------------------------------------------------
      // languages: text-replacement variables per slot (bound to the slot's
      // Type layer), one data set per language, applied in turn and captured
      // as a §10.2-named comp per language — data sets swap the text (§8.1),
      // comps snapshot the state.
      // ---------------------------------------------------------------------
      case "languages": {
        const langs = Object.keys(args.texts);
        const slots = [...new Set(langs.flatMap((lang) => Object.keys(args.texts[lang] ?? {})))].sort();
        const warnings: string[] = [];

        // Slots name Type layers (§10.2 roles); resolve against the tree first.
        const tree = await ctx.engine.listLayers();
        if (!tree.ok) {
          return engineFailureErr(tree, "read the layer tree");
        }
        const unknown: string[] = [];
        const slotLayers = new Map<string, EngineLayerSummary>();
        for (const slot of slots) {
          const exact = tree.value.filter((layer) => layer.name === slot);
          const matches =
            exact.length > 0
              ? exact
              : tree.value.filter((layer) => layer.name.toLowerCase() === slot.toLowerCase());
          if (matches.length === 0) {
            unknown.push(slot);
            continue;
          }
          if (matches.length > 1) {
            return ambiguousLayerErr(slot, matches.map((layer) => `id ${layer.layerId}`));
          }
          const layer = matches[0];
          if (layer === undefined) {
            return err("internal_error", "The layer tree carried an unusable match");
          }
          // Kinds read "Type" for text layers (vendor kind_name); refuse only
          // when the tree positively says otherwise (text-set precedent).
          const isText =
            typeof layer.kind !== "string" ||
            layer.kind.length === 0 ||
            layer.kind.toLowerCase() === "type";
          if (!isText) {
            return err("invalid_slots", `Slot ${quote(slot)} names a ${layer.kind} layer, not a text layer`, {
              hint: "text slots reference Type layers — §10.2 roles like Headline, Subhead, Body, Caption, CTA",
              retryable: false,
            });
          }
          slotLayers.set(slot, layer);
        }
        if (unknown.length > 0) {
          return err("unknown_slots", `unknown slots: ${unknown.join(", ")}`, {
            hint: candidateNames(tree.value.map((layer) => layer.name), "document layers"),
            retryable: false,
          });
        }

        // Two slots on one layer: both variables bind it and the later value
        // in each data set wins on apply — warned, not refused.
        const byLayer = new Map<string, string[]>();
        for (const [slot, layer] of slotLayers) {
          const names = byLayer.get(layer.layerId) ?? [];
          names.push(slot);
          byLayer.set(layer.layerId, names);
        }
        for (const names of byLayer.values()) {
          if (names.length > 1) {
            pushWarning(
              warnings,
              `slots ${names.join(", ")} resolve to the same layer — the later value wins in each data set`,
            );
          }
        }

        // image.variables.define binds slot → engine LayerId (u64); the seam
        // stringifies ids, so non-numeric ids are a conformance stop.
        const slotIds = new Map<string, number>();
        for (const [slot, layer] of slotLayers) {
          if (!/^\d+$/.test(layer.layerId)) {
            return err("internal_error", "The layer tree did not report numeric engine layer ids", {
              hint: "image.variables.define binds variables to engine LayerIds; the seam returned a non-numeric id",
              retryable: false,
            });
          }
          slotIds.set(slot, Number(layer.layerId));
        }

        // Whole-list writes: merge with variables.list, never clobber.
        const varsPreflight = await preflightListing(
          ctx,
          VARIANT_CREATE_COMMANDS.variablesList,
          readVariablesListing,
          "list the variables",
          signal,
        );
        if (varsPreflight.failure !== undefined) {
          return varsPreflight.failure;
        }
        const listing = varsPreflight.listing;
        if (listing === undefined) {
          return unreadableReplyErr("list the variables");
        }
        const defs: VariableDefRow[] = [];
        for (const def of listing.defs) {
          if (slotLayers.has(def.name)) {
            const replacement = slotIds.get(def.name);
            if (replacement !== undefined && replacement !== def.layer) {
              pushWarning(
                warnings,
                `variable ${quote(def.name)} re-bound from layer ${def.layer} to layer ${replacement}`,
              );
            }
            continue;
          }
          defs.push(def);
        }
        for (const slot of slots) {
          const layer = slotIds.get(slot);
          if (layer !== undefined) {
            defs.push({ name: slot, layer, type: "textReplacement" });
          }
        }
        const langNames = new Set(langs);
        const dataSets: DataSetRow[] = [];
        for (const existing of listing.dataSets) {
          if (langNames.has(existing.name)) {
            pushWarning(
              warnings,
              `data set ${quote(existing.name)} replaced an existing data set of the same name`,
            );
            continue;
          }
          dataSets.push(existing);
        }
        for (const lang of langs) {
          const texts = args.texts[lang] ?? {};
          const values = Object.keys(texts)
            .sort()
            .map((slot) => ({ variable: slot, kind: "text" as const, value: texts[slot] ?? "" }));
          dataSets.push({ name: lang, values });
        }

        // Comp names collide-checked before any mutation (§10.2 uniqueness).
        const compPreflight = await preflightListing(
          ctx,
          VARIANT_CREATE_COMMANDS.compList,
          readCompListing,
          "list the layer comps",
          signal,
        );
        if (compPreflight.failure !== undefined) {
          return compPreflight.failure;
        }
        const existingComps = new Set((compPreflight.listing?.comps ?? []).map((comp) => comp.name));
        const compNames = langs.map((lang) => compNameForLanguage(lang));
        const colliding = compNames.filter((name) => existingComps.has(name));
        if (colliding.length > 0) {
          return compCollisionErr(colliding);
        }

        const cmds: EngineCommand[] = [
          { id: VARIANT_CREATE_COMMANDS.variablesDefine, params: { defs } },
          { id: VARIANT_CREATE_COMMANDS.variablesDataSets, params: { dataSets } },
        ];
        for (const lang of langs) {
          cmds.push({ id: VARIANT_CREATE_COMMANDS.applyDataSet, params: { name: lang } });
          cmds.push({
            id: VARIANT_CREATE_COMMANDS.compNew,
            params: { name: compNameForLanguage(lang), comment: `language variant ${lang}` },
          });
        }
        const lastLang = langs.at(-1) ?? "";
        pushWarning(warnings, COMPS_KEEP_TEXT_NOTE);
        pushWarning(
          warnings,
          `the document now shows the last language applied (${quote(lastLang)}); call variant_create apply_data_set to switch texts`,
        );
        return dispatch(
          ctx,
          cmds,
          "create the language variants",
          { created: compNames, applied: langs, warnings },
          signal,
        );
      }
    }
  },
});
