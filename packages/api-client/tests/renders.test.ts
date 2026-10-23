// @studio/api-client — renders v2 (BUILD_PLAN §M8 task 2; PRODUCT_ARCHITECTURE.md
// §7.2, §9.1 `renders`): queue, history list, poll, cancel and estimate over
// the typed client. Pins the wire paths, the D-11 status vocabulary
// (`completed`, NEVER `succeeded`), the v2 job shape (versionId, progress,
// cancelRequested, errorCode, sizeBytes, startedAt, expiresAt), cursor
// plumbing on GET /v1/renders and the §7.2 Idempotency-Key on every mutation.

import { describe, expect, it } from "vitest";

import type { ApiError } from "../src/api-error";
import { isApiError } from "../src/api-error";
import { createApiClient } from "../src/client";
import { jsonOk } from "./helpers";

const BASE = "https://api.studio.test/v1";

function makeClient(handler: (input: string, init?: RequestInit) => Promise<Response>) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  return { calls, client: createApiClient({ baseUrl: BASE, fetch }) };
}

function idempotencyKeyOf(call: { init?: RequestInit }): string | null {
  const headers = call.init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get("idempotency-key");
  const record = headers as Record<string, string>;
  return record["Idempotency-Key"] ?? record["idempotency-key"] ?? null;
}

// A §7.2-valid v2 job row — every field is validated, so the happy paths
// double as validator-acceptance pins for the new shape.
const QUEUED_JOB = {
  id: "rdr_1",
  projectId: "prj_1",
  compId: "cmp_main",
  versionId: "ver_4",
  format: "mp4",
  settings: { width: 1920, height: 1080, frameRate: 24, quality: "good" },
  status: "queued",
  cancelRequested: false,
  progress: { framesDone: 0, framesTotal: 720, percent: 0 },
  credits: null,
  resultUrl: null,
  error: null,
  errorCode: null,
  sizeBytes: null,
  createdBy: "usr_1",
  createdAt: "2026-10-16T09:00:00Z",
  startedAt: null,
  completedAt: null,
  expiresAt: null,
} as const;

const RUNNING_JOB = {
  ...QUEUED_JOB,
  id: "rdr_2",
  status: "running",
  cancelRequested: true,
  progress: { framesDone: 180, framesTotal: 720, percent: 25 },
  credits: 14,
  startedAt: "2026-10-16T09:00:31Z",
} as const;

const COMPLETED_JOB = {
  ...QUEUED_JOB,
  id: "rdr_3",
  status: "completed",
  progress: { framesDone: 720, framesTotal: 720, percent: 100 },
  resultUrl: "https://cdn.studio.test/out.mp4?sig=x",
  sizeBytes: 48_231_808,
  completedAt: "2026-10-16T09:05:41Z",
  expiresAt: "2026-11-15T09:05:41Z",
} as const;

/** A §7.2-valid failed job row (RENDER_TIMEOUT per config errors vocabulary). */
const FAILED_JOB = {
  ...QUEUED_JOB,
  id: "rdr_4",
  status: "failed",
  progress: { framesDone: 61, framesTotal: 720, percent: 8 },
  credits: null,
  error: "Render exceeded the 5-minute budget",
  errorCode: "RENDER_TIMEOUT",
  startedAt: "2026-10-16T09:00:31Z",
  completedAt: "2026-10-16T09:05:41Z",
} as const;

const QUEUE_BODY = {
  projectId: "prj_1",
  compId: "cmp_main",
  format: "mp4",
  settings: { width: 1920, height: 1080, frameRate: 24, quality: "good" },
  idempotencyKey: "idem-render-0001",
} as const;

