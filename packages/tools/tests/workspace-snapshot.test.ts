// workspace-snapshot.test.ts — §6 row 1 / §5.4 contract: compaction, budget,
// stable ordering, degradation, and the engine error mapping table. Fake engine
// fixtures mirror the pinned vendor reply shapes (inspect.rs layer rows with
// hostile extras, layer.list, variables.list, layerComp.list) — no network.

import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS } from "../src/registry.js";
import type {
  DbDocumentRef,
  DbLike,
  EngineCommand,
  EngineCommandReport,
  EngineDocumentSnapshot,
  EngineFailure,
  EngineLayerSummary,
  EngineLike,
  EngineOutcome,
  ToolContext,
  ToolErr,
  ToolOk,
  ToolResult,
} from "../src/types.js";
import {
  MAX_RECENT_RUNS,
  SNAPSHOT_SUMMARY_BUDGET_CHARS,
  commandPayload,
  compareLayerIds,
  compactLayer,
  summarizeSnapshot,
  workspaceSnapshot,
  type SnapshotSections,
} from "../src/tools/workspace-snapshot.js";
import { abortedSignal, freshSignal, makeFakeContext } from "./fakes.js";

const DOC_ID = "11111111-2222-4333-8444-555555555555";

const success = <T>(value: T): EngineOutcome<T> => ({ ok: true, value });

function engineFailure(code: ToolErr["code"], message: string): EngineFailure {
  return { ok: false, code, message };
}

/** Runtime extras beyond the minimal seam types (engine rows are richer). */
function hostileRow(): EngineLayerSummary {
  const hostile = {
    opacity: 0.35,
    pixels: `${"ABCD".repeat(60)}+==`,
    thumbnail: `data:image/png;base64,${"iVBORw0KGgo".repeat(16)}`,
    smartSource: { kind: "linked", path: "/home/z/tenant-a/assets/logo.psd" },
    smartContents: { id: 987654321, instances: 2 },
    labelColor: "red",
    effects: { enabled: true, items: [{ kind: "dropShadow", enabled: true }] },
    video: { frames: 3, fps: 30, source: { file: "/mnt/private/render.mp4" } },
  };
  const base: Record<string, unknown> = {
    layerId: "9",
    name: "Art /srv/assets/headline v2",
    kind: "Raster",
    visible: true,
    bounds: { x: 9, y: 0, width: 100, height: 40 },
    ...hostile,
  };
  return base as unknown as EngineLayerSummary;
}

function layerRow(id: number, over: Record<string, unknown> = {}): EngineLayerSummary {
  const base: Record<string, unknown> = {
    layerId: String(id),
    name: `Layer ${id}`,
    kind: "Raster",
    visible: true,
    bounds: { x: id, y: 0, width: 100, height: 40 },
    ...over,
  };
  return base as unknown as EngineLayerSummary;
}

/** A vendor-shaped row: numeric `id` (layer_list_cmds.rs) + `[x0,y0,w,h]` bounds. */
function vendorRow(): EngineLayerSummary {
  const base: Record<string, unknown> = {
    id: 12,
    name: "Vendor row",
    kind: "Group",
    visible: true,
    bounds: [5, 6, 700, 80],
    childCount: 2,
  };
  return base as unknown as EngineLayerSummary;
}

/** A row with no id at all — malformed, skipped with a warning. */
function malformedRow(): EngineLayerSummary {
  return { name: "Ghost", kind: "Raster" } as unknown as EngineLayerSummary;
}

const HAPPY_ROWS: readonly EngineLayerSummary[] = [
  layerRow(10, { name: "Photo main", kind: "SmartObject" }),
  hostileRow(),
  layerRow(3, { name: "Headline", kind: "Text", opacity: 0.85 }),
  layerRow(2, {
    name: "Hero Group",
    kind: "Group",
    childCount: 2,
    bounds: { x: 0, y: 0, width: 1080, height: 400 },
  }),
  vendorRow(),
  layerRow(1, { name: "Background", kind: "Raster", visible: false, bounds: null }),
  malformedRow(),
];

