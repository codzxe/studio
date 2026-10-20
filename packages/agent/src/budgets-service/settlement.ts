// @studio/agent — §5.2 clean-stop settlement: how a run's credit reservation
// resolves when the §5.2 tier budget stopped it mid-run. Owner: W6-G.
//
// Spec anchors:
//   §5.2  "stop cleanly, commit what strengthened the document (if it is better
//         than the pre-run state and passes the validator), charge partially at
//         most, and tell the user what was cut."
//   §14.2 rule 1 — reserve the tier's base cost on run creation.
//   §14.2 rule 2 — on success, commit the actual tier cost (multipliers included).
//   §14.2 rule 4 — "charge at most half the base" is the FAILURE path owned by
//         @studio/billing `classifyRefund` (billing maps `budget_stop` → nothing
//         to refund: a §5.2 budget stop is explicitly NOT a failure; the
//         reservation settles at the partial commit below). This module never
//         imports @studio/billing — @studio/agent does not depend on it; the
//         run manager bridges this Settlement to the ledger + billing policy.
//
// Partial-charge formula (exact, auditable):
//
//     charge = ceil(credits × completedPhases / totalPhases), clamped to [1, credits]
//
// i.e. the reservation minus the work-not-done ratio. The FLOOR of 1 credit is
// the §14.2-anchored minimum for a run that COMMITTED validator-passed work:
// §5.2 never charges zero for committed work, and the ledger never sees
// fractional credits (§12.2 money is never a float). The CEILING is the tier
// price — "charge partially AT MOST" (§5.2). `ceil` errs towards the platform
// only inside that band.
import { type RunTierId, RUN_TIER_ID_SCHEMA, resolveTierConfig } from "@studio/config";
import { z } from "zod";
import { BUDGET_KINDS } from "../budgets.js";
import type { BudgetReport } from "./tracker-factory.js";

const budgetExceededSchema = z.strictObject({
  kind: z.enum(BUDGET_KINDS),
  remaining: z.number().int().min(0),
  message: z.string().min(1),
});

const budgetModelUsageSchema = z.strictObject({
  calls: z.number().int().min(0),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
});

const budgetUsageSchema = z.strictObject({
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  toolCalls: z.number().int().min(0),
  revisions: z.number().int().min(0),
  wallClockMs: z.number().int().min(0),
});

const budgetRemainingSchema = z.strictObject({
  tokensIn: z.number().int().min(0).nullable(),
  tokensOut: z.number().int().min(0).nullable(),
  toolCalls: z.number().int().min(0),
  revisions: z.number().int().min(0),
  wallClockMs: z.number().int().min(0),
});

/**
 * Boundary schema: settlement consumes reports that may have round-tripped run
 * persistence (JSON), so the shape is validated before any money math — fail
 * fast on drift (W1-P's zod-at-the-boundary precedent).
 */
export const budgetReportSchema = z.strictObject({
  used: budgetUsageSchema,
  remaining: budgetRemainingSchema,
  modelUsage: z.record(z.string(), budgetModelUsageSchema),
  cacheHitRate: z.number().min(0).max(1).nullable(),
  exceeded: budgetExceededSchema.nullable(),
  tier: RUN_TIER_ID_SCHEMA,
  credits: z.number().int().min(1),
  completed: z.boolean(),
  stopped: z.boolean(),
  phasesCompleted: z.number().int().min(0),
  phasesTotal: z.number().int().min(1),
});

export const settlementOutcomeSchema = z.strictObject({
  validatorPassed: z.boolean(),
  documentImproved: z.boolean(),
});

export const SETTLEMENT_POLICIES = ["full_charge", "partial", "refund_all"] as const;

export type SettlementPolicy = (typeof SETTLEMENT_POLICIES)[number];

/** What the run manager passes about the run's terminal quality (§5.2). */
export interface SettlementOutcome {
  /** The deterministic validator passed on the committed document (§5.1). */
  readonly validatorPassed: boolean;
  /** The committed document is better than the pre-run state (§5.2). */
  readonly documentImproved: boolean;
}

/** How the §14.2 rule-1 reservation resolves at the run's terminal. */
export interface Settlement {
  readonly policy: SettlementPolicy;
  readonly tier: RunTierId;
  /** The §14.2 rule-1 reservation: the tier's credit price. */
  readonly reservedCredits: number;
  /** What the ledger COMMITS (§14.2 rule 2) — the actual charge. */
  readonly chargeCredits: number;
  /** What the ledger RELEASES back: reserved − charge. */
  readonly releaseCredits: number;
  readonly completed: boolean;
  readonly stopped: boolean;
  readonly validatorPassed: boolean;
  readonly documentImproved: boolean;
  /** The §5.2 formula charge when policy is `partial`; null otherwise. */
  readonly partialChargeCredits: number | null;
  /** User-surfaceable sentence (§5.2 "tell the user what was cut"): no ids, no paths. */
  readonly note: string;
}

/**
 * The §5.2 partial charge — the exact formula:
 * `ceil(credits × completedPhases / totalPhases)` clamped to `[1, credits]`.
 * See the module header for the floor/ceiling rationale.
 */
