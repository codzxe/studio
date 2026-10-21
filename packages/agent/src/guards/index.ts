// @studio/agent — guards barrel (§5.7 prompt-injection stance). Owner: W6-K.
//
// collision-checked against every current agent export (executor, validator,
// budgets, errors, events, eventbus, models, plan, state): no duplicate names.
//
// NOTE for the package-barrel owner (src/index.ts): when wiring the executor
// integration, add `export * from "./guards/index.js"` — verified collision-free.

export * from "./injection.js";
export * from "./tool-gate.js";
