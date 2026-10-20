// layer-ops.test.ts — layer_ops (§6 row 9): op→command mapping, §10.1/§10.2
// naming rules, §6.1 ref resolution, transactional batch, strict schema.
//
// Pure + fake-engine tests only: no engine, no db, no network (AGENTS.md).

import { describe, expect, it } from "vitest";
import { LAYER_COMMANDS } from "@studio/engine-client";
import {
  ALIGN_MODES,
  checkLayerName,
  isAutoLayerName,
  LAYER_OPS_COMMANDS,
  layerOpsTool,
  resolveLayerRef,
  type LayerOpsArgs,
} from "../src/tools/layer-ops.js";
import { parseToolArgs } from "../src/kit.js";
import type {
  EngineBatchOptions,
  EngineBatchReport,
  EngineCommand,
  EngineFailure,
  EngineLayerSummary,
  EngineOutcome,
  ToolContext,
  ToolErr,
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
];

const manyLayers = (count: number, kind = "Pixel"): EngineLayerSummary[] =>
  Array.from({ length: count }, (_, index) => layer(String(index + 1), `Item ${index + 1}`, kind));

const manyRefs = (count: number): { layerId: string }[] =>
  Array.from({ length: count }, (_, index) => ({ layerId: String(index + 1) }));

interface RecordedBatch {
  readonly cmds: readonly EngineCommand[];
  readonly options: EngineBatchOptions | undefined;
}

interface FakeEngineOptions {
  /** listLayers results in call order; the last one repeats when calls run out. */
  readonly trees?: readonly (readonly EngineLayerSummary[])[];
  readonly revision?: number;
  readonly batchFailure?: EngineFailure;
  readonly commandFailure?: boolean;
  readonly listFailure?: EngineFailure;
  /** 1-based listLayers call from which listFailure is served. */
  readonly failListFromCall?: number;
}

/** A recording EngineLike fake: captures every batch + options. */
function makeRecordingEngine(options: FakeEngineOptions = {}) {
  const batches: RecordedBatch[] = [];
  let listCalls = 0;
  const trees = options.trees ?? [TREE];
  const engine = {
    batch: async (
      cmds: readonly EngineCommand[],
      batchOptions?: EngineBatchOptions,
    ): Promise<EngineOutcome<EngineBatchReport>> => {
      batches.push({ cmds: [...cmds], options: batchOptions });
      if (options.batchFailure !== undefined) {
        return options.batchFailure;
      }
      const outcomes = [...cmds].map((cmd, index): EngineBatchReport["outcomes"][number] => ({
        index,
        commandId: cmd.id,
        ok: !options.commandFailure,
        message: options.commandFailure === true ? "rejected" : undefined,
      }));
      return { ok: true, value: { revision: options.revision ?? 7, outcomes } };
    },
    execute: async (): Promise<EngineOutcome<{ revision: number }>> => ({ ok: true, value: { revision: 7 } }),
    render: async (): Promise<EngineOutcome<{ image: Uint8Array; widthPx: number; heightPx: number }>> => ({
      ok: true,
      value: { image: new Uint8Array(), widthPx: 64, heightPx: 64 },
    }),
    inspect: async (): Promise<
      EngineOutcome<{ revision: number; widthPx: number; heightPx: number; layers: readonly EngineLayerSummary[] }>
    > => ({ ok: true, value: { revision: 7, widthPx: 800, heightPx: 600, layers: [] } }),
    listLayers: async (): Promise<EngineOutcome<readonly EngineLayerSummary[]>> => {
      listCalls += 1;
      if (
        options.listFailure !== undefined &&
        listCalls >= (options.failListFromCall ?? Number.POSITIVE_INFINITY)
      ) {
        return options.listFailure;
      }
      const tree = trees.at(Math.min(listCalls - 1, trees.length - 1));
      return { ok: true, value: tree ?? [] };
    },
  };
  return { engine, batches };
}

