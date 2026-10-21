// @studio/agent — the §5.1 critique→repair cycle gate. Owner: W6-E (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  "Max 2 repair cycles. If issues remain after 2 cycles: ship the best
//         render, mark the run `succeeded_with_warnings`, and surface the
//         remaining issues to the user with suggested manual fixes."
//   §11.2 "The critic is advisory: it cannot veto a valid document forever;
//         after the revision cap the run ships with warnings." — and "minors
//         are shown to the user as suggestions and never trigger a revision by
//         themselves."
//   §23.3 The vision_critique tool already enforced the verdict rules (score
//         forcing, ≤5 issues, revise⇔blocker/major invariants) IN CODE; this
//         gate trusts the enforced verdict and only decides the next phase.
//
// Truth table (task pin, verbatim):
//   verdict accept           → "finalize"
//   verdict revise, cycles<2 → "repair"
//   verdict revise, cycles≥2 → "finalize_with_warnings"
//
// "finalize_with_warnings" maps onto the run-state machine's terminal
// `succeeded_with_warnings` (state.js ALLOWED_TRANSITIONS: finalizing →
// succeeded | succeeded_with_warnings): the run manager transitions
// finalizing → succeeded_with_warnings and surfaces `remainingIssues` to the
// user, each row's `fix` text acting as the §5.1 "suggested manual fix".
// Purity: no counter mutation happens here — the RunCritic service owns the
// tally (noteRepairCycle) and the run manager calls it on "repair".

import { MAX_REPAIR_CYCLES } from "@studio/config";
import type { CritiqueIssue, CritiqueResult, CritiqueVerdict } from "./service.js";

export type CycleGateDecisionName = "finalize" | "repair" | "finalize_with_warnings";

export interface CycleGateDecision {
  readonly decision: CycleGateDecisionName;
  /**
   * Issues that SURVIVE this decision — the §5.1 surface payload:
   *   finalize                 → the accept's leftover issues (minors only per
   *                              the tool invariant) shown as suggestions;
   *   repair                   → [] (they are being fixed, nothing remains yet);
   *   finalize_with_warnings   → every remaining issue, blockers first, with
   *                              their `fix` texts as suggested manual fixes.
   */
  readonly remainingIssues: readonly CritiqueIssue[];
}

/**
 * The §5.1 decision after one critique pass. `critique` is the CritiqueVerdict
 * the tool enforced (not the skipped variant — see cycleGateForOutcome); `cycles`
 * is the number of repair cycles already consumed (RunCritic.cycles()).
 * A counter that overshoots the cap still lands on the capped branch — the
 * gate degrades to `finalize_with_warnings`, never to a third repair.
 */
export function cycleGate(critique: CritiqueVerdict, cycles: number): CycleGateDecision {
  if (critique.verdict === "accept") {
    // §5.1: accept → finalize. The tool's invariant guarantees an accept never
    // carries blocker/major issues, so whatever rides along is §11.2 minors —
    // surfaced to the user as suggestions, never as warnings on the run.
    return { decision: "finalize", remainingIssues: [...critique.issues] };
  }
  if (cycles < MAX_REPAIR_CYCLES) {
    // §5.1: repair narrowly, one more cycle. The blocker/major subset feeds the
    // repair planner through the service's repairIssues — nothing "remains"
    // yet, so the payload is empty.
    return { decision: "repair", remainingIssues: [] };
  }
  // §5.1: cap reached — ship the best render with warnings and surface the
  // remaining issues for manual fixes. (The pin's "cycles == 2"; a healthy
  // counter never reports more, but ≥ degrades to the same capped outcome.)
  return { decision: "finalize_with_warnings", remainingIssues: [...critique.issues] };
}

/**
 * The total gate over a RunCritic result: a skipped critique (§5.3 quick tier,
 * no critic route) finalizes CLEANLY — no critique happened, so the run has no
 * critic warnings to surface and no §5.1 cap to spend.
 */
export function cycleGateForOutcome(outcome: CritiqueResult, cycles: number): CycleGateDecision {
  if (outcome.skipped) {
    return { decision: "finalize", remainingIssues: [] };
  }
  return cycleGate(outcome.verdict, cycles);
}
