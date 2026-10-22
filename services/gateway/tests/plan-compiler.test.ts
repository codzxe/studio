// M5-B — the plan-compiler safety proofs (BUILD_PLAN §M5 task 2, PA §8.5–§8.7).
//
// Proves, per compile:
//   1. GOLDEN translations: each of the 8 write tools compiles to the exact
//      registry command steps + params (ids verified against the Rust source);
//   2. merge: N plan steps ⇒ ONE atomic AgentBatch, label "Agent: <summary>",
//      no $N refs, all §8.5 bounds (≤100 steps, ≤2 MB, schema-compatible);
//   3. the model's proposed batches are advisory: unknown commands, bad refs
//      and disagreements produce WARN issues while the args translation wins
//      (law #5) — and unknown tools/args/registry misses are FATAL (§8.9);
//   4. layer-name resolution requests are deduped (≤50) with the plan's own
//      `change` disambiguation, placeholders point at every name occurrence,
//      resolvers substitute authoritative ids and throwing resolvers degrade;
//   5. risk + credits are RECOMPUTED (model lies ignored) from the compiled
//      commands + tool catalog floors;
//   6. hostile args never crash: dunder keys, 999-length arrays, deep
//      nesting, cyclic structures, non-object args — typed results only;
//   7. determinism: same input twice ⇒ deep-equal; arg key order irrelevant.
//
// Deterministic: pure in-memory fixtures (deps injected — the M5-A/M5-J
// stubs are empty today), no network, no Postgres.

import {
  AGENT_BATCH_SCHEMA,
  collectRefs,
  type CommandSchema,
  type EditPlan,
  estimateCredits,
  type PlanStep,
} from "@studio/contracts";
import { describe, expect, it } from "vitest";
import { z, type ZodTypeAny } from "zod";

import {
  compilePlan,
  type CompileDeps,
  type CompilePlanResult,
  recomputePlanRisk,
  type WriteToolDef,
} from "../src/plan-compiler.js";

// ---------------------------------------------------------------------------
// Fixtures — registry entries mirror the REAL Rust specs
// (editor/crates/engine/src/commands/{comp,layer,prop,effect,anim_presets,edit}.rs)
// ---------------------------------------------------------------------------

const REGISTRY: CommandSchema = {
  "comp.new": {
    id: "comp.new",
    title: "New Composition…",
    params: [
      { name: "name", required: false, type: "string" },
      { name: "width", required: false, type: "number" },
      { name: "height", required: false, type: "number" },
      { name: "frameRate", required: false, type: "number" },
      { name: "duration", required: false, type: "number" },
    ],
  },
  "layer.newText": { id: "layer.newText", title: "Text", params: [] },
  "prop.set": {
    id: "prop.set",
    title: "Set Property Value",
    params: [
      { name: "layer", required: false, type: "string" },
      { name: "path", required: false, type: "string" },
      { name: "value", required: true }, // prop.rs: "missing `value`"
    ],
  },
  "prop.addKey": {
    id: "prop.addKey",
    title: "Add Keyframe",
    params: [
      { name: "layer", required: false, type: "string" },
      { name: "path", required: false, type: "string" },
      { name: "time", required: false, type: "number" },
      { name: "value", required: false },
    ],
  },
  "effect.apply": {
    id: "effect.apply",
    title: "Apply Effect",
    params: [
      { name: "effect", required: true }, // effect.rs: "missing `effect`"
      { name: "layers", required: false, type: "array" },
    ],
  },
  "anim.applyBuiltinPreset": {
    id: "anim.applyBuiltinPreset",
    title: "Apply Built-in Animation Preset",
    params: [
      { name: "preset", required: true },
      { name: "layers", required: false, type: "array" },
    ],
  },
  "anim.applyPreset": {
    id: "anim.applyPreset",
    title: "Apply Animation Preset…",
    params: [
      { name: "preset", required: false },
      { name: "path", required: false, type: "string" },
      { name: "layers", required: false, type: "array" },
    ],
  },
  "edit.undo": { id: "edit.undo", title: "Undo", params: [] },
  "layer.newSolid": { id: "layer.newSolid", title: "Solid…", params: [] },
};

