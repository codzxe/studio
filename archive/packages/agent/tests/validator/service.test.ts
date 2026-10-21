// W6-D — validator service tests: the §5.1 classification of the
// validate_document tool outcome through a fake ValidateToolLike.
//
// Deterministic (§21): the fake tool is a scripted queue — no engine, no
// network, no timers. Fixture summaries are hand-rolled to mirror the tool's
// documented §6.1 compact JSON shape (an independent transcription, the
// state.test.ts precedent), plus one contract-pin test that runs the REAL
// renderSummary output through the parser.

import {
  type ToolErr,
  type ToolOk,
  type ToolResult,
  type ValidateDocumentArgs,
  type ValidationIssue,
  buildReport,
  renderSummary,
} from "@studio/tools";
import { describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/errors.js";
import {
  DEFAULT_MAX_TOOL_RETRIES,
  type RunValidateInput,
  RunValidator,
  type ValidateToolLike,
  type ValidatorReport,
  classifyOutcome,
  parseValidateSummary,
} from "../../src/validator/service.js";

const DOC_ID = "d0a1b2c3-1111-4222-8333-444455556666";
const TEMPLATE_PIN = "instagram-post@3";

// ---------------------------------------------------------------------------
// Fixtures — the §6.1 summary shape, hand-rolled (independent of the tool)
// ---------------------------------------------------------------------------

type Level = "blocker" | "major" | "minor";

interface Row {
  readonly level: Level;
  readonly code: string;
  readonly layer?: string;
  readonly message: string;
  readonly fix: string;
}

/** renderSummary's exact key order: level, code, layer?, message, fix. */
function row(
  level: Level,
  code: string,
  options: { readonly layer?: string; readonly message?: string; readonly fix?: string } = {},
): Row {
  const message = options.message ?? `${code} message`;
  const fix = options.fix ?? `${code} fix`;
  if (options.layer === undefined) return { level, code, message, fix };
  return { level, code, layer: options.layer, message, fix };
}

function countsOf(rows: readonly Row[]): { blocker: number; major: number; minor: number } {
  const counts = { blocker: 0, major: 0, minor: 0 };
  for (const entry of rows) counts[entry.level] += 1;
  return counts;
}

function summaryOf(options: {
  readonly counts?: { readonly blocker: number; readonly major: number; readonly minor: number };
  readonly rows?: readonly Row[];
  readonly truncated?: boolean;
  readonly template?: string;
}): string {
  const rows = options.rows ?? [];
  const counts = options.counts ?? countsOf(rows);
  const parts = [
    `"ok":${counts.blocker === 0}`,
    `"issueCounts":{"blocker":${counts.blocker},"major":${counts.major},"minor":${counts.minor}}`,
  ];
  if (options.template !== undefined) parts.push(`"template":${JSON.stringify(options.template)}`);
  parts.push(`"issues":${JSON.stringify(rows)}`);
  parts.push(`"truncated":${options.truncated === true}`);
  return `{${parts.join(",")}}`;
}

function okResult(
  summary: string,
  options: { readonly documentRevision?: number; readonly warnings?: readonly string[] } = {},
): ToolOk {
  const result: { ok: true; summary: string; documentRevision?: number; warnings?: readonly string[] } = {
    ok: true,
    summary,
  };
  if (options.documentRevision !== undefined) result.documentRevision = options.documentRevision;
  if (options.warnings !== undefined) result.warnings = options.warnings;
  return result;
}

function errResult(
  code: ToolErr["code"],
  message: string,
  options: { readonly hint?: string; readonly retryable?: boolean } = {},
): ToolErr {
  const failure: {
    ok: false;
    code: ToolErr["code"];
    message: string;
    hint?: string;
    retryable?: boolean;
  } = { ok: false, code, message };
  if (options.hint !== undefined) failure.hint = options.hint;
  if (options.retryable !== undefined) failure.retryable = options.retryable;
  return failure;
}

/** A scripted one-method ValidateToolLike; records every call's args. */
function fakeTool(script: readonly ToolResult[]) {
  const calls: ValidateDocumentArgs[] = [];
  let cursor = 0;
  const tool: ValidateToolLike = {
    run: async (args: ValidateDocumentArgs): Promise<ToolResult> => {
      calls.push(args);
      const next = script[cursor];
      cursor += 1;
      if (next === undefined) throw new Error(`fake script exhausted at call ${calls.length}`);
      return next;
    },
  };
  return { calls, tool };
}

function validator(script: readonly ToolResult[], options: { readonly maxToolRetries?: number } = {}) {
  const { calls, tool } = fakeTool(script);
  const service = new RunValidator({ tool, maxToolRetries: options.maxToolRetries });
  return { calls, service };
}

function expectReportOk(result: AgentResult<ValidatorReport>): ValidatorReport {
  expect(result.ok).toBe(true);
  if (result.ok) return result.value;
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Classification table (§5.1/§11.1)
// ---------------------------------------------------------------------------

interface ClassificationCase {
  readonly rows: readonly Row[];
  readonly verdict: "pass" | "blockers" | "warnings";
  readonly blockers: readonly string[];
  readonly majors: readonly string[];
  readonly minors: readonly string[];
}

const CLASSIFICATION_TABLE: readonly ClassificationCase[] = [
  { rows: [], verdict: "pass", blockers: [], majors: [], minors: [] },
  {
    rows: [row("blocker", "in_bounds")],
    verdict: "blockers",
    blockers: ["in_bounds"],
    majors: [],
    minors: [],
  },
  {
    rows: [row("blocker", "in_bounds"), row("blocker", "missing_font")],
    verdict: "blockers",
    blockers: ["in_bounds", "missing_font"],
    majors: [],
    minors: [],
  },
  {
    rows: [
      row("blocker", "contrast", { layer: "Body" }),
      row("major", "z_order"),
      row("minor", "naming"),
    ],
    verdict: "blockers",
    blockers: ["contrast"],
    majors: ["z_order"],
    minors: ["naming"],
  },
  {
    rows: [row("major", "headline_largest"), row("major", "safe_area")],
    verdict: "warnings",
    blockers: [],
    majors: ["headline_largest", "safe_area"],
    minors: [],
  },
  {
    rows: [row("minor", "empty_layers")],
    verdict: "warnings",
    blockers: [],
    majors: [],
    minors: ["empty_layers"],
  },
  {
    rows: [row("major", "min_font_size"), row("minor", "aspect")],
    verdict: "warnings",
    blockers: [],
    majors: ["min_font_size"],
    minors: ["aspect"],
  },
];

describe("validator service: §5.1 classification table", () => {
  it.each(CLASSIFICATION_TABLE)('classifies a "$verdict" document per §5.1', async (spec) => {
    const summary = summaryOf({ rows: spec.rows });
    const { calls, service } = validator([okResult(summary)]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID }));
    expect(calls.length).toBe(1);
    expect(report.verdict).toBe(spec.verdict);
    expect(report.blockers.map((issue) => issue.code)).toEqual([...spec.blockers]);
    expect(report.majors.map((issue) => issue.code)).toEqual([...spec.majors]);
    expect(report.minors.map((issue) => issue.code)).toEqual([...spec.minors]);
    expect(report.counts).toEqual({
      blocker: spec.blockers.length,
      major: spec.majors.length,
      minor: spec.minors.length,
    });
    expect(report.summary).toBe(summary); // §5.4 item 6: verbatim passthrough
    expect(report.warnings).toEqual([]);
  });

  it("classifies by level regardless of row order (§6.3 order is a convention)", async () => {
    const rows = [row("major", "overlap_text"), row("blocker", "editability"), row("minor", "aspect")];
    const { service } = validator([okResult(summaryOf({ rows }))]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID }));
    expect(report.verdict).toBe("blockers");
    expect(report.blockers.map((issue) => issue.code)).toEqual(["editability"]);
    expect(report.majors.map((issue) => issue.code)).toEqual(["overlap_text"]);
    expect(report.minors.map((issue) => issue.code)).toEqual(["aspect"]);
  });

  it("keeps the pre-cap counts when the tool truncated rows (§2.2)", async () => {
    const summary = summaryOf({
      counts: { blocker: 3, major: 2, minor: 1 },
      rows: [row("blocker", "in_bounds")],
      truncated: true,
    });
    const { service } = validator([okResult(summary)]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID }));
    expect(report.verdict).toBe("blockers"); // counts, not visible rows, gate §5.1
    expect(report.counts).toEqual({ blocker: 3, major: 2, minor: 1 });
    expect(report.blockers.length).toBe(1); // actionable subset only
    expect(report.truncated).toBe(true);
  });

  it("widens counts when visible rows exceed issueCounts (contract-breach guard)", async () => {
    const summary = summaryOf({ counts: { blocker: 0, major: 0, minor: 0 }, rows: [row("blocker", "in_bounds")] });
    const { service } = validator([okResult(summary)]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID }));
    expect(report.verdict).toBe("blockers"); // a visible blocker never passes
    expect(report.counts.blocker).toBe(1);
    expect(report.warnings.some((warning) => warning.includes("widened"))).toBe(true);
  });

  it("records tool warnings verbatim (§11.1 user notes)", async () => {
    const capWarning = "issue list capped at 25 (26 total); fix blockers first, then re-validate";
    const { service } = validator([
      okResult(summaryOf({ rows: [row("blocker", "in_bounds")] }), { warnings: [capWarning] }),
    ]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID }));
    expect(report.warnings).toEqual([capWarning]);
  });

  it("echoes the template pin the tool bound (§7.4)", async () => {
    const { service } = validator([okResult(summaryOf({ rows: [], template: TEMPLATE_PIN }))]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID, template: TEMPLATE_PIN }));
    expect(report.template).toBe(TEMPLATE_PIN);
    expect(report.verdict).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Tool wiring (§6.1 strict args) + input boundary
