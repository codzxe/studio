// @studio/agent/obs/langfuse — LLM trace sink for Langfuse (§22, ADR-0005 #3).
// Owner: W9-E (docs/AGENTS.md). Tests: tests/langfuse.test.ts. Worker wiring
// notes: obs/integration.md.
//
// Spec anchors:
//   §22 "Traces: … Langfuse traces include model, tokens, cost, cache hit and
//        the critic/validator verdicts. Sampling: 100% of errors, 10% of
//        successes (configurable)." — `isRunSampled` is the gate; the worker
//        applies it BEFORE `startRun` so an unsampled run emits nothing.
//   §22 "log redaction for prompts unless the workspace opts in" + §15.3
//        provider posture + ADR-0005 #6 — prompts (and run summaries) are
//        REDACTED by default; the per-workspace opt-in flag is the only
//        passthrough. The masker is injectable so ops can tighten it (e.g.
//        length-preserving masks) without touching call sites.
//   §17.2 + §26 Q12 — Langfuse cloud is used ONLY with masked prompts until
//        self-host on the box (~100 users). ADR-0005 #3: MIT core only; the
//        `ee/` directory is never enabled.
//
// Parallel contracts (both landed mid-task; read per the W9-E brief):
//   - W9-D obs/tracer.ts — owns the §22 sampling-policy math and the OTel
//     span helper. The sampling tie-in below IMPORTS `createSamplingPolicy`
//     so one policy surface drives OTel spans and Langfuse traces; the only
//     addition here is run-keyed determinism (FNV-1a of runId as the policy
//     rng — a run must sample identically on every worker and retry). This
//     module still creates no OTel spans; its step handle is self-contained
//     ({ end(result) }) and structurally compatible with the W9-D `Span`
//     (`end` idempotent, typed error, explicit status) if the worker prefers
//     a single timing source.
//   - W9-C metering/cost-model.ts — its per-call usage row is `CostInput`
//     { model, tokensIn, tokensOut, cacheHits? } with cacheHits ⊆ tokensIn,
//     and cost is bigint micro-USD (`computeCost`), bridged to a number via
//     its exported `microToSafeNumber`. `GenerationUsage` below MIRRORS that
//     row (same field names, cacheHits optional) so the worker passes rows
//     through unmapped; the sink clamps cacheHits defensively but does not
//     import the money path — a trace sink never sits on it.
//
// Seam design: everything here runs against the injected `LangfuseLike`
// interface only (the task-fixed contract). The WORKER wires the real client
// — a dynamic import of 'langfuse', env-gated so absence resolves to
// NOOP_LANGFUSE (`resolveLangfuse`). The import uses a non-literal specifier
// so TS/bundlers/vitest never resolve 'langfuse' statically; it is not a
// package.json dependency. Observability must never break a run: every
// emission is try/caught and counted in `sink.dropped`.

import { createSamplingPolicy } from "./tracer.js";

// ---------------------------------------------------------------------------
// Env seam (§22 optional vars; the worker parses env via @studio/config —
// env/worker.ts already declares the two key rows; LANGFUSE_HOST is flagged
// in obs/integration.md for the config owner)
// ---------------------------------------------------------------------------

/** The §22/§17.2 Langfuse env block, single-sourced. */
export const LANGFUSE_ENV_KEYS = {
  publicKey: "LANGFUSE_PUBLIC_KEY",
  secretKey: "LANGFUSE_SECRET_KEY",
  host: "LANGFUSE_HOST",
} as const;

