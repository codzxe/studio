import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TOOL_LIST } from "../src/tools.js";
import {
  DUNDER_KEYS,
  KEYFRAME_INTERPOLATION_SCHEMA,
  MAX_WRITE_TOOL_ARGS_BYTES,
  PROPOSED_BATCH_NOTE,
  WRITE_TOOLS,
  WRITE_TOOL_ARGS_SCHEMAS,
  WRITE_TOOL_IDS,
  WRITE_TOOL_RESULT_SCHEMA,
  type WriteToolId,
  firstDunderKeyLocation,
  hasNoDunderKeys,
  hasNoDunderSegments,
  isDunderKey,
  isJsonSerializableValue,
  studioWriteToolId,
} from "../src/write-tools.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An own `__proto__` key, the way hostile JSON actually arrives on the wire
 * (a JS literal would hit the accessor, JSON.parse creates an own key). */
function jsonWithDunder(json: string): unknown {
  return JSON.parse(json);
}

function layerNames(count: number, name = "Layer"): { name: string }[] {
  return Array.from({ length: count }, (_, i) => ({ name: `${name} ${i + 1}` }));
}

const MINIMAL_VALID: Record<WriteToolId, unknown> = {
  create_composition: { name: "Main" },
  create_text: { text: "Hi" },
  set_properties: {
    layers: [{ name: "Headline" }],
    properties: [{ path: "transform/opacity", value: 100 }],
  },
  add_effect: { layers: [{ name: "Headline" }], effect: { name: "Gaussian Blur" } },
  set_keyframes: {
    layers: [{ name: "Headline" }],
    propertyPath: "transform/scale",
    keys: [{ timeSeconds: 0, value: 20 }],
  },
  apply_preset: { preset: { name: "Kinetic In" } },
  undo_run: {},
  save_version: {},
  engine_commands: { steps: [{ command: "comp.new", params: { name: "Main" } }] },
  run_script: { code: 'app.beginUndoGroup("agent"); app.endUndoGroup();' },
  add_asset: {
    kind: "svg",
    name: "Logo",
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10H0z"/></svg>',
  },
};

