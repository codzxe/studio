// @studio/gateway — the SERVER-SIDE AUTO-APPLY POLICY (BUILD_PLAN §M5 task 6,
// EDITOR_CHAT_UX §7.3; BUILD_PLAN §9 lists auto-apply as the FIRST optional
// scope cut — it ships OFF BY DEFAULT and per-user).
//
// v1 semantics — D-22 CANDIDATE RULING (recorded in the M5-O worklog block):
// the verdict is UI GUIDANCE ONLY. The client NEVER executes a plan from the
// plan event alone; `mode: "auto"` merely arms the plan card's default state
// and Apply remains the user's explicit button press (a deliberate ruling per
// BUILD_PLAN §M5.6 "off by default" + the high-trust UX: the setting flips the
// card's default state, it never bypasses the click). This module DECIDES; it
// never applies anything.
//
// PURITY: no IO, no clocks, no randomness — the decision is a pure function of
// (plan, compiled result, user setting), so the entire decision matrix is
// unit-testable without a database. The wiring (routes/chat.ts) reads the
// per-user setting through the pinned M6-D seam
// (`repos.settings.getUserAutoApply(userId): Promise<boolean>`, userSettings
// table, autoApplyEnabled, default false) and attaches the verdict to the
// `{type: "plan"}` SSE event (contracts PLAN_EVENT_SCHEMA.autoApply).
//
// SERVER VALUES ONLY: the rules are evaluated against the plan-compiler's
// RECOMPUTED risk/estimatedCredits (plan-compiler.ts), never the model's
// self-declared plan.risk/plan.estimatedCredits — a plan that lies low still
// gets judged by what it actually compiles to.
//
// Defense-in-depth — EVERY rule must hold for `mode: "auto"`, checked in this
// order (the first failure is the returned reason):
//   1. user setting enabled (default false)          → "setting-disabled"
//   2. compiled.ok (a compiled batch exists)          → "compile-failed"
//   3. server-recomputed risk === "low"              → "risk-not-low"
//   4. !plan.requiresApproval                        → "approval-required"
//   5. plan.intent ∈ AUTO_APPLYABLE_INTENTS          → "intent-not-auto-applyable"
//      (edit | style | animate — create/organize are structural, render is a
//      spend-heavy export, clarify/explain change nothing; contracts
//      edit-plan.ts owns the vocabulary)
//   6. every compiled batch command ∈ a REVERSIBLE   → "command-not-reversible"
//      subset (below — no effect.remove, no delete-ish, no edit.undo/redo,
//      no render-ish)
//   7. server-recomputed estimatedCredits ≤ ceiling  → "credits-above-ceiling"
//   8. compiled batch step count ≤ AUTO_APPLY_MAX_STEPS → "too-many-steps"
//      (a compiled-ok batch with ZERO steps also lands here — fail-closed: a
//      malformed compile result never yields "auto")

import {
  AGENT_COMMAND_IDS,
  AUTO_APPLYABLE_INTENTS,
  type EditPlan,
  type PlanIntent,
} from "@studio/contracts";

import type { CompilePlanResult } from "./plan-compiler.js";

// ---------------------------------------------------------------------------
// Bounds (EDITOR_CHAT_UX §7.3)
// ---------------------------------------------------------------------------

/**
 * §7.3 "small, quick" plans only: at most 10 compiled batch steps auto-apply.
 * (The §8.5 hard cap is 100 — auto-apply is deliberately an order of magnitude
 * tighter.)
 */
export const AUTO_APPLY_MAX_STEPS = 10;

/**
 * §7.3 says "credit spend above a threshold" without naming a number. Chosen
 * here: 3 credits — comfortably above every single- or few-step low-risk
 * estimate (estimateCredits: 1 step = 1.5, 4 steps = 3.0) while far below
 * render/high-risk spends (renders estimate 12+ per the M5 goldens). Tighten
 * or loosen per business ruling; this is the documented v1 default.
 */
export const AUTO_APPLY_MAX_CREDITS = 3;

/**
 * The reversible auto-apply command subset — hardcoded, deliberately tiny.
 * Every id is an in-place, non-destructive mutation (or an additive text/preset
 * apply) whose whole effect folds into the batch's single `edit.undo` step
 * (§8.5 / AGENT_COMMAND_UNDOABLE's batch-level heuristic). NO effect.remove,
 * NO delete-ish ids, NO edit.undo/edit.redo, NO render/export ids.
 */
const REVERSIBLE_AUTO_COMMAND_NAMES = [
  "prop.set",
  "layer.rename",
  "text.insert",
  "layer.newText",
  "prop.addKey",
  "anim.applyPreset",
  "anim.applyBuiltinPreset",
  "effect.apply",
  "layer.setBlendMode",
] as const;

/**
 * REVERSIBLE_AUTO_COMMANDS is DERIVED from curated-registry presence: an id
 * that ever leaves AGENT_COMMAND_IDS drops out here too (fail-closed — the
 * affected plans simply stop auto-applying). The test suite pins all nine
 * names so registry drift fails loudly instead of silently shrinking.
 */
export const REVERSIBLE_AUTO_COMMANDS: ReadonlySet<string> = new Set(
  REVERSIBLE_AUTO_COMMAND_NAMES.filter((id) =>
    (AGENT_COMMAND_IDS as readonly string[]).includes(id),
  ),
);

/** §7.3 intent gate (contracts edit-plan.ts owns the vocabulary). */
const AUTO_APPLYABLE_INTENT_SET: ReadonlySet<PlanIntent> = new Set(
  AUTO_APPLYABLE_INTENTS as readonly PlanIntent[],
);

// ---------------------------------------------------------------------------
// Verdict types
// ---------------------------------------------------------------------------

