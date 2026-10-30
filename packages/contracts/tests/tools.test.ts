import { describe, expect, it } from "vitest";

import {
  IMAGE_SIZES,
  MIN_AUDIO_DURATION_SECONDS,
  TOOL_CATALOG,
  TOOL_IDS,
  TOOL_LIST,
  type ToolDefinition,
  getTool,
  isReadTool,
  isWriteTool,
} from "../src/tools.js";

/** §8.4 table, exact order — the M5 tools (byte-compatible, unchanged). */
const SPEC_TOOLS: readonly { id: string; kind: "read" | "write" }[] = [
  { id: "studio.get_context", kind: "read" },
  { id: "studio.list_layers", kind: "read" },
  { id: "studio.get_properties", kind: "read" },
  { id: "studio.plan_edit", kind: "read" },
  { id: "studio.render_preview", kind: "read" },
  { id: "studio.create_composition", kind: "write" },
  { id: "studio.create_text", kind: "write" },
  { id: "studio.set_properties", kind: "write" },
  { id: "studio.add_effect", kind: "write" },
  { id: "studio.set_keyframes", kind: "write" },
  { id: "studio.apply_preset", kind: "write" },
  { id: "studio.undo_run", kind: "write" },
  { id: "studio.save_version", kind: "write" },
];

/** Round-12 "Tool catalog v3" additions (docs/research/round12-design.md), appended
 * after the §8.4 table: writes first (they auto-register from write-tools.ts),
 * then the client-executed reads/generative tools. */
const ROUND12_TOOLS: readonly { id: string; kind: "read" | "write" }[] = [
  { id: "studio.engine_commands", kind: "write" },
  { id: "studio.run_script", kind: "write" },
  { id: "studio.add_asset", kind: "write" },
  { id: "studio.list_commands", kind: "read" },
  { id: "studio.describe_command", kind: "read" },
  { id: "studio.web_search", kind: "read" },
  { id: "studio.render_audio", kind: "read" },
  { id: "studio.generate_image", kind: "read" },
];

const ALL_TOOLS: readonly { id: string; kind: "read" | "write" }[] = [
  ...SPEC_TOOLS,
  ...ROUND12_TOOLS,
];

const RAW_COMMAND_ID = /\b(comp|layer|prop|edit|render|ui|project|engine)\.[a-z]/i;

/** Valid args per tool, for the args-stub parse round-trip. */
const VALID_ARGS: Record<string, unknown> = {
  "studio.get_context": { include: ["projectSummary", "selection"] },
  "studio.list_layers": { compId: "c1", depth: 2 },
  "studio.get_properties": { layerIds: ["l1", "l2"], paths: ["transform/scale"] },
  "studio.plan_edit": { goal: "Animate the headline in, then settle" },
  "studio.render_preview": { compId: "c1", timeSeconds: 0.45, maxWidth: 1200 },
  "studio.create_composition": {
    name: "Main",
    width: 1920,
    height: 1080,
    frameRate: 30,
    durationSeconds: 10,
  },
  "studio.create_text": {
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
  },
  "studio.set_properties": {
    layers: [{ name: "Headline" }],
    properties: [{ path: "transform/opacity", value: 100 }],
  },
  "studio.add_effect": {
    layers: [{ name: "Headline" }],
    effect: { name: "Gaussian Blur" },
    params: { radius: 4 },
  },
  "studio.set_keyframes": {
    layers: [{ name: "Headline" }],
    propertyPath: "transform/scale",
    keys: [
      { timeSeconds: 0, value: 20, interpolation: "bezier" },
      { timeSeconds: 0.45, value: 110, interpolation: "hold" },
      { timeSeconds: 0.7, value: 100, interpolation: "linear" },
    ],
  },
  "studio.apply_preset": {
    preset: { name: "Kinetic In" },
    layers: [{ name: "Headline" }],
    args: { intensity: 0.8 },
  },
  "studio.undo_run": {},
  "studio.save_version": { label: "Before sound pass" },
  // -- round-12 "Tool catalog v3" ---------------------------------------------
  "studio.list_commands": { category: "mask" },
  "studio.describe_command": { command: "mask.new" },
  "studio.web_search": { query: "tone.js offline rendering example", maxResults: 5 },
  "studio.render_audio": {
    name: "Whoosh",
    code: "const synth = new Tone.NoiseSynth().toDestination();",
    duration: 2,
  },
  "studio.generate_image": { prompt: "night city skyline, cinematic", size: "1536x1024" },
  "studio.engine_commands": {
    steps: [{ command: "comp.new", params: { name: "Main" } }],
  },
  "studio.run_script": { code: 'app.beginUndoGroup("agent"); app.endUndoGroup();' },
  "studio.add_asset": {
    kind: "svg",
    name: "Logo",
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10H0z"/></svg>',
  },
};