function validResult(): Record<string, unknown> {
  return {
    proposedBatch: {
      label: "Agent: set opacity on Headline",
      steps: [{ command: "prop.set", params: { path: "transform/opacity", value: 100 } }],
    },
    note: PROPOSED_BATCH_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Identity + registry integrity
// ---------------------------------------------------------------------------

describe("write-tools: identity and registry", () => {
  it("WRITE_TOOL_IDS keeps the 8 spec ids first, in BUILD_PLAN §M5.1 order", () => {
    // PRESERVED expectation (round 12): the §M5.1 eight stay in spec order.
    expect([...WRITE_TOOL_IDS].slice(0, 8)).toEqual([
      "create_composition",
      "create_text",
      "set_properties",
      "add_effect",
      "set_keyframes",
      "apply_preset",
      "undo_run",
      "save_version",
    ]);
    expect(new Set(WRITE_TOOL_IDS).size).toBe(WRITE_TOOL_IDS.length);
  });

  it("round-12 additions: the full id list is the §M5.1 eight + engine_commands, run_script, add_asset", () => {
    expect([...WRITE_TOOL_IDS]).toEqual([
      "create_composition",
      "create_text",
      "set_properties",
      "add_effect",
      "set_keyframes",
      "apply_preset",
      "undo_run",
      "save_version",
      "engine_commands",
      "run_script",
      "add_asset",
    ]);
  });

  it("WRITE_TOOL_ARGS_SCHEMAS covers every id, same order, all ZodObjects", () => {
    expect(Object.keys(WRITE_TOOL_ARGS_SCHEMAS)).toEqual([...WRITE_TOOL_IDS]);
    for (const id of WRITE_TOOL_IDS) {
      expect(WRITE_TOOL_ARGS_SCHEMAS[id] instanceof z.ZodObject, id).toBe(true);
    }
  });

  it("every WRITE_TOOLS entry has a matching args schema and proposal-only flags", () => {
    expect(WRITE_TOOLS).toHaveLength(WRITE_TOOL_IDS.length);
    expect(WRITE_TOOLS.map((tool) => tool.id)).toEqual([...WRITE_TOOL_IDS]);
    for (const tool of WRITE_TOOLS) {
      expect(tool.inputSchema, tool.id).toBe(WRITE_TOOL_ARGS_SCHEMAS[tool.id]);
      expect(tool.kind, tool.id).toBe("write");
      expect(tool.returns, tool.id).toBe("proposed-batch");
      expect(["low", "medium", "high"], tool.id).toContain(tool.risk);
    }
  });

  it("descriptions are model-facing, proposal-only and carry no raw command ids", () => {
    const RAW_COMMAND_ID = /\b(comp|layer|prop|edit|render|ui|project|engine)\.[a-z]/i;
    for (const tool of WRITE_TOOLS) {
      expect(tool.description.length, tool.id).toBeGreaterThan(40);
      expect(/propose|proposed/i.test(tool.description), tool.id).toBe(true);
      expect(/proposed batch/i.test(tool.description), tool.id).toBe(true);
      expect(RAW_COMMAND_ID.test(tool.description), `${tool.id} leaks a command id`).toBe(false);
      expect(tool.description.toLowerCase(), tool.id).not.toContain("engine.execute");
    }
  });

  it("studioWriteToolId maps every write id onto the catalog wire id", () => {
    expect(studioWriteToolId("set_properties")).toBe("studio.set_properties");
    for (const id of WRITE_TOOL_IDS) {
      expect(studioWriteToolId(id).startsWith("studio.")).toBe(true);
    }
  });

  it("tools.ts registers the 8 write tools with the SAME schemas and descriptions", () => {
    const writeDefs = TOOL_LIST.filter((tool) => tool.kind === "write");
    expect(writeDefs.map((tool) => tool.id)).toEqual([...WRITE_TOOL_IDS.map(studioWriteToolId)]);
    for (const tool of WRITE_TOOLS) {
      const def = writeDefs.find((entry) => entry.id === studioWriteToolId(tool.id));
      expect(def, studioWriteToolId(tool.id)).toBeDefined();
      expect(def?.args, tool.id).toBe(WRITE_TOOL_ARGS_SCHEMAS[tool.id]);
      expect(def?.description, tool.id).toBe(tool.description);
      expect(def?.returns, tool.id).toBe("proposed-batch");
    }
  });

  it("every args schema converts to provider JSON Schema (the runner wire format)", () => {
    for (const id of WRITE_TOOL_IDS) {
      const jsonSchema = z.toJSONSchema(WRITE_TOOL_ARGS_SCHEMAS[id], { io: "input" }) as Record<
        string,
        unknown
      >;
      expect(jsonSchema.type, id).toBe("object");
      expect(jsonSchema.additionalProperties, `${id} must be strict`).toBe(false);
    }
  });

  it("every args schema is STRICT: unknown keys are rejected", () => {
    for (const id of WRITE_TOOL_IDS) {
      const base = MINIMAL_VALID[id] as Record<string, unknown>;
      expect(WRITE_TOOL_ARGS_SCHEMAS[id].safeParse(base).success, id).toBe(true);
      expect(
        WRITE_TOOL_ARGS_SCHEMAS[id].safeParse({ ...base, surprise: true }).success,
        `${id} must reject unknown keys`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-tool happy paths + bounds (BUILD_PLAN §M5.1 curated bounds)
// ---------------------------------------------------------------------------

describe("write-tools: create_composition args", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.create_composition;

  it("accepts a name-only call and a fully-specified call", () => {
    expect(schema.safeParse({ name: "Main" }).success).toBe(true);
    expect(
      schema.safeParse({
        name: "Main",
        width: 1920,
        height: 1080,
        frameRate: 29.97,
        durationSeconds: 10,
      }).success,
    ).toBe(true);
  });

  it("bounds: name ≤ 80, width/height 1..8192, fps 1..120, duration 0.01..36000", () => {
    expect(schema.safeParse({ name: "x".repeat(80) }).success).toBe(true);
    expect(schema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(schema.safeParse({ name: "M", width: 1 }).success).toBe(true);
    expect(schema.safeParse({ name: "M", width: 8192 }).success).toBe(true);
    expect(schema.safeParse({ name: "M", width: 0 }).success).toBe(false);
    expect(schema.safeParse({ name: "M", width: 8193 }).success).toBe(false);
    expect(schema.safeParse({ name: "M", width: 1920.5 }).success).toBe(false); // integer pixels
    expect(schema.safeParse({ name: "M", frameRate: 120 }).success).toBe(true);
    expect(schema.safeParse({ name: "M", frameRate: 0.5 }).success).toBe(false);
    expect(schema.safeParse({ name: "M", frameRate: 121 }).success).toBe(false);
    expect(schema.safeParse({ name: "M", durationSeconds: 0.01 }).success).toBe(true);
    expect(schema.safeParse({ name: "M", durationSeconds: 36000 }).success).toBe(true);
    expect(schema.safeParse({ name: "M", durationSeconds: 0.009 }).success).toBe(false);
    expect(schema.safeParse({ name: "M", durationSeconds: 36001 }).success).toBe(false);
    expect(schema.safeParse({ name: "" }).success).toBe(false);
  });

  // 2026-11-01 root-cause fix: both failing runs tried to set the composition
  // background right after creation — the surface never exposed it.
  it("accepts a background color in both forms (#hex and [r, g, b] channels)", () => {
    expect(schema.safeParse({ name: "Main", background: "#0B0D10" }).success).toBe(true);
    expect(schema.safeParse({ name: "Main", background: [66, 133, 244] }).success).toBe(true);
    expect(
      schema.safeParse({ name: "Main", background: [66, 133, 244, 255] }).success,
    ).toBe(true);
    expect(schema.safeParse({ name: "Main", background: "black" }).success).toBe(false);
    expect(schema.safeParse({ name: "Main", background: [300, 0, 0] }).success).toBe(false);
  });

  it("repairs the model's near-miss color shapes (run 59cead8c, verbatim)", () => {
    // The gateway's stringified-JSON repair turns the raw strings into these;
    // COLOR_INPUT then fixes the leftovers the strict union used to bounce.
    expect(schema.safeParse({ name: "Main", background: ["66", "133", "244"] }).success).toBe(
      true,
    );
    expect(schema.safeParse({ name: "Main", background: ["#0B0D10"] }).success).toBe(true);
  });
});

describe("write-tools: create_text args (real layer.newText subset)", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.create_text;

  it("accepts text-only and the full typography subset", () => {
    expect(schema.safeParse({ text: "Hello" }).success).toBe(true);
    expect(
      schema.safeParse({
        text: "Hello",
        name: "Headline",
        position: [960, 540],
        box: [100, 100, 800, 200],
        font: "Inter",
        style: "Bold",
        size: 72,
        fill: "#0B0D10",
        stroke: [12, 34, 56],
        strokeWidth: 2,
        tracking: 10,
        leading: 80,
        opacity: 0,
      }).success,
    ).toBe(true);
  });

  // 2026-11-01 root-cause fix: the #1 rejected key across both failing runs
  // (8 burned calls) — opacity at CREATION now validates instead of bouncing.
  it("accepts opacity as a 0..1 fraction or a 1..100 percent, rejects the rest", () => {
    expect(schema.safeParse({ text: "G", opacity: 0 }).success).toBe(true);
    expect(schema.safeParse({ text: "G", opacity: 1 }).success).toBe(true);
    expect(schema.safeParse({ text: "G", opacity: 0.35 }).success).toBe(true);
    expect(schema.safeParse({ text: "G", opacity: 100 }).success).toBe(true);
    expect(schema.safeParse({ text: "G", opacity: -1 }).success).toBe(false);
    expect(schema.safeParse({ text: "G", opacity: 101 }).success).toBe(false);
  });

  it("repairs the model's near-miss fill shapes (run 59cead8c, verbatim)", () => {
    // Post stringified-JSON repair the raw calls became these; the color
    // input repair now finishes the job instead of bouncing a retry.
    expect(schema.safeParse({ text: "G", fill: ["66", "133", "244"] }).success).toBe(true);
    expect(schema.safeParse({ text: "G", fill: ["#4285F4"] }).success).toBe(true);
    expect(schema.safeParse({ text: "G", fill: "#4285F4" }).success).toBe(true);
    expect(schema.safeParse({ text: "G", fill: [66, 133, 244] }).success).toBe(true);
    expect(schema.safeParse({ text: "G", fill: "not-a-color" }).success).toBe(false);
  });

  it("bounds: text ≤ 2000, positions/box/size/colors/tracking/leading bounded", () => {
    expect(schema.safeParse({ text: "x".repeat(2000) }).success).toBe(true);
    expect(schema.safeParse({ text: "x".repeat(2001) }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", position: [-1_000_000, 1_000_000] }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", position: [1_000_001, 0] }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", position: [0] }).success).toBe(false); // [x, y] only
    expect(schema.safeParse({ text: "Hi", box: [0, 0, 1_000_000, 1_000_000] }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", box: [0, 0, 0, 50] }).success).toBe(false); // w ≥ 1
    expect(schema.safeParse({ text: "Hi", size: 0.1 }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", size: 10_000 }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", size: 10_001 }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", fill: "#0B0D10FF" }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", fill: "#0B0" }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", fill: "red" }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", stroke: [0, 0, 0, 255] }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", stroke: [0, 0, 256] }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", strokeWidth: 0 }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", strokeWidth: 1001 }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", tracking: -10_000 }).success).toBe(true);
    expect(schema.safeParse({ text: "Hi", tracking: 10_001 }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", leading: -1 }).success).toBe(false);
  });

  it("rejects dunder layer names and raw ids in args", () => {
    expect(schema.safeParse({ text: "Hi", name: "__proto__" }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", name: "constructor" }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", name: "prototype" }).success).toBe(false);
    expect(schema.safeParse({ text: "Hi", compId: "c1" }).success).toBe(false); // no ids in args
  });
});

describe("write-tools: set_properties args", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.set_properties;
  const base = {
    layers: [{ name: "Headline" }],
    properties: [{ path: "transform/opacity", value: 100 }],
  };

  it("accepts layers BY NAME with property updates", () => {
    expect(schema.safeParse(base).success).toBe(true);
    expect(
      schema.safeParse({
        layers: [{ name: "Headline" }, { name: "Sub" }],
        properties: [
          { path: "transform/opacity", value: 50 },
          { path: "text/sourceText", value: "New copy" },
          { path: "effects[0].radius", value: { nested: [1, 2] } },
        ],
      }).success,
    ).toBe(true);
  });

  it("bounds: 1..50 layers, 1..100 updates, path ≤ 200", () => {
    expect(schema.safeParse({ ...base, layers: layerNames(50) }).success).toBe(true);
    expect(schema.safeParse({ ...base, layers: layerNames(51) }).success).toBe(false);
    const updates = Array.from({ length: 100 }, (_, i) => ({
      path: `transform/opacity/${i}`,
      value: i,
    }));
    expect(schema.safeParse({ layers: [{ name: "L" }], properties: updates }).success).toBe(true);
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [...updates, { path: "transform/opacity", value: 0 }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "x".repeat(200), value: 1 }],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "x".repeat(201), value: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects dunder layer names (F-1 class)", () => {
    for (const name of DUNDER_KEYS) {
      expect(schema.safeParse({ ...base, layers: [{ name }] }).success, name).toBe(false);
    }
  });

  it("rejects dunder keys ANYWHERE in property paths", () => {
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "__proto__", value: 1 }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "transform.__proto__.x", value: 1 }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "effects[0].constructor", value: 1 }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "my__proto__field", value: 1 }],
      }).success,
    ).toBe(true); // exact dunder segments only
  });

  it("rejects dunder keys ANYWHERE in values (JSON.parse own-keys included)", () => {
    const hostile = jsonWithDunder('{"style":{"__proto__":{"polluted":true}}}');
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "text/style", value: hostile }],
      }).success,
    ).toBe(false);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    const ctor = jsonWithDunder('{"constructor":{"x":1}}');
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "a/b", value: ctor }],
      }).success,
    ).toBe(false);
  });

  it("rejects non-JSON values (undefined, functions, class instances, cycles)", () => {
    const bad = [
      undefined,
      () => 1,
      new Date(0),
      new Map(),
      10n,
      { u: undefined },
      (() => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return cyclic;
      })(),
      Number.NaN,
    ];
    for (const value of bad) {
      expect(
        schema.safeParse({
          layers: [{ name: "L" }],
          properties: [{ path: "transform/opacity", value }],
        }).success,
        String(value),
      ).toBe(false);
    }
  });
});

