// W6-O — chat-edit classifier tests: §23.5 prompt verbatim + §24.2 worked
// example (restyle + add_component, quick tier, 1 credit) + ambiguity→clarify
// + the §23.5 cheapest-action downgrades table + §5.1 retry-on-invalid +
// §14.1 tier→credit mapping. Fake model, no network, deterministic,
// table-driven where the logic is pure.
import { PLAN_RETRY_LIMIT } from "@studio/config";
import { describe, expect, it } from "vitest";
import {
  type ChatEditAction,
  type ChatEditClassification,
  type ChatEditClassifyInput,
  type ChatCostTier,
  type ClassifierModelCompletion,
  type ClassifierModelLike,
  CHAT_EDIT_ACTIONS,
  CHAT_EDIT_COMPOSITE_CONVENTIONS,
  CHAT_EDIT_INVALID_CODE,
  CHAT_EDIT_MAX_ISSUES_ATTACHED,
  CHAT_EDIT_MAX_LAYER_ROWS,
  CHAT_EDIT_SPEC_PROMPT,
  ChatEditClassifier,
  LAYER_TARGETED_ACTIONS,
  MAX_ASK_USER_OPTION_CHARS,
  MAX_ASK_USER_OPTIONS,
  MAX_TARGET_LAYERS,
  TIER_TOOL_CALL_CAPS,
  ACTION_PRIMARY_TOOLS,
  buildChatEditMiniPlan,
  buildChatEditPrompt,
  buildChatEditRetryPrompt,
  buildChatEditSteps,
  chatCostTierSchema,
  chatEditClassificationSchema,
  chatEditInputSchema,
  creditsForCostTier,
  enforceChatEditRules,
  extractChatEditJson,
  parseActionExpr,
  resolveCostTier,
} from "../src/classifier/index.js";

// ---------------------------------------------------------------------------
// Fixtures — the §24.2 document (spec §24.1 output, evals/cases/edits.yaml seed)
// ---------------------------------------------------------------------------

const userRequest242 = "Make the subhead smaller and add a 20% OFF badge.";

const layerSummary242 = [
  { name: "Background", kind: "fill", opacity: 100 },
  { name: "Photo", kind: "smart_object", asset: "asset_812" },
  { name: "Headline", kind: "text", size: 88 },
  { name: "Subhead", kind: "text", size: 36 },
];

const catalog242 = {
  tools: [
    { name: "text_set", description: "Create or rewrite editable text." },
    { name: "style_apply", description: "Layer styles and adjustment layers." },
    { name: "component_place", description: "Place a component instance." },
    { name: "component_set_vars", description: "Override component variables." },
    { name: "ask_user", description: "Ask the user one clarifying question." },
  ],
  components: [{ id: "offer-badge@2", variables: ["label"] }],
  templates: [],
  assets: [],
};

const input242: ChatEditClassifyInput = {
  userRequest: userRequest242,
  layerSummary: layerSummary242,
  catalog: catalog242,
};

/** The §24.2 classifier output: restyle + add_component, target Subhead, quick. */
const classification242 = {
  action: "restyle+add_component",
  target_layers: ["Subhead"],
  args: {
    restyle: { size: 30 },
    add_component: {
      id: "offer-badge@2",
      position: "top-right",
      vars: { label: "20% OFF" },
    },
  },
  cost_tier: "quick",
  needs_template_reapply: false,
};

