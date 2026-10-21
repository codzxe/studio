# Langfuse trace sink — worker wiring notes (W9-E)

`langfuse.ts` is a **sink over an injected `LangfuseLike` client**; it never
imports the SDK statically. The worker owns the real client, installed and
configured at boot. This note is the wiring recipe. Spec: §22, §15.3, §17.2,
§26 Q12; ADR-0005 #3/#6 (MIT core only — `ee/` never enabled; prompts
redacted unless the workspace opts in).

## Environment (§22 optional vars; parsed via `@studio/config`)

| Var | Required | Notes |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | for live tracing | declared in `packages/config/src/env/worker.ts` |
| `LANGFUSE_SECRET_KEY` | for live tracing | declared in `packages/config/src/env/worker.ts` |
| `LANGFUSE_HOST` | no | cloud (`https://cloud.langfuse.com`) or the on-box self-host URL per §26 Q12. **Flagged:** not yet a row in the config env schema — the config owner adds `LANGFUSE_HOST: httpUrl.optional()` when self-hosting (§17.2 note: Langfuse is heavy — Postgres + Clickhouse + Redis-class store + S3; cloud-masked until ~100 users). |

Absence of either key → **Noop** without touching the module. Keys are never
logged, echoed in errors, or written to payloads.

## Worker recipe (boot + run loop)

```ts
// boot (once):
const env = readLangfuseEnv(workerEnv);            // workerEnv is @studio/config-parsed
const resolution = await resolveLangfuse(env);     // 'langfuse' dynamic-import, env-gated
const sink = createLangfuseTraceSink(resolution.client);
const rates = samplingRatesFromEnv(workerEnv);     // W9-D obs/tracer.ts (OTEL_TRACES_* vars)

// per run — gate FIRST (§22: 100% errors, 10% successes):
if (!isRunSampled(run.id, { isError: run.failed, ...rates })) return;
const trace = sink.startRun({
  runId: run.id, workspaceId, org, tier, requestId,
  prompt: userBrief, promptOptIn: workspace.traceOptIn,   // §22 opt-in flag
});

// per step event (step.started / step.finished → events.ts shape):
const span = trace.startStep({ stepSeq, phase, tool });
span.end({ ok, durationMs, error: err && { code: err.code, message: err.message } });

// per model call (W9-C metering owns the money path — the sink never does):
const row: CostInput = { model, tokensIn, tokensOut, cacheHits };   // W9-C shape
const costMicroUsd = microToSafeNumber(computeCost(row));           // bigint → number
trace.recordGeneration({
  phase, model, usage: row,                        // GenerationUsage mirrors CostInput 1:1
  costMicroUsd, promptId, promptVersion,           // frontmatter id/version pair
  metadata: { criticVerdict, validatorOk },       // §22 "…verdicts"
});

// terminal event:
trace.endRun({ status, summary: agentSummary });
```

## What is traced

- **Run trace** `agent-run` — metadata carries the §22 correlation chain
  (`requestId → workspaceId → runId`, plus `org`, `tier`, `promptMasked`);
  `input` is the **masked** prompt.
- **Step spans** `step:<seq>[:<tool>]` — `stepSeq`, `phase`, `tool`
  (`null` for engine steps), `durationMs`, `ok`, and on failure the typed
  error envelope fields (`errorCode`/`errorMessage`) — never a stack trace.
- **Generation records** `generation[:<phase>]` — `model`, usage
  (`input`/`output`/`cacheRead`/`total`), `cost` in micro-USD (the worker
  bridges W9-C's **bigint** cost via its exported `microToSafeNumber`; the
  sink takes the number), `prompt` as the versioned ref from
  `packages/agent/prompts` frontmatter (e.g. `planner@v1`); critic/validator
  verdicts ride in `metadata` (§22). `GenerationUsage` mirrors W9-C's
  `CostInput` (`tokensIn`/`tokensOut`/`cacheHits`) field for field; the sink
  clamps `cacheHits ≤ tokensIn` defensively but never imports the money
  path.
- **Closing span** `run:<status>` — terminal status, run duration, and the
  agent's final summary (masked unless opted in) — `LangfuseLike` has no
  trace-update method, so the terminal state is a closing span.

## The masking contract (§22 + §15.3; ADR-0005 #6)

1. **Redacted by default.** Prompts and run summaries go through the injected
   `PromptMasker` (`defaultPromptMasker`); non-opted-in workspaces emit the
   constant `"[redacted]"` — no length or content leak.
2. **Opt-in passthrough only.** The per-workspace flag is the single path to
   unmasked text; it covers prompt AND summary for that run.
3. **Correlation ids are never redacted** — §22 redacts content, not the
   request/workspace/run/step chain.
4. **Injectable policy.** `mask` in `LangfuseSinkOptions` lets ops tighten or
   replace the policy (e.g. length-preserving masks) without touching call
   sites; tests pin the default table.
5. This is what makes the **§26 Q12 cloud deployment honest**: Langfuse cloud
   only ever sees masked prompts until we self-host on the box.

## Sampling tie-in (§22)

`isRunSampled(runId, { isError, errorRate?, successRate? })` — the §22 policy
**math is W9-D's** (`obs/tracer.ts` `createSamplingPolicy`, rates from its
`samplingRatesFromEnv`); the only addition is run-keyed determinism: the
policy's rng is the FNV-1a hash of `runId`, so one run samples identically on
every worker and retry. Errors trace at 100% (dial-down via `errorRate` for a
firehose incident, as in tracer.ts); successes at 10% by default. The worker
applies the gate **before `startRun`**, so an unsampled run emits nothing at
all.

## Noop fallback and failure policy

- Missing keys, absent module, changed SDK shape, or loader throw →
  `NOOP_LANGFUSE`; `resolveLangfuse` never throws.
- A live client that throws per-call is swallowed and counted in
  `sink.dropped`; a failed run-trace emission skips its dependents. **Tracing
  must never break a run.**
- The default loader uses a non-literal dynamic-import specifier — 'langfuse'
  is NOT a package.json dependency; the worker adds it when observability is
  enabled, then verifies the adapter's field mapping against the installed SDK
  minor (usage `cacheRead`/`totalCost`, the generation↔prompt link, and the
  `traceId` unwrapping) — tests pin our seam shape, not the SDK's.

## Flagged for other owners (not done here)

- `LANGFUSE_HOST` env row — `packages/config/src/env/worker.ts` owner.
- `export * from "./obs/langfuse.js"` — barrel owner (`src/index.ts`); until
  then the worker deep-imports `@studio/agent/src/obs/langfuse.js`.
- W9-D `obs/tracer.ts` (landed) is imported for the sampling policy; the step
  handle stays self-contained — if the worker wants one timing source, it can
  wrap a W9-D `Span` and pass its durationMs to `end()`.
- W9-C `metering/cost-model.ts` (landed) is deliberately **mirrored, not
  imported** (trace sink off the money path) — keep `GenerationUsage` field
  names in sync with `CostInput` if W9-C renames them.