/** One invalid mutation per tool. */
const INVALID_ARGS: Record<string, unknown> = {
  "studio.get_context": { include: ["not-a-block"] },
  "studio.list_layers": { depth: 0 },
  "studio.get_properties": { layerIds: [] },
  "studio.plan_edit": { goal: "" },
  "studio.render_preview": { maxWidth: 4096 }, // §8.3: 1200 px cap
  "studio.create_composition": { name: "Main", width: 0, height: 1080 }, // width < 1
  "studio.create_text": { text: "Hello", fill: "red" }, // not a #rrggbb color
  "studio.set_properties": { layers: [{ name: "Headline" }] }, // missing properties
  "studio.add_effect": {
    layers: [{ name: "Headline" }],
    effect: { name: "C:/plugins/blur.plugin" }, // plugin path, not a human name
  },
  "studio.set_keyframes": {
    layers: [{ name: "Headline" }],
    propertyPath: "transform/scale",
    keys: [], // min 1
  },
  "studio.apply_preset": {
    preset: { name: "Kinetic In", builtinId: "kinetic-in" }, // both, not exactly one
  },
  "studio.undo_run": { runId: "run_1" }, // NO args allowed (strict)
  "studio.save_version": { label: "x".repeat(121) }, // label ≤ 120
  // -- round-12 "Tool catalog v3" ---------------------------------------------
  "studio.list_commands": { category: "" }, // min 1 when present
  "studio.describe_command": {}, // `command` required
  "studio.web_search": { query: "x", maxResults: 6 }, // 1..5 only
  "studio.render_audio": { name: "W", code: "" }, // min 1 (code ≤ 20000)
  "studio.generate_image": { prompt: "x", size: "512x512" }, // not a listed size
  "studio.engine_commands": { steps: [] }, // 1..50 steps
  "studio.run_script": { code: "x".repeat(20_001) }, // ≤ 20000 chars
  "studio.add_asset": { kind: "png", name: "Icon", svg: "<svg/>" }, // kind must be svg
};

describe("tools: §8.4 catalog completeness", () => {
  it("has exactly the 13 spec tools in spec order (§8.4 says ~12, lists 13)", () => {
    // PRESERVED (round 12): the §8.4 thirteen stay, in spec order, at the HEAD
    // of both lists — additions are append-only behind them.
    expect([...TOOL_IDS].slice(0, SPEC_TOOLS.length)).toEqual(SPEC_TOOLS.map((t) => t.id));
    expect(TOOL_LIST.slice(0, SPEC_TOOLS.length).map((t) => t.id)).toEqual(
      SPEC_TOOLS.map((t) => t.id),
    );
  });

  it("round-12 catalog v3 appends 8 tools behind the spec 13, same order everywhere", () => {
    expect([...TOOL_IDS]).toEqual(ALL_TOOLS.map((t) => t.id));
    expect(TOOL_LIST.map((t) => t.id)).toEqual([...TOOL_IDS]);
    expect(Object.keys(TOOL_CATALOG)).toHaveLength(ALL_TOOLS.length);
  });

  it("ids are unique and studio-namespaced", () => {
    expect(new Set(TOOL_IDS).size).toBe(TOOL_IDS.length);
    for (const id of TOOL_IDS) expect(id.startsWith("studio.")).toBe(true);
  });

  it("kinds match the spec read/write split exactly (13 + 8 = 21 tools)", () => {
    for (const spec of ALL_TOOLS) {
      const tool = TOOL_CATALOG[spec.id as keyof typeof TOOL_CATALOG];
      expect(tool.kind, spec.id).toBe(spec.kind);
      expect(isWriteTool(spec.id as keyof typeof TOOL_CATALOG)).toBe(spec.kind === "write");
      expect(isReadTool(spec.id as keyof typeof TOOL_CATALOG)).toBe(spec.kind === "read");
    }
  });

  it("every write tool is flagged write, has a risk, and proposes a batch", () => {
    const writeTools = TOOL_LIST.filter((t) => t.kind === "write");
    expect(writeTools.map((t) => t.id)).toEqual(
      ALL_TOOLS.filter((t) => t.kind === "write").map((t) => t.id),
    );
    for (const tool of TOOL_LIST) {
      expect(["low", "medium", "high"], `${tool.id} risk`).toContain(tool.risk);
      if (tool.kind === "write") {
        expect(tool.returns, `${tool.id} must be proposal-only`).toBe("proposed-batch");
      } else {
        expect(tool.returns, `${tool.id} must return data`).toBe("data");
      }
    }
  });

  it("descriptions are model-facing: non-empty, no raw command ids", () => {
    for (const tool of TOOL_LIST) {
      expect(tool.description.length, tool.id).toBeGreaterThan(40);
      expect(RAW_COMMAND_ID.test(tool.description), `${tool.id} leaks a command id`).toBe(false);
    }
    // write tools must tell the model they only propose changes
    for (const tool of TOOL_LIST.filter((t) => t.kind === "write")) {
      expect(/propose|proposed/i.test(tool.description), tool.id).toBe(true);
    }
    // the model must never see the executor or the registry
    for (const tool of TOOL_LIST) {
      expect(tool.description.toLowerCase(), tool.id).not.toContain("engine.execute");
    }
  });

  it("getTool returns the catalog entry and never falls back", () => {
    const tool = getTool("studio.plan_edit") as ToolDefinition;
    expect(tool.kind).toBe("read");
    expect(getTool("studio.delete_layer")).toBeUndefined();
  });
});

