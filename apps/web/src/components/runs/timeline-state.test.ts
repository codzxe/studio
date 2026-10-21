// apps/web — timeline-state unit tests (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Pure, deterministic, <5 s, no network (docs/AGENTS.md "Definition of a good
// test"): the §13.2 payload parsers, the seq-dedupe store, the detail+events
// derivation (all 13 event types), the elapsed/duration helpers and the §24.4
// retry-brief storage seam.

import { describe, expect, it } from "vitest";
import {
  createRunResponseSchema,
  cancelRunResponseSchema,
  deriveTimeline,
  formatDuration,
  isTerminalRunStatus,
  mergeRunEvent,
  orderedRunEvents,
  parsePlanView,
  parseRunEvent,
  readRetryBrief,
  runDetailSchema,
  runElapsedMs,
  statusLabel,
  stepElapsedMs,
  tierLabel,
  writeRetryBrief,
  type BriefStorage,
  type ParsedRunEvent,
  type RunDetailView,
  type WireEventInput,
} from "./timeline-state";

const AT = "2026-07-04T12:00:05.000Z";

/** §5.5 worked example — the spec's own planner output. */
const planFixture: Record<string, unknown> = {
  intent: "create_post",
  template: "instagram-post@3",
  assets: [{ ref: "asset_123", slot: "photo", fit: "cover" }],
  slots: { headline: "Fresh roasted, every morning", subhead: "Open 7–5 · Main St" },
  palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  typography: { headline: { font: "display", weight: "bold" }, body: { font: "sans" } },
  steps: [{ tool: "template.apply", args: {} }, { tool: "template.fill", args: {} }],
  checks: ["in_bounds", "contrast>=4.5", "headline_largest", "safe_area"],
  model_tier: "standard",
  notes_for_user: "Reused the brand palette; headline shortened to fit two lines.",
};

/** GET /v1/runs/:id body — the W4-G RunDetailApiView shape (§13.1). */
const detailFixture: Record<string, unknown> = {
  run_id: "run_018f",
  document_id: "doc_018e",
  status: "failed",
  tier: "standard",
  revision_before: 12,
  revision_after: null,
  created_at: "2026-07-04T12:00:00.000Z",
  started_at: "2026-07-04T12:00:02.000Z",
  finished_at: "2026-07-04T12:01:00.000Z",
  error: {
    code: "image_provider_error",
    message: "The image provider failed on all retries.",
    hint: "Retry the run — the first retry is free.",
    retryable: true,
  },
  plan: planFixture,
  cost: {
    credits_reserved: 2,
    credits_charged: 1,
    tokens_in: 1024,
    tokens_out: 256,
    cache_hits: 64,
    cost_micro_usd: 56_000,
  },
  steps: [
    {
      seq: 1,
      phase: "planning",
      tool: null,
      duration_ms: 900,
      ok: true,
      error_code: null,
      deviation_from_plan: false,
    },
    {
      seq: 2,
      phase: "executing",
      tool: "template.apply",
      duration_ms: 1500,
      ok: false,
      error_code: "image_upscale_limit",
      deviation_from_plan: true,
    },
  ],
};

function wire(seq: number, type: string, payload: unknown): WireEventInput {
  return { seq, type, payload, at: AT };
}

