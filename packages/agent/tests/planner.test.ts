// W6-A — planner service tests: §23.2 prompt verbatim + §5.1 one-retry
// validation + §23.2 rule enforcement + usage tracking. Fake model, no network,
// deterministic, table-driven where the logic is pure.
import { PLAN_RETRY_LIMIT } from "@studio/config";
import { describe, expect, it } from "vitest";
import { type Plan, validatePlan } from "../src/plan.js";
import {
  MAX_ISSUES_ATTACHED,
  RAW_EXCERPT_MAX_CHARS,
  type PlanModelCompletion,
  type PlanModelLike,
  PlannerService,
  type PlannerPath,
  type PlannerSections,
  buildPlannerPrompt,
  buildPlannerRetryPrompt,
  enforcePlannerRules,
  extractPlanJson,
  rawExcerptOf,
} from "../src/planner/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every §6 tool named by any fixture plan, so manifest warnings stay opt-in. */
const manifestTools = [
  { name: "template_apply", description: "Apply a template to the document." },
  { name: "template_fill", description: "Fill a template's slots." },
  { name: "text_set", description: "Set editable text on a layer." },
  { name: "layout_apply", description: "Apply layout constraints." },
  { name: "component_place", description: "Place a component instance." },
  { name: "component_set_vars", description: "Override component instance variables." },
  { name: "variant_create", description: "Derive variants of the document." },
  { name: "export_document", description: "Export the document." },
];

const sections: PlannerSections = {
  brief: {
    prompt: "Coffee-shop promo post for Instagram, warm brand feel",
    attachments: [{ id: "asset_123", kind: "image/png", description: "Latte close-up" }],
  },
  snapshot: {
    canvas: { widthPx: 1080, heightPx: 1080 },
    layers: [{ id: "layer-1", name: "Background" }],
    palette: ["#F4E7D3", "#3B2A20"],
    fonts: ["display", "sans"],
    templateSlots: [],
  },
  catalog: {
    tools: manifestTools,
    templates: [
      {
        id: "instagram-post",
        version: 3,
        tags: ["social", "promo", "square"],
        slots: ["photo", "headline", "subhead", "logo"],
      },
    ],
    components: [{ id: "offer-badge", variables: ["label", "bg", "textColor", "showRibbon"] }],
  },
  budget: { tier: "standard", tokenBudgetIn: 80000, tokenBudgetOut: 5000, toolCallCap: 12, revisions: 2 },
  rules: { checks: ["in_bounds", "contrast>=4.5", "headline_largest", "safe_area"] },
};

/** The §5.5 example plan, adapted to the fixture catalog (§24.1 shape). */
const specPlanJson = {
  intent: "create_post",
  template: "instagram-post@3",
  assets: [{ ref: "asset_123", slot: "photo", fit: "cover" }],
  slots: { headline: "Fresh roasted, every morning", subhead: "Open 7–5 · Main St" },
  palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  typography: { headline: { font: "display", weight: "bold" }, body: { font: "sans" } },
  steps: [
    { tool: "template_apply", args: {} },
    { tool: "template_fill", args: {} },
  ],
  checks: ["in_bounds", "contrast>=4.5", "headline_largest", "safe_area"],
  model_tier: "standard",
  notes_for_user: "Reused the brand palette; headline shortened to fit two lines.",
};

/** A §5.5-valid Plan fixture with per-test patches (deep-merged by key, not nested). */
function planFrom(patch: Record<string, unknown> = {}): Plan {
  const result = validatePlan(Object.assign({}, specPlanJson as Record<string, unknown>, patch));
  if (!result.ok) {
    throw new Error(`fixture plan failed validatePlan: ${result.issues.join("; ")}`);
  }
  return result.plan;
}

/** Fixture sections with per-test overrides. */
function sectionsWith(overrides: Partial<PlannerSections>): PlannerSections {
  return { ...sections, ...overrides };
}

// ---------------------------------------------------------------------------
// Fake planner model (§5.3 seam)
// ---------------------------------------------------------------------------

type ModelOutcome = PlanModelCompletion | { readonly throws: Error };

class FakePlanModel implements PlanModelLike {
  readonly prompts: string[] = [];
  private next = 0;
  private readonly outcomes: readonly ModelOutcome[];

