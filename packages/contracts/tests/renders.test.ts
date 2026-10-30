// @studio/contracts tests — render wire v2 (M8-C; DECISIONS D-2/D-11/D-12).
//
// Accept/reject matrix for every render request schema plus compile pins for
// the response interfaces. The D-11 pin is load-bearing: "succeeded" must
// stay OUT of the render vocabulary (DB wins — completed, not succeeded).

import { describe, expect, it } from "vitest";

import {
  CANCEL_RENDER_SCHEMA,
  IDEMPOTENCY_KEY_SCHEMA,
  QUEUE_RENDER_SCHEMA,
  RENDERS_QUERY_SCHEMA,
  RENDER_ESTIMATE_REQUEST_SCHEMA,
  RENDER_FORMATS,
  RENDER_FORMAT_SCHEMA,
  RENDER_QUALITY_SCHEMA,
  RENDER_SETTINGS_SCHEMA,
  RENDER_STATUSES,
  RENDER_STATUS_SCHEMA,
} from "../src/routes/index.js";
import type { EstimateResult, Page, RenderJob, RenderStatus } from "../src/routes/index.js";

const QUEUE_BODY = {
  projectId: "p1",
  compId: "comp1",
  format: "mp4",
  settings: { timeFrom: 0, timeTo: 5, quality: "good" },
  idempotencyKey: "render-1234",
} as const;

const ESTIMATE_BODY = {
  projectId: "p1",
  compId: "comp1",
  format: "prores",
  settings: {},
} as const;

describe("renders: D-11 status vocabulary (wire v2)", () => {
  it("the five DB statuses; `completed` replaces the retired `succeeded`", () => {
    expect(RENDER_STATUSES).toEqual(["queued", "running", "completed", "failed", "cancelled"]);
    expect(RENDER_STATUS_SCHEMA.options).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]);
    // Compile-time pin: RenderStatus must be exactly the five keys above —
    // re-adding "succeeded" fails typecheck on the missing Record key.
    const pin: Record<RenderStatus, true> = {
      queued: true,
      running: true,
      completed: true,
      failed: true,
      cancelled: true,
    };
    expect(Object.keys(pin)).toHaveLength(5);
    for (const status of RENDER_STATUSES) {
      expect(RENDER_STATUS_SCHEMA.safeParse(status).success).toBe(true);
    }
  });

  it("rejects the retired `succeeded` and non-render words", () => {
    expect(RENDER_STATUS_SCHEMA.safeParse("succeeded").success).toBe(false); // D-11 pin
    expect(RENDER_STATUS_SCHEMA.safeParse("streaming").success).toBe(false);
    expect(RENDER_STATUS_SCHEMA.safeParse("done").success).toBe(false);
    expect(RENDER_STATUS_SCHEMA.safeParse("").success).toBe(false);
  });
});

describe("renders: D-2 format union (all five declared)", () => {
  it("accepts exactly mp4 | prores | png-seq | gif | wav", () => {
    expect(RENDER_FORMATS).toEqual(["mp4", "prores", "png-seq", "gif", "wav"]);
    for (const format of RENDER_FORMATS) {
      expect(RENDER_FORMAT_SCHEMA.safeParse(format).success).toBe(true);
    }
    expect(RENDER_FORMAT_SCHEMA.safeParse("avi").success).toBe(false);
    expect(RENDER_FORMAT_SCHEMA.safeParse("mov").success).toBe(false);
    expect(RENDER_FORMAT_SCHEMA.safeParse("").success).toBe(false);
  });
});

