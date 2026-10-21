// packages/agent/src/obs/tracer.ts — W9-D observability kit: span helpers (§22).
//
// §22 trace chain: HTTP → queue → worker → tool → engine. This module defines
// a TINY internal tracer interface plus adapters, so the agent runtime and
// the apps never import an SDK type directly:
//   - NoopTracer — for tests and for "no @opentelemetry/api installed";
//   - OTelTracer — thin adapter over @opentelemetry/api (dynamic-optional:
//     a non-literal specifier, so tsc/bundlers leave resolution to the
//     runtime; absent → createTracer() resolves to the NoopTracer).
//
// Sampling (§22 / ADR-0005 #2): 100% of errors, 10% of successes,
// env-tunable. The policy is a PURE decision function (`decide({error})`)
// consulted at span end; kept spans get full §22 correlation + error status.
// With only the API package wired there is no exporter, so the keep/drop
// outcome is recorded in `stats` for the app-wiring wave; the SDK/collector
// side consumes `samplingRatesFromEnv()` (rates live in .env.example —
// OTEL_TRACES_SAMPLING_RATE, errors always kept unless overridden).
//
// W3C traceparent propagation (inject/extract) is pure string work and fully
// unit-tested here — the queue payload carries the traceparent so the worker
// continues the SAME chain (ADR-0005 #1 correlation posture for traces).

/** Span attribute primitive values (OTel-compatible). */
export type SpanAttrValue = string | number | boolean;

/** Span attributes; undefined entries are skipped (no attribute set). */
export type SpanAttrs = Readonly<Record<string, SpanAttrValue | undefined>>;

/** §22 correlation chain for spans (camelCase API / snake_case attrs). */
export interface SpanCorrelation {
  readonly requestId?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly stepSeq?: number;
}

export type SpanStatus = "ok" | "error";

export interface SpanEndOptions {
  /** `true` or an Error marks the span errored (→ sampled at 100%). */
  readonly error?: boolean | Error;
  /** Explicit terminal status; omitted → left to the adapter. */
  readonly status?: SpanStatus;
}

/** Mutable live counters (diagnostics + deterministic tests). */
export interface TracerStats {
  started: number;
  ended: number;
  kept: number;
  dropped: number;
}

/** A span in flight. All methods are chainable; `end` is idempotent. */
export interface Span {
  withAttrs(attrs: SpanAttrs): Span;
  setCorrelation(correlation: SpanCorrelation): Span;
  /** Mark the span errored (kept regardless of the success sampling rate). */
  recordError(error: unknown): Span;
  end(options?: SpanEndOptions): void;
}

export interface Tracer {
  startSpan(name: string, attrs?: SpanAttrs): Span;
  /** Current W3C context for outgoing header injection; Noop → undefined. */
  currentContext(): TraceContext | undefined;
  readonly stats: TracerStats;
}

// ---------------------------------------------------------------------------
// Sampling policy (§22: errors 100%, successes 10%, env-tunable)
// ---------------------------------------------------------------------------

export interface SamplingRates {
  readonly errorRate: number;
  readonly successRate: number;
}

/** Pure decision surface: `decide({error})` — keep or drop this trace. */
export interface SamplingPolicy extends SamplingRates {
  decide(outcome: { readonly error: boolean }): boolean;
}

export interface SamplingPolicyOptions extends Partial<SamplingRates> {
  /** Deterministic RNG for tests; default Math.random. */
  readonly rng?: () => number;
}

function clampRate(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, raw));
}

function rateFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, parsed));
}

/**
 * §22 sampling rates from env, clamped to [0, 1]:
 *  - success: OTEL_TRACES_SAMPLING_RATE (default 0.1 — .env.example §22);
 *  - error:   OTEL_TRACES_ERROR_SAMPLING_RATE (default 1 — errors always
 *    kept; the var exists so a firehose incident can dial it down).
 */
export function samplingRatesFromEnv(
  env: Record<string, string | undefined> = process.env,
): SamplingRates {
  return {
    errorRate: rateFromEnv(env.OTEL_TRACES_ERROR_SAMPLING_RATE, 1),
    successRate: rateFromEnv(env.OTEL_TRACES_SAMPLING_RATE, 0.1),
  };
}