// ---------------------------------------------------------------------------

describe("validator service: tool wiring (§6.1 strict args)", () => {
  it("forwards exactly {documentId, template}; revision is service metadata only", async () => {
    const { calls, service } = validator([okResult(summaryOf({}))]);
    await service.validate({ documentId: DOC_ID, template: TEMPLATE_PIN, revision: 9 });
    expect(calls).toStrictEqual([{ documentId: DOC_ID, template: TEMPLATE_PIN }]);
    expect(Object.keys(calls[0] ?? {}).includes("revision")).toBe(false);
  });

  it("omits template from the tool args when unbound", async () => {
    const { calls, service } = validator([okResult(summaryOf({}))]);
    await service.validate({ documentId: DOC_ID, revision: 3 });
    expect(calls).toStrictEqual([{ documentId: DOC_ID }]);
  });

  it("rejects malformed input at its own boundary, without calling the tool", async () => {
    const { calls, service } = validator([okResult(summaryOf({}))]);
    const badId = await service.validate({ documentId: "not-a-uuid" });
    expect(badId.ok).toBe(false);
    if (badId.ok) throw new Error("unreachable");
    expect(badId.code).toBe("plan_invalid");
    expect(badId.retryable).toBe(false);

    const badRevision = await service.validate({ documentId: DOC_ID, revision: -1 });
    expect(badRevision.ok).toBe(false);

    const emptyTemplate = await service.validate({ documentId: DOC_ID, template: "" });
    expect(emptyTemplate.ok).toBe(false);

    // Extra keys are rejected (§6.1 additionalProperties:false discipline).
    // One documented cast: the compiler rightly stops this payload at the type.
    const extraKey = await service.validate({ documentId: DOC_ID, surprise: true } as unknown as RunValidateInput);
    expect(extraKey.ok).toBe(false);
    expect(calls.length).toBe(0); // never reached the tool
  });
});