describe("renders: settings schema (unchanged fields, timeTo refine kept)", () => {
  it("accepts partial settings and a full settings payload", () => {
    expect(RENDER_SETTINGS_SCHEMA.safeParse({}).success).toBe(true);
    expect(
      RENDER_SETTINGS_SCHEMA.safeParse({
        timeFrom: 1,
        timeTo: 4,
        width: 1920,
        height: 1080,
        frameRate: 30,
        quality: "best",
        extra: { preset: "hq" },
      }).success,
    ).toBe(true);
    expect(RENDER_QUALITY_SCHEMA.safeParse("draft").success).toBe(true);
    expect(RENDER_QUALITY_SCHEMA.safeParse("ultra").success).toBe(false);
  });

  it("keeps the timeTo >= timeFrom refine and strictness", () => {
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ timeFrom: 5, timeTo: 0 }).success).toBe(false);
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ timeFrom: 3, timeTo: 3 }).success).toBe(true);
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ unknown: true }).success).toBe(false); // strict
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ width: 1080.5 }).success).toBe(false); // int
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ frameRate: 0 }).success).toBe(false); // positive
  });

  it("BIL-06: frameRate is capped to 1..240 (fractional OK)", () => {
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ frameRate: 240 }).success).toBe(true);
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ frameRate: 29.97 }).success).toBe(true);
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ frameRate: 0.5 }).success).toBe(false);
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ frameRate: 241 }).success).toBe(false);
    expect(RENDER_SETTINGS_SCHEMA.safeParse({ frameRate: 1e6 }).success).toBe(false);
  });
});

describe("renders: queue request (unchanged shape; server pins the version)", () => {
  it("accepts the five-field body; idempotencyKey stays in the body", () => {
    expect(QUEUE_RENDER_SCHEMA.safeParse(QUEUE_BODY).success).toBe(true);
    expect(QUEUE_RENDER_SCHEMA.safeParse({ ...QUEUE_BODY, format: "wav" }).success).toBe(true);
    expect(
      QUEUE_RENDER_SCHEMA.safeParse({ ...QUEUE_BODY, settings: { timeFrom: 5, timeTo: 0 } })
        .success,
    ).toBe(false);
    expect(QUEUE_RENDER_SCHEMA.safeParse({ ...QUEUE_BODY, idempotencyKey: "short" }).success).toBe(
      false,
    );
  });

  it("clients never send versionId — the server pins it at queue time", () => {
    expect(QUEUE_RENDER_SCHEMA.safeParse({ ...QUEUE_BODY, versionId: "v1" }).success).toBe(false);
  });
});

describe("renders: estimate request (pure read — NO idempotencyKey)", () => {
  it("accepts projectId/compId/format/settings", () => {
    expect(RENDER_ESTIMATE_REQUEST_SCHEMA.safeParse(ESTIMATE_BODY).success).toBe(true);
  });

  it("rejects an idempotencyKey, unknown keys and a missing settings block", () => {
    expect(
      RENDER_ESTIMATE_REQUEST_SCHEMA.safeParse({ ...ESTIMATE_BODY, idempotencyKey: "estimate-1" })
        .success,
    ).toBe(false); // pure read — no key anywhere
    expect(RENDER_ESTIMATE_REQUEST_SCHEMA.safeParse({ ...ESTIMATE_BODY, extra: 1 }).success).toBe(
      false,
    ); // strict
    expect(
      RENDER_ESTIMATE_REQUEST_SCHEMA.safeParse({
        projectId: "p1",
        compId: "comp1",
        format: "mp4",
      }).success,
    ).toBe(false); // settings required
  });
});

describe("renders: cancel request (Idempotency-Key rides the HEADER)", () => {
  it("empty body or optional reason; strict about anything else", () => {
    expect(CANCEL_RENDER_SCHEMA.safeParse({}).success).toBe(true);
    expect(CANCEL_RENDER_SCHEMA.safeParse({ reason: "too slow" }).success).toBe(true);
    expect(CANCEL_RENDER_SCHEMA.safeParse({ reason: "x".repeat(281) }).success).toBe(false);
    // The key must ride the Idempotency-Key header, never the body (§7.2).
    expect(CANCEL_RENDER_SCHEMA.safeParse({ idempotencyKey: "cancel-0001" }).success).toBe(false);
  });

  it("the header value is bounded by IDEMPOTENCY_KEY_SCHEMA (8..128)", () => {
    expect(IDEMPOTENCY_KEY_SCHEMA.safeParse("cancel-render-0001").success).toBe(true);
    expect(IDEMPOTENCY_KEY_SCHEMA.safeParse("short").success).toBe(false);
    expect(IDEMPOTENCY_KEY_SCHEMA.safeParse("x".repeat(129)).success).toBe(false);
  });
});

