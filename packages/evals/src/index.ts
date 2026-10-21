// @studio/evals — structural barrel (spec §11.4/§21; ≥85% suite gate §19).
//
// This package is CONFIG-DRIVEN, not library code: the eval surface is the
// promptfoo corpus (promptfoo.config.yaml, chat-edits.config.yaml, cases/**,
// prompts/**, schemas/**) plus provider/script glue in providers/** and
// scripts/** (tsconfig includes those .mjs files). Nothing imports
// @studio/evals at runtime, so this barrel intentionally exports no symbols —
// it exists to keep the repo-wide package layout uniform
// (packages/*/package.json + tsconfig.json + src/index.ts) so structural
// audits and workspace tooling can rely on one shape everywhere.
export {};
