// style-apply.test.ts — §6 row 10 style_apply: command mapping (table), batching,
// adjustment passthrough caps, param ranges, and strict-schema rejection.
// Pure + deterministic: a capturing EngineLike fake, no engine, no network.

import { describe, expect, it } from "vitest";
import { parseToolArgs } from "../src/kit.js";
import {
  MAX_ADJ_PARAM_KEYS,
  MAX_TARGET_LAYERS,
  normalizeColor,
  planStyleCommands,
  styleApplyTool,
} from "../src/tools/style-apply.js";
import type {
  EngineBatchOptions,
  EngineBatchReport,
  EngineCommand,
  EngineCommandOutcome,
  EngineFailure,
  EngineLike,
  EngineOutcome,
  ToolContext,
  ToolResult,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const IDEMPOTENCY = "style-tests-key-1";
const REVISION = 7;

interface BatchCall {
  readonly cmds: readonly EngineCommand[];
  readonly options?: EngineBatchOptions;
}

function success<T>(value: T): EngineOutcome<T> {
  return { ok: true, value };
}

/** The captured batch (throws so noUncheckedIndexedAccess stays honest). */
function firstBatch(batches: readonly BatchCall[]): BatchCall {
  const first = batches[0];
  if (first === undefined) {
    throw new Error("expected at least one engine batch call");
  }
  return first;
}

/** EngineLike fake that captures every batch for assertions. */
function captureEngine(overrides?: {
  failure?: EngineFailure;
  outcomes?: readonly EngineCommandOutcome[];
  revision?: number;
}): { readonly engine: EngineLike; readonly batches: BatchCall[] } {
  const batches: BatchCall[] = [];
  const engine: EngineLike = {
    batch: async (cmds, options) => {
      batches.push({ cmds: [...cmds], options });
      if (overrides?.failure !== undefined) {
        return overrides.failure;
      }
      const report: EngineBatchReport = {
        revision: overrides?.revision ?? REVISION,
        outcomes:
          overrides?.outcomes ??
          cmds.map((command, index) => ({ index, commandId: command.id, ok: true })),
      };
      return success(report);
    },
    execute: async () => success({ revision: 1 }),
    render: async () => success({ image: new Uint8Array(0), widthPx: 1, heightPx: 1 }),
    inspect: async () => success({ revision: 1, widthPx: 100, heightPx: 100, layers: [] }),
    listLayers: async () => success([]),
  };
  return { engine, batches };
}

type RawArgs = Record<string, unknown>;

function rawArgs(style: RawArgs, target: unknown = { layerId: "12" }): RawArgs {
  return { target, style, idempotencyKey: IDEMPOTENCY };
}

/** parseToolArgs + run: the executor's exact boundary sequence. */
async function call(
  raw: RawArgs,
  engine: EngineLike,
  contextOverrides: Partial<ToolContext> = {},
): Promise<ToolResult> {
  const parsed = parseToolArgs(styleApplyTool, raw);
  if (!parsed.ok) {
    return parsed;
  }
  return styleApplyTool.run(
    makeFakeContext({ engine, ...contextOverrides }),
    parsed.args,
    freshSignal(),
  );
}

function expectInvalid(raw: RawArgs): void {
  const parsed = parseToolArgs(styleApplyTool, raw);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.code).toBe("invalid_args");
  }
}

/** The engine renders a drop shadow as dx = round(-cos·d), dy = round(sin·d)
 * (vendor compose/effects.rs offset()) — assert the round trip, not the formula. */
function expectOffsetRoundTrip(
  params: Record<string, unknown>,
  offsetX: number,
  offsetY: number,
): void {
  const angle = params.angle;
  const distance = params.distance;
  expect(typeof angle).toBe("number");
  expect(typeof distance).toBe("number");
  const radians = ((angle as number) * Math.PI) / 180;
  expect(Math.round(-Math.cos(radians) * (distance as number))).toBe(offsetX);
  expect(Math.round(Math.sin(radians) * (distance as number))).toBe(offsetY);
}

const manyKeys = (count: number): Record<string, number> => {
  const params: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) {
    params[`key${i}`] = i;
  }
  return params;
};

