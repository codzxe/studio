// export-document.test.ts — export_document (§6 row 18): delegation seam,
// bounded poll table, event fast-path, pipeline-failure mapping, URL scheme
// validation, §10.3 defaults and §2.3 PSD policy.
//
// Deterministic: no network, no real waits (helper-level sleeps are injected
// no-ops; the one tool-level bounded-wait test drives mocked timers), fakes
// implement the declared seams (tests/fakes.ts for the rest of ToolContext).

import { describe, expect, it, vi } from "vitest";
import { isToolResult, parseToolArgs } from "../src/kit.js";
import { TOOLS, ToolRegistry } from "../src/registry.js";
import {
  EXPORT_FAILED_CODE,
  EXPORT_FORMAT_SCHEMA,
  EXPORT_WAIT_BUDGET_MS,
  MAX_EXPORT_URL_CHARS,
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  PSD_EXPERIMENTAL_WARNING,
  PSD_NOT_OFFERED_HINT,
  awaitExportTerminal,
  buildExportSummary,
  deriveExportIdempotencyKey,
  exportDocumentTool,
  exportPipelineErr,
  isSafeExportUrl,
  isTerminalExportStatus,
  sleepUntilResolved,
  type ExportEventsLike,
  type ExportFormat,
  type ExportJobRecord,
  type ExportJobsLike,
  type ExportSubmission,
} from "../src/tools/export-document.js";
import type { EngineOutcome, ToolContext, ToolOk } from "../src/types.js";
import { abortedSignal, freshSignal, makeFakeContext } from "./fakes.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeJobsInit {
  readonly enqueue?: EngineOutcome<{ exportId: string; status: ExportJobRecord["status"] }>;
  readonly queue?: readonly EngineOutcome<ExportJobRecord>[];
  readonly repeat?: EngineOutcome<ExportJobRecord>;
  readonly enqueueThrows?: Error;
}

class FakeExportJobs implements ExportJobsLike {
  readonly submissions: ExportSubmission[] = [];
  readonly signals: readonly (AbortSignal | undefined)[] = [];
  readonly getLog: string[] = [];
  private readonly queue: EngineOutcome<ExportJobRecord>[];

  constructor(private readonly init: FakeJobsInit = {}) {
    this.queue = [...(init.queue ?? [])];
  }

  async enqueueExport(
    submission: ExportSubmission,
    options?: { readonly signal?: AbortSignal },
  ): Promise<EngineOutcome<{ exportId: string; status: ExportJobRecord["status"] }>> {
    this.submissions.push(submission);
    (this.signals as (AbortSignal | undefined)[]).push(options?.signal);
    if (this.init.enqueueThrows !== undefined) {
      throw this.init.enqueueThrows;
    }
    return this.init.enqueue ?? { ok: true, value: { exportId: "exp-000", status: "queued" } };
  }

  async getExport(exportId: string): Promise<EngineOutcome<ExportJobRecord>> {
    this.getLog.push(exportId);
    const outcome = this.queue.length > 0 ? this.queue.shift() : undefined;
    if (outcome !== undefined) {
      return outcome;
    }
    return this.init.repeat ?? { ok: true, value: { exportId, status: "queued" } };
  }
}

class FakeExportEvents implements ExportEventsLike {
  readonly calls: string[] = [];

  constructor(
    private readonly reply: ExportJobRecord | undefined | "hang" = undefined,
  ) {}

  async waitForExport(exportId: string): Promise<ExportJobRecord | undefined> {
    this.calls.push(exportId);
    if (this.reply === "hang") {
      return new Promise<ExportJobRecord | undefined>(() => {});
    }
    return this.reply;
  }
}

function makeExportContext(parts: {
  exports?: ExportJobsLike;
  exportEvents?: ExportEventsLike;
} = {}): ToolContext {
  return { ...makeFakeContext(), ...parts } as ToolContext;
}

const record = (overrides: Partial<ExportJobRecord> = {}): ExportJobRecord => ({
  exportId: "exp-000",
  status: "succeeded",
  url: "https://objects.example.com/exports/organizations/o/documents/d/exp-x-r1.pcraft",
  warnings: [],
  ...overrides,
});

