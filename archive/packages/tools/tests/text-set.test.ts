// text-set.test.ts — text_set (§6 row 8): create+fit, rewrite, §10.2 name gates, §6.1
// colour table, overflow error shape with the §6.1 hint, strict schema. All engine seams
// are local recording fakes (no engine, no db, no network — deterministic, <5 s).

import { describe, expect, it } from "vitest";
import { parseToolArgs } from "../src/kit.js";
import {
  isMachineLayerName,
  isRoleLayerName,
  textSet,
  textSetArgs,
  toEngineColor,
} from "../src/tools/text-set.js";
import type { TextSetArgs } from "../src/tools/text-set.js";
import type {
  EngineCommand,
  EngineCommandOutcome,
  EngineCommandReport,
  EngineLayerSummary,
  ToolContext,
  ToolErrorCode,
} from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// A recording engine: handlers answer per command id; every seam call is captured.
// ---------------------------------------------------------------------------

/** The command reply payload a conforming adapter attaches under `result`. */
type RichReport = EngineCommandReport & { result?: unknown };
type ExecOutcome =
  | { readonly ok: true; readonly value: RichReport }
  | {
      readonly ok: false;
      readonly code: ToolErrorCode;
      readonly message: string;
      readonly hint?: string;
      readonly retryable?: boolean;
    };
type Handler = (cmd: EngineCommand) => ExecOutcome;

interface RecordedCall {
  readonly kind: "execute" | "batch" | "listLayers" | "render" | "inspect";
  readonly cmd?: EngineCommand;
  readonly cmds?: readonly EngineCommand[];
  readonly options?: { readonly transaction?: unknown; readonly signal?: unknown };
}

function makeEngine(handler: Handler, layers: readonly EngineLayerSummary[]) {
  const calls: RecordedCall[] = [];
  const engine: ToolContext["engine"] = {
    async execute(cmd, options) {
      calls.push({ kind: "execute", cmd, options });
      return handler(cmd);
    },
    async batch(cmds, options) {
      calls.push({ kind: "batch", cmds, options });
      const outcomes: EngineCommandOutcome[] = [];
      let revision = 0;
      for (const [index, cmd] of cmds.entries()) {
        const result = handler(cmd);
        if (!result.ok) {
          return result;
        }
        revision = result.value.revision;
        outcomes.push({ index, commandId: cmd.id, ok: true });
      }
      return { ok: true, value: { revision, outcomes } };
    },
    async render() {
      calls.push({ kind: "render" });
      return { ok: true, value: { image: new Uint8Array(), widthPx: 64, heightPx: 64 } };
    },
    async inspect() {
      calls.push({ kind: "inspect" });
      return { ok: true, value: { revision: 1, widthPx: 1080, heightPx: 1080, layers: [] } };
    },
    async listLayers() {
      calls.push({ kind: "listLayers" });
      return { ok: true, value: layers };
    },
  };
  return { engine, calls };
}

/** A layered document: one fitted text layer, ids and revisions stable across tests. */
const textLayer = (id: string, name: string, kind = "Type"): EngineLayerSummary => ({
  layerId: id,
  name,
  kind,
  visible: true,
});

/** The happy path: type.create → layer 7 @rev 10, layout.fitText → 48 pt/2 lines @rev 11. */
const happyCreateHandler: Handler = (cmd) => {
  switch (cmd.id) {
    case "type.create":
      return {
        ok: true,
        value: { revision: 10, result: { layer: 7, bounds: [72, 732, 972, 176] } },
      };
    case "layout.fitText":
      return {
        ok: true,
        value: {
          revision: 11,
          result: { layer: 7, size: 48, lines: 2, overflow: false, bounds: [72, 732, 920, 90] },
        },
      };
    case "type.edit":
    case "type.setStyle":
      return { ok: true, value: { revision: 12, result: { layer: 3 } } };
    default:
      return {
        ok: false,
        code: "engine_unavailable",
        message: `no fake handler for ${cmd.id}`,
        retryable: false,
      };
  }
};

const mutatingCalls = (calls: readonly RecordedCall[]): readonly RecordedCall[] =>
  calls.filter((c) => c.kind === "execute" || c.kind === "batch");

/** Runs text_set and fails the test with the error envelope when it does not succeed. */
async function runOk(ctx: ToolContext, args: TextSetArgs, signal = freshSignal()) {
  const result = await textSet.run(ctx, args, signal);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result;
}

