// W9-E — obs/langfuse: §22 LLM trace sink. Pins (1) the §22/§15.3 masking
// table (redacted by default, opt-in passthrough), (2) the generation-record
// shape (W9-C usage rows → Langfuse usage + costMicroUsd + prompt version),
// (3) the env-gated Noop fallback, (4) the 10%-success sampling tie-in, and
// (5) "tracing must never break a run". Deterministic; no network (the one
// default-loader test only exercises module ABSENCE — 'langfuse' is not a
// dependency; if the worker installs it per obs/integration.md, swap that row
// for a fixture loader).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACE_SUCCESS_SAMPLE_RATE,
  NOOP_LANGFUSE,
  PROMPT_REDACTED,
  type GenerationUsage,
  type LangfuseLike,
  type LangfuseRunTrace,
  LangfuseTraceSink,
  defaultLangfuseClientLoader,
  defaultPromptMasker,
  formatPromptVersion,
  isRunSampled,
  noopLangfuse,
  readLangfuseEnv,
  resolveLangfuse,
} from "../src/obs/langfuse.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly method: "trace" | "span" | "generation";
  readonly traceRef: unknown;
  readonly body: Record<string, unknown>;
}

function recordingClient(): { client: LangfuseLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: LangfuseLike = {
    trace(body) {
      const traceRef = { id: `trace-${calls.length}` };
      calls.push({ method: "trace", traceRef, body: { ...body } });
      return traceRef;
    },
    span(traceRef, body) {
      calls.push({ method: "span", traceRef, body: { ...body } });
      return null;
    },
    generation(traceRef, body) {
      calls.push({ method: "generation", traceRef, body: { ...body } });
      return null;
    },
  };
  return { client, calls };
}

/** Deterministic clock: every read advances time by `stepMs`. */
function stepClock(stepMs = 5): () => number {
  let t = 0;
  return () => (t += stepMs);
}

function startTrace(
  client: LangfuseLike,
  overrides: Partial<import("../src/obs/langfuse.js").RunTraceStart> = {},
): { sink: LangfuseTraceSink; trace: LangfuseRunTrace } {
  const sink = new LangfuseTraceSink(client, { now: stepClock() });
  const start = {
    runId: "run_01HQ4",
    workspaceId: "ws_123",
    org: "acme",
    tier: "standard",
    requestId: "req_77",
    prompt: "SECRET USER BRIEF: neon sale poster",
    promptOptIn: false,
    ...overrides,
  };
  const trace = sink.startRun(start);
  return { sink, trace };
}

const USAGE: GenerationUsage = { tokensIn: 1200, tokensOut: 300, cacheHits: 800 };

// ---------------------------------------------------------------------------
// §22 / §15.3 masking table — redacted by default, opt-in passthrough
// ---------------------------------------------------------------------------

describe("defaultPromptMasker (§22 masking contract)", () => {
  it.each([
    { value: "neon sale poster with SECRET", optedIn: false, expected: PROMPT_REDACTED },
    {
      value: "neon sale poster with SECRET",
      optedIn: true,
      expected: "neon sale poster with SECRET",
    },
    { value: "", optedIn: false, expected: PROMPT_REDACTED },
    { value: "", optedIn: true, expected: "" },
  ])("optedIn=$optedIn value=%j → %j", ({ value, optedIn, expected }) => {
    expect(defaultPromptMasker(value, { kind: "prompt", runId: "r1", optedIn })).toBe(expected);
  });

  it("applies the identical policy to run summaries (kind only labels)", () => {
    const summaryCtx = (optedIn: boolean) => ({ kind: "summary", runId: "r1", optedIn });
    expect(defaultPromptMasker("headline rewritten", summaryCtx(false))).toBe(PROMPT_REDACTED);
    expect(defaultPromptMasker("headline rewritten", summaryCtx(true))).toBe(
      "headline rewritten",
    );
  });

  it("lets ops swap the whole policy via the injected masker", () => {
    const { client, calls } = recordingClient();
    const sink = new LangfuseTraceSink(client, {
      now: stepClock(),
      mask: (value, ctx) => (ctx.optedIn ? value : `▮${value.length}▮`),
    });
    sink.startRun({
      runId: "run_x",
      workspaceId: "ws_x",
      tier: "quick",
      prompt: "short brief",
      promptOptIn: false,
    });
    expect(calls[0]?.body.input).toBe("▮11▮");
  });
});

// ---------------------------------------------------------------------------
// Run trace emission
// ---------------------------------------------------------------------------