describe("tools: args stubs accept valid and reject invalid args", () => {
  for (const spec of SPEC_TOOLS) {
    it(`${spec.id} args round-trip`, () => {
      const tool = getTool(spec.id) as ToolDefinition;
      expect(
        tool.args.safeParse(VALID_ARGS[spec.id]).success,
        JSON.stringify(VALID_ARGS[spec.id]),
      ).toBe(true);
      const bad = tool.args.safeParse(INVALID_ARGS[spec.id]);
      expect(bad.success, `${spec.id} should reject ${JSON.stringify(INVALID_ARGS[spec.id])}`).toBe(
        false,
      );
    });
  }

  // Round-12 additions run the SAME round-trip (same pattern, appended).
  for (const spec of ROUND12_TOOLS) {
    it(`${spec.id} args round-trip (round 12)`, () => {
      const tool = getTool(spec.id) as ToolDefinition;
      expect(
        tool.args.safeParse(VALID_ARGS[spec.id]).success,
        JSON.stringify(VALID_ARGS[spec.id]),
      ).toBe(true);
      const bad = tool.args.safeParse(INVALID_ARGS[spec.id]);
      expect(bad.success, `${spec.id} should reject ${JSON.stringify(INVALID_ARGS[spec.id])}`).toBe(
        false,
      );
    });
  }
});

describe("tools: §8.3 budgets encoded in stubs", () => {
  it("render_preview caps frames at 1200 px", () => {
    const tool = getTool("studio.render_preview") as ToolDefinition;
    expect(tool.args.safeParse({ maxWidth: 1200 }).success).toBe(true);
    expect(tool.args.safeParse({ maxWidth: 1201 }).success).toBe(false);
  });

  it("get_properties reads at most 12 layers (§8.3)", () => {
    const tool = getTool("studio.get_properties") as ToolDefinition;
    const thirteen = Array.from({ length: 13 }, (_, i) => `l${i}`);
    expect(tool.args.safeParse({ layerIds: thirteen }).success).toBe(false);
  });

  it("list_layers defaults to depth 2 (§8.3 layer.tree)", () => {
    const tool = getTool("studio.list_layers") as ToolDefinition;
    const parsed = tool.args.parse({}) as { depth: number };
    expect(parsed.depth).toBe(2);
  });
});

describe("tools: round-12 budgets encoded in stubs (catalog v3)", () => {
  it("web_search defaults maxResults to 5 and accepts only 1..5", () => {
    const tool = getTool("studio.web_search") as ToolDefinition;
    const parsed = tool.args.parse({ query: "tone.js docs" }) as { maxResults: number };
    expect(parsed.maxResults).toBe(5);
    expect(tool.args.safeParse({ query: "x", maxResults: 1 }).success).toBe(true);
    expect(tool.args.safeParse({ query: "x", maxResults: 0 }).success).toBe(false);
  });

  it("render_audio caps code at 20000 chars and duration at 0.1-60 s", () => {
    const tool = getTool("studio.render_audio") as ToolDefinition;
    expect(tool.args.safeParse({ name: "W", code: "x".repeat(20_000) }).success).toBe(true);
    expect(tool.args.safeParse({ name: "W", code: "x".repeat(20_001) }).success).toBe(false);
    expect(
      tool.args.safeParse({ name: "W", code: "x", duration: MIN_AUDIO_DURATION_SECONDS }).success,
    ).toBe(true);
    expect(tool.args.safeParse({ name: "W", code: "x", duration: 60.1 }).success).toBe(false);
    expect(tool.args.safeParse({ name: "__proto__", code: "x" }).success).toBe(false);
  });

  it("generate_image accepts only the three listed sizes", () => {
    const tool = getTool("studio.generate_image") as ToolDefinition;
    for (const size of IMAGE_SIZES) {
      expect(tool.args.safeParse({ prompt: "x", size }).success, size).toBe(true);
    }
    expect(tool.args.safeParse({ prompt: "x", size: "800x600" }).success).toBe(false);
  });

  it("list_commands/describe_command reject dunder ids and strict unknowns", () => {
    const list = getTool("studio.list_commands") as ToolDefinition;
    expect(list.args.safeParse({ category: "mask" }).success).toBe(true);
    expect(list.args.safeParse({}).success).toBe(true); // filter is optional
    expect(list.args.safeParse({ category: "__proto__" }).success).toBe(false);
    expect(list.args.safeParse({ filter: "mask" }).success).toBe(false); // strict
    const describe = getTool("studio.describe_command") as ToolDefinition;
    expect(describe.args.safeParse({ command: "mask.new" }).success).toBe(true);
    expect(describe.args.safeParse({ command: "constructor" }).success).toBe(false);
    expect(describe.args.safeParse({}).success).toBe(false); // required
  });
});