describe("write-tools: add_effect args", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.add_effect;
  const base = { layers: [{ name: "Headline" }], effect: { name: "Gaussian Blur" } };

  it("accepts human effect names with optional bounded params", () => {
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, params: { radius: 4, repeat: true } }).success).toBe(true);
  });

  it("bounds: ≤ 50 layers; effect names are human, not plugin paths or dunder", () => {
    expect(schema.safeParse({ ...base, layers: layerNames(50) }).success).toBe(true);
    expect(schema.safeParse({ ...base, layers: layerNames(51) }).success).toBe(false);
    expect(
      schema.safeParse({ layers: base.layers, effect: { name: "x".repeat(121) } }).success,
    ).toBe(false);
    for (const bad of ["C:/plugins/blur.plugin", "dir\\blur", "__proto__", ""]) {
      expect(schema.safeParse({ layers: base.layers, effect: { name: bad } }).success, bad).toBe(
        false,
      );
    }
  });

  it("params passthrough: dunder keys and non-JSON rejected (bounded passthrough)", () => {
    const dunder = jsonWithDunder('{"radius":4,"__proto__":{"polluted":true}}');
    expect(schema.safeParse({ ...base, params: dunder }).success).toBe(false);
    expect(schema.safeParse({ ...base, params: { radius: undefined } }).success).toBe(false);
  });

  it("total args are bounded to 2 MB (§8.5 payload cap)", () => {
    expect(
      schema.safeParse({ ...base, params: { blob: "x".repeat(MAX_WRITE_TOOL_ARGS_BYTES) } })
        .success,
    ).toBe(false);
  });
});