describe("run trace", () => {
  it("emits one trace with the §22 correlation chain and a MASKED prompt", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("trace");
    expect(call?.body.name).toBe("agent-run");
    expect(call?.body.input).toBe(PROMPT_REDACTED);
    expect(call?.body.metadata).toMatchObject({
      requestId: "req_77",
      workspaceId: "ws_123",
      org: "acme",
      runId: "run_01HQ4",
      tier: "standard",
      promptMasked: true,
    });
    expect(trace.ref).toBe(call?.traceRef);
  });

  it("never leaks the raw prompt into any payload when opted out", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.startStep({ stepSeq: 1, tool: "template_apply", phase: "execute" }).end({ ok: true });
    trace.recordGeneration({
      model: "gemini-2.5-flash",
      usage: USAGE,
      costMicroUsd: 42,
      metadata: { criticVerdict: "accept" },
    });
    trace.endRun({ status: "succeeded", summary: "headline echo of SECRET USER BRIEF" });
    expect(JSON.stringify(calls)).not.toContain("SECRET USER BRIEF");
  });

  it("passes the prompt through when the workspace opted in", () => {
    const { client, calls } = recordingClient();
    startTrace(client, { promptOptIn: true });
    expect(calls[0]?.body.input).toBe("SECRET USER BRIEF: neon sale poster");
    expect(calls[0]?.body.metadata).toMatchObject({ promptMasked: false });
  });

  it("keeps built-in correlation keys over caller metadata (chain integrity)", () => {
    const { client, calls } = recordingClient();
    startTrace(client, { metadata: { runId: "spoofed", channel: "web" } });
    expect(calls[0]?.body.metadata).toMatchObject({ runId: "run_01HQ4", channel: "web" });
  });
});

// ---------------------------------------------------------------------------
// Step spans
// ---------------------------------------------------------------------------

describe("step spans", () => {
  it("emits one span per step: tool name, duration, ok (events.ts field shape)", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.startStep({ stepSeq: 3, tool: "template_apply", phase: "execute" }).end({ ok: true });
    const call = calls[1];
    expect(call?.method).toBe("span");
    expect(call?.traceRef).toBe(trace.ref);
    expect(call?.body.name).toBe("step:3:template_apply");
    expect(call?.body.metadata).toMatchObject({
      runId: "run_01HQ4",
      stepSeq: 3,
      phase: "execute",
      tool: "template_apply",
      ok: true,
      durationMs: 5, // injected clock: one tick between startStep and end
    });
    expect(JSON.stringify(call?.body)).not.toContain("stack");
  });

  it("carries the typed error code on failure — never a stack trace", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace
      .startStep({ stepSeq: 4, tool: "layer.create", phase: "execute" })
      .end({ ok: false, error: { code: "tool_timeout", message: "layer.create exceeded 5000ms" } });
    expect(calls[1]?.body.metadata).toMatchObject({
      ok: false,
      errorCode: "tool_timeout",
      errorMessage: "layer.create exceeded 5000ms",
    });
    expect(JSON.stringify(calls[1]?.body)).not.toContain("stack");
  });

  it("names engine steps without a tool (tool: null, events.ts shape)", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.startStep({ stepSeq: 9, tool: null, phase: "validate" }).end({ ok: true });
    expect(calls[1]?.body.name).toBe("step:9");
    expect(calls[1]?.body.metadata).toMatchObject({ tool: null, phase: "validate" });
  });

  it("end() is idempotent — a step is emitted exactly once", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    const span = trace.startStep({ stepSeq: 1, tool: "t" });
    span.end({ ok: true });
    span.end({ ok: false });
    expect(calls.filter((c) => c.method === "span")).toHaveLength(1);
  });

  it("honors a worker-measured durationMs over sink timing", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.startStep({ stepSeq: 1, tool: "t" }).end({ ok: true, durationMs: 1234 });
    expect(calls[1]?.body.metadata).toMatchObject({ durationMs: 1234 });
  });
});

// ---------------------------------------------------------------------------
// Generation records (W9-C usage rows → Langfuse shape)
// ---------------------------------------------------------------------------