/** The two §7.3 verdicts: "auto" arms the card, "propose" leaves it manual. */
export type AutoApplyMode = "auto" | "propose";

/**
 * Stable, typed verdict reasons (law #1: codes only — never stack traces,
 * absolute paths or internal ids). Human-readable copy lives in
 * {@link AUTO_APPLY_REASON_MESSAGES}; the wire carries the code and clients
 * own their copy (the M5-G local-duplication precedent for web boundaries).
 */
export type AutoApplyReason =
  | "eligible"
  | "setting-disabled"
  | "setting-unavailable"
  | "compile-failed"
  | "risk-not-low"
  | "approval-required"
  | "intent-not-auto-applyable"
  | "command-not-reversible"
  | "credits-above-ceiling"
  | "too-many-steps";

/** Every reason that yields `mode: "propose"`. */
export type AutoApplyProposeReason = Exclude<AutoApplyReason, "eligible">;

/** Typed verdict: `{mode, reason}` (see the rules in the file header). */
export type AutoApplyDecision =
  | { readonly mode: "auto"; readonly reason: "eligible" }
  | { readonly mode: "propose"; readonly reason: AutoApplyProposeReason };

/**
 * Human-readable copy per reason (law #1: no internals, user-safe). Exported
 * for tests, logs and any server-side surface that wants the words.
 */
export const AUTO_APPLY_REASON_MESSAGES: Readonly<Record<AutoApplyReason, string>> = {
  eligible: "This plan qualifies for auto-apply.",
  "setting-disabled": "Auto-apply is off for your account — review and apply it yourself.",
  "setting-unavailable": "Your auto-apply setting couldn't be read, so nothing applies automatically.",
  "compile-failed": "The plan didn't finish compiling, so there is nothing safe to auto-apply.",
  "risk-not-low": "Auto-apply only covers low-risk plans — this one needs your review.",
  "approval-required": "This plan asks for your approval, so it waits for you.",
  "intent-not-auto-applyable": "Only edits, styling and animation auto-apply; this plan does more than that.",
  "command-not-reversible": "This plan uses commands outside the reversible auto-apply set.",
  "credits-above-ceiling": "This plan's estimated cost is above the auto-apply limit.",
  "too-many-steps": "This plan doesn't fit the auto-apply size range.",
};

/** Human-readable copy for a verdict reason (never throws). */
export function describeAutoApplyReason(reason: AutoApplyReason): string {
  return AUTO_APPLY_REASON_MESSAGES[reason];
}

/**
 * The verdict used when the per-user setting cannot be READ (settings repo
 * absent in a test boot, or the read threw — e.g. the table hasn't landed
 * yet): always propose, never a crash (the wiring fallback in routes/chat.ts).
 */
export const AUTO_APPLY_SETTING_UNAVAILABLE: AutoApplyDecision = Object.freeze({
  mode: "propose",
  reason: "setting-unavailable",
});

// ---------------------------------------------------------------------------
// The decision (PURE — no IO)
// ---------------------------------------------------------------------------

function propose(reason: AutoApplyProposeReason): AutoApplyDecision {
  return { mode: "propose", reason };
}

/**
 * The §7.3 auto-apply decision for one compiled plan. Pure and total: never
 * throws, never mutates its inputs, always answers `{mode, reason}`.
 *
 * Every `mode: "auto"` answer means ALL of: the user opted in, the plan
 * compiled, the SERVER-recomputed risk is low, no approval is required, the
 * intent is an in-place edit/style/animate, every compiled command is in the
 * reversible subset, the server credit estimate is within the ceiling and the
 * batch is small. Anything else proposes with the first-failing reason.
 */
export function autoApplyDecision(input: {
  readonly plan: Readonly<EditPlan>;
  readonly compiled: CompilePlanResult;
  readonly userAutoApplyEnabled: boolean;
}): AutoApplyDecision {
  // 1. Off by default (BUILD_PLAN §M5.6, §7.3): the per-user setting gates
  //    everything, so it is checked first — even a perfect plan proposes.
  if (input.userAutoApplyEnabled !== true) return propose("setting-disabled");

  // 2. No compiled batch ⇒ nothing safe to auto-apply (display-only plan).
  if (!input.compiled.ok) return propose("compile-failed");

  // 3. SERVER-recomputed risk only — never the model's plan.risk.
  if (input.compiled.risk !== "low") return propose("risk-not-low");

  // 4. The model itself flagged approval; the checkbox always wins.
  if (input.plan.requiresApproval) return propose("approval-required");

  // 5. Intent gate (contracts AUTO_APPLYABLE_INTENTS: edit|style|animate).
  if (!AUTO_APPLYABLE_INTENT_SET.has(input.plan.intent)) {
    return propose("intent-not-auto-applyable");
  }

  // 6. Reversible commands only — own-property Set membership (a hostile
  //    "__proto__"-style id can never resolve through the prototype chain).
  const steps = input.compiled.batch.steps;
  for (const step of steps) {
    if (!REVERSIBLE_AUTO_COMMANDS.has(step.command)) {
      return propose("command-not-reversible");
    }
  }

  // 7. Low-cost ceiling on the SERVER-recomputed estimate (non-finite and
  //    negative values fail closed too — hostile compile results).
  const credits = input.compiled.estimatedCredits;
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    credits < 0 ||
    credits > AUTO_APPLY_MAX_CREDITS
  ) {
    return propose("credits-above-ceiling");
  }

  // 8. Small batches only. Zero steps is a malformed compile result — the
  //    compiler's own contract is ≥ 1 — and lands here fail-closed.
  if (steps.length < 1 || steps.length > AUTO_APPLY_MAX_STEPS) {
    return propose("too-many-steps");
  }

  return { mode: "auto", reason: "eligible" };
}