// The M5-A write-tool surface (mirrors packages/contracts/src/tools.ts §8.4,
// so tests survive M5-A's mid-flight edits — deps are injected, never shared).
const HEX_COLOR = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
const EASING = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]);

const WRITE_TOOLS: CompileDeps["writeTools"] = {
  create_composition: {
    args: z.object({
      name: z.string().min(1).max(120),
      width: z.number().int().min(16).max(8192),
      height: z.number().int().min(16).max(8192),
      frameRate: z.number().positive().max(480).default(30),
      durationSeconds: z.number().positive().max(3600).default(10),
    }),
    risk: "medium",
  },
  create_text: {
    args: z.object({
      compId: z.string().min(1).optional(),
      text: z.string().min(1).max(5000),
      name: z.string().min(1).max(120).optional(),
      fontSize: z.number().positive().max(2000).optional(),
      fontFamily: z.string().min(1).max(200).optional(),
      color: HEX_COLOR.optional(),
      position: z.tuple([z.number(), z.number()]).optional(),
    }),
    risk: "low",
  },
  set_properties: {
    args: z.object({
      updates: z
        .array(z.object({ layer: z.string().min(1), path: z.string().min(1), value: z.unknown() }))
        .min(1)
        .max(50),
    }),
    risk: "low",
  },
  set_keyframes: {
    args: z.object({
      layer: z.string().min(1),
      propertyPath: z.string().min(1),
      keyframes: z
        .array(z.object({ time: z.number().nonnegative(), value: z.unknown(), easing: EASING.optional() }))
        .min(1)
        .max(200),
    }),
    risk: "low",
  },
  add_effect: {
    args: z.object({
      layer: z.string().min(1),
      effect: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    risk: "medium",
  },
  apply_preset: {
    args: z.object({
      preset: z.string().min(1).max(200),
      targets: z.array(z.string().min(1)).min(1).max(50),
    }),
    risk: "medium",
  },
  undo_run: { args: z.object({ runId: z.string().min(1).optional() }), risk: "medium" },
  save_version: { args: z.object({ label: z.string().max(280).optional() }), risk: "low" },
};

const DEPS: CompileDeps = { registry: REGISTRY, writeTools: WRITE_TOOLS };

/** Bare-schema dep — same args schemas, NO tool risk metadata (isolates the
 * command-side risk floors from the tool-catalog floors). */
function bareToolsDep(): CompileDeps {
  const writeTools: Record<string, ZodTypeAny | WriteToolDef> = {};
  for (const [id, entry] of Object.entries(WRITE_TOOLS)) {
    const def = entry as WriteToolDef;
    writeTools[id] = def.args ?? z.object({}).passthrough();
  }
  return { registry: REGISTRY, writeTools };
}

// ---------------------------------------------------------------------------
// Plan builders (raw objects — compilePlan re-validates with EDIT_PLAN_SCHEMA)
// ---------------------------------------------------------------------------

interface Proposed {
  command: string;
  params: Record<string, unknown>;
}

/** A plan step. PLAN_STEP_SCHEMA requires batch.steps ≥ 1 — an empty proposal
 * defaults to a benign known command so tests can focus on the translation. */
function step(tool: string, args: unknown, proposed: readonly Proposed[] = []): PlanStep {
  const proposedSteps =
    proposed.length > 0
      ? proposed.map((p) => ({ command: p.command, params: p.params }))
      : [{ command: "edit.undo", params: {} }];
  return {
    title: `${tool} step`,
    tool,
    args,
    batch: { label: tool, steps: proposedSteps },
  };
}

function plan(steps: readonly PlanStep[], overrides: Record<string, unknown> = {}): EditPlan {
  return {
    intent: "edit",
    summary: "Style the headline",
    risk: "low",
    requiresApproval: false,
    affectedLayers: [{ id: 1, name: "Headline", change: "Set opacity to 40" }],
    estimatedCredits: 1.5,
    steps: [...steps],
    ...overrides,
  } as EditPlan;
}

function compile(input: EditPlan, deps: CompileDeps = DEPS): CompilePlanResult {
  return compilePlan(input, deps);
}

function warningCodes(result: Extract<CompilePlanResult, { ok: true }>): string[] {
  return result.warnings.map((w) => w.code);
}

function expectOk(result: CompilePlanResult): Extract<CompilePlanResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (result.ok) return result;
  throw new Error(`expected ok, got issues: ${JSON.stringify(result.issues)}`);
}

type FatalIssues = Extract<CompilePlanResult, { ok: false }>;

function expectFatal(result: CompilePlanResult, code: string): FatalIssues["issues"] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected fatal issues");
  expect(result.issues.some((issue) => issue.code === code && issue.severity === "fatal")).toBe(true);
  return result.issues;
}

