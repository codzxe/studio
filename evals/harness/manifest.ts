// evals/harness — manifest loader + schema-integrity validation.
//
// Loads prompts/manifest.json and validates every entry against the REAL
// workspace contracts (read-only relative imports — no new dependencies):
//   * tool ids          ← packages/contracts/src/tools.ts TOOL_IDS (5 read + 8 write)
//   * write-tool ids    ← packages/contracts/src/write-tools.ts WRITE_TOOL_IDS
//   * intents / risks   ← packages/contracts/src/edit-plan.ts (§8.6)
//   * credits math      ← packages/contracts/src/edit-plan.ts estimateCredits / reserveFor
//
// If the wire contract ever widens (e.g. a camera or arrange write tool
// lands), the premise guards below flip red and the affected manifest
// entries must be re-authored — that is the point: the corpus cannot rot
// silently.

import {
  PLAN_INTENT_SCHEMA,
  PLAN_RISK_SCHEMA,
  estimateCredits,
  reserveFor,
} from "../../packages/contracts/src/edit-plan";
import { TOOL_IDS } from "../../packages/contracts/src/tools";
import { WRITE_TOOL_IDS, studioWriteToolId } from "../../packages/contracts/src/write-tools";
import editPlan from "../prompts/manifest.json";

import {
  ALL_CATEGORIES,
  EXPECTED_BEHAVIOR_TYPES,
  FIXTURE_LAYER_TYPES,
  type GoldenPrompt,
  type PromptCategory,
  type PromptManifest,
} from "./types";

/** The parsed manifest (typed view over the JSON import). */
export const MANIFEST: PromptManifest = editPlan as PromptManifest;

/** All prompts, in manifest order. */
export const PROMPTS: readonly GoldenPrompt[] = MANIFEST.prompts;

// ---------------------------------------------------------------------------
// Vocabulary (resolved from the REAL contracts — never a frozen copy)
// ---------------------------------------------------------------------------

/** All 13 tool ids the runner registers on the provider wire. */
export const TOOL_ID_SET: ReadonlySet<string> = new Set(TOOL_IDS);

/** The 8 curated write tools in wire form (`studio.create_text`, …). */
export const WRITE_TOOL_ID_SET: ReadonlySet<string> = new Set(
  WRITE_TOOL_IDS.map((id) => studioWriteToolId(id)),
);

/** The 5 read tools in wire form. */
export const READ_TOOL_ID_SET: ReadonlySet<string> = new Set(
  TOOL_IDS.filter((id) => !WRITE_TOOL_ID_SET.has(id)),
);

export const INTENT_SET: ReadonlySet<string> = new Set(PLAN_INTENT_SCHEMA.options);
export const RISK_SET: ReadonlySet<string> = new Set(PLAN_RISK_SCHEMA.options);

// ---------------------------------------------------------------------------
// Integrity validation
// ---------------------------------------------------------------------------

export interface IntegrityIssue {
  readonly promptId: string;
  readonly field: string;
  readonly problem: string;
}

const ID_PATTERN = /^ev-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate the whole manifest. Returns one issue per problem found (empty
 * array = the corpus is schema-clean). Pure — safe to call from tests.
 */
