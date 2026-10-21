// W9-C — metering usage accumulator: per-model + per-tool rollup to agent_runs
// cost fields, step-level rollup to agent_steps, bigint money invariants.
import { afterEach, describe, expect, it } from "vitest";
import { MeteringError, resolveModelRates } from "../../src/metering/cost-model.js";
import { RunUsage, type RunUsageRow } from "../../src/metering/usage-accumulator.js";

// Known-good hand-computed costs (Flash $0.75/$3.75, Sonnet $2/$10 per M):
const FLASH_STD_CALL = 46_350n; // 80k in / 5k out / 60% cache-hit ($0.04635)
const SONNET_PLAN_CALL = 30_000n; // 10k in / 1k out, no cache
const FLASH_BARE_CALL = 22_500n; // 20k in / 2k out, no cache
const RUN_TOTAL = FLASH_STD_CALL + SONNET_PLAN_CALL + FLASH_BARE_CALL; // 98_850

function seededRun(): RunUsage {
  const usage = new RunUsage();
  const step1 = usage.openStep({ seq: 1, phase: "executing", tool: "template_apply" });
  step1.addModelCall("gemini-3.8-flash", { tokensIn: 80_000, tokensOut: 5_000, cacheHits: 48_000 });
  step1.addToolCall("template_apply", { durationMs: 120 });
  step1.addToolCall("template_apply", { error: true, durationMs: 30 });
  usage.closeStep(step1);
  const step2 = usage.openStep({ seq: 2, phase: "critiquing", tool: null });
  step2.addModelCall("claude-sonnet-5.5", { tokensIn: 10_000, tokensOut: 1_000 });
  usage.closeStep(step2);
  // Bare run-level call (planner) — not part of any step.
  usage.addModelCall("gemini-3.8-flash", { tokensIn: 20_000, tokensOut: 2_000 });
  usage.addToolCall("render_preview", { durationMs: 15 });
  return usage;
}

describe("W9-C usage accumulator: toRow matches agent_runs cost fields", () => {
  it("aggregates tokens, cache hits and per-model usage with exact costs", () => {
    const row: RunUsageRow = seededRun().toRow("run_123");
    expect(row.runId).toBe("run_123");
    expect(row.tokensIn).toBe(110_000);
    expect(row.tokensOut).toBe(8_000);
    expect(row.cacheHits).toBe(48_000);
    expect(row.costMicroUsd).toBe(Number(RUN_TOTAL));
    expect(Object.keys(row.modelCalls).sort()).toEqual(["claude-sonnet-5.5", "gemini-3.8-flash"]);
    // runs.ts ModelCallUsage shape: { calls, tokensIn, tokensOut, cacheHits, costMicroUsd }
    expect(row.modelCalls["gemini-3.8-flash"]).toEqual({
      calls: 2,
      tokensIn: 100_000,
      tokensOut: 7_000,
      cacheHits: 48_000,
      costMicroUsd: Number(FLASH_STD_CALL + FLASH_BARE_CALL),
    });
    expect(row.modelCalls["claude-sonnet-5.5"]).toEqual({
      calls: 1,
      tokensIn: 10_000,
      tokensOut: 1_000,
      cacheHits: 0,
      costMicroUsd: Number(SONNET_PLAN_CALL),
    });
  });

  it("per-model costs sum to the run total; run total is ≤ MAX_SAFE_INTEGER-checked", () => {
    const row = seededRun().toRow("r");
    const perModelSum = Object.values(row.modelCalls).reduce((sum, m) => sum + m.costMicroUsd, 0);
    expect(perModelSum).toBe(row.costMicroUsd);
  });

  it("addModelCall returns the call's exact bigint cost", () => {
    const usage = new RunUsage();
    const cost = usage.addModelCall("gemini-3.8-flash", {
      tokensIn: 80_000,
      tokensOut: 5_000,
      cacheHits: 48_000,
    });
    expect(cost).toBe(FLASH_STD_CALL);
  });

  it("rows are frozen (persistence layer gets immutable rows)", () => {
    const row = seededRun().toRow("run_123");
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.modelCalls)).toBe(true);
  });

  it("refuses empty run ids (agent_runs.id is mandatory)", () => {
    const usage = new RunUsage();
    expect(() => usage.toRow("")).toThrowError(MeteringError);
    expect(() => usage.toRow("  ")).toThrowError(MeteringError);
  });
});

