import { describe, expect, it } from "vitest";
import {
  AGENT_BATCH_SCHEMA,
  EDIT_PLAN_SCHEMA,
  WRITE_TOOL_ARGS_SCHEMAS,
  hasNoDunderKeys,
} from "@studio/contracts";
import { compilePlan, defaultCompileDeps } from "../src/plan-compiler.js";
import {
  BATCH_WIRE_POISONS,
  COMPILER_DRIFT_PROBES,
  DRIFT_MIXED_PLAN,
  WRITE_ARGS_INJECTIONS,
  WRITE_PLAN_INJECTIONS,
  writeArgsValue,
  writePlan,
  writeStep,
} from "./injection-write.js";

describe("corpus verification", () => {
  it("args expectations", () => {
    for (const fixture of WRITE_ARGS_INJECTIONS) {
      const schema = WRITE_TOOL_ARGS_SCHEMAS[fixture.tool];
      const parsed = schema.safeParse(writeArgsValue(fixture));
      if (fixture.expectation === "reject") {
        if (parsed.success) console.log(`UNEXPECTED-PARSE: ${fixture.id}`);
      } else if (!parsed.success) {
        console.log(`UNEXPECTED-REJECT: ${fixture.id}: ${(parsed.error.issues[0]?.message ?? "").slice(0,60)}`);
      } else if (!hasNoDunderKeys(parsed.data)) {
        console.log(`DUNDER-IN-OUTPUT: ${fixture.id}`);
      }
    }
  });

  it("plan expectations", () => {
    for (const fixture of WRITE_PLAN_INJECTIONS) {
      const plan = JSON.parse(fixture.planJson);
      const schemaOk = EDIT_PLAN_SCHEMA.safeParse(plan).success;
      const result = compilePlan(plan as never, defaultCompileDeps());
      const summary = result.ok
        ? `ok cmds=${result.batch.steps.map((s) => s.command).join("|")} needles=${fixture.poisonNeedles.filter((n) => JSON.stringify(result.batch).includes(n)).join(",")} dunderClean=${hasNoDunderKeys(result.batch)} agentValid=${AGENT_BATCH_SCHEMA.safeParse(result.batch).success}`
        : `fail codes=${result.issues.map((i) => i.code).join("|")}`;
      console.log(`${fixture.id} [exp=${fixture.expectation}] schema=${schemaOk} :: ${summary}`);
    }
  });

  it("drift expectations", () => {
    for (const probe of COMPILER_DRIFT_PROBES) {
      const plan = writePlan([writeStep(probe.tool, JSON.parse(probe.argsJson))]);
      const result = compilePlan(plan as never, defaultCompileDeps());
      if (probe.compiledToday === "empty") {
        console.log(`${probe.id}: ${result.ok ? "UNEXPECTED-OK" : `empty-codes=${result.issues.map((i) => i.code).join("|")}`}`);
      } else {
        console.log(`${probe.id}: ${result.ok ? JSON.stringify(result.batch.steps[0]) : "UNEXPECTED-FAIL"}`);
      }
    }
    const mixed = compilePlan(DRIFT_MIXED_PLAN as never, defaultCompileDeps());
    console.log("mixed:", mixed.ok ? `cmds=${mixed.batch.steps.map((s) => s.command).join("|")} warns=${mixed.warnings.map((w) => w.code).join("|")}` : "FAIL");
  });

  it("wire expectations", () => {
    for (const fixture of BATCH_WIRE_POISONS) {
      const parsed = AGENT_BATCH_SCHEMA.safeParse(JSON.parse(fixture.batchJson));
      const ok = parsed.success === (fixture.expectation === "parse");
      console.log(`${ok ? "OK" : "MISMATCH"} ${fixture.id}: exp=${fixture.expectation} got=${parsed.success}`);
    }
  });
});