  constructor(outcomes: readonly ModelOutcome[]) {
    this.outcomes = outcomes;
  }

  async complete(prompt: string): Promise<PlanModelCompletion> {
    this.prompts.push(prompt);
    const outcome = this.outcomes[this.next];
    this.next += 1;
    if (outcome === undefined) {
      throw new Error("fake planner model: outcome script exhausted");
    }
    if ("throws" in outcome) {
      throw outcome.throws;
    }
    return outcome;
  }
}

function serviceWith(outcomes: readonly ModelOutcome[]): { model: FakePlanModel; service: PlannerService } {
  const model = new FakePlanModel(outcomes);
  return { model, service: new PlannerService(model) };
}

// ---------------------------------------------------------------------------
// buildPlannerPrompt — §23.2 VERBATIM with the five sections interpolated
// ---------------------------------------------------------------------------

describe("planner prompt: §23.2 verbatim", () => {
  it("renders the spec text byte-for-byte with JSON.stringify'd section blocks", () => {
    const prompt = buildPlannerPrompt(sections);
    const expected = `You are planning one design-agent run.

Inputs:
- BRIEF: ${JSON.stringify(sections.brief)}
- SNAPSHOT: ${JSON.stringify(sections.snapshot)}
- CATALOG: ${JSON.stringify(sections.catalog)}
- BUDGET: ${JSON.stringify(sections.budget)}
- RULES: ${JSON.stringify(sections.rules)}

Choose the smallest path to a correct, on-brand, editable document:
- If a template matches the intent, choose it and fill slots.
- Else if components + layout primitives can express it, plan that.
- Else plan a freeform composition from primitives (last resort, flag it).

Return JSON only, validated by the provided schema:
{
  "intent": "create_post|edit_layers|resize|variant|export",
  "template": "id@version or null",
  "assets": [{"ref":"asset_id","slot":"photo","fit":"cover","focal":{"x":0.5,"y":0.4}}],
  "slots": {"slot": "value"},
  "palette": ["#hex", ...],
  "typography": {"headline":{"font":"display","weight":"bold"}},
  "steps": [{"tool":"template_apply","args":{}}, {"tool":"template_fill","args":{}}],
  "checks": ["in_bounds","contrast>=4.5","headline_largest","safe_area"],
  "model_tier": "quick|standard|complex",
  "notes_for_user": "one sentence"
}

Rules:
- Prefer template > components+layout > freeform.
- Never invent slot names, component variables, or asset ids not present in CATALOG/SNAPSHOT.
- Keep text within slot maxChars; write shorter, punchier copy when in doubt.
- If the brief is ambiguous in a way that changes the outcome (language, product, logo),
  include {"tool":"ask_user","args":{...}} as the first step.
- Do not include raw pixel coordinates in slots; layout solves geometry.`;
    expect(prompt).toBe(expected);
  });

  it("interpolates the five labeled sections as compact JSON (no template engine, no {{}})", () => {
    const prompt = buildPlannerPrompt(sections);
    expect(prompt).toContain(`- BRIEF: ${JSON.stringify(sections.brief)}`);
    expect(prompt).toContain(`- CATALOG: ${JSON.stringify(sections.catalog)}`);
    expect(prompt).toContain(`- BUDGET: ${JSON.stringify(sections.budget)}`);
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("{brief}");
    expect(prompt).not.toContain("user prompt, attachments"); // placeholder gone
  });

  it("is byte-stable for equal inputs (§5.3 prompt-cache prefix)", () => {
    expect(buildPlannerPrompt(sections)).toBe(buildPlannerPrompt(sections));
  });
});

