// @studio/billing — pure billing domain (spec §14 + §5.2 + §24.4).
//
// Zero runtime dependencies beyond zod and the @studio/config constants; all
// storage goes through the LedgerStore seam in ./ledger.js, so every function
// is testable against an in-memory fake and the Drizzle-backed repo layer can
// land later without touching this package's semantics.
export * from "./ledger.js";
export * from "./plans.js";
export * from "./policy.js";
// limits/ (W9-B: PlanLimitsService seats/sessions/canvas/runs gates + trial
// rules) — re-exported from the package barrel per W9-B's fleet flag
// ("billing package owner should re-export limits from src/index.ts").
// Collision audit at wiring time: none of the limits names (PlanLimitsService,
// RUN_INTAKE_SCHEMA, TRIAL_*, checkTrial*/isTrial*/trialEligibility,
// InviteOptions, LimitsSeams, RunIntake*, UploadCeiling) appear in
// ledger/plans/policy — no disambiguation needed.
export * from "./limits/index.js";