/** A `getExport` fake playing `script` once, then `repeat` forever. */
function scriptedGetExport(
  script: readonly EngineOutcome<ExportJobRecord>[],
  repeat?: EngineOutcome<ExportJobRecord>,
): { calls: string[]; getExport: (id: string) => Promise<EngineOutcome<ExportJobRecord>> } {
  const calls: string[] = [];
  let index = 0;
  const getExport = async (
    exportId: string,
  ): Promise<EngineOutcome<ExportJobRecord>> => {
    calls.push(exportId);
    const outcome = script[index] ?? repeat;
    index += 1;
    return outcome ?? { ok: true, value: { exportId, status: "queued" } };
  };
  return { calls, getExport };
}

/** A no-op sleep recorder (helper-level tests never touch real timers). */
function recordingSleep(msLog: number[] = []): (ms: number) => Promise<void> {
  return async (ms: number) => {
    msLog.push(ms);
  };
}

function summaryJson(result: ToolOk): Record<string, unknown> {
  return JSON.parse(result.summary) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// §6.1 strict argument schema
// ---------------------------------------------------------------------------

describe("export_document — argument schema (§6.1 strict)", () => {
  it("defaults to the lossless pcraft format (§10.3)", () => {
    const parsed = parseToolArgs(exportDocumentTool, {});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.format).toBe("pcraft");
      expect(parsed.args.width).toBeUndefined();
      expect(parsed.args.height).toBeUndefined();
      expect(parsed.args.quality).toBeUndefined();
    }
  });

  it("rejects psd with the §2.3 experimental hint", () => {
    const parsed = parseToolArgs(exportDocumentTool, { format: "psd" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
      expect(parsed.hint).toContain("psd export is experimental");
      expect(parsed.hint).toContain("pcraft");
      expect(parsed.hint).toContain(PSD_NOT_OFFERED_HINT);
    }
  });

  it.each([
    ["webp"],
    ["PNG"],
    [""],
    [42],
    [null],
    [true],
    ["psd "],
    [{ format: "png" }],
  ])("rejects unknown format %p", (raw) => {
    const parsed = parseToolArgs(exportDocumentTool, { format: raw });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_args");
    }
  });

  it.each([0, -1, 8193, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "800", null])(
    "rejects invalid width/height %p",
    (value) => {
      for (const key of ["width", "height"] as const) {
        const parsed = parseToolArgs(exportDocumentTool, { [key]: value });
        expect(parsed.ok).toBe(false);
      }
    },
  );

  it.each([0, 101, 2.5, Number.NaN, "90", null])("rejects quality out of 1..100: %p", (value) => {
    const parsed = parseToolArgs(exportDocumentTool, { quality: value });
    expect(parsed.ok).toBe(false);
  });

  it.each([1, 100])("accepts quality %p", (value) => {
    const parsed = parseToolArgs(exportDocumentTool, { quality: value });
    expect(parsed.ok).toBe(true);
  });

  it.each([1, 8192])("accepts width/height boundary %p", (value) => {
    const parsed = parseToolArgs(exportDocumentTool, { width: value, height: value });
    expect(parsed.ok).toBe(true);
  });

  it("rejects unknown properties and non-object args", () => {
    expect(parseToolArgs(exportDocumentTool, { format: "png", psd: true }).ok).toBe(false);
    expect(parseToolArgs(exportDocumentTool, null).ok).toBe(false);
    expect(parseToolArgs(exportDocumentTool, 42).ok).toBe(false);
    expect(parseToolArgs(exportDocumentTool, "png").ok).toBe(false);
  });

  it("parses a full valid call", () => {
    const parsed = parseToolArgs(exportDocumentTool, {
      format: "jpg",
      width: 800,
      height: 600,
      quality: 90,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual({
        format: "jpg",
        width: 800,
        height: 600,
        quality: 90,
      });
    }
  });

  it("EXPORT_FORMAT_SCHEMA yields only the three offered formats", () => {
    const values = new Set<string>();
    for (const value of ["pcraft", "png", "jpg"]) {
      const parsed = EXPORT_FORMAT_SCHEMA.safeParse(value);
      expect(parsed.success).toBe(true);
      values.add(value);
    }
    expect(values).toEqual(new Set(["pcraft", "png", "jpg"]));
  });
});

// ---------------------------------------------------------------------------
// Idempotency key (§3.4 retries / §10.3 free re-downloads)
// ---------------------------------------------------------------------------

