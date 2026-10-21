// @studio/agent — executor subsystem barrel. Owner: W6-B (docs/AGENTS.md).
//
// executor.ts: ExecutorService — the §5.1 executing driver over the
// provider-agnostic ExecuteModelLike seam (§5.3); walks plan.steps, dispatches
// tools through the registry map, enforces §5.2 budgets (clean stop + cut
// report), §5.1 round-trip caps, §5.5 deviation logging, §5.7 untrusted
// name/args gates, §23.1-rule-7 failed-call identity + §6.3 retry budget,
// and §3.4 abort/timeout handling.
// prompt.ts: the §23.1 executor system prompt, verbatim (budget substitution +
// tools manifest block only).
//
// NOTE (package barrel owner — W1/W3 lineage): adding
// `export * from "./executor/index.js"` to src/index.ts is safe — checked:
// zero name collisions with budgets/errors/events/eventbus/models/plan/state
// (Executor* prefixed throughout; `ExecuteModelLike`, `ProposedToolCall`,
// `ExecutorMessage`, `ExecutorTranscript`, `ExecutorEvent` are executor-only
// names). The worker (W6-A) consumes this barrel for the run loop.
export * from "./executor.js";
export * from "./prompt.js";
