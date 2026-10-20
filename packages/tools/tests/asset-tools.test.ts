// tests/asset-tools.test.ts — W5-E: asset_search + asset_place contracts (§6 row 6).
//
// Pure fit/focal math is table-driven; tool flows run against recording fakes
// of the EngineLike / AssetStoreLike / TemplateCatalogLike seams (no network,
// no engine). Schema strictness goes through parseToolArgs, the executor path.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESULTS,
  assetSearchTool,
  compactAssetTable,
  toAssetRow,
} from "../src/tools/asset-search.js";
import {
  assetPlaceTool,
  computeFit,
  isPlaceableAssetPath,
} from "../src/tools/asset-place.js";
import { MAX_SUMMARY_CHARS, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import type { AnyTool } from "../src/types.js";
import type {
  AssetRecord,
  AssetStoreLike,
  EngineBatchReport,
  EngineCommand,
  EngineFailure,
  EngineLayerSummary,
  EngineLike,
  EngineOutcome,
  TemplateCatalogLike,
  TemplateManifest,
  ToolContext,
  ToolOk,
  ToolResult,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

const ORG = "org_00000000-0000-0000-0000-000000000000";
const ASSET_ID = "00000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------
// Test fakes (recording seams)
// ---------------------------------------------------------------------------

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    assetId: ASSET_ID,
    organizationId: ORG,
    filename: "sunset.png",
    mimeType: "image/png",
    widthPx: 800,
    heightPx: 600,
    storageUrl: `assets/organizations/${ORG}/assets/${ASSET_ID}`,
    ...overrides,
  };
}

interface EngineState {
  layers: EngineLayerSummary[];
  batches: EngineCommand[][];
  executes: EngineCommand[];
  revision: number;
  batchFailure?: EngineFailure;
  executeFailure?: EngineFailure;
  listFailure?: EngineFailure;
  /** Fails listLayers only once a batch has run (the post-batch diff degrades). */
  listFailureAfterBatch?: boolean;
}

function makeEngine(state: EngineState): EngineLike {
  const success = <T>(value: T): EngineOutcome<T> => ({ ok: true, value });
  return {
    async batch(cmds: readonly EngineCommand[]): Promise<EngineOutcome<EngineBatchReport>> {
      state.batches.push(cmds.map((command) => ({ ...command })));
      if (state.batchFailure !== undefined) {
        return state.batchFailure;
      }
      state.layers = [
        ...state.layers,
        { layerId: "L99", name: "sunset.png", kind: "Smart", visible: true },
      ];
      state.revision += 1;
      return success({
        revision: state.revision,
        outcomes: cmds.map((command, index) => ({ index, commandId: command.id, ok: true })),
      });
    },
    async execute(cmd: EngineCommand): Promise<EngineOutcome<{ revision: number }>> {
      state.executes.push({ ...cmd });
      if (state.executeFailure !== undefined) {
        return state.executeFailure;
      }
      state.revision += 1;
      return success({ revision: state.revision });
    },
    async render() {
      return success({ image: new Uint8Array(), widthPx: 64, heightPx: 64 });
    },
    async inspect() {
      return success({ revision: state.revision, widthPx: 800, heightPx: 600, layers: state.layers });
    },
    async listLayers() {
      if (state.listFailure !== undefined) {
        return state.listFailure;
      }
      if (state.listFailureAfterBatch === true && state.batches.length > 0) {
        return { ok: false, code: "engine_crashed", message: "boom", retryable: true } as EngineFailure;
      }
      return success(state.layers);
    },
  };
}

function makeAssets(records: AssetRecord[], searchResult?: AssetRecord[]) {
  const queries: { query: string; limit?: number }[] = [];
  const store: AssetStoreLike = {
    async search(query, options) {
      queries.push({ query, limit: options?.limit });
      return searchResult ?? records;
    },
    async get(assetId) {
      return records.find((record) => record.assetId === assetId);
    },
  };
  return { store, queries };
}