describe("renders: history list query (house pagination + filters)", () => {
  it("paginates exactly like the siblings (limit default 50, coerced, <= 100)", () => {
    expect(RENDERS_QUERY_SCHEMA.safeParse({}).success).toBe(true);
    expect(RENDERS_QUERY_SCHEMA.parse({}).limit).toBe(50);
    expect(RENDERS_QUERY_SCHEMA.parse({ limit: "25" }).limit).toBe(25);
    expect(RENDERS_QUERY_SCHEMA.safeParse({ limit: 101 }).success).toBe(false);
    expect(RENDERS_QUERY_SCHEMA.parse({ cursor: "abc" }).cursor).toBe("abc");
  });

  it("optional projectId + status filters; status rejects the retired `succeeded`", () => {
    expect(RENDERS_QUERY_SCHEMA.safeParse({ projectId: "p1", status: "running" }).success).toBe(
      true,
    );
    expect(RENDERS_QUERY_SCHEMA.parse({ projectId: "p1", status: "completed" }).status).toBe(
      "completed",
    );
    expect(RENDERS_QUERY_SCHEMA.safeParse({ status: "succeeded" }).success).toBe(false); // D-11 pin
    expect(RENDERS_QUERY_SCHEMA.safeParse({ projectId: "" }).success).toBe(false);
  });
});

describe("renders: RenderJob v2 response type", () => {
  it("carries the v2 fields (version pin, cancel flag, progress, expiry)", () => {
    const job: RenderJob = {
      id: "rdr1",
      projectId: "p1",
      compId: "comp1",
      versionId: "v1",
      format: "mp4",
      settings: { quality: "good" },
      status: "completed",
      cancelRequested: false,
      progress: { framesDone: 150, framesTotal: 150, percent: 100 },
      credits: 4,
      resultUrl: "https://example.test/out.mp4",
      errorCode: null,
      error: null,
      sizeBytes: 2048,
      createdBy: "u1",
      createdAt: "2026-10-24T10:00:00Z",
      startedAt: "2026-10-24T10:00:05Z",
      completedAt: "2026-10-24T10:01:00Z",
      expiresAt: "2026-11-24T10:01:00Z",
    };
    expect(job.status).toBe("completed"); // D-11 vocabulary on the row
    expect(job.progress.percent).toBe(100);
    expect(job.versionId).toBe("v1");
    expect(job.expiresAt).not.toBeNull();
  });

  it("queued rows: zero progress, null optionals", () => {
    const queued: RenderJob = {
      id: "rdr2",
      projectId: "p1",
      compId: "comp1",
      versionId: "v2",
      format: "png-seq",
      settings: {},
      status: "queued",
      cancelRequested: false,
      progress: { framesDone: 0, framesTotal: 0, percent: 0 },
      credits: null,
      resultUrl: null,
      errorCode: null,
      error: null,
      sizeBytes: null,
      createdBy: "u1",
      createdAt: "2026-10-24T10:00:00Z",
      startedAt: null,
      completedAt: null,
      expiresAt: null,
    };
    expect(queued.startedAt).toBeNull();
  });

  it("failed rows carry a stable errorCode alongside the human message", () => {
    const failed: RenderJob = {
      id: "rdr3",
      projectId: "p1",
      compId: "comp1",
      versionId: "v1",
      format: "gif",
      settings: {},
      status: "failed",
      cancelRequested: false,
      progress: { framesDone: 12, framesTotal: 300, percent: 4 },
      credits: null,
      resultUrl: null,
      errorCode: "RENDER_TIMEOUT",
      error: "Render exceeded the time budget.",
      sizeBytes: null,
      createdBy: "u1",
      createdAt: "2026-10-24T10:00:00Z",
      startedAt: "2026-10-24T10:00:05Z",
      completedAt: "2026-10-24T10:02:00Z",
      expiresAt: null,
    };
    expect(failed.errorCode).toBe("RENDER_TIMEOUT");
  });

  it("EstimateResult type compiles (whole display credits, D-12)", () => {
    const estimate: EstimateResult = {
      credits: 1.5,
      outputSeconds: 10,
      longEdgePx: 1920,
      format: "mp4",
      quality: "good",
      minApplied: true,
    };
    expect(estimate.minApplied).toBe(true);
  });

  it("the list response is the house Page<RenderJob>", () => {
    const page: Page<RenderJob> = { items: [], nextCursor: null };
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(0);
  });
});