// ---------------------------------------------------------------------------
// 1. Golden compiles per tool — exact command steps + params
// ---------------------------------------------------------------------------

describe("golden compiles per tool", () => {
  it("create_composition → comp.new with durationSeconds mapped to duration", () => {
    const result = expectOk(
      compile(
        plan([
          step(
            "create_composition",
            { name: "Intro", width: 1920, height: 1080, frameRate: 30, durationSeconds: 5 },
            [{ command: "comp.new", params: { name: "Intro", width: 1920, height: 1080, frameRate: 30, duration: 5 } }],
          ),
        ]),
      ),
    );
    expect(result.batch.steps).toEqual([
      { command: "comp.new", params: { name: "Intro", width: 1920, height: 1080, frameRate: 30, duration: 5 } },
    ]);
    expect(result.batch.atomic).toBe(true);
    expect(result.batch.label).toBe("Agent: Style the headline");
    expect(result.batch.timeoutMs).toBeUndefined(); // omitted ⇒ the 60 s ceiling (§8.5)
  });

  it("create_text (full args) → layer.newText with curated param mapping", () => {
    const args = {
      compId: "Main",
      text: "Hello",
      name: "Title",
      fontSize: 64,
      fontFamily: "Inter",
      color: "#0B0D10",
      position: [960, 540] as [number, number],
    };
    const expected = {
      command: "layer.newText",
      params: {
        text: "Hello",
        name: "Title",
        comp: "Main",
        size: 64,
        font: "Inter",
        fill: "#0B0D10",
        position: [960, 540],
      },
    };
    const result = expectOk(compile(plan([step("create_text", args, [expected])])));
    expect(result.batch.steps).toEqual([expected]);
  });

  it("create_text (minimal) → layer.newText {text} only", () => {
    const result = expectOk(
      compile(plan([step("create_text", { text: "Hi" }, [{ command: "layer.newText", params: { text: "Hi" } }])])),
    );
    expect(result.batch.steps).toEqual([{ command: "layer.newText", params: { text: "Hi" } }]);
  });

  it("set_properties → one prop.set per update, order preserved", () => {
    const args = {
      updates: [
        { layer: "Headline", path: "transform/opacity", value: 40 },
        { layer: "Sub", path: "text/sourceText", value: "New text" },
      ],
    };
    const result = expectOk(
      compile(
        plan([step("set_properties", args)], {
          affectedLayers: [{ name: "Headline", change: "Set opacity" }, { name: "Sub", change: "Rewrite" }],
        }),
      ),
    );
    expect(result.batch.steps).toEqual([
      { command: "prop.set", params: { layer: "Headline", path: "transform/opacity", value: 40 } },
      { command: "prop.set", params: { layer: "Sub", path: "text/sourceText", value: "New text" } },
    ]);
  });

  it("set_keyframes → one prop.addKey per keyframe; easing warns (client state)", () => {
    const args = {
      layer: "Headline",
      propertyPath: "transform/position",
      keyframes: [
        { time: 0, value: [0, 540, 0] },
        { time: 1, value: [960, 540, 0], easing: "ease-in-out" },
      ],
    };
    const result = expectOk(
      compile(
        plan([
          step("set_keyframes", args, [
            { command: "prop.addKey", params: { layer: "Headline", path: "transform/position", time: 0, value: [0, 540, 0] } },
            { command: "prop.addKey", params: { layer: "Headline", path: "transform/position", time: 1, value: [960, 540, 0] } },
          ]),
        ]),
      ),
    );
    expect(result.batch.steps).toEqual([
      { command: "prop.addKey", params: { layer: "Headline", path: "transform/position", time: 0, value: [0, 540, 0] } },
      { command: "prop.addKey", params: { layer: "Headline", path: "transform/position", time: 1, value: [960, 540, 0] } },
    ]);
    const easingWarnings = result.warnings.filter((w) => w.code === "uncompilable_arg");
    expect(easingWarnings).toHaveLength(1);
    expect(easingWarnings[0]?.param).toBe("easing");
  });

  it("add_effect → effect.apply {effect, layers:[name]}; effect params warn", () => {
    const args = { layer: "Headline", effect: "Gaussian Blur", params: { blur: 5, dimensions: "b" } };
    const result = expectOk(compile(plan([step("add_effect", args)])));
    expect(result.batch.steps).toEqual([
      { command: "effect.apply", params: { layers: ["Headline"], effect: "Gaussian Blur" } },
    ]);
    const paramWarnings = result.warnings.filter((w) => w.code === "uncompilable_arg");
    expect(paramWarnings.map((w) => w.param).sort()).toEqual(["blur", "dimensions"]);
  });

  it("apply_preset → anim.applyBuiltinPreset with every target", () => {
    const result = expectOk(
      compile(
        plan([step("apply_preset", { preset: "Fade In", targets: ["Headline", "Sub"] })], {
          affectedLayers: [{ name: "Headline", change: "Fade" }, { name: "Sub", change: "Fade" }],
        }),
      ),
    );
    expect(result.batch.steps).toEqual([
      { command: "anim.applyBuiltinPreset", params: { layers: ["Headline", "Sub"], preset: "Fade In" } },
    ]);
  });

  it("apply_preset with a path-like preset warns and never compiles a filesystem path", () => {
    const result = expectOk(compile(plan([step("apply_preset", { preset: "C:/presets/fade.ecpreset", targets: ["Headline"] })])));
    expect(result.batch.steps).toEqual([
      { command: "anim.applyBuiltinPreset", params: { layers: ["Headline"], preset: "C:/presets/fade.ecpreset" } },
    ]);
    expect(warningCodes(result)).toContain("uncompilable_arg");
    expect(result.batch.steps.some((s) => s.command === "anim.applyPreset")).toBe(false);
  });

  it("undo_run → edit.undo; naming a run warns (ordering is gateway state)", () => {
    const result = expectOk(
      compile(plan([step("undo_run", { runId: "run_9" }, [{ command: "edit.undo", params: {} }])])),
    );
    expect(result.batch.steps).toEqual([{ command: "edit.undo", params: {} }]);
    expect(warningCodes(result)).toContain("undo_run_target");
  });

  it("save_version → compile-time annotation, never a batch step", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
            { command: "prop.set", params: { layer: "Headline", path: "transform/opacity", value: 40 } },
          ]),
          step("save_version", { label: "agent pass" }),
        ]),
      ),
    );
    expect(result.batch.steps).toHaveLength(1);
    expect(result.saveVersion).toEqual({ label: "agent pass" });
    expect(warningCodes(result)).toContain("batch_mismatch"); // save_version proposes nothing executable
  });

  it("duplicate save_version steps: the last labels the version", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }),
          step("save_version", { label: "first" }),
          step("save_version", { label: "second" }),
        ]),
      ),
    );
    expect(result.saveVersion).toEqual({ label: "second" });
    expect(warningCodes(result)).toContain("duplicate_save_version");
  });

  it("a save_version-only plan compiles to an empty batch → fatal (apply needs a batch)", () => {
    expectFatal(compile(plan([step("save_version", { label: "only" })])), "empty_batch");
  });
});