function makeTemplates(manifests: TemplateManifest[]) {
  const requested: string[] = [];
  const catalog: TemplateCatalogLike = {
    async get(ref) {
      requested.push(ref);
      return manifests.find((manifest) => `${manifest.id}@${manifest.version}` === ref);
    },
    async list() {
      return manifests.map((manifest) => ({
        id: manifest.id,
        version: manifest.version,
        title: manifest.id,
        tags: [],
        slotCount: Object.keys(manifest.slots).length,
      }));
    },
  };
  return { catalog, requested };
}

function layer(id: string, name: string, bounds?: { x: number; y: number; w: number; h: number }): EngineLayerSummary {
  return {
    layerId: id,
    name,
    kind: "Pixel",
    visible: true,
    ...(bounds === undefined ? {} : { bounds: { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } }),
  };
}

function manifest(id: string, version: string, slots: TemplateManifest["slots"], layerMap?: Record<string, string>): TemplateManifest {
  return layerMap === undefined ? { id, version, slots } : { id, version, slots, layerMap };
}

const EXHAUSTED_BUDGETS = {
  remaining: () => ({ msRemaining: 0, commandsRemaining: 0 }),
  charge: () => false,
};

async function runSearch(raw: unknown, ctx: ToolContext = makeFakeContext()): Promise<ToolResult> {
  const parsed = parseToolArgs(assetSearchTool, raw);
  if (!parsed.ok) {
    return parsed;
  }
  return assetSearchTool.run(ctx, parsed.args, freshSignal());
}

async function runPlace(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = parseToolArgs(assetPlaceTool, raw);
  if (!parsed.ok) {
    return parsed;
  }
  return assetPlaceTool.run(ctx, parsed.args, freshSignal());
}

function okOf(result: ToolResult): ToolOk {
  if (result.ok !== true) {
    throw new Error(`expected ok, got ${result.code}: ${result.message} (hint: ${result.hint ?? "—"})`);
  }
  return result;
}

function errOf(result: ToolResult) {
  if (result.ok !== false) {
    throw new Error("expected an error envelope");
  }
  return result;
}

function placeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset_id: ASSET_ID,
    target: { layer: { layerName: "Photo" } },
    idempotency_key: "place-run-0001",
    ...overrides,
  };
}

function placeCtx(options: {
  layers?: EngineLayerSummary[];
  assets?: AssetRecord[];
  manifests?: TemplateManifest[];
  budgets?: ToolContext["budgets"];
  engine?: Partial<EngineState>;
} = {}) {
  const state: EngineState = { layers: options.layers ?? [], batches: [], executes: [], revision: 1, ...options.engine };
  const engine = makeEngine(state);
  const { store } = makeAssets(options.assets ?? [asset()]);
  const { catalog } = makeTemplates(options.manifests ?? []);
  const ctx = makeFakeContext({
    engine,
    assets: store,
    templates: catalog,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
  });
  return { ctx, state };
}

// ---------------------------------------------------------------------------
// asset_search
// ---------------------------------------------------------------------------

