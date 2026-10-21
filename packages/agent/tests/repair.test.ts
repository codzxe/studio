// W6-F — §23.4 repair planner: prompt verbatim pin, tool allow-list, blocker/major
// filtering, ≤5 cap, impossible-fix warnings, one formatting retry, and the
// W6-B executor step contract (mini plan.steps).
//
// The fake model scripts raw replies; every test is deterministic, offline.
import { describe, expect, it } from "vitest";
import { type PlanStep, planSchema, planStepSchema } from "../src/plan.js";
import {
  MAX_REPAIR_INPUT_ISSUES,
  type NormalizedRepairIssue,
  REPAIR_MINI_PLAN_NOTE,
  REPAIR_PLANNING_CONTRACT,
  REPAIR_PLAN_INVALID_CODE,
  REPAIR_RETRY_INSTRUCTION,
  REPAIR_TOOLS,
  type RepairIssueInput,
  type RepairModelLike,
  type RepairModelResult,
  type RepairPlan,
  RepairPlanner,
  buildFixList,
  buildRepairMiniPlan,
  isBlockedLayerOp,
  parseRepairPlanRaw,
  planRepairs,
} from "../src/repair/planner.js";
import {
  MAX_REPAIR_FIXES,
  REPAIR_FIXES_HEADER,
  type RepairContext,
  type RepairFix,
  buildRepairPrompt,
  stripControlChars,
} from "../src/repair/prompt.js";

// --- §23.4 skeleton, inlined from docs/BUILD_PROMPT.md so the prompt is pinned
// byte-for-byte against the SPEC, independently of the source constants.

const SPEC_INTRO = "A validated render has issues. Apply the minimum fixes; change nothing else.";

const SPEC_RULES = [
  "Rules:",
  "- One fix at a time, smallest tool that works (text_set, layer_ops, style_apply, layout_apply).",
  "- Do not restructure, rename, add or delete layers unless a fix explicitly requires it.",
  "- After applying, call render_preview and validate_document; reply with JSON:",
  '  {"applied":[{"issue":"code","tool":"...","result":"ok|failed","note":"..."}]}',
  "- If a fix is impossible with available tools, say so and propose the closest valid",
  "  alternative; never leave the document in a worse state than before.",
].join("\n");

// --- Fixtures -------------------------------------------------------------------------

const CONTEXT: RepairContext = {
  layerTree: "Background (fill) / Headline (text 88pt) / Subhead (text 36pt)",
  manifest: "instagram-post@3 {slots: headline, subhead, photo}",
  palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  validatorReport: '{"blockers":1,"majors":1,"minors":2}',
};

/** §11.1 validator-shaped blocker (with `message`, without critic keys). */
const BLOCKER = {
  level: "blocker",
  code: "contrast_body",
  layer: "Subhead",
  message: "body contrast 2.1:1 < 4.5:1",
  fix: "text_set Subhead #3B2A20",
} as const satisfies RepairIssueInput;

/** §23.3 critic-shaped major (severity/observation, not level/message). */
const MAJOR = {
  severity: "major",
  code: "weak_hierarchy",
  layer: "Subhead",
  observation: "Subhead competes with the headline.",
  fix: "Reduce Subhead to 30pt and opacity 80%.",
} as const satisfies RepairIssueInput;

const MINOR_VALIDATOR = {
  level: "minor",
  code: "safe_area",
  fix: "nudge Subhead 4px inside the safe area",
} as const satisfies RepairIssueInput;

const MINOR_CRITIC = {
  severity: "minor",
  code: "balance",
  layer: "Photo",
  observation: "slightly left-heavy",
  fix: "shift Photo 8px right",
} as const satisfies RepairIssueInput;

const vBlocker = (code: string): RepairIssueInput => ({
  level: "blocker",
  code,
  layer: "Headline",
  fix: `fix ${code}`,
});
const vMajor = (code: string): RepairIssueInput => ({
  level: "major",
  code,
  layer: "Headline",
  fix: `fix ${code}`,
});
const vMinor = (code: string): RepairIssueInput => ({
  level: "minor",
  code,
  layer: "Headline",
  fix: `fix ${code}`,
});

