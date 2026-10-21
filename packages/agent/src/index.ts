// @studio/agent — public barrel. Originally W3-M (wiring); rebuilt by W6-P
// (wave-6 assembly) to re-export EVERY landed src/ module: the W1 core
// (budgets, errors, events, models, plan, state), W2-P's eventbus, and the
// wave-6 service directories (planner, executor, observer, validator, critic,
// repair, budgets-service, transactions, router, classifier, run-state).
// Consumers import ONLY this file — package.json main/exports and
// tsconfig.base.json paths point here.
//
// Collision audit (W6-P, across the full src/ export surface, ~600 names):
// exactly four clashes. Star-exports carry every module's public surface;
// each clashing name is ALSO re-exported explicitly below (explicit re-exports
// beat star exports in both TypeScript and the ESM spec — verified against
// tsc 5.7 + esbuild), so every clash resolves deterministically instead of
// being silently dropped. Documented aliases, one comment each:
//   - RUN_PHASES / RunPhase: state.ts's §5.1 step phases (8 statuses, aligned
//     1:1 with agent_runs.status / db RUN_PHASES) keep the canonical names;
//     budgets-service/tracker-factory.js phases — the §5.2 budget-counted kinds
//     plan/execute/validate/critique/repair — ride as BUDGET_PHASES/BudgetPhase.
//   - CritiqueIssue: events.ts's §13.2 critique.report payload (observation/fix
//     required) keeps the canonical name; critic/service.ts's parse-tolerant
//     twin (observation/fix optional — survives the tool's L3/L4 compaction)
//     rides as CriticIssue.
//   - AbortSignalLike: planner/planner.ts's narrow { aborted } stand-in keeps
//     the canonical name (classifier.ts imports it from there);
//     run-state/cancellation.ts's richer cooperative-cancel shape
//     ({ aborted, reason?, addEventListener?, removeEventListener? }) rides as
//     RunAbortSignalLike — structurally compatible both ways (all extras are
//     optional), so the alias is documentation, not a constraint.
//
// Flagged error codes NOT added here (errors.ts is W1-P's; add-only): wave-6
// modules left swap-point constants for AgentErrorCodes that are absent from
// the catalog, and flip the moment errors.ts adopts them —
//   repair/planner.js       REPAIR_PLAN_INVALID_CODE (= "plan_invalid" today)
//     → future code "repair_plan_invalid" (W6-F flag: errors.ts owner adds the
//       code + its AGENT_TO_WIRE_ERROR_CODE row and flips the constant);
//   critic/service.js       CRITIC_TOOL_FAILURE_CODE (= "tool_retry_exhausted"
//     today) → future code "critique_unavailable" (W6-E flag, same steps);
//   classifier/classifier.js CHAT_EDIT_INVALID_CODE (= "plan_invalid" today)
//     → same family, flips with the repair code or on its own row.
// All three constants are public here via their modules' star-exports; no
// index-aux.ts was needed — the four type/value clashes above resolve inline.
// tests/barrel.test.ts pins the swap-point values so each flip is a visible,
// test-breaking change for whoever adopts the codes.
//
// Extension points (checked against `ls src/` + git status at assembly time):
//   - guards/ (W6-K: injection.ts + tool-gate.ts, ToolCallGate) landed
//     MID-ASSEMBLY and was still being written; wired by W7-M below via
//     `export * from "./guards/index.js"` (guards/index.ts is W6-K's own
//     collision-checked barrel re-exporting injection.js + tool-gate.js)
//     + tests/barrel.test.ts rows, per the note in guards/index.ts.
//   - brand/ (W7-F: tokens.ts + service.ts) wired by W7-M the same way;
//     collision-audited by its owner, re-audited here at wiring time (zero
//     clashes with the full barrel surface).
// Each wave-6/7 owner collision-checks before their module goes public here.

// --- W1 core (W1-P budgets/models/plan/state/errors/events, W2-P eventbus) -----
export * from "./budgets.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./eventbus.js";
export * from "./models.js";
export * from "./plan.js";
export * from "./state.js";

// --- wave-6 services (owners: W6-A planner, W6-B executor, W6-C observer,
// --- W6-D validator, W6-E critic, W6-F repair, W6-G budgets-service,
// --- W6-H router, W6-I transactions, W6-J run-state, W6-O classifier) ----------
export * from "./planner/index.js";
export * from "./executor/index.js";
export * from "./observer/context.js";
export * from "./observer/observer.js";
export * from "./validator/service.js";
export * from "./validator/gate.js";
export * from "./critic/service.js";
export * from "./critic/cycle-gate.js";
export * from "./repair/planner.js";
export * from "./repair/prompt.js";
export * from "./budgets-service/tracker-factory.js";
export * from "./budgets-service/settlement.js";
export * from "./transactions/index.js";
export * from "./router/index.js";
export * from "./classifier/index.js";
export * from "./run-state/machine.js";
export * from "./run-state/cancellation.js";

// --- wave-7 additions (W7-M barrel completion; owners: W7-F brand, W6-K guards)
// brand/: BrandTokensService/DEFAULT_BRAND/brandTokensSchema… (§7.5 tokens);
// guards/: ToolCallGate + the §5.7 injection-stance helpers, via W6-K's own
// collision-checked guards/index.ts (re-exports injection.js + tool-gate.js).
export * from "./brand/index.js";
export * from "./guards/index.js";

// --- star-export collision disambiguation (explicit beats star) ----------------
// (1) RUN_PHASES / RunPhase — state.ts's §5.1 phases stay canonical:
export { RUN_PHASES, type RunPhase } from "./state.js";
// ...and budgets-service/tracker-factory.js's §5.2 phase kinds ride aliased:
export {
  RUN_PHASES as BUDGET_PHASES,
  type RunPhase as BudgetPhase,
} from "./budgets-service/tracker-factory.js";
// (2) CritiqueIssue — events.ts's §13.2 wire payload stays canonical:
export type { CritiqueIssue } from "./events.js";
// ...and critic/service.ts's parse-tolerant twin rides aliased as CriticIssue:
export type { CritiqueIssue as CriticIssue } from "./critic/service.js";
// (3) AbortSignalLike — planner's narrow stand-in stays canonical:
export type { AbortSignalLike } from "./planner/planner.js";
// ...and run-state/cancellation.ts's cooperative-cancel shape rides aliased:
export type { AbortSignalLike as RunAbortSignalLike } from "./run-state/cancellation.js";