describe("buildPlannerRetryPrompt: §5.1 issues attached", () => {
  it("keeps the full original prompt and appends every issue", () => {
    const retry = buildPlannerRetryPrompt("BASE PLAN PROMPT", [
      "plan.intent: Invalid enum value",
      'plan slot "hero": invented slot name (§23.2)',
    ]);
    expect(retry.startsWith("BASE PLAN PROMPT")).toBe(true);
    expect(retry).toContain("plan.intent: Invalid enum value");
    expect(retry).toContain('plan slot "hero": invented slot name (§23.2)');
    expect(retry).toContain("the full JSON object only");
  });

  it(`caps attached issues at ${MAX_ISSUES_ATTACHED} and reports the rest`, () => {
    const issues = Array.from({ length: MAX_ISSUES_ATTACHED + 5 }, (_, i) => `issue-${i}`);
    const retry = buildPlannerRetryPrompt("BASE", issues);
    expect(retry).toContain("issue-0");
    expect(retry).toContain(`issue-${MAX_ISSUES_ATTACHED - 1}`);
    expect(retry).not.toContain(`issue-${MAX_ISSUES_ATTACHED}`);
    expect(retry).toContain(`…and 5 more issue(s)`);
  });
});

// ---------------------------------------------------------------------------
// extractPlanJson — fence/preamble tolerance
// ---------------------------------------------------------------------------