export function partialChargeCredits(
  credits: number,
  completedPhases: number,
  totalPhases: number,
): number {
  if (!Number.isSafeInteger(credits) || credits < 1) {
    throw new Error("[agent] credits must be a positive integer");
  }
  if (!Number.isSafeInteger(totalPhases) || totalPhases < 1) {
    throw new Error("[agent] totalPhases must be a positive integer");
  }
  if (!Number.isSafeInteger(completedPhases) || completedPhases < 0) {
    throw new Error("[agent] completedPhases must be a non-negative integer");
  }
  const raw = Math.ceil((credits * completedPhases) / totalPhases);
  return Math.min(credits, Math.max(1, raw));
}

function buildSettlement(params: {
  readonly policy: SettlementPolicy;
  readonly tier: RunTierId;
  readonly reservedCredits: number;
  readonly chargeCredits: number;
  readonly partialChargeCredits: number | null;
  readonly completed: boolean;
  readonly stopped: boolean;
  readonly validatorPassed: boolean;
  readonly documentImproved: boolean;
  readonly note: string;
}): Settlement {
  return Object.freeze({
    ...params,
    releaseCredits: params.reservedCredits - params.chargeCredits,
  });
}

/**
 * Resolves a run's credit reservation under the §5.2 clean-stop rule. The
 * caller (run manager) consumes the returned `Settlement` to drive the ledger
 * commit/release (via @studio/billing) and surfaces `note` + the tracker's
 * `exceeded.message` over SSE.
 *
 * Table (exact):
 *   completed within budget, validator passed  → full_charge (§14.2 rule 2)
 *   budget-stopped + improved + validator ok   → partial      (formula above)
 *   budget-stopped, no improvement            → refund_all   (nothing committed)
 *   validation failed (any terminal)          → refund_all   (§5.1 rolls the
 *                                               transaction back; §5.2 commits
 *                                               only validator-passing work)
 *
 * Anything else — neither completed nor §5.2-stopped, with validation passed —
 * is a NON-budget terminal (user cancel / engine crash / provider failure).
 * That is @studio/billing's §14.2 `classifyRefund` path; this function refuses
 * to guess and throws (a wiring bug, not a budget event).
 */
export function computeSettlement(
  budgetReport: BudgetReport,
  tier: RunTierId,
  outcome: SettlementOutcome,
): Settlement {
  const report = budgetReportSchema.parse(budgetReport);
  const settled = settlementOutcomeSchema.parse(outcome);
  if (report.tier !== tier) {
    throw new Error(
      `[agent] settlement tier mismatch: report priced '${report.tier}', caller passed '${tier}'`,
    );
  }
  const reservedCredits = resolveTierConfig(tier).credits;
  if (report.credits !== reservedCredits) {
    throw new Error(
      `[agent] settlement credit drift: report holds ${report.credits}, tier '${tier}' prices ${reservedCredits}`,
    );
  }
  if (report.completed && report.stopped) {
    throw new Error("[agent] a run cannot be both completed and budget-stopped");
  }

  // §5.1: a validation blocker rolls the transaction back, and §5.2 commits only
  // work that "passes the validator" — nothing commits, nothing is owed.
  if (!settled.validatorPassed) {
    return buildSettlement({
      policy: "refund_all",
      tier,
      reservedCredits,
      chargeCredits: 0,
      partialChargeCredits: null,
      completed: report.completed,
      stopped: report.stopped,
      validatorPassed: false,
      documentImproved: settled.documentImproved,
      note: `Validation failed, so nothing was committed — released all ${reservedCredits} reserved credits.`,
    });
  }

  // §14.2 rule 2: success commits the actual tier cost (multipliers included).
  if (report.completed) {
    return buildSettlement({
      policy: "full_charge",
      tier,
      reservedCredits,
      chargeCredits: reservedCredits,
      partialChargeCredits: null,
      completed: true,
      stopped: false,
      validatorPassed: true,
      documentImproved: settled.documentImproved,
      note: `Run completed within the tier budget — charged ${reservedCredits} of ${reservedCredits} reserved credits.`,
    });
  }

  // §5.2 clean stop: commit what strengthened the document, charge partially.
  if (report.stopped) {
    if (settled.documentImproved) {
      const charge = partialChargeCredits(
        reservedCredits,
        report.phasesCompleted,
        report.phasesTotal,
      );
      const cut = report.exceeded !== null ? `${report.exceeded.message} ` : "";
      return buildSettlement({
        policy: "partial",
        tier,
        reservedCredits,
        chargeCredits: charge,
        partialChargeCredits: charge,
        completed: false,
        stopped: true,
        validatorPassed: true,
        documentImproved: true,
        note: `${cut}Charged ${charge} of ${reservedCredits} reserved credits for the ${report.phasesCompleted} of ${report.phasesTotal} phases that finished.`,
      });
    }
    return buildSettlement({
      policy: "refund_all",
      tier,
      reservedCredits,
      chargeCredits: 0,
      partialChargeCredits: null,
      completed: false,
      stopped: true,
      validatorPassed: true,
      documentImproved: false,
      note: `The tier budget stopped the run before it strengthened the document — released all ${reservedCredits} reserved credits.`,
    });
  }

  throw new Error(
    "[agent] not a §5.2 settlement: the run neither completed nor stopped on a tier budget — route non-budget terminals through @studio/billing classifyRefund (§14.2)",
  );
}
