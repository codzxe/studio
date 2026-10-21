// vision-critique.test.ts — vision_critique (§6 row 16, §23.3): parse + repair
// retry, rubric enforcement table, scheme/cap validation, seam injection. The
// critic model is a local recording fake — no network, no engine, deterministic.

import { describe, expect, it } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  CRITIQUE_PARSE_FAILED_CODE,
  type CriticModelLike,
  type CritiqueInput,
  type CritiqueIssue,
  type CritiqueModelOutput,
  MAX_CRITIC_ISSUES,
  REPAIR_INSTRUCTION,
  averageScore,
  buildCritiqueSummary,
  enforceCritiqueRules,
  isHttpPreviewUrl,
  parseCritiqueRaw,
  stripControlChars,
  visionCritiqueArgsSchema,
  visionCritiqueTool,
} from "../src/tools/vision-critique.js";
import type { ToolContext } from "../src/types.js";
import { freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** §24.1 critique: hierarchy 4, balance 4, contrast 5, adherence 5, brand 4, editability 5. */
const COFFEE_SCORES = {
  hierarchy: 4,
  balance: 4,
  contrast: 5,
  brief_adherence: 5,
  brand_fit: 4,
  editability: 5,
} as const;

/** Markdown code fence, as models wrap JSON despite "Return JSON only". */
const FENCE = "```";

const coffeeAccept = {
  scores: { ...COFFEE_SCORES },
  verdict: "accept",
  issues: [],
};

const issue = (
  severity: CritiqueIssue["severity"],
  code: string,
  layer: string,
  observation = "Subhead competes with the headline.",
  fix = "Reduce Subhead to 30pt and lower opacity to 80%.",
): CritiqueIssue => ({ severity, code, layer, observation, fix });

const allScores = (n: number): CritiqueModelOutput["scores"] => ({
  hierarchy: n,
  balance: n,
  contrast: n,
  brief_adherence: n,
  brand_fit: n,
  editability: n,
});

function makeOutput(
  partial: {
    verdict?: CritiqueModelOutput["verdict"];
    scores?: CritiqueModelOutput["scores"];
    issues?: readonly CritiqueIssue[];
  } = {},
): CritiqueModelOutput {
  return {
    scores: partial.scores ?? allScores(4),
    verdict: partial.verdict ?? "accept",
    issues: [...(partial.issues ?? [])],
  };
}

const baseArgs = {
  brief: "Coffee shop promo post, warm and cozy, headline 'Fresh roasted, every morning'",
  previewUrl: "https://cdn.example.com/previews/run_42.png",
  layerSummary: '{"canvas":[1080,1080],"layers":["Background","Photo","Headline","Subhead"]}',
  palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  validatorReport: "0 blockers, 1 minor: subhead 14px from safe area",
};

// ---------------------------------------------------------------------------
// Recording fakes (critic seam + logger)
// ---------------------------------------------------------------------------

interface RecordedCritique {
  readonly input: CritiqueInput;
  readonly signal: AbortSignal;
}

function makeCritic(
  raws: readonly string[] = [],
  options: { throwsAt?: number; error?: Error } = {},
): { critic: CriticModelLike; calls: RecordedCritique[] } {
  const calls: RecordedCritique[] = [];
  const critic: CriticModelLike = {
    async critique(input, signal) {
      const index = calls.length;
      calls.push({ input, signal });
      if (options.throwsAt === index) {
        throw options.error ?? new Error("critic exploded");
      }
      const raw = raws[index] ?? "";
      return { raw, usage: { inputTokens: 10 + index, outputTokens: 20 } };
    },
  };
  return { critic, calls };
}

function makeCtx(critic?: CriticModelLike): {
  ctx: ToolContext;
  infos: Array<[string, Record<string, unknown>]>;
} {
  const base = makeFakeContext();
  const infos: Array<[string, Record<string, unknown>]> = [];
  const ctx: ToolContext = {
    ...base,
    logger: {
      ...base.logger,
      info: (message, fields) => {
        infos.push([message, { ...fields }]);
      },
    },
    ...(critic !== undefined ? { critic } : {}),
  } as ToolContext;
  return { ctx, infos };
}

const runTool = async (
  ctx: ToolContext,
  args: Partial<typeof baseArgs> = {},
  signal: AbortSignal = freshSignal(),
) => visionCritiqueTool.run(ctx, { ...baseArgs, ...args }, signal);

// ---------------------------------------------------------------------------
// Argument schema (§6.1: strict, capped; task-pinned sizes)
// ---------------------------------------------------------------------------

describe("vision_critique args schema", () => {
  it("accepts the full §6 row 16 shape and drops the optional palette", () => {
    const parsed = visionCritiqueArgsSchema.safeParse(baseArgs);
    expect(parsed.success).toBe(true);
    const noPalette = visionCritiqueArgsSchema.safeParse({ ...baseArgs, palette: undefined });
    expect(noPalette.success).toBe(true);
  });

  it("allows an empty validator report (no findings)", () => {
    const parsed = visionCritiqueArgsSchema.safeParse({ ...baseArgs, validatorReport: "" });
    expect(parsed.success).toBe(true);
  });

  it("rejects extra properties (strictObject, §6.1)", () => {
    const parsed = visionCritiqueArgsSchema.safeParse({ ...baseArgs, idempotencyKey: "k-123456" });
    expect(parsed.success).toBe(false);
  });

  it.each([
    ["brief empty", { brief: "" }],
    ["brief 4001 chars", { brief: "a".repeat(4001) }],
    ["layerSummary empty", { layerSummary: "" }],
    ["layerSummary 4001 chars", { layerSummary: "b".repeat(4001) }],
    ["validatorReport 2001 chars", { validatorReport: "c".repeat(2001) }],
    ["palette 11 entries", { palette: Array.from({ length: 11 }, () => "#3B2A20") }],
    ["palette non-hex", { palette: ["rgb(1,2,3)"] }],
    ["palette bad hex", { palette: ["#12"] }],
  ])("rejects %s", (_name, override) => {
    const parsed = visionCritiqueArgsSchema.safeParse({ ...baseArgs, ...override });
    expect(parsed.success).toBe(false);
  });

  it.each([
    ["brief exactly 4000", { brief: "a".repeat(4000) }],
    ["layerSummary exactly 4000", { layerSummary: "b".repeat(4000) }],
    ["validatorReport exactly 2000", { validatorReport: "c".repeat(2000) }],
    ["palette exactly 10", { palette: Array.from({ length: 10 }, () => "#F4E7D3") }],
    ["palette 8-digit engine hex", { palette: ["#3B2A2080"] }],
    ["previewUrl exactly 2048 chars", { previewUrl: `https://e.test/${"p".repeat(2033)}` }],
  ])("accepts %s at the boundary", (_name, override) => {
    const parsed = visionCritiqueArgsSchema.safeParse({ ...baseArgs, ...override });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["ftp", "ftp://example.com/p.png"],
    ["file", "file:///etc/passwd"],
    ["data", "data:image/png;base64,AAAA"],
    ["javascript", "javascript:alert(1)"],
    ["root-relative", "/previews/run_42.png"],
    ["bare words", "not a url"],
    ["empty", ""],
    ["no host", "http://"],
    ["2049 chars", `https://e.test/${"p".repeat(2034)}`],
    ["control character", "https://e.test/\u0007.png"],
  ])("rejects previewUrl scheme/format: %s", (_name, url) => {
    const parsed = visionCritiqueArgsSchema.safeParse({ ...baseArgs, previewUrl: url });
    expect(parsed.success).toBe(false);
  });

  it("parseToolArgs returns the invalid_args envelope with issue paths", () => {
    const parsed = parseToolArgs(visionCritiqueTool, { ...baseArgs, brief: "" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toContain("brief");
      expect(parsed.retryable).toBe(false);
    }
  });
});

describe("isHttpPreviewUrl", () => {
  it.each([
    ["http", "http://example.com/p.png", true],
    ["https with query", "https://cdn.example.org/x.png?sig=1", true],
    ["uppercase scheme", "HTTPS://EXAMPLE.COM/P.PNG", true],
    ["ftp", "ftp://example.com/p.png", false],
    ["file", "file:///etc/passwd", false],
    ["data", "data:image/png;base64,AAAA", false],
    ["javascript", "javascript:alert(1)", false],
    ["relative", "/previews/run_42.png", false],
    ["no host", "http://", false],
  ])("%s → %s", (_name, url, expected) => {
    expect(isHttpPreviewUrl(url)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Raw-output parsing (§23.3 JSON contract)
// ---------------------------------------------------------------------------

describe("parseCritiqueRaw", () => {
  it("parses bare JSON", () => {
    const parsed = parseCritiqueRaw(JSON.stringify(coffeeAccept));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.verdict).toBe("accept");
      expect(parsed.value.scores).toEqual({ ...COFFEE_SCORES });
      expect(parsed.value.issues).toEqual([]);
    }
  });

  it("parses a fenced ```json block", () => {
    const fenced = `${FENCE}json\n${JSON.stringify(coffeeAccept)}\n${FENCE}`;
    expect(parseCritiqueRaw(fenced).ok).toBe(true);
  });

  it("parses a fence without a language tag", () => {
    const fenced = `${FENCE}\n${JSON.stringify(coffeeAccept)}\n${FENCE}`;
    expect(parseCritiqueRaw(fenced).ok).toBe(true);
  });

  it("extracts JSON embedded in prose (preamble + trailing remark)", () => {
    const raw = `Sure — here is my review:\n${JSON.stringify(coffeeAccept)}\nHope that helps!`;
    expect(parseCritiqueRaw(raw).ok).toBe(true);
  });

  it("extracts JSON with unbalanced-looking braces inside strings", () => {
    const payload = {
      scores: allScores(4),
      verdict: "accept",
      issues: [issue("minor", "bracey", "Headline", "text } with } braces", "no change needed")],
    };
    const raw = `Done. ${JSON.stringify(payload)} Thanks.`;
    const parsed = parseCritiqueRaw(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.issues[0]?.observation).toBe("text } with } braces");
    }
  });

  it("defaults an omitted issues array to [] (clean-accept slip)", () => {
    const parsed = parseCritiqueRaw(JSON.stringify({ scores: allScores(4), verdict: "accept" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.issues).toEqual([]);
    }
  });

  it("keeps parse-side headroom beyond 5 issues (truncation is code-enforced)", () => {
    const six = makeOutput({
      issues: [1, 2, 3, 4, 5, 6].map((n) => issue("minor", `i_${n}`, "L")),
    });
    expect(parseCritiqueRaw(JSON.stringify(six)).ok).toBe(true);
  });

  it.each([
    ["empty string", "", "empty"],
    ["whitespace only", "   \n\t ", "empty"],
    ["no JSON at all", "I think it looks great!", "not_json"],
    ["unterminated object", '{"verdict":"accept"', "not_json"],
    ["missing scores", JSON.stringify({ verdict: "accept" }), "schema"],
    ["extra top-level key", JSON.stringify({ ...coffeeAccept, commentary: "nice" }), "schema"],
    [
      "score 6",
      JSON.stringify({ ...coffeeAccept, scores: { ...COFFEE_SCORES, hierarchy: 6 } }),
      "schema",
    ],
    [
      "non-integer score",
      JSON.stringify({ ...coffeeAccept, scores: { ...COFFEE_SCORES, balance: 2.5 } }),
      "schema",
    ],
    [
      "score as string",
      JSON.stringify({ ...coffeeAccept, scores: { ...COFFEE_SCORES, contrast: "5" } }),
      "schema",
    ],
    ["verdict typo", JSON.stringify({ ...coffeeAccept, verdict: "Accept" }), "schema"],
    [
      "unknown severity",
      JSON.stringify({
        ...coffeeAccept,
        verdict: "revise",
        issues: [issue("critical" as CritiqueIssue["severity"], "x", "L")],
      }),
      "schema",
    ],
    [
      "bad issue code",
      JSON.stringify({
        ...coffeeAccept,
        verdict: "revise",
        issues: [issue("major", "Bad Code", "L")],
      }),
      "schema",
    ],
    [
      "empty layer",
      JSON.stringify({
        ...coffeeAccept,
        verdict: "revise",
        issues: [issue("major", "low_contrast", "")],
      }),
      "schema",
    ],
    [
      "empty observation",
      JSON.stringify({
        ...coffeeAccept,
        verdict: "revise",
        issues: [issue("major", "low_contrast", "L", "")],
      }),
      "schema",
    ],
    [
      "missing fix",
      JSON.stringify({
        ...coffeeAccept,
        verdict: "revise",
        issues: [{ severity: "major", code: "low_contrast", layer: "L", observation: "o" }],
      }),
      "schema",
    ],
    [
      "issue extra property",
      JSON.stringify({
        ...coffeeAccept,
        verdict: "revise",
        issues: [{ ...issue("major", "low_contrast", "L"), note: "extra" }],
      }),
      "schema",
    ],
  ])("fails on %s", (_name, raw, reason) => {
    const parsed = parseCritiqueRaw(raw as string);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// §23.3 rule enforcement (pure, table-driven)
// ---------------------------------------------------------------------------

describe("averageScore", () => {
  it.each([
    [allScores(5), 5],
    [{ ...allScores(4), editability: 5 }, 4.17],
    [allScores(3), 3],
    [{ ...allScores(4), editability: 3 }, 3.83],
  ])("averages %j of six rubric scores", (scores, expected) => {
    expect(averageScore(scores)).toBe(expected);
  });
});

describe("enforceCritiqueRules", () => {
  it("keeps a clean accept untouched (§24.1 trace)", () => {
    const enforced = enforceCritiqueRules(makeOutput({ scores: { ...COFFEE_SCORES } }));
    expect(enforced.verdict).toBe("accept");
    expect(enforced.avg).toBe(4.5);
    expect(enforced.warnings).toEqual([]);
  });

  it("forces revise when any score ≤ 2 (naming the rubric keys)", () => {
    const enforced = enforceCritiqueRules(makeOutput({ scores: { ...allScores(4), contrast: 2 } }));
    expect(enforced.verdict).toBe("revise");
    expect(enforced.warnings).toHaveLength(1);
    expect(enforced.warnings[0]).toContain("contrast");
    expect(enforced.warnings[0]).toContain("revise");
  });

  it("forces revise when the average < 3.5", () => {
    const enforced = enforceCritiqueRules(makeOutput({ scores: allScores(3) }));
    expect(enforced.verdict).toBe("revise");
    expect(enforced.warnings).toHaveLength(1);
    expect(enforced.warnings[0]).toContain("Average score 3 < 3.5");
  });

  it("does not fire the average rule at exactly 3.5 (strict <)", () => {
    const scores = {
      hierarchy: 3,
      balance: 3,
      contrast: 3,
      brief_adherence: 4,
      brand_fit: 4,
      editability: 4,
    };
    const enforced = enforceCritiqueRules(makeOutput({ scores }));
    expect(enforced.verdict).toBe("accept");
    expect(enforced.warnings).toEqual([]);
    expect(enforced.avg).toBe(3.5);
  });

  it("downgrades a substance-free revise to accept (minors never revise, §11.2)", () => {
    const enforced = enforceCritiqueRules(
      makeOutput({ verdict: "revise", issues: [issue("minor", "spacing", "Subhead")] }),
    );
    expect(enforced.verdict).toBe("accept");
    expect(enforced.warnings).toHaveLength(1);
    expect(enforced.warnings[0]).toContain("downgraded to accept");
  });

  it("keeps a revise backed by a blocker/major issue", () => {
    const enforced = enforceCritiqueRules(
      makeOutput({ verdict: "revise", issues: [issue("major", "weak_hierarchy", "Subhead")] }),
    );
    expect(enforced.verdict).toBe("revise");
    expect(enforced.warnings).toEqual([]);
  });

  it("never downgrades a score-forced revise (§23.3 score rule beats the downgrade)", () => {
    const enforced = enforceCritiqueRules(
      makeOutput({
        verdict: "revise",
        scores: { ...allScores(4), hierarchy: 2 },
        issues: [issue("minor", "spacing", "Subhead")],
      }),
    );
    expect(enforced.verdict).toBe("revise");
    expect(enforced.warnings).toHaveLength(1);
    expect(enforced.warnings[0]).toContain("hierarchy");
  });

  it("forces revise when the model accepts but lists a blocker/major issue", () => {
    const enforced = enforceCritiqueRules(
      makeOutput({ verdict: "accept", issues: [issue("blocker", "out_of_bounds", "Badge")] }),
    );
    expect(enforced.verdict).toBe("revise");
    expect(enforced.warnings).toHaveLength(1);
    expect(enforced.warnings[0]).toContain("forced to revise");
  });

  it("truncates more than 5 issues to the first 5 in model order (§23.3)", () => {
    const issues = Array.from({ length: 8 }, (_v, i) =>
      i % 2 === 0 ? issue("minor", `i_${i}`, `L${i}`) : issue("major", `i_${i}`, `L${i}`),
    );
    const enforced = enforceCritiqueRules(makeOutput({ issues }));
    expect(enforced.issues).toHaveLength(MAX_CRITIC_ISSUES);
    expect(enforced.issues.map((entry) => entry.code)).toEqual(["i_0", "i_1", "i_2", "i_3", "i_4"]);
    expect(enforced.warnings.some((w) => w.includes("kept the first 5"))).toBe(true);
  });

  it("stacks truncation + score + average warnings deterministically", () => {
    const enforced = enforceCritiqueRules(
      makeOutput({
        scores: { ...allScores(3), contrast: 2 },
        issues: Array.from({ length: 7 }, (_v, i) => issue("minor", `i_${i}`, `L${i}`)),
      }),
    );
    expect(enforced.verdict).toBe("revise");
    expect(enforced.issues).toHaveLength(5);
    expect(enforced.warnings).toHaveLength(3);
    expect(enforced.warnings[0]).toContain("kept the first 5");
    expect(enforced.warnings[1]).toContain("contrast");
    expect(enforced.warnings[2]).toContain("Average score 2.83 < 3.5");
  });
});

// ---------------------------------------------------------------------------
// Compact summary (§6.1 2000-char budget, guaranteed fit)
// ---------------------------------------------------------------------------

describe("buildCritiqueSummary", () => {
  it("round-trips a small critique as compact JSON", () => {
    const enforced = enforceCritiqueRules(makeOutput({ scores: { ...COFFEE_SCORES } }));
    const { summary, compacted } = buildCritiqueSummary(enforced);
    expect(compacted).toBe(false);
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed.verdict).toBe("accept");
    expect(parsed.avg).toBe(4.5);
    expect(parsed.scores).toEqual({ ...COFFEE_SCORES });
    expect(parsed.issues).toEqual([]);
  });

  it("clips prose before structure and stays within 2000 chars (fat issues)", () => {
    const fat = Array.from({ length: 5 }, (_v, i) =>
      issue("major", `i_${i}`, `L${i}`, "o".repeat(500), "f".repeat(500)),
    );
    const enforced = enforceCritiqueRules(makeOutput({ verdict: "revise", issues: fat }));
    const { summary, compacted } = buildCritiqueSummary(enforced);
    expect(compacted).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(summary) as { issues: Array<Record<string, unknown>> };
    expect(parsed.issues).toHaveLength(5);
    for (const [i, entry] of parsed.issues.entries()) {
      expect(entry.severity).toBe("major");
      expect(entry.code).toBe(`i_${i}`);
      expect(String(entry.observation).length).toBeLessThanOrEqual(61);
      expect(String(entry.fix).length).toBeLessThanOrEqual(61);
    }
  });

  it("sheds issues entirely before ever exceeding the budget (monster fields)", () => {
    const monster = Array.from({ length: 5 }, (_v, i) => ({
      severity: "major" as const,
      code: "c".repeat(80),
      layer: "l".repeat(200),
      observation: "o".repeat(500),
      fix: "f".repeat(500),
    }));
    const enforced = enforceCritiqueRules(makeOutput({ verdict: "revise", issues: monster }));
    const { summary } = buildCritiqueSummary(enforced);
    expect(summary.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(summary) as { issues: unknown[] };
    expect(parsed.issues.length).toBeGreaterThanOrEqual(1);
    expect(parsed.issues.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// The tool: seam injection, repair retry, failures, traces
// ---------------------------------------------------------------------------

describe("vision_critique tool", () => {
  it("returns a clean accept on the first try and passes the seam inputs verbatim", async () => {
    const { critic, calls } = makeCritic([JSON.stringify(coffeeAccept)]);
    const { ctx, infos } = makeCtx(critic);
    const signal = freshSignal();
    const result = await visionCritiqueTool.run(ctx, { ...baseArgs }, signal);

    expect(result.ok).toBe(true);
    expect(isToolResult(result)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(signal);
    expect(calls[0]?.input).toStrictEqual({
      brief: baseArgs.brief,
      previewUrl: baseArgs.previewUrl,
      layerSummary: baseArgs.layerSummary,
      palette: baseArgs.palette,
      validatorReport: baseArgs.validatorReport,
    });
    if (result.ok) {
      expect(result.warnings).toBeUndefined();
      expect(result.documentRevision).toBeUndefined();
      const parsed = JSON.parse(result.summary) as Record<string, unknown>;
      expect(parsed.verdict).toBe("accept");
      expect(parsed.avg).toBe(4.5);
    }
    expect(infos).toHaveLength(1);
    expect(infos[0]?.[1].usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("omits palette from the seam input when not supplied", async () => {
    const { critic, calls } = makeCritic([JSON.stringify(coffeeAccept)]);
    const { ctx } = makeCtx(critic);
    const args = { ...baseArgs, palette: undefined };
    await visionCritiqueTool.run(ctx, args, freshSignal());
    expect(calls[0]?.input.palette).toBeUndefined();
  });

  it('repairs unparseable output with one retry carrying "Return JSON only."', async () => {
    const { critic, calls } = makeCritic([
      "Trust me, it looks fine.",
      JSON.stringify(coffeeAccept),
    ]);
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.repairInstruction).toBe(REPAIR_INSTRUCTION);
    expect(REPAIR_INSTRUCTION).toBe("Return JSON only.");
    if (result.ok) {
      expect(result.warnings?.[0]).toContain("first reply was not valid JSON");
      const parsed = JSON.parse(result.summary) as Record<string, unknown>;
      expect(parsed.verdict).toBe("accept");
    }
  });

  it("also retries on schema failures (valid JSON, wrong shape)", async () => {
    const wrongShape = JSON.stringify({ ...coffeeAccept, verdict: "maybe" });
    const { critic, calls } = makeCritic([wrongShape, JSON.stringify(coffeeAccept)]);
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("fails with the parse-failed code (retryable) after two unparseable replies", async () => {
    const { critic, calls } = makeCritic(["nope", "still nope"]);
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
    if (!result.ok) {
      expect(result.code).toBe(CRITIQUE_PARSE_FAILED_CODE);
      expect(result.code).toBe("critique_parse_failed"); // W7-M catalog adoption pin
      expect(result.retryable).toBe(true);
      expect(result.hint).toContain("render_preview");
      expect(JSON.stringify(result)).not.toContain("still nope");
    }
  });

  it("fails the same way on empty replies", async () => {
    const { critic } = makeCritic(["", "   "]);
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(CRITIQUE_PARSE_FAILED_CODE);
    }
  });

  it("maps a thrown seam error to provider_unhealthy without leaking details", async () => {
    const { critic } = makeCritic([], {
      throwsAt: 0,
      error: new Error("boomed with sk-live-secret"),
    });
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("provider_unhealthy");
      expect(result.retryable).toBe(true);
      expect(JSON.stringify(result)).not.toContain("sk-live-secret");
    }
  });

  it("maps an aborted seam call to engine_timeout (§3.4 deadline)", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const { critic } = makeCritic([], { throwsAt: 0, error: abort });
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_timeout");
      expect(result.retryable).toBe(true);
    }
  });

  it("requires the injected critic seam (ctx.critic missing → internal_error)", async () => {
    const { ctx } = makeCtx();
    const result = await runTool(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal_error");
      expect(result.hint).toContain("ctx.critic");
      expect(result.hint).toContain("§5.3");
    }
  });

  it("sanitizes §15.3 control characters before the brief reaches the model", async () => {
    const { critic, calls } = makeCritic([JSON.stringify(coffeeAccept)]);
    const { ctx } = makeCtx(critic);
    await runTool(ctx, {
      brief: "Coffee\u0000 shop \u200Bpromo\u007F",
      layerSummary: "Background\n\tPhoto",
    });
    expect(calls[0]?.input.brief).toBe("Coffee shop promo");
    expect(calls[0]?.input.layerSummary).toBe("Background\n\tPhoto");
  });

  it("rejects a brief that is empty after sanitisation", async () => {
    const { critic, calls } = makeCritic([JSON.stringify(coffeeAccept)]);
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx, { brief: "\u0000\u0000" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_args");
    }
    expect(calls).toHaveLength(0);
  });

  it("sums token usage across the repair retry for the §22 trace", async () => {
    const { critic } = makeCritic(["garbage", JSON.stringify(coffeeAccept)]);
    const { ctx, infos } = makeCtx(critic);
    await runTool(ctx);
    expect(infos).toHaveLength(1);
    expect(infos[0]?.[1].usage).toEqual({ inputTokens: 21, outputTokens: 40 });
    expect(infos[0]?.[1].verdict).toBe("accept");
  });

  it("surfaces enforced rules as warnings on the ok result", async () => {
    const forced = {
      scores: { ...allScores(4), contrast: 2 },
      verdict: "accept",
      issues: [],
    };
    const { critic } = makeCritic([JSON.stringify(forced)]);
    const { ctx } = makeCtx(critic);
    const result = await runTool(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.summary) as Record<string, unknown>;
      expect(parsed.verdict).toBe("revise");
      expect(result.warnings?.[0]).toContain("contrast");
    }
  });
});

// ---------------------------------------------------------------------------
// Registry pinning (§6 surface)
// ---------------------------------------------------------------------------

describe("vision_critique registry", () => {
  it("registers under the pinned §6 name", () => {
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(visionCritiqueTool)).toEqual({ ok: true });
    const lookup = registry.get(TOOLS.vision_critique);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.tool.name).toBe("vision_critique");
    }
  });
});

// stripControlChars is a shared pure helper; pin the §15.3 behaviour directly.
describe("stripControlChars", () => {
  it("keeps newlines and tabs, strips zero-width and C0 controls, CRLF→LF", () => {
    expect(stripControlChars("a\r\nb\u0000c\u200Bd\te")).toBe("a\nbcd\te");
    expect(stripControlChars("  trim  ")).toBe("trim");
  });
});
