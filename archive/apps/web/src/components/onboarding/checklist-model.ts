// components/onboarding/checklist-model.ts — pure model for the 5-minute
// first-success checklist (§19 Phase 4 onboarding; §20 #1 signup→export path).
//
// Step 0 is the trial-credit grant: it is verified with a GET /v1/credits
// check (see trial-grant.ts), not persisted. "Create workspace" is likewise
// runtime-verified (the user is already inside a workspace). The three user
// actions (pick-template, first-prompt, export-design) persist in localStorage
// so the checklist survives reloads and cross-tab navigation.
//
// Pure module: no React, no DOM, no fetch — everything is injected so the
// logic stays table-testable in a node environment.

export const CHECKLIST_STORAGE_KEY = "onboarding.checklist.v1";

/** Written once, the first time all five steps are complete. */
export const CHECKLIST_CELEBRATED_KEY = "onboarding.checklist.celebrated.v1";

export const TRIAL_CREDITS = 30; // §19 Phase 1: "Trial credits (30)"

export const CHECKLIST_STEP_IDS = [
  "trial-grant",
  "create-workspace",
  "pick-template",
  "first-prompt",
  "export-design",
] as const;

export type ChecklistStepId = (typeof CHECKLIST_STEP_IDS)[number];

/** Completion flags for every step, including the two runtime-checked ones. */
export type ChecklistSteps = Record<ChecklistStepId, boolean>;

export interface ChecklistStepMeta {
  readonly id: ChecklistStepId;
  readonly title: string;
  readonly detail: string;
  /** Where the user goes to do this step; empty string = no navigation. */
  readonly href: string;
  /** Label for the call-to-action link (unused when href is empty). */
  readonly cta: string;
  /** True when the step completes on its own (no user action needed). */
  readonly automatic: boolean;
}

export const CHECKLIST_STEPS: readonly ChecklistStepMeta[] = [
  {
    id: "trial-grant",
    title: "Trial credits added",
    detail: `Your sign-up grant of ${TRIAL_CREDITS} credits is live and ready to spend.`,
    href: "",
    cta: "",
    automatic: true,
  },
  {
    id: "create-workspace",
    title: "Create a workspace",
    detail: "Your projects, assets and brand tokens live here.",
    href: "/dashboard",
    cta: "Go to dashboard",
    automatic: true,
  },
  {
    id: "pick-template",
    title: "Pick a template",
    detail: "Start from a layout that already knows good design.",
    href: "/templates",
    cta: "Browse templates",
    automatic: false,
  },
  {
    id: "first-prompt",
    title: "Write your first prompt",
    detail: "One sentence is enough — the agent plans the whole layout.",
    href: "/compose",
    cta: "Open the composer",
    automatic: false,
  },
  {
    id: "export-design",
    title: "Export your design",
    detail: "A PNG for posting, plus the layered file for later edits.",
    href: "/documents",
    cta: "Your documents",
    automatic: false,
  },
];

export function emptyChecklistSteps(): ChecklistSteps {
  return {
    "trial-grant": false,
    "create-workspace": false,
    "pick-template": false,
    "first-prompt": false,
    "export-design": false,
  };
}

/**
 * Parse a persisted checklist blob. Always returns a full step map: junk,
 * stale or empty payloads degrade to "nothing done yet" instead of throwing.
 */
export function parseChecklistSteps(raw: string | null): ChecklistSteps {
  const steps = emptyChecklistSteps();
  if (raw === null) return steps;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return steps;
    }
    const source = parsed as Record<string, unknown>;
    for (const id of CHECKLIST_STEP_IDS) {
      const value = source[id];
      if (typeof value === "boolean") steps[id] = value;
    }
    return steps;
  } catch {
    return steps;
  }
}

/** Serialize only the known step ids (forward-compatible: extra keys dropped). */
export function serializeChecklistSteps(steps: ChecklistSteps): string {
  const out: Partial<ChecklistSteps> = {};
  for (const id of CHECKLIST_STEP_IDS) {
    if (steps[id]) out[id] = true;
  }
  return JSON.stringify(out);
}

/** Copy-on-write step flip (never mutates the input). */
export function markChecklistStep(
  steps: ChecklistSteps,
  id: ChecklistStepId,
  value = true,
): ChecklistSteps {
  return { ...steps, [id]: value };
}

/** Merge injected completion overrides; unknown keys and non-booleans are dropped. */
export function applyChecklistOverrides(
  base: ChecklistSteps,
  overrides: Readonly<Record<string, unknown>> | undefined,
): ChecklistSteps {
  if (!overrides) return base;
  const next = { ...base };
  for (const id of CHECKLIST_STEP_IDS) {
    const value = overrides[id];
    if (typeof value === "boolean") next[id] = value;
  }
  return next;
}

export function countCompletedSteps(steps: ChecklistSteps): number {
  let done = 0;
  for (const id of CHECKLIST_STEP_IDS) if (steps[id]) done += 1;
  return done;
}

export interface ChecklistProgress {
  readonly done: number;
  readonly total: number;
  readonly ratio: number;
}

export function checklistProgress(steps: ChecklistSteps): ChecklistProgress {
  const done = countCompletedSteps(steps);
  const total = CHECKLIST_STEP_IDS.length;
  return { done, total, ratio: total === 0 ? 0 : done / total };
}

/** The first incomplete step — the row the UI should highlight. */
export function nextChecklistStep(
  steps: ChecklistSteps,
): ChecklistStepMeta | null {
  return CHECKLIST_STEPS.find((step) => !steps[step.id]) ?? null;
}

export function isChecklistComplete(steps: ChecklistSteps): boolean {
  return countCompletedSteps(steps) === CHECKLIST_STEP_IDS.length;
}

export function checklistStepMeta(
  id: ChecklistStepId,
): ChecklistStepMeta | undefined {
  return CHECKLIST_STEPS.find((step) => step.id === id);
}
