// packages/agent/src/obs/index.ts — W9-D barrel: the zero-dep observability kit (§22).
//
// Reusable by apps (gateway /v1/metrics, worker run spans) WITHOUT touching
// their dependency trees: every SDK (pino, @opentelemetry/api) is loaded via
// dynamic-optional imports with pure-TS fallbacks (see module headers).
//
// NOT yet re-exported from src/index.ts (the main barrel is owned by the
// wiring wave): apps import "@studio/agent/src/obs/index.js" directly for
// now. When the wiring owner star-exports this module, the collision audit
// stands ready — none of these names collide with the current public
// surface (verified by grepping `export … (Tracer|Span|Counter|Gauge|
// Histogram|ObsLogger|SamplingPolicy|TraceContext|CorrelationBindings|`
// REDACTED_MARKER|MetricKind|Registry)` over src/** at assembly time), and
// tests/barrel.test.ts gains one row per curated symbol (W6-P convention).

export * from "./logger.js";
export * from "./tracer.js";
export * from "./metrics.js";