function baseSnapshot(extras: Record<string, unknown> = {}): EngineDocumentSnapshot {
  const base: Record<string, unknown> = {
    revision: 7,
    widthPx: 1080,
    heightPx: 1350,
    layers: [layerRow(1), layerRow(2), layerRow(3)],
    name: "promo-1080x1350",
    path: "/srv/workspaces/tenant-a/promo.pcraft",
    layerComps: [
      { id: 2, name: "Instagram" },
      { id: 1, name: "Print" },
    ],
    variables: { defs: [{ name: "headline", layer: 3 }], dataSets: ["default", "sale"], active: 0 },
    fonts: ["Inter", "Serif Engine"],
    ...extras,
  };
  return base as unknown as EngineDocumentSnapshot;
}

/** `variables.list` reply (variables_cmds.rs) — JSON-serialized into `message`. */
const VARIABLES_MESSAGE: EngineCommandReport = {
  revision: 7,
  message: JSON.stringify({
    defs: [
      { name: "headline", layer: 3, type: "textReplacement", method: "fit" },
      { name: "showBadge", layer: 9, type: "visibility" },
    ],
    dataSets: [
      { name: "default", values: [{ variable: "headline", kind: "text", value: "leaky" }] },
      { name: "sale", values: [] },
    ],
    active: 0,
  }),
};

/** `layerComp.list` reply (comps_cmds.rs) — attached under `result`. */
const COMPS_RESULT: EngineCommandReport = {
  revision: 7,
  result: {
    comps: [
      {
        id: 2,
        name: "Instagram",
        comment: "check safe margins before export",
        visibility: true,
        position: true,
        appearance: true,
        layers: 12,
        missingLayers: 1,
      },
      { id: 1, name: "Print A4", comment: "legacy", visibility: true },
    ],
    lastApplied: 2,
    hasLastDocumentState: false,
  },
} as unknown as EngineCommandReport;

interface EngineScript {
  inspect?: () => Promise<EngineOutcome<EngineDocumentSnapshot>>;
  listLayers?: () => Promise<EngineOutcome<readonly EngineLayerSummary[]>>;
  execute?: (cmd: EngineCommand) => Promise<EngineOutcome<EngineCommandReport>>;
}

function makeEngine(script: EngineScript = {}): EngineLike {
  return {
    inspect: script.inspect ?? (async () => success(baseSnapshot())),
    listLayers: script.listLayers ?? (async () => success([])),
    execute: script.execute ?? (async () => success({ revision: 7 })),
    render: async () => success({ image: new Uint8Array(), widthPx: 64, heightPx: 64 }),
    batch: async () => success({ revision: 7, outcomes: [] }),
  };
}

/** The scripted happy-path engine: layer.list rows + variables/comps commands. */
function scriptedEngine(options: { rows?: readonly EngineLayerSummary[] } = {}): {
  engine: EngineLike;
  executed: EngineCommand[];
} {
  const executed: EngineCommand[] = [];
  const engine = makeEngine({
    listLayers: async () => success(options.rows ?? HAPPY_ROWS),
    execute: async (cmd) => {
      executed.push(cmd);
      if (cmd.id === "variables.list") return success(VARIABLES_MESSAGE);
      if (cmd.id === "layerComp.list") return success(COMPS_RESULT);
      return success({ revision: 7 });
    },
  });
  return { engine, executed };
}

const TEMPLATE_ROWS = [
  {
    id: "menu-a4",
    version: "1.0.0",
    title: "Menu A4",
    tags: ["menu", "a4", "print", "discardme"],
    slotCount: 4,
  },
  { id: "ig-square", version: "2.1.0", title: "IG Square", tags: ["social"], slotCount: 6 },
];

const RUN_ROWS: readonly unknown[] = [
  { runId: "run-1", status: "succeeded", createdAt: "2026-01-01T00:00:00Z" },
  { runId: "run-2", status: "failed", createdAt: "2026-01-02T00:00:00Z" },
  { runId: "run-3", status: "succeeded", createdAt: "2026-01-03T00:00:00Z" },
  { runId: "run-4", status: "cancelled", createdAt: "2026-01-04T00:00:00Z" },
  { runId: "run-5", status: "running", createdAt: "2026-01-05T00:00:00Z" },
  { runId: "run-6", status: "queued", createdAt: "2026-01-06T00:00:00Z" },
  { runId: "run-7", status: "queued", createdAt: new Date("2026-01-07T00:00:00Z") },
];

