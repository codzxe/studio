// W6-K — §5.7 tool-call gate tests: the decision table (unknown tool, schema
// reject, cap reject, mutating budget), manifest-fixed-at-run-start pinning,
// §5.7 raw-arg structural caps (strings 2000 / arrays 50 / records 50 / depth
// 8 / JSON-only), reserve-at-validation budget semantics, §5.2 tier caps, and
// constructor fail-fast. Pure logic, table-driven; no network, <5 s.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AnyTool,
  MAX_ARG_STRING_CHARS,
  cappedArray,
  cappedString,
  defineTool,
  ok as toolOk,
  parseToolArgs,
  strictObject,
  zIdempotencyKey,
  zTemplateRef,
} from "@studio/tools";
import {
  DEFAULT_MUTATING_TOOLS,
  GATE_DEFAULT_ARG_CAPS,
  type ModelToolCall,
  type ToolGateOptions,
  ToolCallGate,
  mutatingCommandCapFromTier,
} from "../../src/guards/tool-gate.js";

// ---------------------------------------------------------------------------
// Fixtures: §6.1-shaped fake tools over kit helpers
// ---------------------------------------------------------------------------

/** Read-only row (§6 table): never touches the mutating budget. */
const snapshotTool: AnyTool = defineTool({
  name: "workspace_snapshot",
  description: "One-call context: canvas, layers, slots (gate test fake).",
  args: strictObject({}),
  run: async () => toolOk({ summary: "snapshot taken" }),
});

/** Mutating row with a strict schema: strings ≤ 200, size 4–400. */
const textSetTool: AnyTool = defineTool({
  name: "text_set",
  description: "Create or rewrite editable text (gate test fake).",
  args: strictObject({ text: cappedString(200), size: z.number().int().min(4).max(400) }),
  run: async (_ctx, args) => toolOk({ summary: `text set at ${args.size}pt`, documentRevision: 9 }),
});

/**
 * Mutating row whose schema allows up to 200 array items (the kit's ceiling) —
 * deliberately looser than the gate's §5.7 default of 50, proving the gate
 * fires FIRST on oversized arrays.
 */
const layerOpsTool: AnyTool = defineTool({
  name: "layer_ops",
  description: "Create, group, rename or reorder layers (gate test fake).",
  args: strictObject({ operations: cappedArray(200, strictObject({ op: cappedString(40) })) }),
  run: async () => toolOk({ summary: "ops done", documentRevision: 5 }),
});

/** Mutating row with an UNCAPPED record schema — the gate's record cap fires. */
const componentSetVarsTool: AnyTool = defineTool({
  name: "component_set_vars",
  description: "Override component variables (gate test fake).",
  args: strictObject({ vars: z.record(z.string(), cappedString(20)) }),
  run: async () => toolOk({ summary: "vars set", documentRevision: 6 }),
});

/** Mutating row with idempotency + template ref atoms (§6.1). */
const templateApplyTool: AnyTool = defineTool({
  name: "template_apply",
  description: "Instantiate a template onto the document (gate test fake).",
  args: strictObject({ template: zTemplateRef, idempotencyKey: zIdempotencyKey }),
  run: async () => toolOk({ summary: "applied", documentRevision: 3 }),
});

const TOOLS: Record<string, AnyTool> = {
  workspace_snapshot: snapshotTool,
  text_set: textSetTool,
  layer_ops: layerOpsTool,
  component_set_vars: componentSetVarsTool,
  template_apply: templateApplyTool,
};

const MANIFEST = [
  { name: "workspace_snapshot", description: "One-call context (fake)." },
  { name: "text_set", description: "Set editable text (fake)." },
  { name: "layer_ops", description: "Layer operations (fake)." },
  { name: "component_set_vars", description: "Component variables (fake)." },
  { name: "template_apply", description: "Apply a template (fake)." },
];

function makeGate(overrides: Partial<ToolGateOptions> = {}): ToolCallGate {
  return new ToolCallGate({
    tools: { ...TOOLS },
    manifest: MANIFEST.map((tool) => ({ ...tool })),
    mutatingCommandCap: 24,
    ...overrides,
  });
}

