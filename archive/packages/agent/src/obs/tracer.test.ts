// packages/agent/src/obs/tracer.test.ts — W9-D: W3C traceparent round-trips,
// §22 sampling policy (errors 100% / successes 10%), adapters.

import { describe, expect, it } from "vitest";
import {
  SAMPLED_FLAG,
  TRACEPARENT_HEADER,
  createNoopTracer,
  createSamplingPolicy,
  createTracer,
  extractTraceparent,
  formatTraceparent,
  injectTraceparent,
  isValidSpanId,
  isValidTraceId,
  parseTraceparent,
  samplingRatesFromEnv,
  type OtelApiLike,
  type OtelSpanContextLike,
  type OtelSpanLike,
  type SpanAttrValue,
  type TraceContext,
} from "./tracer.js";

// The W3C Trace Context spec's own example values — a known-output anchor.
const SPEC_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPEC_SPAN_ID = "00f067aa0ba902b7";
const SPEC_HEADER = `00-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01`;

describe("traceparent format/parse (W3C, pure)", () => {
  it("formats the spec example exactly", () => {
    expect(formatTraceparent({ traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 0x01 })).toBe(
      SPEC_HEADER,
    );
  });

  it.each([
    ["masks flags to one byte", { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 0x1ab }, "ab"],
    ["zero flags render 00", { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 0 }, "00"],
    ["lowercases uppercase ids", { traceId: SPEC_TRACE_ID.toUpperCase(), spanId: SPEC_SPAN_ID.toUpperCase(), flags: 1 }, "01"],
  ] as ReadonlyArray<[string, TraceContext, string]>)(
    "%s",
    (_name, context, expectedFlags) => {
      const header = formatTraceparent(context);
      expect(header).toBeDefined();
      expect(header?.split("-")[3]).toBe(expectedFlags);
    },
  );

  it("returns undefined for invalid ids (never propagates garbage)", () => {
    expect(formatTraceparent({ traceId: "0".repeat(32), spanId: SPEC_SPAN_ID, flags: 1 })).toBeUndefined();
    expect(formatTraceparent({ traceId: SPEC_TRACE_ID, spanId: "0".repeat(16), flags: 1 })).toBeUndefined();
    expect(formatTraceparent({ traceId: "xyz", spanId: SPEC_SPAN_ID, flags: 1 })).toBeUndefined();
    expect(formatTraceparent({ traceId: `${SPEC_TRACE_ID}0`, spanId: SPEC_SPAN_ID, flags: 1 })).toBeUndefined();
  });

  it("isValidTraceId / isValidSpanId agree with the formatter", () => {
    expect(isValidTraceId(SPEC_TRACE_ID)).toBe(true);
    expect(isValidTraceId("0".repeat(32))).toBe(false);
    expect(isValidTraceId(SPEC_SPAN_ID)).toBe(false);
    expect(isValidSpanId(SPEC_SPAN_ID)).toBe(true);
    expect(isValidSpanId("0".repeat(16))).toBe(false);
  });

  it.each([
    ["spec example", SPEC_HEADER, { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 1 }],
    ["uppercase hex accepted + normalized", `00-${SPEC_TRACE_ID.toUpperCase()}-${SPEC_SPAN_ID.toUpperCase()}-0A`, { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 10 }],
    ["future version same shape parses", `01-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01`, { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 1 }],
    ["surrounding whitespace trimmed", `  ${SPEC_HEADER}  `, { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 1 }],
  ] as ReadonlyArray<[string, string, TraceContext]>)(
    "parse: %s",
    (_name, header, expected) => {
      expect(parseTraceparent(header)).toEqual(expected);
    },
  );

  it.each([
    ["version ff is reserved", `ff-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01`],
    ["three parts", `00-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}`],
    ["five parts", `00-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-01-02`],
    ["all-zero trace id", `00-${"0".repeat(32)}-${SPEC_SPAN_ID}-01`],
    ["all-zero span id", `00-${SPEC_TRACE_ID}-${"0".repeat(16)}-01`],
    ["short flags", `00-${SPEC_TRACE_ID}-${SPEC_SPAN_ID}-1`],
    ["non-hex ids", `00-${"g".repeat(32)}-${SPEC_SPAN_ID}-01`],
    ["empty string", ""],
  ])("parse rejects: %s", (_name, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it("parse returns undefined for absent headers", () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
  });

  it.each([
    { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 0x01 },
    { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", flags: 0 },
    { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: 0xff },
  ] as ReadonlyArray<TraceContext>)("round-trips format → parse (%j)", (context) => {
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });
});

describe("traceparent inject/extract (string headers, §22 chain)", () => {
  it("inject → extract round-trips through a plain header record", () => {
    const headers: Record<string, string> = {};
    injectTraceparent(headers, { traceId: SPEC_TRACE_ID, spanId: SPEC_SPAN_ID, flags: SAMPLED_FLAG });
    expect(headers[TRACEPARENT_HEADER]).toBe(SPEC_HEADER);
    expect(extractTraceparent(headers)).toEqual({
      traceId: SPEC_TRACE_ID,
      spanId: SPEC_SPAN_ID,
      flags: 1,
    });
  });

  it("extract is case-insensitive over header names (HTTP proxies)", () => {
    const headers: Record<string, string | undefined> = { "TraceParent": SPEC_HEADER };
    expect(extractTraceparent(headers)).toEqual({
      traceId: SPEC_TRACE_ID,
      spanId: SPEC_SPAN_ID,
      flags: 1,
    });
  });

  it("missing header → undefined; invalid context → no header, no throw", () => {
    expect(extractTraceparent({})).toBeUndefined();
    const headers: Record<string, string> = {};
    injectTraceparent(headers, { traceId: "bad", spanId: "bad", flags: 1 });
    expect(TRACEPARENT_HEADER in headers).toBe(false);
  });
});

describe("sampling policy (§22: errors 100%, successes 10%, env-tunable)", () => {
  it("errors are always kept at the default error rate", () => {
    const policy = createSamplingPolicy({ rng: () => 0.999 });
    expect(policy.errorRate).toBe(1);
    expect(policy.decide({ error: true })).toBe(true);
  });

  it("successes sample at 10% by default with the injected rng", () => {
    const policy = createSamplingPolicy({ rng: () => 0.05 });
    expect(policy.successRate).toBe(0.1);
    expect(policy.decide({ error: false })).toBe(true);
    const dropping = createSamplingPolicy({ rng: () => 0.15 });
    expect(dropping.decide({ error: false })).toBe(false);
  });

  it.each([
    ["negative rates clamp to 0 (never keep)", { errorRate: -1, successRate: -5, rng: () => 0.001 }, { error: false, kept: false }],
    ["rates above 1 clamp to 1 (always keep)", { errorRate: 2, successRate: 1.5, rng: () => 0.999 }, { error: false, kept: true }],
    ["non-finite falls back to §22 defaults", { errorRate: Number.NaN, successRate: Number.NaN, rng: () => 0.05 }, { error: false, kept: true }],
  ] as const)("clamp/fallback: %s", (_name, options, outcome) => {
    const policy = createSamplingPolicy(options);
    expect(policy.successRate).toBeLessThanOrEqual(1);
    expect(policy.successRate).toBeGreaterThanOrEqual(0);
    expect(policy.decide({ error: outcome.error })).toBe(outcome.kept);
  });

  it("errors stay keepable even when the rng lands above the success rate", () => {
    const policy = createSamplingPolicy({ successRate: 0, rng: () => 0.5 });
    expect(policy.decide({ error: false })).toBe(false);
    expect(policy.decide({ error: true })).toBe(true);
  });

  it.each([
    ["defaults", {}, { errorRate: 1, successRate: 0.1 }],
    ["success rate from env", { OTEL_TRACES_SAMPLING_RATE: "0.5" }, { errorRate: 1, successRate: 0.5 }],
    ["success clamps high", { OTEL_TRACES_SAMPLING_RATE: "2" }, { errorRate: 1, successRate: 1 }],
    ["success clamps low", { OTEL_TRACES_SAMPLING_RATE: "-1" }, { errorRate: 1, successRate: 0 }],
    ["garbage env falls back", { OTEL_TRACES_SAMPLING_RATE: "garbage" }, { errorRate: 1, successRate: 0.1 }],
    ["empty env falls back", { OTEL_TRACES_SAMPLING_RATE: "" }, { errorRate: 1, successRate: 0.1 }],
    ["error rate from env", { OTEL_TRACES_ERROR_SAMPLING_RATE: "0.25" }, { errorRate: 0.25, successRate: 0.1 }],
  ] as ReadonlyArray<[string, Record<string, string | undefined>, Record<string, number>]>)(
    "samplingRatesFromEnv: %s",
    (_name, env, expected) => {
      expect(samplingRatesFromEnv(env)).toEqual(expected);
    },
  );
});

describe("createNoopTracer (tests + dependency-absent deployments)", () => {
  it("spans are chainable no-ops and stats stay honest", () => {
    const tracer = createNoopTracer(createSamplingPolicy({ rng: () => 0.01 }));
    expect(tracer.currentContext()).toBeUndefined();
    const span = tracer.startSpan("worker.run");
    expect(span.withAttrs({ "queue.name": "runs" })).toBe(span);
    expect(span.setCorrelation({ requestId: "r" })).toBe(span);
    span.end();
    span.end(); // idempotent
    expect(tracer.stats).toEqual({ started: 1, ended: 1, kept: 1, dropped: 0 });
  });

  it("recordError routes the end decision through the §22 error branch", () => {
    const tracer = createNoopTracer(createSamplingPolicy({ successRate: 0, rng: () => 0.5 }));
    const span = tracer.startSpan("tool.call");
    span.recordError(new Error("boom"));
    span.end();
    const success = tracer.startSpan("tool.call");
    success.end();
    expect(tracer.stats.kept).toBe(1);
    expect(tracer.stats.dropped).toBe(1);
  });
});

interface FakeSpanState {
  readonly name: string;
  readonly attributes: Record<string, SpanAttrValue>;
  status: { code: number; description?: string } | undefined;
  exception: unknown;
  ended: boolean;
}

function fakeOtelApi(
  spanContext?: OtelSpanContextLike,
): { readonly api: OtelApiLike; readonly spans: FakeSpanState[] } {
  const spans: FakeSpanState[] = [];
  const makeSpan = (
    name: string,
    attrs?: Readonly<Record<string, SpanAttrValue>>,
  ): OtelSpanLike => {
    const state: FakeSpanState = {
      name,
      attributes: { ...(attrs ?? {}) },
      status: undefined,
      exception: undefined,
      ended: false,
    };
    spans.push(state);
    return {
      setAttribute: (key, value) => {
        state.attributes[key] = value;
      },
      setStatus: (status) => {
        state.status = status;
      },
      recordException: (exception) => {
        state.exception = exception;
      },
      end: () => {
        state.ended = true;
      },
    };
  };
  const api: OtelApiLike = {
    trace: {
      getTracer: () => ({
        startSpan: (name, options) => makeSpan(name, options?.attributes),
      }),
      ...(spanContext !== undefined ? { getSpanContext: () => spanContext } : {}),
    },
    context: { active: () => "active-context" },
    SpanStatusCode: { ERROR: 2, OK: 1 },
  };
  return { api, spans };
}

function keepAll(): ReturnType<typeof createSamplingPolicy> {
  return createSamplingPolicy({ errorRate: 1, successRate: 1, rng: () => 0 });
}

describe("createTracer — OTel adapter (injected api)", () => {
  it("starts spans with attrs and §22 snake_case correlation", async () => {
    const { api, spans } = fakeOtelApi();
    const tracer = await createTracer({
      backend: "otel",
      otelApi: api,
      policy: keepAll(),
    });
    const span = tracer.startSpan("http.request", { "http.method": "GET" });
    span.setCorrelation({ requestId: "r1", workspaceId: "ws1", runId: "run1", stepSeq: 4 });
    span.end();
    const [state] = spans;
    expect(state?.name).toBe("http.request");
    expect(state?.attributes["http.method"]).toBe("GET");
    expect(state?.attributes.request_id).toBe("r1");
    expect(state?.attributes.workspace_id).toBe("ws1");
    expect(state?.attributes.run_id).toBe("run1");
    expect(state?.attributes.step_seq).toBe(4);
    expect(state?.ended).toBe(true);
    expect(tracer.stats).toEqual({ started: 1, ended: 1, kept: 1, dropped: 0 });
  });

  it("end({error}) keeps §22 sample and sets the OTel error status", async () => {
    const { api, spans } = fakeOtelApi();
    const tracer = await createTracer({ backend: "auto", otelApi: api, policy: keepAll() });
    tracer.startSpan("worker.run").end({ error: true });
    expect(spans[0]?.status?.code).toBe(2);
    expect(spans[0]?.exception).toBeUndefined();
    expect(tracer.stats.kept).toBe(1);
  });

  it("recordError + end records the exception via the SDK seam", async () => {
    const { api, spans } = fakeOtelApi();
    const tracer = await createTracer({ backend: "otel", otelApi: api, policy: keepAll() });
    const boom = new Error("tool failed");
    const span = tracer.startSpan("tool.call");
    span.recordError(boom);
    span.end();
    expect(spans[0]?.attributes.error).toBe(true);
    expect(spans[0]?.exception).toBe(boom);
    expect(spans[0]?.status?.code).toBe(2);
  });

  it("end({error: Error}) records that error object too", async () => {
    const { api, spans } = fakeOtelApi();
    const tracer = await createTracer({ backend: "otel", otelApi: api, policy: keepAll() });
    const boom = new Error("late failure");
    tracer.startSpan("engine.command").end({ error: boom });
    expect(spans[0]?.exception).toBe(boom);
    expect(spans[0]?.status?.code).toBe(2);
  });

  it("end({status: \"ok\"}) on a kept success sets the OK status", async () => {
    const { api, spans } = fakeOtelApi();
    const tracer = await createTracer({ backend: "otel", otelApi: api, policy: keepAll() });
    tracer.startSpan("queue.enqueue").end({ status: "ok" });
    expect(spans[0]?.status?.code).toBe(1);
  });

  it("dropped successes end without a status (§22 tail-sampling decision)", async () => {
    const { api, spans } = fakeOtelApi();
    const tracer = await createTracer({
      backend: "otel",
      otelApi: api,
      policy: createSamplingPolicy({ successRate: 0, rng: () => 0.5 }),
    });
    tracer.startSpan("tool.call").end();
    expect(spans[0]?.status).toBeUndefined();
    expect(spans[0]?.ended).toBe(true);
    expect(tracer.stats.dropped).toBe(1);
    expect(tracer.stats.kept).toBe(0);
  });

  it("end() is idempotent (single stats bump)", async () => {
    const { api } = fakeOtelApi();
    const tracer = await createTracer({ backend: "otel", otelApi: api, policy: keepAll() });
    const span = tracer.startSpan("x");
    span.end();
    span.end();
    expect(tracer.stats).toEqual({ started: 1, ended: 1, kept: 1, dropped: 0 });
  });

  it("currentContext maps the active OTel span context to a TraceContext", async () => {
    const withContext = fakeOtelApi({
      traceId: SPEC_TRACE_ID,
      spanId: SPEC_SPAN_ID,
      traceFlags: 1,
    });
    const tracer = await createTracer({
      backend: "otel",
      otelApi: withContext.api,
      policy: keepAll(),
    });
    expect(tracer.currentContext()).toEqual({
      traceId: SPEC_TRACE_ID,
      spanId: SPEC_SPAN_ID,
      flags: 1,
    });
    const ctx = tracer.currentContext();
    if (ctx === undefined) {
      throw new Error("expected currentContext to be defined");
    }
    expect(formatTraceparent(ctx)).toBe(SPEC_HEADER);

    const invalid = fakeOtelApi({ traceId: SPEC_TRACE_ID, spanId: "0".repeat(16), traceFlags: 1 });
    const invalidTracer = await createTracer({
      backend: "otel",
      otelApi: invalid.api,
      policy: keepAll(),
    });
    expect(invalidTracer.currentContext()).toBeUndefined();

    const noContext = fakeOtelApi();
    const bareTracer = await createTracer({
      backend: "otel",
      otelApi: noContext.api,
      policy: keepAll(),
    });
    expect(bareTracer.currentContext()).toBeUndefined();
  });

  it("backend \"noop\" resolves to the NoopTracer regardless of the api", async () => {
    const { api } = fakeOtelApi();
    const tracer = await createTracer({ backend: "noop", otelApi: api });
    expect(tracer.currentContext()).toBeUndefined();
    tracer.startSpan("x").end();
    expect(tracer.stats.ended).toBe(1);
  });
});