// ---------------------------------------------------------------------------
// 2. Merge + §8.5 bounds
// ---------------------------------------------------------------------------

describe("merge + bounds", () => {
  it("many plan steps merge into ONE atomic batch in plan order", () => {
    const result = expectOk(
      compile(
        plan(
          [
            step("create_text", { text: "Hello", name: "Title" }, [
              { command: "layer.newText", params: { text: "Hello", name: "Title" } },
            ]),
            step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
              { command: "prop.set", params: { layer: "Headline", path: "transform/opacity", value: 40 } },
            ]),
            step("set_keyframes", { layer: "Headline", propertyPath: "transform/scale", keyframes: [{ time: 0, value: 100 }] }, [
              { command: "prop.addKey", params: { layer: "Headline", path: "transform/scale", time: 0, value: 100 } },
            ]),
          ],
          { summary: "Build the title sequence" },
        ),
      ),
    );
    expect(result.batch.label).toBe("Agent: Build the title sequence");
    expect(result.batch.atomic).toBe(true);
    expect(result.batch.steps.map((s) => s.command)).toEqual(["layer.newText", "prop.set", "prop.addKey"]);
  });

  it("over 100 compiled commands is a fatal bound violation", () => {
    const fifty = Array.from({ length: 50 }, (_v, i) => ({ layer: "Headline", path: "transform/opacity", value: i }));
    const threeSteps = [1, 2, 3].map(() => step("set_properties", { updates: fifty }));
    expectFatal(compile(plan(threeSteps)), "too_many_commands");
  });

  it("a serialized batch over 2 MB is a fatal bound violation", () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    const result = compile(
      plan([step("set_properties", { updates: [{ layer: "Headline", path: "text/sourceText", value: huge }] })]),
    );
    expectFatal(result, "batch_too_large");
  });

  it("a plan with more than 20 steps fails the §8.6 schema", () => {
    const twentyOne = Array.from({ length: 21 }, () => step("undo_run", {}, [{ command: "edit.undo", params: {} }]));
    expectFatal(compile(plan(twentyOne)), "plan_schema");
  });

  it("more than 50 distinct layer names is fatal", () => {
    const fifty = Array.from({ length: 50 }, (_v, i) => ({ name: `L${i}`, change: "touch" }));
    const result = compile(
      plan([step("set_properties", { updates: [{ layer: "Extra", path: "transform/opacity", value: 1 }] })], {
        affectedLayers: fifty,
      }),
    );
    expectFatal(result, "too_many_layer_names");
  });

  it("the compiled batch satisfies AGENT_BATCH_SCHEMA (§8.5 envelope)", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
            { command: "prop.set", params: { layer: "Headline", path: "transform/opacity", value: 40 } },
          ]),
        ]),
      ),
    );
    const check = AGENT_BATCH_SCHEMA.safeParse(result.batch);
    expect(check.success).toBe(true);
  });

  it("the compiled batch carries no $N references (names only)", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
            { command: "prop.set", params: { layer: "$2.layer", path: "x", value: 1 } }, // proposal noise
          ]),
        ]),
      ),
    );
    expect(collectRefs(result.batch.steps)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Allowlists: unknown tool/command fatal; proposals warn (translation wins)
// ---------------------------------------------------------------------------

describe("allowlist + proposed-batch validation", () => {
  it("an unknown tool is fatal", () => {
    const issues = expectFatal(compile(plan([step("studio.nuke_everything", { all: true })])), "unknown_tool");
    expect(issues.every((issue) => issue.severity === "fatal")).toBe(true);
  });

  it("a tool missing from the injected deps is fatal (deps are the seam)", () => {
    const customDeps: CompileDeps = {
      registry: REGISTRY,
      writeTools: { save_version: WRITE_TOOLS.save_version },
    };
    expectFatal(
      compile(plan([step("set_properties", { updates: [{ layer: "H", path: "p", value: 1 }] })]), customDeps),
      "unknown_tool",
    );
  });

  it("a registry without the translated command fatals with the compiled step", () => {
    const trimmed: CommandSchema = { ...REGISTRY };
    delete trimmed["layer.newText"];
    const issues = expectFatal(
      compile(
        plan([step("create_text", { text: "Hi" }, [{ command: "layer.newText", params: { text: "Hi" } }])]),
        { ...DEPS, registry: trimmed },
      ),
      "unknown_command",
    );
    expect(issues.find((issue) => issue.code === "unknown_command")?.batchStep).toBe(1);
  });

  it("a compiled command missing a registry-required param is fatal", () => {
    // prop.set without `value` — the registry (M5-J) is the authority (prop.rs).
    const issues = expectFatal(
      compile(plan([step("set_properties", { updates: [{ layer: "Headline", path: "name" }] })])),
      "missing_required_param",
    );
    expect(issues.find((issue) => issue.code === "missing_required_param")?.param).toBe("value");
  });

  it("an unknown PROPOSED command warns; the compiled batch still comes from args", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
            { command: "layer.nuke", params: { everything: true } },
          ]),
        ]),
      ),
    );
    expect(result.batch.steps[0]?.command).toBe("prop.set");
    const codes = warningCodes(result);
    expect(codes).toContain("unknown_command");
    expect(codes).toContain("batch_mismatch");
  });

  it("a proposed __proto__ command id cannot resolve through the prototype chain", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
            { command: "__proto__", params: { polluted: "PWNED" } },
          ]),
        ]),
      ),
    );
    expect(warningCodes(result)).toContain("unknown_command");
    expect(JSON.stringify(result.batch)).not.toContain("PWNED");
  });

  it("a proposed batch missing a required param warns", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
            { command: "prop.set", params: { layer: "Headline", path: "x" } }, // no value
          ]),
        ]),
      ),
    );
    expect(warningCodes(result)).toContain("missing_required_param");
  });

  it("an exactly-agreeing proposal with different param key order produces no mismatch warn", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }, [
            { command: "prop.set", params: { value: 40, path: "transform/opacity", layer: "Headline" } },
          ]),
        ]),
      ),
    );
    expect(warningCodes(result)).not.toContain("batch_mismatch");
  });
});