/** Parses valid args or fails the test; keeps run calls typed + terse. */
function parseOk(raw: unknown): LayerOpsArgs {
  const parsed = parseToolArgs(layerOpsTool, raw);
  if (!parsed.ok) {
    throw new Error(`args unexpectedly invalid: ${parsed.hint ?? parsed.message}`);
  }
  return parsed.args;
}

function parseErr(raw: unknown): ToolErr {
  const parsed = parseToolArgs(layerOpsTool, raw);
  if (parsed.ok) {
    throw new Error("args unexpectedly valid");
  }
  return parsed;
}

async function runTool(raw: unknown, engineOptions: FakeEngineOptions = {}) {
  const { engine, batches } = makeRecordingEngine(engineOptions);
  const ctx: ToolContext = makeFakeContext({ engine });
  const result = await layerOpsTool.run(ctx, parseOk(raw), freshSignal());
  return { result, batches, ctx };
}

/** ok-side helper: asserts success and hands back the ToolOk. */
async function runOk(raw: unknown, engineOptions: FakeEngineOptions = {}) {
  const { result, batches } = await runTool(raw, engineOptions);
  if (!result.ok) {
    throw new Error(`tool unexpectedly failed: ${result.code} ${result.message}`);
  }
  return { result, batches };
}

function warningsOf(result: { warnings?: readonly string[] }): readonly string[] {
  return result.warnings ?? [];
}

// ---------------------------------------------------------------------------
// §6 row 9 surface + §2.2 id pinning
// ---------------------------------------------------------------------------

