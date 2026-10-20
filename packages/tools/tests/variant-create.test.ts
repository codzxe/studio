// variant-create.test.ts — variant_create (§6 row 17): op→command mapping,
// §10.2 comp naming (validate + auto-fix), size/language bounds, data-set
// value caps, fromCurrent semantics, §5.2 budgets, strict schema.
//
// Pure + fake-engine tests only: no engine, no db, no network (AGENTS.md).

import { IMAGE_COMMANDS, VARIANT_COMMANDS } from "@studio/engine-client";
import { describe, expect, it } from "vitest";
import { parseToolArgs } from "../src/kit.js";
import { TOOLS } from "../src/registry.js";
import {
  type CompListing,
  type DataSetRow,
  LAYOUT_REPLAY_WARNING,
  MAX_DATA_SET_VALUES,
  MAX_LANGUAGES,
  MAX_SIZES,
  MAX_SIZE_PX,
  VARIANT_COMP_BASE,
  VARIANT_CREATE_COMMANDS,
  type VariableDefRow,
  type VariablesListing,
  type VariantCreateArgs,
  buildDataSetValues,
  buildSummary,
  coerceVisibilityValue,
  compNameForLanguage,
  compNameForSize,
  fixVariantName,
  readCompListing,
  readVariablesListing,
  variantCreateTool,
} from "../src/tools/variant-create.js";
import type {
  BudgetTracker,
  EngineBatchOptions,
  EngineCallOptions,
  EngineCommand,
  EngineCommandReport,
  EngineDocumentSnapshot,
  EngineFailure,
  EngineLayerSummary,
  EngineLike,
  ToolContext,
  ToolErr,
  ToolOk,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const layer = (layerId: string, name: string, kind = "Pixel"): EngineLayerSummary => ({
  layerId,
  name,
  kind,
  visible: true,
});

const TREE: readonly EngineLayerSummary[] = [
  layer("1", "Background"),
  layer("2", "Photo"),
  layer("3", "Headline", "Type"),
  layer("4", "Subhead", "Type"),
  layer("5", "Logo"),
];

const NO_COMPS: CompListing = { comps: [], lastApplied: null };
const NO_VARIABLES: VariablesListing = { defs: [], dataSets: [] };
const CANVAS: EngineDocumentSnapshot = { revision: 9, widthPx: 800, heightPx: 600, layers: [] };

interface RecordedExecute {
  readonly cmd: EngineCommand;
  readonly options: EngineCallOptions | undefined;
}

interface RecordedBatch {
  readonly cmds: readonly EngineCommand[];
  readonly options: EngineBatchOptions | undefined;
}

type ListingSource<T> = T | "unreadable" | EngineFailure;

/** Structural guard for the seam's EngineFailure arm (no `in` guessing). */
function isFailure(value: unknown): value is EngineFailure {
  return (
    typeof value === "object" && value !== null && (value as { readonly ok?: unknown }).ok === false
  );
}

interface FakeEngineOptions {
  readonly revision?: number;
  readonly batchFailure?: EngineFailure;
  readonly commandFailure?: boolean;
  readonly compListing?: ListingSource<CompListing>;
  readonly variablesListing?: ListingSource<VariablesListing>;
  readonly trees?: readonly EngineLayerSummary[] | EngineFailure;
  readonly canvas?: EngineDocumentSnapshot | EngineFailure;
  /** Payloads attached to batch outcomes by index (e.g. apply's missingLayers). */
  readonly outcomeResults?: readonly unknown[];
}

function listingOutcome<T>(
  source: ListingSource<T> | undefined,
  empty: T,
): { ok: true; value: { revision: number; result?: T } } | EngineFailure {
  if (source === undefined) {
    return { ok: true, value: { revision: 9, result: empty } };
  }
  if (source === "unreadable") {
    return { ok: true, value: { revision: 9 } };
  }
  if (isFailure(source)) {
    return source;
  }
  return { ok: true, value: { revision: 9, result: source } };
}

/** A recording EngineLike fake: captures every batch, execute and options. */
function makeRecordingEngine(options: FakeEngineOptions = {}) {
  const batches: RecordedBatch[] = [];
  const executes: RecordedExecute[] = [];
  const engine: EngineLike = {
    batch: async (cmds, batchOptions) => {
      batches.push({ cmds: [...cmds], options: batchOptions });
      if (options.batchFailure !== undefined) {
        return options.batchFailure;
      }
      const outcomes = [...cmds].map((cmd, index) => ({
        index,
        commandId: cmd.id,
        ok: !options.commandFailure,
        message: options.commandFailure === true ? "rejected" : undefined,
        result: options.outcomeResults?.[index],
      }));
      return { ok: true, value: { revision: options.revision ?? 9, outcomes } };
    },
    execute: async (cmd, callOptions) => {
      executes.push({ cmd, options: callOptions });
      if (cmd.id === VARIANT_CREATE_COMMANDS.compList) {
        return listingOutcome(options.compListing, NO_COMPS);
      }
      if (cmd.id === VARIANT_CREATE_COMMANDS.variablesList) {
        return listingOutcome(options.variablesListing, NO_VARIABLES);
      }
      return { ok: true, value: { revision: 9 } };
    },
    render: async () => ({
      ok: true,
      value: { image: new Uint8Array(), widthPx: 64, heightPx: 64 },
    }),
    inspect: async () => {
      if (isFailure(options.canvas)) {
        return options.canvas;
      }
      return { ok: true, value: options.canvas ?? CANVAS };
    },
    listLayers: async () => {
      if (isFailure(options.trees)) {
        return options.trees;
      }
      return { ok: true, value: options.trees ?? TREE };
    },
  };
  return { engine, batches, executes };
}

function makeRecordingBudgets(approve = true) {
  const charges: Array<{ commands?: number; renderPx?: number }> = [];
  const budgets: BudgetTracker = {
    remaining: () => ({ msRemaining: 5000, commandsRemaining: 256 }),
    charge: (usage) => {
      charges.push(usage);
      return approve;
    },
  };
  return { budgets, charges };
}

/** Parses valid args or fails the test; keeps run calls typed + terse. */
function parseOk(raw: unknown): VariantCreateArgs {
  const parsed = parseToolArgs(variantCreateTool, raw);
  if (!parsed.ok) {
    throw new Error(`args unexpectedly invalid: ${parsed.hint ?? parsed.message}`);
  }
  return parsed.args;
}

function parseErr(raw: unknown): ToolErr {
  const parsed = parseToolArgs(variantCreateTool, raw);
  if (parsed.ok) {
    throw new Error("args unexpectedly valid");
  }
  return parsed;
}

interface RunResult {
  readonly result: ToolOk | ToolErr;
  readonly batches: readonly RecordedBatch[];
  readonly executes: readonly RecordedExecute[];
  readonly charges: readonly { commands?: number }[];
}

async function runTool(
  raw: unknown,
  engineOptions: FakeEngineOptions = {},
  budgetApprove = true,
): Promise<RunResult> {
  const { engine, batches, executes } = makeRecordingEngine(engineOptions);
  const { budgets, charges } = makeRecordingBudgets(budgetApprove);
  const ctx: ToolContext = makeFakeContext({ engine, budgets });
  const result = await variantCreateTool.run(ctx, parseOk(raw), freshSignal());
  return { result, batches, executes, charges };
}

async function runOk(
  raw: unknown,
  engineOptions: FakeEngineOptions = {},
): Promise<{
  result: ToolOk;
  batches: readonly RecordedBatch[];
  executes: readonly RecordedExecute[];
}> {
  const run = await runTool(raw, engineOptions);
  if (!run.result.ok) {
    throw new Error(`tool unexpectedly failed: ${run.result.code} ${run.result.message}`);
  }
  return { result: run.result, batches: run.batches, executes: run.executes };
}

async function runErr(raw: unknown, engineOptions: FakeEngineOptions = {}): Promise<ToolErr> {
  const run = await runTool(raw, engineOptions);
  if (run.result.ok) {
    throw new Error("tool unexpectedly succeeded");
  }
  return run.result;
}

function idsOf(batch: RecordedBatch): string[] {
  return batch.cmds.map((cmd) => cmd.id);
}

function paramsOf(batch: RecordedBatch, index: number): Record<string, unknown> {
  return batch.cmds[index]?.params ?? {};
}

/** The single recorded batch, or the test fails loudly. */
function batchOf(batches: readonly RecordedBatch[]): RecordedBatch {
  const batch = batches[0];
  if (batch === undefined) {
    throw new Error("no batch was recorded");
  }
  return batch;
}

function summaryJson(result: ToolOk): {
  created?: string[];
  applied?: string[];
  warnings?: unknown;
} {
  return JSON.parse(result.summary) as {
    created?: string[];
    applied?: string[];
    warnings?: unknown;
  };
}

const COMPS: CompListing = {
  comps: [
    { id: 3, name: "Design" },
    { id: 9, name: "Design v2" },
  ],
  lastApplied: 9,
};

const VARIABLES: VariablesListing = {
  defs: [
    { name: "Headline", layer: 3, type: "textReplacement" },
    { name: "Logo", layer: 5, type: "visibility" },
  ],
  dataSets: [
    {
      name: "old",
      values: [{ variable: "Headline", kind: "text", value: "Hi" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// §6 row 17 surface + §2.2 id pinning
// ---------------------------------------------------------------------------

describe("variant_create — §6 row 17 surface", () => {
  it("is named variant_create with a planner description", () => {
    expect(variantCreateTool.name).toBe("variant_create");
    expect(variantCreateTool.description.length).toBeGreaterThanOrEqual(10);
    expect(variantCreateTool.description.length).toBeLessThanOrEqual(500);
  });

  it("is pinned to the §6 tool surface (TOOLS registry)", () => {
    expect(TOOLS.variant_create).toBe("variant_create");
  });

  it("emits only §2.2 registry ids (drift check vs @studio/engine-client)", () => {
    const commands = VARIANT_CREATE_COMMANDS;
    for (const id of [
      commands.compNew,
      commands.compApply,
      commands.variablesDefine,
      commands.variablesDataSets,
      commands.applyDataSet,
      commands.variablesList,
    ]) {
      expect(VARIANT_COMMANDS, id).toContain(id);
    }
    expect(IMAGE_COMMANDS).toContain(commands.canvasSize);
    // layerComp.list is a vendor registry id (comps_cmds.rs, journal:false):
    // commands.ts deliberately keeps it out of the REQUIRED list, and
    // workspace-snapshot already reads it via execute — pinned verbatim here.
    expect(commands.compList).toBe("layerComp.list");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — §10.2 naming, visibility coercion, data-set compilation
// ---------------------------------------------------------------------------

describe("variant_create — §10.2 comp naming helpers", () => {
  it.each([
    { input: "Headline — es", name: "Headline — es", fixed: false },
    { input: "Campaign — summer sale", name: "Campaign — summer sale", fixed: false },
    { input: "  Variant — 1080x1920  ", name: "Variant — 1080x1920", fixed: false },
    { input: "Dark", name: "Dark — variant", fixed: true },
    { input: "A—B", name: "A — B", fixed: true },
    { input: "A — B", name: "A — B", fixed: false },
  ])("fixVariantName($input) → $name", ({ input, name, fixed }) => {
    expect(fixVariantName(input)).toEqual({ name, fixed });
  });

  it("fixVariantName appends the qualifier when the em-dash is malformed", () => {
    const fixed = fixVariantName("Badge —");
    expect(fixed.fixed).toBe(true);
    expect(fixed.name.endsWith("variant")).toBe(true);
  });

  it("builds §10.2 names for sizes and languages", () => {
    expect(compNameForSize(1080, 1920)).toBe(`${VARIANT_COMP_BASE} — 1080x1920`);
    expect(compNameForLanguage("es")).toBe(`${VARIANT_COMP_BASE} — es`);
  });

  it("every tool-made comp name follows the §10.2 pattern", () => {
    expect(fixVariantName(compNameForSize(64, 64)).fixed).toBe(false);
    expect(fixVariantName(compNameForLanguage("en-US")).fixed).toBe(false);
  });
});

describe("variant_create — visibility coercion + data-set compilation", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["visible", true],
    [" TRUE ", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["off", false],
    ["invisible", false],
    ["Hidden", false],
  ])("coerceVisibilityValue(%j) → %s", (input, expected) => {
    expect(coerceVisibilityValue(input)).toBe(expected);
  });

  it.each(["maybe", ""])("coerceVisibilityValue(%j) → undefined", (input) => {
    expect(coerceVisibilityValue(input)).toBeUndefined();
  });

  const defs: readonly VariableDefRow[] = [
    { name: "Headline", layer: 3, type: "textReplacement" },
    { name: "Logo", layer: 5, type: "visibility" },
    { name: "Photo", layer: 2, type: "pixelReplacement" },
  ];

  it("maps text values verbatim and visibility values to booleans (sorted keys)", () => {
    const built = buildDataSetValues({ Logo: "on", Headline: "Sale" }, defs);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.rows).toEqual([
        { variable: "Headline", kind: "text", value: "Sale" },
        { variable: "Logo", kind: "visibility", value: true },
      ]);
    }
  });

  it("refuses unknown variables with candidates", () => {
    const built = buildDataSetValues({ Badge: "x" }, defs);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("validation_failed");
      expect(built.message).toContain("unknown variables: Badge");
      expect(built.hint).toContain("Headline");
    }
  });

  it("refuses ambiguous visibility values, never a silent false", () => {
    const built = buildDataSetValues({ Logo: "maybe" }, defs);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("validation_failed");
      expect(built.message).toContain("visibility");
    }
  });

  it("refuses pixel replacement variables (paths never cross the boundary)", () => {
    const built = buildDataSetValues({ Photo: "img.png" }, defs);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("validation_failed");
      expect(built.message).toContain("pixel replacement");
    }
  });
});

describe("variant_create — engine reply readers", () => {
  it("parses variables.list and layerComp.list payloads defensively", () => {
    const variables = readVariablesListing({
      revision: 1,
      result: {
        defs: [{ name: "Headline", layer: 3, type: "textReplacement" }, { junk: true }],
        dataSets: [{ name: "es", values: [{ variable: "Headline", kind: "text", value: "Hola" }] }],
      },
    } as unknown as EngineCommandReport);
    expect(variables?.defs).toEqual([{ name: "Headline", layer: 3, type: "textReplacement" }]);
    expect(variables?.dataSets).toHaveLength(1);

    const comps = readCompListing({
      revision: 1,
      result: { comps: [{ id: 2, name: "Variant — es" }], lastApplied: 2 },
    } as unknown as EngineCommandReport);
    expect(comps?.comps).toEqual([{ id: 2, name: "Variant — es" }]);
    expect(comps?.lastApplied).toBe(2);
  });

  it("returns undefined when the seam attached no payload", () => {
    expect(readVariablesListing({ revision: 1 })).toBeUndefined();
    expect(readCompListing({ revision: 1, message: "done" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// op → engine command mapping (the task's table), one transactional batch
// ---------------------------------------------------------------------------

describe("variant_create — op → command mapping (§2.2 ids, one batch)", () => {
  it("comp_new fromCurrent=true snapshots the live state via layerComp.new", async () => {
    const { result, batches } = await runOk({
      op: "comp_new",
      name: "Campaign — summer",
      fromCurrent: true,
    });
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual(["layerComp.new"]);
    expect(paramsOf(batch, 0)).toEqual({ name: "Campaign — summer" });
    expect(summaryJson(result).created).toEqual(["Campaign — summer"]);
    expect(result.documentRevision).toBe(9);
  });

  it("comp_new fromCurrent=false applies the last applied comp first", async () => {
    const { batches } = await runOk(
      { op: "comp_new", name: "Design v3 — dark", fromCurrent: false },
      { compListing: COMPS },
    );
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual(["layerComp.apply", "layerComp.new"]);
    expect(paramsOf(batch, 0)).toEqual({ comp: 9 });
    expect(paramsOf(batch, 1)).toEqual({ name: "Design v3 — dark" });
  });

  it("comp_new fromCurrent=false falls back to the first comp when none was applied", async () => {
    const { batches } = await runOk(
      { op: "comp_new", name: "Base — draft", fromCurrent: false },
      { compListing: { comps: COMPS.comps, lastApplied: null } },
    );
    expect(paramsOf(batchOf(batches), 0)).toEqual({ comp: 3 });
  });

  it("comp_new fromCurrent=false auto-fixes the name with a warning", async () => {
    const { result, batches } = await runOk(
      { op: "comp_new", name: "Dark", fromCurrent: false },
      { compListing: COMPS },
    );
    expect(paramsOf(batchOf(batches), 1)).toEqual({ name: "Dark — variant" });
    expect(result.warnings?.[0]).toContain('renamed to "Dark — variant"');
    expect(summaryJson(result).created).toEqual(["Dark — variant"]);
  });

  it("comp_apply applies by name", async () => {
    const { result, batches } = await runOk(
      { op: "comp_apply", name: "Design v2" },
      { compListing: COMPS },
    );
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual(["layerComp.apply"]);
    expect(paramsOf(batch, 0)).toEqual({ comp: "Design v2" });
    expect(summaryJson(result).applied).toEqual(["Design v2"]);
    expect(summaryJson(result).created).toEqual([]);
  });

  it("data_set_new writes the merged list via image.variables.dataSets", async () => {
    const { result, batches } = await runOk(
      { op: "data_set_new", name: "promo", values: { Logo: "on", Headline: "Sale" } },
      { variablesListing: VARIABLES },
    );
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual(["image.variables.dataSets"]);
    const dataSets = paramsOf(batch, 0).dataSets as DataSetRow[];
    expect(dataSets).toEqual([
      { name: "old", values: [{ variable: "Headline", kind: "text", value: "Hi" }] },
      {
        name: "promo",
        values: [
          { variable: "Headline", kind: "text", value: "Sale" },
          { variable: "Logo", kind: "visibility", value: true },
        ],
      },
    ]);
    expect(summaryJson(result).created).toEqual(["promo"]);
  });

  it("apply_data_set applies by name via image.applyDataSet", async () => {
    const { result, batches } = await runOk(
      { op: "apply_data_set", name: "es" },
      { variablesListing: { defs: [], dataSets: [{ name: "es", values: [] }] } },
    );
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual(["image.applyDataSet"]);
    expect(paramsOf(batch, 0)).toEqual({ name: "es" });
    expect(summaryJson(result).applied).toEqual(["es"]);
  });

  it("sizes fromCurrent=true: baseline comp + resize + comp per size, baseline re-applied", async () => {
    const { result, batches } = await runOk({
      op: "sizes",
      sizes: [
        { width: 1080, height: 1080 },
        { width: 1080, height: 1920 },
      ],
      fromCurrent: true,
    });
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual([
      "layerComp.new",
      "image.canvasSize",
      "layerComp.new",
      "layerComp.apply",
      "image.canvasSize",
      "layerComp.new",
    ]);
    expect(paramsOf(batch, 0)).toEqual({
      name: "Variant — 800x600",
      comment: "size-variant baseline",
    });
    expect(paramsOf(batch, 1)).toEqual({ width: 1080, height: 1080, anchor: "center" });
    expect(paramsOf(batch, 2)).toEqual({
      name: "Variant — 1080x1080",
      comment: "size variant 1080x1080",
    });
    expect(paramsOf(batch, 3)).toEqual({ comp: "Variant — 800x600" });
    expect(paramsOf(batch, 4)).toEqual({ width: 1080, height: 1920, anchor: "center" });
    expect(paramsOf(batch, 5)).toEqual({
      name: "Variant — 1080x1920",
      comment: "size variant 1080x1920",
    });
    expect(summaryJson(result).created).toEqual([
      "Variant — 800x600",
      "Variant — 1080x1080",
      "Variant — 1080x1920",
    ]);
    expect(result.warnings).toEqual([LAYOUT_REPLAY_WARNING]);
  });

  it("sizes fromCurrent=false: last applied comp re-applied before every resize", async () => {
    const { result, batches } = await runOk(
      {
        op: "sizes",
        sizes: [
          { width: 1080, height: 1080 },
          { width: 640, height: 640 },
        ],
        fromCurrent: false,
      },
      { compListing: COMPS },
    );
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual([
      "layerComp.apply",
      "image.canvasSize",
      "layerComp.new",
      "layerComp.apply",
      "image.canvasSize",
      "layerComp.new",
    ]);
    expect(paramsOf(batch, 0)).toEqual({ comp: 9 });
    expect(paramsOf(batch, 3)).toEqual({ comp: 9 });
    expect(summaryJson(result).created).toEqual(["Variant — 1080x1080", "Variant — 640x640"]);
  });

  it("languages: define + data sets, then applyDataSet + comp per language", async () => {
    const { result, batches } = await runOk({
      op: "languages",
      texts: {
        es: { Headline: "Hola", Subhead: "Mundo" },
        en: { Headline: "Hello", Subhead: "World" },
      },
    });
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual([
      "image.variables.define",
      "image.variables.dataSets",
      "image.applyDataSet",
      "layerComp.new",
      "image.applyDataSet",
      "layerComp.new",
    ]);
    expect(paramsOf(batch, 0)).toEqual({
      defs: [
        { name: "Headline", layer: 3, type: "textReplacement" },
        { name: "Subhead", layer: 4, type: "textReplacement" },
      ],
    });
    expect(paramsOf(batch, 1)).toEqual({
      dataSets: [
        {
          name: "es",
          values: [
            { variable: "Headline", kind: "text", value: "Hola" },
            { variable: "Subhead", kind: "text", value: "Mundo" },
          ],
        },
        {
          name: "en",
          values: [
            { variable: "Headline", kind: "text", value: "Hello" },
            { variable: "Subhead", kind: "text", value: "World" },
          ],
        },
      ],
    });
    expect(paramsOf(batch, 2)).toEqual({ name: "es" });
    expect(paramsOf(batch, 3)).toEqual({
      name: "Variant — es",
      comment: "language variant es",
    });
    expect(paramsOf(batch, 4)).toEqual({ name: "en" });
    expect(paramsOf(batch, 5)).toEqual({
      name: "Variant — en",
      comment: "language variant en",
    });
    expect(summaryJson(result).created).toEqual(["Variant — es", "Variant — en"]);
    expect(summaryJson(result).applied).toEqual(["es", "en"]);
  });
});

// ---------------------------------------------------------------------------
// Sizes: bounds, 12-entry cap, duplicates, skipped current size, collisions
// ---------------------------------------------------------------------------

describe("variant_create — sizes bounds and semantics", () => {
  const size = (width: number, height: number) => ({ width, height });

  it("accepts 12 sizes at the 64..8192 bounds (8192 cap, 12 max)", async () => {
    const sizes = [size(64, 64), ...Array.from({ length: 11 }, (_, i) => size(8192 - i, 8192 - i))];
    const { result, batches } = await runOk({ op: "sizes", sizes, fromCurrent: true });
    expect(batchOf(batches).cmds).toHaveLength(1 + 2 + 3 * 11);
    expect(summaryJson(result).created).toHaveLength(13);
  });

  it("rejects 13 sizes, out-of-bounds sides, and non-integers at the schema", () => {
    const many = Array.from({ length: 13 }, () => size(1080, 1080));
    expect(parseErr({ op: "sizes", sizes: many, fromCurrent: true }).code).toBe("invalid_args");
    for (const bad of [
      size(63, 64),
      size(64, 8193),
      size(64.5, 64),
      size(Number.NaN, 64),
      size(Number.POSITIVE_INFINITY, 64),
    ]) {
      expect(parseErr({ op: "sizes", sizes: [bad], fromCurrent: true }).code).toBe("invalid_args");
    }
    expect(parseErr({ op: "sizes", sizes: [], fromCurrent: true }).code).toBe("invalid_args");
    expect(MAX_SIZES).toBe(12);
    expect(MAX_SIZE_PX).toBe(8192);
  });

  it("rejects duplicate sizes before any engine call", async () => {
    const failure = await runErr({
      op: "sizes",
      sizes: [size(1080, 1080), size(1080, 1920), size(1080, 1080)],
      fromCurrent: true,
    });
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("duplicate sizes: 1080x1080");
  });

  it("skips the size equal to the current canvas — the baseline already covers it", async () => {
    const { result, batches } = await runOk({
      op: "sizes",
      sizes: [size(800, 600), size(1080, 1080)],
      fromCurrent: true,
    });
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(idsOf(batch)).toEqual(["layerComp.new", "image.canvasSize", "layerComp.new"]);
    expect(summaryJson(result).created).toEqual(["Variant — 800x600", "Variant — 1080x1080"]);
    expect(result.warnings?.[0]).toContain("size 800x600 equals the current canvas");
    expect(result.warnings).toContain(LAYOUT_REPLAY_WARNING);
  });

  it("fromCurrent=false without comps is a not_found with a comp_new hint", async () => {
    const failure = await runErr(
      { op: "sizes", sizes: [size(1080, 1080)], fromCurrent: false },
      { compListing: NO_COMPS },
    );
    expect(failure.code).toBe("not_found");
    expect(failure.hint).toContain("comp_new");
  });

  it("refuses to shadow existing comps (apply-by-name must stay unambiguous)", async () => {
    const listing: CompListing = {
      comps: [{ id: 1, name: "Variant — 1080x1080" }],
      lastApplied: 1,
    };
    const failure = await runErr(
      { op: "sizes", sizes: [size(1080, 1080)], fromCurrent: true },
      { compListing: listing },
    );
    expect(failure.code).toBe("conflict");
    expect(failure.message).toContain("Variant — 1080x1080");
  });

  it("refuses a colliding baseline name (fromCurrent=true names it from the canvas)", async () => {
    const listing: CompListing = { comps: [{ id: 1, name: "Variant — 800x600" }], lastApplied: 1 };
    const failure = await runErr(
      { op: "sizes", sizes: [size(1080, 1080)], fromCurrent: true },
      { compListing: listing },
    );
    expect(failure.code).toBe("conflict");
    expect(failure.message).toContain("Variant — 800x600");
  });

  it("maps an inspect failure instead of guessing the baseline name", async () => {
    const failure = await runErr(
      { op: "sizes", sizes: [size(1080, 1080)], fromCurrent: true },
      {
        canvas: { ok: false, code: "engine_crashed", message: "died", retryable: true },
      },
    );
    expect(failure.code).toBe("engine_crashed");
  });

  it("treats the comp listing as load-bearing for sizes", async () => {
    const failure = await runErr(
      { op: "sizes", sizes: [size(1080, 1080)], fromCurrent: true },
      { compListing: { ok: false, code: "engine_timeout", message: "late", retryable: true } },
    );
    expect(failure.code).toBe("engine_timeout");
  });
});

// ---------------------------------------------------------------------------
// Languages: comp naming table, slot resolution, merges, caps
// ---------------------------------------------------------------------------

describe("variant_create — languages (comp naming + data sets)", () => {
  it("names one comp per language after the §10.2 pattern", async () => {
    const { result } = await runOk({
      op: "languages",
      texts: {
        en: { Headline: "Hello" },
        "en-US": { Headline: "Hello" },
      },
    });
    expect(summaryJson(result).created).toEqual(["Variant — en", "Variant — en-US"]);
    expect(summaryJson(result).applied).toEqual(["en", "en-US"]);
  });

  it("resolves slots case-insensitively against Type layers", async () => {
    const { batches } = await runOk({
      op: "languages",
      texts: { es: { headline: "Hola" } },
    });
    expect(paramsOf(batchOf(batches), 0)).toEqual({
      defs: [{ name: "headline", layer: 3, type: "textReplacement" }],
    });
  });

  it("refuses unknown slots with the document's layer names", async () => {
    const failure = await runErr({
      op: "languages",
      texts: { es: { Badge: "New!" } },
    });
    expect(failure.code).toBe("unknown_slots");
    expect(failure.message).toBe("unknown slots: Badge");
    expect(failure.hint).toContain("Headline");
  });

  it("refuses ambiguous slots with candidate ids", async () => {
    const failure = await runErr(
      { op: "languages", texts: { es: { Headline: "Hola" } } },
      { trees: [layer("3", "Headline", "Type"), layer("7", "Headline", "Type")] },
    );
    expect(failure.code).toBe("ambiguous_layer");
    expect(failure.hint).toContain("id 3");
  });

  it("refuses non-text slots", async () => {
    const failure = await runErr({
      op: "languages",
      texts: { es: { Logo: "Brand text" } },
    });
    expect(failure.code).toBe("invalid_slots");
    expect(failure.message).toContain("Pixel layer, not a text layer");
  });

  it("warns when two slots resolve to the same layer", async () => {
    const { result } = await runOk({
      op: "languages",
      texts: { es: { Headline: "One", headline: "Two" } },
    });
    expect(result.warnings?.some((warning) => warning.includes("resolve to the same layer"))).toBe(
      true,
    );
  });

  it("keeps existing variables and data sets, re-binding slot-named defs (warned)", async () => {
    const listing: VariablesListing = {
      defs: [
        { name: "Headline", layer: 99, type: "textReplacement" },
        { name: "CTA", layer: 6, type: "visibility" },
      ],
      dataSets: [
        { name: "de", values: [{ variable: "Headline", kind: "text", value: "Hallo" }] },
        { name: "es", values: [{ variable: "Old", kind: "text", value: "old" }] },
      ],
    };
    const { result, batches } = await runOk(
      { op: "languages", texts: { es: { Headline: "Hola" } } },
      { variablesListing: listing },
    );
    const batch = batches[0];
    if (batch === undefined) throw new Error("no batch");
    expect(paramsOf(batch, 0)).toEqual({
      defs: [
        { name: "CTA", layer: 6, type: "visibility" },
        { name: "Headline", layer: 3, type: "textReplacement" },
      ],
    });
    const dataSets = paramsOf(batch, 1).dataSets as DataSetRow[];
    expect(dataSets.map((set) => set.name)).toEqual(["de", "es"]);
    expect(result.warnings?.some((warning) => warning.includes("re-bound from layer 99"))).toBe(
      true,
    );
    expect(
      result.warnings?.some((warning) => warning.includes("replaced an existing data set")),
    ).toBe(true);
  });

  it("refuses comp name collisions before mutating", async () => {
    const failure = await runErr(
      { op: "languages", texts: { es: { Headline: "Hola" } } },
      { compListing: { comps: [{ id: 1, name: "Variant — es" }], lastApplied: 1 } },
    );
    expect(failure.code).toBe("conflict");
  });

  it("says the document ends on the last language and pairs comps with data sets", async () => {
    const { result } = await runOk({
      op: "languages",
      texts: { es: { Headline: "Hola" }, en: { Headline: "Hello" } },
    });
    expect(
      result.warnings?.some((warning) => warning.includes('the last language applied ("en")')),
    ).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes("not text"))).toBe(true);
  });

  it("caps warnings at the kit's 20 (defineTool would reject more)", async () => {
    const slots = Array.from({ length: 40 }, (_, i) => `Slot ${i}`);
    const defs = slots.map((slot, i) => ({ name: slot, layer: 100 + i, type: "textReplacement" }));
    const texts = Object.fromEntries(slots.map((slot) => [slot, "x"]));
    const tree = slots.map((slot, i) => layer(String(i + 1), slot, "Type"));
    const { result } = await runOk(
      { op: "languages", texts: { es: texts } },
      { variablesListing: { defs, dataSets: [] }, trees: tree },
    );
    expect(result.warnings).toHaveLength(20);
    expect(result.warnings?.at(-1)).toContain("more warnings");
    // buildSummary keeps the compact reply small under the same flood.
    const summary = buildSummary({ created: ["x"], warnings: result.warnings ?? [] });
    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it("schema caps: 10 languages, 10-char codes, 40 slots, 2000-char texts", () => {
    const langs = Object.fromEntries(
      Array.from({ length: MAX_LANGUAGES }, (_, i) => [`l${i}`, { Headline: "x" }]),
    );
    expect(parseOk({ op: "languages", texts: langs })).toBeTruthy();
    const eleven = { ...langs, extra: { Headline: "x" } };
    expect(parseErr({ op: "languages", texts: eleven }).code).toBe("invalid_args");
    expect(parseErr({ op: "languages", texts: { "12345678901": { Headline: "x" } } }).code).toBe(
      "invalid_args",
    );
    expect(parseErr({ op: "languages", texts: { es: { Headline: "x".repeat(2001) } } }).code).toBe(
      "invalid_args",
    );
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`S${i}`, "x"]));
    expect(parseErr({ op: "languages", texts: { es: many } }).code).toBe("invalid_args");
    expect(parseErr({ op: "languages", texts: {} }).code).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// data_set_new / apply_data_set — value caps and existence checks
// ---------------------------------------------------------------------------

describe("variant_create — data set value caps and lookups", () => {
  it("accepts 50 values and rejects 51 at the schema (task-pinned cap)", () => {
    expect(MAX_DATA_SET_VALUES).toBe(50);
    const entries = Array.from({ length: 50 }, (_, i) => [`v${i}`, "text"] as const);
    const fifty = Object.fromEntries(entries);
    expect(parseOk({ op: "data_set_new", name: "big", values: fifty })).toBeTruthy();
    const defs: readonly VariableDefRow[] = entries.map(([name]) => ({
      name,
      layer: 1,
      type: "textReplacement",
    }));
    expect(
      parseErr({ op: "data_set_new", name: "big", values: { ...fifty, extra: "x" } }).code,
    ).toBe("invalid_args");
    expect(buildDataSetValues(fifty, defs).ok).toBe(true);
  });

  it("caps each value at 2000 chars", () => {
    expect(parseErr({ op: "data_set_new", name: "x", values: { a: "y".repeat(2001) } }).code).toBe(
      "invalid_args",
    );
    expect(
      parseOk({ op: "data_set_new", name: "x", values: { a: "y".repeat(2000) } }),
    ).toBeTruthy();
  });

  it("refuses unknown variables with defined-variable candidates", async () => {
    const failure = await runErr(
      { op: "data_set_new", name: "promo", values: { Badge: "New" } },
      { variablesListing: VARIABLES },
    );
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("unknown variables: Badge");
    expect(failure.hint).toContain("Headline");
  });

  it("replaces a same-name data set and warns; keeps the others", async () => {
    const listing: VariablesListing = {
      defs: VARIABLES.defs,
      dataSets: [
        { name: "promo", values: [{ variable: "Headline", kind: "text", value: "Old" }] },
        { name: "keep", values: [] },
      ],
    };
    const { result, batches } = await runOk(
      { op: "data_set_new", name: "promo", values: { Headline: "New" } },
      { variablesListing: listing },
    );
    const dataSets = paramsOf(batchOf(batches), 0).dataSets as DataSetRow[];
    expect(dataSets.map((set) => set.name)).toEqual(["keep", "promo"]);
    expect(dataSets[1]?.values).toEqual([{ variable: "Headline", kind: "text", value: "New" }]);
    expect(result.warnings?.[0]).toContain("replaced an existing data set");
  });

  it("apply_data_set not_found lists the known data sets", async () => {
    const failure = await runErr(
      { op: "apply_data_set", name: "fr" },
      { variablesListing: { defs: [], dataSets: [{ name: "es", values: [] }] } },
    );
    expect(failure.code).toBe("not_found");
    expect(failure.hint).toContain("known data sets: es");
  });

  it("treats unreadable variables.list as a conformance stop for data_set_new", async () => {
    const failure = await runErr(
      { op: "data_set_new", name: "promo", values: { Headline: "x" } },
      { variablesListing: "unreadable" },
    );
    expect(failure.code).toBe("internal_error");
  });
});

// ---------------------------------------------------------------------------
// comp_new / comp_apply / apply_data_set — collisions, degradation, warnings
// ---------------------------------------------------------------------------

describe("variant_create — comp lookups and advisory degradation", () => {
  it("comp_apply not_found lists known comps", async () => {
    const failure = await runErr({ op: "comp_apply", name: "Nope — x" }, { compListing: COMPS });
    expect(failure.code).toBe("not_found");
    expect(failure.hint).toContain("known comps: Design, Design v2");
  });

  it("comp_apply refuses a name held by two comps", async () => {
    const listing: CompListing = {
      comps: [
        { id: 2, name: "Design" },
        { id: 5, name: "Design" },
      ],
      lastApplied: 2,
    };
    const failure = await runErr({ op: "comp_apply", name: "Design" }, { compListing: listing });
    expect(failure.code).toBe("conflict");
    expect(failure.hint).toContain("2, 5");
  });

  it("comp_apply surfaces missingLayers from the apply reply as a warning", async () => {
    const { result } = await runOk(
      { op: "comp_apply", name: "Design" },
      { compListing: COMPS, outcomeResults: [{ comp: 3, missingLayers: 2 }] },
    );
    expect(result.warnings?.some((warning) => warning.includes("2 deleted layer(s)"))).toBe(true);
  });

  it("comp_apply proceeds (warned) when the comp listing degrades", async () => {
    const { result, batches } = await runOk(
      { op: "comp_apply", name: "Design" },
      { compListing: { ok: false, code: "engine_timeout", message: "late", retryable: true } },
    );
    expect(batches).toHaveLength(1);
    expect(result.warnings?.some((warning) => warning.includes("was not verified"))).toBe(true);
  });

  it("apply_data_set proceeds (warned) when the variables listing degrades", async () => {
    const { result, batches } = await runOk(
      { op: "apply_data_set", name: "es" },
      { variablesListing: { ok: false, code: "engine_timeout", message: "late", retryable: true } },
    );
    expect(batches).toHaveLength(1);
    expect(result.warnings?.some((warning) => warning.includes("was not verified"))).toBe(true);
  });

  it("comp_new fromCurrent=true proceeds (warned) without the collision check", async () => {
    const { result, batches } = await runOk(
      { op: "comp_new", name: "Campaign — summer", fromCurrent: true },
      { compListing: "unreadable" },
    );
    expect(batches).toHaveLength(1);
    expect(result.warnings?.some((warning) => warning.includes("not checked for collisions"))).toBe(
      true,
    );
  });

  it("comp_new refuses to shadow an existing comp name (checked post-auto-fix)", async () => {
    const listing: CompListing = { comps: [{ id: 1, name: "Dark — variant" }], lastApplied: 1 };
    const failure = await runErr(
      { op: "comp_new", name: "Dark", fromCurrent: true },
      { compListing: listing },
    );
    expect(failure.code).toBe("conflict");
    expect(failure.message).toContain("Dark — variant");
  });

  it("comp_new fromCurrent=false maps a listing failure", async () => {
    const failure = await runErr(
      { op: "comp_new", name: "Design v3 — dark", fromCurrent: false },
      { compListing: { ok: false, code: "engine_unavailable", message: "gone", retryable: true } },
    );
    expect(failure.code).toBe("engine_unavailable");
  });

  it("languages stops when the comp listing is load-bearing and fails", async () => {
    const failure = await runErr(
      { op: "languages", texts: { es: { Headline: "Hola" } } },
      { compListing: { ok: false, code: "engine_crashed", message: "died", retryable: true } },
    );
    expect(failure.code).toBe("engine_crashed");
  });

  it("languages stops when variables.list is unreadable (whole-list writes)", async () => {
    const failure = await runErr(
      { op: "languages", texts: { es: { Headline: "Hola" } } },
      { variablesListing: "unreadable" },
    );
    expect(failure.code).toBe("internal_error");
  });

  it("languages maps a layer-tree failure", async () => {
    const failure = await runErr(
      { op: "languages", texts: { es: { Headline: "Hola" } } },
      { trees: { ok: false, code: "engine_unavailable", message: "gone", retryable: true } },
    );
    expect(failure.code).toBe("engine_unavailable");
  });
});

// ---------------------------------------------------------------------------
// §5.2 budgets + transactional batch + failure mapping
// ---------------------------------------------------------------------------

describe("variant_create — budgets, transactions, engine failures", () => {
  it("charges the exact mutating-command count once, before dispatch", async () => {
    const run = await runTool({
      op: "sizes",
      sizes: [
        { width: 1080, height: 1080 },
        { width: 1080, height: 1920 },
      ],
      fromCurrent: true,
    });
    expect(run.charges).toEqual([{ commands: 6 }]);
  });

  it("stops cleanly when the budget boundary is crossed (§5.2)", async () => {
    const run = await runTool({ op: "comp_new", name: "A — b", fromCurrent: true }, {}, false);
    if (run.result.ok) throw new Error("unexpected success");
    expect(run.result.code).toBe("budget_exceeded");
    expect(run.result.hint).toContain("§5.2");
    expect(run.batches).toHaveLength(0);
  });

  it("runs one transactional batch with the run's signal", async () => {
    const { engine, batches } = makeRecordingEngine({ compListing: COMPS });
    const ctx: ToolContext = makeFakeContext({ engine });
    const signal = freshSignal();
    const result = await variantCreateTool.run(
      ctx,
      parseOk({ op: "comp_apply", name: "Design" }),
      signal,
    );
    expect(result.ok).toBe(true);
    expect(batchOf(batches).options?.transaction).toBe(true);
    expect(batchOf(batches).options?.signal).toBe(signal);
  });

  it("passes the signal to preflight execute calls too", async () => {
    const { engine, executes } = makeRecordingEngine({
      variablesListing: { defs: [], dataSets: [{ name: "es", values: [] }] },
    });
    const ctx: ToolContext = makeFakeContext({ engine });
    const signal = freshSignal();
    await variantCreateTool.run(ctx, parseOk({ op: "apply_data_set", name: "es" }), signal);
    expect(executes[0]?.cmd.id).toBe("variables.list");
    expect(executes[0]?.options?.signal).toBe(signal);
  });

  it("maps batch failures (catalog code passes through)", async () => {
    const failure = await runErr(
      { op: "comp_new", name: "A — b", fromCurrent: true },
      { batchFailure: { ok: false, code: "engine_crashed", message: "died", retryable: true } },
    );
    expect(failure.code).toBe("engine_crashed");
    expect(failure.retryable).toBe(true);
    expect(failure.message).toBe("died");
  });

  it("degrades unmapped facade codes to engine_unavailable, never leaks them", async () => {
    const failure = await runErr(
      { op: "comp_new", name: "A — b", fromCurrent: true },
      {
        batchFailure: {
          ok: false,
          code: "engine_command_failed" as never,
          message: "internal id 17",
          retryable: false,
        },
      },
    );
    expect(failure.code).toBe("engine_unavailable");
    expect(failure.message).toContain("internal id 17");
  });

  it("a failed command outcome is a rolled-back transaction, not a partial variant", async () => {
    const failure = await runErr(
      { op: "comp_new", name: "A — b", fromCurrent: true },
      { commandFailure: true },
    );
    expect(failure.code).toBe("internal_error");
    expect(failure.hint).toContain("rolled back");
  });
});

// ---------------------------------------------------------------------------
// §6.1 strict schema (parseToolArgs table)
// ---------------------------------------------------------------------------

describe("variant_create — strict argument schema (§6.1)", () => {
  const name121 = "x".repeat(121);

  it.each([
    { what: "empty", raw: {} },
    { what: "unknown op", raw: { op: "comp_clone", name: "A — b" } },
    { what: "missing op", raw: { name: "A — b" } },
    {
      what: "comp_new missing fromCurrent",
      raw: { op: "comp_new", name: "A — b" },
    },
    {
      what: "comp_new boolean as string",
      raw: { op: "comp_new", name: "A — b", fromCurrent: "true" },
    },
    {
      what: "comp_new extra property",
      raw: { op: "comp_new", name: "A — b", fromCurrent: true, extra: 1 },
    },
    {
      what: "comp_new 121-char name",
      raw: { op: "comp_new", name: name121, fromCurrent: true },
    },
    {
      what: "comp_new empty name",
      raw: { op: "comp_new", name: "", fromCurrent: true },
    },
    {
      what: "comp_apply extra property",
      raw: { op: "comp_apply", name: "A — b", fromCurrent: true },
    },
    {
      what: "data_set_new missing values",
      raw: { op: "data_set_new", name: "promo" },
    },
    {
      what: "data_set_new empty values",
      raw: { op: "data_set_new", name: "promo", values: {} },
    },
    {
      what: "data_set_new 51 values",
      raw: {
        op: "data_set_new",
        name: "promo",
        values: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, "x"])),
      },
    },
    {
      what: "data_set_new empty variable key",
      raw: { op: "data_set_new", name: "promo", values: { "": "x" } },
    },
    { what: "apply_data_set missing name", raw: { op: "apply_data_set" } },
    { what: "apply_data_set empty name", raw: { op: "apply_data_set", name: "" } },
    {
      what: "sizes missing fromCurrent",
      raw: { op: "sizes", sizes: [{ width: 64, height: 64 }] },
    },
    {
      what: "sizes extra field",
      raw: {
        op: "sizes",
        sizes: [{ width: 64, height: 64, anchor: "topLeft" }],
        fromCurrent: true,
      },
    },
  ])("rejects $what with invalid_args", ({ raw }) => {
    const parsed = parseErr(raw);
    expect(parsed.code).toBe("invalid_args");
    expect(parsed.hint).toBeTruthy();
  });

  it("accepts every documented op shape", () => {
    expect(parseOk({ op: "comp_new", name: "A — b", fromCurrent: true })).toBeTruthy();
    expect(parseOk({ op: "comp_apply", name: "A — b" })).toBeTruthy();
    expect(
      parseOk({ op: "data_set_new", name: "promo", values: { Headline: "Sale" } }),
    ).toBeTruthy();
    expect(parseOk({ op: "apply_data_set", name: "promo" })).toBeTruthy();
    expect(
      parseOk({
        op: "sizes",
        sizes: [{ width: 64, height: 8192 }],
        fromCurrent: false,
      }),
    ).toBeTruthy();
    expect(parseOk({ op: "languages", texts: { es: { Headline: "Hola" } } })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Result envelope shape (§6.1 compact reply)
// ---------------------------------------------------------------------------

describe("variant_create — result envelope", () => {
  it("returns a §6.1 ok envelope with a JSON summary the model can act on", async () => {
    const { result } = await runOk({
      op: "languages",
      texts: { es: { Headline: "Hola" } },
    });
    const parsed = summaryJson(result);
    expect(parsed.created).toEqual(["Variant — es"]);
    expect(parsed.applied).toEqual(["es"]);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(2000);
    expect(result.documentRevision).toBe(9);
  });

  it("keeps created-only (or applied-only) summaries minimal", async () => {
    const comp = await runOk({ op: "comp_new", name: "A — b", fromCurrent: true });
    expect(summaryJson(comp.result)).toEqual({ created: ["A — b"], warnings: [] });
    const applied = await runOk(
      { op: "apply_data_set", name: "es" },
      { variablesListing: { defs: [], dataSets: [{ name: "es", values: [] }] } },
    );
    expect(summaryJson(applied.result)).toEqual({ created: [], applied: ["es"], warnings: [] });
  });
});
