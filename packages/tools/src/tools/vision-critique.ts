// @studio/tools — vision_critique (§6 row 16, model-orchestrated; §23.3 rubric).
// Owner: W5-O.
//
// §6: `vision_critique` is one of the four MODEL-ORCHESTRATED tools — it makes
// NO engine call. The render arrives as `previewUrl` (produced by
// `render_preview`/doc.render), the layer tree as `layerSummary` (from
// `workspace_snapshot`), and this tool ships both plus the brief, palette and
// the deterministic validator report to an EXTERNAL VISION MODEL, then applies
// the §23.3 scoring rules IN CODE — the model's verdict alone is never trusted.
//
// §5.3 routing happens in the WORKER, never here (no provider SDK import):
// the worker implements `CriticModelLike` and wires the §5.3 "Critic (vision)"
// row — default Gemini 3.8 Flash (vision), premium Claude Sonnet 5.5, max
// Claude Opus 5.5; economy/quick tier skips the critic entirely (route null).
// Paid endpoints only: customer content NEVER flows through free LLM tiers
// (§1.5 constraint 6). The worker sends the §23.3 critic prompt VERBATIM as
// the system prompt (promptfoo variant: packages/evals/prompts/critic.system.txt)
// and attaches the downscaled render (≤1024 px) from `previewUrl`.
//
// No engine command → no `budgets.charge` and no idempotency key (§5.2 charges
// mutating commands; §11.3: critic tokens are priced into the tier, repair
// cycles never cost extra credits).

import { z } from "zod";
import {
  MAX_PREVIEW_URL_CHARS,
  MAX_SUMMARY_CHARS,
  ToolError,
  defineTool,
  err,
  ok,
  strictObject,
} from "../kit.js";
import { TOOLS } from "../registry.js";
import type { Tool, ToolContext, ToolErr, ToolErrorCode } from "../types.js";

// ---------------------------------------------------------------------------
// Constants (§23.3 rubric; task-pinned caps)
// ---------------------------------------------------------------------------

/** The six §23.3 rubric keys, in prompt + output order. */
export const CRITIC_RUBRIC_KEYS = [
  "hierarchy",
  "balance",
  "contrast",
  "brief_adherence",
  "brand_fit",
  "editability",
] as const;

export type CriticRubricKey = (typeof CRITIC_RUBRIC_KEYS)[number];

/** §23.3: "Maximum 5 issues" — extra issues are truncated with a warning. */
export const MAX_CRITIC_ISSUES = 5;

/** Defensive parse-side hard bound (enforcement truncates to 5 afterwards; a
 * model that ignores "Maximum 5 issues" still parses — the count rules are
 * enforced in code, never via a schema rejection that would burn the retry). */
const MAX_PARSED_ISSUES = 50;

/** §23.3: "Any score <= 2 or average < 3.5 => verdict \"revise\"." */
export const SCORE_REVISE_CEILING = 2;
export const AVG_REVISE_THRESHOLD = 3.5;

/**
 * Appended to the critic input on the single repair retry when the raw output
 * was not parseable JSON (§23.3 "Return JSON only").
 */
export const REPAIR_INSTRUCTION = "Return JSON only.";

/** Task caps: brief and layer summary ≤ 4000 chars (§5.4 keeps whole-document
 * context ~4k tokens; these are 2× the kit's model-scale `cappedString` default
 * on purpose — pinned by the §6 row 16 contract). */
export const MAX_BRIEF_CHARS = 4000;
export const MAX_LAYER_SUMMARY_CHARS = 4000;
export const MAX_VALIDATOR_REPORT_CHARS = 2000;
export const MAX_PALETTE_ENTRIES = 10;

/**
 * The parse-failure code. `critique_parse_failed` lives in the shared §13.3
 * catalog (@studio/config ERROR_CODES, adopted by W10-F via the W7-M swap
 * point) — this constant stays as the single import point the tests pin
 * (W5-D/W5-B/W5-O fleet precedent).
 */
export const CRITIQUE_PARSE_FAILED_CODE: ToolErrorCode = "critique_parse_failed";

// ---------------------------------------------------------------------------
// The injected vision-model seam (worker conforms structurally; §5.3 in worker)
// ---------------------------------------------------------------------------

/** What the tool hands the worker for one critique call; the worker adds the
 * §23.3 system prompt + the render attachment and talks to the routed model. */
export interface CritiqueInput {
  readonly brief: string;
  readonly previewUrl: string;
  readonly layerSummary: string;
  readonly palette?: readonly string[];
  readonly validatorReport: string;
  /** Present only on the repair retry: "Return JSON only." (§23.3). */
  readonly repairInstruction?: string;
}

