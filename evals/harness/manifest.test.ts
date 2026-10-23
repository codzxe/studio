// evals/harness — the §7.2 SCHEMA-INTEGRITY SUITE (runs green on-box, no
// network, no new dependencies; vitest resolves from the repo root).
//
// Layers (BUILD_PLAN §7.1 "Evals"):
//   1. corpus integrity  — manifest parses, ids unique, ≥30 prompts, all 10
//      §7.2 categories covered (+ extras), vocabulary valid against the REAL
//      contracts (drift-checked, never a frozen copy).
//   2. premise guards    — the explain/refuse entries encode facts about the
//      CURRENT tool surface + credit math; pinned here so the corpus is
//      re-authored the day the surface widens.
//   3. scoring stubs     — the six §7.2 dimensions behave deterministically
//      on synthetic transcripts; live scoring stays skip-guarded.

import { describe, expect, it, vi } from "vitest";

import {
  MANIFEST,
  PROMPTS,
  countsByCategory,
  premiseFacts,
  unfundablePrompts,
  validateManifest,
} from "./manifest";
import { WRITE_TOOL_ID_SET } from "./manifest";
import {
  type ObservedRun,
  aggregate,
  assertCorpusIntegrity,
  runLiveSuite,
  scoreRun,
} from "./score";
import { ALL_CATEGORIES, type GoldenPrompt, REQUIRED_CATEGORIES } from "./types";

// ---------------------------------------------------------------------------
// 1. Corpus integrity
// ---------------------------------------------------------------------------

