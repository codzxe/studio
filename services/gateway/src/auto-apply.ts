// @studio/gateway — the SERVER-SIDE AUTO-APPLY POLICY (BUILD_PLAN §M5 task 6,
// EDITOR_CHAT_UX §7.3; round-10 v2).
//
// v2 semantics — ROUND-10 PRODUCT RULING (supersedes the D-22 "UI guidance
// only" candidate ruling): when the verdict is `mode: "auto"`, the CLIENT
// EXECUTES the plan automatically at run completion (resolve → one atomic
// engine.batch → saveNow("agent-apply") → applyRun). The plan card folds to
// its applied state with Undo as the one-click escape hatch (one apply = one
// undo step = one version). The product owner ordered this directly: an
// agent that only writes plans and changes nothing is useless. This module
// still only DECIDES; it never applies anything — execution stays on the
// client because the engine (wasm) lives in the browser.
//
// v2 envelope (what actually lands automatically vs. v1's tiny box):
//   - `create` IS auto-applyable (additive: comps/layers/keyframes; the
//     §6.2 ladder calls medium "many layers/effects" — that is normal work,
//     not danger),
//   - low AND medium risk pass (HIGH — delete, replace footage, render —
//     still proposes; delete-ish ids can never be in an auto batch anyway),
//   - `comp.new` joined the reversible command set,
//   - ceilings raised to the size real motion-graphics work needs.
// The hard safety wall is unchanged: every compiled command must pass the
// REVERSIBLE classification — no delete/remove, no effect.remove, no
// edit.undo/redo, no render/export or render-queue work — and the whole batch
// is one atomic undo step. Round-12 ("Tool catalog v3") widened the compiled
// surface: engine_commands batches may contain any ALLOWED engine catalog id,
// and the run_script / add_asset translations emit the client-special
// script.run / asset.importSvg steps. The classification below therefore
// derives from the contracts ALLOWED catalog (see isReversibleAutoCommand)
// while keeping every §7.3 ban intact.
//
// PURITY: no IO, no clocks, no randomness — the decision is a pure function of
// (plan, compiled result, user setting), so the entire decision matrix is
// unit-testable without a database. The wiring (routes/chat.ts) reads the
// per-user setting through the pinned M6-D seam
// (`repos.settings.getUserAutoApply(userId): Promise<boolean>`, userSettings
// table, autoApplyEnabled) and attaches the verdict to the `{type: "plan"}`
// SSE event (contracts PLAN_EVENT_SCHEMA.autoApply).
//
// SERVER VALUES ONLY: the rules are evaluated against the plan-compiler's
// RECOMPUTED risk/estimatedCredits (plan-compiler.ts), never the model's
// self-declared plan.risk/plan.estimatedCredits — a plan that lies low still
// gets judged by what it actually compiles to.
//
// Defense-in-depth — EVERY rule must hold for `mode: "auto"`, checked in this
// order (the first failure is the returned reason):
//   1. user setting enabled                      → "setting-disabled"
//   2. compiled.ok (a compiled batch exists)      → "compile-failed"
//   3. server-recomputed risk !== "high"         → "risk-too-high"
//   4. !plan.requiresApproval                    → "approval-required"
//   5. plan.intent ∈ AUTO_APPLYABLE_INTENTS      → "intent-not-auto-applyable"
//      (create | edit | style | animate — organize is structural review,
//       render is spend-heavy export, clarify/explain change nothing;
//       contracts edit-plan.ts owns the vocabulary)
//   6. every compiled batch command passes the REVERSIBLE → "command-not-reversible"
//      classification (below — curated ten, client-special apply-seam steps,
//      or ALLOWED engine catalog commands; never history, delete-ish,
//      render-queue or anything outside the allowed catalog)
//   7. server-recomputed estimatedCredits ≤ ceiling → "credits-above-ceiling"
//   8. compiled batch step count ≤ AUTO_APPLY_MAX_STEPS → "too-many-steps"
//      (a compiled-ok batch with ZERO steps also lands here — fail-closed: a
//      malformed compile result never yields "auto")

import {
  AGENT_COMMAND_IDS,
  AUTO_APPLYABLE_INTENTS,
  type EditPlan,
  type PlanIntent,
  isAllowedEngineCommand,
} from "@studio/contracts";