/** A schema-valid classification (per-test patches deep-merge by key). */
function validClassification(patch: Record<string, unknown> = {}): ChatEditClassification {
  const parsed = chatEditClassificationSchema.safeParse({
    action: "set_text",
    target_layers: ["Headline"],
    args: { text: "Roasted this morning" },
    cost_tier: "quick",
    needs_template_reapply: false,
    ...patch,
  });
  if (!parsed.success) {
    throw new Error(`fixture classification failed the schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** The rules context for the §24.2 document. */
const context242 = {
  layerNames: new Set(layerSummary242.map((row) => row.name)),
  components: catalog242.components,
};

// ---------------------------------------------------------------------------
// Fake classifier model (§5.3 seam, planner precedent)
// ---------------------------------------------------------------------------

type ModelOutcome = ClassifierModelCompletion | { readonly throws: Error };

class FakeClassifierModel implements ClassifierModelLike {
  readonly prompts: string[] = [];
  private next = 0;
  private readonly outcomes: readonly ModelOutcome[];

  constructor(outcomes: readonly ModelOutcome[]) {
    this.outcomes = [...outcomes];
  }

  async complete(prompt: string): Promise<ClassifierModelCompletion> {
    this.prompts.push(prompt);
    const outcome = this.outcomes[this.next];
    this.next += 1;
    if (outcome === undefined) {
      throw new Error("fake classifier model: outcome script exhausted");
    }
    if ("throws" in outcome) {
      throw outcome.throws;
    }
    return outcome;
  }
}

function serviceWith(outcomes: readonly ModelOutcome[]): {
  model: FakeClassifierModel;
  service: ChatEditClassifier;
} {
  const model = new FakeClassifierModel(outcomes);
  return { model, service: new ChatEditClassifier(model) };
}

function classifyWith(
  outcomes: readonly ModelOutcome[],
  input: ChatEditClassifyInput = input242,
): ReturnType<ChatEditClassifier["classify"]> {
  return new ChatEditClassifier(new FakeClassifierModel(outcomes)).classify(input);
}

// ---------------------------------------------------------------------------
// buildChatEditPrompt — §23.5 VERBATIM with the three sections interpolated
// ---------------------------------------------------------------------------

describe("chat-edit prompt: §23.5 verbatim", () => {
  const spec235 = [
    "Classify the user's edit request on an existing document. Return JSON only:",
    '{"action":"set_text|replace_field|restyle|move|resize|add_component|remove_layer|recolor|export|clarify",',
    ' "target_layers":["name"], "args":{...}, "cost_tier":"quick|standard|complex",',
    ' "needs_template_reapply":true|false}',
    "Pick the cheapest action that satisfies the request. If the target is ambiguous, list",
    'candidates and set action "clarify" with one question. Never propose a full regeneration',
    "when a targeted edit works.",
  ].join("\n");

  it("renders the spec block byte-for-byte (LF-joined, CRLF spec file)", () => {
    expect(CHAT_EDIT_SPEC_PROMPT).toBe(spec235);
  });

  it("closes the prompt with the §23.5 text, exactly once, after the inputs", () => {
    const prompt = buildChatEditPrompt(input242);
    expect(prompt.endsWith(spec235)).toBe(true);
    expect(prompt.indexOf(spec235)).toBe(prompt.lastIndexOf(spec235));
    expect(prompt).toContain(CHAT_EDIT_COMPOSITE_CONVENTIONS);
  });

  it("labels the three §23.5 sections as JSON blocks", () => {
    const prompt = buildChatEditPrompt(input242);
    expect(prompt).toContain(`- USER REQUEST: ${JSON.stringify(userRequest242)}`);
    expect(prompt).toContain("- LAYER SUMMARY: ");
    expect(prompt).toContain(JSON.stringify(layerSummary242[3]));
    expect(prompt).toContain("- CATALOG: ");
    expect(prompt).toContain('"offer-badge@2"');
  });

  it("is byte-stable for equal inputs (§5.3 cache anchor)", () => {
    expect(buildChatEditPrompt(input242)).toBe(buildChatEditPrompt(input242));
  });

  it("input boundary: rejects empty request, oversized requests, oversized summaries", () => {
    expect(chatEditInputSchema.safeParse({ ...input242, userRequest: "" }).success).toBe(false);
    expect(
      chatEditInputSchema.safeParse({ ...input242, userRequest: "x".repeat(20_001) }).success,
    ).toBe(false);
    const rows = Array.from({ length: CHAT_EDIT_MAX_LAYER_ROWS + 1 }, (_, i) => ({
      name: `Layer ${i}`,
    }));
    expect(
      chatEditInputSchema.safeParse({ ...input242, layerSummary: rows }).success,
    ).toBe(false);
    expect(chatEditInputSchema.safeParse(input242).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildChatEditRetryPrompt — §5.1 issues appended, §23.5 text never edited
// ---------------------------------------------------------------------------

describe("chat-edit retry prompt", () => {
  it("appends the issues to the untouched base prompt", () => {
    const base = buildChatEditPrompt(input242);
    const retry = buildChatEditRetryPrompt(base, ["issue one", "issue two"]);
    expect(retry.startsWith(base)).toBe(true);
    expect(retry).toContain("- issue one");
    expect(retry).toContain("- issue two");
    expect(retry).toContain("Return the corrected classification now");
  });

  it("caps attached issues and elides the rest", () => {
    const issues = Array.from({ length: CHAT_EDIT_MAX_ISSUES_ATTACHED + 5 }, (_, i) => `i${i}`);
    const retry = buildChatEditRetryPrompt("base", issues);
    expect(retry).toContain("- i0");
    expect(retry).toContain(`- i${CHAT_EDIT_MAX_ISSUES_ATTACHED - 1}`);
    expect(retry).not.toContain(`- i${CHAT_EDIT_MAX_ISSUES_ATTACHED}`);
    expect(retry).toContain("5 more issue(s)");
  });
});

// ---------------------------------------------------------------------------
// parseActionExpr — §23.5 atoms + the §24.2 composite
// ---------------------------------------------------------------------------

describe("parseActionExpr", () => {
  it("parses each §23.5 atom", () => {
    for (const action of CHAT_EDIT_ACTIONS) {
      const parsed = parseActionExpr(action);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.atoms).toEqual([action]);
      }
    }
  });

  it("parses the §24.2 composite with and without spaces", () => {
    for (const expr of ["restyle+add_component", "restyle + add_component"]) {
      const parsed = parseActionExpr(expr);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.atoms).toEqual<readonly ChatEditAction[]>(["restyle", "add_component"]);
      }
    }
  });

  const invalid: readonly [string, string][] = [
    ["", "empty"],
    ["regenerate", "not one of the §23.5 actions"],
    ["set_text+regenerate", "not one of the §23.5 actions"],
    ["restyle+restyle", "repeats atom"],
    ["set_text+restyle+move+recolor", "max"],
  ];
  for (const [expr, needle] of invalid) {
    it(`rejects "${expr}" (${needle})`, () => {
      const parsed = parseActionExpr(expr);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issue).toContain(needle);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// chatEditClassificationSchema — §23.5 contract, strict (§5.7)
// ---------------------------------------------------------------------------

describe("chatEditClassificationSchema", () => {
  it("accepts the §24.2 composite classification", () => {
    const parsed = chatEditClassificationSchema.safeParse(classification242);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.action).toBe("restyle+add_component");
      expect(parsed.data.target_layers).toEqual(["Subhead"]);
      expect(parsed.data.cost_tier).toBe("quick");
    }
  });

  const base: Record<string, unknown> = {
    action: "set_text",
    target_layers: ["Headline"],
    args: { text: "Hi" },
    cost_tier: "quick",
    needs_template_reapply: false,
  };
  const rejected: readonly [string, Record<string, unknown>][] = [
    ["unknown action", { ...base, action: "regenerate" }],
    ["repeated atom", { ...base, action: "restyle+restyle" }],
    ["four atoms", { ...base, action: "set_text+restyle+move+recolor" }],
    ["premium tier (§5.2 multiplier, not a chat-edit cost tier)", { ...base, cost_tier: "premium" }],
    ["string needs_template_reapply", { ...base, needs_template_reapply: "false" }],
    [
      "11 target layers",
      { ...base, target_layers: Array.from({ length: MAX_TARGET_LAYERS + 1 }, (_, i) => `L${i}`) },
    ],
    ["smuggled top-level key (§5.7)", { ...base, extra_directive: true }],
    [
      "missing args",
      {
        action: "set_text",
        target_layers: ["Headline"],
        cost_tier: "quick",
        needs_template_reapply: false,
      },
    ],
    ["array args", { ...base, args: ["nope"] }],
    [
      "33 args keys",
      (() => {
        const args: Record<string, unknown> = {};
        for (let i = 0; i < 33; i++) args[`k${i}`] = i;
        return { ...base, args };
      })(),
    ],
  ];
  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(chatEditClassificationSchema.safeParse(value).success).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// extractChatEditJson — fence/preamble tolerance
// ---------------------------------------------------------------------------

describe("extractChatEditJson", () => {
  const json = JSON.stringify({ action: "restyle" });

  it("accepts bare JSON", () => {
    const result = extractChatEditJson(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.json).toEqual({ action: "restyle" });
    }
  });

  it("accepts a fenced block with prose around it", () => {
    const result = extractChatEditJson(`Sure!\n\`\`\`json\n${json}\n\`\`\`\nDone.`);
    expect(result.ok).toBe(true);
  });

  it("accepts prose with a balanced object (escapes honored)", () => {
    const result = extractChatEditJson(`Here you go: {"action":"set_text"} — hope it helps`);
    expect(result.ok).toBe(true);
  });

  it("rejects empty and non-JSON output with a §23.5-flavored issue", () => {
    for (const text of ["", "   ", "no json at all"]) {
      const result = extractChatEditJson(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issue).toContain("§23.5");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// enforceChatEditRules — §23.5 deterministic post-rules
// ---------------------------------------------------------------------------

describe("enforceChatEditRules", () => {
  it("accepts the §24.2 composite with no issues", () => {
    const outcome = enforceChatEditRules(
      ["restyle", "add_component"],
      validClassification(classification242),
      context242,
    );
    expect(outcome.issues).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.clarify).toBeNull();
  });

  it("clarify requires candidates + one question (§23.5)", () => {
    const missing = enforceChatEditRules(
      ["clarify"],
      validClassification({ action: "clarify", target_layers: [], args: {} }),
      context242,
    );
    expect(missing.issues.length).toBe(2);
    expect(missing.issues.join(" ")).toContain("args.candidates");
    expect(missing.issues.join(" ")).toContain("args.question");

    const good = enforceChatEditRules(
      ["clarify"],
      validClassification({
        action: "clarify",
        target_layers: [],
        args: { candidates: ["Headline", "Subhead"], question: "Which text layer?" },
      }),
      context242,
    );
    expect(good.issues).toEqual([]);
    expect(good.clarify).toEqual({
      question: "Which text layer?",
      candidates: ["Headline", "Subhead"],
    });
  });

  it("a clarify never composes with another atom", () => {
    const outcome = enforceChatEditRules(
      ["clarify", "restyle"],
      validClassification({
        action: "clarify+restyle",
        target_layers: ["Headline"],
        args: { candidates: ["Headline"], question: "Which?" },
      }),
      context242,
    );
    expect(outcome.issues.join(" ")).toContain("never composes");
  });

  it("rejects invented target layers (§23.5 never-invent stance)", () => {
    const outcome = enforceChatEditRules(
      ["restyle"],
      validClassification({ action: "restyle", target_layers: ["Sub-head"] }),
      context242,
    );
    expect(outcome.issues.join(" ")).toContain('target layer "Sub-head"');
    expect(outcome.issues.join(" ")).toContain("invented target");
  });

  it("warns (never fails) when no layer summary exists to verify against", () => {
    const outcome = enforceChatEditRules(
      ["restyle"],
      validClassification({ target_layers: ["Subhead"] }),
      { layerNames: new Set<string>(), components: [] },
    );
    expect(outcome.issues).toEqual([]);
    expect(outcome.warnings.join(" ")).toContain("could not be verified");
  });

  it("layer-targeted atoms need ≥1 target", () => {
    for (const action of LAYER_TARGETED_ACTIONS) {
      const outcome = enforceChatEditRules(
        [action],
        validClassification({ action, target_layers: [] }),
        context242,
      );
      expect(outcome.issues.join(" ")).toContain("need named target layers");
    }
  });

  it("rejects invented component ids, warns when unverifiable", () => {
    const invented = enforceChatEditRules(
      ["add_component"],
      validClassification({
        action: "add_component",
        target_layers: [],
        args: { id: "mega-badge@9" },
      }),
      context242,
    );
    expect(invented.issues.join(" ")).toContain("invented component id");

    const noCatalog = enforceChatEditRules(
      ["add_component"],
      validClassification({ action: "add_component", target_layers: [], args: { id: "offer-badge@2" } }),
      { layerNames: context242.layerNames, components: [] },
    );
    expect(noCatalog.issues).toEqual([]);
    expect(noCatalog.warnings.join(" ")).toContain("catalog lists no components");

    const noId = enforceChatEditRules(
      ["add_component"],
      validClassification({ action: "add_component", target_layers: [], args: {} }),
      context242,
    );
    expect(noId.issues).toEqual([]);
    expect(noId.warnings.join(" ")).toContain("no component id");
  });

  it("matches id@version component refs against versioned catalog entries", () => {
    const outcome = enforceChatEditRules(
      ["add_component"],
      validClassification({
        action: "add_component",
        target_layers: [],
        args: { component: "offer-badge@2" },
      }),
      { layerNames: context242.layerNames, components: [{ id: "offer-badge", version: 2 }] },
    );
    expect(outcome.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveCostTier — the §23.5 cheapest-action downgrade guard (pure table)
// ---------------------------------------------------------------------------

describe("resolveCostTier: §23.5 cheapest-action guard", () => {
  const rows: readonly {
    readonly label: string;
    readonly atoms: readonly ChatEditAction[];
    readonly targetCount: number;
    readonly reapply: boolean;
    readonly proposed: ChatCostTier;
    readonly resolved: ChatCostTier;
    readonly credits: number;
    readonly estimated: number;
    readonly kind: "none" | "downgrade" | "raise" | "overflow";
  }[] = [
    {
      label: "the task's example: set_text proposed complex → quick",
      atoms: ["set_text"], targetCount: 1, reapply: false, proposed: "complex",
      resolved: "quick", credits: 1, estimated: 4, kind: "downgrade",
    },
    {
      label: "set_text proposed standard → quick",
      atoms: ["set_text"], targetCount: 1, reapply: false, proposed: "standard",
      resolved: "quick", credits: 1, estimated: 4, kind: "downgrade",
    },
    {
      label: "§24.2 restyle+add_component proposed complex → quick (5 calls, 1 credit)",
      atoms: ["restyle", "add_component"], targetCount: 1, reapply: false, proposed: "complex",
      resolved: "quick", credits: 1, estimated: 5, kind: "downgrade",
    },
    {
      label: "§24.2 at quick stays quick, no warnings",
      atoms: ["restyle", "add_component"], targetCount: 1, reapply: false, proposed: "quick",
      resolved: "quick", credits: 1, estimated: 5, kind: "none",
    },
    {
      label: "10-target set_text at complex legitimately stays (13 calls)",
      atoms: ["set_text"], targetCount: 10, reapply: false, proposed: "complex",
      resolved: "complex", credits: 5, estimated: 13, kind: "none",
    },
    {
      label: "9-target set_text complex → standard (12 calls)",
      atoms: ["set_text"], targetCount: 9, reapply: false, proposed: "complex",
      resolved: "standard", credits: 2, estimated: 12, kind: "downgrade",
    },
    {
      label: "8-target set_text quick → standard (budget-fit raise, 11 calls)",
      atoms: ["set_text"], targetCount: 8, reapply: false, proposed: "quick",
      resolved: "standard", credits: 2, estimated: 11, kind: "raise",
    },
    {
      label: "add_component proposed standard → quick (4 calls)",
      atoms: ["add_component"], targetCount: 0, reapply: false, proposed: "standard",
      resolved: "quick", credits: 1, estimated: 4, kind: "downgrade",
    },
    {
      label: "clarify proposed complex → quick (ask_user only, no run tail)",
      atoms: ["clarify"], targetCount: 0, reapply: false, proposed: "complex",
      resolved: "quick", credits: 1, estimated: 1, kind: "downgrade",
    },
    {
      label: "export proposed standard → quick (4 calls)",
      atoms: ["export"], targetCount: 0, reapply: false, proposed: "standard",
      resolved: "quick", credits: 1, estimated: 4, kind: "downgrade",
    },
    {
      label: "canvas resize + template reapply at quick fits exactly (6 calls)",
      atoms: ["resize"], targetCount: 0, reapply: true, proposed: "quick",
      resolved: "quick", credits: 1, estimated: 6, kind: "none",
    },
    {
      label: "canvas resize + reapply proposed complex → quick",
      atoms: ["resize"], targetCount: 0, reapply: true, proposed: "complex",
      resolved: "quick", credits: 1, estimated: 6, kind: "downgrade",
    },
    {
      label: "10-target restyle quick → complex (13 calls over every lower cap)",
      atoms: ["restyle"], targetCount: 10, reapply: false, proposed: "quick",
      resolved: "complex", credits: 5, estimated: 13, kind: "raise",
    },
    {
      label: "composite set_text+recolor over 4 targets complex → standard (11 calls)",
      atoms: ["set_text", "recolor"], targetCount: 4, reapply: false, proposed: "complex",
      resolved: "standard", credits: 2, estimated: 11, kind: "downgrade",
    },
  ];

  for (const row of rows) {
    it(row.label, () => {
      const result = resolveCostTier({
        atoms: row.atoms,
        targetCount: row.targetCount,
        needsTemplateReapply: row.reapply,
        proposed: row.proposed,
      });
      expect(result.proposed).toBe(row.proposed);
      expect(result.resolved).toBe<ChatCostTier>(row.resolved);
      expect(result.credits).toBe(row.credits);
      expect(result.estimatedCalls).toBe(row.estimated);
      const text = result.warnings.join(" ");
      if (row.kind === "none") {
        expect(result.warnings).toEqual([]);
      } else if (row.kind === "downgrade") {
        expect(text).toContain(`downgraded to "${row.resolved}"`);
        expect(text).toContain("§23.5");
      } else if (row.kind === "raise") {
        expect(text).toContain(`raised to "${row.resolved}"`);
        expect(text).toContain("§5.2");
      } else {
        expect(text).toContain("stop cleanly");
      }
    });
  }

  it("estimates mirror the emitted steps + §24.2 run tail + reapply pair", () => {
    // §24.2: 2 mutating steps (restyle × Subhead + component place) + 3 tail.
    const classification = validClassification(classification242);
    const steps = buildChatEditSteps(classification, ["restyle", "add_component"], null);
    expect(steps.steps).toHaveLength(2);
    const tier = resolveCostTier({
      atoms: ["restyle", "add_component"],
      targetCount: classification.target_layers.length,
      needsTemplateReapply: classification.needs_template_reapply,
      proposed: "quick",
    });
    expect(tier.estimatedCalls).toBe(steps.steps.length + 3);
  });

  it("§5.2 caps table pinned (quick 6 / standard 12 / complex 24)", () => {
    expect(TIER_TOOL_CALL_CAPS).toEqual({ quick: 6, standard: 12, complex: 24 });
  });
});

// ---------------------------------------------------------------------------
// creditsForCostTier — §14.1 billing-policy mapping
// ---------------------------------------------------------------------------

describe("creditsForCostTier (§14.1: quick 1 / standard 2 / complex 5)", () => {
  it("maps every chat-edit tier to its credit price", () => {
    expect(creditsForCostTier("quick")).toBe(1);
    expect(creditsForCostTier("standard")).toBe(2);
    expect(creditsForCostTier("complex")).toBe(5);
  });

  it("cost tiers are the three §23.5 values (premium/max are §5.2 multipliers)", () => {
    expect(chatCostTierSchema.options).toEqual(["quick", "standard", "complex"]);
  });
});

// ---------------------------------------------------------------------------
// buildChatEditSteps — §24.2 trace assembly
// ---------------------------------------------------------------------------

describe("buildChatEditSteps", () => {
  it("§24.2: restyle binds the target, add_component keeps its scoped args", () => {
    const classification = validClassification(classification242);
    const outcome = buildChatEditSteps(classification, ["restyle", "add_component"], null);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.steps).toEqual([
      { tool: "style_apply", args: { size: 30, layer: "Subhead" } },
      {
        tool: "component_place",
        args: { id: "offer-badge@2", position: "top-right", vars: { label: "20% OFF" } },
      },
    ]);
  });

  it("emits one step per target for layer-targeted atoms", () => {
    const classification = validClassification({
      action: "recolor",
      target_layers: ["Headline", "Subhead", "Photo"],
      args: { color: "#D96C3B" },
    });
    const outcome = buildChatEditSteps(classification, ["recolor"], null);
    expect(outcome.steps).toHaveLength(3);
    for (const step of outcome.steps) {
      expect(step.tool).toBe("style_apply");
    }
    const first = outcome.steps[0]?.args;
    expect(first?.["layer"]).toBe("Headline");
    expect(first?.["color"]).toBe("#D96C3B");
  });

  it("canvas-level resize without targets emits a single step with no layer binding", () => {
    const classification = validClassification({
      action: "resize",
      target_layers: [],
      args: { canvas: { width: 1080, height: 1920 } },
    });
    const outcome = buildChatEditSteps(classification, ["resize"], null);
    expect(outcome.steps).toEqual([
      { tool: "layer_ops", args: { canvas: { width: 1080, height: 1920 } } },
    ]);
  });

  it("scoped args win over flat args; flat atoms share the remainder", () => {
    const classification = validClassification({
      action: "set_text",
      target_layers: ["Headline"],
      args: { keep: "shared", set_text: { text: "New copy" } },
    });
    const outcome = buildChatEditSteps(classification, ["set_text"], null);
    expect(outcome.steps).toEqual([{ tool: "text_set", args: { text: "New copy", layer: "Headline" } }]);
  });

  it("clarify emits one ask_user step with the tool's 1-4 option cap", () => {
    const classification = validClassification({
      action: "clarify",
      target_layers: [],
      args: {
        candidates: ["Headline", "Subhead", "Headline 2", "Subhead 2", "Badge", "Logo"],
        question: "Which text layer should be smaller?",
      },
    });
    const outcome = buildChatEditSteps(
      classification,
      ["clarify"],
      { question: "Which text layer should be smaller?", candidates: classification.args.candidates as string[] },
    );
    expect(outcome.steps).toEqual([
      {
        tool: "ask_user",
        args: {
          question: "Which text layer should be smaller?",
          options: ["Headline", "Subhead", "Headline 2", "Subhead 2"],
        },
      },
    ]);
    expect(outcome.warnings.join(" ")).toContain("dropped from the question card");
    expect(MAX_ASK_USER_OPTIONS).toBe(4);
    expect(MAX_ASK_USER_OPTION_CHARS).toBe(120); // ask_user tool contract parity
  });

  it("maps every atom to its §6 primary tool", () => {
    const expected: Readonly<Record<string, string>> = {
      set_text: "text_set",
      replace_field: "template_fill",
      restyle: "style_apply",
      move: "layer_ops",
      resize: "layer_ops",
      remove_layer: "layer_ops",
      recolor: "style_apply",
      add_component: "component_place",
      export: "export_document",
      clarify: "ask_user",
    };
    expect(ACTION_PRIMARY_TOOLS).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// buildChatEditMiniPlan — §5.5 wrap (buildRepairMiniPlan precedent)
// ---------------------------------------------------------------------------

describe("buildChatEditMiniPlan", () => {
  const classification = validClassification(classification242);
  const steps = buildChatEditSteps(classification, ["restyle", "add_component"], null).steps;

  it("wraps the steps into a §5.5-valid edit_layers plan at the tier", () => {
    const mini = buildChatEditMiniPlan({
      classification,
      atoms: ["restyle", "add_component"],
      steps,
      tier: "quick",
      clarify: null,
    });
    expect(mini.ok).toBe(true);
    if (mini.ok) {
      expect(mini.plan.intent).toBe("edit_layers");
      expect(mini.plan.template).toBeNull();
      expect(mini.plan.model_tier).toBe("quick");
      expect(mini.plan.steps).toHaveLength(2);
      expect(mini.plan.notes_for_user).toContain("Chat edit (§23.5)");
      expect(mini.plan.notes_for_user).toContain("Subhead");
    }
  });

  it("single-atom export/resize classify as those §5.5 intents", () => {
    const exportPlan = buildChatEditMiniPlan({
      classification: validClassification({
        action: "export",
        target_layers: [],
        args: { format: "png" },
      }),
      atoms: ["export"],
      steps: buildChatEditSteps(validClassification({ action: "export", target_layers: [], args: { format: "png" } }), ["export"], null).steps,
      tier: "quick",
      clarify: null,
    });
    expect(exportPlan.ok && exportPlan.plan.intent).toBe("export");

    const resizePlan = buildChatEditMiniPlan({
      classification: validClassification({
        action: "resize",
        target_layers: [],
        args: { canvas: { width: 1080, height: 1920 } },
      }),
      atoms: ["resize"],
      steps: buildChatEditSteps(
        validClassification({
          action: "resize",
          target_layers: [],
          args: { canvas: { width: 1080, height: 1920 } },
        }),
        ["resize"],
        null,
      ).steps,
      tier: "quick",
      clarify: null,
    });
    expect(resizePlan.ok && resizePlan.plan.intent).toBe("resize");
  });

  it("carries the reapply flag + question into notes_for_user", () => {
    const withReapply = buildChatEditMiniPlan({
      classification: validClassification({ needs_template_reapply: true }),
      atoms: ["set_text"],
      steps: buildChatEditSteps(validClassification({ needs_template_reapply: true }), ["set_text"], null).steps,
      tier: "quick",
      clarify: null,
    });
    expect(withReapply.ok && withReapply.plan.notes_for_user).toContain("Template reapply needed");

    const withQuestion = buildChatEditMiniPlan({
      classification: validClassification({
        action: "clarify",
        target_layers: [],
        args: { candidates: ["Headline"], question: "Which layer?" },
      }),
      atoms: ["clarify"],
      steps: [{ tool: "ask_user", args: { question: "Which layer?", options: ["Headline"] } }],
      tier: "quick",
      clarify: { question: "Which layer?", candidates: ["Headline"] },
    });
    expect(withQuestion.ok && withQuestion.plan.notes_for_user).toContain("Which layer?");
  });
});

// ---------------------------------------------------------------------------
// ChatEditClassifier — the §24.2 worked example, end to end
// ---------------------------------------------------------------------------

describe("ChatEditClassifier: §24.2 worked example (quick tier, 1 credit)", () => {
  it("classifies restyle + add_component and emits the §5.5 mini plan", async () => {
    const { model, service } = serviceWith([
      { text: JSON.stringify(classification242), usage: { tokensIn: 420, tokensOut: 38, cacheHits: 12 } },
    ]);
    const result = await service.classify(input242);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toEqual<readonly ChatEditAction[]>(["restyle", "add_component"]);
      expect(result.costTier).toBe<ChatCostTier>("quick");
      expect(result.proposedTier).toBe("quick");
      expect(result.credits).toBe(1); // §24.2 "charge 1 credit"
      expect(result.needsTemplateReapply).toBe(false);
      expect(result.warnings).toEqual([]); // no downgrade: quick IS the cheapest fit
      expect(result.clarify).toBeNull();
      expect(result.attempts).toBe(1);
      expect(result.usage).toEqual({ calls: 1, tokensIn: 420, tokensOut: 38, cacheHits: 12 });
      expect(result.plan.intent).toBe("edit_layers");
      expect(result.plan.template).toBeNull(); // §23.5: targeted edit, no reapply
      expect(result.plan.model_tier).toBe("quick");
      // §24.2 trace: subhead 36 -> 30pt …
      const first = result.plan.steps[0];
      expect(first?.tool).toBe("style_apply");
      expect(first?.args.layer).toBe("Subhead");
      expect(first?.args.size).toBe(30);
      // … and the badge with label "20% OFF"
      const second = result.plan.steps[1];
      expect(second?.tool).toBe("component_place");
      expect(second?.args.id).toBe("offer-badge@2");
      expect((second?.args.vars as { label?: string }).label).toBe("20% OFF");
      expect(second?.args.position).toBe("top-right");
    }
    expect(model.prompts).toHaveLength(1);
  });

  it("accepts fenced model output (§23.5 'JSON only' still fences)", async () => {
    const result = await classifyWith([
      { text: `\`\`\`json\n${JSON.stringify(classification242)}\n\`\`\`` },
    ]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ChatEditClassifier — ambiguity → clarify with candidates (§23.5)
// ---------------------------------------------------------------------------

describe("ChatEditClassifier: ambiguity → clarify", () => {
  const clarifyOutput = {
    action: "clarify",
    target_layers: [],
    args: { candidates: ["Headline", "Subhead"], question: "Which text layer should be smaller?" },
    cost_tier: "quick",
    needs_template_reapply: false,
  };

  it("surfaces the question + candidates and plans a single ask_user step", async () => {
    const result = await classifyWith([{ text: JSON.stringify(clarifyOutput) }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clarify).toEqual({
        question: "Which text layer should be smaller?",
        candidates: ["Headline", "Subhead"],
      });
      expect(result.costTier).toBe("quick");
      expect(result.credits).toBe(1);
      expect(result.plan.steps).toEqual([
        {
          tool: "ask_user",
          args: { question: "Which text layer should be smaller?", options: ["Headline", "Subhead"] },
        },
      ]);
    }
  });

  it("downgrades a complex-tier clarify to quick (a question is 1 call)", async () => {
    const result = await classifyWith([
      { text: JSON.stringify({ ...clarifyOutput, cost_tier: "complex" }) },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.costTier).toBe("quick");
      expect(result.credits).toBe(1);
      expect(result.warnings.join(" ")).toContain('downgraded to "quick"');
    }
  });
});

// ---------------------------------------------------------------------------
// ChatEditClassifier — tier guard through the service
// ---------------------------------------------------------------------------

describe("ChatEditClassifier: cost-tier guard through classify()", () => {
  it("§23.5 cheapest-action: heavy proposal for a targeted ask downgrades + warns", async () => {
    const result = await classifyWith([
      {
        text: JSON.stringify({
          action: "set_text",
          target_layers: ["Headline"],
          args: { text: "Roasted this morning" },
          cost_tier: "complex",
          needs_template_reapply: false,
        }),
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposedTier).toBe("complex");
      expect(result.costTier).toBe("quick");
      expect(result.credits).toBe(1);
      expect(result.plan.model_tier).toBe("quick");
      expect(result.warnings.join(" ")).toContain("downgraded");
    }
  });

  it("a workload over the proposed cap raises the tier so the run completes", async () => {
    const targets = Array.from({ length: 8 }, (_, i) => `L${i}`);
    const layers = targets.map((name) => ({ name, kind: "text" }));
    const result = await classifyWith(
      [
        {
          text: JSON.stringify({
            action: "set_text",
            target_layers: targets,
            args: { text: "New copy" },
            cost_tier: "quick",
            needs_template_reapply: false,
          }),
        },
      ],
      { ...input242, layerSummary: layers },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.costTier).toBe("standard");
      expect(result.credits).toBe(2);
      expect(result.plan.steps).toHaveLength(8);
      expect(result.warnings.join(" ")).toContain("raised");
    }
  });
});

// ---------------------------------------------------------------------------
// ChatEditClassifier — §5.1 retry-on-invalid
// ---------------------------------------------------------------------------

describe("ChatEditClassifier: one retry with issues attached (§5.1)", () => {
  it("retries non-JSON output once, then succeeds", async () => {
    const { model, service } = serviceWith([
      { text: "I would say restyle, maybe?" },
      { text: JSON.stringify(classification242), usage: { tokensIn: 100, tokensOut: 20 } },
    ]);
    const result = await service.classify(input242);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1 + PLAN_RETRY_LIMIT);
      expect(result.usage.calls).toBe(2);
    }
    expect(model.prompts).toHaveLength(2);
    const retry = model.prompts[1] ?? "";
    expect(retry.startsWith(model.prompts[0] ?? "")).toBe(true);
    expect(retry).toContain("rejected by validation");
    expect(retry).toContain("not valid JSON");
  });

  it("retries schema violations (premium cost_tier) with the zod issue attached", async () => {
    const { model, service } = serviceWith([
      { text: JSON.stringify({ ...classification242, cost_tier: "premium" }) },
      { text: JSON.stringify(classification242) },
    ]);
    const result = await service.classify(input242);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
    }
    const retry = model.prompts[1] ?? "";
    expect(retry).toContain("classification.cost_tier");
  });

  it("retries invented targets, invented component ids, empty targets, bad clarify", async () => {
    const cases: readonly [string, Record<string, unknown>, RegExp][] = [
      ["invented target", { action: "restyle", target_layers: ["Sub-head"] }, /invented target/],
      ["invented component", {
        action: "add_component",
        target_layers: [],
        args: { id: "mega-badge@9" },
      }, /invented component id/],
      ["empty targets", { action: "restyle", target_layers: [] }, /need named target layers/],
      ["clarify without candidates", {
        action: "clarify",
        target_layers: [],
        args: { question: "Which?" },
      }, /args\.candidates/],
    ];
    for (const [label, patch, issueRe] of cases) {
      const { model, service } = serviceWith([
        { text: JSON.stringify({ ...classification242, ...patch }) },
        { text: JSON.stringify(classification242) },
      ]);
      const result = await service.classify(input242);
      expect(result.ok).toBe(true); // recovered on the one retry
      expect(model.prompts).toHaveLength(2);
      const retry = model.prompts[1] ?? "";
      expect(retry).toMatch(issueRe);
      if (result.ok) {
        expect(result.attempts).toBe(2);
      }
    }
  });

  it("a full-regeneration action never enters the enum — schema rejects it", async () => {
    const { model, service } = serviceWith([
      { text: JSON.stringify({ ...classification242, action: "regenerate" }) },
      { text: JSON.stringify(classification242) },
    ]);
    const result = await service.classify(input242);
    expect(result.ok).toBe(true);
    const retry = model.prompts[1] ?? "";
    expect(retry).toContain("not one of the §23.5 actions");
  });

  it("fails plan_invalid after the retry, with sanitized issues + excerpt", async () => {
    const longRaw = `x`.repeat(600);
    const { model, service } = serviceWith([{ text: longRaw }, { text: "{" }]);
    const result = await service.classify(input242);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(CHAT_EDIT_INVALID_CODE);
      expect(CHAT_EDIT_INVALID_CODE).toBe("plan_invalid");
      expect(result.retryable).toBe(false);
      expect(result.attempts).toBe(1 + PLAN_RETRY_LIMIT);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join(" ")).toContain("§23.5");
      expect(result.rawExcerpt.length).toBeLessThanOrEqual(500); // §5.7 excerpt budget
      expect(result.usage.calls).toBe(2);
    }
    expect(model.prompts).toHaveLength(2);
  });

  it("fails plan_invalid when the model keeps inventing targets", async () => {
    const result = await classifyWith([
      { text: JSON.stringify({ ...classification242, target_layers: ["Ghost"] }) },
      { text: JSON.stringify({ ...classification242, target_layers: ["Ghost 2"] }) },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("plan_invalid");
      expect(result.issues.join(" ")).toContain("invented target");
    }
  });
});

// ---------------------------------------------------------------------------
// ChatEditClassifier — provider seam failures + §3.4 abort
// ---------------------------------------------------------------------------

describe("ChatEditClassifier: provider + abort handling", () => {
  it("maps a thrown seam error to provider_unhealthy without leaking internals", async () => {
    const { model, service } = serviceWith([
      { throws: new Error("connect ECONNREFUSED gemini-secret-token-9f2") },
    ]);
    const result = await service.classify(input242);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("provider_unhealthy");
      expect(result.retryable).toBe(true);
      const envelope = `${result.message} ${result.hint}`;
      expect(envelope).not.toContain("gemini");
      expect(envelope).not.toContain("ECONNREFUSED");
      expect(envelope).not.toContain("secret");
      expect(result.issues).toEqual([]);
      expect(result.attempts).toBe(1);
    }
    expect(model.prompts).toHaveLength(1);
  });

  it("returns run_timeout before any call when the signal is already aborted", async () => {
    const { model, service } = serviceWith([]);
    const result = await service.classify({ ...input242, signal: { aborted: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("run_timeout");
      expect(result.attempts).toBe(0);
    }
    expect(model.prompts).toHaveLength(0);
  });

  it("maps AbortError from the seam to run_timeout", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const result = await classifyWith([{ throws: abortError }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("run_timeout");
      expect(result.retryable).toBe(false);
    }
  });

  it("sanitizes flaky provider telemetry (NaN/negative → 0)", async () => {
    const result = await classifyWith([
      {
        text: JSON.stringify(classification242),
        usage: { tokensIn: Number.NaN, tokensOut: -5, cacheHits: 2 },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual({ calls: 1, tokensIn: 0, tokensOut: 0, cacheHits: 2 });
    }
  });

  it("worker wiring bugs fail fast with field paths only (§15.3)", async () => {
    const { model, service } = serviceWith([]);
    await expect(
      service.classify({ userRequest: "", layerSummary: [], catalog: {} }),
    ).rejects.toThrow(/worker wiring: userRequest/);
    const rows = Array.from({ length: CHAT_EDIT_MAX_LAYER_ROWS + 1 }, (_, i) => ({ name: `L${i}` }));
    await expect(
      service.classify({ ...input242, layerSummary: rows }),
    ).rejects.toThrow(/worker wiring: layerSummary/);
    expect(model.prompts).toHaveLength(0);
  });
});