/** Optional token usage for §22 traces; logged, never echoed into results. */
export interface CriticUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** What the seam returns: the raw model text plus optional usage. */
export interface CriticModelResult {
  readonly raw: string;
  readonly usage?: CriticUsage;
}

/**
 * The external vision-model seam (§6 row 16 "external vision model"). The
 * WORKER wires this per §5.3 (critic row) with per-provider circuit breakers
 * and same-class failover; failures THROW (the tool maps them to typed errors
 * and never leaks the provider's message). No provider SDK import in the tool.
 */
export interface CriticModelLike {
  critique(input: CritiqueInput, signal: AbortSignal): Promise<CriticModelResult>;
}

/** The context the worker must assemble: base `ToolContext` + `ctx.critic`. */
export interface VisionCritiqueContext extends ToolContext {
  readonly critic: CriticModelLike;
}

function isVisionCritiqueContext(value: ToolContext): value is VisionCritiqueContext {
  const candidate = value as Partial<VisionCritiqueContext>;
  return candidate.critic !== undefined && typeof candidate.critic.critique === "function";
}

function requireVisionCritiqueContext(ctx: ToolContext): VisionCritiqueContext {
  if (!isVisionCritiqueContext(ctx)) {
    throw new ToolError("internal_error", "vision_critique requires the critic model seam on ctx", {
      hint: "The agent runtime wires ctx.critic per §5.3 (Gemini 3.8 Flash vision default; premium Claude Sonnet 5.5; never free tiers §1.5-6).",
      retryable: false,
    });
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Argument schema (§6.1: strict, capped)
// ---------------------------------------------------------------------------

/** Task pin: previewUrl is http(s) ONLY — the worker fetches the render over
 * HTTP; every other scheme (ftp:, file:, data:, javascript:, root-relative) is
 * rejected before anything leaves the tool. */
export function isHttpPreviewUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PREVIEW_URL_CHARS) {
    return false;
  }
  // §15.3: no control characters ever enter a model-facing URL.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
}

/** Task pin: palette entries are hex — #RGB, #RRGGBB or #RRGGBBAA (engine form). */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const visionCritiqueArgsSchema = strictObject({
  /** The user brief the design is judged against (§23.3 "brief_adherence"). */
  brief: z.string().min(1).max(MAX_BRIEF_CHARS),
  /** http(s) URL of the ≤1024 px render (from render_preview). */
  previewUrl: z.string().refine(isHttpPreviewUrl, {
    message: "previewUrl must be an http(s) URL (other schemes are rejected, §6 row 16)",
  }),
  /** Compact layer-tree summary (from workspace_snapshot). */
  layerSummary: z.string().min(1).max(MAX_LAYER_SUMMARY_CHARS),
  /** Brand palette as hex colours, ≤ 10 entries. */
  palette: z
    .array(z.string().regex(HEX_COLOR_RE, { message: "palette entries must be hex colours" }))
    .max(MAX_PALETTE_ENTRIES)
    .optional(),
  /** The deterministic validator report (§6 row 15); empty when it found nothing. */
  validatorReport: z.string().max(MAX_VALIDATOR_REPORT_CHARS),
});

export type VisionCritiqueArgs = z.output<typeof visionCritiqueArgsSchema>;

// ---------------------------------------------------------------------------
// §23.3 output schema (raw model text → typed critique)
// ---------------------------------------------------------------------------

const zScore = z.number().int().min(1).max(5);

export const criticIssueSchema = strictObject({
  severity: z.enum(["blocker", "major", "minor"]),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,79}$/, { message: "issue code must be short_snake_case" }),
  layer: z.string().min(1).max(200),
  observation: z.string().min(1).max(500),
  fix: z.string().min(1).max(500),
});

export type CritiqueIssue = z.output<typeof criticIssueSchema>;

export const critiqueSchema = strictObject({
  scores: strictObject({
    hierarchy: zScore,
    balance: zScore,
    contrast: zScore,
    brief_adherence: zScore,
    brand_fit: zScore,
    editability: zScore,
  }),
  verdict: z.enum(["accept", "revise"]),
  // §23.3 always shows the array; an omitted array (a common "clean accept"
  // slip) defaults to [] — a formatting tolerance, not a contract relaxation.
  issues: z.array(criticIssueSchema).max(MAX_PARSED_ISSUES).default([]),
});

export type CritiqueModelOutput = z.output<typeof critiqueSchema>;

export type CritiqueParseResult =
  | { readonly ok: true; readonly value: CritiqueModelOutput }
  | { readonly ok: false; readonly reason: "empty" | "not_json" | "schema" };