describe("W9-C usage accumulator: step rollup matches agent_steps cost fields", () => {
  it("step rows carry tokens in/out + cost, per-tool calls/errors and duration", () => {
    const usage = seededRun();
    const steps = usage.steps();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      seq: 1,
      phase: "executing",
      tool: "template_apply",
      tokensIn: 80_000,
      tokensOut: 5_000,
      costMicroUsd: Number(FLASH_STD_CALL),
      toolCalls: 2,
      toolErrors: 1,
      durationMs: 150,
    });
    // agent_steps carries no cache column — cache lives on the run row only.
    expect(steps[1]).toEqual({
      seq: 2,
      phase: "critiquing",
      tool: null,
      tokensIn: 10_000,
      tokensOut: 1_000,
      costMicroUsd: Number(SONNET_PLAN_CALL),
      toolCalls: 0,
      toolErrors: 0,
      durationMs: 0,
    });
  });

  it("INVARIANT: Σ step costs + bare-call cost = run total (single counting path)", () => {
    const usage = seededRun();
    const stepSum = usage
      .steps()
      .reduce((sum, step) => sum + BigInt(step.costMicroUsd), 0n);
    const row = usage.toRow("r");
    expect(stepSum).toBe(RUN_TOTAL - FLASH_BARE_CALL);
    expect(row.costMicroUsd).toBe(Number(RUN_TOTAL));
    // token totals reconcile the same way
    const stepTokensIn = usage.steps().reduce((sum, step) => sum + step.tokensIn, 0);
    expect(stepTokensIn).toBe(row.tokensIn - 20_000);
  });

  it("steps are strictly sequential: one open scope at a time", () => {
    const usage = new RunUsage();
    const open = usage.openStep({ seq: 1, phase: "executing", tool: "text_set" });
    try {
      usage.openStep({ seq: 2, phase: "executing", tool: "text_set" });
      expect.unreachable("second openStep must throw");
    } catch (error) {
      expect((error as MeteringError).code).toBe("invalid_usage");
    }
    usage.closeStep(open);
    // After close, the next step opens fine.
    const next = usage.openStep({ seq: 2, phase: "finalizing", tool: null });
    expect(next.seq).toBe(2);
  });

  it("closing the wrong step, or usage after close, is refused", () => {
    const usage = new RunUsage();
    const first = usage.openStep({ seq: 1, phase: "executing", tool: null });
    usage.closeStep(first);
    const reopened = usage.openStep({ seq: 2, phase: "executing", tool: null });
    try {
      usage.closeStep(first); // already closed, not the open step
      expect.unreachable("double close must throw");
    } catch (error) {
      expect((error as MeteringError).code).toBe("invalid_usage");
    }
    usage.closeStep(reopened);
    try {
      first.addModelCall("gemini-3.8-flash", { tokensIn: 1, tokensOut: 1 });
      expect.unreachable("post-close usage must throw");
    } catch (error) {
      expect((error as MeteringError).code).toBe("invalid_usage");
    }
  });

  it("rejects invalid step seq (agent_steps.seq is 1-based)", () => {
    const usage = new RunUsage();
    for (const seq of [0, -1, 1.5]) {
      expect(() => usage.openStep({ seq, phase: "executing", tool: null })).toThrowError(MeteringError);
    }
  });
});