const WORKSPACE = {
  organizationId: "org_00000000-0000-0000-0000-000000000000",
  brandTokens: {
    palette: { ink: "#3B2A20", paper: "#F4E7D3", accent: "#D96C3B" },
    fonts: ["Display", "Inter"],
  },
};

interface DbWithRuns extends DbLike {
  listRuns?(documentId: string, options?: { limit?: number }): Promise<readonly unknown[]>;
}

function makeDb(withRuns: boolean, calls?: unknown[][]): DbWithRuns {
  return {
    getDocument: async (): Promise<DbDocumentRef | undefined> => undefined,
    appendCommandLog: async (): Promise<void> => undefined,
    ...(withRuns
      ? {
          listRuns: async (documentId: string, options?: { limit?: number }) => {
            calls?.push([documentId, options]);
            return RUN_ROWS;
          },
        }
      : {}),
  };
}

function recordingLogger(): { logger: ToolContext["logger"]; debugs: [string, unknown][] } {
  const debugs: [string, unknown][] = [];
  return {
    debugs,
    logger: {
      debug: (message: string, fields?: Readonly<Record<string, unknown>>) => {
        debugs.push([message, fields ?? {}]);
      },
      info() {},
      warn() {},
      error() {},
    },
  };
}

function makeCtx(parts: {
  engine: EngineLike;
  db?: DbWithRuns;
  templates?: ToolContext["templates"];
  logger?: ToolContext["logger"];
}): ToolContext {
  return makeFakeContext({
    engine: parts.engine,
    db: parts.db ?? makeDb(false),
    templates:
      parts.templates ?? { get: async () => undefined, list: async () => TEMPLATE_ROWS },
    workspace: WORKSPACE,
    ...(parts.logger !== undefined ? { logger: parts.logger } : {}),
  });
}

function parseSummary(summary: string): Record<string, unknown> {
  return JSON.parse(summary) as Record<string, unknown>;
}

function layersOf(summary: string): Record<string, unknown>[] {
  return (parseSummary(summary).layers ?? []) as Record<string, unknown>[];
}

async function runTool(ctx: ToolContext, args = { documentId: DOC_ID }): Promise<ToolResult> {
  return workspaceSnapshot.run(ctx, args, freshSignal());
}

/** Fresh happy-path fixture per test (spies must not leak between tests). */
function happyFixture(options: { rows?: readonly EngineLayerSummary[] } = {}): {
  ctx: ToolContext;
  executed: EngineCommand[];
  listRunsCalls: unknown[][];
  debugs: [string, unknown][];
} {
  const { engine, executed } = scriptedEngine(options);
  const listRunsCalls: unknown[][] = [];
  const { logger, debugs } = recordingLogger();
  const ctx = makeCtx({ engine, db: makeDb(true, listRunsCalls), logger });
  return { ctx, executed, listRunsCalls, debugs };
}

// ---------------------------------------------------------------------------
// Args + tool metadata (§6.1 strict schema)
// ---------------------------------------------------------------------------

