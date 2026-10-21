import { describe, expect, it } from "vitest";

import {
  AGENT_BATCH_SCHEMA,
  type AgentBatch,
  BATCH_STEP_SCHEMA,
  type CommandSchema,
  DEFAULT_BATCH_TIMEOUT_MS,
  MAX_BATCH_BYTES,
  MAX_BATCH_STEPS,
  MAX_BATCH_TIMEOUT_MS,
  checkBatchCommands,
  collectRefs,
  validateBatchRefs,
} from "../src/engine-batch.js";

/** The §8.5 example batch, verbatim in structure. */
function docExample(): Record<string, unknown> {
  return {
    label: "Agent: build kinetic title",
    atomic: true,
    steps: [
      { command: "comp.new", params: { name: "Main", width: 1920, height: 1080 } },
      { command: "layer.newSolid", params: { name: "Background", color: "#0B0D10" } },
      { command: "layer.rename", params: { layer: "$2.layer", name: "Background" } },
      { command: "prop.set", params: { layer: "$2.layer", path: "transform/opacity", value: 100 } },
    ],
  };
}

function step(command: string, params: Record<string, unknown> = {}) {
  return { command, params };
}

describe("engine-batch: §8.5 acceptance", () => {
  it("parses the doc example (backwards $N.key refs resolve)", () => {
    const parsed = AGENT_BATCH_SCHEMA.safeParse(docExample());
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("agent batches are atomic: literal true only", () => {
    expect(AGENT_BATCH_SCHEMA.safeParse({ ...docExample(), atomic: false }).success).toBe(false);
    expect(AGENT_BATCH_SCHEMA.safeParse({ label: "l", steps: [step("x")] }).success).toBe(false);
  });

  it("bounds steps to 1..100", () => {
    const empty = AGENT_BATCH_SCHEMA.safeParse({ label: "l", atomic: true, steps: [] });
    expect(empty.success).toBe(false);
    const big = Array.from({ length: MAX_BATCH_STEPS + 1 }, (_, i) => step(`c${i}`));
    expect(AGENT_BATCH_SCHEMA.safeParse({ label: "l", atomic: true, steps: big }).success).toBe(
      false,
    );
    expect(
      AGENT_BATCH_SCHEMA.safeParse({
        label: "l",
        atomic: true,
        steps: Array.from({ length: MAX_BATCH_STEPS }, (_, i) => step(`c${i}`)),
      }).success,
    ).toBe(true);
  });

  it("bounds timeout to ≤ 60 s and defaults to the ceiling", () => {
    const over = AGENT_BATCH_SCHEMA.safeParse({
      ...docExample(),
      timeoutMs: MAX_BATCH_TIMEOUT_MS + 1,
    });
    expect(over.success).toBe(false);
    expect(
      AGENT_BATCH_SCHEMA.safeParse({ ...docExample(), timeoutMs: MAX_BATCH_TIMEOUT_MS }).success,
    ).toBe(true);
    expect(DEFAULT_BATCH_TIMEOUT_MS).toBe(60_000);
  });

  it("rejects batches over the 2 MiB serialized limit and admits ~1 MiB", () => {
    const blob = "a".repeat(MAX_BATCH_BYTES); // alone already at the cap; JSON overhead pushes over
    const over = AGENT_BATCH_SCHEMA.safeParse({
      label: "l",
      atomic: true,
      steps: [step("layer.newSolid", { color: blob })],
    });
    expect(over.success).toBe(false);
    const okBlob = "a".repeat(1024 * 1024);
    expect(
      AGENT_BATCH_SCHEMA.safeParse({
        label: "l",
        atomic: true,
        steps: [step("layer.newSolid", { color: okBlob })],
      }).success,
    ).toBe(true);
  });

  it("BATCH_STEP_SCHEMA requires a command string and params record", () => {
    expect(BATCH_STEP_SCHEMA.safeParse(step("x")).success).toBe(true);
    expect(BATCH_STEP_SCHEMA.safeParse({ command: "", params: {} }).success).toBe(false);
    expect(BATCH_STEP_SCHEMA.safeParse({ command: "x", params: "nope" }).success).toBe(false);
  });
});

describe("engine-batch: $N.key references", () => {
  it("rejects forward references and refs without a matching step", () => {
    const forward = AGENT_BATCH_SCHEMA.safeParse({
      label: "l",
      atomic: true,
      steps: [step("a", { ref: "$2.layer" }), step("b")],
    });
    expect(forward.success, JSON.stringify(forward)).toBe(false); // step 1 cannot see step 2

    const beyond = AGENT_BATCH_SCHEMA.safeParse({
      label: "l",
      atomic: true,
      steps: [step("a", { ref: "$5.layer" }), step("b", { ref: "$9.x" })],
    });
    expect(beyond.success).toBe(false); // $ref-without-step

    const zero = AGENT_BATCH_SCHEMA.safeParse({
      label: "l",
      atomic: true,
      steps: [step("a", { ref: "$0.layer" }), step("b", { ref: "$1.layer" })],
    });
    expect(zero.success).toBe(false); // positions are 1-based
  });

  it("accepts backwards references, including dotted paths", () => {
    const batch = {
      label: "l",
      atomic: true,
      steps: [
        step("a"),
        step("b", { layer: "$1.layer", nested: { deep: ["$1.transform.position"] } }),
      ],
    };
    expect(AGENT_BATCH_SCHEMA.safeParse(batch).success).toBe(true);
    expect(validateBatchRefs((batch as AgentBatch).steps)).toEqual([]);
  });

  it("collectRefs walks strings, arrays and nested objects, skipping bare $N", () => {
    const refs = collectRefs({
      a: "$1.layer",
      b: ["$2.x", "plain"],
      c: { d: "use $3.transform.position here" },
      money: "$1,000",
      bare: "$5",
    });
    expect(refs.map((r) => r.raw)).toEqual(["$1.layer", "$2.x", "$3.transform.position"]);
    expect(refs[0]).toMatchObject({ step: 1, path: ["layer"], origin: "a" });
    const dotted = refs.find((r) => r.step === 3);
    expect(dotted?.path).toEqual(["transform", "position"]);
    expect(dotted?.origin).toBe("c.d");
    expect(refs[1]?.origin).toBe("b[0]");
  });

  it("validateBatchRefs classifies self / forward / out_of_range", () => {
    const steps = [step("a", { x: "$1.y" }), step("b", { x: "$3.z" }), step("c", { x: "$9.q" })];
    const issues = validateBatchRefs(steps);
    expect(issues.map((i) => `${i.step}:${i.reason}`).sort()).toEqual([
      "1:self",
      "2:forward",
      "3:out_of_range",
    ]);
  });
});

describe("engine-batch: live-registry command validation (§8.5)", () => {
  const registry: CommandSchema = {
    "comp.new": {
      id: "comp.new",
      params: [
        { name: "name", required: true, type: "string" },
        { name: "width", required: true, type: "number" },
        { name: "height", required: true, type: "number" },
      ],
    },
    "layer.rename": { id: "layer.rename", params: [{ name: "layer", required: true }] },
  };

  it("flags unknown command ids", () => {
    const issues = checkBatchCommands({ steps: [step("comp.nope")] }, registry);
    expect(issues).toEqual([{ step: 1, command: "comp.nope", reason: "unknown_command" }]);
  });

  it("flags missing required params", () => {
    const issues = checkBatchCommands({ steps: [step("comp.new", { name: "Main" })] }, registry);
    expect(issues).toEqual([
      {
        step: 1,
        command: "comp.new",
        reason: "missing_required_param",
        param: "width",
      },
      {
        step: 1,
        command: "comp.new",
        reason: "missing_required_param",
        param: "height",
      },
    ]);
  });

  it("passes a fully-described batch", () => {
    const batch = { steps: [step("comp.new", { name: "Main", width: 1920, height: 1080 })] };
    expect(checkBatchCommands(batch, registry)).toEqual([]);
  });
});