describe("§7.2 golden prompt corpus — integrity", () => {
  it("loads and parses the manifest", () => {
    expect(MANIFEST.version).toBe(1);
    expect(Array.isArray(PROMPTS)).toBe(true);
    expect(PROMPTS.length).toBeGreaterThanOrEqual(30);
  });

  it("has zero schema-integrity issues (ids, categories, tools, risks, fixtures)", () => {
    const issues = validateManifest();
    expect(issues).toEqual([]);
  });

  it("has unique ids matching the ev-NNN-kebab grammar", () => {
    const ids = PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^ev-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("covers every §7.2-required category (plus the W3-C10 extras)", () => {
    const counts = countsByCategory();
    for (const category of REQUIRED_CATEGORIES) {
      expect(counts.get(category) ?? 0, `category "${category}"`).toBeGreaterThan(0);
    }
    // Every declared category is actually used — no dead taxonomy entries.
    for (const category of ALL_CATEGORIES) {
      expect(counts.has(category), `unused category "${category}"`).toBe(true);
    }
  });

  it("prompts are real user phrasing, not schema noise", () => {
    for (const prompt of PROMPTS) {
      expect(prompt.prompt.trim().length).toBeGreaterThan(8);
      expect(prompt.expectedBehavior.description.trim().length).toBeGreaterThan(20);
    }
  });

  it("expectedTools reference the REAL curated write tools (wire ids)", () => {
    for (const prompt of PROMPTS) {
      for (const tool of prompt.expectedBehavior.expectedTools ?? []) {
        expect(WRITE_TOOL_ID_SET.has(tool), `${prompt.id}: "${tool}"`).toBe(true);
      }
    }
  });

  it("risk high always requires confirmation", () => {
    const highRisk = PROMPTS.filter((p) => p.risk === "high");
    expect(highRisk.length).toBeGreaterThan(0); // the corpus exercises the gate
    for (const prompt of highRisk) {
      expect(prompt.requiresConfirmation).toBe(true);
    }
  });

  it("fixture selections reference staged layers", () => {
    for (const prompt of PROMPTS) {
      const names = new Set(prompt.fixtures.layers.map((layer) => layer.name));
      for (const selected of prompt.fixtures.selection ?? []) {
        expect(names.has(selected), `${prompt.id}: "${selected}"`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Premise guards (explain/refuse entries stay honest as the surface moves)
// ---------------------------------------------------------------------------

describe("§7.2 corpus — premise guards against the REAL contracts", () => {
  it("no camera / arrange / delete write tool exists (ev-015, ev-020, ev-024 premises)", () => {
    const facts = premiseFacts();
    expect(facts.noCameraTool).toBe(true);
    expect(facts.noArrangeTool).toBe(true);
    expect(facts.noDeleteTool).toBe(true);
  });

  it("a minimal plan costs 1.5 credits and reserves 1.8 (ev-036/ev-037 premises)", () => {
    const facts = premiseFacts();
    expect(facts.minPlanCredits).toBe(1.5);
    expect(facts.minPlanReserve).toBe(1.8);
  });

  it("exactly the credits-refusal prompts stage an unfundable balance", () => {
    const unfundable = unfundablePrompts();
    expect(unfundable.length).toBe(2);
    for (const prompt of unfundable) {
      expect(prompt.category).toBe("credits-refusal");
      expect(prompt.expectedBehavior.type).toBe("refuse");
    }
    // …and every other prompt CAN fund its plan (no accidental refusals).
    for (const prompt of PROMPTS) {
      if (prompt.category === "credits-refusal") continue;
      expect(prompt.fixtures.creditBalance).toBeGreaterThanOrEqual(premiseFacts().minPlanReserve);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Scoring stubs (pure, deterministic — the six §7.2 dimensions)
// ---------------------------------------------------------------------------

/** A golden plan run: everything the §7.2 targets ask for. */
function goldenPlanRun(promptId: string): ObservedRun {
  return {
    promptId,
    planEmitted: true,
    planSchemaValid: true,
    behaviorMatch: true,
    applied: true,
    applyError: null,
    frameComparePassed: true,
    undone: true,
    estimatedCredits: 1.5,
    chargedCredits: 1.5,
    firstTokenMs: 400,
    planValidationMs: 12,
  };
}

describe("§7.2 scoring harness — stubs", () => {
  it("assertCorpusIntegrity accepts the shipped corpus", () => {
    const corpus = assertCorpusIntegrity();
    expect(corpus.length).toBeGreaterThanOrEqual(30);
  });

  it("scores a golden plan run full-marks on all six dimensions", () => {
    const scores = scoreRun(goldenPlanRun("ev-004-headline-scale-in"));
    expect(scores).toEqual({
      validity: true,
      apply: true,
      visual: true,
      undo: true,
      credits: true,
      latency: true,
    });
  });

  it("marks a schema-invalid plan invalid and unappliable", () => {
    const scores = scoreRun({
      ...goldenPlanRun("ev-001-hero-title-comp"),
      planSchemaValid: false,
    });
    expect(scores.validity).toBe(false);
    expect(scores.apply).toBe(false);
  });

  it("treats a clean refusal as valid-without-apply (no plan by design)", () => {
    const scores = scoreRun({
      promptId: "ev-036-zero-balance",
      planEmitted: false,
      planSchemaValid: false,
      behaviorMatch: true, // golden: graceful refusal, no plan
      applied: false,
      applyError: null,
      frameComparePassed: null,
      undone: false,
      estimatedCredits: 0,
      chargedCredits: 0,
      firstTokenMs: 120,
      planValidationMs: null,
    });
    expect(scores.validity).toBe(true);
    expect(scores.apply).toBeNull();
  });

  it("flags credit drift beyond tolerance", () => {
    const scores = scoreRun({
      ...goldenPlanRun("ev-002-end-card-comp"),
      estimatedCredits: 1.5,
      chargedCredits: 2,
    });
    expect(scores.credits).toBe(false);
  });

  it("flags first-token latency over the §6 budget", () => {
    const scores = scoreRun({ ...goldenPlanRun("ev-003-podcast-title-comp"), firstTokenMs: 2000 });
    expect(scores.latency).toBe(false);
  });

  it("aggregates to the §7.2 targets (≥90% valid, ≥95% apply-on-valid)", () => {
    const prompt = (id: string): GoldenPrompt => {
      const found = PROMPTS.find((p) => p.id === id);
      if (found === undefined) throw new Error(`no prompt ${id}`);
      return found;
    };
    const runs = [
      goldenPlanRun(prompt("ev-004-headline-scale-in").id),
      goldenPlanRun(prompt("ev-005-lower-third-slide-in").id),
      goldenPlanRun(prompt("ev-006-logo-fade-in-out").id),
      goldenPlanRun(prompt("ev-007-badge-pulse").id),
      goldenPlanRun(prompt("ev-008-blur-background").id),
      goldenPlanRun(prompt("ev-009-tune-blur-radius").id),
      goldenPlanRun(prompt("ev-010-drop-shadow-subtitle").id),
      goldenPlanRun(prompt("ev-011-rebrand-red").id),
      goldenPlanRun(prompt("ev-012-lower-third-palette").id),
      goldenPlanRun(prompt("ev-013-text-ink-everywhere").id),
      // One invalid plan out of ten ⇒ 90% validity — still at target…
      { ...goldenPlanRun(prompt("ev-014-rename-final-names").id), planSchemaValid: false },
    ];
    const summary = aggregate(runs.map(scoreRun));
    expect(summary.promptCount).toBe(11);
    expect(summary.validityRate).toBeCloseTo(10 / 11, 10);
    expect(summary.validityRate).toBeGreaterThanOrEqual(0.9);
    expect(summary.applyRate).toBe(1); // every valid plan applied
    expect(summary.meetsValidityTarget).toBe(true);
    expect(summary.meetsApplyTarget).toBe(true);
  });

  it("aggregate apply-rate denominates on VALID plans only", () => {
    const golden = goldenPlanRun("ev-016-lower-third-build");
    const invalid = { ...goldenPlanRun("ev-018-lower-third-emphasis"), planSchemaValid: false };
    const summary = aggregate([golden, invalid, invalid].map(scoreRun));
    expect(summary.validityRate).toBeCloseTo(1 / 3, 10);
    expect(summary.applyRate).toBe(1); // 1 apply attempt on 1 valid plan
  });
});

// ---------------------------------------------------------------------------
// 4. Live runner — skip-guarded (requires LiteLLM)
// ---------------------------------------------------------------------------

describe("live scoring guard (requires LiteLLM)", () => {
  it("skips without EVALS_LIVE=1 and says why", async () => {
    vi.stubEnv("EVALS_LIVE", ""); // vitest drops the variable on empty string
    try {
      const result = await runLiveSuite();
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("LiteLLM");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