import type { CompilePlanResult } from "./plan-compiler.js";

// ---------------------------------------------------------------------------
// Bounds (EDITOR_CHAT_UX §7.3)
// ---------------------------------------------------------------------------

/**
 * §7.3 v2: at most 60 compiled batch steps auto-apply — the size real
 * motion-graphics work needs (a titled comp with per-layer fades is
 * already 15-30 compiled steps via the keyframe cross-products), while the
 * §8.5 hard cap is 100 and auto-apply stays deliberately under it.
 */
export const AUTO_APPLY_MAX_STEPS = 60;

/**
 * §7.3 v2 credit ceiling: 16 — covers every plan the schema can produce at
 * low/medium risk (20 plan steps × 0.5 + base × 1.25 medium multiplier ≈
 * 13.75 worst case) while staying an order of magnitude under render spends
 * (renders estimate 12+ per the M5 goldens and never reach this rule — the
 * intent gate stops them first).
 */
export const AUTO_APPLY_MAX_CREDITS = 16;

/**
 * The reversible auto-apply command subset — hardcoded, deliberately small.
 * Every id is an additive or in-place, non-destructive mutation whose whole
 * effect folds into the batch's single `edit.undo` step (§8.5 /
 * AGENT_COMMAND_UNDOABLE's batch-level heuristic). `comp.new` creates a
 * composition (additive — round-10 v2: composition creation IS the product's
 * core "do the work" path). NO delete-ish ids, NO effect.remove, NO
 * edit.undo/edit.redo, NO render/export ids.
 */