// ---------------------------------------------------------------------------
// Raw-output extraction (tolerant of fences/preamble, strict on content)
// ---------------------------------------------------------------------------

/**
 * Finds the first balanced JSON object in `raw`, honouring string escapes so
 * prose with braces cannot truncate the scan. Returns `undefined` when there
 * is no object to extract.
 */
function firstJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/**
 * Parses raw critic text into the §23.3 shape. Accepts bare JSON, a fenced
 * ```json block, or JSON embedded in prose (models add preambles despite
 * "Return JSON only"); anything else fails, which drives the repair retry.
 * Never throws; the failure reason is safe to log.
 */
export function parseCritiqueRaw(raw: string): CritiqueParseResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  const candidates: string[] = [raw.trim()];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  if (fenced?.[1] !== undefined) {
    candidates.unshift(fenced[1].trim());
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      const parsed = critiqueSchema.safeParse(value);
      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }
      return { ok: false, reason: "schema" };
    } catch {
      // try the next candidate
    }
  }
  const extracted = firstJsonObject(raw);
  if (extracted !== undefined) {
    try {
      const value: unknown = JSON.parse(extracted);
      const parsed = critiqueSchema.safeParse(value);
      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }
      return { ok: false, reason: "schema" };
    } catch {
      return { ok: false, reason: "not_json" };
    }
  }
  return { ok: false, reason: "not_json" };
}

// ---------------------------------------------------------------------------
// §23.3 rule enforcement (pure, table-driven)
// ---------------------------------------------------------------------------

/** Average of the six rubric scores, 2-decimal rounded (display form). */
export function averageScore(scores: CritiqueModelOutput["scores"]): number {
  let sum = 0;
  for (const key of CRITIC_RUBRIC_KEYS) {
    sum += scores[key];
  }
  return Math.round((sum / CRITIC_RUBRIC_KEYS.length) * 100) / 100;
}

export interface EnforcedCritique {
  readonly verdict: "accept" | "revise";
  readonly scores: CritiqueModelOutput["scores"];
  readonly issues: readonly CritiqueIssue[];
  readonly avg: number;
  readonly warnings: readonly string[];
}

/**
 * Enforces the §23.3 rules IN CODE (the model's verdict is never trusted):
 *
 * 1. issues > 5 → truncated to the first 5 + warning ("Maximum 5 issues";
 *    model order is kept — severity ordering is the prompt's job).
 * 2. any score ≤ 2 → verdict forced to "revise" + warning naming the keys.
 * 3. average < 3.5 → verdict forced to "revise" + warning (sum < 21 keeps the
 *    comparison exact — six integer scores).
 * 4. model said "revise" but listed NO blocker/major issue AND no score rule
 *    fired → DOWNGRADED to "accept" + warning. Documented choice: §11.2 —
 *    "minors … never trigger a revision by themselves", so a substance-free
 *    revise is noise. Score-forced revises are NEVER downgraded (§23.3's
 *    score rule is unconditional and beats this one).
 * 5. model said "accept" but listed a blocker/major issue → forced "revise" +
 *    warning. Documented choice: §23.3 reads as the invariant
 *    verdict=revise ⇔ (score rule fired ∨ a blocker/major exists); §11.2 —
 *    "Blocker/major issues drive the repair loop", so they can never ride
 *    along with an accept.
 */