/** Build a pure sampling policy (§22). Non-finite rates fall back. */
export function createSamplingPolicy(options: SamplingPolicyOptions = {}): SamplingPolicy {
  const errorRate = clampRate(options.errorRate, 1);
  const successRate = clampRate(options.successRate, 0.1);
  const rng = options.rng ?? Math.random;
  return {
    errorRate,
    successRate,
    decide: (outcome) => rng() < (outcome.error ? errorRate : successRate),
  };
}

// ---------------------------------------------------------------------------
// W3C traceparent (pure — format/parse/inject/extract over string headers)
// ---------------------------------------------------------------------------

/** W3C trace context: ids are 32/16 lowercase hex; flags is one byte. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly flags: number;
}

export const TRACEPARENT_HEADER = "traceparent";

/** Trace-flags bit: the downstream may sample (W3C Trace Context §3.2.2). */
export const SAMPLED_FLAG = 0x01;

const HEX_RE = /^[0-9a-f]+$/;

function isHex(value: string, length: number): boolean {
  return (
    value.length === length &&
    HEX_RE.test(
      // Accept uppercase on input (HEXDIG per the W3C ABNF); output is lowercase.
      value.toLowerCase(),
    )
  );
}

function allZero(value: string): boolean {
  return /^[0]+$/.test(value);
}

export function isValidTraceId(traceId: string): boolean {
  return isHex(traceId, 32) && !allZero(traceId.toLowerCase());
}

export function isValidSpanId(spanId: string): boolean {
  return isHex(spanId, 16) && !allZero(spanId.toLowerCase());
}

/**
 * Format a W3C traceparent: `00-<traceId 32>-<spanId 16>-<flags 2>`.
 * Returns undefined for invalid ids (callers skip the header rather than
 * crash a request over tracing); flags are masked to one byte.
 */
export function formatTraceparent(context: TraceContext): string | undefined {
  if (!isValidTraceId(context.traceId) || !isValidSpanId(context.spanId)) {
    return undefined;
  }
  const flags = context.flags & 0xff;
  return `00-${context.traceId.toLowerCase()}-${context.spanId.toLowerCase()}-${flags
    .toString(16)
    .padStart(2, "0")}`;
}

/**
 * Parse a W3C traceparent header (strict per the spec): 4 dash-separated
 * lowercase-hex-accepting parts, version != "ff", non-zero ids. Future
 * versions with the same 00-format lengths parse forward-compatibly.
 */
export function parseTraceparent(header: string | undefined | null): TraceContext | undefined {
  if (typeof header !== "string") {
    return undefined;
  }
  const parts = header.trim().split("-");
  if (parts.length !== 4) {
    return undefined;
  }
  const version = parts[0];
  const traceId = parts[1] ?? "";
  const spanId = parts[2] ?? "";
  const flags = parts[3] ?? "";
  if (!isHex(version, 2) || version.toLowerCase() === "ff") {
    return undefined;
  }
  if (!isHex(traceId, 32) || !isHex(spanId, 16) || !isHex(flags, 2)) {
    return undefined;
  }
  if (allZero(traceId.toLowerCase()) || allZero(spanId.toLowerCase())) {
    return undefined;
  }
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    flags: Number.parseInt(flags, 16),
  };
}

/** Set the traceparent header for outgoing HTTP/queue payloads (§22 chain). */
export function injectTraceparent(
  headers: Record<string, string>,
  context: TraceContext,
): void {
  const value = formatTraceparent(context);
  if (value !== undefined) {
    headers[TRACEPARENT_HEADER] = value;
  }
}

/** Extract the trace context from received headers (case-insensitive). */
export function extractTraceparent(
  headers: Record<string, string | undefined>,
): TraceContext | undefined {
  const value = headers[TRACEPARENT_HEADER] ?? findByCaseInsensitiveKey(headers);
  return parseTraceparent(value);
}

function findByCaseInsensitiveKey(
  headers: Record<string, string | undefined>,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === TRACEPARENT_HEADER) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// @opentelemetry/api structural seam (NO hard import — optional dep)
// ---------------------------------------------------------------------------

/** The slice of an OTel span the adapter uses (structural, no `any`). */
export interface OtelSpanLike {
  setAttribute(key: string, value: SpanAttrValue): unknown;
  setStatus(status: { code: number; description?: string }): unknown;
  recordException?(exception: unknown): void;
  end(): unknown;
}

export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: { readonly attributes?: Readonly<Record<string, SpanAttrValue>> },
  ): OtelSpanLike;
}