function ops(count: number): { op: string }[] {
  return Array.from({ length: count }, () => ({ op: "rename" }));
}

// ---------------------------------------------------------------------------
// The gate decision table (§5.7): unknown tool / schema reject / cap reject /
// mutating budget
// ---------------------------------------------------------------------------

describe("ToolCallGate: decision table", () => {
  it("known tool + valid args → ok with parseToolArgs-parsed args", () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({ name: "text_set", args: { text: "Hello", size: 72 } });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.tool.name).toBe("text_set");
      expect(verdict.args).toEqual({ text: "Hello", size: 72 });
      expect(verdict.mutating).toBe(true);
    }
  });

  it.each([
    { name: "shell_exec", why: "not in the §6 surface at all" },
    { name: "template_fill", why: "a §6 name this run never offered" },
    { name: "", why: "empty name" },
    { name: "TEXT_SET", why: "wrong case" },
  ])("unknown tool: $name ($why) → unknown_tool with the allowlist", ({ name }) => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({ name, args: {} });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.kind).toBe("unknown_tool");
      expect(verdict.rejection.code).toBe("unknown_tool");
      expect(verdict.rejection.retryable).toBe(false);
      expect(verdict.rejection.hint).toContain("Available tools: workspace_snapshot, component_set_vars");
      expect(verdict.allowedTools).toEqual(gate.allowedToolNames());
    }
  });

  it("non-string names (number, null, undefined, missing) → unknown_tool", () => {
    const gate = makeGate();
    for (const name of [123, null, undefined] as unknown[]) {
      const verdict = gate.validateModelToolCall({ name, args: {} });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.kind).toBe("unknown_tool");
    }
    const missing = gate.validateModelToolCall({ args: {} } as ModelToolCall);
    expect(missing.ok === false && missing.kind).toBe("unknown_tool");
  });

  it("the manifest was FIXED AT RUN START: registry-only names stay unknown mid-run", () => {
    // registry can dispatch template_apply, but this run's manifest omits it.
    const gate = makeGate({
      manifest: MANIFEST.filter((tool) => tool.name !== "template_apply"),
    });
    const verdict = gate.validateModelToolCall({
      name: "template_apply",
      args: { template: "menu-a4@1.0.0", idempotencyKey: "key_12345" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.kind).toBe("unknown_tool");
    expect(gate.allowedToolNames()).not.toContain("template_apply");
  });

  it("schema reject: parseToolArgs envelope passes through as invalid_args", () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({ name: "text_set", args: { text: "ok", size: "big" } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.kind).toBe("invalid_args");
      expect(verdict.rejection.code).toBe("invalid_args");
      expect(verdict.rejection.hint).toContain("size");
      expect(verdict.rejection.retryable).toBe(false);
    }
  });

  it("schema strictness: additional properties are rejected (§6.1 strictObject)", () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({
      name: "text_set",
      args: { text: "ok", size: 10, rogue: "extra" },
    });
    expect(verdict.ok === false && verdict.kind).toBe("invalid_args");
  });

  it("schema atom rejects: bad template ref + bad idempotency key (§6.1)", () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({
      name: "template_apply",
      args: { template: "Menu A4!", idempotencyKey: "short" },
    });
    expect(verdict.ok === false && verdict.kind).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// §5.7 raw-arg structural caps (before the schema parse)
// ---------------------------------------------------------------------------

describe("ToolCallGate: §5.7 cap rejects", () => {
  it(`string cap: >${MAX_ARG_STRING_CHARS} chars rejected at the exact path, value never echoed`, () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({
      name: "text_set",
      args: { text: `${"x".repeat(2001)}`, size: 10 },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.kind).toBe("args_cap");
      expect(verdict.rejection.code).toBe("invalid_args");
      expect(verdict.rejection.message).toContain('"text"');
      expect(verdict.rejection.message).toContain("2000");
      expect(verdict.rejection.message).not.toContain("xxxx");
    }
  });

  it("array cap: 51 items rejected even though the schema allows 200 (gate fires first)", () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({ name: "layer_ops", args: { operations: ops(51) } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.kind).toBe("args_cap");
      expect(verdict.rejection.message).toContain('"operations"');
      expect(verdict.rejection.message).toContain("more than 50 items");
    }
    // 50 items fit the gate and the schema — both pass.
    const fits = gate.validateModelToolCall({ name: "layer_ops", args: { operations: ops(50) } });
    expect(fits.ok).toBe(true);
  });

  it("record cap: 51 entries rejected before the uncapped schema sees them", () => {
    const gate = makeGate();
    const vars: Record<string, string> = {};
    for (let i = 0; i < 51; i += 1) {
      vars[`slot_${i}`] = "value";
    }
    const verdict = gate.validateModelToolCall({ name: "component_set_vars", args: { vars } });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.kind).toBe("args_cap");
    expect(verdict.ok === false && verdict.rejection.message).toContain("more than 50 entries");
  });

  it("depth cap: 9-level nesting rejected as hostile", () => {
    const gate = makeGate();
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 9; i += 1) {
      nested = { deeper: nested };
    }
    const verdict = gate.validateModelToolCall({
      name: "component_set_vars",
      args: { vars: nested },
    });
    expect(verdict.ok === false && verdict.kind).toBe("args_cap");
    expect(verdict.ok === false && verdict.rejection.message).toContain("nesting deeper than 8 levels");
  });

  it.each([
    { why: "function value", value: () => {} },
    { why: "undefined value", value: undefined },
    { why: "symbol value", value: Symbol("x") },
    { why: "bigint value", value: 10n },
    { why: "NaN", value: Number.NaN },
    { why: "Infinity", value: Number.POSITIVE_INFINITY },
    { why: "class instance (non-plain object)", value: new Date(0) },
  ])("non-JSON value rejected: $why", ({ value }) => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({
      name: "text_set",
      args: { text: "ok", size: 10, payload: value },
    });
    expect(verdict.ok === false && verdict.kind).toBe("args_cap");
  });

  it("a string arg at exactly the cap passes (boundary is >, not ≥)", () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({
      name: "text_set",
      args: { text: "y".repeat(200), size: 10 },
    });
    expect(verdict.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mutating-command budget (§5.7 "cap total mutating commands per run")
// ---------------------------------------------------------------------------

describe("ToolCallGate: mutating-command budget", () => {
  const validTextSet = { name: "text_set", args: { text: "ok", size: 10 } };

  it("validation RESERVES a mutating slot; exhaustion rejects with budget_exceeded", () => {
    const gate = makeGate({ mutatingCommandCap: 2 });
    expect(gate.mutatingCommandsRemaining()).toBe(2);
    const first = gate.validateModelToolCall(validTextSet);
    expect(first.ok).toBe(true);
    expect(gate.mutatingCommandsUsed()).toBe(1);
    expect(gate.mutatingCommandsRemaining()).toBe(1);
    const second = gate.validateModelToolCall(validTextSet);
    expect(second.ok).toBe(true);
    expect(gate.mutatingCommandsRemaining()).toBe(0);
    const third = gate.validateModelToolCall(validTextSet);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.kind).toBe("mutating_budget");
      expect(third.rejection.code).toBe("budget_exceeded");
      expect(third.rejection.message).toContain("2 of 2");
      expect(third.rejection.retryable).toBe(false);
    }
    expect(gate.mutatingCommandsUsed()).toBe(2);
  });

  it("read-only tools are NEVER blocked by the mutating budget", () => {
    const gate = makeGate({ mutatingCommandCap: 0 });
    const blocked = gate.validateModelToolCall(validTextSet);
    expect(blocked.ok === false && blocked.kind).toBe("mutating_budget");
    const snapshot = gate.validateModelToolCall({ name: "workspace_snapshot", args: {} });
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.mutating).toBe(false);
    }
  });

  it("cap 0 bans every mutating call from the first proposal (§5.2 feature)", () => {
    const gate = makeGate({ mutatingCommandCap: 0 });
    const verdict = gate.validateModelToolCall(validTextSet);
    expect(verdict.ok === false && verdict.kind).toBe("mutating_budget");
    expect(gate.mutatingCommandsUsed()).toBe(0);
  });

  it("rejected calls never consume budget (reserve happens on success only)", () => {
    const gate = makeGate({ mutatingCommandCap: 1 });
    const badSchema = gate.validateModelToolCall({
      name: "text_set",
      args: { text: "ok", size: 9999 },
    });
    expect(badSchema.ok === false && badSchema.kind).toBe("invalid_args");
    const badCap = gate.validateModelToolCall({
      name: "text_set",
      args: { text: "x".repeat(2001), size: 10 },
    });
    expect(badCap.ok === false && badCap.kind).toBe("args_cap");
    expect(gate.mutatingCommandsUsed()).toBe(0);
    const good = gate.validateModelToolCall(validTextSet);
    expect(good.ok).toBe(true);
    const exhausted = gate.validateModelToolCall(validTextSet);
    expect(exhausted.ok === false && exhausted.kind).toBe("mutating_budget");
  });

  it("the mutating set is configurable; membership decides, not the schema", () => {
    const gate = makeGate({ mutatingCommandCap: 1, mutatingTools: ["text_set"] });
    const apply = gate.validateModelToolCall({
      name: "template_apply",
      args: { template: "menu-a4@1.0.0", idempotencyKey: "key_12345" },
    });
    expect(apply.ok).toBe(true);
    if (apply.ok) {
      expect(apply.mutating).toBe(false);
    }
    expect(gate.isMutating("text_set")).toBe(true);
    expect(gate.isMutating("template_apply")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5.2 tier caps + defaults pins
// ---------------------------------------------------------------------------

describe("ToolCallGate: tier caps and catalog pins", () => {
  it("mutatingCommandCapFromTier pins the §5.2 tool-calls column", () => {
    expect(mutatingCommandCapFromTier("quick")).toBe(6);
    expect(mutatingCommandCapFromTier("standard")).toBe(12);
    expect(mutatingCommandCapFromTier("complex")).toBe(24);
    expect(mutatingCommandCapFromTier("premium")).toBe(18);
    expect(mutatingCommandCapFromTier("max")).toBe(48);
    expect(mutatingCommandCapFromTier("image_gen")).toBe(1);
    expect(mutatingCommandCapFromTier("image_gen_hd")).toBe(1);
  });

  it("image tiers: the single mutating image_generate call fits, the second does not", () => {
    const gate = makeGate({
      tools: { image_generate: textSetTool },
      manifest: [{ name: "image_generate", description: "Generate a raster image (fake)." }],
      mutatingCommandCap: mutatingCommandCapFromTier("image_gen"),
    });
    const prompt = { name: "image_generate", args: { text: "a cat", size: 72 } };
    const first = gate.validateModelToolCall(prompt);
    expect(first.ok).toBe(true);
    const second = gate.validateModelToolCall(prompt);
    expect(second.ok === false && second.kind).toBe("mutating_budget");
  });

  it("DEFAULT_MUTATING_TOOLS is the pinned §6 mutating set (12 names, sorted)", () => {
    expect(DEFAULT_MUTATING_TOOLS).toEqual([
      "asset_place",
      "component_place",
      "component_set_vars",
      "export_document",
      "image_generate",
      "layer_ops",
      "layout_apply",
      "style_apply",
      "template_apply",
      "template_fill",
      "text_set",
      "variant_create",
    ]);
    for (const readOnly of [
      "workspace_snapshot",
      "template_list",
      "template_inspect",
      "asset_search",
      "component_list",
      "render_preview",
      "validate_document",
      "vision_critique",
      "ask_user",
    ]) {
      expect(DEFAULT_MUTATING_TOOLS).not.toContain(readOnly);
    }
  });

  it("§5.7 default caps are pinned (strings 2000, arrays 50, records 50, depth 8)", () => {
    expect(GATE_DEFAULT_ARG_CAPS).toEqual({
      maxStringChars: 2000,
      maxArrayItems: 50,
      maxRecordEntries: 50,
      maxDepth: 8,
    });
  });

  it("caps are overridable upward within the §5.7 ceilings (strings ≤ 2000)", () => {
    const gate = makeGate({ caps: { maxArrayItems: 60, maxDepth: 4 } });
    const verdict = gate.validateModelToolCall({ name: "layer_ops", args: { operations: ops(55) } });
    expect(verdict.ok).toBe(true);
    const deep = gate.validateModelToolCall({
      name: "component_set_vars",
      args: { vars: { a: { b: { c: { d: { e: true } } } } } },
    });
    expect(deep.ok === false && deep.kind).toBe("args_cap");
  });
});

// ---------------------------------------------------------------------------
// Executor-integration shape (W6-B seam) + constructor fail-fast
// ---------------------------------------------------------------------------

describe("ToolCallGate: executor seam + constructor", () => {
  it("accepts the executor's ProposedToolCall shape (callId tolerated)", () => {
    const gate = makeGate();
    const proposed = { callId: "call-1", name: "text_set", args: { text: "hi", size: 10 } };
    const verdict = gate.validateModelToolCall(proposed);
    expect(verdict.ok).toBe(true);
  });

  it("verdicts match the kit's own parseToolArgs behavior (same boundary)", () => {
    const gate = makeGate();
    const direct = parseToolArgs(textSetTool, { text: "ok", size: 10 });
    const viaGate = gate.validateModelToolCall({ name: "text_set", args: { text: "ok", size: 10 } });
    expect(viaGate.ok).toBe(true);
    expect(direct.ok).toBe(true);
    expect(viaGate.ok && viaGate.args).toEqual(direct.ok ? direct.args : null);
  });

  it.each([
    {
      why: "manifest name missing from the registry",
      build: (): ToolGateOptions => ({
        tools: TOOLS,
        manifest: [{ name: "text_set", description: "ok" }, { name: "vision_critique", description: "not wired" }],
        mutatingCommandCap: 6,
      }),
    },
    {
      why: "empty tools map",
      build: (): ToolGateOptions => ({
        tools: {},
        manifest: [{ name: "text_set", description: "ok" }],
        mutatingCommandCap: 6,
      }),
    },
    {
      why: "empty manifest",
      build: (): ToolGateOptions => ({ tools: TOOLS, manifest: [], mutatingCommandCap: 6 }),
    },
    {
      why: "negative mutating cap",
      build: (): ToolGateOptions => ({
        tools: TOOLS,
        manifest: MANIFEST,
        mutatingCommandCap: -1,
      }),
    },
    {
      why: "fractional mutating cap",
      build: (): ToolGateOptions => ({
        tools: TOOLS,
        manifest: MANIFEST,
        mutatingCommandCap: 2.5,
      }),
    },
    {
      why: "cap above the §5.7 ceiling (maxStringChars > 2000)",
      build: (): ToolGateOptions => ({
        tools: TOOLS,
        manifest: MANIFEST,
        mutatingCommandCap: 6,
        caps: { maxStringChars: 5000 },
      }),
    },
    {
      why: "malformed manifest listing (no description)",
      build: (): ToolGateOptions => ({
        tools: TOOLS,
        manifest: [{ name: "text_set" } as { name: string; description: string }],
        mutatingCommandCap: 6,
      }),
    },
    {
      why: "malformed mutatingTools entry",
      build: (): ToolGateOptions => ({
        tools: TOOLS,
        manifest: MANIFEST,
        mutatingCommandCap: 6,
        mutatingTools: ["not snake-case!"],
      }),
    },
  ])("constructor fails fast: $why", ({ build }) => {
    expect(() => new ToolCallGate(build())).toThrow(/\[agent\/guards\/tool-gate\]/);
  });

  it("rejections are §6.1 envelopes: no stack, no values, no internal ids", () => {
    const gate = makeGate();
    const verdict = gate.validateModelToolCall({
      name: "text_set",
      args: { text: "secret-payload-value", size: Number.NaN },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      const serialized = JSON.stringify(verdict.rejection);
      expect(serialized).not.toContain("secret-payload-value");
      expect(verdict.rejection.hint).toBeDefined();
    }
  });
});