// ---------------------------------------------------------------------------
// Command mapping — every kind, table-driven (§2.2 exact ids, §6 row 10)
// ---------------------------------------------------------------------------

describe("style_apply command mapping", () => {
  const table: {
    readonly name: string;
    readonly style: RawArgs;
    readonly commands: readonly { id: string; params?: Record<string, unknown> }[];
    readonly summaryIncludes: readonly string[];
    readonly warnings?: readonly string[];
    /** true when the engine params include derived floats (angle/distance) the
     * exact-params assertion must not compare. */
    readonly partialParams?: boolean;
  }[] = [
    {
      name: "drop_shadow → layer.layerStyle.dropShadow (0..1 opacity → 0..100; offset → angle+distance; blur → size)",
      style: {
        kind: "drop_shadow",
        color: "#000000",
        opacity: 0.75,
        offsetX: 4,
        offsetY: 3,
        blur: 8,
      },
      commands: [
        {
          id: "layer.layerStyle.dropShadow",
          params: { layer: 12, color: "#000000", opacity: 75, size: 8, useGlobalLight: false },
        },
      ],
      summaryIncludes: ["Styled 1 layer with drop shadow", "layer 12"],
      partialParams: true,
    },
    {
      name: "drop_shadow with a zero offset passes distance 0 and no angle",
      style: {
        kind: "drop_shadow",
        color: "#111111",
        opacity: 1,
        offsetX: 0,
        offsetY: 0,
        blur: 5,
      },
      commands: [
        {
          id: "layer.layerStyle.dropShadow",
          params: { layer: 12, color: "#111111", opacity: 100, size: 5, distance: 0 },
        },
      ],
      summaryIncludes: ["drop shadow"],
    },
    {
      name: "stroke → layer.layerStyle.stroke (width → size)",
      style: { kind: "stroke", color: "#00ff00", width: 3, position: "center" },
      commands: [
        {
          id: "layer.layerStyle.stroke",
          params: { layer: 12, size: 3, position: "center", color: "#00ff00" },
        },
      ],
      summaryIncludes: ["stroke"],
    },
    {
      name: "color_overlay → layer.layerStyle.colorOverlay (rgb() normalized to hex)",
      style: { kind: "color_overlay", color: "rgb(255, 0, 0)", opacity: 0.6 },
      commands: [
        {
          id: "layer.layerStyle.colorOverlay",
          params: { layer: 12, color: "#ff0000", opacity: 60 },
        },
      ],
      summaryIncludes: ["color overlay"],
    },
    {
      name: "gradient_overlay → layer.layerStyle.gradientOverlay (hsl() to-color normalized)",
      style: { kind: "gradient_overlay", from: "#000000", to: "hsl(120, 100%, 50%)", angle: 90 },
      commands: [
        {
          id: "layer.layerStyle.gradientOverlay",
          params: { layer: 12, from: "#000000", to: "#00ff00", angle: 90 },
        },
      ],
      summaryIncludes: ["gradient overlay"],
    },
    {
      name: "inner_shadow → layer.layerStyle.innerShadow (intensity → opacity percent)",
      style: { kind: "inner_shadow", color: "#123456", intensity: 0.4 },
      commands: [
        { id: "layer.layerStyle.innerShadow", params: { layer: 12, color: "#123456", opacity: 40 } },
      ],
      summaryIncludes: ["inner shadow"],
    },
    {
      name: "outer_glow → layer.layerStyle.outerGlow (intensity → opacity percent)",
      style: { kind: "outer_glow", color: "#abcdef", intensity: 0.8 },
      commands: [
        { id: "layer.layerStyle.outerGlow", params: { layer: 12, color: "#abcdef", opacity: 80 } },
      ],
      summaryIncludes: ["outer glow"],
    },
    {
      name: "bevel_emboss → layer.layerStyle.bevelEmboss (intensity → depth 0..1000; colour warned)",
      style: { kind: "bevel_emboss", color: "#ffffff", intensity: 0.5 },
      commands: [{ id: "layer.layerStyle.bevelEmboss", params: { layer: 12, depth: 500 } }],
      summaryIncludes: ["bevel/emboss"],
      warnings: [
        "bevel_emboss colour is not applied: the engine's bevel command exposes no highlight/shadow colour parameters",
      ],
    },
    {
      name: "clear → layer.layerStyle.clear",
      style: { kind: "clear" },
      commands: [{ id: "layer.layerStyle.clear", params: { layer: 12 } }],
      summaryIncludes: ["Cleared layer styles on 1 layer", "layer 12"],
    },
    {
      name: "adjustment levels → layer.select + layer.newAdjustmentLayer.levels (passthrough)",
      style: { kind: "adjustment", type: "levels", params: { inBlack: 10, inWhite: 240, gamma: 1.2 } },
      commands: [
        { id: "layer.select", params: { layer: 12 } },
        { id: "layer.newAdjustmentLayer.levels", params: { inBlack: 10, inWhite: 240, gamma: 1.2 } },
      ],
      summaryIncludes: ["levels adjustment layer above layer 12"],
    },
    {
      name: "adjustment curves → layer.newAdjustmentLayer.curves (nested passthrough)",
      style: {
        kind: "adjustment",
        type: "curves",
        params: { points: [[0, 0], [128, 150], [255, 255]], blue: [[0, 20], [255, 235]] },
      },
      commands: [
        { id: "layer.select" },
        {
          id: "layer.newAdjustmentLayer.curves",
          params: { points: [[0, 0], [128, 150], [255, 255]], blue: [[0, 20], [255, 235]] },
        },
      ],
      summaryIncludes: ["curves adjustment layer"],
    },
    {
      name: "adjustment hue_saturation → layer.newAdjustmentLayer.hueSaturation (exact suffix casing)",
      style: { kind: "adjustment", type: "hue_saturation", params: { hue: 40, saturation: 20 } },
      commands: [
        { id: "layer.select" },
        { id: "layer.newAdjustmentLayer.hueSaturation", params: { hue: 40, saturation: 20 } },
      ],
      summaryIncludes: ["hue saturation adjustment layer"],
    },
    {
      name: "adjustment brightness_contrast → layer.newAdjustmentLayer.brightnessContrast",
      style: { kind: "adjustment", type: "brightness_contrast", params: { brightness: 20, contrast: -10 } },
      commands: [
        { id: "layer.select" },
        {
          id: "layer.newAdjustmentLayer.brightnessContrast",
          params: { brightness: 20, contrast: -10 },
        },
      ],
      summaryIncludes: ["brightness contrast adjustment layer"],
    },
  ];

  for (const entry of table) {
    it(entry.name, async () => {
      const { engine, batches } = captureEngine();
      const result = await call(rawArgs(entry.style), engine);
      expect(result.ok).toBe(true);
      expect(batches).toHaveLength(1);
      const batch = firstBatch(batches);
      expect(batch.options?.transaction).toBe(true);
      expect(batch.options?.signal).toBeDefined();
      expect(batch.cmds).toHaveLength(entry.commands.length);
      for (const [index, expected] of entry.commands.entries()) {
        expect(batch.cmds[index]?.id).toBe(expected.id);
        if (expected.params !== undefined) {
          const params = batch.cmds[index]?.params as Record<string, unknown>;
          if (entry.partialParams === true) {
            expect(params).toEqual(expect.objectContaining(expected.params));
          } else {
            expect(params).toEqual(expected.params);
          }
        }
      }
      if (result.ok) {
        expect(result.documentRevision).toBe(REVISION);
        for (const fragment of entry.summaryIncludes) {
          expect(result.summary).toContain(fragment);
        }
        if (entry.warnings === undefined) {
          expect(result.warnings).toBeUndefined();
        } else {
          expect(result.warnings).toEqual(entry.warnings);
        }
      }
    });
  }

  it("drop_shadow offset inverts the engine's angle+distance model exactly", async () => {
    const { engine, batches } = captureEngine();
    await call(
      rawArgs({ kind: "drop_shadow", color: "#000", opacity: 0.5, offsetX: -7, offsetY: 12, blur: 10 }),
      engine,
    );
    const params = firstBatch(batches).cmds[0]?.params as Record<string, unknown>;
    expectOffsetRoundTrip(params, -7, 12);
  });

  it("named refs pass through as strings for the engine to resolve (§6.1)", async () => {
    const { engine, batches } = captureEngine();
    await call(rawArgs({ kind: "clear" }, { layerName: "Headline" }), engine);
    expect(firstBatch(batches).cmds[0]?.params).toEqual({ layer: "Headline" });
  });

  it("non-numeric layer_id strings are handed over as names", async () => {
    const { engine, batches } = captureEngine();
    await call(rawArgs({ kind: "clear" }, { layerId: "hero-layer" }), engine);
    expect(firstBatch(batches).cmds[0]?.params).toEqual({ layer: "hero-layer" });
  });

  it("rgba() colour alpha is dropped with a warning, never silently", async () => {
    const { engine } = captureEngine();
    const result = await call(
      rawArgs({ kind: "color_overlay", color: "rgba(0, 128, 255, 0.5)", opacity: 1 }),
      engine,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings?.[0]).toContain("alpha");
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-target batching — one command per layer, single transactional batch
// ---------------------------------------------------------------------------

describe("style_apply multi-target batching", () => {
  it("sends one command per layer, in target order, in one transaction", async () => {
    const { engine, batches } = captureEngine();
    const result = await call(
      rawArgs(
        { kind: "color_overlay", color: "#f0a", opacity: 1 },
        [{ layerName: "Headline" }, { layerId: "3" }, { layerName: "Badge" }],
      ),
      engine,
    );
    expect(result.ok).toBe(true);
    expect(batches).toHaveLength(1);
    const batch = firstBatch(batches);
    expect(batch.options?.transaction).toBe(true);
    const cmds = batch.cmds;
    expect(cmds.map((command) => command.id)).toEqual([
      "layer.layerStyle.colorOverlay",
      "layer.layerStyle.colorOverlay",
      "layer.layerStyle.colorOverlay",
    ]);
    expect(cmds.map((command) => command.params.layer)).toEqual(["Headline", 3, "Badge"]);
    if (result.ok) {
      expect(result.summary).toContain("3 layers");
      expect(result.summary).toContain('"Headline"');
      expect(result.summary).toContain('"Badge"');
    }
  });

  it("caps the named layers in the summary at 10 (+N more)", () => {
    const targets = Array.from({ length: MAX_TARGET_LAYERS }, (_, i) => ({
      layerName: `Layer ${i}`,
    }));
    const plan = planStyleCommands({ kind: "clear" }, targets);
    expect(plan.summary).toContain("50 layers");
    expect(plan.summary).toContain("(+40 more)");
    expect(plan.summary.length).toBeLessThanOrEqual(2000);
  });

  it("adjustment with multiple targets creates one document-wide layer + warning", async () => {
    const { engine, batches } = captureEngine();
    const result = await call(
      rawArgs({ kind: "adjustment", type: "levels", params: {} }, [
        { layerName: "A" },
        { layerName: "B" },
      ]),
      engine,
    );
    expect(result.ok).toBe(true);
    const batch = firstBatch(batches);
    expect(batch.cmds.map((command) => command.id)).toEqual([
      "layer.newAdjustmentLayer.levels",
    ]);
    if (result.ok) {
      expect(result.summary).toContain("above the active layer");
      expect(result.warnings?.[0]).toContain("document");
    }
  });
});

// ---------------------------------------------------------------------------
// Strict schema: ranges, caps, unknown keys (§6.1)
// ---------------------------------------------------------------------------

describe("style_apply strict schema", () => {
  it("rejects out-of-range params with invalid_args", () => {
    const shadow = (over: RawArgs): RawArgs =>
      rawArgs({ kind: "drop_shadow", color: "#000", opacity: 0.5, offsetX: 0, offsetY: 0, blur: 5, ...over });
    expectInvalid(shadow({ blur: -1 }));
    expectInvalid(shadow({ blur: 101 }));
    expectInvalid(shadow({ offsetX: 2001 }));
    expectInvalid(shadow({ offsetY: -2001 }));
    expectInvalid(shadow({ opacity: -0.01 }));
    expectInvalid(shadow({ opacity: 1.01 }));
    expectInvalid(rawArgs({ kind: "stroke", color: "#000", width: 51, position: "outside" }));
    expectInvalid(rawArgs({ kind: "stroke", color: "#000", width: -1, position: "outside" }));
    expectInvalid(rawArgs({ kind: "gradient_overlay", from: "#000", to: "#fff", angle: 361 }));
    expectInvalid(rawArgs({ kind: "inner_shadow", color: "#000", intensity: 1.5 }));
    expectInvalid(rawArgs({ kind: "color_overlay", color: "red", opacity: 0.5 }));
    expectInvalid(rawArgs({ kind: "stroke", color: "#000", width: 3, position: "beyond" }));
  });

  it("accepts the range boundaries", () => {
    expect(
      parseToolArgs(
        styleApplyTool,
        rawArgs({ kind: "drop_shadow", color: "#000", opacity: 0, offsetX: -2000, offsetY: 2000, blur: 100 }),
      ).ok,
    ).toBe(true);
    expect(
      parseToolArgs(
        styleApplyTool,
        rawArgs({ kind: "gradient_overlay", from: "#000", to: "#fff", angle: 360 }),
      ).ok,
    ).toBe(true);
    expect(
      parseToolArgs(styleApplyTool, rawArgs({ kind: "stroke", color: "#000", width: 0, position: "inside" })).ok,
    ).toBe(true);
    const fifty = Array.from({ length: MAX_TARGET_LAYERS }, () => ({ layerId: "1" }));
    expect(parseToolArgs(styleApplyTool, rawArgs({ kind: "clear" }, fifty)).ok).toBe(true);
  });

  it("caps targets at 50 and rejects empty/malformed refs", () => {
    const fiftyOne = Array.from({ length: MAX_TARGET_LAYERS + 1 }, () => ({ layerId: "1" }));
    expectInvalid(rawArgs({ kind: "clear" }, fiftyOne));
    expectInvalid(rawArgs({ kind: "clear" }, []));
    expectInvalid(rawArgs({ kind: "clear" }, { layerId: "1", layerName: "Two" }));
    expectInvalid(rawArgs({ kind: "clear" }, "Headline"));
  });

  it("rejects unknown kinds, unknown keys, and missing required fields", () => {
    expectInvalid(rawArgs({ kind: "satin", color: "#000" }));
    expectInvalid(rawArgs({ kind: "clear", effect: 0 }));
    const extra = rawArgs({ kind: "clear" });
    extra.surprise = true;
    expectInvalid(extra);
    expectInvalid({ target: { layerId: "1" }, style: { kind: "clear" } });
    expectInvalid({
      target: { layerId: "1" },
      style: { kind: "clear" },
      idempotencyKey: "short",
    });
    expectInvalid({
      target: { layerId: "1" },
      style: { kind: "clear" },
      idempotencyKey: "not a key!",
    });
  });

  it("unknown adjustment type → invalid_args listing the candidate types", () => {
    const parsed = parseToolArgs(
      styleApplyTool,
      rawArgs({ kind: "adjustment", type: "vibrance", params: {} }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      for (const candidate of ["levels", "curves", "hue_saturation", "brightness_contrast"]) {
        expect(parsed.hint).toContain(candidate);
      }
    }
  });

  it("bounds adjustment passthrough params (≤ 20 keys, bounded JSON)", () => {
    expect(
      parseToolArgs(
        styleApplyTool,
        rawArgs({ kind: "adjustment", type: "levels", params: manyKeys(MAX_ADJ_PARAM_KEYS) }),
      ).ok,
    ).toBe(true);
    expectInvalid(rawArgs({ kind: "adjustment", type: "levels", params: manyKeys(MAX_ADJ_PARAM_KEYS + 1) }));
    expectInvalid(
      rawArgs({ kind: "adjustment", type: "levels", params: { red: manyKeys(MAX_ADJ_PARAM_KEYS + 1) } }),
    );
    expectInvalid(
      rawArgs({
        kind: "adjustment",
        type: "curves",
        params: { points: Array.from({ length: 65 }, (_, i) => [i, i]) },
      }),
    );
    expectInvalid(
      rawArgs({ kind: "adjustment", type: "levels", params: { note: "x".repeat(201) } }),
    );
    expectInvalid(
      rawArgs({ kind: "adjustment", type: "levels", params: { gamma: Number.POSITIVE_INFINITY } }),
    );
    expectInvalid(rawArgs({ kind: "adjustment", type: "levels", params: "levels" }));
  });

  it("adjustment params may be empty (engine defaults)", async () => {
    const { engine, batches } = captureEngine();
    const result = await call(
      rawArgs({ kind: "adjustment", type: "brightness_contrast", params: {} }),
      engine,
    );
    expect(result.ok).toBe(true);
    expect(firstBatch(batches).cmds[1]?.params).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Failure paths: typed envelopes, rollback, budget clean stop
// ---------------------------------------------------------------------------

describe("style_apply failure paths", () => {
  it("propagates engine batch failures verbatim (§6.1 typed unions)", async () => {
    const failure: EngineFailure = {
      ok: false,
      code: "engine_unavailable",
      message: "No engine session can be served",
      retryable: true,
    };
    const { engine, batches } = captureEngine({ failure });
    const result = await call(rawArgs({ kind: "clear" }), engine);
    expect(result).toMatchObject({
      ok: false,
      code: "engine_unavailable",
      retryable: true,
    });
    expect(batches).toHaveLength(1);
  });

  it("a failed command in the batch rolls back and names the target", async () => {
    const { engine } = captureEngine({
      outcomes: [
        { index: 0, commandId: "layer.layerStyle.clear", ok: true },
        { index: 1, commandId: "layer.layerStyle.clear", ok: false, message: 'no layer named "Badge"' },
      ],
    });
    const result = await call(
      rawArgs({ kind: "clear" }, [{ layerName: "Headline" }, { layerName: "Badge" }]),
      engine,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain('"Badge"');
      expect(result.message).toContain("no layer named");
      expect(result.hint).toContain("rolled back");
    }
  });

  it("stops cleanly on the budget boundary before any engine call (§5.2)", async () => {
    const { engine, batches } = captureEngine();
    const result = await call(rawArgs({ kind: "clear" }, { layerName: "A" }), engine, {
      budgets: {
        remaining: () => ({ msRemaining: 0, commandsRemaining: 0 }),
        charge: () => false,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("budget_exceeded");
    }
    expect(batches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Colour normalization (§6.1 forms → engine hex)
// ---------------------------------------------------------------------------

describe("normalizeColor", () => {
  const table: readonly [string, string, boolean][] = [
    ["#f0a", "#ff00aa", false],
    ["#ABCDEF", "#abcdef", false],
    ["rgb(0, 128, 255)", "#0080ff", false],
    ["rgba(255, 0, 0, 0.5)", "#ff0000", true],
    ["hsl(120, 100%, 50%)", "#00ff00", false],
    ["hsl(0, 0%, 100%)", "#ffffff", false],
    ["hsla(300, 100%, 50%, 0.2)", "#ff00ff", true],
    ["rgb( 1 , 2 , 3 )", "#010203", false],
  ];

  for (const [input, hex, droppedAlpha] of table) {
    it(`${input} → ${hex} (droppedAlpha: ${droppedAlpha})`, () => {
      expect(normalizeColor(input)).toEqual({ hex, droppedAlpha });
    });
  }
});

// ---------------------------------------------------------------------------
// Tool surface pin
// ---------------------------------------------------------------------------

describe("style_apply tool pin", () => {
  it("is the §6 style_apply surface entry", () => {
    expect(styleApplyTool.name).toBe("style_apply");
    expect(styleApplyTool.description.length).toBeGreaterThanOrEqual(10);
    expect(styleApplyTool.description.length).toBeLessThanOrEqual(500);
  });
});