describe("asset_search", () => {
  it("returns the compact table: id, name, width, height, kind — never URLs", async () => {
    const { store } = makeAssets([
      asset(),
      asset({
        assetId: "00000000-0000-4000-8000-000000000002",
        filename: "portrait.jpg",
        mimeType: "image/jpeg",
        widthPx: 400,
        heightPx: 300,
      }),
      asset({
        assetId: "00000000-0000-4000-8000-000000000003",
        filename: "scan.png",
        widthPx: undefined,
        heightPx: undefined,
      }),
    ]);
    const ctx = makeFakeContext({ assets: store });
    const result = okOf(await runSearch({}, ctx));
    const payload = JSON.parse(result.summary) as {
      assets: { id: string; name: string; width: number | null; height: number | null; kind: string }[];
    };
    expect(payload.assets).toHaveLength(3);
    expect(payload.assets[0]).toEqual({
      id: ASSET_ID,
      name: "sunset.png",
      width: 800,
      height: 600,
      kind: "image",
    });
    expect(payload.assets[1]?.kind).toBe("image");
    expect(payload.assets[2]?.width).toBeNull();
    expect(result.summary).not.toContain("storageUrl");
    expect(result.summary).not.toContain("assets/organizations");
    expect(result.warnings).toBeUndefined();
  });

  it("passes the query and the default limit (20) to the seam", async () => {
    const { store, queries } = makeAssets([asset()]);
    const ctx = makeFakeContext({ assets: store });
    okOf(await runSearch({ query: "sunset" }, ctx));
    expect(queries).toEqual([{ query: "sunset", limit: DEFAULT_RESULTS }]);
  });

  it("honors limit and trims a store that ignores it, with a warning", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      asset({ assetId: `00000000-0000-4000-8000-00000000000${i + 1}`, filename: `image-${i}.png` }),
    );
    const { store, queries } = makeAssets(many);
    const ctx = makeFakeContext({ assets: store });
    const result = okOf(await runSearch({ limit: 2 }, ctx));
    expect(queries).toEqual([{ query: "", limit: 2 }]);
    const payload = JSON.parse(result.summary) as { assets: unknown[] };
    expect(payload.assets).toHaveLength(2);
    expect(result.warnings?.[0]).toContain("Showing 2 of 9");
  });

  it("keeps the summary under the compact-reply cap", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      asset({
        assetId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        filename: `a-very-long-asset-filename-${String(i).padStart(3, "0")}.png`,
      }),
    );
    const { store } = makeAssets(many);
    const ctx = makeFakeContext({ assets: store });
    const result = okOf(await runSearch({}, ctx));
    expect(result.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    const payload = JSON.parse(result.summary) as { assets: unknown[] };
    expect(payload.assets.length).toBeLessThan(DEFAULT_RESULTS);
    expect(result.warnings?.[0]).toMatch(/Showing \d+ of 30 matching assets/);
  });

  it("an empty library returns an empty table without warnings", async () => {
    const { store } = makeAssets([]);
    const ctx = makeFakeContext({ assets: store });
    const result = okOf(await runSearch({ query: "nothing" }, ctx));
    expect(result.summary).toBe('{"assets":[]}');
    expect(result.warnings).toBeUndefined();
  });

  it("schema is strict: caps, kinds and unknown keys are rejected", () => {
    const reject = (raw: unknown) => errOf(runSearch(raw) as unknown as ToolResult);
    // runSearch is async; parseToolArgs is sync, so test the schema directly:
    const parse = (raw: unknown) => parseToolArgs(assetSearchTool, raw);
    expect(parse({ query: "x".repeat(121) }).ok).toBe(false);
    expect(parse({ kind: "video" }).ok).toBe(false);
    expect(parse({ limit: 121 }).ok).toBe(false);
    expect(parse({ limit: 0 }).ok).toBe(false);
    expect(parse({ limit: 2.5 }).ok).toBe(false);
    expect(parse({ extra: 1 }).ok).toBe(false);
    const good = parse({ query: "sunset", limit: 5 });
    expect(good.ok).toBe(true);
    expect(reject).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// computeFit — pure fit/focal math (§7.3)
// ---------------------------------------------------------------------------

describe("computeFit", () => {
  const base = { boxX: 10, boxY: 20, boxW: 100, boxH: 50 } as const;
  const cases: {
    name: string;
    input: Parameters<typeof computeFit>[0];
    expect: {
      scaleX: number;
      scaleY: number;
      dx: number;
      dy: number;
      scalePercent: number;
      isIdentity: boolean;
    };
  }[] = [
    {
      name: "cover crops the overflowing axis (centred focal)",
      input: { ...base, boxW: 400, boxH: 300, assetW: 800, assetH: 600, fit: "cover", focalX: 0.5, focalY: 0.5 },
      expect: { scaleX: 0.5, scaleY: 0.5, dx: 0, dy: 0, scalePercent: 50, isIdentity: false },
    },
    {
      name: "cover focal x=1 shows the right edge (dx shifts left)",
      input: { ...base, boxW: 100, boxH: 100, assetW: 200, assetH: 50, fit: "cover", focalX: 1, focalY: 0.5 },
      expect: { scaleX: 2, scaleY: 2, dx: -150, dy: 0, scalePercent: 200, isIdentity: false },
    },
    {
      name: "contain letterboxes (min) and focal y=1 bottom-aligns",
      input: { ...base, boxW: 100, boxH: 100, assetW: 200, assetH: 50, fit: "contain", focalX: 0.5, focalY: 1 },
      expect: { scaleX: 0.5, scaleY: 0.5, dx: 0, dy: 37.5, scalePercent: 50, isIdentity: false },
    },
    {
      name: "fill stretches per axis to the exact box",
      input: { ...base, boxW: 100, boxH: 50, assetW: 200, assetH: 200, fit: "fill", focalX: 0.5, focalY: 0.5 },
      expect: { scaleX: 0.5, scaleY: 0.25, dx: 0, dy: 0, scalePercent: 50, isIdentity: false },
    },
    {
      name: "an exact fit is the identity transform",
      input: { ...base, boxW: 800, boxH: 600, assetW: 800, assetH: 600, fit: "contain", focalX: 0.5, focalY: 0.5 },
      expect: { scaleX: 1, scaleY: 1, dx: 0, dy: 0, scalePercent: 100, isIdentity: true },
    },
    {
      name: "a focal shift alone is not the identity",
      input: { ...base, boxW: 100, boxH: 100, assetW: 100, assetH: 200, fit: "cover", focalX: 0.3, focalY: 0.8 },
      expect: { scaleX: 1, scaleY: 1, dx: 0, dy: -30, scalePercent: 100, isIdentity: false },
    },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const plan = computeFit(testCase.input);
      expect(plan.scaleX).toBeCloseTo(testCase.expect.scaleX, 10);
      expect(plan.scaleY).toBeCloseTo(testCase.expect.scaleY, 10);
      expect(plan.dx).toBeCloseTo(testCase.expect.dx, 10);
      expect(plan.dy).toBeCloseTo(testCase.expect.dy, 10);
      expect(plan.scalePercent).toBe(testCase.expect.scalePercent);
      expect(plan.isIdentity).toBe(testCase.expect.isIdentity);
    });
  }
  it("doc.place centre is the destination box centre", () => {
    const plan = computeFit({ boxX: 10, boxY: 20, boxW: 100, boxH: 50, assetW: 10, assetH: 10, fit: "fill", focalX: 0.5, focalY: 0.5 });
    expect(plan.placeCenterX).toBe(60);
    expect(plan.placeCenterY).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// isPlaceableAssetPath — capability-root guard (§25 rule 6, keys.ts key space)
// ---------------------------------------------------------------------------

describe("isPlaceableAssetPath", () => {
  it("accepts only relative keys under this workspace's asset prefix", () => {
    expect(isPlaceableAssetPath(`assets/organizations/${ORG}/assets/${ASSET_ID}`, ORG)).toBe(true);
    expect(isPlaceableAssetPath(`assets/organizations/${ORG}/assets/${ASSET_ID}/original.png`, ORG)).toBe(true);
    expect(isPlaceableAssetPath(`assets/organizations/${ORG}/assets/${ASSET_ID}`, "org_other")).toBe(false);
    expect(isPlaceableAssetPath("/etc/passwd", ORG)).toBe(false);
    expect(isPlaceableAssetPath("https://cdn.example.com/logo.png", ORG)).toBe(false);
    expect(isPlaceableAssetPath(`assets/organizations/${ORG}/assets/../../secrets`, ORG)).toBe(false);
    expect(isPlaceableAssetPath(`assets\\organizations\\${ORG}\\assets\\x`, ORG)).toBe(false);
    expect(isPlaceableAssetPath(`assets/organizations/${ORG}/assets/\u0007bad`, ORG)).toBe(false);
    expect(isPlaceableAssetPath(`${"long".repeat(300)}`, ORG)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// asset_place
// ---------------------------------------------------------------------------

describe("asset_place", () => {
  it("places into a named layer: doc.place + edit.transform + smart-object convert", async () => {
    const { ctx, state } = placeCtx({ layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 300 })] });
    const result = okOf(await runPlace(placeArgs(), ctx));
    expect(state.batches).toHaveLength(1);
    const [place, transform] = state.batches[0] ?? [];
    expect(place).toEqual({
      id: "doc.place",
      params: { path: `assets/organizations/${ORG}/assets/${ASSET_ID}`, scale: 100, center: [200, 150], smartObject: true },
    });
    expect(transform).toEqual({
      id: "edit.transform",
      params: { scaleX: 50, scaleY: 50, dx: 0, dy: 0 },
    });
    expect(state.executes).toEqual([
      { id: "layer.smartObjects.convertToSmartObject", params: { layer: "L99" } },
    ]);
    const payload = JSON.parse(result.summary) as { placed: Record<string, unknown> };
    expect(payload.placed).toEqual({ assetId: ASSET_ID, layerId: "L99", fit: "cover", scalePercent: 50 });
    expect(result.documentRevision).toBe(3);
    expect(result.warnings).toBeUndefined();
  });

  it("skips edit.transform when the plan is the identity", async () => {
    const { ctx, state } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 800, h: 600 })],
      assets: [asset({ widthPx: 800, heightPx: 600 })],
    });
    const result = okOf(await runPlace(placeArgs({ fit: "contain" }), ctx));
    expect(state.batches[0]).toHaveLength(1);
    expect(state.batches[0]?.[0]?.id).toBe("doc.place");
    const payload = JSON.parse(result.summary) as { placed: { scalePercent: number } };
    expect(payload.placed.scalePercent).toBe(100);
    expect(result.documentRevision).toBe(3);
  });

  it("focal shifts a cover placement without upscaling", async () => {
    const { ctx, state } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      assets: [asset({ widthPx: 1200, heightPx: 300 })],
    });
    const result = okOf(await runPlace(placeArgs({ focal: { x: 0, y: 0.5 } }), ctx));
    const transform = state.batches[0]?.[1];
    expect(transform?.id).toBe("edit.transform");
    expect(transform?.params).toEqual({ scaleX: 100, scaleY: 100, dx: 400, dy: 0 });
    expect(result.warnings).toBeUndefined();
  });

  it("upscale past 200% is refused before any mutation (§7.3)", async () => {
    const { ctx, state } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 800, h: 600 })],
      assets: [asset({ widthPx: 200, heightPx: 200 })],
    });
    const failure = errOf(await runPlace(placeArgs(), ctx));
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("200%");
    expect(state.batches).toHaveLength(0);
    expect(state.executes).toHaveLength(0);
  });

  it("upscale thresholds: 200% allowed with a warning, 125% allowed silently", async () => {
    const at200 = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 400 })],
      assets: [asset({ widthPx: 200, heightPx: 200 })],
    });
    const result200 = okOf(await runPlace(placeArgs(), at200.ctx));
    expect(result200.warnings?.[0]).toContain("200%");

    const at125 = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 250, h: 250 })],
      assets: [asset({ widthPx: 200, heightPx: 200 })],
    });
    const result125 = okOf(await runPlace(placeArgs(), at125.ctx));
    expect(result125.warnings).toBeUndefined();

    const at126 = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 251, h: 251 })],
      assets: [asset({ widthPx: 200, heightPx: 200 })],
    });
    const result126 = okOf(await runPlace(placeArgs(), at126.ctx));
    expect(result126.warnings?.[0]).toContain("125%");
  });

  it("an ambiguous layer name lists candidates (§6.1)", async () => {
    const { ctx } = placeCtx({ layers: [layer("L1", "Photo", { x: 0, y: 0, w: 10, h: 10 }), layer("L2", "Photo")] });
    const failure = errOf(await runPlace(placeArgs(), ctx));
    expect(failure.code).toBe("ambiguous_layer");
    expect(failure.hint).toContain("L1");
    expect(failure.hint).toContain("L2");
  });

  it("unknown layer ids and names are not_found", async () => {
    const byId = placeCtx({ layers: [layer("L1", "Photo", { x: 0, y: 0, w: 10, h: 10 })] });
    expect(errOf(await runPlace(placeArgs({ target: { layer: { layerId: "L404" } } }), byId.ctx)).code).toBe(
      "layer_not_found",
    );
    const byName = placeCtx({ layers: [] });
    expect(errOf(await runPlace(placeArgs(), byName.ctx)).code).toBe("layer_not_found");
  });

  it("unknown assets list candidate ids from the library", async () => {
    const other = asset({
      assetId: "00000000-0000-4000-8000-000000000009",
      filename: "beach.png",
    });
    const state: EngineState = { layers: [], batches: [], executes: [], revision: 1 };
    const { store } = makeAssets([other]);
    const ctx = makeFakeContext({ engine: makeEngine(state), assets: store });
    const failure = errOf(await runPlace(placeArgs({ asset_id: "00000000-0000-4000-8000-ffffffffffff" }), ctx));
    expect(failure.code).toBe("not_found");
    expect(failure.hint).toContain("00000000-0000-4000-8000-000000000009");
    expect(failure.hint).toContain("beach.png");
    expect(state.batches).toHaveLength(0);
  });

  it("cross-tenant assets are refused (§15.1)", async () => {
    const { ctx } = placeCtx({ assets: [asset({ organizationId: "org_ffffffff-0000-4000-8000-000000000000" })] });
    const failure = errOf(await runPlace(placeArgs(), ctx));
    expect(failure.code).toBe("cross_tenant_denied");
    expect(failure.retryable).toBe(false);
  });

  it("storage locations outside the workspace asset key space never reach the engine", async () => {
    const { ctx, state } = placeCtx({ assets: [asset({ storageUrl: "/tmp/absolute.png" })] });
    const failure = errOf(await runPlace(placeArgs(), ctx));
    expect(failure.code).toBe("invalid_args");
    expect(state.batches).toHaveLength(0);
  });

  it("resolves slots through the template layer map (§7.2)", async () => {
    const { ctx, state } = placeCtx({
      layers: [layer("L7", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      manifests: [
        manifest("instagram-post", "3", { photo: { kind: "image" }, headline: { kind: "text" } }, { photo: "Photo" }),
      ],
    });
    const result = okOf(await runPlace(placeArgs({ target: { slot: "photo" } }), ctx));
    expect(state.batches[0]?.[0]?.id).toBe("doc.place");
    const payload = JSON.parse(result.summary) as { placed: { layerId: string; scalePercent: number } };
    expect(payload.placed.layerId).toBe("L99");
    expect(payload.placed.scalePercent).toBe(50);
  });

  it("unknown slots, text slots and missing mapped layers are typed errors", async () => {
    const base = {
      layers: [layer("L7", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      manifests: [manifest("instagram-post", "3", { photo: { kind: "image" }, headline: { kind: "text" } }, { photo: "Photo" })],
    };
    const unknown = placeCtx(base);
    const unknownResult = errOf(await runPlace(placeArgs({ target: { slot: "logo" } }), unknown.ctx));
    expect(unknownResult.code).toBe("unknown_slots");
    expect(unknownResult.hint).toContain("photo");

    const text = placeCtx(base);
    const textResult = errOf(await runPlace(placeArgs({ target: { slot: "headline" } }), text.ctx));
    expect(textResult.code).toBe("invalid_slots");

    const missing = placeCtx({
      ...base,
      manifests: [manifest("instagram-post", "3", { photo: { kind: "image" } }, { photo: "Ghost" })],
    });
    const missingResult = errOf(await runPlace(placeArgs({ target: { slot: "photo" } }), missing.ctx));
    expect(missingResult.code).toBe("layer_not_found");
    expect(missingResult.hint).toContain('instagram-post@3:photo→"Ghost"');
  });

  it("a slot resolving to several layers is ambiguous with candidates", async () => {
    const { ctx } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 10, h: 10 }), layer("L2", "Hero", { x: 0, y: 0, w: 10, h: 10 })],
      manifests: [
        manifest("instagram-post", "3", { photo: { kind: "image" } }, { photo: "Photo" }),
        manifest("presentation-slide", "1", { photo: { kind: "image" } }, { photo: "Hero" }),
      ],
    });
    const failure = errOf(await runPlace(placeArgs({ target: { slot: "photo" } }), ctx));
    expect(failure.code).toBe("ambiguous_layer");
    expect(failure.hint).toContain("Photo (L1)");
    expect(failure.hint).toContain("Hero (L2)");
  });

  it("explicit bounds override the target layer's box", async () => {
    const { ctx, state } = placeCtx({ layers: [layer("L1", "Photo", { x: 0, y: 0, w: 4000, h: 3000 })] });
    const result = okOf(await runPlace(placeArgs({ target: { layer: { layerName: "Photo" }, bounds: [10, 10, 100, 100] } }), ctx));
    expect(state.batches[0]?.[0]?.params).toEqual({
      path: `assets/organizations/${ORG}/assets/${ASSET_ID}`,
      scale: 100,
      center: [60, 60],
      smartObject: true,
    });
    const transform = state.batches[0]?.[1];
    expect(transform?.id).toBe("edit.transform");
    expect(transform?.params?.scaleX).toBeCloseTo((100 / 600) * 100, 10);
    expect(transform?.params?.scaleY).toBeCloseTo((100 / 800) * 100, 10);
    const payload = JSON.parse(result.summary) as { placed: { scalePercent: number } };
    expect(payload.placed.scalePercent).toBe(17);
  });

  it("places into a free bounds box with no target layer", async () => {
    const { ctx } = placeCtx();
    const result = okOf(await runPlace(placeArgs({ target: { bounds: [0, 0, 400, 300] } }), ctx));
    const payload = JSON.parse(result.summary) as { placed: { layerId: string } };
    expect(payload.placed.layerId).toBe("L99");
    expect(result.ok).toBe(true);
  });

  it("unrecorded asset dimensions place at 100% with a warning", async () => {
    const { ctx, state } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      assets: [asset({ widthPx: undefined, heightPx: undefined })],
    });
    const result = okOf(await runPlace(placeArgs({ fit: "cover" }), ctx));
    expect(state.batches[0]).toHaveLength(1);
    const payload = JSON.parse(result.summary) as { placed: { scalePercent: number } };
    expect(payload.placed.scalePercent).toBe(100);
    expect(result.warnings?.[0]).toContain("dimensions are not recorded");
  });

  it("engine batch failures mirror the engine's sanitized code", async () => {
    const { ctx } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      engine: {
        batchFailure: { ok: false, code: "engine_unavailable", message: "no session", retryable: true },
      },
    });
    const failure = errOf(await runPlace(placeArgs(), ctx));
    expect(failure.code).toBe("engine_unavailable");
    expect(failure.message).toBe("no session");
    expect(failure.retryable).toBe(true);
  });

  it("an exhausted budget stops before mutating (§5.2)", async () => {
    const { ctx, state } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      budgets: EXHAUSTED_BUDGETS,
    });
    const failure = errOf(await runPlace(placeArgs(), ctx));
    expect(failure.code).toBe("budget_exceeded");
    expect(state.batches).toHaveLength(0);
    expect(state.executes).toHaveLength(0);
  });

  it("smart-object conversion failure is a warning, not an error", async () => {
    const { ctx } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      engine: { executeFailure: { ok: false, code: "engine_unavailable", message: "already a smart object" } },
    });
    const result = okOf(await runPlace(placeArgs(), ctx));
    expect(result.warnings?.[0]).toContain("Smart-object conversion did not apply");
    expect(result.documentRevision).toBe(2);
    const payload = JSON.parse(result.summary) as { placed: { layerId: string } };
    expect(payload.placed.layerId).toBe("L99");
  });

  it("an unconfirmable layer diff degrades to a warning and skips the convert", async () => {
    const { ctx, state } = placeCtx({
      layers: [layer("L1", "Photo", { x: 0, y: 0, w: 400, h: 300 })],
      engine: { listFailureAfterBatch: true },
    });
    const result = okOf(await runPlace(placeArgs(), ctx));
    expect(result.warnings?.[0]).toContain("could not be confirmed");
    expect(state.executes).toHaveLength(0);
    const payload = JSON.parse(result.summary) as { placed: { layerId: string | null } };
    expect(payload.placed.layerId).toBeNull();
    expect(result.documentRevision).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Schema strictness (§6.1) and registry pinning
// ---------------------------------------------------------------------------

describe("asset_place schema (§6.1 strict)", () => {
  const parse = (raw: unknown) => parseToolArgs(assetPlaceTool, raw);

  it("requires a uuid asset id and an idempotency key", () => {
    expect(parse(placeArgs({ asset_id: "not-a-uuid" })).ok).toBe(false);
    expect(parse(placeArgs({ idempotency_key: "" })).ok).toBe(false);
    expect(parse(placeArgs({ idempotency_key: "short" })).ok).toBe(false);
    expect(parse({ ...placeArgs(), idempotency_key: undefined }).ok).toBe(false);
  });

  it("target takes slot or layer — never both, never none without bounds", () => {
    const both = parse(placeArgs({ target: { slot: "photo", layer: { layerName: "Photo" } } }));
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.hint).toContain("not both");
    }
    expect(parse(placeArgs({ target: {} })).ok).toBe(false);
    expect(parse(placeArgs({ target: { bounds: [0, 0, 10, 10] } })).ok).toBe(true);
  });

  it("bounds reject zero sizes, negatives, NaN and Infinity", () => {
    expect(parse(placeArgs({ target: { bounds: [0, 0, 0, 100] } })).ok).toBe(false);
    expect(parse(placeArgs({ target: { bounds: [-1, 0, 100, 100] } })).ok).toBe(false);
    expect(parse(placeArgs({ target: { bounds: [Number.NaN, 0, 100, 100] } })).ok).toBe(false);
    expect(parse(placeArgs({ target: { bounds: [Number.POSITIVE_INFINITY, 0, 100, 100] } })).ok).toBe(false);
    expect(parse(placeArgs({ target: { bounds: [0, 0, 300001, 100] } })).ok).toBe(false);
    expect(parse(placeArgs({ target: { bounds: [0, 0, 100] } })).ok).toBe(false);
  });

  it("focal is 0..1 per axis; fit and layer refs are closed sets", () => {
    expect(parse(placeArgs({ focal: { x: 1.5, y: 0.5 } })).ok).toBe(false);
    expect(parse(placeArgs({ focal: { x: 0.5, y: Number.NaN } })).ok).toBe(false);
    expect(parse(placeArgs({ fit: "stretch" })).ok).toBe(false);
    expect(parse(placeArgs({ target: { layer: { layerId: "L1", layerName: "Photo" } } })).ok).toBe(false);
    expect(parse(placeArgs({ target: { layer: "Photo" } })).ok).toBe(false);
  });

  it("unknown keys are rejected (additionalProperties: false)", () => {
    expect(parse(placeArgs({ extra: true })).ok).toBe(false);
    expect(parse({ ...placeArgs(), target: { slot: "photo", bounds: [0, 0, 10, 10] } }).ok).toBe(true);
  });

  it("both tools register against the pinned §6 surface", () => {
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(assetSearchTool as AnyTool)).toEqual({ ok: true });
    expect(registry.register(assetPlaceTool as AnyTool)).toEqual({ ok: true });
    expect(registry.get("asset_place").ok).toBe(true);
    expect(assetSearchTool.name).toBe("asset_search");
    expect(assetPlaceTool.name).toBe("asset_place");
  });
});

// compactAssetTable: the trim loop never emits an over-cap summary.
describe("compactAssetTable trim", () => {
  it("drops rows (never fields) until the summary fits", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: "a-really-long-asset-filename.png",
      width: 4000,
      height: 3000,
      kind: "image",
    })).map((row) => toAssetRow(asset(row)));
    const { summary, shown } = compactAssetTable(rows);
    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(shown).toBeLessThan(40);
    const payload = JSON.parse(summary) as { assets: { id: string; name: string }[] };
    expect(payload.assets[0]?.id).toBe(rows[0]?.id);
  });
});