describe("W9-C usage accumulator: §22 tool-error-rate aggregation", () => {
  it("toolUsage rows are sorted, error-tagged and duration-summed", () => {
    const usage = seededRun();
    expect(usage.toolUsage()).toEqual([
      { tool: "render_preview", calls: 1, errors: 0, durationMs: 15 },
      { tool: "template_apply", calls: 2, errors: 1, durationMs: 150 },
    ]);
  });

  it("snapshot exposes the §22 counters (tokens, cost, tools, steps)", () => {
    const snap = seededRun().snapshot();
    expect(snap).toEqual({
      tokensIn: 110_000,
      tokensOut: 8_000,
      cacheHits: 48_000,
      costMicroUsd: RUN_TOTAL,
      modelCalls: 2,
      toolCalls: 3,
      toolErrors: 1,
      steps: 2,
    });
  });

  it("refuses blank tool names and negative durations", () => {
    const usage = new RunUsage();
    expect(() => usage.addToolCall("", {})).toThrowError(MeteringError);
    expect(() => usage.addToolCall("text_set", { durationMs: -1 })).toThrowError(MeteringError);
    expect(() => usage.addToolCall("text_set", { durationMs: 1.5 })).toThrowError(MeteringError);
  });
});

describe("W9-C usage accumulator: rates injection and money guards", () => {
  it("uses Appendix C defaults when no rates are injected (clean env)", () => {
    const hadKey = Object.hasOwn(process.env, "MODEL_RATES_JSON");
    const previous = hadKey ? process.env.MODEL_RATES_JSON : undefined;
    if (hadKey) delete process.env.MODEL_RATES_JSON;
    try {
      const usage = new RunUsage();
      usage.addModelCall("gemini-3.8-flash", { tokensIn: 1_000_000, tokensOut: 0 });
      expect(usage.toRow("r").costMicroUsd).toBe(750_000);
    } finally {
      if (hadKey) process.env.MODEL_RATES_JSON = previous;
    }
  });

  it("accepts an injected resolved table (boot-time MODEL_RATES_JSON)", () => {
    const rates = resolveModelRates({
      MODEL_RATES_JSON: '{"gemini-3.8-flash":{"kind":"text","inputUsdPerM":1.5,"outputUsdPerM":7.5}}',
    });
    const usage = new RunUsage({ rates });
    usage.addModelCall("gemini-3.8-flash", { tokensIn: 1_000_000, tokensOut: 0 });
    expect(usage.toRow("r").costMicroUsd).toBe(1_500_000);
  });

  it("fails fast at construction on a broken MODEL_RATES_JSON (money path)", () => {
    expect(() => new RunUsage({ rates: resolveModelRates({ MODEL_RATES_JSON: "{oops" }) })).toThrowError(
      MeteringError,
    );
  });

  it("unknown models throw model_rate_missing — never a silent $0", () => {
    const usage = new RunUsage();
    try {
      usage.addModelCall("mystery-model", { tokensIn: 10, tokensOut: 10 });
      expect.unreachable("unknown model must throw");
    } catch (error) {
      expect((error as MeteringError).code).toBe("model_rate_missing");
    }
  });

  it("bigint totals refuse to wrap through float64 at row time", () => {
    const usage = new RunUsage();
    // gpt-6-astra $50/M out: 2e14 tokens ⇒ 1e16 µ$ > Number.MAX_SAFE_INTEGER.
    usage.addModelCall("gpt-6-astra", { tokensIn: 0, tokensOut: 200_000_000_000_000 });
    expect(usage.snapshot().costMicroUsd).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    try {
      usage.toRow("r");
      expect.unreachable("overflowing cost must throw at row time");
    } catch (error) {
      expect((error as MeteringError).code).toBe("unsafe_number_conversion");
    }
  });
});

afterEach(() => {
  if (Object.hasOwn(process.env, "MODEL_RATES_JSON")) {
    delete process.env.MODEL_RATES_JSON;
  }
});
