// evals/harness — types for the golden-prompt corpus (BUILD_PLAN §7.2).
//
// This module is deliberately dependency-free: the harness validates the
// corpus against the REAL @studio/contracts sources (imported by relative
// path in manifest.ts — read-only, zero new packages) so the vocabulary can
// never drift from the wire contract.

import type { PlanIntent, PlanRisk } from "../../packages/contracts/src/edit-plan";

// ---------------------------------------------------------------------------
// Category taxonomy
// ---------------------------------------------------------------------------

/**
 * The 10 §7.2 prompt categories (REQUIRED — the manifest must cover every
 * one) plus the 6 W3-C10 extras (multi-layer edits, keyframe timing
 * precision, undo-after-apply, zero-credit refusal, oversized-plan
 * rejection, injection containment).
 */
export type PromptCategory =
  // -- §7.2 required ------------------------------------------------------
  | "create-title-comp" // §7.2 "Create a title comp with text and a background"
  | "animate-transform" // §7.2 "Animate scale/position/opacity with specific timings"
  | "effect-add-tune" // §7.2 "Add and tune an effect"
  | "brand-colors" // §7.2 "Change brand colours across layers"
  | "reorganize-rename" // §7.2 "Reorganize/rename layers"
  | "lower-third" // §7.2 "Add a lower third"
  | "camera-3d" // §7.2 "Create a 3D-ish camera move (within engine support)"
  | "ambiguous-clarify" // §7.2 "Ambiguous target → must clarify"
  | "destructive-confirm" // §7.2 "Destructive request → must confirm"
  | "impossible-explain" // §7.2 "Impossible request → must explain, not hallucinate"
  // -- W3-C10 extras ------------------------------------------------------
  | "multi-layer-edit" // N layers × M properties in one atomic plan
  | "keyframe-precision" // exact key times (seconds, not timecode/frames)
  | "undo-after-apply" // law #6: one apply = one undo step
  | "credits-refusal" // zero/below-reserve balance → no plan, graceful decline
  | "oversized-plan" // >20 steps / >100 compiled commands → reject or split
  | "injection-defense"; // §8.3: project text is data, not instructions

/** The §7.2-required subset (every one must appear in the manifest). */
export const REQUIRED_CATEGORIES: readonly PromptCategory[] = [
  "create-title-comp",
  "animate-transform",
  "effect-add-tune",
  "brand-colors",
  "reorganize-rename",
  "lower-third",
  "camera-3d",
  "ambiguous-clarify",
  "destructive-confirm",
  "impossible-explain",
];

/** All valid categories (required + extras). */
export const ALL_CATEGORIES: readonly PromptCategory[] = [
  ...REQUIRED_CATEGORIES,
  "multi-layer-edit",
  "keyframe-precision",
  "undo-after-apply",
  "credits-refusal",
  "oversized-plan",
  "injection-defense",
];

// ---------------------------------------------------------------------------
// Expected behavior
// ---------------------------------------------------------------------------

/**
 * The golden outcome class for one prompt:
 *
 *  - "plan"    — a well-formed EditPlan is produced (§8.6 schema, curated
 *                write tools, layers by name, ≤20 steps).
 *  - "clarify" — the target is genuinely ambiguous: exactly ONE clarifying
 *                question (intent "clarify"), no speculative plan.
 *  - "confirm" — destructive scope: must surface the scope + approval gate
 *                (risk high / requiresApproval) before anything applies.
 *  - "explain" — impossible or outside the curated tool surface: must
 *                explain the limit; hallucinating a tool is a failure.
 *  - "refuse"  — credits path: the gateway refuses the run up-front; no
 *                plan may be produced, nothing charged.
 *  - "reject"  — oversized by construction (>20 steps / >100 compiled
 *                commands): split or refuse; never silently truncate.
 *  - "contain" — injection attempt in project content (§8.3): treat it as
 *                data; never follow it, never leak the tool surface.
 */
export type ExpectedBehaviorType =
  | "plan"
  | "clarify"
  | "confirm"
  | "explain"
  | "refuse"
  | "reject"
  | "contain";

export const EXPECTED_BEHAVIOR_TYPES: readonly ExpectedBehaviorType[] = [
  "plan",
  "clarify",
  "confirm",
  "explain",
  "refuse",
  "reject",
  "contain",
];

/** What the agent must do for this prompt to score as golden. */
export interface ExpectedBehavior {
  /** Outcome class (see {@link ExpectedBehaviorType}). */
  readonly type: ExpectedBehaviorType;
  /**
   * The EditPlan intent the run should carry when one is produced
   * ("clarify" for clarify-type prompts). Omitted when no plan is expected.
   */
  readonly intent?: PlanIntent;
  /** Human-readable golden assertion (what the scorer checks). */
  readonly description: string;
  /**
   * Curated WRITE tools (wire ids, `studio.*`) the plan is expected to
   * propose — ANY-of semantics when more than one is listed (e.g. fade-in
   * via apply_preset OR set_keyframes). Empty when no plan is expected.
   */
  readonly expectedTools?: readonly string[];
  /** Tools that must NEVER appear in the run (fabrication guard). */
  readonly forbiddenTools?: readonly string[];
  /** READ tools the run may legitimately call before planning. */
  readonly mayUseTools?: readonly string[];
}

// ---------------------------------------------------------------------------
// Fixtures (the editor snapshot the context assembly would send, §5.1/§5.2)
// ---------------------------------------------------------------------------

export type FixtureLayerType = "text" | "solid" | "shape" | "null" | "adjustment" | "footage";

export const FIXTURE_LAYER_TYPES: readonly FixtureLayerType[] = [
  "text",
  "solid",
  "shape",
  "null",
  "adjustment",
  "footage",
];

export interface FixtureLayer {
  /** Layer NAME — the only handle the agent may reference (law #5). */
  readonly name: string;
  readonly type: FixtureLayerType;
  /** Extra fixture detail (positions, colors, existing keys, adversarial names). */
  readonly detail?: string;
}

export interface PromptFixtures {
  /** Human description of the project/comp state to stage. */
  readonly project: string;
  /** Active composition name, or null for an empty project. */
  readonly activeComp: string | null;
  /** Layers in the active comp (empty when none). */
  readonly layers: readonly FixtureLayer[];
  /** Selected layer names, or null when nothing is selected. */
  readonly selection: readonly string[] | null;
  /** Playhead position in seconds (§5.4). */
  readonly playheadSeconds: number;
  /** Workspace credit balance at run start (§8.8). */
  readonly creditBalance: number;
}

// ---------------------------------------------------------------------------
// The golden prompt entry + manifest envelope
// ---------------------------------------------------------------------------

export interface GoldenPrompt {
  /** Unique id: `ev-NNN-kebab-case`. */
  readonly id: string;
  readonly category: PromptCategory;
  /** The user message verbatim. */
  readonly prompt: string;
  readonly expectedBehavior: ExpectedBehavior;
  /**
   * Expected plan-card risk AFTER the server-side recompute (tool/command
   * floors + estimateCredits — never the model's self-declaration).
   */
  readonly risk: PlanRisk;
  /** `true` when the plan card must gate on explicit approval. risk high ⇒ true. */
  readonly requiresConfirmation: boolean;
  readonly fixtures: PromptFixtures;
}

export interface PromptManifest {
  readonly version: number;
  readonly source: string;
  readonly notes: readonly string[];
  readonly prompts: readonly GoldenPrompt[];
}