/** Runs text_set and fails the test when it unexpectedly succeeds. */
async function runErr(ctx: ToolContext, args: TextSetArgs) {
  const result = await textSet.run(ctx, args, freshSignal());
  if (result.ok) {
    throw new Error(`expected an error, got ok: ${result.summary}`);
  }
  return result;
}

const createArgs = {
  mode: "create" as const,
  name: "Headline",
  text: "Latte art, done right",
  bounds: [72, 732, 936, 176] as [number, number, number, number],
  font: "Inter",
  size: 72,
  color: "#3B2A20",
  align: "center" as const,
};

// ---------------------------------------------------------------------------
// create: type.create → layout.fitText (§9.3)
// ---------------------------------------------------------------------------

describe("text_set create", () => {
  it("creates via type.create then fits via layout.fitText, reporting the fit facts", async () => {
    const signal = freshSignal();
    const { engine, calls } = makeEngine(happyCreateHandler, []);
    const ctx = makeFakeContext({ engine });

    const result = await runOk(ctx, createArgs, signal);
    expect(JSON.parse(result.summary)).toEqual({
      layerId: 7,
      name: "Headline",
      chosenSize: 48,
      lines: 2,
      overflow: false,
      warnings: [],
    });
    expect(result.documentRevision).toBe(11);

    const create = calls.find((c) => c.cmd?.id === "type.create");
    expect(create?.cmd?.params).toEqual({
      name: "Headline",
      text: "Latte art, done right",
      box: [72, 732, 936, 176],
      font: "Inter",
      size: 72,
      color: "#3b2a20",
      align: "center",
    });
    expect(create?.options?.signal).toBe(signal);

    const fit = calls.find((c) => c.cmd?.id === "layout.fitText");
    expect(fit?.cmd?.params).toEqual({
      layer: 7,
      bounds: [72, 732, 936, 176],
      minSize: 12,
      maxSize: 72,
    });
    expect(fit?.options?.signal).toBe(signal);
  });

  it("omits size/maxSize when none was requested (engine fits the layer's own size)", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, []);
    const ctx = makeFakeContext({ engine });

    const result = await runOk(ctx, {
      mode: "create",
      name: "Caption",
      text: "Sip slowly",
      bounds: [8, 8, 120, 32],
      font: "Inter",
    });
    expect(JSON.parse(result.summary)).toEqual({
      layerId: 7,
      name: "Caption",
      chosenSize: 48,
      lines: 2,
      overflow: false,
      warnings: [],
    });
    const create = calls.find((c) => c.cmd?.id === "type.create");
    expect(create?.cmd?.params).toEqual({
      name: "Caption",
      text: "Sip slowly",
      box: [8, 8, 120, 32],
      font: "Inter",
    });
    const fit = calls.find((c) => c.cmd?.id === "layout.fitText");
    expect(fit?.cmd?.params).toEqual({ layer: 7, bounds: [8, 8, 120, 32], minSize: 12 });
  });

  it("never fits below a requested caption size (minSize follows the request)", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, []);
    const ctx = makeFakeContext({ engine });

    await runOk(ctx, { ...createArgs, name: "Caption", size: 8 });
    const fit = calls.find((c) => c.cmd?.id === "layout.fitText");
    expect(fit?.cmd?.params).toMatchObject({ minSize: 8, maxSize: 8 });
  });

  it("rejects machine-generated names before touching the engine", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, []);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, { ...createArgs, name: "Layer 3" });
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("machine-generated");
    expect(failure.hint).toContain("§10.2");
    expect(calls).toHaveLength(0);
  });

  it("rejects names that are not §10.2 semantic role names", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, []);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, { ...createArgs, name: "headline" });
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("semantic role name");
    expect(calls).toHaveLength(0);
  });

  it("refuses to duplicate an existing §10.1 name", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, [textLayer("2", "Headline")]);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, createArgs);
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("already exists");
    expect(failure.hint).toContain('mode "edit"');
    expect(mutatingCalls(calls)).toHaveLength(0);
  });

  it("rejects a font outside the workspace set with an install hint (§10.2)", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, []);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, { ...createArgs, font: "Papyrus" });
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("workspace font set");
    expect(failure.hint).toContain("Install");
    expect(failure.hint).toContain("Inter");
    expect(calls).toHaveLength(0);
  });

  it("maps an overflow report to text_overflow with the exact px and the §6.1 hint", async () => {
    const handler: Handler = (cmd) => {
      if (cmd.id === "type.create") {
        return { ok: true, value: { revision: 10, result: { layer: 7 } } };
      }
      return {
        ok: true,
        value: {
          revision: 11,
          result: {
            layer: 7,
            size: 12,
            lines: 8,
            overflow: true,
            bounds: [72, 732, 938, 774.5],
            overflowPx: 42.5,
            overflowChars: 11,
          },
        },
      };
    };
    const { engine } = makeEngine(handler, []);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, { ...createArgs, size: 24, text: "A".repeat(60) });
    expect(failure.code).toBe("text_overflow");
    expect(failure.message).toContain("42.5 px");
    expect(failure.message).toContain("11 chars too many at 12 pt");
    expect(failure.message).toContain("Headline");
    expect(failure.hint).toBe("shorten to 49 chars or reduce size to 9pt");
    expect(failure.retryable).toBe(false);
  });

  it("falls back to a size-estimate warning when layout.fitText is unavailable", async () => {
    const handler: Handler = (cmd) => {
      if (cmd.id === "type.create") {
        return { ok: true, value: { revision: 10, result: { layer: 7 } } };
      }
      return {
        ok: false,
        code: "engine_unavailable",
        message: "command layout.fitText is not registered",
        retryable: false,
      };
    };
    const { engine } = makeEngine(handler, []);
    const ctx = makeFakeContext({ engine });

    const result = await runOk(ctx, { ...createArgs, size: 24 });
    expect(result.warnings?.length).toBe(1);
    expect(result.warnings?.[0]).toMatch(/layout\.fitText unavailable \(engine_unavailable\)/);
    expect(result.warnings?.[0]).toMatch(/estimate/);
    expect(result.documentRevision).toBe(10);
    expect(JSON.parse(result.summary)).toEqual({
      layerId: 7,
      name: "Headline",
      chosenSize: 24,
      lines: null,
      overflow: null,
      warnings: result.warnings,
    });
  });

  it("falls back to a warning when the fit reply carries no usable metrics", async () => {
    const handler: Handler = (cmd) => {
      if (cmd.id === "type.create") {
        return { ok: true, value: { revision: 10, result: { layer: 7 } } };
      }
      return { ok: true, value: { revision: 11 } };
    };
    const { engine } = makeEngine(handler, []);
    const ctx = makeFakeContext({ engine });

    const result = await runOk(ctx, { ...createArgs, size: 24 });
    expect(result.warnings?.[0]).toMatch(/without usable fit metrics/);
    expect(result.documentRevision).toBe(11);
    const summary = JSON.parse(result.summary) as { chosenSize: number | null };
    expect(summary.chosenSize).toBe(24);
  });

  it("passes a type.create engine failure through unchanged", async () => {
    const handler: Handler = () => ({
      ok: false,
      code: "engine_unavailable",
      message: "no document is open",
      retryable: true,
    });
    const { engine } = makeEngine(handler, []);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, createArgs);
    expect(failure.code).toBe("engine_unavailable");
    expect(failure.message).toBe("no document is open");
    expect(failure.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// edit: type.edit (+ type.setStyle for align), one transactional batch (§6.2)
// ---------------------------------------------------------------------------

describe("text_set edit", () => {
  it("rewrites text only: one transactional type.edit, no style run", async () => {
    const signal = freshSignal();
    const { engine, calls } = makeEngine(happyCreateHandler, [textLayer("3", "Headline")]);
    const ctx = makeFakeContext({ engine });

    const result = await runOk(
      ctx,
      { mode: "edit", layer: { layerName: "Headline" }, text: "Fresh words" },
      signal,
    );
    expect(JSON.parse(result.summary)).toEqual({
      layerId: 3,
      name: "Headline",
      chosenSize: null,
      lines: null,
      overflow: null,
      warnings: [],
    });
    expect(result.documentRevision).toBe(12);

    const batch = calls.find((c) => c.kind === "batch");
    expect(batch?.cmds).toEqual([{ id: "type.edit", params: { layer: 3, text: "Fresh words" } }]);
    expect(batch?.options?.transaction).toBe(true);
    expect(batch?.options?.signal).toBe(signal);
  });

  it("applies size/color/font as one full-text run and align via type.setStyle", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, [textLayer("3", "Headline")]);
    const ctx = makeFakeContext({ engine });

    await runOk(ctx, {
      mode: "edit",
      layer: { layerName: "Headline" },
      text: "New copy",
      size: 24,
      color: "rgb(255,0,170)",
      font: "Inter",
      align: "right",
    });
    expect(calls.find((c) => c.kind === "batch")?.cmds).toEqual([
      {
        id: "type.edit",
        params: {
          layer: 3,
          text: "New copy",
          runs: [{ start: 0, end: 8, size: 24, color: "#ff00aa", font: "Inter" }],
        },
      },
      { id: "type.setStyle", params: { layer: 3, align: "right" } },
    ]);
  });

  it("sends only type.setStyle when nothing but the alignment changes", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, [textLayer("3", "Headline")]);
    const ctx = makeFakeContext({ engine });

    await runOk(ctx, { mode: "edit", layer: { layerId: "3" }, align: "left" });
    expect(calls.find((c) => c.kind === "batch")?.cmds).toEqual([
      { id: "type.setStyle", params: { layer: 3, align: "left" } },
    ]);
  });

  it("styles every character when the text is not replaced (clamped run end)", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, [textLayer("3", "Headline")]);
    const ctx = makeFakeContext({ engine });

    await runOk(ctx, { mode: "edit", layer: { layerId: "3" }, size: 18 });
    expect(calls.find((c) => c.kind === "batch")?.cmds).toEqual([
      { id: "type.edit", params: { layer: 3, runs: [{ start: 0, end: 1_000_000, size: 18 }] } },
    ]);
  });

  it("reports an ambiguous layer_name with the candidate ids (§6.1)", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, [
      textLayer("3", "Headline"),
      textLayer("9", "Headline"),
    ]);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, {
      mode: "edit",
      layer: { layerName: "Headline" },
      text: "x",
    });
    expect(failure.code).toBe("ambiguous_layer");
    expect(failure.message).toContain("2 layers");
    expect(failure.hint).toContain("3");
    expect(failure.hint).toContain("9");
    expect(mutatingCalls(calls)).toHaveLength(0);
  });

  it("reports layer_not_found for an unresolvable reference (by name and by id)", async () => {
    const { engine } = makeEngine(happyCreateHandler, []);
    const ctx = makeFakeContext({ engine });

    const byName = await runErr(ctx, { mode: "edit", layer: { layerName: "Headline" }, text: "x" });
    expect(byName.code).toBe("layer_not_found");
    expect(byName.hint).toContain("Headline");

    const byId = await runErr(ctx, { mode: "edit", layer: { layerId: "77" }, text: "x" });
    expect(byId.code).toBe("layer_not_found");
    expect(byId.hint).toContain("77");
  });

  it("refuses to edit a non-text layer with the layer's kind in the message", async () => {
    const { engine } = makeEngine(happyCreateHandler, [textLayer("4", "Logo", "Pixel")]);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, { mode: "edit", layer: { layerName: "Logo" }, text: "x" });
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("Pixel");
  });

  it("rejects a font change outside the workspace set (install hint, no mutation)", async () => {
    const { engine, calls } = makeEngine(happyCreateHandler, [textLayer("3", "Headline")]);
    const ctx = makeFakeContext({ engine });

    const failure = await runErr(ctx, { mode: "edit", layer: { layerId: "3" }, font: "Papyrus" });
    expect(failure.code).toBe("validation_failed");
    expect(failure.hint).toContain("Install");
    expect(mutatingCalls(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §10.2 name tables (pure)
// ---------------------------------------------------------------------------

describe("§10.2 name validation tables", () => {
  it("accepts role names and their §10.2 variant forms", () => {
    for (const name of [
      "Headline",
      "Subhead",
      "Body",
      "Caption",
      "CTA",
      "Body Copy",
      "Offer Price",
      "Badge Text",
      "Headline — es",
      "CTA — 20%",
      "Footer — 1080x1080",
    ]) {
      expect(isRoleLayerName(name), name).toBe(true);
      expect(isMachineLayerName(name), name).toBe(false);
    }
  });

  it("rejects non-role names (case, punctuation, dashes, empty variants)", () => {
    for (const name of [
      "headline",
      "my headline",
      "Headline!",
      "3 Headline",
      "Headline —",
      "Headline—es",
      "Headline - es",
      "Headline  Copy",
      "",
    ]) {
      expect(isRoleLayerName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it("flags the machine-name family §10.1 forbids", () => {
    const machines = [
      "Layer",
      "Layer 3",
      "layer 1",
      "Group 12",
      "Artboard 2",
      "Layer 1 copy",
      "Copy",
      "copy 2",
    ];
    for (const name of machines) {
      expect(isMachineLayerName(name), name).toBe(true);
      expect(isRoleLayerName(name), name).toBe(false);
    }
    for (const name of ["Headline", "Layers", "Layered Design", "Headline — es"]) {
      expect(isMachineLayerName(name), name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §6.1 colour formats → engine hex (pure table + schema rejection)
// ---------------------------------------------------------------------------

describe("colour conversion (§6.1 formats → engine hex)", () => {
  it("converts every accepted format deterministically", () => {
    const table: readonly [string, string][] = [
      ["#F0A", "#ff00aa"],
      ["#f0a", "#ff00aa"],
      ["#3B2A20", "#3b2a20"],
      ["rgb(59,42,32)", "#3b2a20"],
      ["rgba(59,42,32,1)", "#3b2a20"],
      ["rgba(255,0,170,0.5)", "#ff00aa80"],
      ["hsl(120,100%,50%)", "#00ff00"],
      ["hsl(0,100%,50%)", "#ff0000"],
      ["hsl(240,100%,50%)", "#0000ff"],
      ["hsl(0,0%,100%)", "#ffffff"],
      ["hsl(0,0%,0%)", "#000000"],
    ];
    for (const [input, expected] of table) {
      expect(toEngineColor(input), input).toBe(expected);
    }
  });

  it("rejects non-§6.1 colours at the schema boundary", () => {
    for (const color of ["blue", "#12345", "rgb(300,0,0)", "hsl(120,50,50)", "var(--ink)"]) {
      const parsed = textSetArgs.safeParse({ ...createArgs, color });
      expect(parsed.success, color).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Strict schema (§6.1: additionalProperties false, caps, mode discrimination)
// ---------------------------------------------------------------------------

describe("text_set schema", () => {
  const baseCreate = {
    mode: "create",
    name: "Headline",
    text: "Hi",
    bounds: [1, 2, 100, 50],
    font: "Inter",
  };

  it("rejects every malformed variant", () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      [
        "unknown key",
        { ...baseCreate, colour: "#fff" },
      ],
      [
        "create-only name on edit",
        { mode: "edit", layer: { layerName: "Headline" }, name: "New", text: "x" },
      ],
      [
        "create without font",
        { mode: "create", name: "Headline", text: "Hi", bounds: [1, 2, 100, 50] },
      ],
      ["create without bounds", { mode: "create", name: "Headline", text: "Hi", font: "Inter" }],
      ["zero-width bounds", { ...baseCreate, bounds: [1, 2, 0, 50] }],
      ["box wider than the engine limit", { ...baseCreate, bounds: [1, 2, 1_000_001, 50] }],
      ["non-numeric bounds", { ...baseCreate, bounds: [1, "2", 100, 50] }],
      ["text over the §6.2 cap", { ...baseCreate, text: "x".repeat(2001) }],
      ["whitespace-only text", { ...baseCreate, text: "   " }],
      ["size above the cap", { ...baseCreate, size: 1201 }],
      ["size below the floor", { ...baseCreate, size: 2 }],
      ["unknown align", { ...baseCreate, align: "middle" }],
      [
        "layer ref with both keys",
        { mode: "edit", layer: { layerId: "3", layerName: "Headline" }, text: "x" },
      ],
      ["edit with no change", { mode: "edit", layer: { layerName: "Headline" } }],
      ["unknown mode", { mode: "upsert", layer: { layerName: "Headline" }, text: "x" }],
      ["short idempotency key", { ...baseCreate, idempotencyKey: "abc" }],
    ];
    for (const [label, raw] of cases) {
      expect(textSetArgs.safeParse(raw).success, label).toBe(false);
    }
  });

  it("accepts valid creates and edits, with the optional idempotency key", () => {
    expect(textSetArgs.safeParse(baseCreate).success).toBe(true);
    expect(
      textSetArgs.safeParse({ ...baseCreate, idempotencyKey: "run-12345-abc" }).success,
    ).toBe(true);
    expect(
      textSetArgs.safeParse({ mode: "edit", layer: { layerId: "3" }, size: 24 }).success,
    ).toBe(true);
  });

  it("surfaces schema failures as invalid_args envelopes via parseToolArgs", () => {
    const parsed = parseToolArgs(textSet, { ...baseCreate, surprise: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(typeof parsed.hint).toBe("string");
    }
  });
});