describe("generation records", () => {
  it("map usage rows, cost and the prompt version into the generation body", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.recordGeneration({
      phase: "planner",
      model: "gemini-2.5-flash",
      usage: USAGE,
      costMicroUsd: 420,
      promptId: "planner",
      promptVersion: 1,
    });
    const call = calls[1];
    expect(call?.method).toBe("generation");
    expect(call?.traceRef).toBe(trace.ref);
    expect(call?.body.name).toBe("generation:planner");
    expect(call?.body.model).toBe("gemini-2.5-flash");
    expect(call?.body.usage).toEqual({
      input: 1200,
      output: 300,
      cacheRead: 800,
      total: 1500,
    });
    expect(call?.body.cost).toBe(420);
    expect(call?.body.prompt).toBe("planner@v1");
    expect(call?.body.metadata).toMatchObject({
      runId: "run_01HQ4",
      phase: "planner",
      costMicroUsd: 420,
      cacheHits: 800,
      promptVersion: "planner@v1",
    });
  });

  it("clamps cacheHits above tokensIn defensively (W9-C invariant, never a throw)", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.recordGeneration({
      model: "gemini-2.5-flash",
      usage: { tokensIn: 100, tokensOut: 5, cacheHits: 999 }, // bad row from wiring
      costMicroUsd: 1,
    });
    expect(calls[1]?.body.usage).toEqual({ input: 100, output: 5, cacheRead: 100, total: 105 });
  });

  it("omit the prompt ref when the frontmatter version is unknown", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.recordGeneration({ model: "claude-sonnet", usage: USAGE, costMicroUsd: 1 });
    const body = calls[1]?.body;
    expect(body?.prompt).toBeUndefined();
    expect(body?.metadata).toMatchObject({ promptVersion: null, costMicroUsd: 1 });
  });

  it("format prompt versions from the packages/agent/prompts frontmatter pair", () => {
    expect(formatPromptVersion("planner", 1)).toBe("planner@v1");
    expect(formatPromptVersion("critic", 2)).toBe("critic@v2");
    expect(formatPromptVersion("chat-edit-classifier", "1-beta")).toBe(
      "chat-edit-classifier@v1-beta",
    );
  });
});

// ---------------------------------------------------------------------------
// endRun
// ---------------------------------------------------------------------------

describe("endRun", () => {
  it("closes the run with a status span and a masked summary", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.endRun({
      status: "succeeded",
      summary: "rewrote headline layer",
      metadata: { steps: 4 },
    });
    const call = calls[1];
    expect(call?.method).toBe("span");
    expect(call?.traceRef).toBe(trace.ref);
    expect(call?.body.name).toBe("run:succeeded");
    expect(call?.body.output).toBe(PROMPT_REDACTED);
    expect(call?.body.metadata).toMatchObject({
      runId: "run_01HQ4",
      status: "succeeded",
      steps: 4,
      durationMs: 5,
    });
  });

  it("pass the summary through when the workspace opted in", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client, { promptOptIn: true });
    trace.endRun({ status: "failed", summary: "validator blocked the render" });
    expect(calls[1]?.body.output).toBe("validator blocked the render");
  });

  it("omit output entirely when no summary was given", () => {
    const { client, calls } = recordingClient();
    const { trace } = startTrace(client);
    trace.endRun({ status: "cancelled" });
    expect(calls[1]?.body.output).toBeUndefined();
    expect(calls[1]?.body.metadata).toMatchObject({ status: "cancelled" });
  });
});

// ---------------------------------------------------------------------------
// Noop fallback (env-gated absence) + resolution
// ---------------------------------------------------------------------------