export interface OtelSpanContextLike {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/** The slice of @opentelemetry/api the adapter uses (injectable in tests). */
export interface OtelApiLike {
  readonly trace: {
    getTracer(name: string, version?: string): OtelTracerLike;
    getSpanContext?(context: unknown): OtelSpanContextLike | undefined;
  };
  readonly context?: { active(): unknown };
  /** Numeric SpanStatusCode members (real api: ERROR = 2, OK = 1). */
  readonly SpanStatusCode?: { readonly ERROR?: number; readonly OK?: number };
}

const OTEL_API_MODULE_ID: string = "@opentelemetry/api";
const DEFAULT_TRACER_NAME = "@studio/obs";
const OTel_STATUS_ERROR = 2;
const OTel_STATUS_OK = 1;

/** Explicitly-requested backend could not be resolved — refuse to guess. */
export class TracerSetupError extends Error {
  constructor(
    readonly code: "otel_unavailable",
    message: string,
  ) {
    super(`[obs/tracer] ${message}`);
    this.name = "TracerSetupError";
  }
}

async function loadOtelApi(explicit?: OtelApiLike): Promise<OtelApiLike | undefined> {
  if (explicit !== undefined) {
    return explicit;
  }
  try {
    const loaded = (await import(OTEL_API_MODULE_ID)) as unknown as OtelApiLike | undefined;
    return loaded !== undefined && typeof loaded.trace?.getTracer === "function"
      ? loaded
      : undefined;
  } catch {
    return undefined;
  }
}

/** Correlation → snake_case span attributes (§22, OTel naming). */
function correlationAttrs(correlation: SpanCorrelation): SpanAttrs {
  const attrs: Record<string, SpanAttrValue> = {};
  if (correlation.requestId !== undefined) attrs.request_id = correlation.requestId;
  if (correlation.workspaceId !== undefined) attrs.workspace_id = correlation.workspaceId;
  if (correlation.runId !== undefined) attrs.run_id = correlation.runId;
  if (correlation.stepSeq !== undefined) attrs.step_seq = correlation.stepSeq;
  return attrs;
}

/** Tracing must never take the caller down (§22): every SDK call is guarded. */
function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // A misconfigured/absent SDK never propagates into product code paths.
  }
}

export interface TracerOptions {
  /** Force a backend. "auto" (default): OTel when resolvable, else Noop. */
  readonly backend?: "auto" | "otel" | "noop";
  /** The app's @opentelemetry/api namespace (skips the dynamic import). */
  readonly otelApi?: OtelApiLike;
  /** Default: from `samplingRatesFromEnv(options.env)`. */
  readonly policy?: SamplingPolicy;
  readonly env?: Record<string, string | undefined>;
  /** OTel tracer name; default "@studio/obs". */
  readonly serviceName?: string;
  readonly serviceVersion?: string;
}

/**
 * Create the §22 tracer. Async: the OTel probe is a dynamic-optional import.
 * Resolves to the NoopTracer (never throws) unless backend "otel" is forced
 * and the API is unavailable — then TracerSetupError (fail fast, no guess).
 */
export async function createTracer(options: TracerOptions = {}): Promise<Tracer> {
  const backend = options.backend ?? "auto";
  if (backend === "noop") {
    return createNoopTracer(options.policy);
  }
  const api =
    options.otelApi !== undefined ? options.otelApi : await loadOtelApi();
  if (api === undefined) {
    if (backend === "otel") {
      throw new TracerSetupError(
        "otel_unavailable",
        'backend "otel" requested but @opentelemetry/api is not installed — pass otelApi or use backend "auto"/"noop"',
      );
    }
    return createNoopTracer(options.policy);
  }
  const policy = options.policy ?? createSamplingPolicy(samplingRatesFromEnv(options.env));
  return createOtelTracer(api, policy, options.serviceName, options.serviceVersion);
}

/** No-op tracer for tests and dependency-absent deployments. */
export function createNoopTracer(policy: SamplingPolicy = createSamplingPolicy()): Tracer {
  const stats: TracerStats = { started: 0, ended: 0, kept: 0, dropped: 0 };
  return {
    stats,
    currentContext: () => undefined,
    startSpan: (_name) => {
      stats.started += 1;
      return createNoopSpan(policy, stats);
    },
  };
}