// ---------------------------------------------------------------------------
// 4. $N.key reference validation on PROPOSED batches (warn; compiled is clean)
// ---------------------------------------------------------------------------

describe("$N references", () => {
  const baseArgs = { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] };

  it("a forward reference warns", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", baseArgs, [
            { command: "prop.set", params: { layer: "$2.layer", path: "x", value: 1 } },
            { command: "prop.set", params: { layer: "Headline", path: "x", value: 2 } },
          ]),
        ]),
      ),
    );
    expect(warningCodes(result)).toContain("unresolvable_ref");
  });

  it("a self reference warns", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", baseArgs, [{ command: "prop.set", params: { layer: "$1.layer", path: "x", value: 1 } }]),
        ]),
      ),
    );
    expect(warningCodes(result)).toContain("unresolvable_ref");
  });

  it("an out-of-range reference warns", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", baseArgs, [{ command: "prop.set", params: { layer: "$99.layer", path: "x", value: 1 } }]),
        ]),
      ),
    );
    expect(warningCodes(result)).toContain("unresolvable_ref");
  });
});

// ---------------------------------------------------------------------------
// 5. Layer-name resolution requests + placeholders
// ---------------------------------------------------------------------------

describe("layer name resolution", () => {
  it("requests are deduped and placeholders cover every occurrence", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] }),
          step("set_keyframes", { layer: "Headline", propertyPath: "transform/scale", keyframes: [{ time: 0, value: 100 }] }),
        ]),
      ),
    );
    expect(result.resolutionRequests).toEqual([
      { requestId: "lr-1", layerName: "Headline", disambiguation: ["Set opacity to 40"] },
    ]);
    expect(result.placeholders).toHaveLength(2);
    expect(result.placeholders.every((p) => p.requestId === "lr-1" && p.layerName === "Headline")).toBe(true);
    expect(result.placeholders.map((p) => [p.step, p.param])).toEqual([
      [1, "layer"],
      [2, "layer"],
    ]);
  });

  it("duplicate affectedLayers rows merge into one request with all changes", () => {
    const result = expectOk(
      compile(
        plan([step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] })], {
          affectedLayers: [
            { name: "Headline", change: "Set opacity" },
            { name: "Headline", change: "Also recolor" },
          ],
        }),
      ),
    );
    expect(result.resolutionRequests).toEqual([
      { requestId: "lr-1", layerName: "Headline", disambiguation: ["Set opacity", "Also recolor"] },
    ]);
  });

  it("a resolver substitutes authoritative ids and omits the request", () => {
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "x", value: 1 }] }),
          step("add_effect", { layer: "Headline", effect: "Gaussian Blur" }),
        ]),
        { ...DEPS, layerResolver: (name) => (name === "Headline" ? 7 : undefined) },
      ),
    );
    expect(result.resolutionRequests).toHaveLength(0);
    expect(result.batch.steps[0]?.params.layer).toBe(7);
    expect(result.batch.steps[1]?.params.layers).toEqual([7]);
    expect(result.placeholders.every((p) => p.resolvedId === 7)).toBe(true);
  });

  it("a partial resolver keeps name-based requests for unresolved names", () => {
    const result = expectOk(
      compile(
        plan(
          [
            step("set_properties", {
              updates: [
                { layer: "Headline", path: "x", value: 1 },
                { layer: "Logo", path: "y", value: 2 },
              ],
            }),
          ],
          { affectedLayers: [{ name: "Headline", change: "Set" }] },
        ),
        { ...DEPS, layerResolver: (name) => (name === "Headline" ? 7 : undefined) },
      ),
    );
    expect(result.resolutionRequests).toEqual([{ requestId: "lr-1", layerName: "Logo", disambiguation: [] }]);
    expect(result.batch.steps[0]?.params.layer).toBe(7);
    expect(result.batch.steps[1]?.params.layer).toBe("Logo");
    expect(warningCodes(result)).toContain("undeclared_layer");
  });

  it("a throwing resolver degrades to name-based resolution with a warn", () => {
    const result = expectOk(
      compile(
        plan([step("set_properties", { updates: [{ layer: "Headline", path: "x", value: 1 }] })]),
        {
          ...DEPS,
          layerResolver: () => {
            throw new Error("bridge down");
          },
        },
      ),
    );
    expect(warningCodes(result)).toContain("resolver_error");
    expect(result.batch.steps[0]?.params.layer).toBe("Headline");
    expect(result.resolutionRequests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Hostile args — nothing may crash (typed results only)
// ---------------------------------------------------------------------------

describe("hostile args (injection corpus patterns)", () => {
  it("dunder/proto keys in args never pollute anything", () => {
    const args = JSON.parse(
      '{"__proto__":{"polluted":"ARG-PROTO-PWNED"},"constructor":{"prototype":{"polluted":"ARG-PROTO-PWNED"}},' +
        '"updates":[{"layer":"Headline","path":"transform/opacity","value":40}]}',
    );
    const result = expectOk(compile(plan([step("set_properties", args)])));
    expect(JSON.stringify(result.batch)).not.toContain("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a 999-entry updates array is rejected by the tool schema bound (no crash)", () => {
    const updates = Array.from({ length: 999 }, (_v, i) => ({ layer: `l${i}`, path: "transform/opacity", value: 1 }));
    expectFatal(compile(plan([step("set_properties", { updates })])), "invalid_args");
  });

  it("deeply nested values compile to a typed result without throwing", () => {
    let deep: unknown = { leaf: true };
    for (let depth = 0; depth < 500; depth += 1) deep = { nested: deep };
    const result = compile(
      plan([step("set_properties", { updates: [{ layer: "Headline", path: "x", value: deep }] })]),
    );
    expect(result.ok).toBe(true);
  });

  it("non-object args (null / string / array / number) are schema-rejected, not crashes", () => {
    for (const hostile of [null, "layerId=1; DROP TABLE", [1, 2, 3], 42]) {
      expectFatal(compile(plan([step("set_properties", hostile)])), "invalid_args");
    }
  });

  it("cyclic structures yield a typed fatal, never a throw", () => {
    const cyclic: Record<string, unknown> = { updates: [{ layer: "Headline", path: "x", value: null }] };
    (cyclic.updates as Array<Record<string, unknown>>)[0].value = cyclic;
    const result = compile(plan([step("set_properties", cyclic)]));
    expect(result.ok).toBe(false);
  });

  it("an args validation crash inside an injected schema is contained", () => {
    const hostileDeps: CompileDeps = {
      registry: REGISTRY,
      writeTools: {
        set_properties: {
          args: {
            safeParse: () => {
              throw new Error("hostile schema");
            },
          } as unknown as ZodTypeAny,
        },
      },
    };
    const result = compile(
      plan([step("set_properties", { updates: [{ layer: "H", path: "p", value: 1 }] })]),
      hostileDeps,
    );
    expectFatal(result, "invalid_args");
  });
});

// ---------------------------------------------------------------------------
// 7. Risk + credits recompute (never the model's numbers)
// ---------------------------------------------------------------------------

describe("risk + credits recompute", () => {
  it("a lying model (risk high, 999 credits) is recomputed from the compiled commands", () => {
    const result = expectOk(
      compile(
        plan([step("set_properties", { updates: [{ layer: "Headline", path: "transform/opacity", value: 40 }] })], {
          risk: "high",
          estimatedCredits: 999,
          requiresApproval: true,
        }),
      ),
    );
    expect(result.risk).toBe("low");
    expect(result.estimatedCredits).toBe(estimateCredits({ risk: "low", steps: [{}] }));
    expect(result.estimatedCredits).not.toBe(999);
  });

  it("undo_run floors risk at medium via the edit.undo command floor alone", () => {
    const result = expectOk(
      compile(plan([step("undo_run", {}, [{ command: "edit.undo", params: {} }])], { affectedLayers: [] }), bareToolsDep()),
    );
    expect(result.risk).toBe("medium");
  });

  it("add_effect floors risk at medium via the tool-catalog floor", () => {
    const result = expectOk(compile(plan([step("add_effect", { layer: "Headline", effect: "Glow" })])));
    expect(result.risk).toBe("medium");
  });

  it("recomputePlanRisk: delete/remove/render force medium; clean commands stay low", () => {
    expect(recomputePlanRisk([{ command: "effect.remove" }])).toBe("medium");
    expect(recomputePlanRisk([{ command: "effect.removeAll" }])).toBe("medium");
    expect(recomputePlanRisk([{ command: "keys.delete" }])).toBe("medium");
    expect(recomputePlanRisk([{ command: "render.frame" }])).toBe("medium");
    expect(recomputePlanRisk([{ command: "comp.new" }])).toBe("low");
    expect(recomputePlanRisk([], "medium")).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// 8. Determinism + input forms
// ---------------------------------------------------------------------------

describe("determinism + input forms", () => {
  it("the same plan compiles to a deep-equal result twice", () => {
    const thePlan = plan([
      step("create_text", { text: "Hello" }, [{ command: "layer.newText", params: { text: "Hello" } }]),
      step("set_properties", { updates: [{ layer: "Headline", path: "x", value: 1 }] }),
    ]);
    const first = compile(thePlan);
    const second = compile(thePlan);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("arg field order does not change the compiled result", () => {
    const a = plan([step("set_properties", { updates: [{ layer: "Headline", path: "x", value: 1 }] })]);
    const b = plan([step("set_properties", { updates: [{ value: 1, path: "x", layer: "Headline" }] })]);
    expect(JSON.stringify(compile(a))).toBe(JSON.stringify(compile(b)));
  });

  it("accepts the SEAMS CompilePlanInput form ({plan}) as well as a bare EditPlan", () => {
    const thePlan = plan([step("undo_run", {}, [{ command: "edit.undo", params: {} }])]);
    const wrapped = expectOk(compilePlan({ plan: thePlan }, DEPS));
    const direct = expectOk(compilePlan(thePlan, DEPS));
    expect(JSON.stringify(wrapped)).toBe(JSON.stringify(direct));
  });

  it("prefixed tool ids (studio.*) normalize to the same 8 write tools", () => {
    const result = expectOk(
      compile(
        plan([
          step("studio.set_properties", { updates: [{ layer: "Headline", path: "x", value: 1 }] }, [
            { command: "prop.set", params: { layer: "Headline", path: "x", value: 1 } },
          ]),
        ]),
      ),
    );
    expect(result.batch.steps[0]?.command).toBe("prop.set");
    expect(warningCodes(result)).not.toContain("batch_mismatch");
  });

  it("an unusable step under the stub-era (passthrough) schemas warns and still compiles the rest", () => {
    // M5-A's stub is passthrough — a step with no usable fields must not crash.
    const stubDeps: CompileDeps = {
      registry: REGISTRY,
      writeTools: Object.fromEntries(Object.keys(WRITE_TOOLS).map((id) => [id, z.object({}).passthrough()])),
    };
    const result = expectOk(
      compile(
        plan([
          step("set_properties", { updates: [{ layer: "Headline", path: "x", value: 1 }] }),
          step("create_text", { position: "top-left" }),
        ]),
        stubDeps,
      ),
    );
    const codes = warningCodes(result);
    expect(codes).toContain("unusable_args");
    expect(result.batch.steps).toHaveLength(1);
  });
});