/** parseRunEvent, but fixtures must parse — a null here is a test bug. */
function parseOk(input: WireEventInput): ParsedRunEvent {
  const parsed = parseRunEvent(input);
  if (parsed === null) {
    throw new Error(`fixture failed to parse: ${input.type}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// §13.2 payload parsing
// ---------------------------------------------------------------------------

describe("parseRunEvent", () => {
  const canonical: readonly WireEventInput[] = [
    wire(1, "run.queued", { tier: "standard" }),
    wire(2, "run.started", { revisionBefore: 12 }),
    wire(3, "run.plan", { plan: planFixture }),
    wire(4, "step.started", { stepSeq: 0, phase: "executing", tool: "template.apply" }),
    wire(5, "step.finished", {
      stepSeq: 0,
      phase: "executing",
      tool: "template.apply",
      ok: true,
      durationMs: 1200,
      deviationFromPlan: false,
    }),
    wire(6, "preview.updated", { url: "https://cdn.example/p.png", revision: 13 }),
    wire(7, "validate.report", {
      ok: true,
      blockers: [],
      majors: ["contrast_low"],
      minors: ["text_trimmed"],
    }),
    wire(8, "critique.report", {
      verdict: "accept",
      scores: {
        hierarchy: 5,
        balance: 4,
        contrast: 4.5,
        brief_adherence: 4,
        brand_fit: 5,
        editability: 5,
      },
      issues: [],
    }),
    wire(9, "credits.reserved", { reserved: 2 }),
    wire(10, "credits.charged", { charged: 1, partial: true }),
    wire(11, "run.succeeded", { revisionAfter: 14, warnings: ["text_trimmed"] }),
    wire(12, "run.failed", {
      error: { code: "image_provider_error", message: "The image provider failed.", retryable: true },
    }),
    wire(13, "run.cancelled", { reason: "user_cancel" }),
  ];

  it("parses all 13 §13.2 event types", () => {
    expect(canonical).toHaveLength(13);
    for (const input of canonical) {
      const parsed = parseRunEvent(input);
      expect(parsed, `type ${input.type} should parse`).not.toBeNull();
      if (parsed !== null) {
        expect(parsed.seq).toBe(input.seq);
        expect(parsed.type).toBe(input.type);
      }
    }
  });

  it("narrow the payload by type (critique scores + step phase enums)", () => {
    const critique = parseRunEvent(canonical[7]);
    if (critique !== null && critique.type === "critique.report") {
      expect(critique.payload.verdict).toBe("accept");
      expect(critique.payload.scores.brief_adherence).toBe(4);
    } else {
      throw new Error("critique fixture should narrow");
    }
    const started = parseRunEvent(canonical[3]);
    if (started !== null && started.type === "step.started") {
      expect(started.payload.phase).toBe("executing");
    }
  });

  it("skips unknown types — the §13.2 resync sentinel is transport, not an event", () => {
    expect(parseRunEvent(wire(4, "run.resync", { run_id: "run_018f", last_seq: 3 }))).toBeNull();
    expect(parseRunEvent(wire(4, "heartbeat", {}))).toBeNull();
  });

  it("skips malformed payloads instead of throwing (never wedge the timeline)", () => {
    expect(parseRunEvent(wire(4, "step.started", { phase: "executing" }))).toBeNull(); // no stepSeq
    expect(parseRunEvent(wire(5, "step.finished", { stepSeq: 0, phase: "executing" }))).toBeNull();
    expect(parseRunEvent(wire(8, "critique.report", { verdict: "maybe" }))).toBeNull();
    expect(parseRunEvent(wire(12, "run.failed", { error: { code: 500 } }))).toBeNull();
  });

  it("tolerates additive server fields", () => {
    const parsed = parseRunEvent(
      wire(9, "credits.reserved", { reserved: 2, future_field: "x" }),
    );
    expect(parsed).not.toBeNull();
  });

  it("accepts Date/string/number `at` values", () => {
    const asDate = parseRunEvent({ seq: 1, type: "run.queued", payload: { tier: "quick" }, at: new Date(0) });
    const asNumber = parseRunEvent({ seq: 1, type: "run.queued", payload: { tier: "quick" }, at: 0 });
    const asString = parseRunEvent({
      seq: 1,
      type: "run.queued",
      payload: { tier: "quick" },
      at: "1970-01-01T00:00:00.000Z",
    });
    expect(asDate?.atMs).toBe(0);
    expect(asNumber?.atMs).toBe(0);
    expect(asString?.atMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §5.5 plan view
// ---------------------------------------------------------------------------

describe("parsePlanView", () => {
  it("maps the §5.5 wire keys to the view shape", () => {
    const plan = parsePlanView(planFixture);
    if (plan === null) {
      throw new Error("§5.5 fixture should parse");
    }
    expect(plan.intent).toBe("create_post");
    expect(plan.template).toBe("instagram-post@3");
    expect(plan.checks).toContain("contrast>=4.5");
    expect(plan.modelTier).toBe("standard");
    expect(plan.notesForUser).toContain("brand palette");
    expect(plan.slots["headline"]).toBe("Fresh roasted, every morning");
    expect(plan.steps).toHaveLength(2);
  });

  it("fills defaults for optional §5.5 sections", () => {
    const plan = parsePlanView({
      intent: "resize",
      template: null,
      steps: [{ tool: "canvas.resize" }],
      model_tier: "quick",
      notes_for_user: "",
    });
    expect(plan?.checks).toEqual([]);
    expect(plan?.palette).toEqual([]);
  });

  it("rejects drifted plans", () => {
    expect(parsePlanView({ intent: "vibe_magic" })).toBeNull();
    expect(parsePlanView(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §13.1 detail schema
// ---------------------------------------------------------------------------

describe("runDetailSchema", () => {
  it("parses the RunDetailApiView shape (§13.1)", () => {
    const detail: RunDetailView = runDetailSchema.parse(detailFixture);
    expect(detail.run_id).toBe("run_018f");
    expect(detail.status).toBe("failed");
    expect(detail.cost.credits_reserved).toBe(2);
    expect(detail.steps).toHaveLength(2);
  });

  it("rejects drifted details at the boundary (Zod at every boundary)", () => {
    expect(() => runDetailSchema.parse({ run_id: "x" })).toThrow();
  });

  it("create/cancel response schemas accept their §13.1 shapes", () => {
    expect(
      createRunResponseSchema.parse({ run_id: "r2", status: "queued", credits_reserved: 2 }),
    ).toBeTruthy();
    expect(
      cancelRunResponseSchema.parse({ run_id: "r1", status: "cancelled", credits_refunded: 2 }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §13.2 seq dedupe store
// ---------------------------------------------------------------------------

describe("mergeRunEvent", () => {
  it("appends monotonically and drops replays (StrictMode + resync backfill)", () => {
    const a = parseOk(wire(1, "run.queued", { tier: "standard" }));
    const b = parseOk(wire(2, "run.started", { revisionBefore: 12 }));
    const gap = parseOk(wire(5, "preview.updated", { url: "https://cdn.example/p.png", revision: 13 }));

    let store = mergeRunEvent(new Map(), a);
    store = mergeRunEvent(store, b);
    expect(store.size).toBe(2);

    // Replay of an old backfill event — dropped.
    expect(mergeRunEvent(store, a).size).toBe(2);
    // A late event below the high-water mark — dropped (never mis-sequences).
    const late = parseOk(wire(3, "validate.report", { ok: true, blockers: [], majors: [], minors: [] }));
    expect(mergeRunEvent(store, late).size).toBe(2);
    // The gap event (after a resync reconnect) — appended.
    store = mergeRunEvent(store, gap);
    expect(store.size).toBe(3);
    expect(orderedRunEvents(store).map((event) => event.seq)).toEqual([1, 2, 5]);
  });
});

// ---------------------------------------------------------------------------
// deriveTimeline — detail seed + the 13-event fold
// ---------------------------------------------------------------------------

describe("deriveTimeline", () => {
  it("starts as an empty queued view before any data", () => {
    const timeline = deriveTimeline(null, []);
    expect(timeline.status).toBe("queued");
    expect(timeline.terminal).toBe(false);
    expect(timeline.plan).toBeNull();
    expect(timeline.steps).toEqual([]);
  });

  it("seeds from the §13.1 detail (plan, cost, failure, steps)", () => {
    const detail: RunDetailView = runDetailSchema.parse(detailFixture);
    const timeline = deriveTimeline(detail, []);
    expect(timeline.status).toBe("failed");
    expect(timeline.terminal).toBe(true);
    expect(timeline.plan?.template).toBe("instagram-post@3");
    expect(timeline.creditsReserved).toBe(2);
    expect(timeline.creditsCharged).toEqual({ charged: 1, partial: true });
    expect(timeline.failure?.code).toBe("image_provider_error");
    expect(timeline.deviated).toBe(true); // the seeded executing step deviated
    expect(timeline.steps).toHaveLength(2);
    expect(timeline.steps[1]?.errorCode).toBe("image_upscale_limit");
    expect(timeline.revisionAfter).toBeNull();
  });

  it("streams the full §20 #5 flow — plan → steps → preview → verdicts → charge", () => {
    const events: readonly ParsedRunEvent[] = [
      parseOk(wire(1, "run.queued", { tier: "standard" })),
      parseOk(wire(2, "run.started", { revisionBefore: 12 })),
      parseOk(wire(3, "run.plan", { plan: planFixture })),
      parseOk(wire(4, "step.started", { stepSeq: 0, phase: "executing", tool: "template.apply" })),
      parseOk(
        wire(5, "step.finished", {
          stepSeq: 0,
          phase: "executing",
          tool: "template.apply",
          ok: true,
          durationMs: 1200,
          deviationFromPlan: false,
        }),
      ),
      parseOk(
        wire(6, "step.started", { stepSeq: 1, phase: "rendering", tool: "document.render" }),
      ),
      parseOk(wire(7, "preview.updated", { url: "https://cdn.example/p1.png", revision: 13 })),
      parseOk(
        wire(8, "preview.updated", { url: "https://cdn.example/p2.png", revision: 14 }),
      ),
      parseOk(
        wire(9, "validate.report", { ok: true, blockers: [], majors: [], minors: ["text_trimmed"] }),
      ),
      parseOk(
        wire(10, "critique.report", {
          verdict: "accept",
          scores: { hierarchy: 5, balance: 4, contrast: 4.5, brief_adherence: 4, brand_fit: 5, editability: 5 },
          issues: [],
        }),
      ),
      parseOk(wire(11, "credits.reserved", { reserved: 2 })),
      parseOk(wire(12, "credits.charged", { charged: 2, partial: false })),
    ].map((event, index) => ({ ...event, atMs: 1_000_000 + index * 1_000 }));

    let timeline = deriveTimeline(null, events);
    // Mid-flight (before run.succeeded): active, in the rendering phase.
    expect(timeline.terminal).toBe(false);
    expect(timeline.status).toBe("rendering");
    expect(timeline.tier).toBe("standard");
    expect(timeline.plan?.intent).toBe("create_post");
    expect(timeline.activeStepSeq).toBe(1); // step 1 started, not finished
    expect(timeline.steps).toHaveLength(2);
    expect(timeline.preview?.revision).toBe(14); // last preview wins
    expect(timeline.validation?.minors).toContain("text_trimmed");
    expect(timeline.critique?.scores.brief_adherence).toBe(4);
    expect(timeline.creditsCharged).toEqual({ charged: 2, partial: false });

    // Terminal with warnings → succeeded_with_warnings (§5.1).
    timeline = deriveTimeline(null, [
      ...events,
      parseOk(wire(13, "run.succeeded", { revisionAfter: 14, warnings: ["text_trimmed"] })),
    ]);
    expect(timeline.terminal).toBe(true);
    expect(timeline.status).toBe("succeeded_with_warnings");
    expect(timeline.succeeded?.revisionAfter).toBe(14);
    expect(timeline.activeStepSeq).toBeNull();
  });

  it("drops seeded (detail) steps once live step events exist (numbering bases differ)", () => {
    const detail: RunDetailView = runDetailSchema.parse(detailFixture);
    const timeline = deriveTimeline(detail, [
      parseOk(wire(1, "run.queued", { tier: "standard" })),
      parseOk(wire(2, "step.started", { stepSeq: 0, phase: "planning", tool: null })),
    ]);
    expect(timeline.liveSteps).toBe(true);
    expect(timeline.steps).toHaveLength(1); // the SSE step only
    expect(timeline.steps[0]?.stepSeq).toBe(0);
  });

  it("events supersede a stale detail — a replayed history beats an old GET", () => {
    const detail: RunDetailView = runDetailSchema.parse(detailFixture); // says failed
    const timeline = deriveTimeline(detail, [
      parseOk(wire(1, "run.cancelled", { reason: "user_cancel" })),
    ]);
    expect(timeline.status).toBe("cancelled");
    expect(timeline.failure).toBeNull(); // detail.error cleared by the event
    expect(timeline.cancelledReason).toBe("user_cancel");
  });

  it("run.failed carries the §13.3 envelope into the failure card state", () => {
    const timeline = deriveTimeline(null, [
      parseOk(
        wire(1, "run.failed", {
          error: {
            code: "image_provider_error",
            message: "The image provider failed on all retries.",
            hint: "Retry the run — the first retry is free.",
            retryable: true,
          },
        }),
      ),
    ]);
    expect(timeline.status).toBe("failed");
    expect(timeline.failure?.retryable).toBe(true);
    expect(timeline.failure?.hint).toContain("free");
    expect(timeline.terminal).toBe(true);
  });

  it("charges stay unseeded until a detail or a credits event arrives", () => {
    const events = [parseOk(wire(1, "run.queued", { tier: "quick" }))];
    const timeline = deriveTimeline(null, events);
    expect(timeline.creditsReserved).toBeNull();
  });

  it("run.started moves queued → planning and stamps startedAt (§5.1)", () => {
    const timeline = deriveTimeline(null, [
      parseOk(wire(1, "run.queued", { tier: "standard" })),
      parseOk(wire(2, "run.started", { revisionBefore: 3 })),
    ]);
    expect(timeline.status).toBe("planning");
    expect(timeline.startedAtMs).toBe(parseOk(wire(2, "run.started", { revisionBefore: 3 })).atMs);
  });
});

// ---------------------------------------------------------------------------
// elapsed + labels
// ---------------------------------------------------------------------------

describe("elapsed helpers", () => {
  const baseDetail: RunDetailView = runDetailSchema.parse(detailFixture);
  const timeline = deriveTimeline(baseDetail, []);

  it("freezes elapsed at finishedAt for terminal runs", () => {
    const ms = runElapsedMs(timeline, Date.now() + 60_000);
    expect(ms).toBe(58_000); // 12:00:02 → 12:01:00
  });

  it("ticks elapsed for active runs and falls back to createdAt", () => {
    const active = deriveTimeline(null, [parseOk(wire(1, "run.queued", { tier: "quick" }))]);
    expect(runElapsedMs(active, 5_000)).toBeNull(); // no createdAt without a detail
    const seededActive = deriveTimeline(
      { ...baseDetail, status: "executing", finished_at: null },
      [],
    );
    expect(runElapsedMs(seededActive, new Date("2026-07-04T12:00:42.000Z").getTime())).toBe(40_000);
  });

  it("stepElapsedMs ticks only for in-flight steps", () => {
    const events = [
      parseOk(wire(1, "step.started", { stepSeq: 0, phase: "executing", tool: "template.apply" })),
      parseOk(
        wire(2, "step.finished", {
          stepSeq: 0,
          phase: "executing",
          tool: "template.apply",
          ok: true,
          durationMs: 900,
          deviationFromPlan: false,
        }),
      ),
    ];
    const timeline = deriveTimeline(null, events);
    const finished = timeline.steps[0];
    if (finished === undefined) {
      throw new Error("fixture should have one step");
    }
    expect(stepElapsedMs(finished, 10_000_000)).toBeNull();
    expect(stepElapsedMs({ ...finished, finished: false, atMs: 999_000 }, 1_000_000)).toBe(1_000);
  });

  it("formatDuration renders compact human durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_500)).toBe("42s");
    expect(formatDuration(72_500)).toBe("1m 12s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
  });

  it("labels statuses, tiers and terminality (user-facing words only)", () => {
    expect(statusLabel("succeeded_with_warnings")).toBe("Succeeded with warnings");
    expect(statusLabel("critiquing")).toBe("Critiquing");
    expect(tierLabel("quick")).toBe("Quick edit");
    expect(tierLabel("image_gen_hd")).toBe("Image generation (HD)");
    expect(tierLabel(null)).toBe("Unknown tier");
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("repairing")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §24.4 retry-brief seam
// ---------------------------------------------------------------------------

describe("retry brief storage", () => {
  class MemoryStorage implements BriefStorage {
    readonly map = new Map<string, string>();
    getItem(key: string): string | null {
      return this.map.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.map.set(key, value);
    }
  }

  it("round-trips the brief that created the run", () => {
    const storage = new MemoryStorage();
    writeRetryBrief("run_1", { prompt: "Coffee shop promo post, warm and cozy" }, storage);
    expect(readRetryBrief("run_1", storage)?.prompt).toBe("Coffee shop promo post, warm and cozy");
    expect(readRetryBrief("run_2", storage)).toBeNull();
  });

  it("rejects corrupted or blank entries", () => {
    const storage = new MemoryStorage();
    storage.setItem("app:runs:brief:run_x", "{not json");
    expect(readRetryBrief("run_x", storage)).toBeNull();
    storage.setItem("app:runs:brief:run_y", JSON.stringify({ prompt: "" }));
    expect(readRetryBrief("run_y", storage)).toBeNull();
  });
});