describe("createApiClient — renders v2 (queue/list/get/cancel/estimate)", () => {
  it("create (queue) POSTs /renders with the validated body and an Idempotency-Key", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(QUEUED_JOB)));
    const job = await client.renders.create(QUEUE_BODY, { idempotencyKey: "idem-render-0001" });
    expect(calls).toHaveLength(1);
    const { input, init } = calls[0] as { input: string; init: RequestInit };
    expect(input).toBe(`${BASE}/renders`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(QUEUE_BODY);
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBe("idem-render-0001");
    // v2 shape: server-resolved snapshot + zero progress while queued.
    expect(job.versionId).toBe("ver_4");
    expect(job.status).toBe("queued");
    expect(job.cancelRequested).toBe(false);
    expect(job.progress).toEqual({ framesDone: 0, framesTotal: 720, percent: 0 });
    expect(job.errorCode).toBeNull();
    expect(job.sizeBytes).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.expiresAt).toBeNull();
  });

  it("get parses a running job with progress and a pending cancel", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(RUNNING_JOB)));
    const job = await client.renders.get("rdr_2");
    expect(calls[0]?.input).toBe(`${BASE}/renders/rdr_2`);
    expect((calls[0] as { init?: RequestInit }).init?.method).toBe("GET");
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBeNull();
    expect(job.status).toBe("running");
    expect(job.cancelRequested).toBe(true);
    expect(job.progress.percent).toBe(25);
    expect(job.startedAt).toBe("2026-10-16T09:00:31Z");
  });

  it("get parses a completed job with size/result/expiry", async () => {
    const { client } = makeClient(() => Promise.resolve(jsonOk(COMPLETED_JOB)));
    const job = await client.renders.get("rdr_3");
    expect(job.status).toBe("completed");
    expect(job.progress.percent).toBe(100);
    expect(job.sizeBytes).toBe(48_231_808);
    expect(job.expiresAt).toBe("2026-11-15T09:05:41Z");
  });

  it("list serializes cursor/limit/projectId/status and threads nextCursor through", async () => {
    const { calls, client } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [RUNNING_JOB], nextCursor: "cur_page_2" })),
    );
    const page = await client.renders.list({
      cursor: "cur_page_1",
      limit: 25,
      projectId: "prj_1",
      status: "running",
    });
    expect(calls[0]?.input).toBe(
      `${BASE}/renders?cursor=cur_page_1&limit=25&projectId=prj_1&status=running`,
    );
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBeNull(); // GETs never carry one
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("rdr_2");
    // Cursor plumbing: the caller feeds nextCursor back in as `cursor`.
    expect(page.nextCursor).toBe("cur_page_2");
  });

  it("list defaults limit to 50 and skips absent filters (§7.2 pagination)", async () => {
    const { calls, client } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    await client.renders.list();
    expect(calls[0]?.input).toBe(`${BASE}/renders?limit=50`);
  });

  it("list strips unknown keys off job rows (§7.2 forward compat)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          items: [{ ...COMPLETED_JOB, workerNode: "gpu-07", internalPath: "/tmp/x" }],
          nextCursor: null,
        }),
      ),
    );
    const page = await client.renders.list();
    // toStrictEqual is deep-strict: any server-only key that survived would fail.
    expect(page.items[0]).toStrictEqual(COMPLETED_JOB);
  });

  it("cancel POSTs /renders/:id/cancel with an auto-derived Idempotency-Key", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(RUNNING_JOB)));
    const job = await client.renders.cancel("rdr_2");
    const { input, init } = calls[0] as { input: string; init: RequestInit };
    expect(input).toBe(`${BASE}/renders/rdr_2/cancel`);
    expect(init.method).toBe("POST");
    const key = idempotencyKeyOf(calls[0] as { init?: RequestInit });
    expect(key).not.toBeNull();
    expect(key?.length).toBeGreaterThanOrEqual(8);
    expect(job.cancelRequested).toBe(true);
    // Bare cancel: an empty body cancels (the id is the intent).
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("cancel forwards the optional reason in the body", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(RUNNING_JOB)));
    await client.renders.cancel("rdr_2", { reason: "queued the wrong comp" });
    const { init } = calls[0] as { input: string; init: RequestInit };
    expect(JSON.parse(String(init.body))).toEqual({ reason: "queued the wrong comp" });
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBeTruthy();
  });

  it("cancel honors the caller's explicit idempotency key and rejects short ones pre-send", async () => {
    const { calls, client } = makeClient(() => Promise.resolve(jsonOk(RUNNING_JOB)));
    await client.renders.cancel("rdr_2", undefined, { idempotencyKey: "idem-cancel-0001" });
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBe("idem-cancel-0001");

    const bad = await client.renders
      .cancel("rdr_2", undefined, { idempotencyKey: "short" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(bad)).toBe(true);
    expect((bad as ApiError).code).toBe("VALIDATION_FAILED");
    expect(calls).toHaveLength(1); // the short key never reached the wire
  });

  it("estimate POSTs /renders/estimate and parses the quote", async () => {
    const { calls, client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          credits: 14,
          outputSeconds: 30,
          longEdgePx: 1920,
          format: "mp4",
          quality: "good",
          minApplied: false,
        }),
      ),
    );
    const estimate = await client.renders.estimate({
      projectId: "prj_1",
      compId: "cmp_main",
      format: "mp4",
      settings: { width: 1920, height: 1080, frameRate: 24, quality: "good" },
    });
    const { input, init } = calls[0] as { input: string; init: RequestInit };
    expect(input).toBe(`${BASE}/renders/estimate`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: "prj_1",
      compId: "cmp_main",
      format: "mp4",
      settings: { width: 1920, height: 1080, frameRate: 24, quality: "good" },
    });
    // A PURE READ per contracts: no idempotency key on the wire unless the
    // caller passes one explicitly (the gateway exempts the route).
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBeNull();
    expect(estimate).toEqual({
      credits: 14,
      outputSeconds: 30,
      longEdgePx: 1920,
      format: "mp4",
      quality: "good",
      minApplied: false,
    });
  });

  it("estimate honors an explicit idempotency key when the caller sends one", async () => {
    const { calls, client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          credits: 4,
          outputSeconds: 30,
          longEdgePx: 1280,
          format: "mp4",
          quality: "draft",
          minApplied: true,
        }),
      ),
    );
    await client.renders.estimate(
      {
        projectId: "prj_1",
        compId: "cmp_main",
        format: "mp4",
        settings: {},
      },
      { idempotencyKey: "idem-estimate-0001" },
    );
    expect(idempotencyKeyOf(calls[0] as { init?: RequestInit })).toBe("idem-estimate-0001");
  });

  it("estimate reports a plan-min clamp (minApplied: true)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          credits: 4,
          outputSeconds: 30,
          longEdgePx: 1280,
          format: "mp4",
          quality: "draft",
          minApplied: true,
        }),
      ),
    );
    const estimate = await client.renders.estimate({
      projectId: "prj_1",
      compId: "cmp_main",
      format: "mp4",
      settings: { width: 4096, height: 2160 },
    });
    expect(estimate.minApplied).toBe(true);
    expect(estimate.longEdgePx).toBe(1280);
  });

  it("estimate validates the body client-side (off-vocabulary format never sends)", async () => {
    const { calls, client } = makeClient(() =>
      Promise.resolve(
        jsonOk({
          credits: 0,
          outputSeconds: 0,
          longEdgePx: 1920,
          format: "mp4",
          quality: "good",
          minApplied: false,
        }),
      ),
    );
    const bad = await client.renders
      .estimate({
        projectId: "prj_1",
        compId: "cmp_main",
        format: "avi" as never,
        settings: {},
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(bad)).toBe(true);
    expect((bad as ApiError).code).toBe("VALIDATION_FAILED");
    expect(calls).toHaveLength(0);
  });
});