describe("noop fallback", () => {
  it("NOOP_LANGFUSE methods exist, return null and never throw", () => {
    expect(NOOP_LANGFUSE.trace({ name: "x" })).toBeNull();
    expect(NOOP_LANGFUSE.span(null, { name: "x" })).toBeNull();
    expect(
      NOOP_LANGFUSE.generation(null, {
        model: "m",
        usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
        cost: 0,
      }),
    ).toBeNull();
    expect(noopLangfuse()).not.toBe(NOOP_LANGFUSE); // fresh instances are distinct
  });

  it("a sink built without a client still completes a full run lifecycle", () => {
    const sink = new LangfuseTraceSink(); // default client = NOOP
    const trace = sink.startRun({
      runId: "run_noop",
      workspaceId: "ws_1",
      tier: "quick",
      prompt: "SECRET BRIEF",
      promptOptIn: false,
    });
    expect(() => {
      trace.startStep({ stepSeq: 1, tool: "template_apply" }).end({ ok: true });
      trace.recordGeneration({ model: "gemini-2.5-flash", usage: USAGE, costMicroUsd: 3 });
      trace.endRun({ status: "succeeded" });
    }).not.toThrow();
    expect(sink.dropped).toBe(0);
  });

  it("resolves to noop WITHOUT loading the module when keys are missing", async () => {
    let loadCalls = 0;
    const resolution = await resolveLangfuse(readLangfuseEnv({}), async () => {
      loadCalls += 1;
      return recordingClient().client;
    });
    expect(resolution).toMatchObject({ mode: "noop", reason: "missing-keys" });
    expect(resolution.client).toBe(NOOP_LANGFUSE);
    expect(loadCalls).toBe(0);
  });

  it("resolves to noop when only one key is present (half-configured env)", async () => {
    const env = readLangfuseEnv({ LANGFUSE_PUBLIC_KEY: "pk-lf-12345678" });
    const resolution = await resolveLangfuse(env, async () => recordingClient().client);
    expect(resolution).toMatchObject({ mode: "noop", reason: "missing-keys" });
  });

  it("resolves to noop when the loader fails (module absent or SDK shape changed)", async () => {
    const env = readLangfuseEnv({
      LANGFUSE_PUBLIC_KEY: "pk-lf-12345678",
      LANGFUSE_SECRET_KEY: "sk-lf-12345678",
    });
    const resolution = await resolveLangfuse(env, async () => {
      throw new Error("Cannot find package 'langfuse'");
    });
    expect(resolution).toMatchObject({ mode: "noop", reason: "module-unavailable" });
  });

  it("resolves live with the loaded client and the host — keys never surfaced", async () => {
    const fake = recordingClient().client;
    const env = readLangfuseEnv({
      LANGFUSE_PUBLIC_KEY: "pk-lf-12345678",
      LANGFUSE_SECRET_KEY: "sk-lf-12345678",
      LANGFUSE_HOST: "https://langfuse.internal.example",
    });
    const resolution = await resolveLangfuse(env, async () => fake);
    expect(resolution.mode).toBe("live");
    if (resolution.mode === "live") {
      expect(resolution.client).toBe(fake);
      expect(resolution.host).toBe("https://langfuse.internal.example");
    }
    expect(JSON.stringify(resolution)).not.toContain("pk-lf-12345678");
    expect(JSON.stringify(resolution)).not.toContain("sk-lf-12345678");
  });

  it("default loader: null while 'langfuse' is not installed (absence gate)", async () => {
    // 'langfuse' is deliberately NOT a package.json dependency (ADR-0005 #3;
    // obs/integration.md): the worker installs it when observability is
    // enabled. Until then the env-gated dynamic import must resolve to null,
    // never throw. If the worker later installs it, replace this row with a
    // fixture-loader row.
    const loaded = await defaultLangfuseClientLoader({
      publicKey: "pk-lf-12345678",
      secretKey: "sk-lf-12345678",
      host: "https://cloud.langfuse.com",
    });
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sink never breaks a run
// ---------------------------------------------------------------------------

describe("sink failure policy (tracing must never break a run)", () => {
  it("swallows client failures, counts them, and skips dependents of a dead trace", () => {
    const boom: LangfuseLike = {
      trace: () => {
        throw new Error("langfuse down");
      },
      span: () => {
        throw new Error("langfuse down");
      },
      generation: () => {
        throw new Error("langfuse down");
      },
    };
    const sink = new LangfuseTraceSink(boom, { now: stepClock() });
    const trace = sink.startRun({
      runId: "run_boom",
      workspaceId: "ws_1",
      tier: "quick",
      prompt: "brief",
      promptOptIn: false,
    });
    expect(() => {
      trace.startStep({ stepSeq: 1, tool: "t" }).end({ ok: true });
      trace.recordGeneration({ model: "m", usage: USAGE, costMicroUsd: 1 });
      trace.endRun({ status: "failed" });
    }).not.toThrow();
    expect(sink.dropped).toBe(1); // the failed trace; dependents were skipped
  });
});

// ---------------------------------------------------------------------------
// §22 sampling tie-in — 100% errors, 10% successes, deterministic
// ---------------------------------------------------------------------------

describe("isRunSampled (§22 sampling tie-in, W9-D policy + FNV determinism)", () => {
  it("traces 100% of error runs by default, regardless of the success rate", () => {
    expect(isRunSampled("run-1", { isError: true, successRate: 0 })).toBe(true);
    expect(DEFAULT_TRACE_SUCCESS_SAMPLE_RATE).toBe(0.1); // §22: 10% of successes
  });

  it("lets an explicit errorRate dial errors down (W9-D firehose-incident var)", () => {
    expect(isRunSampled("run-1", { isError: true, errorRate: 0 })).toBe(false);
  });

  it("never samples successes at rate 0 and always at rate 1", () => {
    expect(isRunSampled("run-x", { isError: false, successRate: 0 })).toBe(false);
    expect(isRunSampled("run-x", { isError: false, successRate: 1 })).toBe(true);
  });

  it("samples successes deterministically at the §22 default", () => {
    // FNV-1a on runId → stable across workers/retries; the fixed hash over
    // run-0..run-999 lands ~10% (bounds assert both distribution and
    // determinism without pinning a magic count).
    let sampled = 0;
    for (let i = 0; i < 1000; i += 1) {
      const id = `run-${i}`;
      const first = isRunSampled(id, { isError: false });
      expect(first).toBe(isRunSampled(id, { isError: false })); // stable
      if (first) sampled += 1;
    }
    expect(sampled).toBeGreaterThan(50);
    expect(sampled).toBeLessThan(150);
  });
});