describe("layer_ops — §6 row 9 surface", () => {
  it("is named layer_ops with a planner description", () => {
    expect(layerOpsTool.name).toBe("layer_ops");
    expect(layerOpsTool.description.length).toBeGreaterThanOrEqual(10);
  });

  it("emits only §2.2 registry ids (drift check vs @studio/engine-client)", () => {
    const emitted = [
      LAYER_OPS_COMMANDS.select,
      LAYER_OPS_COMMANDS.newGroup,
      LAYER_OPS_COMMANDS.groupLayers,
      LAYER_OPS_COMMANDS.duplicate,
      LAYER_OPS_COMMANDS.setProps,
      ...Object.values(LAYER_OPS_COMMANDS.align),
      ...Object.values(LAYER_OPS_COMMANDS.arrange),
    ];
    for (const id of emitted) {
      expect(LAYER_COMMANDS, id).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// op → engine command mapping (the task's table), one transactional batch
// ---------------------------------------------------------------------------

describe("layer_ops — op → command mapping (§2.2 ids, one batch)", () => {
  const mapping = [
    {
      what: "create_group",
      raw: { op: "create_group", name: "Brand" },
      ids: ["layer.new.group"],
      params: [{ name: "Brand" }],
    },
    {
      what: "create_group with a parent selects it first",
      raw: { op: "create_group", name: "Brand", parent: { layerId: "3" } },
      ids: ["layer.select", "layer.new.group"],
      params: [{ layer: 3, mode: "replace" }, { name: "Brand" }],
    },
    {
      what: "create_group resolves a parent by name to its id",
      raw: { op: "create_group", name: "Brand", parent: { layerName: "Subhead" } },
      ids: ["layer.select", "layer.new.group"],
      params: [{ layer: 4, mode: "replace" }, { name: "Brand" }],
    },
    {
      what: "duplicate by id",
      raw: { op: "duplicate", layer: { layerId: "2" } },
      ids: ["layer.duplicate"],
      params: [{ layer: 2 }],
    },
    {
      what: "duplicate by name resolves to the id",
      raw: { op: "duplicate", layer: { layerName: "Photo" } },
      ids: ["layer.duplicate"],
      params: [{ layer: 2 }],
    },
    {
      what: "rename via layer.setProps",
      raw: { op: "rename", layer: { layerId: "3" }, name: "CTA" },
      ids: ["layer.setProps"],
      params: [{ layer: 3, name: "CTA" }],
    },
    {
      what: "reorder front",
      raw: { op: "reorder", layer: { layerId: "3" }, position: "front" },
      ids: ["layer.arrange.bringToFront"],
      params: [{ layer: 3 }],
    },
    {
      what: "reorder back",
      raw: { op: "reorder", layer: { layerId: "3" }, position: "back" },
      ids: ["layer.arrange.sendToBack"],
      params: [{ layer: 3 }],
    },
    {
      what: "reorder forward",
      raw: { op: "reorder", layer: { layerId: "3" }, position: "forward" },
      ids: ["layer.arrange.bringForward"],
      params: [{ layer: 3 }],
    },
    {
      what: "reorder backward",
      raw: { op: "reorder", layer: { layerId: "3" }, position: "backward" },
      ids: ["layer.arrange.sendBackward"],
      params: [{ layer: 3 }],
    },
    {
      what: "align selects its targets then aligns to their combined bounds",
      raw: { op: "align", layers: [{ layerId: "1" }, { layerId: "2" }, { layerId: "3" }], mode: "leftEdges" },
      ids: ["layer.select", "layer.select", "layer.select", "layer.align.leftEdges"],
      params: [
        { layer: 1, mode: "replace" },
        { layer: 2, mode: "add" },
        { layer: 3, mode: "add" },
        { to: "layers" },
      ],
    },
    {
      what: "set_props carries only the given properties as fractions",
      raw: { op: "set_props", layer: { layerId: "3" }, visible: false, opacity: 0.5, locked: true },
      ids: ["layer.setProps"],
      params: [{ layer: 3, visible: false, opacity: 0.5, locked: true }],
    },
    {
      what: "set_props with a single property",
      raw: { op: "set_props", layer: { layerId: "1" }, opacity: 0 },
      ids: ["layer.setProps"],
      params: [{ layer: 1, opacity: 0 }],
    },
    {
      what: "group selects its members then groups them",
      raw: { op: "group", layers: [{ layerId: "2" }, { layerId: "3" }], name: "Content" },
      ids: ["layer.select", "layer.select", "layer.groupLayers"],
      params: [{ layer: 2, mode: "replace" }, { layer: 3, mode: "add" }, { name: "Content" }],
    },
    {
      what: "group without a name lets the engine auto-name (and warns)",
      raw: { op: "group", layers: [{ layerId: "2" }, { layerId: "3" }] },
      ids: ["layer.select", "layer.select", "layer.groupLayers"],
      params: [{ layer: 2, mode: "replace" }, { layer: 3, mode: "add" }, {}],
    },
  ] as const;

  for (const row of mapping) {
    it(`${row.what}`, async () => {
      const { result, batches } = await runOk(row.raw, { trees: [TREE] });
      expect(result.ok).toBe(true);
      expect(batches).toHaveLength(1);
      const recorded = batches.at(0);
      expect(recorded?.cmds.map((cmd) => cmd.id)).toEqual([...row.ids]);
      expect(recorded?.cmds.map((cmd) => cmd.params)).toEqual([...row.params]);
      expect(recorded?.options?.transaction).toBe(true);
    });
  }

  it("every align mode maps to the exact layer.align.<mode> id", async () => {
    for (const mode of ALIGN_MODES) {
      const { result, batches } = await runOk(
        { op: "align", layers: [{ layerId: "3" }, { layerId: "4" }], mode },
        { trees: [TREE] },
      );
      expect(result.ok).toBe(true);
      const last = batches.at(0)?.cmds.at(-1);
      expect(last?.id).toBe(`layer.align.${mode}`);
      expect(last?.params).toEqual({ to: "layers" });
    }
  });

  it("runs one transactional batch and threads the executor's signal", async () => {
    const { engine, batches } = makeRecordingEngine({ trees: [TREE] });
    const ctx: ToolContext = makeFakeContext({ engine });
    const signal = freshSignal();
    const result = await layerOpsTool.run(
      ctx,
      parseOk({ op: "duplicate", layer: { layerId: "2" } }),
      signal,
    );
    expect(result.ok).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches.at(0)?.options?.transaction).toBe(true);
    expect(batches.at(0)?.options?.signal).toBe(signal);
  });

  it("reports the batch's documentRevision", async () => {
    const { result } = await runOk({ op: "duplicate", layer: { layerId: "2" } }, { revision: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.documentRevision).toBe(42);
    }
  });

  it("group of 50 selects each member then groups (51 batch commands)", async () => {
    const { result, batches } = await runOk(
      { op: "group", layers: manyRefs(50), name: "Content" },
      { trees: [manyLayers(50)] },
    );
    expect(result.ok).toBe(true);
    const recorded = batches.at(0);
    expect(recorded?.cmds).toHaveLength(51);
    expect(recorded?.cmds.at(-1)?.id).toBe("layer.groupLayers");
    expect(recorded?.cmds.at(-1)?.params).toEqual({ name: "Content" });
    if (result.ok) {
      expect(result.summary).toContain("+45 more");
    }
  });
});

// ---------------------------------------------------------------------------
// group 2–50 bounds
// ---------------------------------------------------------------------------

describe("layer_ops — group bounds (2–50 refs)", () => {
  it("rejects a single ref at the parse boundary", () => {
    expect(parseErr({ op: "group", layers: manyRefs(1), name: "Content" }).code).toBe("invalid_args");
  });

  it("rejects 51 refs at the parse boundary", () => {
    expect(parseErr({ op: "group", layers: manyRefs(51), name: "Content" }).code).toBe("invalid_args");
  });

  it("accepts 2 and 50 refs", () => {
    expect(parseOk({ op: "group", layers: manyRefs(2) }).ok).toBe(true);
    expect(parseOk({ op: "group", layers: manyRefs(50) }).ok).toBe(true);
  });

  it("rejects an empty align list", () => {
    expect(parseErr({ op: "align", layers: [], mode: "leftEdges" }).code).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// §10.2 rename rules + create/group names
// ---------------------------------------------------------------------------

describe("layer_ops — §10.2 naming", () => {
  it("isAutoLayerName table", () => {
    for (const name of ["Layer 0", "Layer 42", "Group 3"]) {
      expect(isAutoLayerName(name), name).toBe(true);
    }
    for (const name of ["Headline", "Photo — Latte", "Layered 2", "layer 1", "Group", "Layer 42x"]) {
      expect(isAutoLayerName(name), name).toBe(false);
    }
  });

  it("checkLayerName rejects placeholders with a PascalCase-roles hint", () => {
    for (const name of ["Layer 1", "Group 3"]) {
      const issue = checkLayerName(name);
      expect(issue, name).toBeDefined();
      expect(issue?.code).toBe("validation_failed");
      expect(issue?.hint).toContain("Headline");
      expect(issue?.hint).toContain("Content");
    }
  });

  it("checkLayerName rejects blank names", () => {
    expect(checkLayerName("  ")?.code).toBe("validation_failed");
  });

  it("checkLayerName accepts §10.2 role names", () => {
    for (const name of ["Headline", "CTA", "Photo — Latte", "Content"]) {
      expect(checkLayerName(name), name).toBeUndefined();
    }
  });

  it("rename rejects placeholders before any engine call", async () => {
    const { result, batches } = await runTool(
      { op: "rename", layer: { layerId: "2" }, name: "Layer 1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain("Layer 1");
    }
    expect(batches).toHaveLength(0);
  });

  it("rename accepts a §10.2 name and sends it to layer.setProps", async () => {
    const { result, batches } = await runOk({ op: "rename", layer: { layerId: "3" }, name: "CTA" });
    expect(batches.at(0)?.cmds.at(0)?.params).toEqual({ layer: 3, name: "CTA" });
    if (result.ok) {
      expect(result.summary).toContain('Renamed "Headline" (id 3) to "CTA"');
      expect(result.warnings).toBeUndefined();
    }
  });

  it("create_group rejects a placeholder name before any engine call", async () => {
    const { result, batches } = await runTool({ op: "create_group", name: "Group 2" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
    }
    expect(batches).toHaveLength(0);
  });

  it("group rejects a placeholder name before any engine call", async () => {
    const { result, batches } = await runTool({
      op: "group",
      layers: [{ layerId: "1" }, { layerId: "2" }],
      name: "Group 9",
    });
    expect(result.ok).toBe(false);
    expect(batches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6.1 layer reference resolution
// ---------------------------------------------------------------------------

describe("layer_ops — §6.1 layer refs", () => {
  it("an unknown id fails with the document's layers as candidates", async () => {
    const { result, batches } = await runTool({ op: "duplicate", layer: { layerId: "99" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("layer_not_found");
      expect(result.hint).toContain("Photo (id 2)");
      expect(result.hint).toContain("Headline (id 3)");
    }
    expect(batches).toHaveLength(0);
  });

  it("an unknown name fails with candidates too", async () => {
    const { result, batches } = await runTool({ op: "duplicate", layer: { layerName: "Missing" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("layer_not_found");
      expect(result.hint).toContain('No layer is named "Missing"');
    }
    expect(batches).toHaveLength(0);
  });

  it("an ambiguous name lists the candidate ids", async () => {
    const trees = [layer("1", "Headline", "Type"), layer("2", "Photo"), layer("3", "Headline", "Type")];
    const { result, batches } = await runTool(
      { op: "rename", layer: { layerName: "Headline" }, name: "CTA" },
      { trees: [trees] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ambiguous_layer");
      expect(result.message).toContain("matches 2 layers");
      expect(result.hint).toContain("id 1");
      expect(result.hint).toContain("id 3");
    }
    expect(batches).toHaveLength(0);
  });

  it("a unique case-insensitive name match resolves like the engine's", async () => {
    const { result, batches } = await runOk({ op: "duplicate", layer: { layerName: "photo" } });
    expect(batches.at(0)?.cmds.at(0)?.params).toEqual({ layer: 2 });
    if (result.ok) {
      expect(result.summary).toContain('Duplicated "Photo" (id 2)');
    }
  });

  it("the same layer referenced twice is rejected, not silently deduped", async () => {
    const { result, batches } = await runTool({
      op: "group",
      layers: [{ layerId: "2" }, { layerName: "Photo" }],
      name: "Content",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
    }
    expect(batches).toHaveLength(0);
  });

  it("resolveLayerRef table: id hit, name hit, folded hit, ambiguity, miss", () => {
    const layers = [
      layer("1", "Background"),
      layer("2", "Headline", "Type"),
      layer("3", "Photo"),
      layer("4", "Headline", "Type"),
    ];
    expect(resolveLayerRef({ layerId: "2" }, layers)).toMatchObject({ ok: true, layer: { layerId: "2" } });
    expect(resolveLayerRef({ layerName: "Photo" }, layers)).toMatchObject({ ok: true, layer: { layerId: "3" } });
    expect(resolveLayerRef({ layerName: "photo" }, layers)).toMatchObject({ ok: true, layer: { layerId: "3" } });
    const ambiguous = resolveLayerRef({ layerName: "Headline" }, layers);
    expect(ambiguous.ok).toBe(false);
    const miss = resolveLayerRef({ layerId: "404" }, layers);
    expect(miss.ok).toBe(false);
  });

  it("candidate hints cap at 8 layers", () => {
    const miss = resolveLayerRef({ layerName: "Nope" }, manyLayers(12));
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.hint).toContain("(+4 more)");
      expect(miss.hint).not.toContain("Item 12");
      expect((miss.hint ?? "").length).toBeLessThanOrEqual(500);
    }
  });
});

// ---------------------------------------------------------------------------
// opacity range + set_props shape
// ---------------------------------------------------------------------------

describe("layer_ops — opacity range (0–1, engine fractions)", () => {
  it("accepts 0, fractions and 1 at the parse boundary", () => {
    for (const opacity of [0, 0.25, 0.5, 1]) {
      expect(parseOk({ op: "set_props", layer: { layerId: "1" }, opacity }).ok).toBe(true);
    }
  });

  it("rejects values outside 0..1 and non-numbers", () => {
    for (const opacity of [-0.01, 1.01, 2, "0.5", null, Number.NaN]) {
      const parsed = parseToolArgs(layerOpsTool, {
        op: "set_props",
        layer: { layerId: "1" },
        opacity,
      });
      expect(parsed.ok, `opacity ${String(opacity)}`).toBe(false);
    }
  });

  it("set_props with nothing to apply is a validation failure, not a batch", async () => {
    const { result, batches } = await runTool({ op: "set_props", layer: { layerId: "1" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
    }
    expect(batches).toHaveLength(0);
  });

  it("set_props summary lists the applied properties", async () => {
    const { result } = await runOk({
      op: "set_props",
      layer: { layerId: "3" },
      visible: false,
      opacity: 0.5,
      locked: true,
    });
    if (result.ok) {
      expect(result.summary).toContain("visible=false");
      expect(result.summary).toContain("opacity=0.5");
      expect(result.summary).toContain("locked=true");
    }
  });
});

// ---------------------------------------------------------------------------
// §10.1 grouping warnings
// ---------------------------------------------------------------------------

describe("layer_ops — §10.1 group-before-multiply warnings", () => {
  it("warns 'document needs grouping' past 7 loose layers after a create", async () => {
    const { result } = await runOk({ op: "duplicate", layer: { layerId: "2" } }, {
      trees: [TREE, manyLayers(8)],
    });
    expect(warningsOf(result)).toContain("document needs grouping");
  });

  it("stays quiet at exactly 7 loose layers", async () => {
    const { result } = await runOk({ op: "duplicate", layer: { layerId: "2" } }, {
      trees: [TREE, manyLayers(7)],
    });
    expect(warningsOf(result)).not.toContain("document needs grouping");
  });

  it("counts groups as tidy, not loose", async () => {
    const trees = [TREE, [...manyLayers(6), layer("99", "Brand", "Group")]];
    const { result } = await runOk({ op: "duplicate", layer: { layerId: "2" } }, { trees });
    expect(warningsOf(result)).not.toContain("document needs grouping");
  });

  it("create_group relists to name the new group's id", async () => {
    const trees = [TREE, [...TREE, layer("12", "Brand", "Group")]];
    const { result } = await runOk({ op: "create_group", name: "Brand" }, { trees });
    if (result.ok) {
      expect(result.summary).toContain('Created group "Brand"');
      expect(result.summary).toContain("(id 12)");
    }
  });

  it("a failed advisory relist never fails the mutation", async () => {
    const { result } = await runOk({ op: "duplicate", layer: { layerId: "2" } }, {
      trees: [TREE],
      listFailure: { ok: false, code: "engine_timeout", message: "listing timed out", retryable: true },
      failListFromCall: 2,
    });
    expect(result.ok).toBe(true);
    expect(warningsOf(result)).not.toContain("document needs grouping");
  });

  it("duplicate warns about the §10.1 name collision", async () => {
    const { result } = await runOk({ op: "duplicate", layer: { layerId: "2" } });
    expect(warningsOf(result).join(" ")).toContain('keeps the name "Photo"');
  });

  it("unnamed group warns about the auto-name", async () => {
    const { result } = await runOk({
      op: "group",
      layers: [{ layerId: "2" }, { layerId: "3" }],
    });
    expect(warningsOf(result).join(" ")).toContain("auto-named");
  });

  it("single-layer align warns it is a no-op", async () => {
    const { result } = await runOk({ op: "align", layers: [{ layerId: "2" }], mode: "leftEdges" });
    expect(warningsOf(result).join(" ")).toContain("no-op");
  });
});

// ---------------------------------------------------------------------------
// engine errors mapped + strict schema
// ---------------------------------------------------------------------------

describe("layer_ops — engine failures mapped to typed envelopes", () => {
  it("a batch failure passes the catalog code, message, hint and retryable", async () => {
    const failure: EngineFailure = {
      ok: false,
      code: "engine_unavailable",
      message: "could not reach the engine",
      hint: "retry on a fresh connection",
      retryable: true,
    };
    const { result, batches } = await runTool({ op: "duplicate", layer: { layerId: "2" } }, {
      trees: [TREE],
      batchFailure: failure,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_unavailable");
      expect(result.message).toBe("could not reach the engine");
      expect(result.hint).toBe("retry on a fresh connection");
      expect(result.retryable).toBe(true);
    }
    expect(batches).toHaveLength(1);
  });

  it("codes outside the tool catalog degrade to engine_unavailable", async () => {
    const failure = {
      ok: false,
      code: "engine_command_failed",
      message: "the engine rejected a command mid-batch",
      retryable: false,
    } as EngineFailure;
    const { result } = await runTool({ op: "duplicate", layer: { layerId: "2" } }, {
      trees: [TREE],
      batchFailure: failure,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_unavailable");
      expect(result.message).toBe("the engine rejected a command mid-batch");
    }
  });

  it("a failed command in the report is a rolled-back edit, not a partial one", async () => {
    const { result } = await runTool({ op: "group", layers: [{ layerId: "1" }, { layerId: "2" }] }, {
      trees: [TREE],
      commandFailure: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal_error");
      expect(result.hint).toContain("rolled back");
    }
  });

  it("a listing failure surfaces before any mutation", async () => {
    const { result, batches } = await runTool(
      { op: "group", layers: [{ layerId: "1" }, { layerId: "2" }], name: "Content" },
      {
        trees: [TREE],
        listFailure: { ok: false, code: "engine_timeout", message: "listing timed out", retryable: true },
        failListFromCall: 1,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_timeout");
    }
    expect(batches).toHaveLength(0);
  });
});

describe("layer_ops — strict schema (§6.1)", () => {
  it("rejects unknown ops, extra keys and malformed refs", () => {
    const bad = [
      { op: "explode" },
      { op: "rename", layer: { layerId: "3" }, name: "CTA", extra: 1 },
      { op: "duplicate", layer: { layerId: "3", layerName: "Headline" } },
      { op: "duplicate", layer: {} },
      { op: "duplicate" },
      { op: "reorder", layer: { layerId: "3" }, position: "sideways" },
      { op: "align", layers: [], mode: "leftEdges" },
      { op: "align", layers: manyRefs(2), mode: "diagonal" },
      { op: "group", layers: manyRefs(1) },
      { op: "group", layers: manyRefs(51) },
      { op: "create_group" },
      { op: "create_group", name: "" },
      { op: "rename", layer: { layerId: "3" } },
      "not an object",
      null,
    ];
    for (const raw of bad) {
      const outcome = parseErr(raw);
      expect(outcome.code, JSON.stringify(raw)).toBe("invalid_args");
    }
  });

  it("accepts each op's canonical args", () => {
    const good = [
      { op: "create_group", name: "Brand" },
      { op: "create_group", name: "Brand", parent: { layerId: "3" } },
      { op: "duplicate", layer: { layerName: "Photo" } },
      { op: "rename", layer: { layerId: "3" }, name: "CTA" },
      { op: "reorder", layer: { layerId: "3" }, position: "backward" },
      { op: "align", layers: manyRefs(2), mode: "bottomEdges" },
      { op: "set_props", layer: { layerId: "1" }, locked: false },
      { op: "group", layers: manyRefs(2), name: "Content" },
      { op: "group", layers: manyRefs(50) },
    ];
    for (const raw of good) {
      expect(parseOk(raw).op, JSON.stringify(raw)).toBeTruthy();
    }
  });
});