// D-11 pin: the render status vocabulary is the DB's — `completed`, NEVER
// `succeeded` (the pre-D-11 wire name). The client rejects it at BOTH
// boundaries: as a query filter before the request, and in response data.
describe("createApiClient — renders D-11 status vocabulary", () => {
  it('rejects status: "succeeded" in a job response as MALFORMED_RESPONSE', async () => {
    const { client } = makeClient(() =>
      Promise.resolve(jsonOk({ ...COMPLETED_JOB, status: "succeeded" })),
    );
    const error = await client.renders
      .get("rdr_3")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it('rejects status: "succeeded" job rows inside a list page', async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({ items: [{ ...COMPLETED_JOB, status: "succeeded" }], nextCursor: null }),
      ),
    );
    const error = await client.renders
      .list()
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it('rejects status: "succeeded" as a list filter client-side (never sends)', async () => {
    const { calls, client } = makeClient(() =>
      Promise.resolve(jsonOk({ items: [], nextCursor: null })),
    );
    const error = await client.renders
      .list({ status: "succeeded" as never })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("VALIDATION_FAILED");
    expect(calls).toHaveLength(0);
  });

  it("accepts every legal v2 status across the full job lifecycle", async () => {
    // queued → running → completed | failed | cancelled (§7.4/§8.9).
    for (const status of ["queued", "running", "completed", "failed", "cancelled"] as const) {
      const { client } = makeClient(() =>
        Promise.resolve(
          jsonOk({
            ...FAILED_JOB,
            status,
            error: status === "failed" ? "RENDER_TIMEOUT" : null,
            errorCode: status === "failed" ? "RENDER_TIMEOUT" : null,
            completedAt:
              status === "queued" || status === "running" ? null : "2026-10-16T09:05:41Z",
          }),
        ),
      );
      const job = await client.renders.get("rdr_9");
      expect(job.status).toBe(status);
    }
  });
});

// Validator negatives for the v2 job shape: the new required fields must be
// present and well-formed, or the boundary rejects the response as malformed.
describe("createApiClient — renders v2 validator negatives", () => {
  it("rejects a job missing progress", async () => {
    const { client } = makeClient(() => {
      const { progress: _drop, ...rest } = COMPLETED_JOB;
      return Promise.resolve(jsonOk(rest));
    });
    const error = await client.renders
      .get("rdr_3")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects a job missing versionId (server-resolved at queue time)", async () => {
    const { client } = makeClient(() => {
      const { versionId: _drop, ...rest } = COMPLETED_JOB;
      return Promise.resolve(jsonOk(rest));
    });
    const error = await client.renders
      .get("rdr_3")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects out-of-range progress percent", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({ ...RUNNING_JOB, progress: { framesDone: 900, framesTotal: 720, percent: 140 } }),
      ),
    );
    const error = await client.renders
      .get("rdr_2")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects a fractional progress percent (integer 0..100 per contracts)", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonOk({ ...RUNNING_JOB, progress: { framesDone: 180, framesTotal: 720, percent: 24.5 } }),
      ),
    );
    const error = await client.renders
      .get("rdr_2")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects a non-boolean cancelRequested", async () => {
    const { client } = makeClient(() =>
      Promise.resolve(jsonOk({ ...QUEUED_JOB, cancelRequested: "no" })),
    );
    const error = await client.renders
      .get("rdr_1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });

  it("rejects a non-string errorCode (stable machine code per contracts)", async () => {
    const { client } = makeClient(() => Promise.resolve(jsonOk({ ...FAILED_JOB, errorCode: 42 })));
    const error = await client.renders
      .get("rdr_4")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("MALFORMED_RESPONSE");
  });
});