const HAPPY_REPLY = JSON.stringify({
  applied: [
    {
      issue: "contrast_body",
      tool: "text_set",
      args: { layer: "Subhead", text: "Open 7–5 · Main St", color: "#3B2A20" },
    },
    { issue: "weak_hierarchy", tool: "style_apply", args: { layer: "Subhead", opacity: 0.8 } },
  ],
});

/** The §23.4 prompt for [BLOCKER, MAJOR] exactly as planRepairs must send it. */
function expectedPrompt(fixes: readonly RepairFix[]): string {
  return [
    SPEC_INTRO,
    "",
    "FIXES:",
    JSON.stringify(fixes),
    "",
    `CONTEXT: ${JSON.stringify({
      layerTree: CONTEXT.layerTree,
      manifest: CONTEXT.manifest,
      palette: CONTEXT.palette,
      validatorReport: CONTEXT.validatorReport,
    })}`,
    "",
    SPEC_RULES,
  ].join("\n");
}

/** The FIXES json array line of a captured prompt. */
function fixesLine(prompt: string): string {
  const lines = prompt.split("\n");
  const idx = lines.indexOf(REPAIR_FIXES_HEADER);
  return lines[idx + 1] ?? "";
}

// --- Fakes ----------------------------------------------------------------------------

class FakeRepairModel implements RepairModelLike {
  readonly prompts: string[] = [];
  readonly signals: AbortSignal[] = [];
  private next = 0;

  constructor(private readonly replies: readonly (string | RepairModelResult)[]) {}

  complete(prompt: string, signal: AbortSignal): Promise<RepairModelResult> {
    this.prompts.push(prompt);
    this.signals.push(signal);
    const scripted = this.replies[this.next];
    this.next += 1;
    if (scripted === undefined) {
      return Promise.reject(new Error("fake: no scripted reply left"));
    }
    return Promise.resolve(typeof scripted === "string" ? { raw: scripted } : scripted);
  }
}

class FailingModel implements RepairModelLike {
  constructor(private readonly error: Error) {}
  complete(): Promise<RepairModelResult> {
    return Promise.reject(this.error);
  }
}

// --- prompt.ts: §23.4 verbatim ---------------------------------------------------------

