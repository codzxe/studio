// @studio/agent — classifier barrel (owner: W6-O, docs/AGENTS.md).
//
// Exposes the §23.5 prompt builder (prompt.ts), the ChatEditClassifier +
// post-rule/tier-guard/mini-plan helpers (classifier.ts), and the classifier
// input schemas/types. No export-name collisions within this directory
// (checked against each other and against the sibling in-flight modules;
// AbortSignalLike/rawExcerptOf are IMPORTED from ../planner, not re-exported,
// so the package barrel cannot hit TS4078 on them).
//
// NOTE for the src/index.ts owner: the package barrel does not re-export this
// directory yet (outside this task's ownership) — add
// `export * from "./classifier/index.js";` when the chat-edit wave wires the
// classifier into the run loop.
export * from "./classifier.js";
export * from "./prompt.js";
