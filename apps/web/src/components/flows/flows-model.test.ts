// apps/web/src/components/flows/flows-model.test.ts (W8-P)
//
// Pure-logic unit tests for the flows model — deterministic, no network, < 5 s
// (docs/AGENTS.md test rules). Table-driven wherever the logic is a map.

import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  DEFAULT_EXPORT_FORMAT,
  EXPORT_FORMAT_OPTIONS,
  EXPORT_PHASE_BADGE_VARIANT,
  EXPORT_PHASE_LABEL,
  MAX_EXPORT_SIDE_PX,
  PSD_EXPERIMENTAL_WARNING,
  REDO_NOTICE_TEXT,
  UNDO_NOTICE_TEXT,
  buildExportRequest,
  exportFileName,
  exportItemSchema,
  exportListSchema,
  exportPhase,
  exportQueuedSchema,
  flowErrorText,
  formatRevisionNotice,
  isTerminalExportPhase,
  nextExportPollAction,
  toExportJobView,
  undoRedoReplySchema,
  upsertExportJob,
  type ExportCreateRequestBody,
  type ExportFormat,
  type ExportJobView,
  type ExportListItem,
  type ExportPollDecision,
  type ExportRequestDraft,
} from "./flows-model";

// ---------------------------------------------------------------------------
// Status machine (§13.1 wire statuses → queued/processing/ready/failed)
// ---------------------------------------------------------------------------