describe("buildRepairPrompt: §23.4 verbatim", () => {
  it("renders the exact spec skeleton with FIXES and CONTEXT substituted", () => {
    const prompt = buildRepairPrompt({
      fixes: [
        { code: "contrast_body", layer: "Subhead", fix: "text_set Subhead #3B2A20" },
        {
          code: "weak_hierarchy",
          layer: "Subhead",
          fix: "Reduce Subhead to 30pt and opacity 80%.",
        },
      ],
      context: CONTEXT,
    });
    expect(prompt).toBe(
      expectedPrompt([
        { code: "contrast_body", layer: "Subhead", fix: "text_set Subhead #3B2A20" },
        {
          code: "weak_hierarchy",
          layer: "Subhead",
          fix: "Reduce Subhead to 30pt and opacity 80%.",
        },
      ]),
    );
  });

  it("carries the four context parts even when manifest/palette are absent", () => {
    const prompt = buildRepairPrompt({
      fixes: [{ code: "contrast_body", fix: "text_set Subhead #3B2A20" }],
      context: { layerTree: "A / B", validatorReport: "" },
    });
    const contextJson = JSON.parse(
      prompt.split("\nCONTEXT: ")[1]?.split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(contextJson.layerTree).toBe("A / B");
    expect(contextJson.manifest).toBe("none");
    expect(contextJson.palette).toEqual([]);
    expect(contextJson.validatorReport).toBe("");
    const fixes = JSON.parse(fixesLine(prompt)) as { layer?: string }[];
    expect(fixes[0]?.layer).toBeUndefined();
  });

  it("renders an empty FIXES array when there is nothing to fix", () => {
    const prompt = buildRepairPrompt({ fixes: [], context: CONTEXT });
    expect(fixesLine(prompt)).toBe("[]");
  });

  it("strips §15.3 control characters from everything it embeds", () => {
    const prompt = buildRepairPrompt({
      fixes: [{ code: "contrast_body", layer: "Sub\u202EBad", fix: "do\u0000 it" }],
      context: { ...CONTEXT, layerTree: "a\u200Bb", validatorReport: "x\u0008y" },
    });
    expect(prompt).toContain("SubBad");
    expect(prompt).toContain("do it");
    const contextJson = prompt.split("\nCONTEXT: ")[1]?.split("\n")[0] ?? "";
    expect(contextJson).toContain("ab");
    expect(contextJson).not.toContain("\\u202e");
    expect(contextJson).not.toContain("\\u0008");
  });

  it("rejects more than 5 fixes (§23.3 cap, belt-and-braces) and invalid shapes", () => {
    const six: RepairFix[] = Array.from({ length: 6 }, (_, i) => ({
      code: `c_${i}`,
      fix: "f",
    }));
    expect(() => buildRepairPrompt({ fixes: six, context: CONTEXT })).toThrow(
      /buildRepairPrompt input invalid/,
    );
    expect(() => buildRepairPrompt({ fixes: [{ code: "", fix: "f" }], context: CONTEXT })).toThrow(
      /buildRepairPrompt input invalid/,
    );
    expect(() =>
      buildRepairPrompt({ fixes: [], context: { layerTree: "", validatorReport: "" } }),
    ).toThrow(/buildRepairPrompt input invalid/);
  });

  it("stripControlChars keeps tabs/newlines and normalises CRLF (§15.3)", () => {
    expect(stripControlChars("a\r\nb\u0000c\u200Bd\te")).toBe("a\nbcd\te");
    expect(stripControlChars("  trim  ")).toBe("trim");
  });
});

// --- planner.ts: pure policy pieces ----------------------------------------------------

describe("buildFixList: §11.2/§23.3 policy", () => {
  it("drops minors, ranks blockers first, stable within a level", () => {
    const list = buildFixList([
      { severity: "major", code: "m1", fix: "f" },
      { severity: "blocker", code: "b1", fix: "f" },
      { severity: "minor", code: "x1", fix: "f" },
      { severity: "major", code: "m2", fix: "f" },
      { severity: "blocker", code: "b2", fix: "f" },
    ]);
    expect(list.fixes.map((fix) => fix.code)).toEqual(["b1", "b2", "m1", "m2"]);
    expect(list.droppedMinorCount).toBe(1);
    expect(list.deferredCount).toBe(0);
    expect(list.warnings.some((w) => w.includes("1 minor issue(s) dropped"))).toBe(true);
  });

  it("caps at 5 fixes and documents the deferred overflow", () => {
    const issues: NormalizedRepairIssue[] = [
      { severity: "blocker", code: "b1", fix: "f" },
      { severity: "blocker", code: "b2", fix: "f" },
      { severity: "blocker", code: "b3", fix: "f" },
      { severity: "blocker", code: "b4", fix: "f" },
      { severity: "major", code: "m1", fix: "f" },
      { severity: "major", code: "m2", fix: "f" },
      { severity: "major", code: "m3", fix: "f" },
    ];
    const list = buildFixList(issues);
    expect(list.fixes).toHaveLength(MAX_REPAIR_FIXES);
    expect(list.fixes.map((fix) => fix.code)).toEqual(["b1", "b2", "b3", "b4", "m1"]);
    expect(list.deferredCount).toBe(2);
    expect(list.warnings.some((w) => w.includes("m2, m3"))).toBe(true);
  });

  it("returns an empty list for minors-only input", () => {
    const list = buildFixList([{ severity: "minor", code: "x", fix: "f" }]);
    expect(list.fixes).toEqual([]);
    expect(list.droppedMinorCount).toBe(1);
  });
});

describe("repair tool allow-list and add/delete ban", () => {
  it("pins the §23.4 tool set exactly", () => {
    expect(REPAIR_TOOLS).toEqual(["text_set", "layer_ops", "style_apply", "layout_apply"]);
  });

  it("blocks layer_ops add/delete ops, allows the in-place ops", () => {
    for (const op of [
      "create_group",
      "duplicate",
      "group",
      "delete_layer",
      "remove_layer",
      "add_layer",
      "new_group",
    ]) {
      expect(isBlockedLayerOp(op)).toBe(true);
    }
    for (const op of ["rename", "reorder", "align", "set_props"]) {
      expect(isBlockedLayerOp(op)).toBe(false);
    }
  });

  it("REPAIR_PLAN_INVALID_CODE is the plan_invalid swap-point until the catalog grows", () => {
    expect(REPAIR_PLAN_INVALID_CODE).toBe("plan_invalid");
  });
});

describe("parseRepairPlanRaw", () => {
  it("accepts bare JSON, fenced JSON and prose-wrapped JSON", () => {
    const good = JSON.stringify({
      applied: [{ issue: "contrast_body", tool: "text_set", args: { text: "hi" } }],
    });
    expect(parseRepairPlanRaw(good).ok).toBe(true);
    expect(parseRepairPlanRaw(`\`\`\`json\n${good}\n\`\`\``).ok).toBe(true);
    expect(parseRepairPlanRaw(`Sure! ${good} hope that helps`).ok).toBe(true);
  });

  it("defaults an omitted applied array to [] (§23.3 tolerance precedent)", () => {
    const parsed = parseRepairPlanRaw("{}");
    expect(parsed.ok && parsed.value.applied).toEqual([]);
  });

  it("rejects empty/non-JSON replies with issues safe to attach to a retry", () => {
    const empty = parseRepairPlanRaw("   ");
    expect(!empty.ok && empty.reason).toBe("empty");
    const notJson = parseRepairPlanRaw("I cannot do that, sorry");
    expect(!notJson.ok && notJson.reason).toBe("not_json");
    expect(!notJson.ok && notJson.issues).toEqual(["the reply was not JSON"]);
  });

  it("rejects non-allow-listed tools and missing tools at the schema level", () => {
    const badTool = parseRepairPlanRaw(
      JSON.stringify({ applied: [{ issue: "c", tool: "template_apply", args: {} }] }),
    );
    expect(badTool.ok).toBe(false);
    if (!badTool.ok) {
      expect(badTool.reason).toBe("schema");
      expect(badTool.issues.join("\n")).toContain("applied.0.tool");
    }
    const noTool = parseRepairPlanRaw(JSON.stringify({ applied: [{ issue: "c", args: {} }] }));
    expect(noTool.ok).toBe(false);
  });

  it("rejects layer_ops add/delete ops at the schema level", () => {
    const parsed = parseRepairPlanRaw(
      JSON.stringify({ applied: [{ issue: "c", tool: "layer_ops", args: { op: "duplicate" } }] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.join("\n")).toContain("duplicate");
      expect(parsed.issues.join("\n")).toContain("§23.4");
    }
  });

  it("accepts the §23.4 rule-3 reply shape (result/note) and the impossible shape", () => {
    const replyShape = parseRepairPlanRaw(
      JSON.stringify({ applied: [{ issue: "c", tool: "text_set", result: "ok", note: "done" }] }),
    );
    expect(replyShape.ok).toBe(true);
    const impossible = parseRepairPlanRaw(
      JSON.stringify({
        applied: [{ issue: "c", impossible: true, alternative: "try style_apply" }],
      }),
    );
    expect(impossible.ok).toBe(true);
  });

  it("rejects more than 10 applied entries (parse headroom)", () => {
    const applied = Array.from({ length: 11 }, () => ({ issue: "c", tool: "text_set", args: {} }));
    const parsed = parseRepairPlanRaw(JSON.stringify({ applied }));
    expect(parsed.ok).toBe(false);
  });
});

// --- planner.ts: planRepairs end-to-end --------------------------------------------------

describe("planRepairs: happy path", () => {
  it("sends the §23.4 prompt verbatim plus the planning contract, builds executor steps", async () => {
    const model = new FakeRepairModel([HAPPY_REPLY]);
    const result = await planRepairs({
      issues: [MAJOR, BLOCKER, MINOR_VALIDATOR, MINOR_CRITIC],
      context: CONTEXT,
      model,
    });
    if (!result.ok) throw new Error(result.message);
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toBe(
      expectedPrompt([
        { code: "contrast_body", layer: "Subhead", fix: "text_set Subhead #3B2A20" },
        {
          code: "weak_hierarchy",
          layer: "Subhead",
          fix: "Reduce Subhead to 30pt and opacity 80%.",
        },
      ]) + REPAIR_PLANNING_CONTRACT,
    );
    expect(result.value.steps).toEqual([
      {
        tool: "text_set",
        args: { layer: "Subhead", text: "Open 7–5 · Main St", color: "#3B2A20" },
      },
      { tool: "style_apply", args: { layer: "Subhead", opacity: 0.8 } },
    ]);
    expect(result.value.stepIssues).toEqual(["contrast_body", "weak_hierarchy"]);
    expect(result.value.modelCalls).toBe(1);
    expect(result.value.warnings.some((w) => w.includes("2 minor issue(s) dropped"))).toBe(true);
  });

  it("emits steps that satisfy the §5.5 plan-step schema (W6-B executor contract)", async () => {
    const result = await planRepairs({
      issues: [BLOCKER, MAJOR],
      context: CONTEXT,
      model: new FakeRepairModel([HAPPY_REPLY]),
    });
    if (!result.ok) throw new Error(result.message);
    const steps: readonly PlanStep[] = result.value.steps; // type-level contract check
    for (const step of steps) {
      expect(planStepSchema.safeParse(step).success).toBe(true);
    }
  });

  it("tolerates §23.4 rule-3-shaped replies (result/note, no args) as empty-args steps", async () => {
    const reply = JSON.stringify({
      applied: [{ issue: "contrast_body", tool: "text_set", result: "ok", note: "done" }],
    });
    const result = await planRepairs({
      issues: [BLOCKER],
      context: CONTEXT,
      model: new FakeRepairModel([reply]),
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.steps).toEqual([{ tool: "text_set", args: {} }]);
  });

  it("passes the §3.4 signal through to the model, or mints one", async () => {
    const model = new FakeRepairModel([HAPPY_REPLY]);
    const ac = new AbortController();
    await planRepairs({ issues: [BLOCKER], context: CONTEXT, model, signal: ac.signal });
    expect(model.signals[0]).toBe(ac.signal);

    const model2 = new FakeRepairModel([HAPPY_REPLY]);
    await planRepairs({ issues: [BLOCKER], context: CONTEXT, model: model2 });
    expect(model2.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("sums §22 usage across calls and never echoes it into the plan", async () => {
    const model = new FakeRepairModel([
      {
        raw: JSON.stringify({
          applied: [{ issue: "contrast_body", tool: "template_apply", args: {} }],
        }),
        usage: { inputTokens: 100 },
      },
      { raw: HAPPY_REPLY, usage: { inputTokens: 50, outputTokens: 7 } },
    ]);
    const result = await planRepairs({ issues: [BLOCKER], context: CONTEXT, model });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.usage).toEqual({ inputTokens: 150, outputTokens: 7 });
    expect(result.value.steps).toHaveLength(1);
  });

  it("RepairPlanner delegates to planRepairs with its injected model", async () => {
    const planner = new RepairPlanner(new FakeRepairModel([HAPPY_REPLY]));
    const result = await planner.planRepairs({ issues: [BLOCKER, MAJOR], context: CONTEXT });
    if (!result.ok) throw new Error(result.message);
    const plan: RepairPlan = result.value;
    expect(plan.steps).toHaveLength(2);
  });
});

describe("buildRepairMiniPlan: the W6-B executor wrapper", () => {
  it("wraps repair steps into a §5.5-validated Plan the ExecutorService accepts", async () => {
    const result = await planRepairs({
      issues: [BLOCKER, MAJOR],
      context: CONTEXT,
      model: new FakeRepairModel([HAPPY_REPLY]),
    });
    if (!result.ok) throw new Error(result.message);
    const mini = buildRepairMiniPlan(result.value.steps, "standard");
    if (!mini.ok) throw new Error(mini.message);
    expect(mini.value.intent).toBe("edit_layers");
    expect(mini.value.template).toBeNull();
    expect(mini.value.model_tier).toBe("standard");
    expect(mini.value.notes_for_user).toBe(REPAIR_MINI_PLAN_NOTE);
    expect(mini.value.steps).toEqual(result.value.steps);
    // The mini plan itself passes the §5.5 schema (drift guard).
    expect(planSchema.safeParse(mini.value).success).toBe(true);
  });

  it("rejects an empty step list (§5.5 steps min 1) with a typed envelope", () => {
    const empty = buildRepairMiniPlan([], "standard");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe(REPAIR_PLAN_INVALID_CODE);
      expect(empty.message).toContain("repair mini-plan failed the §5.5 schema");
    }
  });
});

describe("planRepairs: blocker/major filtering and the ≤5 cap", () => {
  it("never sends minors to the model (§11.2)", async () => {
    const model = new FakeRepairModel([HAPPY_REPLY]);
    const result = await planRepairs({
      issues: [MINOR_VALIDATOR, MINOR_CRITIC, BLOCKER],
      context: CONTEXT,
      model,
    });
    if (!result.ok) throw new Error(result.message);
    const fixes = JSON.parse(fixesLine(model.prompts[0] ?? "")) as { code: string }[];
    expect(fixes.map((f) => f.code)).toEqual(["contrast_body"]);
    expect(result.value.warnings.some((w) => w.includes("minors never drive repair"))).toBe(true);
  });

  it("caps the FIXES payload at 5 per cycle and documents the deferred tail", async () => {
    const issues: RepairIssueInput[] = [
      vBlocker("b1"),
      vBlocker("b2"),
      vBlocker("b3"),
      vBlocker("b4"),
      vMajor("m1"),
      vMajor("m2"),
      vMajor("m3"),
      vMinor("x1"),
      vMinor("x2"),
    ];
    const reply = JSON.stringify({
      applied: ["b1", "b2", "b3", "b4", "m1"].map((code) => ({
        issue: code,
        tool: "layer_ops",
        args: { op: "reorder", layer: "Headline", position: "front" },
      })),
    });
    const model = new FakeRepairModel([reply]);
    const result = await planRepairs({ issues, context: CONTEXT, model });
    if (!result.ok) throw new Error(result.message);
    expect(JSON.parse(fixesLine(model.prompts[0] ?? ""))).toHaveLength(5);
    expect(result.value.steps).toHaveLength(5);
    expect(result.value.warnings.some((w) => w.includes("deferred to a later cycle: m2, m3"))).toBe(
      true,
    );
    expect(result.value.warnings.some((w) => w.includes("2 minor issue(s) dropped"))).toBe(true);
  });
});

describe("planRepairs: the one §23.3/§5.1 retry", () => {
  it("rejects template_apply once, attaches the validation errors, succeeds on retry", async () => {
    const model = new FakeRepairModel([
      JSON.stringify({ applied: [{ issue: "contrast_body", tool: "template_apply", args: {} }] }),
      JSON.stringify({
        applied: [{ issue: "contrast_body", tool: "text_set", args: { text: "hi" } }],
      }),
    ]);
    const result = await planRepairs({ issues: [BLOCKER], context: CONTEXT, model });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.modelCalls).toBe(2);
    expect(result.value.steps).toEqual([{ tool: "text_set", args: { text: "hi" } }]);
    const retry = model.prompts[1] ?? "";
    expect(retry).toContain(REPAIR_RETRY_INSTRUCTION);
    expect(retry).toContain("Return JSON only. Your previous reply failed schema validation:");
    expect(retry).toContain("applied.0.tool");
    expect(retry).toContain("template_apply");
    expect(retry).toContain(REPAIR_TOOLS.join(", "));
    // The retry rebuilds on the same §23.4 skeleton (prompt reused verbatim).
    expect(
      retry.startsWith(
        expectedPrompt([
          { code: "contrast_body", layer: "Subhead", fix: "text_set Subhead #3B2A20" },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects add/delete layer_ops (duplicate/group/create_group) with a retry", async () => {
    const model = new FakeRepairModel([
      JSON.stringify({
        applied: [
          {
            issue: "contrast_body",
            tool: "layer_ops",
            args: { op: "duplicate", layer: "Subhead" },
          },
        ],
      }),
      JSON.stringify({
        applied: [
          {
            issue: "contrast_body",
            tool: "layer_ops",
            args: { op: "set_props", layer: "Subhead", opacity: 1 },
          },
        ],
      }),
    ]);
    const result = await planRepairs({ issues: [BLOCKER], context: CONTEXT, model });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.modelCalls).toBe(2);
    expect(result.value.steps[0]?.args).toEqual({ op: "set_props", layer: "Subhead", opacity: 1 });
    expect(model.prompts[1] ?? "").toContain("duplicate");
  });

  it("allows the in-place layer_ops (rename/reorder/align/set_props) without a retry", async () => {
    const model = new FakeRepairModel([
      JSON.stringify({
        applied: [
          {
            issue: "contrast_body",
            tool: "layer_ops",
            args: { op: "reorder", layer: "Subhead", position: "front" },
          },
        ],
      }),
    ]);
    const result = await planRepairs({ issues: [BLOCKER], context: CONTEXT, model });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.modelCalls).toBe(1);
  });

  it("fails with repair_plan_invalid after the retry is exhausted", async () => {
    const bad = JSON.stringify({
      applied: [{ issue: "contrast_body", tool: "template_apply", args: {} }],
    });
    const model = new FakeRepairModel([bad, bad]);
    const result = await planRepairs({ issues: [BLOCKER], context: CONTEXT, model });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("plan_invalid");
      expect(result.retryable).toBe(false);
      expect(result.message).toContain("after 2 attempt(s)");
      expect(result.message).toContain("applied.0.tool"); // validation issue attached
      expect(result.hint).toContain(REPAIR_TOOLS.join(", "));
    }
    expect(model.prompts).toHaveLength(2);
  });

  it("retries once on unparseable prose and succeeds on JSON the second time", async () => {
    const model = new FakeRepairModel([
      "I looked at your document and I would improve the balance significantly.",
      HAPPY_REPLY,
    ]);
    const result = await planRepairs({ issues: [BLOCKER, MAJOR], context: CONTEXT, model });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.modelCalls).toBe(2);
  });
});

describe("planRepairs: impossible fixes (§23.4 rule 4)", () => {
  it("documents an impossible fix as a warning with the closest alternative — never a hard fail", async () => {
    const reply = JSON.stringify({
      applied: [
        {
          issue: "contrast_body",
          impossible: true,
          alternative: "darken the backdrop rectangle instead via style_apply",
        },
        { issue: "weak_hierarchy", tool: "style_apply", args: { layer: "Subhead", opacity: 0.8 } },
      ],
    });
    const result = await planRepairs({
      issues: [BLOCKER, MAJOR],
      context: CONTEXT,
      model: new FakeRepairModel([reply]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toHaveLength(1);
    const warning = result.value.warnings.find((w) => w.includes("impossible"));
    expect(warning).toContain("contrast_body");
    expect(warning).toContain("darken the backdrop rectangle instead via style_apply");
  });

  it("documents impossible fixes with no proposed alternative as 'none proposed'", async () => {
    const reply = JSON.stringify({ applied: [{ issue: "contrast_body", impossible: true }] });
    const result = await planRepairs({
      issues: [BLOCKER],
      context: CONTEXT,
      model: new FakeRepairModel([reply]),
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.steps).toEqual([]);
    expect(result.value.warnings.some((w) => w.includes("none proposed"))).toBe(true);
  });
});

describe("planRepairs: defensive folding of validated output", () => {
  it("drops fixes for issue codes that are not in the planned FIXES list (§23.4 'change nothing else')", async () => {
    const reply = JSON.stringify({
      applied: [{ issue: "hallucinated_code", tool: "text_set", args: { text: "surprise" } }],
    });
    const result = await planRepairs({
      issues: [BLOCKER],
      context: CONTEXT,
      model: new FakeRepairModel([reply]),
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.steps).toEqual([]);
    expect(result.value.warnings.some((w) => w.includes("not in the planned FIXES list"))).toBe(
      true,
    );
  });

  it("keeps the first fix for a duplicated issue (§11.3 one issue, one minimal fix)", async () => {
    const reply = JSON.stringify({
      applied: [
        { issue: "contrast_body", tool: "text_set", args: { text: "first" } },
        { issue: "contrast_body", tool: "style_apply", args: { opacity: 0.5 } },
      ],
    });
    const result = await planRepairs({
      issues: [BLOCKER],
      context: CONTEXT,
      model: new FakeRepairModel([reply]),
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.steps).toEqual([{ tool: "text_set", args: { text: "first" } }]);
    expect(result.value.warnings.some((w) => w.includes("more than one fix"))).toBe(true);
  });

  it("accepts an empty applied array as a valid, no-op plan", async () => {
    const result = await planRepairs({
      issues: [BLOCKER],
      context: CONTEXT,
      model: new FakeRepairModel([JSON.stringify({ applied: [] })]),
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.steps).toEqual([]);
    expect(result.value.modelCalls).toBe(1);
  });
});

describe("planRepairs: short-circuits, envelopes and input validation", () => {
  it("short-circuits minors-only input: no model call, no steps", async () => {
    const model = new FakeRepairModel([]);
    const result = await planRepairs({
      issues: [MINOR_VALIDATOR, MINOR_CRITIC],
      context: CONTEXT,
      model,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.steps).toEqual([]);
    expect(result.value.modelCalls).toBe(0);
    expect(model.prompts).toHaveLength(0);
    expect(result.value.warnings.some((w) => w.includes("no blocker/major issues"))).toBe(true);
  });

  it("short-circuits empty issue input the same way", async () => {
    const model = new FakeRepairModel([]);
    const result = await planRepairs({ issues: [], context: CONTEXT, model });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.modelCalls).toBe(0);
  });

  it("maps provider failures to provider_unhealthy without leaking the provider message", async () => {
    const result = await planRepairs({
      issues: [BLOCKER],
      context: CONTEXT,
      model: new FailingModel(new Error("401 unauthorized from providerX")),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("provider_unhealthy");
      expect(result.retryable).toBe(true);
      expect(result.message).not.toContain("401");
      expect(result.message).not.toContain("providerX");
      expect(result.hint).toContain("§5.3");
    }
  });

  it("rethrows AbortError for the caller's §3.4 deadline mapping", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(
      planRepairs({ issues: [BLOCKER], context: CONTEXT, model: new FailingModel(abort) }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects malformed issue rows with a typed envelope (no model call)", async () => {
    const model = new FakeRepairModel([HAPPY_REPLY]);
    const malformed = [{ level: "blocker", code: "x" }] as unknown as RepairIssueInput[];
    const result = await planRepairs({ issues: malformed, context: CONTEXT, model });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(REPAIR_PLAN_INVALID_CODE);
      expect(result.retryable).toBe(false);
      expect(result.message).toContain("repair planning input failed schema validation");
    }
    expect(model.prompts).toHaveLength(0);
  });

  it("rejects invalid context (empty tree, oversized report) with a typed envelope", async () => {
    const result = await planRepairs({
      issues: [BLOCKER],
      context: { layerTree: "", validatorReport: "" },
      model: new FakeRepairModel([HAPPY_REPLY]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("repair context failed schema validation");

    const longReport = await planRepairs({
      issues: [BLOCKER],
      context: { layerTree: "A", validatorReport: "x".repeat(2001) },
      model: new FakeRepairModel([HAPPY_REPLY]),
    });
    expect(longReport.ok).toBe(false);
  });

  it("rejects more than 30 input issues (25 validator + 5 critic headroom)", async () => {
    const issues: RepairIssueInput[] = Array.from({ length: MAX_REPAIR_INPUT_ISSUES + 1 }, (_, i) =>
      vMinor(`x${i}`),
    );
    const result = await planRepairs({
      issues,
      context: CONTEXT,
      model: new FakeRepairModel([HAPPY_REPLY]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(REPAIR_PLAN_INVALID_CODE);
  });
});

describe("REPAIR_PLANNING_CONTRACT", () => {
  it("pins the planning reply shape and the tool ban without touching §23.4 text", () => {
    expect(REPAIR_PLANNING_CONTRACT).toContain("PLANNING CALL");
    expect(REPAIR_PLANNING_CONTRACT).toContain(
      '{"applied":[{"issue":"<fix code>","tool":"text_set|layer_ops|style_apply|layout_apply","args":{}}]}',
    );
    expect(REPAIR_PLANNING_CONTRACT).toContain("impossible");
    expect(REPAIR_PLANNING_CONTRACT).toContain("template_apply");
    expect(REPAIR_PLANNING_CONTRACT).toContain("create_group/duplicate/group");
    expect(REPAIR_PLANNING_CONTRACT).not.toContain("A validated render has issues");
  });
});