export function validateManifest(): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const push = (promptId: string, field: string, problem: string): void => {
    issues.push({ promptId, field, problem });
  };

  const seenIds = new Set<string>();
  for (const prompt of PROMPTS) {
    const id = prompt.id ?? "<missing>";

    // -- id ---------------------------------------------------------------
    if (typeof prompt.id !== "string" || !ID_PATTERN.test(prompt.id)) {
      push(id, "id", `id must match ${ID_PATTERN.toString()}`);
    }
    if (seenIds.has(prompt.id)) push(id, "id", "duplicate id");
    seenIds.add(prompt.id);

    // -- category ----------------------------------------------------------
    if (!ALL_CATEGORIES.includes(prompt.category as PromptCategory)) {
      push(id, "category", `"${prompt.category}" is not a known category`);
    }

    // -- prompt text ---------------------------------------------------------
    if (typeof prompt.prompt !== "string" || prompt.prompt.trim().length < 8) {
      push(id, "prompt", "prompt text must be a non-trivial string");
    }

    // -- expected behavior ---------------------------------------------------
    const behavior = prompt.expectedBehavior;
    if (behavior === undefined || behavior === null) {
      push(id, "expectedBehavior", "missing");
      continue;
    }
    if (!EXPECTED_BEHAVIOR_TYPES.includes(behavior.type)) {
      push(id, "expectedBehavior.type", `"${behavior.type}" is not a known behavior type`);
    }
    if (typeof behavior.description !== "string" || behavior.description.trim().length < 20) {
      push(id, "expectedBehavior.description", "must be a meaningful assertion");
    }
    if (behavior.intent !== undefined && !INTENT_SET.has(behavior.intent)) {
      push(id, "expectedBehavior.intent", `"${behavior.intent}" is not a §8.6 intent`);
    }
    if (
      behavior.type === "clarify" &&
      behavior.intent !== undefined &&
      behavior.intent !== "clarify"
    ) {
      push(id, "expectedBehavior.intent", 'clarify prompts must carry intent "clarify"');
    }
    if (behavior.type === "plan" && (behavior.expectedTools?.length ?? 0) === 0) {
      push(id, "expectedBehavior.expectedTools", 'type "plan" must name at least one write tool');
    }

    // Tool references resolve against the REAL catalog.
    for (const [field, tools] of [
      ["expectedTools", behavior.expectedTools],
      ["forbiddenTools", behavior.forbiddenTools],
      ["mayUseTools", behavior.mayUseTools],
    ] as const) {
      if (tools === undefined) continue;
      for (const tool of tools) {
        if (!TOOL_ID_SET.has(tool)) {
          push(id, `expectedBehavior.${field}`, `"${tool}" is not a registered tool id`);
        }
      }
    }
    // expectedTools are WRITE tools (plan steps carry write proposals only).
    if (behavior.expectedTools !== undefined) {
      for (const tool of behavior.expectedTools) {
        if (!WRITE_TOOL_ID_SET.has(tool)) {
          push(id, "expectedBehavior.expectedTools", `"${tool}" is not a write tool`);
        }
      }
    }
    // mayUseTools are READ tools (reads precede planning; writes are the plan).
    if (behavior.mayUseTools !== undefined) {
      for (const tool of behavior.mayUseTools) {
        if (!READ_TOOL_ID_SET.has(tool)) {
          push(id, "expectedBehavior.mayUseTools", `"${tool}" is not a read tool`);
        }
      }
    }

    // -- risk / confirmation --------------------------------------------------
    if (!RISK_SET.has(prompt.risk)) {
      push(id, "risk", `"${prompt.risk}" is not a §8.6 risk tier`);
    }
    if (prompt.risk === "high" && prompt.requiresConfirmation !== true) {
      push(id, "requiresConfirmation", "risk high must require confirmation");
    }
    if (prompt.risk !== "high" && prompt.requiresConfirmation === true) {
      // Allowed in principle (a medium plan may still gate) — but the corpus
      // keeps the invariant one-directional; flag it so entries stay honest.
      push(id, "requiresConfirmation", "confirmation gate without risk high — tighten the entry");
    }

    // -- fixtures -----------------------------------------------------------
    const fixtures = prompt.fixtures;
    if (fixtures === undefined || fixtures === null) {
      push(id, "fixtures", "missing");
      continue;
    }
    if (typeof fixtures.project !== "string" || fixtures.project.trim() === "") {
      push(id, "fixtures.project", "must describe the project state");
    }
    if (fixtures.activeComp !== null && typeof fixtures.activeComp !== "string") {
      push(id, "fixtures.activeComp", "must be a comp name or null");
    }
    if (!Array.isArray(fixtures.layers)) {
      push(id, "fixtures.layers", "must be an array");
    } else {
      const layerNames = new Set<string>();
      for (const layer of fixtures.layers) {
        if (typeof layer?.name !== "string" || layer.name.trim() === "") {
          push(id, "fixtures.layers", "every layer needs a name");
        }
        if (layerNames.has(layer.name)) {
          push(id, "fixtures.layers", `duplicate layer name "${layer.name}"`);
        }
        layerNames.add(layer.name);
        if (!FIXTURE_LAYER_TYPES.includes(layer.type)) {
          push(id, "fixtures.layers", `"${layer.type}" is not a fixture layer type`);
        }
      }
      if (fixtures.selection !== null) {
        if (!Array.isArray(fixtures.selection)) {
          push(id, "fixtures.selection", "must be an array of layer names or null");
        } else {
          for (const name of fixtures.selection) {
            if (!layerNames.has(name)) {
              push(id, "fixtures.selection", `"${name}" is not a fixture layer`);
            }
          }
        }
      }
    }
    if (typeof fixtures.playheadSeconds !== "number" || fixtures.playheadSeconds < 0) {
      push(id, "fixtures.playheadSeconds", "must be a non-negative number");
    }
    if (typeof fixtures.creditBalance !== "number" || fixtures.creditBalance < 0) {
      push(id, "fixtures.creditBalance", "must be a non-negative number");
    }
  }

  return issues;
}

/** Category → prompt count, across the whole manifest. */
export function countsByCategory(): Map<PromptCategory, number> {
  const counts = new Map<PromptCategory, number>();
  for (const prompt of PROMPTS) {
    counts.set(prompt.category, (counts.get(prompt.category) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Premise guards — the "explain"/"refuse" entries encode facts about the
// CURRENT tool surface + credit math. These guards pin those facts to the
// real contracts so the corpus is updated the day the surface widens.
// ---------------------------------------------------------------------------

/** Facts the manifest's explain/refuse entries rely on (all verified true). */
export function premiseFacts(): {
  readonly noCameraTool: boolean;
  readonly noArrangeTool: boolean;
  readonly noDeleteTool: boolean;
  readonly minPlanCredits: number;
  readonly minPlanReserve: number;
} {
  return {
    // No camera/arrange/delete surface anywhere in the curated write tools.
    noCameraTool: ![...WRITE_TOOL_ID_SET].some((id) => /camera/i.test(id)),
    noArrangeTool: ![...WRITE_TOOL_ID_SET].some((id) => /arrange|reorder/i.test(id)),
    noDeleteTool: ![...WRITE_TOOL_ID_SET].some((id) => /delete|remove/i.test(id)),
    // Smallest possible plan: 1 step, low risk → 1.5 credits, 1.8 reserved.
    minPlanCredits: estimateCredits({ risk: "low", steps: [{}] }),
    minPlanReserve: reserveFor(estimateCredits({ risk: "low", steps: [{}] })),
  };
}

/** Prompts whose fixture balance cannot fund even a minimal plan. */
export function unfundablePrompts(): readonly GoldenPrompt[] {
  const { minPlanReserve } = premiseFacts();
  return PROMPTS.filter((p) => p.fixtures.creditBalance < minPlanReserve);
}