describe("extractPlanJson", () => {
  const table: readonly { name: string; text: string; json: unknown }[] = [
    { name: "bare JSON", text: '{"intent":"create_post"}', json: { intent: "create_post" } },
    { name: "fenced json block", text: '```json\n{"intent":"create_post"}\n```', json: { intent: "create_post" } },
    { name: "fenced untagged block", text: '```\n{"a":1}\n```', json: { a: 1 } },
    {
      name: "prose preamble + trailing prose",
      text: 'Sure! Here is the plan:\n{"intent":"create_post"}\nHope this helps.',
      json: { intent: "create_post" },
    },
    { name: "brace inside string is not a closer", text: 'x {"a":"}"} y', json: { a: "}" } },
    { name: "open fence, balanced object still recovered", text: '```json\n{"a":1}', json: { a: 1 } },
    { name: "valid non-object JSON extracts (validatePlan owns the shape)", text: "[1,2]", json: [1, 2] },
  ];
  for (const { name, text, json } of table) {
    it(`extracts: ${name}`, () => {
      const result = extractPlanJson(text);
      expect(result).toEqual({ ok: true, json });
    });
  }

  const badTable: readonly { name: string; text: string }[] = [
    { name: "empty", text: "" },
    { name: "whitespace only", text: "   \n\t  " },
    { name: "prose without braces", text: "I cannot comply with that request." },
    { name: "unterminated object", text: '{"intent":"create_post"' },
    { name: "unterminated object inside open fence", text: '```json\n{"a":1' },
  ];
  for (const { name, text } of badTable) {
    it(`rejects: ${name}`, () => {
      const result = extractPlanJson(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issue.length).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// rawExcerptOf — ≤500 chars, control-char-sanitized (§5.7/§15.3)
// ---------------------------------------------------------------------------

describe("rawExcerptOf", () => {
  it("truncates to ≤500 chars, replaces control chars with spaces, trims", () => {
    const nasty = `B\u0001${"A".repeat(600)}\u001f\u007f`;
    const excerpt = rawExcerptOf(nasty);
    expect(excerpt.length).toBeLessThanOrEqual(RAW_EXCERPT_MAX_CHARS);
    expect(excerpt).toBe(`B ${"A".repeat(498)}`); // clip 500 → control chars → space
  });

  it("keeps short, clean text as-is (control chars stripped at the edges)", () => {
    expect(rawExcerptOf('  {"intent":"create_post"}  ')).toBe('{"intent":"create_post"}');
    expect(rawExcerptOf('{"a":"b"}\u0007\u001f')).toBe('{"a":"b"}');
  });
});

// ---------------------------------------------------------------------------
// enforcePlannerRules — §23.2 invented-reference rejection table
// ---------------------------------------------------------------------------

describe("enforcePlannerRules: invented references are invalid", () => {
  const table: readonly {
    name: string;
    patch: Record<string, unknown>;
    sections?: PlannerSections;
    issue: RegExp;
  }[] = [
    {
      name: "invented slot name in plan.slots",
      patch: { slots: { headline: "ok", hero: "nope" } },
      issue: /plan slot "hero".*invented slot name/,
    },
    {
      name: "invented slot name via assets[].slot",
      patch: { assets: [{ ref: "asset_123", slot: "photo2" }] },
      issue: /plan slot "photo2".*invented slot name/,
    },
    {
      name: "invented asset ref",
      patch: { assets: [{ ref: "asset_999", slot: "photo" }] },
      issue: /plan asset ref "asset_999".*invented asset id/,
    },
    {
      name: "invented template id",
      patch: { template: "made-up-post@9" },
      issue: /plan\.template: "made-up-post@9".*invented template id/,
    },
    {
      name: "template version drift vs pinned catalog entry",
      patch: { template: "instagram-post@4" },
      issue: /"instagram-post@4".*invented template id/,
    },
    {
      name: "slot valid in another template is still invented for the chosen one",
      patch: { slots: { headline: "ok", title: "belongs to poster-a3" } },
      sections: sectionsWith({
        catalog: {
          tools: manifestTools,
          templates: [
            { id: "instagram-post", version: 3, slots: ["photo", "headline"] },
            { id: "poster-a3", version: 1, slots: ["photo2", "title"] },
          ],
        },
      }),
      issue: /plan slot "title".*invented slot name/,
    },
    {
      name: "any slot is invented when CATALOG/SNAPSHOT carry no slot data",
      patch: { slots: { headline: "no data to check against" } },
      sections: sectionsWith({
        catalog: { tools: manifestTools },
        snapshot: { canvas: { widthPx: 1080, heightPx: 1080 }, templateSlots: [] },
      }),
      issue: /slot names cannot be verified/,
    },
    {
      name: "any asset ref is invented when no asset ids exist anywhere",
      patch: { assets: [{ ref: "asset_123", slot: "photo" }] },
      sections: sectionsWith({
        brief: { prompt: "Coffee promo" },
        catalog: { tools: manifestTools, templates: sections.catalog?.templates },
        snapshot: { templateSlots: [] },
      }),
      issue: /asset refs cannot be verified/,
    },
  ];

  for (const { name, patch, sections: custom, issue } of table) {
    it(`rejects: ${name}`, () => {
      const outcome = enforcePlannerRules(planFrom(patch), custom ?? sections);
      expect(outcome.issues.length).toBeGreaterThan(0);
      expect(outcome.issues.some((entry) => issue.test(entry))).toBe(true);
    });
  }

  it("accepts the §5.5 example against the fixture catalog (no issues)", () => {
    const outcome = enforcePlannerRules(planFrom(), sections);
    expect(outcome.issues).toEqual([]);
    expect(outcome.path).toBe<PlannerPath>("template");
    expect(outcome.freeform).toBe(false);
    expect(outcome.warnings).toEqual([]);
  });

  it("matches an unversioned catalog entry to any pinned version", () => {
    const outcome = enforcePlannerRules(
      planFrom({ slots: {}, assets: [] }),
      sectionsWith({ catalog: { tools: manifestTools, templates: [{ id: "instagram-post" }] } }),
    );
    expect(outcome.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// enforcePlannerRules — §23.2 smallest-path classification + freeform flagging
// ---------------------------------------------------------------------------

describe("enforcePlannerRules: path classification and freeform flagging", () => {
  const primitives: Record<string, unknown> = {
    template: null,
    slots: {},
    assets: [],
    steps: [{ tool: "text_set", args: { layer: "Headline", text: "New" } }],
  };

  it("flags a primitives-only composition as freeform and requires notes_for_user", () => {
    const unexplained = enforcePlannerRules(
      planFrom({ ...primitives, notes_for_user: "" }),
      sections,
    );
    expect(unexplained.freeform).toBe(true);
    expect(unexplained.issues.some((i) => i.includes("notes_for_user"))).toBe(true);
    expect(unexplained.warnings.some((w) => w.includes("freeform composition planned"))).toBe(true);
    expect(
      unexplained.warnings.some((w) => w.includes("1 template(s)") && w.includes("prefer template")),
    ).toBe(true);
  });

  it("accepts a freeform composition when notes_for_user explains it", () => {
    const explained = enforcePlannerRules(
      planFrom({ ...primitives, notes_for_user: "No template or component fits; composed from primitives." }),
      sections,
    );
    expect(explained.issues).toEqual([]);
    expect(explained.path).toBe<PlannerPath>("freeform");
    expect(explained.freeform).toBe(true);
  });

  it("does NOT flag edit_layers/resize/export runs (existing document, no composition ladder)", () => {
    for (const intent of ["edit_layers", "resize", "export"] as const) {
      const outcome = enforcePlannerRules(
        planFrom({
          ...primitives,
          intent,
          steps: [{ tool: intent === "export" ? "export_document" : "text_set", args: {} }],
        }),
        sections,
      );
      expect(outcome.path).toBe<PlannerPath>("edit");
      expect(outcome.freeform).toBe(false);
      expect(outcome.issues).toEqual([]);
    }
  });

  it("classifies variant_create as the variant path and components/layout as rung 2", () => {
    const variant = enforcePlannerRules(
      planFrom({ ...primitives, intent: "variant", steps: [{ tool: "variant_create", args: {} }] }),
      sections,
    );
    expect(variant.path).toBe<PlannerPath>("variant");
    expect(variant.freeform).toBe(false);

    const layout = enforcePlannerRules(
      planFrom({ ...primitives, steps: [{ tool: "layout_apply", args: {} }] }),
      sections,
    );
    expect(layout.path).toBe<PlannerPath>("components_layout");
    expect(layout.freeform).toBe(false);
    expect(layout.issues).toEqual([]);
  });

  it("accepts dotted §5.5 step ids and warns only when a tool is off-manifest", () => {
    const dotted = enforcePlannerRules(planFrom({ template: "instagram-post@3" }), sections);
    expect(dotted.issues).toEqual([]);
    expect(dotted.warnings).toEqual([]);

    const offManifest = enforcePlannerRules(
      planFrom({ ...primitives, steps: [{ tool: "canvas.resize", args: {} }] }),
      sections,
    );
    expect(
      offManifest.warnings.some((w) => w.includes("outside the §6 manifest") && w.includes("canvas_resize")),
    ).toBe(true);
  });

  it("warns when a template is chosen but never applied, and when slots have no template", () => {
    const unapplied = enforcePlannerRules(
      planFrom({ steps: [{ tool: "template_fill", args: {} }] }),
      sections,
    );
    expect(unapplied.issues).toEqual([]);
    expect(unapplied.warnings.some((w) => w.includes("no template_apply step"))).toBe(true);

    const orphanSlots = enforcePlannerRules(
      planFrom({ intent: "edit_layers", ...primitives, slots: { headline: "edit" } }),
      sections,
    );
    expect(orphanSlots.issues).toEqual([]);
    expect(orphanSlots.warnings.some((w) => w.includes("without choosing a template"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PlannerService — §5.1 plan first, one retry, then fail clear
// ---------------------------------------------------------------------------

describe("PlannerService.plan", () => {
  it("returns the validated plan on the first attempt (usage tracked)", async () => {
    const { model, service } = serviceWith([
      { text: JSON.stringify(specPlanJson), usage: { tokensIn: 120, tokensOut: 40 } },
    ]);
    const result = await service.plan({ ...sections });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.intent).toBe("create_post");
      expect(result.plan.template).toBe("instagram-post@3");
      expect(result.path).toBe<PlannerPath>("template");
      expect(result.freeform).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.usage).toEqual({ calls: 1, tokensIn: 120, tokensOut: 40, cacheHits: 0 });
      expect(result.warnings).toEqual([]);
    }
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]?.startsWith("You are planning one design-agent run.")).toBe(true);
    expect(model.prompts[0]).toContain("Return JSON only, validated by the provided schema:");
    expect(model.prompts[0]).toContain('- BRIEF: {"prompt":"Coffee-shop promo post');
  });

  it("extracts fenced JSON end-to-end", async () => {
    const { service } = serviceWith([{ text: `\`\`\`json\n${JSON.stringify(specPlanJson)}\n\`\`\`` }]);
    const result = await service.plan({ ...sections });
    expect(result.ok).toBe(true);
  });

  it("retries ONCE with the schema issues attached, then succeeds (§5.1)", async () => {
    const invalid = { ...specPlanJson, intent: "delete_everything" };
    const { model, service } = serviceWith([
      { text: JSON.stringify(invalid), usage: { tokensIn: 100, tokensOut: 10 } },
      { text: JSON.stringify(specPlanJson), usage: { tokensIn: 90, tokensOut: 30, cacheHits: 12 } },
    ]);
    const result = await service.plan({ ...sections });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2); // 1 + PLAN_RETRY_LIMIT
      expect(result.usage).toEqual({ calls: 2, tokensIn: 190, tokensOut: 40, cacheHits: 12 });
    }
    expect(model.prompts).toHaveLength(2);
    const first = model.prompts[0] ?? "";
    const second = model.prompts[1] ?? "";
    expect(second.startsWith(first)).toBe(true); // original prompt kept
    expect(second).toContain("plan.intent"); // validation errors attached
    expect(second).toContain("delete_everything"); // zod echoes the bad value in the issue
  });

  it("retries once when a §23.2 rule is violated (invented slot), then succeeds", async () => {
    const inventedSlot = { ...specPlanJson, slots: { hero: "nope" } };
    const { model, service } = serviceWith([
      { text: JSON.stringify(inventedSlot) },
      { text: JSON.stringify(specPlanJson) },
    ]);
    const result = await service.plan({ ...sections });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
    }
    expect(model.prompts[1]).toContain("invented slot name");
  });

  it("fails with plan_invalid after the retry, carrying sanitized issues + excerpt", async () => {
    const gibberish = `I can haz design?\u0007${"x".repeat(700)}`;
    const { model, service } = serviceWith([{ text: gibberish }, { text: gibberish }]);
    const result = await service.plan({ ...sections });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("plan_invalid");
      expect(result.retryable).toBe(false);
      expect(result.attempts).toBe(1 + PLAN_RETRY_LIMIT);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toContain("not valid JSON");
      expect(result.rawExcerpt.length).toBeLessThanOrEqual(RAW_EXCERPT_MAX_CHARS);
      expect(result.rawExcerpt.includes("I can haz design?")).toBe(true);
      expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(result.rawExcerpt)).toBe(false);
      expect(result.usage.calls).toBe(2);
    }
    expect(model.prompts).toHaveLength(2); // exactly one retry
  });

  it("sanitizes flaky provider usage numbers (§22: counts never throw)", async () => {
    const { service } = serviceWith([
      {
        text: JSON.stringify(specPlanJson),
        usage: { tokensIn: Number.NaN, tokensOut: -3, cacheHits: 2.9 },
      },
    ]);
    const result = await service.plan({ ...sections });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual({ calls: 1, tokensIn: 0, tokensOut: 0, cacheHits: 2 });
    }
  });

  it("maps a thrown provider error to provider_unhealthy without leaking internals", async () => {
    const { service } = serviceWith([
      { throws: new Error("SECRET upstream stack for gemini-3.8-flash: AIza-sy-token") },
    ]);
    const result = await service.plan({ ...sections });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("provider_unhealthy");
      expect(result.retryable).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.rawExcerpt).toBe("");
      expect(`${result.message}${result.hint}`).not.toContain("SECRET");
      expect(`${result.message}${result.hint}`).not.toContain("AIza");
    }
  });

  it("maps AbortError and a pre-aborted signal to run_timeout (model not called)", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const thrown = await serviceWith([{ throws: abort }]).service.plan({ ...sections });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) {
      expect(thrown.code).toBe("run_timeout");
      expect(thrown.retryable).toBe(false);
    }

    const { model, service } = serviceWith([{ text: JSON.stringify(specPlanJson) }]);
    const preAborted = await service.plan({ ...sections, signal: { aborted: true } });
    expect(preAborted.ok).toBe(false);
    if (!preAborted.ok) {
      expect(preAborted.code).toBe("run_timeout");
      expect(preAborted.usage.calls).toBe(0);
    }
    expect(model.prompts).toHaveLength(0);
  });

  it("fails fast on malformed worker input with field paths only (no values)", async () => {
    const { service } = serviceWith([{ text: JSON.stringify(specPlanJson) }]);
    const bad = { ...sections, budget: { ...sections.budget, tier: "ultra" } } as unknown as PlannerInput;
    let message = "";
    try {
      await service.plan(bad);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("invalid planner input");
    expect(message).toContain("budget.tier");
    expect(message).not.toContain("ultra"); // §15.3: values never echo
  });
});