describe("exportPhase", () => {
  it.each([
    ["queued", "queued"],
    ["running", "processing"],
    ["succeeded", "ready"],
    ["failed", "failed"],
  ] as const)("maps %s → %s", (status, phase) => {
    expect(exportPhase(status)).toBe(phase);
  });

  it.each([
    ["queued", false],
    ["processing", false],
    ["ready", true],
    ["failed", true],
  ] as const)("terminal(%s) === %s", (phase, terminal) => {
    expect(isTerminalExportPhase(phase)).toBe(terminal);
  });

  it("labels + badge variants exist for every phase", () => {
    const phases = ["queued", "processing", "ready", "failed"] as const;
    for (const phase of phases) {
      expect(EXPORT_PHASE_LABEL[phase]).toBeTruthy();
      expect(EXPORT_PHASE_BADGE_VARIANT[phase]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Format picker metadata (§10.3 — pcraft primary; psd experimental)
// ---------------------------------------------------------------------------

describe("format picker metadata", () => {
  it(".pcraft is the default + the recommended option (§10.3 primary)", () => {
    expect(DEFAULT_EXPORT_FORMAT).toBe("pcraft");
    const pcraft = EXPORT_FORMAT_OPTIONS.find((option) => option.format === "pcraft");
    expect(pcraft?.recommended).toBe(true);
  });

  it("psd carries the experimental marker; every §10.3 format is listed once", () => {
    const formats = EXPORT_FORMAT_OPTIONS.map((option) => option.format);
    expect(formats).toEqual(["pcraft", "png", "jpg", "psd"]);
    expect(EXPORT_FORMAT_OPTIONS.at(-1)?.experimental).toBe(true);
  });

  it("the §2.3 warning never promises round-trip-perfect PSD", () => {
    expect(PSD_EXPERIMENTAL_WARNING).toContain("experimental");
    expect(PSD_EXPERIMENTAL_WARNING).not.toContain("round-trip-perfect PSD");
  });
});

// ---------------------------------------------------------------------------
// Request building (§13.1 POST body)
// ---------------------------------------------------------------------------

describe("buildExportRequest", () => {
  const successes: ReadonlyArray<readonly [string, ExportRequestDraft, ExportCreateRequestBody]> = [
    [
      "pcraft with empty sizes sends the bare format",
      { format: "pcraft", width: "", height: "", quality: 90, psdEnabled: false },
      { format: "pcraft" },
    ],
    [
      "png sends sizes but never quality (lossless, §10.3)",
      { format: "png", width: "1080", height: "1350", quality: 90, psdEnabled: false },
      { format: "png", width: 1080, height: 1350 },
    ],
    [
      "jpg sends quality from the slider",
      { format: "jpg", width: "", height: "", quality: 75, psdEnabled: false },
      { format: "jpg", quality: 75 },
    ],
    [
      "psd is allowed only when the flag is on",
      { format: "psd", width: "", height: "", quality: 90, psdEnabled: true },
      { format: "psd" },
    ],
  ];

  it.each(successes)("buildExportRequest: %s", (_name, draft, expected) => {
    const result = buildExportRequest(draft);
    expect(result).toEqual({ ok: true, body: expected });
  });

  it("trims whitespace around sizes", () => {
    const result = buildExportRequest({
      format: "png",
      width: " 1080 ",
      height: "1350",
      quality: 90,
      psdEnabled: false,
    });
    expect(result).toEqual({ ok: true, body: { format: "png", width: 1080, height: 1350 } });
  });

  type DraftOverrides = Readonly<
    { readonly format: ExportFormat } & Partial<ExportRequestDraft>
  >;
  const failures: ReadonlyArray<readonly [string, DraftOverrides, string]> = [
    ["psd behind the flag", { format: "psd", psdEnabled: false }, "psd_disabled"],
    ["zero width", { format: "png", width: "0" }, "invalid_width"],
    ["non-numeric width", { format: "png", width: "wide" }, "invalid_width"],
    ["decimal width", { format: "png", width: "12.5" }, "invalid_width"],
    ["oversized width", { format: "png", width: String(MAX_EXPORT_SIDE_PX + 1) }, "invalid_width"],
    ["oversized height", { format: "png", height: "99999" }, "invalid_height"],
    ["jpg quality below 1", { format: "jpg", quality: 0 }, "invalid_quality"],
    ["jpg quality above 100", { format: "jpg", quality: 101 }, "invalid_quality"],
  ];

  it.each(failures)("%s → %s", (_name, overrides, code) => {
    const draft: ExportRequestDraft = {
      format: overrides.format,
      width: overrides.width ?? "",
      height: overrides.height ?? "",
      quality: overrides.quality ?? 90,
      psdEnabled: overrides.psdEnabled ?? false,
    };
    const result = buildExportRequest(draft);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.hint.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Poll loop decision (bounded 2 s loop — the task's contract)
// ---------------------------------------------------------------------------

const queuedItem: ExportListItem = exportItemSchema.parse({
  export_id: "exp_1",
  format: "png",
  status: "queued",
  revision: 3,
  width: 1080,
  height: 1350,
  quality: null,
  created_at: "2026-10-01T00:00:00.000Z",
  finished_at: null,
  url: null,
  expires_at: null,
});

describe("nextExportPollAction", () => {
  const decisions: ReadonlyArray<
    readonly [
      string,
      { readonly item: ExportListItem | null; readonly error: unknown },
      ExportPollDecision,
    ]
  > = [
    [
      "succeeded row stops ready",
      { item: { ...queuedItem, status: "succeeded" }, error: null },
      "stop-ready",
    ],
    ["failed row stops failed", { item: { ...queuedItem, status: "failed" }, error: null }, "stop-failed"],
    ["queued row keeps polling within budget", { item: queuedItem, error: null }, "continue"],
    [
      "4xx (not 429) stops with the hard error",
      { item: null, error: new ApiError({ code: "forbidden", message: "no", status: 403 }) },
      "stop-hard-error",
    ],
    [
      "429 is transient — keep polling",
      { item: null, error: new ApiError({ code: "rate_limited", message: "slow", status: 429 }) },
      "continue",
    ],
    [
      "5xx is transient — keep polling",
      { item: null, error: new ApiError({ code: "engine_unavailable", message: "down", status: 503 }) },
      "continue",
    ],
    ["exhausted budget stops with stop-budget", { item: null, error: null }, "stop-budget"],
  ];

  it.each(decisions)("nextExportPollAction: %s", (_name, state, expected) => {
    const polls = expected === "stop-budget" ? 150 : 10;
    expect(nextExportPollAction({ polls, maxPolls: 150, ...state })).toBe(expected);
  });

  it("a terminal row wins over a concurrent list-call error", () => {
    expect(
      nextExportPollAction({
        polls: 149,
        maxPolls: 150,
        item: { ...queuedItem, status: "succeeded" },
        error: new ApiError({ code: "forbidden", message: "no", status: 403 }),
      }),
    ).toBe("stop-ready");
  });
});

// ---------------------------------------------------------------------------
// Job views (mini-history + live polls)
// ---------------------------------------------------------------------------

const succeededItem: ExportListItem = exportItemSchema.parse({
  export_id: "exp_1",
  format: "png",
  status: "succeeded",
  revision: 3,
  width: 1080,
  height: 1350,
  quality: null,
  created_at: "2026-10-01T00:00:00.000Z",
  finished_at: "2026-10-01T00:00:05.000Z",
  url: "https://cdn.example.com/signed?token=abc",
  expires_at: "2026-10-01T00:15:00.000Z",
});

const baseJob: ExportJobView = {
  exportId: "exp_0",
  format: "pcraft",
  revision: 2,
  phase: "queued",
  width: null,
  height: null,
  quality: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  url: null,
  expiresAt: null,
  error: null,
  pollBudgetExhausted: false,
  warnings: [],
};

describe("job views", () => {
  it("toExportJobView maps wire fields and defaults the loop-local flags", () => {
    expect(toExportJobView(succeededItem)).toEqual({
      exportId: "exp_1",
      format: "png",
      revision: 3,
      phase: "ready",
      width: 1080,
      height: 1350,
      quality: null,
      createdAt: succeededItem.created_at,
      url: "https://cdn.example.com/signed?token=abc",
      expiresAt: "2026-10-01T00:15:00.000Z",
      error: null,
      pollBudgetExhausted: false,
      warnings: [],
    });
  });

  it("toExportJobView preserves a failed row's error and budget flag across polls", () => {
    const previous: ExportJobView = {
      ...toExportJobView(queuedItem),
      error: "boom",
      pollBudgetExhausted: true,
      warnings: [PSD_EXPERIMENTAL_WARNING],
    };
    const next = toExportJobView(succeededItem, previous);
    expect(next.error).toBe("boom");
    expect(next.pollBudgetExhausted).toBe(true);
    expect(next.warnings).toEqual([PSD_EXPERIMENTAL_WARNING]);
  });

  it("upsertExportJob replaces in place and sorts newest first", () => {
    const older = baseJob;
    const newer: ExportJobView = { ...baseJob, exportId: "exp_9", createdAt: "2026-10-02T00:00:00.000Z" };
    const updated: ExportJobView = { ...baseJob, phase: "ready", url: "u" };
    expect(upsertExportJob([], newer)).toEqual([newer]);
    expect(upsertExportJob([older], newer)).toEqual([newer, older]);
    expect(upsertExportJob([older, newer], updated).map((job) => job.exportId)).toEqual([
      "exp_9",
      "exp_0",
    ]);
  });

  it("exportFileName uses the revision + §10.3 suffix", () => {
    expect(exportFileName({ format: "png", revision: 4 })).toBe("export-r4.png");
    expect(exportFileName({ format: "pcraft", revision: 12 })).toBe("export-r12.pcraft");
  });
});

// ---------------------------------------------------------------------------
// Wire schemas (gateway W4-K/W4-L shapes — drift throws)
// ---------------------------------------------------------------------------

describe("wire schemas", () => {
  it("undoRedoReplySchema accepts the gateway command reply (toCommandReply)", () => {
    const reply = undoRedoReplySchema.parse({
      ok: true,
      command: "edit.undo",
      seq: 42,
      summary: "Undid the last transaction",
      warnings: [],
      document_revision: 6,
      revision_before: 7,
      revision_after: 6,
      replayed: true,
    });
    expect(reply.revision_after).toBe(6);
  });

  it("undoRedoReplySchema rejects a reply without revision_after (contract drift)", () => {
    expect(() => undoRedoReplySchema.parse({ ok: true, command: "edit.undo" })).toThrow();
  });

  it("exportQueuedSchema parses the 202 reply", () => {
    expect(
      exportQueuedSchema.parse({
        export_id: "exp_1",
        status: "queued",
        revision: 3,
        warnings: [PSD_EXPERIMENTAL_WARNING],
      }),
    ).toEqual({
      export_id: "exp_1",
      status: "queued",
      revision: 3,
      warnings: [PSD_EXPERIMENTAL_WARNING],
    });
  });

  it("exportListSchema parses the ExportApiView list (url/expires_at may be absent)", () => {
    const parsed = exportListSchema.parse({
      exports: [
        {
          export_id: "exp_2",
          format: "psd",
          status: "failed",
          revision: 5,
          width: null,
          height: null,
          quality: null,
          created_at: "2026-10-01T00:00:00.000Z",
          finished_at: "2026-10-01T00:00:02.000Z",
          url: null,
          expires_at: null,
        },
        {
          export_id: "exp_3",
          format: "jpg",
          status: "succeeded",
          revision: 5,
          width: 1000,
          height: 1000,
          quality: 80,
          created_at: "2026-10-01T00:00:00.000Z",
          finished_at: "2026-10-01T00:00:01.000Z",
        },
      ],
    });
    expect(parsed.exports).toHaveLength(2);
    expect(parsed.exports[1]?.url ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Notices + envelope text (§13.3 — never leak codes/paths/stack)
// ---------------------------------------------------------------------------

describe("notice + error text", () => {
  it("undo/redo toast texts are the task-mandated one-liners", () => {
    expect(UNDO_NOTICE_TEXT).toBe("Run undone — one step");
    expect(REDO_NOTICE_TEXT).toBe("Run restored — one step");
  });

  it("formatRevisionNotice appends the revision as a detail", () => {
    expect(formatRevisionNotice(UNDO_NOTICE_TEXT, 6)).toBe("Run undone — one step · revision 6");
    expect(formatRevisionNotice(REDO_NOTICE_TEXT, null)).toBe(REDO_NOTICE_TEXT);
  });

  it("flowErrorText unfolds the envelope message + hint", () => {
    expect(
      flowErrorText(
        new ApiError({
          code: "plan_limit",
          message: "HD export requires Pro",
          status: 402,
          hint: "Upgrade the workspace plan (§14.1).",
        }),
        "fallback",
      ),
    ).toBe("HD export requires Pro — Upgrade the workspace plan (§14.1).");
    expect(
      flowErrorText(new ApiError({ code: "x", message: "plain", status: 500 }), "fallback"),
    ).toBe("plain");
    expect(flowErrorText(new Error("boom"), "fallback")).toBe("fallback");
    expect(flowErrorText("boom", "fallback")).toBe("fallback");
  });
});