describe("workspace_snapshot args (§6.1 strict)", () => {
  it("is pinned to the §6 surface with a uuid documentId", () => {
    expect(workspaceSnapshot.name).toBe(TOOLS.workspace_snapshot);
    expect(workspaceSnapshot.description.length).toBeGreaterThan(10);
    const parsed = parseToolArgs(workspaceSnapshot, { documentId: DOC_ID });
    expect(parsed.ok).toBe(true);
  });

  it("rejects non-uuid ids, non-strings, missing ids, and unknown keys", () => {
    const bad: unknown[] = [
      { documentId: "not-a-uuid" },
      { documentId: "" },
      { documentId: 123 },
      {},
      { documentId: DOC_ID, extra: true },
    ];
    for (const raw of bad) {
      const parsed = parseToolArgs(workspaceSnapshot, raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("invalid_args");
    }
  });

  it("reports the failing path in the hint, never the value", () => {
    const parsed = parseToolArgs(workspaceSnapshot, { documentId: "nope" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.hint).toContain("documentId");
  });
});

// ---------------------------------------------------------------------------
// Happy path: §5.4 compaction over fake engine fixture replies
// ---------------------------------------------------------------------------

describe("workspace_snapshot compaction (§5.4)", () => {
  it("returns an ok envelope the kit schema accepts", async () => {
    const { ctx } = happyFixture();
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    expect(isToolResult(result)).toBe(true);
    if (!result.ok) return;
    const okResult = result as ToolOk;
    expect(okResult.documentRevision).toBe(7);
    expect(okResult.summary.length).toBeLessThanOrEqual(SNAPSHOT_SUMMARY_BUDGET_CHARS);
    expect(okResult.summary.startsWith('{"canvas":')).toBe(true);
  });

  it("issues exactly the registry-verified commands and no raw ids leak (§6)", async () => {
    const { ctx, executed } = happyFixture();
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    expect(executed.map((cmd) => cmd.id).sort()).toEqual(["layerComp.list", "variables.list"]);
    for (const cmd of executed) expect(cmd.params).toEqual({});
    if (result.ok) {
      expect(result.summary).not.toContain("variables.list");
      expect(result.summary).not.toContain("layerComp.list");
      expect(result.summary).not.toContain("document.inspect");
      expect(result.summary).not.toContain("layer.list");
    }
  });

  it("compacts the layer tree to id/name/kind/bounds/visible/opacity, ids sorted", async () => {
    const { ctx } = happyFixture();
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = layersOf(result.summary);
    expect(rows.map((row) => row.id)).toEqual(["1", "2", "3", "9", "10", "12"]);
    const allowed = new Set(["id", "name", "kind", "visible", "opacity", "bounds", "childCount"]);
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
    }
    // Defensive reads pinned: numeric vendor `id`, `[x0,y0,w,h]` bounds, opacity.
    expect(rows[5]).toEqual({
      id: "12",
      name: "Vendor row",
      kind: "Group",
      visible: true,
      bounds: { x: 5, y: 6, width: 700, height: 80 },
      childCount: 2,
    });
    expect(rows[3]).toEqual({
      id: "9",
      name: "Art <path> v2", // §6.1: the path embedded in the name was scrubbed
      kind: "Raster",
      visible: true,
      opacity: 0.35,
      bounds: { x: 9, y: 0, width: 100, height: 40 },
    });
    expect(rows[2]).toEqual({
      id: "3",
      name: "Headline",
      kind: "Text",
      visible: true,
      opacity: 0.85,
      bounds: { x: 3, y: 0, width: 100, height: 40 },
    });
    expect(rows[0]).toEqual({ id: "1", name: "Background", kind: "Raster", visible: false });
    expect(rows[1]).toEqual({
      id: "2",
      name: "Hero Group",
      kind: "Group",
      visible: true,
      childCount: 2,
      bounds: { x: 0, y: 0, width: 1080, height: 400 },
    });
  });

  it("never leaks pixel data, absolute paths, internal ids, or the doc path", async () => {
    const { ctx } = happyFixture();
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const forbidden = [
      "/home/",
      "/srv/",
      "/mnt/",
      "data:image",
      "ABCDABCD",
      "iVBORw0KGgo",
      "smartContents",
      "smartSource",
      "labelColor",
      "dropShadow",
      "render.mp4",
      "tenant-a",
      "promo.pcraft",
      "987654321",
    ];
    for (const needle of forbidden) expect(result.summary).not.toContain(needle);
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes("skipped (no usable id)"))).toBe(true);
    expect(warnings.some((w) => w.includes("stripped 1 path/pixel-data value(s)"))).toBe(true);
  });

  it("compacts variables (names/layers/types; data-set values dropped) and comps", async () => {
    const { ctx } = happyFixture();
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseSummary(result.summary);
    expect(parsed.variables).toEqual({
      defs: [
        { name: "headline", layer: "3", type: "textReplacement" },
        { name: "showBadge", layer: "9", type: "visibility" },
      ],
      dataSets: ["default", "sale"],
      active: 0,
    });
    expect(result.summary).not.toContain("leaky");
    expect(result.summary).not.toContain("method");
    expect(parsed.comps).toEqual({
      comps: [
        { id: "1", name: "Print A4" },
        { id: "2", name: "Instagram" },
      ],
      lastApplied: "2",
    });
    expect(result.summary).not.toContain("safe margins");
    expect(result.summary).not.toContain("missingLayers");
  });

  it("carries slots (template summaries), palette, and merged fonts, sorted", async () => {
    const { ctx } = happyFixture();
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseSummary(result.summary);
    expect(parsed.templates).toEqual([
      { ref: "ig-square@2.1.0", title: "IG Square", slots: 6, tags: ["social"] },
      { ref: "menu-a4@1.0.0", title: "Menu A4", slots: 4, tags: ["menu", "a4", "print"] },
    ]);
    expect(result.summary).not.toContain("discardme");
    expect(parsed.palette).toEqual({ accent: "#D96C3B", ink: "#3B2A20", paper: "#F4E7D3" });
    expect(parsed.fonts).toEqual(["Display", "Inter", "Serif Engine"]); // brand + engine, deduped
    expect(parsed.canvas).toEqual({ widthPx: 1080, heightPx: 1350 });
  });

  it("lists optional recent runs newest-first, capped, scoped by documentId", async () => {
    const { ctx, listRunsCalls } = happyFixture();
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    expect(listRunsCalls).toEqual([[DOC_ID, { limit: MAX_RECENT_RUNS }]]);
    if (!result.ok) return;
    const parsed = parseSummary(result.summary);
    const runs = parsed.recentRuns as Record<string, unknown>[];
    expect(runs.map((run) => run.id)).toEqual(["run-7", "run-6", "run-5", "run-4", "run-3"]);
    expect(runs[0]).toEqual({
      id: "run-7",
      status: "queued",
      createdAt: "2026-01-07T00:00:00.000Z",
    });
    expect(result.warnings?.some((w) => w.includes("recent runs limited to 5 of 7"))).toBe(true);
  });

  it("logs count-only breadcrumbs (§22)", async () => {
    const { ctx, debugs } = happyFixture();
    await runTool(ctx);
    const last = debugs[debugs.length - 1] ?? ["", {}];
    expect(last[0]).toBe("workspace_snapshot assembled");
    const fields = last[1] as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      expect(["layerRows", "templateRows", "warningCount", "summaryChars"]).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Stable ordering / determinism (§5.4 cache prefix)
// ---------------------------------------------------------------------------

describe("workspace_snapshot determinism (§5.4)", () => {
  it("produces byte-identical summaries regardless of engine row order", async () => {
    const first = happyFixture();
    const second = happyFixture({ rows: [...HAPPY_ROWS].reverse() });
    const resultA = await runTool(first.ctx);
    const resultB = await runTool(second.ctx);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;
    expect(resultA.summary).toBe(resultB.summary);
    expect(resultA.warnings).toEqual(resultB.warnings);
  });

  it("produces byte-identical summaries across repeated calls", async () => {
    const { ctx } = happyFixture();
    const first = await runTool(ctx);
    const second = await runTool(ctx);
    expect(first).toEqual(second);
  });

  it("compareLayerIds: numeric ids compare numerically, others bytewise", () => {
    expect(compareLayerIds("10", "9")).toBe(1);
    expect(compareLayerIds("2", "10")).toBe(-1);
    expect(compareLayerIds("12", "12")).toBe(0);
    expect(compareLayerIds("a10", "a9")).toBe(-1); // bytewise: "1" < "9"
    expect(compareLayerIds("b", "a")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Token budget enforcement (§5.4 + §6.1 small-reply rule)
// ---------------------------------------------------------------------------

describe("workspace_snapshot budget (§5.4)", () => {
  function monsterRows(count: number): readonly EngineLayerSummary[] {
    const rows: EngineLayerSummary[] = [];
    for (let i = 1; i <= count; i += 1) {
      rows.push(
        layerRow(i, {
          name: `Layer ${i} ${"n".repeat(60)}`,
          kind: "SmartObject",
          bounds: { x: 0, y: 0, width: 1080, height: 1350 },
        }),
      );
    }
    return rows;
  }

  it("truncates a monster document under the kit ceiling with warnings", async () => {
    const { ctx } = happyFixture({ rows: monsterRows(80) });
    const result = await runTool(ctx);
    expect(result.ok).toBe(true); // ok() would throw above the ceiling — never
    if (!result.ok) return;
    expect(result.summary.length).toBeLessThanOrEqual(SNAPSHOT_SUMMARY_BUDGET_CHARS);
    const parsed = parseSummary(result.summary);
    expect((parsed.layers as unknown[]).length).toBeLessThan(80);
    expect(parsed.recentRuns).toBeUndefined(); // shed before the layer tree
    expect(parsed.comps).toBeUndefined();
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes("layer tree limited to first 60 of 80"))).toBe(true);
    expect(warnings.some((w) => w.includes("summary budget: dropped"))).toBe(true);
    expect(warnings.some((w) => w.includes("layer tree truncated to"))).toBe(true);
  });

  it("summarizeSnapshot sheds sections in a fixed order before truncating layers", () => {
    const result = summarizeSnapshot(makeSections(), 300);
    expect(result.summary.length).toBeLessThanOrEqual(300);
    const parsed = parseSummary(result.summary);
    expect(parsed.recentRuns).toBeUndefined();
    expect(parsed.comps).toBeUndefined();
    expect(parsed.variables).toBeUndefined();
    expect(parsed.fonts).toBeDefined();
    expect(parsed.palette).toBeDefined();
    expect(parsed.templates).toBeDefined();
    expect(parsed.layers).toBeDefined();
    expect(result.warnings.some((w) => w.includes("dropped recentRuns, comps, variables"))).toBe(
      true,
    );
  });

  it("summarizeSnapshot binary-searches the largest layer prefix that fits", () => {
    const sections = makeSections({
      layers: [1, 2, 3, 4, 5].map((id) => ({
        id: String(id),
        name: `L${id}`,
        kind: "Raster",
        visible: true,
      })),
      layersTotal: 5,
      templates: undefined,
      palette: undefined,
      fonts: undefined,
      variables: undefined,
      comps: undefined,
      recentRuns: undefined,
    });
    const result = summarizeSnapshot(sections, 300);
    expect(result.summary.length).toBeLessThanOrEqual(300);
    expect(layersOf(result.summary).length).toBe(4);
    expect(result.warnings.some((w) => w.includes("truncated to 4 of 5"))).toBe(true);
  });

  it("summarizeSnapshot hard-clamps as the unreachable last resort", () => {
    const result = summarizeSnapshot(makeSections(), 10);
    expect(result.summary.length).toBeLessThanOrEqual(10);
    expect(result.warnings.some((w) => w.includes("hard-truncated"))).toBe(true);
  });

  it("summarizeSnapshot dedupes and caps warnings at the kit limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const result = summarizeSnapshot(makeSections({ buildWarnings: ["dup", "dup", ...many] }));
    expect(result.warnings.length).toBeLessThanOrEqual(20);
    expect(result.warnings.filter((w) => w === "dup")).toHaveLength(1);
    expect(result.warnings[0]).toBe("dup");
  });
});

// ---------------------------------------------------------------------------
// Degradation policy + the engine error mapping table (§6.1)
// ---------------------------------------------------------------------------

describe("workspace_snapshot error mapping (§6.1)", () => {
  const table: { code: ToolErr["code"]; retryable: boolean }[] = [
    { code: "engine_unavailable", retryable: true },
    { code: "engine_timeout", retryable: true },
    { code: "engine_crashed", retryable: true },
    { code: "rate_limited", retryable: true },
    { code: "provider_unhealthy", retryable: true },
    { code: "storage_error", retryable: false },
    { code: "not_found", retryable: false },
  ];

  it("maps document.inspect failures to err envelopes with hints", async () => {
    for (const row of table) {
      const engine = makeEngine({
        inspect: async () => engineFailure(row.code, "no engine session available"),
      });
      const result = await runTool(makeCtx({ engine }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe(row.code);
      expect(result.retryable).toBe(row.retryable);
      expect(result.message).toContain("no engine session available");
      expect(result.hint).toBeDefined();
      expect(isToolResult(result)).toBe(true);
    }
  });

  it("passes the engine hint through and honors an explicit retryable=false", async () => {
    const engine = makeEngine({
      inspect: async () =>
        ({
          ok: false,
          code: "engine_timeout",
          message: "deadline",
          hint: "Re-open the document from the workspace",
          retryable: false,
        }) as EngineFailure,
    });
    const result = await runTool(makeCtx({ engine }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toBe("Re-open the document from the workspace");
    expect(result.retryable).toBe(false);
  });

  it("converts transport throws on the core read to internal_error without leaks", async () => {
    const engine = makeEngine({
      inspect: async () => {
        throw new Error("BOOM-STACK-SECRET /home/z");
      },
    });
    const result = await runTool(makeCtx({ engine }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("internal_error");
    expect(result.message).not.toContain("BOOM-STACK-SECRET");
    expect(result.message).not.toContain("/home/z");
  });

  it("degrades layer.list failures to the document.inspect rows with a warning", async () => {
    const engine = makeEngine({
      listLayers: async () => engineFailure("engine_timeout", "layer.list timed out"),
    });
    const result = await runTool(makeCtx({ engine }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(layersOf(result.summary).map((row) => row.id)).toEqual(["1", "2", "3"]);
    expect(result.warnings?.some((w) => w.includes("layer.list unavailable (engine_timeout)"))).toBe(
      true,
    );
  });

  it("degrades variables.list and layerComp.list failures to warnings + inspect fallback", async () => {
    const engine = makeEngine({
      execute: async () => engineFailure("engine_unavailable", "session detached"),
    });
    const result = await runTool(makeCtx({ engine }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes("variables unavailable (engine_unavailable)"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("layer comps unavailable (engine_unavailable)"))).toBe(
      true,
    );
    // The document.inspect rows stand in (inspect.rs carries both).
    const parsed = parseSummary(result.summary);
    expect(parsed.variables).toEqual({
      defs: [{ name: "headline", layer: "3" }],
      dataSets: ["default", "sale"],
      active: 0,
    });
    expect(parsed.comps).toEqual({
      comps: [
        { id: "1", name: "Print" },
        { id: "2", name: "Instagram" },
      ],
    });
  });

  it("degrades transport throws on secondary reads to warnings", async () => {
    const engine = makeEngine({
      execute: async () => {
        throw new Error("transport exploded");
      },
    });
    const result = await runTool(makeCtx({ engine }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes("variables unavailable"))).toBe(true);
    expect(warnings.some((w) => w.includes("layer comps unavailable"))).toBe(true);
  });

  it("falls back to the inspect rows when execute carries no payload (minimal adapter)", async () => {
    const result = await runTool(makeCtx({ engine: makeEngine() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseSummary(result.summary);
    expect(parsed.variables).toBeDefined();
    expect(parsed.comps).toBeDefined();
  });

  it("degrades a throwing template catalog to a warning", async () => {
    const ctx = makeCtx({
      engine: makeEngine(),
      templates: {
        get: async () => undefined,
        list: async () => {
          throw new Error("catalog down");
        },
      },
    });
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseSummary(result.summary).templates).toBeUndefined();
    expect(result.warnings?.some((w) => w.includes("template catalog unavailable"))).toBe(true);
  });

  it("degrades a throwing runs lister to a warning", async () => {
    const db: DbWithRuns = {
      getDocument: async () => undefined,
      appendCommandLog: async () => undefined,
      listRuns: async () => {
        throw new Error("db down");
      },
    };
    const result = await runTool(makeCtx({ engine: makeEngine(), db }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseSummary(result.summary).recentRuns).toBeUndefined();
    expect(result.warnings?.some((w) => w.includes("recent runs unavailable"))).toBe(true);
  });

  it("omits the runs section silently when the db seam has no lister", async () => {
    const result = await runTool(makeCtx({ engine: makeEngine(), db: makeDb(false) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseSummary(result.summary).recentRuns).toBeUndefined();
    expect(result.warnings ?? []).toEqual([]);
  });

  it("returns engine_timeout for a pre-aborted signal (§3.4 boundary)", async () => {
    const result = await workspaceSnapshot.run(
      makeCtx({ engine: makeEngine() }),
      { documentId: DOC_ID },
      abortedSignal(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("engine_timeout");
  });

  it("omits documentRevision when the engine reports a nonsensical revision", async () => {
    const engine = makeEngine({
      inspect: async () => success(baseSnapshot({ revision: -1 })),
    });
    const result = await runTool(makeCtx({ engine }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documentRevision).toBeUndefined();
  });

  it("forwards the engine revision as documentRevision", async () => {
    const engine = makeEngine({
      inspect: async () => success(baseSnapshot({ revision: 42 })),
    });
    const result = await runTool(makeCtx({ engine }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documentRevision).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function makeSections(over: Partial<SnapshotSections> = {}): SnapshotSections {
  return {
    canvas: { widthPx: 1080, heightPx: 1350 },
    layers: [
      { id: "1", name: "L1", kind: "Raster", visible: true },
      { id: "2", name: "L2", kind: "Text", visible: false, opacity: 0.5 },
    ],
    layersTotal: 2,
    templates: [{ ref: "t@1", title: "T", slots: 2, tags: ["x"] }],
    palette: [{ token: "ink", value: "#3B2A20" }],
    fonts: ["Inter"],
    variables: {
      defs: [
        { name: "a", layer: "1" },
        { name: "b", layer: "2" },
        { name: "v", layer: "1" },
      ],
      dataSets: ["default"],
    },
    comps: { comps: [{ id: "1", name: "C" }], lastApplied: "1" },
    recentRuns: [{ id: "r1", status: "done", createdAt: "2026-01-01T00:00:00Z" }],
    buildWarnings: [],
    ...over,
  };
}

describe("compactLayer (§5.4 projection)", () => {
  it("normalizes percent opacity and drops opacity 1", () => {
    expect(compactLayer(layerRow(1, { opacity: 85 }))?.opacity).toBe(0.85);
    expect(compactLayer(layerRow(2, { opacity: 1 }))?.opacity).toBeUndefined();
    expect(compactLayer(layerRow(3, { opacity: 5 }))?.opacity).toBe(0.05);
    expect(compactLayer(layerRow(4, { opacity: 150 }))?.opacity).toBeUndefined();
    expect(compactLayer(layerRow(5, { opacity: "50%" }))?.opacity).toBeUndefined();
  });

  it("clips long names and keeps only whitelisted fields", () => {
    const layer = compactLayer({ ...hostileRow(), name: "x".repeat(200) });
    expect(layer?.name).toHaveLength(80);
    expect(layer?.name.endsWith("…")).toBe(true);
    const keys = Object.keys(layer ?? {});
    expect(keys).not.toContain("pixels");
    expect(keys).not.toContain("thumbnail");
    expect(keys).not.toContain("smartSource");
  });

  it("returns undefined for rows without a usable id", () => {
    expect(compactLayer(malformedRow())).toBeUndefined();
    expect(compactLayer(layerRow(1, { layerId: "", id: null }))).toBeUndefined();
  });
});

describe("commandPayload (minimal seam probing)", () => {
  it("reads result/value/reply/data/payload keys", () => {
    for (const key of ["result", "value", "reply", "data", "payload"] as const) {
      const report = { revision: 1, [key]: { defs: [] } } as unknown as EngineCommandReport;
      expect(commandPayload(report)).toEqual({ defs: [] });
    }
  });

  it("parses a JSON message and ignores plain-text messages", () => {
    expect(commandPayload({ revision: 1, message: '{"defs":[]}' })).toEqual({ defs: [] });
    expect(commandPayload({ revision: 1, message: "done" })).toBeUndefined();
    expect(commandPayload({ revision: 1, message: "{broken" })).toBeUndefined();
    expect(commandPayload({ revision: 1 })).toBeUndefined();
  });

  it("accepts an object-valued message defensively", () => {
    const report = { revision: 1, message: { comps: [] } } as unknown as EngineCommandReport;
    expect(commandPayload(report)).toEqual({ comps: [] });
  });
});