export function enforceCritiqueRules(critique: CritiqueModelOutput): EnforcedCritique {
  const warnings: string[] = [];

  // 1. §23.3 "Maximum 5 issues".
  let issues = critique.issues;
  if (issues.length > MAX_CRITIC_ISSUES) {
    warnings.push(
      `Critic returned ${issues.length} issues; kept the first ${MAX_CRITIC_ISSUES} (§23.3 maximum).`,
    );
    issues = issues.slice(0, MAX_CRITIC_ISSUES);
  }

  // 2 + 3. Score rules (exact integer arithmetic for the average threshold).
  const lowKeys = CRITIC_RUBRIC_KEYS.filter((key) => critique.scores[key] <= SCORE_REVISE_CEILING);
  let sum = 0;
  for (const key of CRITIC_RUBRIC_KEYS) {
    sum += critique.scores[key];
  }
  const scoreForced = lowKeys.length > 0 || sum < CRITIC_RUBRIC_KEYS.length * AVG_REVISE_THRESHOLD;
  const avg = Math.round((sum / CRITIC_RUBRIC_KEYS.length) * 100) / 100;
  if (lowKeys.length > 0) {
    warnings.push(
      `Scores ≤ ${SCORE_REVISE_CEILING} on ${lowKeys.join(", ")} — verdict forced to revise (§23.3).`,
    );
  }
  if (sum < CRITIC_RUBRIC_KEYS.length * AVG_REVISE_THRESHOLD) {
    warnings.push(
      `Average score ${avg} < ${AVG_REVISE_THRESHOLD} — verdict forced to revise (§23.3).`,
    );
  }

  const hasBlocking = issues.some(
    (issue) => issue.severity === "blocker" || issue.severity === "major",
  );

  let verdict: "accept" | "revise" = critique.verdict;

  // 4. Substance-free revise (never after a score rule fired — see docblock).
  if (verdict === "revise" && !scoreForced && !hasBlocking) {
    verdict = "accept";
    warnings.push(
      "Critic verdict was revise but no blocker/major issue was listed; downgraded to accept — minors never trigger a revision (§11.2).",
    );
  }

  // 5. Accept carrying a blocker/major is self-contradictory → revise.
  if (verdict === "accept" && hasBlocking) {
    verdict = "revise";
    warnings.push(
      "Critic accepted while listing blocker/major issues; verdict forced to revise (§23.3).",
    );
  }

  if (scoreForced) {
    verdict = "revise";
  }

  return { verdict, scores: critique.scores, issues, avg, warnings };
}

// ---------------------------------------------------------------------------
// §6.1 compact summary (≤ 2000 chars, guaranteed — ok() throws past the cap)
// ---------------------------------------------------------------------------

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Serializes the enforced critique as compact JSON inside the kit's string
 * summary. Degradation ladder when the §6.1 2000-char budget cannot hold the
 * full text (schema caps allow 5 × ~1300 chars of prose):
 *   L0 full issues → L1 prose clipped to 160 → L2 prose clipped to 60 →
 *   L3 issues as {severity, code, layer} → L4 drop issues from the end.
 */
export function buildCritiqueSummary(enforced: EnforcedCritique): {
  readonly summary: string;
  readonly compacted: boolean;
} {
  const shape = (issues: readonly unknown[]): string =>
    JSON.stringify({
      verdict: enforced.verdict,
      scores: enforced.scores,
      issues,
      avg: enforced.avg,
    });

  const full = enforced.issues;
  const l1 = full.map((issue) => ({
    ...issue,
    observation: clip(issue.observation, 160),
    fix: clip(issue.fix, 160),
  }));
  const l2 = full.map((issue) => ({
    ...issue,
    observation: clip(issue.observation, 60),
    fix: clip(issue.fix, 60),
  }));
  const l3 = full.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    layer: issue.layer,
  }));

  const stages: readonly string[] = [shape(full), shape(l1), shape(l2), shape(l3)];

  for (const candidate of stages) {
    if (candidate.length <= MAX_SUMMARY_CHARS) {
      return { summary: candidate, compacted: candidate !== stages[0] };
    }
  }

  // L4: shed issues from the end until the wrapper fits (always terminates —
  // the bare wrapper is ~140 chars).
  for (let count = l3.length; count >= 0; count -= 1) {
    const candidate = shape(l3.slice(0, count));
    if (candidate.length <= MAX_SUMMARY_CHARS) {
      return { summary: candidate, compacted: true };
    }
  }
  return { summary: shape([]), compacted: true }; // unreachable, but ok() must never throw
}

// ---------------------------------------------------------------------------
// §15.3 output safety for model-facing strings
// ---------------------------------------------------------------------------

/** §15.3: forbidden code points in model-facing strings (C0/C1 controls, zero
 * width + bidi marks). Newlines and tabs stay legitimate structure. */
const STRIPPED_CODE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], // C0 controls before LF
  [0x000b, 0x000c], // vertical tab + form feed
  [0x000e, 0x001f], // C0 tail (keeps \n 0x0a and \t 0x09)
  [0x007f, 0x009f], // DEL + C1 controls
  [0x200b, 0x200f], // zero width + LRM/RLM marks
  [0x202a, 0x202e], // bidi embedding overrides (Trojan Source)
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function isStrippableCode(code: number): boolean {
  for (const [low, high] of STRIPPED_CODE_RANGES) {
    if (code >= low && code <= high) {
      return true;
    }
  }
  return false;
}

