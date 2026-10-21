// @studio/agent — planner barrel (owner: W6-A, docs/AGENTS.md).
//
// Exposes the §23.2 prompt builder (prompt.ts), the §5.1 one-retry
// PlannerService + §23.2 rule enforcement (planner.ts), and the planner input
// schemas/types. No export-name collisions within this directory (checked
// against each other and against the sibling in-flight modules).
//
// NOTE for the src/index.ts owner: the package barrel does not re-export this
// directory yet (outside this task's ownership) — add
// `export * from "./planner/index.js";` when the executor/loop wave wires the
// planner into the run loop.
export * from "./planner.js";
export * from "./prompt.js";