describe("write-tools: set_keyframes args", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.set_keyframes;
  const base = {
    layers: [{ name: "Headline" }],
    propertyPath: "transform/scale",
    keys: [{ timeSeconds: 0, value: 20 }],
  };

  it("accepts layers BY NAME, a path and 1..500 keys", () => {
    expect(schema.safeParse(base).success).toBe(true);
    const keys = Array.from({ length: 500 }, (_, i) => ({
      timeSeconds: i * 0.1,
      value: i,
      interpolation: "bezier" as const,
    }));
    expect(
      schema.safeParse({
        layers: [{ name: "Headline" }],
        propertyPath: "transform/scale",
        keys,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        layers: [{ name: "Headline" }],
        propertyPath: "transform/scale",
        keys: [...keys, { timeSeconds: 50, value: 1 }],
      }).success,
    ).toBe(false);
  });

  it("interpolation is exactly linear|bezier|hold (the engine trio)", () => {
    expect(KEYFRAME_INTERPOLATION_SCHEMA.options).toEqual(["linear", "bezier", "hold"]);
    expect(schema.safeParse({ ...base, keys: [{ timeSeconds: 0, value: 1 }] }).success).toBe(true);
    expect(
      schema.safeParse({ ...base, keys: [{ timeSeconds: 0, value: 1, interpolation: "ease-in" }] })
        .success,
    ).toBe(false);
  });

  it("bounds: timeSeconds 0..36000, propertyPath ≤ 200, dunder-free", () => {
    expect(schema.safeParse({ ...base, keys: [{ timeSeconds: 36000, value: 1 }] }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...base, keys: [{ timeSeconds: -0.1, value: 1 }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...base, keys: [{ timeSeconds: 36001, value: 1 }] }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...base, propertyPath: "__proto__", keys: base.keys as unknown[] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        propertyPath: "x".repeat(201),
        keys: [{ timeSeconds: 0, value: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects dunder layer names and dunder/non-JSON key values", () => {
    expect(schema.safeParse({ ...base, layers: [{ name: "prototype" }] }).success).toBe(false);
    const hostile = jsonWithDunder('{"value":{"__proto__":1}}');
    expect(
      schema.safeParse({
        layers: [{ name: "L" }],
        propertyPath: "transform/scale",
        keys: [{ timeSeconds: 0, value: hostile }],
      }).success,
    ).toBe(false);
  });
});

describe("write-tools: apply_preset args", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.apply_preset;

  it("accepts preset by name OR builtinId, with optional layers/args", () => {
    expect(schema.safeParse({ preset: { name: "Kinetic In" } }).success).toBe(true);
    expect(schema.safeParse({ preset: { builtinId: "kinetic-in" } }).success).toBe(true);
    expect(
      schema.safeParse({
        preset: { builtinId: "kinetic-in" },
        layers: [{ name: "Headline" }],
        args: { intensity: 0.8 },
      }).success,
    ).toBe(true);
  });

  it("preset must be exactly one of name/builtinId, bounded and dunder-free", () => {
    expect(schema.safeParse({ preset: {} }).success).toBe(false);
    expect(
      schema.safeParse({ preset: { name: "Kinetic In", builtinId: "kinetic-in" } }).success,
    ).toBe(false);
    expect(schema.safeParse({ preset: { name: "x".repeat(121) } }).success).toBe(false);
    expect(schema.safeParse({ preset: { builtinId: "__proto__" } }).success).toBe(false);
  });

  it("layers are optional, BY NAME, ≤ 50; args is a bounded passthrough", () => {
    expect(schema.safeParse({ preset: { name: "In" }, layers: layerNames(50) }).success).toBe(true);
    expect(schema.safeParse({ preset: { name: "In" }, layers: layerNames(51) }).success).toBe(
      false,
    );
    expect(schema.safeParse({ preset: { name: "In" }, layers: [] }).success).toBe(false); // omit instead of empty
    const dunder = jsonWithDunder('{"__proto__":{"polluted":true}}');
    expect(schema.safeParse({ preset: { name: "In" }, args: dunder }).success).toBe(false);
    expect(
      schema.safeParse({ preset: { name: "In" }, args: { blob: "x".repeat(3_000_000) } }).success,
    ).toBe(false);
  });
});

describe("write-tools: undo_run and save_version args", () => {
  it("undo_run takes NO args (one undo for the whole run — law #6)", () => {
    expect(WRITE_TOOL_ARGS_SCHEMAS.undo_run.safeParse({}).success).toBe(true);
    expect(WRITE_TOOL_ARGS_SCHEMAS.undo_run.safeParse({ runId: "run_1" }).success).toBe(false);
    expect(WRITE_TOOL_ARGS_SCHEMAS.undo_run.safeParse({ anything: 1 }).success).toBe(false);
  });

  it("save_version takes only an optional label ≤ 120", () => {
    expect(WRITE_TOOL_ARGS_SCHEMAS.save_version.safeParse({}).success).toBe(true);
    expect(WRITE_TOOL_ARGS_SCHEMAS.save_version.safeParse({ label: "x".repeat(120) }).success).toBe(
      true,
    );
    expect(WRITE_TOOL_ARGS_SCHEMAS.save_version.safeParse({ label: "x".repeat(121) }).success).toBe(
      false,
    );
    expect(WRITE_TOOL_ARGS_SCHEMAS.save_version.safeParse({ label: "" }).success).toBe(false);
    expect(WRITE_TOOL_ARGS_SCHEMAS.save_version.safeParse({ extra: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-12 write tools ("Tool catalog v3" — engine_commands / run_script / add_asset)
// ---------------------------------------------------------------------------

describe("write-tools: engine_commands args (round 12)", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.engine_commands;

  it("accepts 1..50 steps of {command, params}", () => {
    expect(
      schema.safeParse({ steps: [{ command: "comp.new", params: { name: "Main" } }] }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        steps: [
          { command: "layer.newText", params: {} },
          { command: "prop.set", params: {} },
        ],
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ steps: [] }).success).toBe(false); // min 1
    const fifty = Array.from({ length: 50 }, () => ({
      command: "markers.set",
      params: {},
    }));
    expect(schema.safeParse({ steps: fifty }).success).toBe(true);
    expect(schema.safeParse({ steps: [...fifty, fifty[0]] }).success).toBe(false); // max 50
  });

  it("command must be a dotted id; params are dunder-safe records", () => {
    expect(schema.safeParse({ steps: [{ command: "newComp", params: {} }] }).success).toBe(false);
    expect(schema.safeParse({ steps: [{ command: ".comp", params: {} }] }).success).toBe(false);
    expect(schema.safeParse({ steps: [{ command: "__proto__", params: {} }] }).success).toBe(false);
    const dunder = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(schema.safeParse({ steps: [{ command: "comp.new", params: dunder }] }).success).toBe(
      false,
    );
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});

describe("write-tools: run_script args (round 12)", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.run_script;

  it("accepts code 1..20000 chars, nothing else", () => {
    expect(schema.safeParse({ code: "app.project;" }).success).toBe(true);
    expect(schema.safeParse({ code: "x".repeat(20_000) }).success).toBe(true);
    expect(schema.safeParse({ code: "x".repeat(20_001) }).success).toBe(false);
    expect(schema.safeParse({ code: "" }).success).toBe(false);
    expect(schema.safeParse({ code: "app.project;", name: "rig" }).success).toBe(false); // strict
  });
});

describe("write-tools: add_asset args (round 12)", () => {
  const schema = WRITE_TOOL_ARGS_SCHEMAS.add_asset;

  it("kind is exactly svg; name ≤ 120 dunder-free; svg 1..50000 chars", () => {
    expect(
      schema.safeParse({ kind: "svg", name: "Logo", svg: '<svg><path d="M0 0"/></svg>' }).success,
    ).toBe(true);
    expect(schema.safeParse({ kind: "png", name: "Logo", svg: "<svg/>" }).success).toBe(false);
    expect(schema.safeParse({ kind: "svg", svg: "<svg/>" }).success).toBe(false); // name required
    expect(schema.safeParse({ kind: "svg", name: "__proto__", svg: "<svg/>" }).success).toBe(false);
    expect(schema.safeParse({ kind: "svg", name: "x".repeat(121), svg: "<svg/>" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ kind: "svg", name: "L", svg: "x".repeat(50_000) }).success).toBe(
      true,
    );
    expect(schema.safeParse({ kind: "svg", name: "L", svg: "x".repeat(50_001) }).success).toBe(
      false,
    );
    expect(schema.safeParse({ kind: "svg", name: "L", svg: "" }).success).toBe(false);
  });
});

describe("write-tools: round-12 badges and intent hints", () => {
  it("all three round-12 tools carry the medium risk floor", () => {
    for (const id of ["engine_commands", "run_script", "add_asset"] as const) {
      const tool = WRITE_TOOLS.find((entry) => entry.id === id);
      expect(tool, id).toBeDefined();
      expect(tool?.risk, id).toBe("medium");
      expect(tool?.kind, id).toBe("write");
      expect(tool?.returns, id).toBe("proposed-batch");
    }
  });

  it("run_script pins its §8.6 intent hint; the others leave the gateway fallback", () => {
    const runScript = WRITE_TOOLS.find((entry) => entry.id === "run_script");
    expect(runScript?.intent).toBe("animate");
    const engineCommands = WRITE_TOOLS.find((entry) => entry.id === "engine_commands");
    expect(engineCommands?.intent).toBeUndefined();
    const addAsset = WRITE_TOOLS.find((entry) => entry.id === "add_asset");
    expect(addAsset?.intent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dunder-safe helpers (exported for M5 peers — plan compiler, executor)
// ---------------------------------------------------------------------------

describe("write-tools: dunder-safe helpers (F-1 class)", () => {
  it("isDunderKey flags exactly the three dangerous keys", () => {
    expect(DUNDER_KEYS).toEqual(["__proto__", "constructor", "prototype"]);
    expect(isDunderKey("__proto__")).toBe(true);
    expect(isDunderKey("constructor")).toBe(true);
    expect(isDunderKey("prototype")).toBe(true);
    expect(isDunderKey("Headline")).toBe(false);
    expect(isDunderKey("my__proto__field")).toBe(false);
  });

  it("firstDunderKeyLocation finds nested dunder keys with a location", () => {
    expect(firstDunderKeyLocation({ a: { b: 1 } })).toBeUndefined();
    expect(firstDunderKeyLocation(jsonWithDunder('{"a":{"__proto__":1}}'))).toBe("a.__proto__");
    expect(firstDunderKeyLocation(jsonWithDunder('[0,{"constructor":1}]'))).toBe("[1].constructor");
    expect(firstDunderKeyLocation(jsonWithDunder('{"prototype":1}'))).toBe("prototype");
  });

  it("hasNoDunderKeys is the boolean refinement peers reuse", () => {
    expect(hasNoDunderKeys({ deep: { list: [1, { ok: true }] } })).toBe(true);
    expect(hasNoDunderKeys(jsonWithDunder('{"deep":{"list":[1,{"__proto__":1}]}}'))).toBe(false);
  });

  it("hasNoDunderSegments checks whole path segments, not substrings", () => {
    expect(hasNoDunderSegments("transform/opacity")).toBe(true);
    expect(hasNoDunderSegments("effects[0].filters[1].radius")).toBe(true);
    expect(hasNoDunderSegments("__proto__")).toBe(false);
    expect(hasNoDunderSegments("transform.__proto__.x")).toBe(false);
    expect(hasNoDunderSegments("effects[0].constructor")).toBe(false);
    expect(hasNoDunderSegments("my__proto__field")).toBe(true);
  });

  it("isJsonSerializableValue: JSON-only values, cycles rejected", () => {
    expect(isJsonSerializableValue(null)).toBe(true);
    expect(isJsonSerializableValue("s")).toBe(true);
    expect(isJsonSerializableValue(false)).toBe(true);
    expect(isJsonSerializableValue(1.5)).toBe(true);
    expect(isJsonSerializableValue(Number.NaN)).toBe(false);
    expect(isJsonSerializableValue(undefined)).toBe(false);
    expect(isJsonSerializableValue(() => 1)).toBe(false);
    expect(isJsonSerializableValue(10n)).toBe(false);
    expect(isJsonSerializableValue(new Date(0))).toBe(false);
    expect(isJsonSerializableValue(new Map())).toBe(false);
    expect(isJsonSerializableValue({ a: [1, { b: null }] })).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonSerializableValue(cyclic)).toBe(false);
  });

  it("shared subobjects (DAGs) stay serializable — only true cycles fail", () => {
    const shared = { leaf: true };
    expect(isJsonSerializableValue({ a: shared, b: shared })).toBe(true);
    expect(hasNoDunderKeys({ a: shared, b: shared })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Result envelope (every write tool returns this — §8.4 rule 1)
// ---------------------------------------------------------------------------

describe("write-tools: proposed-batch result envelope", () => {
  it("accepts a valid envelope", () => {
    const parsed = WRITE_TOOL_RESULT_SCHEMA.safeParse(validResult());
    expect(parsed.success).toBe(true);
  });

  it("is strict and bounds label/steps/note", () => {
    expect(WRITE_TOOL_RESULT_SCHEMA.safeParse({ ...validResult(), executed: true }).success).toBe(
      false,
    );
    expect(
      WRITE_TOOL_RESULT_SCHEMA.safeParse({
        ...validResult(),
        proposedBatch: { label: "Agent: x", steps: [] },
      }).success,
    ).toBe(false);
    expect(
      WRITE_TOOL_RESULT_SCHEMA.safeParse({
        ...validResult(),
        proposedBatch: { label: "x".repeat(281), steps: validResult().proposedBatch },
      }).success,
    ).toBe(false);
    expect(WRITE_TOOL_RESULT_SCHEMA.safeParse({ ...validResult(), note: "" }).success).toBe(false);
  });

  it("caps the batch at 100 steps and 2 MB", () => {
    const steps = Array.from({ length: 100 }, () => ({
      command: "prop.set",
      params: { path: "transform/opacity", value: 1 },
    }));
    expect(
      WRITE_TOOL_RESULT_SCHEMA.safeParse({
        proposedBatch: { label: "Agent: bulk", steps },
        note: PROPOSED_BATCH_NOTE,
      }).success,
    ).toBe(true);
    expect(
      WRITE_TOOL_RESULT_SCHEMA.safeParse({
        proposedBatch: { label: "Agent: bulk", steps: [...steps, steps[0]] },
        note: PROPOSED_BATCH_NOTE,
      }).success,
    ).toBe(false);
    const heavy = Array.from({ length: 50 }, () => ({
      command: "prop.set",
      params: { path: "transform/opacity", blob: "x".repeat(50_000) },
    }));
    expect(
      WRITE_TOOL_RESULT_SCHEMA.safeParse({
        proposedBatch: { label: "Agent: heavy", steps: heavy },
        note: PROPOSED_BATCH_NOTE,
      }).success,
    ).toBe(false); // > 2 MB serialized
  });

  it("rejects dunder keys inside step params (F-1 class at the result seam)", () => {
    const dunder = jsonWithDunder('{"path":"transform/opacity","__proto__":{"polluted":true}}');
    expect(
      WRITE_TOOL_RESULT_SCHEMA.safeParse({
        proposedBatch: { label: "Agent: x", steps: [{ command: "prop.set", params: dunder }] },
        note: PROPOSED_BATCH_NOTE,
      }).success,
    ).toBe(false);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("PROPOSED_BATCH_NOTE is a valid, bounded note", () => {
    expect(PROPOSED_BATCH_NOTE.length).toBeGreaterThan(0);
    expect(PROPOSED_BATCH_NOTE.length).toBeLessThanOrEqual(1000);
    expect(WRITE_TOOL_RESULT_SCHEMA.safeParse(validResult()).success).toBe(true); // uses the note
  });
});

describe("write-tools: 2 MB total-args bound (§8.5)", () => {
  it("set_properties args are bounded to 2 MB in total", () => {
    const bigValue = "x".repeat(MAX_WRITE_TOOL_ARGS_BYTES);
    expect(
      WRITE_TOOL_ARGS_SCHEMAS.set_properties.safeParse({
        layers: [{ name: "L" }],
        properties: [{ path: "transform/opacity", value: bigValue }],
      }).success,
    ).toBe(false);
  });

  it("set_keyframes and apply_preset args are bounded to 2 MB in total", () => {
    expect(
      WRITE_TOOL_ARGS_SCHEMAS.set_keyframes.safeParse({
        layers: [{ name: "L" }],
        propertyPath: "transform/scale",
        keys: [{ timeSeconds: 0, value: "x".repeat(MAX_WRITE_TOOL_ARGS_BYTES) }],
      }).success,
    ).toBe(false);
    expect(
      WRITE_TOOL_ARGS_SCHEMAS.apply_preset.safeParse({
        preset: { name: "In" },
        args: { blob: "x".repeat(MAX_WRITE_TOOL_ARGS_BYTES) },
      }).success,
    ).toBe(false);
  });

  it("MAX_WRITE_TOOL_ARGS_BYTES equals the engine.batch 2 MB payload cap", () => {
    expect(MAX_WRITE_TOOL_ARGS_BYTES).toBe(2 * 1024 * 1024);
  });
});
