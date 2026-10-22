# M4-A — LiteLLM runner (work record)

Task ID: M4-A · Agent: M4-A LiteLLM runner · Wave 1 · 2026-10-22/23

## Scope (owned paths — law #12)

- `services/gateway/src/runner.ts` (seam: AgentRunner/AgentRun/AgentRunStream/RunLog/RunRegistry + MockRunner)
- `services/gateway/src/routes/chat.ts`
- `services/gateway/src/litellm/{openai.ts, prompt.ts, runner.ts}` (new)
- `services/gateway/src/index.ts` (ONE line: `createRunnerForEnv(env, logger)`)
- `services/gateway/tests/litellm-{openai,runner,chat}.test.ts` (new, 43 tests)
- `packages/contracts/src/routes/chat.ts` (optional `model` field ONLY)

## What landed

1. **Seam 1 slice** — `CHAT_REQUEST_SCHEMA.model: MODEL_ID_SCHEMA.optional()` (strictObject kept);
   chat route: `resolvePlan(workspace.id)` → `resolveChatModel({requested, plan, requestId})`
   (exported, unit-tested) → `GatewayError("MODEL_NOT_ENTITLED", 403)` or
   `request.model ?? defaultModelForPlan(plan)`. Replaced the hardcoded `"trial"`.
2. **Seam 2** — `RunLog.waitToolResult(toolCallId, timeoutMs)` resolving on the log's own
   `tool.result` events (runs.ts already emits them on client POST), `aborted` via the
   registry signal (RunLog constructor takes an optional signal; `RunRegistry.register` wires it).
   `AgentRunStream.waitForToolResult(toolCallId)` wired in chat.ts with
   `TOOL_RESULT_TIMEOUT_MS = 30_000` (exported from `litellm/runner.ts`).
   Timeout → outcome failed `EDITOR_DISCONNECTED`, retryable, "The editor didn't respond in time."
3. **Seam 3** — `litellm/openai.ts`: fetch+SSE streaming client, NO SDK; body
   `{model, messages, tools?, tool_choice:"auto", stream:true, stream_options:{include_usage:true}}`;
   bearer `virtualKey ?? apiKey`; 2 retries (1s/2s, injectable sleep); abort → AbortError;
   mid-stream failure → ModelUnavailableError (no retry — deltas already streamed).
   `litellm/prompt.ts`: §5.4 six primer bullets VERBATIM + read-tool descriptions +
   motion-graphics statement + §8.3 untrusted-data rule; `buildMessages` (system + history +
   user + context-flags/pinned note); `fingerprintMessages` = chars + sha256 ONLY (M4.3 redaction).
   `litellm/runner.ts`: full loop — 5 read tools only (M4.6; test asserts the provider tools array),
   Zod args validation with ONE repair turn then `RUN_INVALID_TOOL`, client tools via
   tool.started + expectToolCall + waitForToolResult, `studio.plan_edit` as a server-side
   structured-output call (2 attempts, fence-tolerant parse, `EDIT_PLAN_SCHEMA`) →
   emits `{type:"plan"}` + tool.result(plan) + feeds plan JSON back, step cap →
   `RUN_STEP_LIMIT`, usage → `ceil(in/1k×rateIn + out/1k×rateOut)` min 1 (MODEL_CATALOG),
   missing usage → tokens ≈ chars/4 (assistant turns counted as output).
4. `AgentRun.history?: readonly AgentRunHistoryTurn[]` — chat.ts loads the thread's last 6
   messages via `repos.threads.listMessages` BEFORE persisting this run's user turn.
5. `createRunnerForEnv(env, logger = nullLogger)` — mock when `env.app.mockModel`, else LiteLLM
   (`env.litellm.{baseUrl,apiKey,virtualKey}`, maxSteps `env.agent.chatMaxSteps`).
   UnavailableRunner deleted (no remaining consumers).

## Deviations from the brief (documented)