function createNoopSpan(policy: SamplingPolicy, stats: TracerStats): Span {
  let errored = false;
  let ended = false;
  const span: Span = {
    withAttrs: () => span,
    setCorrelation: () => span,
    recordError: () => {
      errored = true;
      return span;
    },
    end: (options) => {
      if (ended) {
        return;
      }
      ended = true;
      stats.ended += 1;
      const error = errored || options?.error === true || options?.error instanceof Error;
      if (policy.decide({ error })) {
        stats.kept += 1;
      } else {
        stats.dropped += 1;
      }
    },
  };
  return span;
}

function createOtelTracer(
  api: OtelApiLike,
  policy: SamplingPolicy,
  serviceName?: string,
  serviceVersion?: string,
): Tracer {
  const stats: TracerStats = { started: 0, ended: 0, kept: 0, dropped: 0 };
  const tracerName = serviceName ?? DEFAULT_TRACER_NAME;
  let cachedTracer: OtelTracerLike | undefined;
  const getTracer = (): OtelTracerLike => {
    if (cachedTracer === undefined) {
      cachedTracer = safeResult(() => api.trace.getTracer(tracerName, serviceVersion));
    }
    return cachedTracer ?? createNoopOtelSpanFactory();
  };
  return {
    stats,
    startSpan: (name, attrs) => {
      stats.started += 1;
      const attributes: Record<string, SpanAttrValue> = {};
      for (const [key, value] of Object.entries(attrs ?? {})) {
        if (value !== undefined) {
          attributes[key] = value;
        }
      }
      const otelSpan = safeResult(
        () => getTracer().startSpan(name, { attributes }),
      ) ?? createNoopOtelSpanFactory();
      return createOtelSpan(api, otelSpan, policy, stats);
    },
    currentContext: () => {
      const active = safeResult(() => api.context?.active());
      if (active === undefined) {
        return undefined;
      }
      const spanContext = safeResult(() => api.trace.getSpanContext?.(active));
      if (
        spanContext === undefined ||
        !isValidTraceId(spanContext.traceId) ||
        !isValidSpanId(spanContext.spanId)
      ) {
        return undefined;
      }
      return {
        traceId: spanContext.traceId.toLowerCase(),
        spanId: spanContext.spanId.toLowerCase(),
        flags: spanContext.traceFlags & 0xff,
      };
    },
  };
}

/** A span-shaped stub for when the SDK exists in type but fails at runtime. */
function createNoopOtelSpanFactory(): OtelTracerLike {
  return {
    startSpan: () => ({
      setAttribute: () => undefined,
      setStatus: () => undefined,
      end: () => undefined,
    }),
  };
}

function safeResult<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}

function createOtelSpan(
  api: OtelApiLike,
  otelSpan: OtelSpanLike,
  policy: SamplingPolicy,
  stats: TracerStats,
): Span {
  let errored = false;
  let recordedError: unknown;
  let ended = false;
  const span: Span = {
    withAttrs: (attrs) => {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined) {
          safeCall(() => otelSpan.setAttribute(key, value));
        }
      }
      return span;
    },
    setCorrelation: (correlation) =>
      span.withAttrs(correlationAttrs(correlation)),
    recordError: (error) => {
      errored = true;
      recordedError = error;
      safeCall(() => otelSpan.setAttribute("error", true));
      return span;
    },
    end: (options) => {
      if (ended) {
        return;
      }
      ended = true;
      stats.ended += 1;
      const endError = options?.error;
      const error =
        errored || endError === true || endError instanceof Error;
      // §22 sampling: tail decision — errors at 100%, successes at 10%.
      if (policy.decide({ error })) {
        stats.kept += 1;
        if (error) {
          const errorCode = numericStatusCode(api, "ERROR", OTel_STATUS_ERROR);
          safeCall(() => otelSpan.setStatus({ code: errorCode }));
          const exception = endError instanceof Error ? endError : recordedError;
          if (exception !== undefined) {
            safeCall(() => otelSpan.recordException?.(exception));
          }
        } else if (options?.status === "ok") {
          safeCall(() =>
            otelSpan.setStatus({ code: numericStatusCode(api, "OK", OTel_STATUS_OK) }),
          );
        }
      } else {
        stats.dropped += 1;
      }
      safeCall(() => otelSpan.end());
    },
  };
  return span;
}

function numericStatusCode(
  api: OtelApiLike,
  key: "ERROR" | "OK",
  fallback: number,
): number {
  const value = api.SpanStatusCode?.[key];
  return typeof value === "number" ? value : fallback;
}