// ---------------------------------------------------------------------------
// Revision passthrough (§5.4 item 6)
// ---------------------------------------------------------------------------

describe("validator service: revision passthrough", () => {
  it("adopts the tool-reported documentRevision", async () => {
    const { service } = validator([okResult(summaryOf({}), { documentRevision: 7 })]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID }));
    expect(report.revision).toBe(7);
    expect(report.expectedRevision).toBeUndefined();
    expect(report.staleRevision).toBe(false);
  });

  it("falls back to the caller's revision when the tool omits one", async () => {
    const { service } = validator([okResult(summaryOf({}))]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID, revision: 4 }));
    expect(report.revision).toBe(4);
    expect(report.staleRevision).toBe(false); // nothing to compare against
  });

  it("flags a stale report when the tool linted a different revision", async () => {
    const { service } = validator([okResult(summaryOf({}), { documentRevision: 7 })]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID, revision: 9 }));
    expect(report.revision).toBe(7); // what was actually linted
    expect(report.expectedRevision).toBe(9);
    expect(report.staleRevision).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("revision 7") && warning.includes("9"))).toBe(true);
  });

  it("is clean when the revisions agree", async () => {
    const { service } = validator([okResult(summaryOf({}), { documentRevision: 7 })]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID, revision: 7 }));
    expect(report.staleRevision).toBe(false);
    expect(report.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tool failures → typed agent envelopes (§13.3)
// ---------------------------------------------------------------------------

describe("validator service: tool failure mapping", () => {
  it.each([
    { code: "engine_timeout", expected: "run_timeout" },
    { code: "engine_unavailable", expected: "engine_session_lost" },
    { code: "engine_crashed", expected: "engine_session_lost" },
    { code: "rate_limited", expected: "provider_unhealthy" },
    { code: "provider_unhealthy", expected: "provider_unhealthy" },
    { code: "not_found", expected: "plan_invalid" },
    { code: "validation_failed", expected: "tool_retry_exhausted" },
    { code: "internal_error", expected: "tool_retry_exhausted" },
    { code: "ambiguous_layer", expected: "tool_retry_exhausted" },
  ] as const)("$code maps to agent code $expected", async ({ code, expected }) => {
    const { calls, service } = validator([errResult(code, "tool said boom", { hint: "tool hint", retryable: false })]);
    const result = await service.validate({ documentId: DOC_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe(expected);
    expect(result.message).toContain("Document validation failed");
    expect(result.message).toContain("tool said boom");
    expect(result.hint).toBe("tool hint");
    expect(result.retryable).toBe(false);
    expect(calls.length).toBe(1); // fatal: no service retry
  });

  it("retries a retryable failure once (§6 freely retryable) and passes on attempt 2", async () => {
    const { calls, service } = validator([
      errResult("engine_timeout", "engine hiccup", { retryable: true }),
      okResult(summaryOf({ rows: [row("minor", "naming")] }), { documentRevision: 2 }),
    ]);
    const report = expectReportOk(await service.validate({ documentId: DOC_ID }));
    expect(calls.length).toBe(2);
    expect(report.verdict).toBe("warnings");
    expect(report.revision).toBe(2); // the SECOND attempt's revision is authoritative
  });

  it("surfaces the mapped code with passthrough retryability once retries are spent", async () => {
    const { calls, service } = validator([
      errResult("engine_timeout", "engine hiccup", { retryable: true }),
      errResult("engine_timeout", "engine hiccup", { retryable: true }),
    ]);
    const result = await service.validate({ documentId: DOC_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("run_timeout");
    expect(result.retryable).toBe(true); // loop owner still decides (§6.3/§5.2)
    expect(calls.length).toBe(2);
  });

  it("honors maxToolRetries: 0 — the worker owns all retries (§6.3)", async () => {
    const { calls, service } = validator(
      [errResult("engine_timeout", "engine hiccup", { retryable: true }), okResult(summaryOf({}))],
      { maxToolRetries: 0 },
    );
    const result = await service.validate({ documentId: DOC_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("run_timeout");
    expect(calls.length).toBe(1);
  });

  it("converts a thrown seam error to engine_session_lost without leaking the cause", async () => {
    const tool: ValidateToolLike = {
      // A thrown error means the SEAM broke (defineTool returns envelopes);
      // the run must get a typed envelope, never an exception, never a stack.
      run: async () => {
        throw new Error("secret-token /abs/path");
      },
    };
    const service = new RunValidator({ tool });
    const result = await service.validate({ documentId: DOC_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("engine_session_lost");
    expect(result.retryable).toBe(false);
    expect(result.message).not.toContain("secret-token");
    expect(result.message).not.toContain("/abs/path");
  });

  it("rejects an unreadable summary deterministically (no retry)", async () => {
    for (const summary of ["definitely not json", '{"unexpected":true}', ""]) {
      const { calls, service } = validator([okResult(summary)]);
      const result = await service.validate({ documentId: DOC_ID });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("tool_retry_exhausted");
      expect(result.retryable).toBe(false);
      expect(result.hint).toContain("§6.1");
      expect(calls.length).toBe(1);
    }
  });

  it("pins the default service retry budget", () => {
    expect(DEFAULT_MAX_TOOL_RETRIES).toBe(1);
  });

  it("fails fast on a malformed retry budget (BudgetTracker precedent)", () => {
    const { tool } = fakeTool([]);
    expect(() => new RunValidator({ tool, maxToolRetries: -1 })).toThrow(RangeError);
    expect(() => new RunValidator({ tool, maxToolRetries: 1.5 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Contract pin — the shipped tool's summary parses (kills format drift)
// ---------------------------------------------------------------------------

describe("validator service: contract pin against the real tool summary", () => {
  it("accepts the shipped buildReport + renderSummary output", () => {
    const report = buildReport(
      [
        {
          level: "blocker",
          code: "in_bounds",
          layer: "Photo",
          message: "Photo is fully outside the canvas.",
          fix: "Move Photo back inside the canvas bounds.",
        },
        {
          level: "minor",
          code: "naming",
          message: "Layer 3 is a machine name.",
          fix: "Rename to a role name such as Headline.",
        },
      ] satisfies readonly ValidationIssue[],
      { template: TEMPLATE_PIN },
    );
    const parsed = parseValidateSummary(renderSummary(report));
    expect(parsed).toBeDefined();
    if (parsed === undefined) throw new Error("unreachable");
    const classified = classifyOutcome(parsed);
    expect(classified.verdict).toBe("blockers");
    expect(classified.blockers[0]?.code).toBe("in_bounds");
    expect(classified.minors[0]?.code).toBe("naming");
    expect(classified.counts).toEqual({ blocker: 1, major: 0, minor: 1 });
    expect(classified.coherent).toBe(true);
    expect(parsed.template).toBe(TEMPLATE_PIN);
    expect(parsed.truncated).toBe(false);
  });
});