/** §15.3: strip control characters (keep newlines/tabs), normalise CRLF→LF. */
export function stripControlChars(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    if (ch === "\r") {
      // CRLF → LF; a lone CR is a newline too (normalise instead of strip).
      if (raw[i + 1] === "\n") {
        continue; // drop the CR, the next iteration keeps the LF
      }
      out += "\n";
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (!isStrippableCode(code)) {
      out += ch;
    }
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

function addUsage(total: CriticUsage | undefined, added: CriticUsage | undefined): CriticUsage {
  if (added === undefined) {
    return total ?? {};
  }
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  return {
    inputTokens: sum(total?.inputTokens, added.inputTokens),
    outputTokens: sum(total?.outputTokens, added.outputTokens),
    totalTokens: sum(total?.totalTokens, added.totalTokens),
  };
}

async function callCritic(
  critic: CriticModelLike,
  input: CritiqueInput,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly result: CriticModelResult } | ToolErr> {
  try {
    return { ok: true, result: await critic.critique(input, signal) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error; // §3.4 deadline — the defineTool boundary maps engine_timeout.
    }
    // §13.3 has no transport code for the critic model; provider_unhealthy is
    // the §5.3 model-provider failure code. The provider's own message never
    // leaks (§6.1).
    return err("provider_unhealthy", "The vision model call failed for this critique", {
      hint: "The worker retries on the failover route (§5.3); call vision_critique again once the provider recovers.",
      retryable: true,
    });
  }
}

export const visionCritiqueTool: Tool<VisionCritiqueArgs> = defineTool({
  name: TOOLS.vision_critique,
  description:
    "Review a rendered document against the brief with the design rubric (hierarchy, balance, contrast, brief adherence, brand fit, editability) and return a scored verdict with up to 5 actionable issues.",

  args: visionCritiqueArgsSchema,

  async run(ctx, args, signal) {
    const cctx = requireVisionCritiqueContext(ctx);

    // §15.3: user/engine text is data; strip control characters before the
    // strings leave for the external model.
    const input: CritiqueInput = {
      brief: stripControlChars(args.brief),
      previewUrl: args.previewUrl,
      layerSummary: stripControlChars(args.layerSummary),
      ...(args.palette !== undefined ? { palette: args.palette } : {}),
      validatorReport: stripControlChars(args.validatorReport),
    };
    if (input.brief.length === 0 || input.layerSummary.length === 0) {
      return err("invalid_args", "The brief or layer summary is empty after sanitisation", {
        hint: "Provide plain text (control characters are stripped, §15.3).",
        retryable: false,
      });
    }

    // Call 1 — the §23.3 system prompt, render attachment and §5.3 routing are
    // all worker-side; this tool only supplies the structured inputs.
    const first = await callCritic(cctx.critic, input, signal);
    if (!first.ok) {
      return first;
    }
    let parsed = parseCritiqueRaw(first.result.raw);

    // One repair retry when the raw output was not parseable §23.3 JSON.
    let usage = addUsage(undefined, first.result.usage);
    const warnings: string[] = [];
    if (!parsed.ok) {
      cctx.logger.warn("vision_critique: unparseable model output, retrying with JSON repair", {
        attempt: 1,
        reason: parsed.reason,
      });
      const second = await callCritic(
        cctx.critic,
        { ...input, repairInstruction: REPAIR_INSTRUCTION },
        signal,
      );
      if (!second.ok) {
        return second;
      }
      usage = addUsage(usage, second.result.usage);
      parsed = parseCritiqueRaw(second.result.raw);
      if (parsed.ok) {
        warnings.push(
          'The critic\'s first reply was not valid JSON; the retry with "Return JSON only." succeeded.',
        );
      }
    }

    if (!parsed.ok) {
      // One retry spent and still unparseable — do not echo raw model text
      // (§6.1); the failure is retryable at the run level.
      cctx.logger.error("vision_critique: model output failed parsing after repair retry", {
        reason: parsed.reason,
      });
      return err(
        CRITIQUE_PARSE_FAILED_CODE,
        "The critic's reply could not be parsed as the expected JSON rubric",
        {
          hint: "Re-render with render_preview and call vision_critique again; the critic route may need failover (§5.3).",
          retryable: true,
        },
      );
    }

    const enforced = enforceCritiqueRules(parsed.value);
    warnings.push(...enforced.warnings);

    const { summary, compacted } = buildCritiqueSummary(enforced);
    if (compacted) {
      warnings.push(
        `Critique summary compacted to ≤ ${MAX_SUMMARY_CHARS} chars for the compact-reply rule (§6.1); full issue text is in the run trace.`,
      );
    }

    // §22: token/cost trace fields only — never brief or model content.
    cctx.logger.info("vision_critique: critique complete", {
      verdict: enforced.verdict,
      avg: enforced.avg,
      issueCount: enforced.issues.length,
      usage,
    });

    return ok({
      summary,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  },
});