export interface LangfuseEnv {
  readonly publicKey: string | undefined;
  readonly secretKey: string | undefined;
  readonly host: string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Picks the Langfuse block out of an already-validated env object (the worker
 * passes its @studio/config `WorkerEnv`; raw records work in tests). The keys
 * are never logged, echoed in errors, or written into trace payloads.
 */
export function readLangfuseEnv(env: {
  readonly LANGFUSE_PUBLIC_KEY?: string | undefined;
  readonly LANGFUSE_SECRET_KEY?: string | undefined;
  readonly LANGFUSE_HOST?: string | undefined;
}): LangfuseEnv {
  return {
    publicKey: nonEmpty(env.LANGFUSE_PUBLIC_KEY),
    secretKey: nonEmpty(env.LANGFUSE_SECRET_KEY),
    host: nonEmpty(env.LANGFUSE_HOST),
  };
}

// ---------------------------------------------------------------------------
// Client seam — the task-fixed LangfuseLike interface (worker adapts the SDK)
// ---------------------------------------------------------------------------

export interface LangfuseTraceBody {
  readonly name: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LangfuseSpanBody {
  readonly name: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Canonical Langfuse usage shape (input/output/total) + our cache row. */
export interface LangfuseGenerationUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly total: number;
}

export interface LangfuseGenerationBody {
  readonly name?: string;
  readonly model: string;
  readonly usage: LangfuseGenerationUsage;
  /** LLM cost for the call, micro-USD (W9-C `costMicroUsd`). */
  readonly cost: number;
  /** Versioned prompt ref, e.g. "planner@v1" (packages/agent/prompts frontmatter). */
  readonly prompt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The injected client contract (task-fixed): `trace` returns an opaque ref the
 * other two methods take back as their parent. The worker adapts the real
 * Langfuse SDK (or anything test-shaped) onto this.
 */
export interface LangfuseLike {
  trace(body: LangfuseTraceBody): unknown;
  span(traceRef: unknown, body: LangfuseSpanBody): unknown;
  generation(traceRef: unknown, body: LangfuseGenerationBody): unknown;
}

/** No-op client — the env-gated fallback. Returns null refs; never throws. */
export function noopLangfuse(): LangfuseLike {
  const nothing = (): null => null;
  return Object.freeze({ trace: nothing, span: nothing, generation: nothing });
}

/** Shared frozen instance (immutable; cheap). */
export const NOOP_LANGFUSE: LangfuseLike = noopLangfuse();

// ---------------------------------------------------------------------------
// Masking contract (§22 + §15.3; ADR-0005 #6: "user prompts are redacted from
// logs and Langfuse payloads unless the workspace opts in")
// ---------------------------------------------------------------------------

/** Constant redaction token — no length or content leak. */
export const PROMPT_REDACTED = "[redacted]";

export interface RedactionContext {
  /** What the value is — the masker may care; the policy does not. */
  readonly kind: "prompt" | "summary";
  readonly runId: string;
  /** Per-workspace opt-in flag — the ONLY path to unmasked passthrough. */
  readonly optedIn: boolean;
}

export type PromptMasker = (value: string, context: RedactionContext) => string;

/** §22 default: redact unless the workspace opted in. */
export const defaultPromptMasker: PromptMasker = (value, context) =>
  context.optedIn ? value : PROMPT_REDACTED;

// ---------------------------------------------------------------------------
// W9-C usage-row mirror (metering/cost-model.ts `CostInput`) + prompt
// versioning (§23 frontmatter: id + version)
// ---------------------------------------------------------------------------

/**
 * One model call's token rows — mirrors W9-C cost-model `CostInput` field for
 * field (tokensIn/tokensOut/cacheHits, cacheHits ⊆ tokensIn) so the worker
 * passes metering rows through unmapped. Cost arrives separately as
 * `costMicroUsd` (the worker bridges W9-C's bigint via `microToSafeNumber`).
 */
export interface GenerationUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits?: number;
}

/** `planner@v1`-style ref from the packages/agent/prompts frontmatter pair. */
export function formatPromptVersion(promptId: string, version: number | string): string {
  return `${promptId}@v${version}`;
}

// ---------------------------------------------------------------------------
// §22 sampling — 100% of errors, 10% of successes (configurable)
// Policy math is W9-D's (obs/tracer.ts `createSamplingPolicy`); this adds
// run-keyed determinism so one run traces atomically across retries.
// ---------------------------------------------------------------------------

/** §22 default success-sample rate (mirrors the tracer.ts policy default). */
export const DEFAULT_TRACE_SUCCESS_SAMPLE_RATE = 0.1;

/** FNV-1a 32: stable runId → [0, 1) mapping (no runtime RNG anywhere). */
function fnv1a01(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** `Partial<SamplingRates>` from W9-D tracer.ts, plus the run outcome. */
export interface RunSamplingOptions {
  readonly isError: boolean;
  readonly errorRate?: number;
  readonly successRate?: number;
}

/**
 * §22 sampling decision for a run, deterministic in `runId` so the same run
 * samples identically on every worker and retry (the injected rng is the
 * FNV-1a hash of the runId; W9-D's policy still owns the rates + clamping).
 * Errors are ALWAYS traced; successes at `successRate` (default 10%).
 * Apply BEFORE startRun so an unsampled run emits nothing at all.
 */
export function isRunSampled(runId: string, options: RunSamplingOptions): boolean {
  const policy = createSamplingPolicy({
    errorRate: options.errorRate,
    successRate: options.successRate,
    rng: () => fnv1a01(runId),
  });
  return policy.decide({ error: options.isError });
}

// ---------------------------------------------------------------------------
// Sink input types (field names mirror src/events.ts step payloads)
// ---------------------------------------------------------------------------

export interface RunTraceStart {
  readonly runId: string;
  readonly workspaceId: string;
  readonly org?: string;
  readonly tier: string;
  /** §22 correlation chain head: request_id → workspace_id → run_id → step_seq. */
  readonly requestId?: string;
  /** Raw user brief — masked inside startRun, before it leaves this module. */
  readonly prompt: string;
  /** Per-workspace opt-in (§22): the only path to unmasked passthrough. */
  readonly promptOptIn: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StepSpanStart {
  readonly stepSeq: number;
  readonly phase?: string;
  /** Tool steps carry the tool name; engine steps pass null (events.ts shape). */
  readonly tool: string | null;
}

export interface StepSpanResult {
  readonly ok: boolean;
  /** Overrides sink timing when the worker already measured the step. */
  readonly durationMs?: number;
  /** Typed envelope fields only — never a stack, absolute path or internal id. */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface GenerationRecord {
  /** §5.1 phase that made the call (planner/executor/critic/repair/classifier). */
  readonly phase?: string;
  readonly model: string;
  readonly usage: GenerationUsage;
  /** W9-C cost-model cost for this call, micro-USD. */
  readonly costMicroUsd: number;
  /** From the packages/agent/prompts/v* frontmatter `id` + `version` pair. */
  readonly promptId?: string;
  readonly promptVersion?: number | string;
  /** Critic/validator verdicts ride here (§22 "traces include … verdicts"). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RunTraceEnd {
  /** Terminal status (RunPhase string), e.g. "succeeded" | "failed". */
  readonly status: string;
  /** Final agent summary — masked unless the workspace opted in. */
  readonly summary?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LangfuseStepSpan {
  /** Emits the completed span exactly once (a second call is ignored). */
  end(result: StepSpanResult): void;
}

export interface LangfuseRunTrace {
  readonly runId: string;
  /** Opaque client trace ref (null/undefined ⇒ trace failed; emissions skip). */
  readonly ref: unknown;
  startStep(step: StepSpanStart): LangfuseStepSpan;
  recordGeneration(record: GenerationRecord): void;
  endRun(end: RunTraceEnd): void;
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

export interface LangfuseSinkOptions {
  /** Injectable §15.3 redaction policy (default: constant "[redacted]"). */
  readonly mask?: PromptMasker;
  /** Injectable clock (deterministic tests; default Date.now). */
  readonly now?: () => number;
}

/**
 * Emits one Langfuse trace per run, one span per step, one generation record
 * per model call. Prompts and summaries pass the injected masker; correlation
 * ids (request/workspace/run/stepSeq) are metadata and are NEVER redacted —
 * §22 redacts content, not correlation. Client failures are swallowed and
 * counted: tracing must never break a run.
 */
export class LangfuseTraceSink {
  private readonly client: LangfuseLike;
  private readonly mask: PromptMasker;
  private readonly clock: () => number;
  private droppedCount = 0;

  constructor(client: LangfuseLike = NOOP_LANGFUSE, options: LangfuseSinkOptions = {}) {
    this.client = client;
    this.mask = options.mask ?? defaultPromptMasker;
    this.clock = options.now ?? Date.now;
  }

  /** Emissions swallowed since construction (client threw / trace failed). */
  get dropped(): number {
    return this.droppedCount;
  }

  startRun(start: RunTraceStart): LangfuseRunTrace {
    const masked = this.mask(start.prompt, {
      kind: "prompt",
      runId: start.runId,
      optedIn: start.promptOptIn,
    });
    // Built-in correlation keys are spread LAST: caller metadata can never
    // overwrite runId/workspaceId/tier (§22 chain integrity).
    const ref = this.emit(() =>
      this.client.trace({
        name: "agent-run",
        input: masked,
        metadata: {
          ...(start.metadata ?? {}),
          requestId: start.requestId ?? null,
          workspaceId: start.workspaceId,
          org: start.org ?? null,
          runId: start.runId,
          tier: start.tier,
          promptMasked: !start.promptOptIn,
        },
      }),
    );
    const startedAt = this.clock();
    const self = this;
    const live = ref !== null && ref !== undefined;

    return {
      runId: start.runId,
      ref,
      startStep(step: StepSpanStart): LangfuseStepSpan {
        const stepStartedAt = self.clock();
        let ended = false;
        return {
          end(result: StepSpanResult): void {
            if (ended || !live) return;
            ended = true;
            const durationMs = result.durationMs ?? Math.max(0, self.clock() - stepStartedAt);
            const metadata: Record<string, unknown> = {
              runId: start.runId,
              stepSeq: step.stepSeq,
              phase: step.phase ?? null,
              tool: step.tool,
              ok: result.ok,
              durationMs,
              ...(result.error
                ? { errorCode: result.error.code, errorMessage: result.error.message }
                : {}),
            };
            self.emit(() =>
              self.client.span(ref, {
                name: step.tool ? `step:${step.stepSeq}:${step.tool}` : `step:${step.stepSeq}`,
                metadata,
              }),
            );
          },
        };
      },
      recordGeneration(record: GenerationRecord): void {
        if (!live) return;
        const promptRef =
          record.promptId !== undefined && record.promptVersion !== undefined
            ? formatPromptVersion(record.promptId, record.promptVersion)
            : undefined;
        self.emit(() =>
          self.client.generation(ref, {
            name: record.phase ? `generation:${record.phase}` : "generation",
            model: record.model,
            usage: {
              input: record.usage.tokensIn,
              output: record.usage.tokensOut,
              // W9-C asserts cacheHits ≤ tokensIn on the money path; the sink
              // clamps defensively (a trace sink never throws over telemetry).
              cacheRead: Math.min(record.usage.cacheHits ?? 0, record.usage.tokensIn),
              total: record.usage.tokensIn + record.usage.tokensOut,
            },
            cost: record.costMicroUsd,
            ...(promptRef !== undefined ? { prompt: promptRef } : {}),
            metadata: {
              ...(record.metadata ?? {}),
              runId: start.runId,
              ...(record.phase !== undefined ? { phase: record.phase } : {}),
              costMicroUsd: record.costMicroUsd,
              cacheHits: record.usage.cacheHits ?? 0,
              promptVersion: promptRef ?? null,
            },
          }),
        );
      },
      endRun(end: RunTraceEnd): void {
        if (!live) return;
        const summary =
          end.summary !== undefined
            ? self.mask(end.summary, {
                kind: "summary",
                runId: start.runId,
                optedIn: start.promptOptIn,
              })
            : undefined;
        self.emit(() =>
          self.client.span(ref, {
            // LangfuseLike has no trace-update method, so the terminal status
            // is a closing span under the run trace.
            name: `run:${end.status}`,
            ...(summary !== undefined ? { output: summary } : {}),
            metadata: {
              ...(end.metadata ?? {}),
              runId: start.runId,
              status: end.status,
              durationMs: Math.max(0, self.clock() - startedAt),
            },
          }),
        );
      },
    };
  }

  /** Swallow-and-count: an observability sink never breaks the run path. */
  private emit<T>(call: () => T): T | null {
    try {
      return call();
    } catch {
      this.droppedCount += 1;
      return null;
    }
  }
}

/** Functional constructor for the worker's DI container. */
export function createLangfuseTraceSink(
  client: LangfuseLike = NOOP_LANGFUSE,
  options: LangfuseSinkOptions = {},
): LangfuseTraceSink {
  return new LangfuseTraceSink(client, options);
}

// ---------------------------------------------------------------------------
// Env-gated client resolution (worker calls once at boot; absence → Noop)
// ---------------------------------------------------------------------------

/** Minimal surface of the Langfuse JS SDK this module needs (v3 core client). */
interface RawLangfuseClient {
  trace(body: Readonly<Record<string, unknown>>): unknown;
  span(body: Readonly<Record<string, unknown>>): unknown;
  generation(body: Readonly<Record<string, unknown>>): unknown;
}

function traceRefToId(traceRef: unknown): string | undefined {
  if (typeof traceRef === "string") return traceRef;
  if (traceRef !== null && typeof traceRef === "object" && "id" in traceRef) {
    const id = (traceRef as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

function adaptRawLangfuse(raw: RawLangfuseClient): LangfuseLike {
  return {
    trace: (body) => raw.trace({ ...body }),
    span: (traceRef, body) => {
      const traceId = traceRefToId(traceRef);
      return raw.span({ ...body, ...(traceId !== undefined ? { traceId } : {}) });
    },
    generation: (traceRef, body) => {
      const traceId = traceRefToId(traceRef);
      // Canonical Langfuse usage keys; cache + micro-cost ride in metadata —
      // the installed SDK minor's cacheRead/totalCost support is verified by
      // the worker at wiring time (obs/integration.md, field-fidelity note).
      return raw.generation({
        name: body.name,
        model: body.model,
        usage: {
          input: body.usage.input,
          output: body.usage.output,
          total: body.usage.total,
          totalCost: body.cost / 1_000_000,
        },
        ...(traceId !== undefined ? { traceId } : {}),
        metadata: {
          ...(body.metadata ?? {}),
          cacheRead: body.usage.cacheRead,
          costMicroUsd: body.cost,
        },
      });
    },
  };
}

export type LangfuseClientLoader = (env: LangfuseEnv) => Promise<LangfuseLike | null>;

/**
 * Best-effort default loader: dynamic-imports 'langfuse' (NOT a package.json
 * dependency — the worker installs it when observability is enabled) and
 * adapts the SDK client to LangfuseLike. Absent module, absent keys, or an
 * SDK shape change all resolve to null (→ NOOP), never a throw.
 */
export const defaultLangfuseClientLoader: LangfuseClientLoader = async (env) => {
  const publicKey = env.publicKey;
  const secretKey = env.secretKey;
  if (publicKey === undefined || secretKey === undefined) return null;
  const specifier = "langfuse";
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ specifier);
  } catch {
    return null;
  }
  const ctor = (mod as { Langfuse?: unknown } | null)?.Langfuse;
  if (typeof ctor !== "function") return null;
  try {
    const raw = new (ctor as new (options: {
      publicKey: string;
      secretKey: string;
      host?: string;
    }) => RawLangfuseClient)({
      publicKey,
      secretKey,
      ...(env.host !== undefined ? { host: env.host } : {}),
    });
    return adaptRawLangfuse(raw);
  } catch {
    return null;
  }
};

export type LangfuseResolution =
  | {
      readonly mode: "noop";
      readonly reason: "missing-keys" | "module-unavailable";
      readonly client: LangfuseLike;
    }
  | { readonly mode: "live"; readonly client: LangfuseLike; readonly host: string | null };

/**
 * Env-gated resolution (worker calls once at boot):
 *   - either key missing → NOOP without touching the module (a half-configured
 *     environment must not half-trace);
 *   - loader failure/absence → NOOP (tracing is optional, §17.2);
 *   - live → the adapted client; host echoed for the worker's health log —
 *     the keys themselves are never surfaced anywhere.
 */
export async function resolveLangfuse(
  env: LangfuseEnv,
  load: LangfuseClientLoader = defaultLangfuseClientLoader,
): Promise<LangfuseResolution> {
  if (env.publicKey === undefined || env.secretKey === undefined) {
    return { mode: "noop", reason: "missing-keys", client: NOOP_LANGFUSE };
  }
  let client: LangfuseLike | null = null;
  try {
    client = await load(env);
  } catch {
    client = null;
  }
  if (client === null) {
    return { mode: "noop", reason: "module-unavailable", client: NOOP_LANGFUSE };
  }
  return { mode: "live", client, host: env.host ?? null };
}