const REVERSIBLE_AUTO_COMMAND_NAMES = [
  "comp.new",
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

// ---------------------------------------------------------------------------
// Round-12 ("Tool catalog v3") — the widened REVERSIBLE classification
// ---------------------------------------------------------------------------

/**
 * CLIENT-SPECIAL compiled steps emitted by the round-12 translations
 * (plan-compiler.ts): `script.run` (the engine refuses it inside engine.batch
 * — NOT_IN_BATCH — so the client apply seam executes it via bridge.execute
 * with ONE undo group) and `asset.importSvg` (no direct engine id; the client
 * imports the inline SVG string, folding into the batch's one undo). Both
 * are additive and undoable, emitted ONLY by the guarded run_script /
 * add_asset translations — the model can never inject them directly
 * (engine_commands rejects script.run as a code-exec DENIED id and
 * asset.importSvg is not an engine id at all).
 */
const CLIENT_SPECIAL_AUTO_COMMANDS: ReadonlySet<string> = new Set([
  "script.run",
  "asset.importSvg",
]);

/** §7.3 ban kept verbatim through the widening: history commands never
 * auto-apply — an auto-applied plan must never silently revert project
 * state (both ids ARE allowed engine catalog commands; the ban is policy). */
const AUTO_NEVER_REVERSIBLE: ReadonlySet<string> = new Set(["edit.undo", "edit.redo"]);

/** The render-queue CATEGORY prefix: renderQueue.* ids are ALLOWED engine
 * catalog commands (renderQueue.render, …) but spend-heavy output work —
 * never auto (§7.3 "no render/export"). The catalog's category equals the
 * id prefix, so the prefix test IS the category test. */
const RENDER_QUEUE_AUTO_DENY_PREFIX = "renderQueue.";

/** Delete-ish id names keep the §7.3 hard wall ("no delete/remove") even
 * though the catalog allows them (effect.remove, text.delete,
 * camera.deletePoints…): an auto-applied batch never destroys content. */
const DELETE_ISH_AUTO_COMMAND = /(?:^|\.)(?:delete|remove|purge)/;

/**
 * The round-12 REVERSIBLE classification for ONE compiled batch command
 * (rule 6). Ordered, own-property Set membership first (a hostile
 * "__proto__"-style id can never resolve through the prototype chain):
 *
 *   1. the curated ten (REVERSIBLE_AUTO_COMMANDS) — unchanged;
 *   2. the CLIENT-SPECIAL apply-seam steps (script.run / asset.importSvg) —
 *      additive, one undo each;
 *   3. history commands NEVER (§7.3 ban);
 *   4. ids outside the ALLOWED engine catalog NEVER — unknown, and every
 *      deny-tagged class (destructive / project-destructive, filesystem,
 *      code-exec, render-output, render-queue-tagged, app-chrome, path-param)
 *      plus meta transport ids (engine.batch) all land here, fail-closed;
 *   5. the render-queue category (renderQueue.*) NEVER (§7.3 "no render");
 *   6. delete/remove/purge-ish NAMES never (§7.3 hard wall);
 *   7. DEFAULT: an ALLOWED engine catalog id (the studio.engine_commands
 *      widening) IS reversible — every engine.batch command folds into the
 *      batch's single edit.undo step, and the catalog already excludes every
 *      denied class (D-28: the reversible wall is the safety).
 *
 * Pure, total, deterministic — the decision stays a pure function of its
 * inputs (no IO, no clocks, law #1).
 */
export function isReversibleAutoCommand(id: string): boolean {
  if (REVERSIBLE_AUTO_COMMANDS.has(id)) return true;
  if (CLIENT_SPECIAL_AUTO_COMMANDS.has(id)) return true;
  if (AUTO_NEVER_REVERSIBLE.has(id)) return false;
  if (!isAllowedEngineCommand(id)) return false;
  if (id.startsWith(RENDER_QUEUE_AUTO_DENY_PREFIX)) return false;
  if (DELETE_ISH_AUTO_COMMAND.test(id)) return false;
  return true; // allowed engine command ⇒ reversible by default (round-12)
}

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
  | "risk-too-high"
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
  "setting-unavailable":
    "Your auto-apply setting couldn't be read, so nothing applies automatically.",
  "compile-failed": "The plan didn't finish compiling, so there is nothing safe to auto-apply.",
  "risk-too-high":
    "This plan deletes, replaces or exports material — it needs your explicit review.",
  "approval-required": "This plan asks for your approval, so it waits for you.",
  "intent-not-auto-applyable":
    "Only creating, editing, styling and animation auto-apply; this plan does more than that.",
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
 * The §7.3 v2 auto-apply decision for one compiled plan. Pure and total: never
 * throws, never mutates its inputs, always answers `{mode, reason}`.
 *
 * Every `mode: "auto"` answer means ALL of: the user has it on, the plan
 * compiled, the SERVER-recomputed risk is not high (delete/replace/render
 * wait for review), no approval is required, the intent is create/edit/style/
 * animate, every compiled command is in the reversible subset, the server
 * credit estimate is within the ceiling and the batch is a reasonable size.
 * Anything else proposes with the first-failing reason.
 */
export function autoApplyDecision(input: {
  readonly plan: Readonly<EditPlan>;
  readonly compiled: CompilePlanResult;
  readonly userAutoApplyEnabled: boolean;
}): AutoApplyDecision {
  // 1. The per-user setting gates everything (checked first — even a perfect
  //    plan proposes when the user wants to review everything themselves).
  if (input.userAutoApplyEnabled !== true) return propose("setting-disabled");

  // 2. No compiled batch ⇒ nothing safe to auto-apply (display-only plan).
  if (!input.compiled.ok) return propose("compile-failed");

  // 3. SERVER-recomputed risk only — never the model's plan.risk. v2: HIGH
  //    (delete, replace footage, render/export) still proposes; low AND
  //    medium ("many layers/effects" on the §6.2 ladder — normal work) pass —
  //    the reversible-command gate below is the actual hard wall.
  if (input.compiled.risk === "high") return propose("risk-too-high");

  // 4. The model itself flagged approval; the checkbox always wins.
  if (input.plan.requiresApproval) return propose("approval-required");

  // 5. Intent gate (contracts AUTO_APPLYABLE_INTENTS: edit|style|animate).
  if (!AUTO_APPLYABLE_INTENT_SET.has(input.plan.intent)) {
    return propose("intent-not-auto-applyable");
  }

  // 6. Reversible commands only — the round-12 classification (curated ten,
  //    client-special apply-seam steps, or ALLOWED engine catalog commands;
  //    never history, delete-ish, render-queue or non-catalog ids — see
  //    isReversibleAutoCommand). Own-property Set membership throughout: a
  //    hostile "__proto__"-style id can never resolve through the chain.
  const steps = input.compiled.batch.steps;
  for (const step of steps) {
    if (!isReversibleAutoCommand(step.command)) {
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