- Step-cap env var is **CHAT_MAX_STEPS** (`env.agent.chatMaxSteps`), not `MAX_MODEL_STEPS`
  (that name doesn't exist in @studio/config; the seams doc was wrong on the exact name).
- Step-limit code: `RUN_STEP_LIMIT` as the run.failed SSE event code (NOT in the config catalog
  — SSE payload codes are free-form strings; `httpStatusFor` fallback only matters for HTTP
  envelopes, and run.failed is not one). No catalog add needed; noted for M4-K.
- `MODEL_NOT_ENTITLED` is NOT a `StudioErrorCode` (catalog lacks it); thrown as
  `GatewayError` (status 403 already mapped in gateway errors.ts) — no unowned file edited.
- `createLiteLLMRunner` deps gained optional `sleep?` and `logger?` beyond the pinned shape
  ({baseUrl, apiKey, virtualKey?, maxSteps, fetch?}) — required for deterministic <5s retry
  tests and the M4.3 redaction logging. Call sites still satisfy the pinned shape.
- After 2 failed plan-parse attempts the runner feeds `{error:"PLAN_INVALID"}` back as the tool
  result (model may retry inside the step cap) instead of failing the run — never mutates,
  bounded by the step cap; noted for M4-K/M5.
- plan_edit also gets tool.started + expectToolCall + a server-emitted tool.result (per
  M4-SEAMS Seam 3 ordering; M4-C2's executor skips executing it and must ignore its result).

## Tests (all deterministic, fake in-process OpenAI SSE server, no network)

- `litellm-openai.test.ts` (8): SSE order, fragment aggregation by index, usage chunk,
  body/bearer shape, tools omitted for structured calls, 500→retry→success (sleep spy 1s/2s),
  500×3→ModelUnavailableError, mid-stream abort, mid-stream failure mapping, CRLF + tail frame.
- `litellm-runner.test.ts` (25): happy path (usage→credits 7 + §7.4 order), estimate path,
  committedCreditsFor math, get_context round-trip (deferred wait resolved by the test),
  EDITOR_DISCONNECTED timeout, aborted wait → cancelled, repair turn → RUN_INVALID_TOOL,
  repair-recovery, plan_edit happy (fenced JSON, plan event schema-valid, result fed back,
  structured call has no tools), plan invalid ×2 → PLAN_INVALID fed back, step cap →
  RUN_STEP_LIMIT, 500×3 → RUN_MODEL_UNAVAILABLE, cancel mid-stream, ONLY 5 read tools sent,
  redaction (spy logger: sha256 prefix + chars, marker never logged), RunLog.waitToolResult
  (resolve/late/timeout/aborted/registry cancel), prompt primer bullets verbatim.
- `litellm-chat.test.ts` (10): schema model field (optional/enum/strict), resolveChatModel
  defaults + entitlements + 403, createRunnerForEnv mock-vs-LiteLLM selection (stubbed
  global fetch; env.litellm wiring + bearer fallback).

## Gates at close

- `pnpm --filter @studio/gateway typecheck` GREEN; `test` 91/91 GREEN with
  DATABASE_URL (42 pre-existing + 6 models (M4-A2) + 43 mine); suite ~15s, my files <100ms.
- `pnpm --filter @studio/contracts typecheck` GREEN; `test` 105/105 GREEN.
- `pnpm --filter @studio/api-client` typecheck+test 117/117 GREEN (contracts change is additive).
- web typecheck GREEN. Biome: MY files clean; repo gateway `pnpm lint` was ALREADY red at
  baseline (88 errors in W3-gw files: middleware.ts/app.test.ts etc. — not mine, untouched).

## Handoff facts (wave-2 UI + M4-K)

- AgentRunStream gained `waitForToolResult(toolCallId)` → the chat route wires it to
  `log.waitToolResult(id, TOOL_RESULT_TIMEOUT_MS)`; client tools see tool.started → POST
  /v1/runs/:id/events → the runs route emits tool.result on the log → wait resolves.
- Step-limit failure code on the wire: `run.failed {code:"RUN_STEP_LIMIT", retryable:false}`.
- credits event shape (route finalize): `{reserved, committed, balance}` where committed is
  the LEDGER-capped commit (min(outcome.committedCredits, reserve)); the runner's outcome
  committedCredits is the raw usage math.
- The runner emits plan + tool.result for plan_edit SERVER-side; client tools get tool.result
  ONLY from the runs route (no duplicates).
- Full-route E2E (SSE over HTTP + ledger refund paths) is M4-K's chat-loop.test.ts.