describe("deriveExportIdempotencyKey", () => {
  it.each([
    [{ format: "pcraft" }, "exp-pcraft-autoxauto"],
    [{ format: "png" }, "exp-png-autoxauto"],
    [
      { format: "jpg", width: 800, height: 600, quality: 90 },
      "exp-jpg-800x600-q90",
    ],
    [{ format: "png", width: 2048 }, "exp-png-2048xauto"],
    [{ format: "png", quality: 100 }, "exp-png-autoxauto-q100"],
  ])("derives %j → %s", (args, expected) => {
    expect(deriveExportIdempotencyKey(args as { format: ExportFormat })).toBe(expected);
  });

  it("is deterministic and key-segment safe (worker keySegment pattern)", () => {
    const key = deriveExportIdempotencyKey({
      format: "pcraft",
      width: 8192,
      height: 8192,
      quality: 100,
    });
    expect(key).toBe("exp-pcraft-8192x8192-q100");
    expect(deriveExportIdempotencyKey({ format: "pcraft", width: 8192, height: 8192, quality: 100 })).toBe(key);
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delegation through the seam
// ---------------------------------------------------------------------------

describe("export_document — delegation", () => {
  it("delegates a deterministic idempotent submission with only model-controlled fields", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-000", status: "succeeded" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(
      ctx,
      { format: "jpg", width: 800, height: 600, quality: 90 },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    expect(jobs.submissions).toEqual([
      {
        format: "jpg",
        width: 800,
        height: 600,
        quality: 90,
        idempotencyKey: "exp-jpg-800x600-q90",
      },
    ]);
  });

  it("derives the same key across calls (retries land on the same job)", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-000", status: "succeeded" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(jobs.submissions[0]?.idempotencyKey).toBe("exp-png-autoxauto");
    expect(jobs.submissions[1]?.idempotencyKey).toBe("exp-png-autoxauto");
  });

  it("omits optional fields when the model did not send them", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-000", status: "succeeded" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(Object.keys(jobs.submissions[0] ?? {}).sort()).toEqual([
      "format",
      "idempotencyKey",
    ]);
  });

  it("forwards the executor signal to the enqueue seam", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-000", status: "succeeded" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    const signal = freshSignal();
    await exportDocumentTool.run(ctx, { format: "png" }, signal);
    expect(jobs.signals[0]).toBe(signal);
  });

  it("fails with internal_error when the seam is not wired", async () => {
    const ctx = makeExportContext();
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal_error");
      expect(result.message).toContain("export job seam");
    }
  });

  it("passes seam failures through with code, hint and retryable preserved", async () => {
    const jobs = new FakeExportJobs({
      enqueue: {
        ok: false,
        code: "rate_limited",
        message: "too many export jobs",
        hint: "wait and retry",
        retryable: true,
      },
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rate_limited");
      expect(result.message).toBe("too many export jobs");
      expect(result.hint).toBe("wait and retry");
      expect(result.retryable).toBe(true);
    }
  });

  it("converts transport throws into sanitized internal_error (no path leaks)", async () => {
    const jobs = new FakeExportJobs({
      enqueueThrows: new Error("connect ECONNREFUSED 127.0.0.1:9999 /var/run/secret.sock"),
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal_error");
      expect(result.message).not.toContain("ECONNREFUSED");
      expect(result.message).not.toContain("/var/run");
      expect(String(result.hint)).not.toContain("/var/run");
    }
  });

  it("fast path: a terminal enqueue reply skips polling entirely", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-9", status: "succeeded" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "pcraft" }, freshSignal());
    expect(result.ok).toBe(true);
    expect(jobs.getLog).toEqual([]);
    if (result.ok) {
      const summary = summaryJson(result);
      expect(summary.exportId).toBe("exp-9");
      expect(summary.status).toBe("succeeded");
      expect(summary.format).toBe("pcraft");
    }
  });

  it("first poll resolves the export without sleeping", async () => {
    const jobs = new FakeExportJobs({
      queue: [{ ok: true, value: record({ exportId: "exp-000", documentRevision: 7 }) }],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(true);
    expect(jobs.getLog).toEqual(["exp-000"]);
    if (result.ok) {
      expect(result.documentRevision).toBe(7);
      expect(summaryJson(result).status).toBe("succeeded");
      expect(String(summaryJson(result).url)).toContain("https://");
    }
  });
});

// ---------------------------------------------------------------------------
// Result envelope: summary fact set + fidelity warnings + revision
// ---------------------------------------------------------------------------

describe("export_document — result envelope", () => {
  it("returns the task's fact set as compact JSON in the kit string summary", async () => {
    const jobs = new FakeExportJobs({
      queue: [
        {
          ok: true,
          value: record({ warnings: ["jpeg quality ignored for png"], documentRevision: 4 }),
        },
      ],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "jpg" }, freshSignal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isToolResult(result)).toBe(true);
      const summary = summaryJson(result);
      expect(Object.keys(summary).sort()).toEqual([
        "exportId",
        "format",
        "status",
        "url",
        "warnings",
      ]);
      expect(summary.format).toBe("jpg");
      expect(summary.status).toBe("succeeded");
      expect(summary.warnings).toEqual(["jpeg quality ignored for png"]);
      expect(result.documentRevision).toBe(4);
    }
  });

  it("surfaces pipeline fidelity warnings (JPEG quality on a lossless format)", async () => {
    const warning = "quality applies to JPEG exports only and was ignored for this lossless format";
    const jobs = new FakeExportJobs({
      repeat: {
        ok: true,
        value: record({ warnings: [warning], documentRevision: 12 }),
      },
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(
      ctx,
      { format: "png", quality: 90 },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([warning]);
      expect(result.documentRevision).toBe(12);
      expect(summaryJson(result).warnings).toEqual([warning]);
    }
  });

  it("caps 30 × 600-char pipeline warnings to the kit limits (≤20 × ≤500)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `${"w".repeat(600)}-${i}`);
    const jobs = new FakeExportJobs({
      queue: [{ ok: true, value: record({ warnings: many }) }],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.warnings ?? []).length).toBeLessThanOrEqual(20);
      for (const warning of result.warnings ?? []) {
        expect(warning.length).toBeLessThanOrEqual(500);
        expect(warning.length).toBeGreaterThan(0);
      }
      expect(result.summary.length).toBeLessThanOrEqual(2000);
    }
  });

  it("omits documentRevision when the job record does not echo one", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-1", status: "succeeded" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.documentRevision).toBeUndefined();
      expect("documentRevision" in result).toBe(false);
    }
  });

  it("sanitizes an invalid echoed documentRevision instead of failing", async () => {
    const jobs = new FakeExportJobs({
      queue: [{ ok: true, value: record({ documentRevision: -1 }) }],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.documentRevision).toBeUndefined();
    }
  });

  it("keeps the §2.3 PSD fidelity label branch for gateway parity (unreachable via schema)", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-1", status: "succeeded" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    // psd can never be parsed from model output; drive the run function directly
    // to pin the parity branch (the gateway/UI surface may offer PSD, §2.3).
    const result = await exportDocumentTool.run(
      ctx,
      { format: "psd" as ExportFormat },
      freshSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContain(PSD_EXPERIMENTAL_WARNING);
      expect(PSD_EXPERIMENTAL_WARNING.length).toBeLessThanOrEqual(500);
      expect(summaryJson(result).format).toBe("psd");
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline failures → export_failed (task mapping)
// ---------------------------------------------------------------------------

describe("export_document — pipeline failures", () => {
  it("maps a failed job to a retryable export failure with the pipeline hint", async () => {
    const jobs = new FakeExportJobs({
      queue: [
        {
          ok: true,
          value: record({
            status: "failed",
            errorCode: "export_engine_failed",
            errorMessage: "the engine failed to write the export file",
            url: undefined,
          }),
        },
      ],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(EXPORT_FAILED_CODE);
      expect(result.retryable).toBe(true);
      expect(result.hint).toContain("export_engine_failed");
      expect(result.hint).toContain("the engine failed to write the export file");
    }
  });

  it("maps a failed enqueue handle without polling", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-1", status: "failed" } },
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(false);
    expect(jobs.getLog).toEqual([]);
    if (!result.ok) {
      expect(result.code).toBe(EXPORT_FAILED_CODE);
      expect(result.retryable).toBe(true);
      expect(result.hint).toContain("unknown");
    }
  });

  it("maps the §14.1 plan ceiling to a non-retryable plan_limit error", async () => {
    const jobs = new FakeExportJobs({
      queue: [
        {
          ok: true,
          value: record({
            status: "failed",
            errorCode: "canvas_exceeds_plan_limit",
            errorMessage: "requested export size of 20000×20000 px exceeds the 32 MP ceiling",
            url: undefined,
          }),
        },
      ],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("plan_limit");
      expect(result.retryable).toBe(false);
      expect(result.message).toContain("32 MP ceiling");
      expect(result.hint).toContain("§14.1");
    }
  });

  it("defensively maps experimental_psd and invalid_export_request (non-retryable)", () => {
    const psd = exportPipelineErr("experimental_psd", "PSD export is experimental");
    expect(psd.code).toBe("validation_failed");
    expect(psd.retryable).toBe(false);
    expect(psd.hint).toBe(PSD_NOT_OFFERED_HINT);

    const invalid = exportPipelineErr("invalid_export_request", "schema rejected");
    expect(invalid.code).toBe("validation_failed");
    expect(invalid.retryable).toBe(false);

    const noReason = exportPipelineErr(undefined, undefined);
    expect(noReason.code).toBe(EXPORT_FAILED_CODE);
    expect(noReason.retryable).toBe(true);
    expect(String(noReason.hint)).toContain("unknown");
  });

  it("maps store/sign failures to the retryable export failure code", () => {
    for (const code of [
      "export_store_failed",
      "export_sign_failed",
      "invalid_export_bytes",
      "some-future-code",
    ]) {
      const mapped = exportPipelineErr(code, "boom");
      expect(mapped.code).toBe(EXPORT_FAILED_CODE);
      expect(mapped.retryable).toBe(true);
      expect(String(mapped.hint)).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// URL scheme validation (signed, validated http(s))
// ---------------------------------------------------------------------------

describe("isSafeExportUrl", () => {
  it.each([
    ["https://objects.example.com/e/o/d/exp-x-r1.pcraft?sig=abc", true],
    ["http://objects.example.com/e.png", true],
    ["https://example.com/a/b/c.jpg?X-Amz-Signature=abc&x=1#frag", true],
    ["s3://internal-bucket/key", false],
    ["file:///etc/passwd", false],
    ["javascript:alert(1)", false],
    ["ftp://host/x", false],
    ["/exports/relative.png", false],
    ["objects.example.com/x.png", false],
    ["not a url", false],
    ["", false],
    ["https://example.com/../secret", false],
    ["https://example.com/a\\b", false],
    [`https://example.com/${"a".repeat(1600)}`, false],
  ])("%p → %p", (url, expected) => {
    expect(isSafeExportUrl(url)).toBe(expected);
  });

  it("accepts urls up to the cap and rejects past it", () => {
    const exact = `https://e.example/${"a".repeat(MAX_EXPORT_URL_CHARS - "https://e.example/".length)}`;
    expect(exact.length).toBe(MAX_EXPORT_URL_CHARS);
    expect(isSafeExportUrl(exact)).toBe(true);
    expect(isSafeExportUrl(`${exact}x`)).toBe(false);
  });

  it("a succeeded record with an unsafe URL becomes a retryable export failure (no echo)", async () => {
    const jobs = new FakeExportJobs({
      queue: [{ ok: true, value: record({ url: "file:///var/exports/secret.pcraft" }) }],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(EXPORT_FAILED_CODE);
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("http(s)");
      expect(result.message).not.toContain("file:");
      expect(String(result.hint)).not.toContain("/var/exports");
      expect(String(result.hint)).not.toContain("secret.pcraft");
    }
  });

  it("a succeeded record without a URL degrades to a warning, never a fake link", async () => {
    const jobs = new FakeExportJobs({
      enqueue: { ok: true, value: { exportId: "exp-1", status: "succeeded" } },
      queue: [{ ok: true, value: record({ url: undefined }) }],
    });
    const ctx = makeExportContext({ exports: jobs });
    const result = await exportDocumentTool.run(ctx, { format: "pcraft" }, freshSignal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(summaryJson(result).url).toBeUndefined();
      expect(result.warnings?.some((w) => w.includes("no download URL"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded polling (task table: success / failure / timeout / abort)
// ---------------------------------------------------------------------------

describe("awaitExportTerminal — bounded poll table", () => {
  it("polls to success: 3 reads, 2 sleeps, terminal record", async () => {
    const { calls, getExport } = scriptedGetExport([
      { ok: true, value: record({ status: "queued", url: undefined }) },
      { ok: true, value: record({ status: "active", url: undefined }) },
      { ok: true, value: record({ status: "succeeded" }) },
    ]);
    const msLog: number[] = [];
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      signal: freshSignal(),
      sleep: recordingSleep(msLog),
    });
    expect(awaited.kind).toBe("record");
    if (awaited.kind === "record") {
      expect(awaited.record.status).toBe("succeeded");
    }
    expect(calls).toEqual(["exp-1", "exp-1", "exp-1"]);
    expect(msLog).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it("polls to failure and reports the record", async () => {
    const { getExport } = scriptedGetExport([
      { ok: true, value: record({ status: "failed", errorCode: "export_store_failed" }) },
    ]);
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      signal: freshSignal(),
      sleep: recordingSleep(),
    });
    expect(awaited.kind).toBe("record");
    if (awaited.kind === "record") {
      expect(awaited.record.status).toBe("failed");
    }
  });

  it("timeout: exhausted after maxAttempts with the last non-terminal record", async () => {
    const { calls, getExport } = scriptedGetExport([], {
      ok: true,
      value: record({ status: "queued", url: undefined }),
    });
    const msLog: number[] = [];
    const awaited = await awaitExportTerminal(
      {
        exportId: "exp-1",
        getExport,
        signal: freshSignal(),
        sleep: recordingSleep(msLog),
      },
      { maxAttempts: 3, intervalMs: 5 },
    );
    expect(awaited.kind).toBe("exhausted");
    if (awaited.kind === "exhausted") {
      expect(awaited.record?.status).toBe("queued");
      expect(awaited.lastFailure).toBeUndefined();
    }
    expect(calls).toHaveLength(3);
    expect(msLog).toEqual([5, 5]);
  });

  it("default bound is exactly POLL_MAX_ATTEMPTS reads (≤30)", async () => {
    const { calls, getExport } = scriptedGetExport([], {
      ok: true,
      value: record({ status: "active", url: undefined }),
    });
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      signal: freshSignal(),
      sleep: recordingSleep(),
    });
    expect(awaited.kind).toBe("exhausted");
    expect(calls).toHaveLength(POLL_MAX_ATTEMPTS);
    expect(calls.length).toBeLessThanOrEqual(30);
    expect(POLL_MAX_ATTEMPTS).toBe(30);
    expect(POLL_INTERVAL_MS).toBe(2000);
    expect(EXPORT_WAIT_BUDGET_MS).toBe(60000);
  });

  it("clamps a caller-oversized maxAttempts to the contract bound", async () => {
    const { calls, getExport } = scriptedGetExport([], {
      ok: true,
      value: record({ status: "queued", url: undefined }),
    });
    const awaited = await awaitExportTerminal(
      {
        exportId: "exp-1",
        getExport,
        signal: freshSignal(),
        sleep: recordingSleep(),
      },
      { maxAttempts: 99 },
    );
    expect(awaited.kind).toBe("exhausted");
    expect(calls).toHaveLength(30);
  });

  it("aborted before the first read: zero calls", async () => {
    const { calls, getExport } = scriptedGetExport([]);
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      signal: abortedSignal(),
      sleep: recordingSleep(),
    });
    expect(awaited.kind).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  it("aborted mid-poll: returns aborted after the sleep resolves", async () => {
    const controller = new AbortController();
    const { calls, getExport } = scriptedGetExport([], {
      ok: true,
      value: record({ status: "queued", url: undefined }),
    });
    const sleep = async (): Promise<void> => {
      controller.abort();
    };
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      signal: controller.signal,
      sleep,
    });
    expect(awaited.kind).toBe("aborted");
    expect(calls).toHaveLength(1);
  });

  it("survives read blips (read-after-write lag) and still resolves", async () => {
    const blip: EngineOutcome<ExportJobRecord> = {
      ok: false,
      code: "storage_error",
      message: "row not visible yet",
      retryable: true,
    };
    const { calls, getExport } = scriptedGetExport([
      blip,
      blip,
      { ok: true, value: record({ status: "succeeded" }) },
    ]);
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      signal: freshSignal(),
      sleep: recordingSleep(),
    });
    expect(awaited.kind).toBe("record");
    expect(calls).toHaveLength(3);
  });

  it("all reads failing: exhausted with the last failure and no record", async () => {
    const { calls, getExport } = scriptedGetExport([], {
      ok: false,
      code: "engine_unavailable",
      message: "job store unreachable",
      retryable: true,
    });
    const awaited = await awaitExportTerminal(
      {
        exportId: "exp-1",
        getExport,
        signal: freshSignal(),
        sleep: recordingSleep(),
      },
      { maxAttempts: 2, intervalMs: 1 },
    );
    expect(awaited.kind).toBe("exhausted");
    if (awaited.kind === "exhausted") {
      expect(awaited.record).toBeUndefined();
      expect(awaited.lastFailure?.code).toBe("engine_unavailable");
    }
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Event-subscribe fast-path (used when the seam is present)
// ---------------------------------------------------------------------------

describe("awaitExportTerminal — event seam", () => {
  it("delivers the terminal record without a single poll read", async () => {
    const { calls, getExport } = scriptedGetExport([]);
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      waitForExport: async () => record({ status: "succeeded" }),
      signal: freshSignal(),
      sleep: recordingSleep(),
    });
    expect(awaited.kind).toBe("record");
    expect(calls).toHaveLength(0);
  });

  it("subscription silent until the budget: one authoritative read decides", async () => {
    const { calls, getExport } = scriptedGetExport([], {
      ok: true,
      value: record({ status: "succeeded", documentRevision: 3 }),
    });
    const awaited = await awaitExportTerminal(
      {
        exportId: "exp-1",
        getExport,
        waitForExport: new FakeExportEvents("hang").waitForExport,
        signal: freshSignal(),
        sleep: recordingSleep(),
      },
      { maxAttempts: 3, intervalMs: 4 },
    );
    expect(awaited.kind).toBe("record");
    if (awaited.kind === "record") {
      expect(awaited.record.status).toBe("succeeded");
    }
    expect(calls).toHaveLength(1);
  });

  it("subscription timeout with a still-running job: exhausted with last record", async () => {
    const { calls, getExport } = scriptedGetExport([], {
      ok: true,
      value: record({ status: "queued", url: undefined }),
    });
    const awaited = await awaitExportTerminal(
      {
        exportId: "exp-1",
        getExport,
        waitForExport: new FakeExportEvents("hang").waitForExport,
        signal: freshSignal(),
        sleep: recordingSleep(),
      },
      { maxAttempts: 2, intervalMs: 4 },
    );
    expect(awaited.kind).toBe("exhausted");
    if (awaited.kind === "exhausted") {
      expect(awaited.record?.status).toBe("queued");
    }
    expect(calls).toHaveLength(1);
  });

  it("subscription timeout where the follow-up read fails: exhausted with failure", async () => {
    const { getExport } = scriptedGetExport([], {
      ok: false,
      code: "storage_error",
      message: "job row unreadable",
      retryable: true,
    });
    const awaited = await awaitExportTerminal(
      {
        exportId: "exp-1",
        getExport,
        waitForExport: new FakeExportEvents("hang").waitForExport,
        signal: freshSignal(),
        sleep: recordingSleep(),
      },
      { maxAttempts: 2, intervalMs: 4 },
    );
    expect(awaited.kind).toBe("exhausted");
    if (awaited.kind === "exhausted") {
      expect(awaited.record).toBeUndefined();
      expect(awaited.lastFailure?.message).toBe("job row unreadable");
    }
  });

  it("non-terminal event delivery: the follow-up read decides", async () => {
    const { calls, getExport } = scriptedGetExport([], {
      ok: true,
      value: record({ status: "failed", errorCode: "export_engine_failed" }),
    });
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      waitForExport: async () => record({ status: "active", url: undefined }),
      signal: freshSignal(),
      sleep: recordingSleep(),
    });
    expect(awaited.kind).toBe("record");
    if (awaited.kind === "record") {
      expect(awaited.record.status).toBe("failed");
    }
    expect(calls).toHaveLength(1);
  });

  it("abort during an event wait: aborted, and no follow-up read", async () => {
    const { calls, getExport } = scriptedGetExport([]);
    const awaited = await awaitExportTerminal({
      exportId: "exp-1",
      getExport,
      waitForExport: new FakeExportEvents("hang").waitForExport,
      signal: abortedSignal(),
      sleep: recordingSleep(),
    });
    expect(awaited.kind).toBe("aborted");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool-level waiting composition
// ---------------------------------------------------------------------------

describe("export_document — waiting composition", () => {
  it("uses the event seam when present (no polling reads, no timers leaked)", async () => {
    const controller = new AbortController();
    const jobs = new FakeExportJobs(); // would poll 30× if the event seam were ignored
    const events = new FakeExportEvents(record({ exportId: "exp-000", status: "succeeded" }));
    const ctx = makeExportContext({ exports: jobs, exportEvents: events });
    const pending = exportDocumentTool.run(ctx, { format: "png" }, controller.signal);
    const result = await pending;
    controller.abort(); // clears the raced 60 s budget timer (sleepUntilResolved)
    expect(events.calls).toEqual(["exp-000"]);
    expect(jobs.getLog).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(summaryJson(result).status).toBe("succeeded");
    }
  });

  it("returns ok with the last status when the bounded wait is exhausted", async () => {
    vi.useFakeTimers();
    try {
      const jobs = new FakeExportJobs(); // queued forever
      const ctx = makeExportContext({ exports: jobs });
      const pending = exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
      await vi.advanceTimersByTimeAsync(EXPORT_WAIT_BUDGET_MS);
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(jobs.getLog).toHaveLength(POLL_MAX_ATTEMPTS);
        const summary = summaryJson(result);
        expect(summary.status).toBe("queued");
        expect(summary.exportId).toBe("exp-000");
        expect(summary.url).toBeUndefined();
        expect(
          (result.warnings ?? []).some((w) => w.includes("still processing")),
        ).toBe(true);
        expect(String(result.summary).length).toBeLessThanOrEqual(2000);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns engine_timeout (retryable) when the run deadline aborts the poll", async () => {
    const controller = new AbortController();
    const jobs = new FakeExportJobs(); // queued forever → poll forever
    const ctx = makeExportContext({ exports: jobs });
    const pending = exportDocumentTool.run(ctx, { format: "png" }, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_timeout");
      expect(result.retryable).toBe(true);
      expect(String(result.hint)).toContain("idempotent");
    }
  });

  it("exhausted polls with unreadable status surface the last read failure", async () => {
    vi.useFakeTimers();
    try {
      const jobs = new FakeExportJobs({
        repeat: { ok: false, code: "storage_error", message: "job rows unreadable", retryable: true },
      });
      const ctx = makeExportContext({ exports: jobs });
      const pending = exportDocumentTool.run(ctx, { format: "png" }, freshSignal());
      await vi.advanceTimersByTimeAsync(EXPORT_WAIT_BUDGET_MS);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("storage_error");
        expect(result.message).toBe("job rows unreadable");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("sleepUntilResolved resolves early on abort", async () => {
    const controller = new AbortController();
    const pending = sleepUntilResolved(60_000, controller.signal);
    controller.abort();
    await pending; // resolves (never rejects, never hangs)
  });
});

// ---------------------------------------------------------------------------
// Summary budget helpers
// ---------------------------------------------------------------------------

describe("buildExportSummary (§6.1 small-reply rule)", () => {
  it("embeds exactly the task's fact set", () => {
    const summary = buildExportSummary({
      exportId: "exp-1",
      format: "pcraft",
      status: "succeeded",
      url: "https://objects.example.com/x.pcraft",
      warnings: ["one", "two"],
    });
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "exportId",
      "format",
      "status",
      "url",
      "warnings",
    ]);
  });

  it("omits the url and warnings keys when absent", () => {
    const parsed = JSON.parse(
      buildExportSummary({
        exportId: "exp-1",
        format: "png",
        status: "queued",
        warnings: [],
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["exportId", "format", "status"]);
  });

  it("fits inside the 2000-char budget for monster warnings", () => {
    const huge = Array.from({ length: 20 }, () => "w".repeat(500));
    const summary = buildExportSummary({
      exportId: "exp-0000000000000000000000000000000000000000",
      format: "pcraft",
      status: "succeeded",
      url: `https://objects.example.com/${"a".repeat(400)}`,
      warnings: huge,
    });
    expect(summary.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(summary) as { warnings?: string[] };
    expect(parsed.warnings === undefined || parsed.warnings.length < 20).toBe(true);
  });

  it("isTerminalExportStatus only accepts succeeded/failed", () => {
    expect(isTerminalExportStatus("succeeded")).toBe(true);
    expect(isTerminalExportStatus("failed")).toBe(true);
    for (const status of ["queued", "active", "delayed", "", "unknown"]) {
      expect(isTerminalExportStatus(status)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry pinning (the §6 surface owns the name; W5-R wires the map)
// ---------------------------------------------------------------------------

describe("export_document — registry pinning", () => {
  it("is pinned to the §6 surface and registerable", () => {
    expect(TOOLS.export_document).toBe("export_document");
    expect(exportDocumentTool.name).toBe("export_document");
    const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
    expect(registry.register(exportDocumentTool).ok).toBe(true);
    const lookup = registry.get("export_document");
    expect(lookup.ok).toBe(true);
  });

  it("carries a planner-safe description and a parseable schema", () => {
    expect(exportDocumentTool.description.length).toBeGreaterThanOrEqual(10);
    expect(exportDocumentTool.description.length).toBeLessThanOrEqual(500);
    expect(exportDocumentTool.args.safeParse({}).success).toBe(true);
    expect(exportDocumentTool.args.safeParse({ format: "psd" }).success).toBe(false);
  });
});
