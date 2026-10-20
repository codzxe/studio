// Exports + preview routes tests — deterministic fakes, no network, no DB
// (AGENTS.md test rules). Covers §13.1 POST/GET /v1/documents/:id/exports and
// GET /v1/documents/:id/preview: format validation, §14.1 MP ceiling (402),
// §2.3 PSD warning, jobId = idempotency key (§3.4 replay + cross-org conflict),
// preview hit/miss (ttl 900), tenant guards (§15.1) and RBAC (§15.2).
//
// The idempotent enqueue wrapper (services/exports.ts) is exercised through
// the mounted routes AND directly — including the concurrent in-flight replay.

import { err, ok, type Result } from "@studio/config";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import { mountExportRoutes, type ExportPrincipal } from "../src/routes/exports.js";
import {
  EXPORTS_QUEUE_NAME,
  PREVIEW_URL_TTL_SECONDS,
  PSD_EXPERIMENTAL_WARNING,
  checkExportMegapixels,
  withIdempotentEnqueue,
  type EnqueuedJob,
  type ExportDocument,
  type ExportDocumentsLike,
  type ExportJobPayload,
  type ExportRecord,
  type ExportRoutesDepsAlias,
  type ExportStatusLike,
  type ExportsLike,
  type ObjectUrlSignerLike,
  type PreviewCacheLike,
  type SignedObjectUrl,
} from "../src/services/exports.js";

// --- fixtures ------------------------------------------------------------------

const ORG_A = "org-a";
const ORG_B = "org-b";
const DOC_A = "doc-a";
const DOC_B = "doc-b";
const DOC_ARCHIVED = "doc-archived";
const DOC_BIG = "doc-big"; // 6000×6000 = 36 MP > starter's 32 MP ceiling (§14.1)
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";
const TOKEN_VIEWER = "token-viewer";
const USER_A = "user-a";

/** §13.3 flat error envelope (W1-H error mapper shape). */
interface Envelope {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

async function envelope(res: Response): Promise<Envelope> {
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as Envelope;
}

class FakeAuth {
  constructor(private readonly callers: ReadonlyMap<string, ExportPrincipal>) {}

  async authenticate(request: Request): Promise<Result<ExportPrincipal>> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const caller = this.callers.get(token);
    if (caller === undefined) {
      return err("unauthorized", "Missing or invalid credentials.", {
        hint: "Send Authorization: Bearer <token>.",
      });
    }
    return ok(caller);
  }
}

class FakeDocuments implements ExportDocumentsLike {
  private readonly rows = new Map<string, ExportDocument>();

  seed(
    organizationId: string,
    documentId: string,
    canvas: {
      readonly widthPx: number;
      readonly heightPx: number;
      readonly currentRevision: number;
      readonly archived?: boolean;
    },
  ): void {
    this.rows.set(`${organizationId}:${documentId}`, {
      id: documentId,
      organizationId,
      widthPx: canvas.widthPx,
      heightPx: canvas.heightPx,
      currentRevision: canvas.currentRevision,
      archived: canvas.archived ?? false,
    });
  }

  async get(organizationId: string, documentId: string): Promise<ExportDocument | null> {
    return this.rows.get(`${organizationId}:${documentId}`) ?? null;
  }
}

/** Raw (unmemoized) queue producer — the harness wraps it in withIdempotentEnqueue. */
class FakeEnqueue implements ExportsLike {
  readonly calls: { queue: string; payload: ExportJobPayload; jobId: string }[] = [];
  failNext = false;

  async enqueue(
    queue: string,
    payload: ExportJobPayload,
    options: { readonly jobId: string },
  ): Promise<Result<EnqueuedJob>> {
    this.calls.push({ queue, payload, jobId: options.jobId });
    if (this.failNext) {
      this.failNext = false;
      return err("engine_unavailable", "The queue broker is unavailable.", { retryable: true });
    }
    return ok({ jobId: options.jobId });
  }
}

/** Gated producer for the concurrent in-flight replay test. */
class GatedEnqueue implements ExportsLike {
  calls = 0;
  private readonly gate: Promise<void>;
  readonly release: () => void;

  constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async enqueue(
    _queue: string,
    _payload: ExportJobPayload,
    options: { readonly jobId: string },
  ): Promise<Result<EnqueuedJob>> {
    this.calls += 1;
    await this.gate;
    return ok({ jobId: options.jobId });
  }
}

class FakePreviewCache implements PreviewCacheLike {
  private readonly rows = new Map<string, { storageKey: string; revision: number }>();

  /** Seeds a well-formed key: renders/organizations/<org>/documents/<doc>/… */
  seed(organizationId: string, documentId: string, width: number, revision: number): void {
    this.rows.set(`${documentId}:${width}`, {
      storageKey: `renders/organizations/${organizationId}/documents/${documentId}/preview-${width}-${revision}.png`,
      revision,
    });
  }

  /** Seeds a raw row (foreign/invalid keys for the §15.1 re-guard tests). */
  seedRaw(documentId: string, width: number, row: { storageKey: string; revision: number }): void {
    this.rows.set(`${documentId}:${width}`, row);
  }

  async get(
    documentId: string,
    width: number,
  ): Promise<{ storageKey: string; revision: number } | null> {
    return this.rows.get(`${documentId}:${width}`) ?? null;
  }
}

class FakeSigner implements ObjectUrlSignerLike {
  readonly calls: { key: string; ttlSeconds: number }[] = [];
  failNext = false;

  async sign(
    storageKey: string,
    options: { readonly ttlSeconds: number },
  ): Promise<Result<SignedObjectUrl>> {
    this.calls.push({ key: storageKey, ttlSeconds: options.ttlSeconds });
    if (this.failNext) {
      this.failNext = false;
      return err("storage_error", "Signing is unavailable.", { retryable: true });
    }
    return ok({
      url: `https://objects.example.test/${storageKey}?sig=test`,
      expiresAt: Date.now() + options.ttlSeconds * 1000,
    });
  }
}

class FakeExportStatus implements ExportStatusLike {
  private readonly rows: ExportRecord[] = [];

  seed(record: ExportRecord): void {
    this.rows.push(record);
  }

  async list(
    organizationId: string,
    documentId: string,
    options: { readonly limit: number },
  ): Promise<readonly ExportRecord[]> {
    return this.rows
      .filter(
        (row) => row.organizationId === organizationId && row.documentId === documentId,
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, options.limit);
  }
}

interface Harness {
  readonly documents: FakeDocuments;
  readonly enqueue: FakeEnqueue;
  readonly previewCache: FakePreviewCache;
  readonly signer: FakeSigner;
  readonly status: FakeExportStatus;
  readonly app: ReturnType<typeof buildApp>;
}

function makeHarness(): Harness {
  const documents = new FakeDocuments();
  documents.seed(ORG_A, DOC_A, { widthPx: 4000, heightPx: 3000, currentRevision: 7 });
  documents.seed(ORG_B, DOC_B, { widthPx: 2000, heightPx: 2000, currentRevision: 3 });
  documents.seed(ORG_A, DOC_ARCHIVED, {
    widthPx: 1000,
    heightPx: 1000,
    currentRevision: 2,
    archived: true,
  });
  documents.seed(ORG_A, DOC_BIG, { widthPx: 6000, heightPx: 6000, currentRevision: 1 });

  const auth = new FakeAuth(
    new Map<string, ExportPrincipal>([
      [TOKEN_A, { userId: USER_A, organizationId: ORG_A, plan: "starter", role: "editor" }],
      [TOKEN_B, { userId: "user-b", organizationId: ORG_B, plan: "pro", role: "editor" }],
      [TOKEN_VIEWER, { userId: "user-v", organizationId: ORG_A, plan: "starter", role: "viewer" }],
    ]),
  );
  const enqueue = new FakeEnqueue();
  const previewCache = new FakePreviewCache();
  const signer = new FakeSigner();
  const status = new FakeExportStatus();
  const deps: ExportRoutesDepsAlias = {
    auth,
    documents,
    enqueue: withIdempotentEnqueue(enqueue),
    previewCache,
    signer,
    status,
  };
  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: Date.now(),
    mount: (root) => {
      mountExportRoutes(root, deps);
    },
  });
  return { documents, enqueue, previewCache, signer, status, app };
}

function jsonHeaders(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function createExport(
  harness: Harness,
  documentId: string,
  body: Record<string, unknown>,
  options: { token?: string; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<Response> {
  return harness.app.request(`/v1/documents/${documentId}/exports`, {
    method: "POST",
    headers: jsonHeaders(options.token ?? TOKEN_A, options.headers ?? {}),
    body: options.rawBody ?? JSON.stringify(body),
  });
}

async function listExports(
  harness: Harness,
  documentId: string,
  query = "",
  token: string = TOKEN_A,
): Promise<Response> {
  return harness.app.request(`/v1/documents/${documentId}/exports${query}`, {
    method: "GET",
    headers: jsonHeaders(token),
  });
}

async function getPreview(
  harness: Harness,
  documentId: string,
  query = "",
  token: string = TOKEN_A,
): Promise<Response> {
  return harness.app.request(`/v1/documents/${documentId}/preview${query}`, {
    method: "GET",
    headers: jsonHeaders(token),
  });
}

// --- pure gates -----------------------------------------------------------------

describe("checkExportMegapixels (§14.1 plan ceiling)", () => {
  it.each([
    { width: 5000, height: 6400, plan: "starter" as const, ok: true }, // exactly 32 MP
    { width: 5657, height: 5657, plan: "starter" as const, ok: false }, // 32.001 MP
    { width: 8000, height: 8000, plan: "starter" as const, ok: false }, // 64 MP > 32
    { width: 8000, height: 8000, plan: "pro" as const, ok: true }, // 64 MP == pro ceiling
    { width: 10_000, height: 13_000, plan: "business" as const, ok: false }, // 130 MP > 128
    { width: 0, height: 100, plan: "starter" as const, ok: false },
    { width: 1.5, height: 100, plan: "starter" as const, ok: false },
  ])("$width×$height on $plan → ok=$ok", ({ width, height, plan, ok: passes }) => {
    const result = checkExportMegapixels(width, height, plan);
    expect(result.ok).toBe(passes);
    if (passes) {
      expect(result.ok && result.value.megapixels).toBeCloseTo((width * height) / 1_000_000, 6);
    } else if (!result.ok) {
      expect(result.code).toBe(result.code === "validation_failed" ? "validation_failed" : "plan_limit");
    }
  });

  it("maps a ceiling rejection to the 402 catalog code plan_limit", () => {
    const result = checkExportMegapixels(8000, 8000, "starter");
    expect(result).toMatchObject({ ok: false, code: "plan_limit", retryable: false });
  });
});

// --- §3.4 idempotent enqueue wrapper ----------------------------------------------

describe("withIdempotentEnqueue (§3.4)", () => {
  const payload = (organizationId: string, key: string): ExportJobPayload => ({
    documentId: DOC_A,
    format: "png",
    organizationId,
    requestId: "req-1",
    idempotencyKey: key,
    revision: 7,
    plan: "starter",
  });

  it("concurrent same-key enqueues share one in-flight job", async () => {
    const gated = new GatedEnqueue();
    const wrapped = withIdempotentEnqueue(gated);
    const first = wrapped.enqueue(EXPORTS_QUEUE_NAME, payload(ORG_A, "k"), { jobId: "k" });
    const second = wrapped.enqueue(EXPORTS_QUEUE_NAME, payload(ORG_A, "k"), { jobId: "k" });
    gated.release();
    const [one, two] = await Promise.all([first, second]);
    expect(gated.calls).toBe(1);
    expect(one).toMatchObject({ ok: true, value: { jobId: "k" } });
    expect(two).toMatchObject({ ok: true, value: { jobId: "k" } });
  });

  it("rejects the same key held by another organization (409 conflict)", async () => {
    const inner = new FakeEnqueue();
    const wrapped = withIdempotentEnqueue(inner);
    const first = await wrapped.enqueue(EXPORTS_QUEUE_NAME, payload(ORG_A, "k"), { jobId: "k" });
    expect(first.ok).toBe(true);
    const second = await wrapped.enqueue(EXPORTS_QUEUE_NAME, payload(ORG_B, "k"), { jobId: "k" });
    expect(second).toMatchObject({ ok: false, code: "conflict" });
    expect(inner.calls).toHaveLength(1);
  });
});

// --- POST /v1/documents/:id/exports ----------------------------------------------

describe("POST /v1/documents/:id/exports (§13.1 → job)", () => {
  it("enqueues on the exports queue with jobId = the idempotency key", async () => {
    const harness = makeHarness();

    const res = await createExport(
      harness,
      DOC_A,
      { format: "jpg", width: 1024, height: 768, quality: 85 },
      { headers: { "Idempotency-Key": "key-1", "x-request-id": "req-abc" } },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      export_id: string;
      status: string;
      revision: number;
      warnings: readonly string[];
    };
    expect(body).toEqual({ export_id: "key-1", status: "queued", revision: 7, warnings: [] });

    expect(harness.enqueue.calls).toHaveLength(1);
    const call = harness.enqueue.calls[0];
    if (call === undefined) {
      throw new Error("expected one enqueue call");
    }
    expect(call.queue).toBe(EXPORTS_QUEUE_NAME);
    expect(call.jobId).toBe("key-1"); // §3.4: jobId = idempotency key
    expect(call.payload).toEqual({
      documentId: DOC_A,
      format: "jpg",
      width: 1024,
      height: 768,
      quality: 85,
      organizationId: ORG_A,
      requestId: "req-abc", // §22 correlation rides in the payload
      idempotencyKey: "key-1",
      revision: 7,
      plan: "starter",
    });
  });

  it("replays the same key without re-enqueueing (§3.4)", async () => {
    const harness = makeHarness();
    const first = await createExport(harness, DOC_A, { format: "png" }, {
      headers: { "Idempotency-Key": "same-key" },
    });
    const second = await createExport(harness, DOC_A, { format: "png" }, {
      headers: { "Idempotency-Key": "same-key" },
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual(await first.json());
    expect(harness.enqueue.calls).toHaveLength(1);
  });

  it("rejects unknown formats and unknown fields with 422", async () => {
    const harness = makeHarness();
    for (const body of [{ format: "pdf" }, { format: "" }, { format: 42 }, { format: "png", speed: 9 }]) {
      const res = await createExport(harness, DOC_A, body, {
        headers: { "Idempotency-Key": "k" },
      });
      expect(res.status).toBe(422);
      expect((await envelope(res)).code).toBe("validation_failed");
      expect(harness.enqueue.calls).toHaveLength(0);
    }
  });

  it("bounds width/height to 1..8192 and quality to 1..100 (worker contract)", async () => {
    const harness = makeHarness();
    const rejections = [
      { format: "png", width: 0 },
      { format: "png", width: 8193 },
      { format: "png", height: 0 },
      { format: "jpg", quality: 0 },
      { format: "jpg", quality: 101 },
    ];
    for (const body of rejections) {
      const res = await createExport(harness, DOC_A, body, {
        headers: { "Idempotency-Key": "bounds" },
      });
      expect(res.status).toBe(422);
    }
    for (const body of [{ format: "jpg", quality: 1 }, { format: "jpg", quality: 100 }]) {
      const res = await createExport(harness, DOC_A, body, {
        headers: { "Idempotency-Key": "bounds-ok" },
      });
      expect(res.status).toBe(202);
    }
  });

  it("rejects a requested size over the plan MP ceiling with 402 plan_limit", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_A, { format: "png", width: 8000, height: 8000 }, {
      headers: { "Idempotency-Key": "over" },
    });
    expect(res.status).toBe(402);
    const body = await envelope(res);
    expect(body.code).toBe("plan_limit");
    expect(harness.enqueue.calls).toHaveLength(0);
  });

  it("accepts a requested size exactly at the ceiling", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_A, { format: "png", width: 5000, height: 6400 }, {
      headers: { "Idempotency-Key": "edge" },
    });
    expect(res.status).toBe(202);
  });

  it("rejects a canvas already over the ceiling before any enqueue", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_BIG, { format: "png" }, {
      headers: { "Idempotency-Key": "big" },
    });
    expect(res.status).toBe(402);
    expect((await envelope(res)).code).toBe("plan_limit");
    expect(harness.enqueue.calls).toHaveLength(0);
  });

  it("includes the §2.3 experimental warning for psd", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_A, { format: "psd" }, {
      headers: { "Idempotency-Key": "psd-key" },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { warnings: readonly string[]; export_id: string };
    expect(body.warnings).toEqual([PSD_EXPERIMENTAL_WARNING]);
    expect(body.export_id).toBe("psd-key");
  });

  it("requires an idempotency key (header or body; they must agree)", async () => {
    const harness = makeHarness();
    const missing = await createExport(harness, DOC_A, { format: "png" });
    expect(missing.status).toBe(422);
    expect((await envelope(missing)).code).toBe("validation_failed");

    const disagree = await createExport(harness, DOC_A, { format: "png", idempotency_key: "b" }, {
      headers: { "Idempotency-Key": "a" },
    });
    expect(disagree.status).toBe(422);

    const bodyOnly = await createExport(harness, DOC_A, { format: "png", idempotency_key: "c" });
    expect(bodyOnly.status).toBe(202);
    expect(((await bodyOnly.json()) as { export_id: string }).export_id).toBe("c");
  });

  it("404s unknown and cross-tenant documents identically (§15.1)", async () => {
    const harness = makeHarness();
    const foreign = await createExport(harness, DOC_A, { format: "png" }, {
      token: TOKEN_B,
      headers: { "Idempotency-Key": "x-org" },
    });
    const unknown = await createExport(harness, "doc-missing", { format: "png" }, {
      headers: { "Idempotency-Key": "x-miss" },
    });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect((await envelope(foreign))).toEqual(await envelope(unknown));
  });

  it("409s when another organization holds the same idempotency key", async () => {
    const harness = makeHarness();
    const first = await createExport(harness, DOC_A, { format: "png" }, {
      headers: { "Idempotency-Key": "shared" },
    });
    expect(first.status).toBe(202);
    const second = await createExport(harness, DOC_B, { format: "png" }, {
      token: TOKEN_B,
      headers: { "Idempotency-Key": "shared" },
    });
    expect(second.status).toBe(409);
    expect((await envelope(second)).code).toBe("conflict");
    expect(harness.enqueue.calls).toHaveLength(1);
  });

  it("409s exports on archived documents", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_ARCHIVED, { format: "png" }, {
      headers: { "Idempotency-Key": "arch" },
    });
    expect(res.status).toBe(409);
    expect((await envelope(res)).code).toBe("conflict");
  });

  it("403s viewers (exports:create is editor+, §15.2/ADR-0003)", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_A, { format: "png" }, {
      token: TOKEN_VIEWER,
      headers: { "Idempotency-Key": "v" },
    });
    expect(res.status).toBe(403);
    expect((await envelope(res)).code).toBe("forbidden");
    expect(harness.enqueue.calls).toHaveLength(0);
  });

  it("maps enqueue failure to 503 engine_unavailable and frees the key for retry", async () => {
    const harness = makeHarness();
    harness.enqueue.failNext = true;
    const down = await createExport(harness, DOC_A, { format: "png" }, {
      headers: { "Idempotency-Key": "retry-key" },
    });
    expect(down.status).toBe(503);
    expect((await envelope(down)).code).toBe("engine_unavailable");

    // The failed attempt is evicted from the memo — the retry re-enqueues.
    const retry = await createExport(harness, DOC_A, { format: "png" }, {
      headers: { "Idempotency-Key": "retry-key" },
    });
    expect(retry.status).toBe(202);
    expect(harness.enqueue.calls).toHaveLength(2);
    expect(harness.enqueue.calls[1]?.jobId).toBe("retry-key");
  });

  it("answers 400 to malformed JSON", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_A, {}, {
      headers: { "Idempotency-Key": "bad-json" },
      rawBody: "not json",
    });
    expect(res.status).toBe(400);
    expect((await envelope(res)).code).toBe("validation_failed");
  });

  it("401s unauthenticated requests", async () => {
    const harness = makeHarness();
    const res = await createExport(harness, DOC_A, { format: "png" }, {
      token: undefined,
      headers: { "Idempotency-Key": "anon" },
    });
    expect(res.status).toBe(401);
    expect((await envelope(res)).code).toBe("unauthorized");
  });
});

// --- GET /v1/documents/:id/preview ------------------------------------------------

describe("GET /v1/documents/:id/preview?w=1024 (§13.1 cached preview)", () => {
  it("serves a cached preview as a signed URL (ttl 900, §13)", async () => {
    const harness = makeHarness();
    harness.previewCache.seed(ORG_A, DOC_A, 1024, 7);

    const res = await getPreview(harness, DOC_A, "?w=1024");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; revision: number; expires_at: string };
    expect(body.revision).toBe(7);
    expect(body.url).toBe(
      `https://objects.example.test/renders/organizations/${ORG_A}/documents/${DOC_A}/preview-1024-7.png?sig=test`,
    );
    expect(res.headers.get("location")).toBe(body.url);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(harness.signer.calls).toEqual([
      {
        key: `renders/organizations/${ORG_A}/documents/${DOC_A}/preview-1024-7.png`,
        ttlSeconds: PREVIEW_URL_TTL_SECONDS,
      },
    ]);
  });

  it("defaults w to 1024 (§13.1) and looks up the exact requested width", async () => {
    const harness = makeHarness();
    harness.previewCache.seed(ORG_A, DOC_A, 1024, 7);

    const implicit = await getPreview(harness, DOC_A);
    expect(implicit.status).toBe(200);

    const otherWidth = await getPreview(harness, DOC_A, "?w=512");
    expect(otherWidth.status).toBe(404); // cache identity is (document, width, revision)
    expect((await envelope(otherWidth)).code).toBe("preview_not_rendered");
  });

  it("404s preview_not_rendered with the open/run hint on a cache miss", async () => {
    const harness = makeHarness();
    const res = await getPreview(harness, DOC_A, "?w=1024");
    expect(res.status).toBe(404);
    const body = await envelope(res);
    expect(body.code).toBe("preview_not_rendered");
    expect(body.hint).toContain("Open the document");
    expect(harness.signer.calls).toHaveLength(0);
  });

  it("422s w outside 1..4096 or non-numeric", async () => {
    const harness = makeHarness();
    for (const query of ["?w=0", "?w=4097", "?w=abc", "?w=-5"]) {
      const res = await getPreview(harness, DOC_A, query);
      expect(res.status).toBe(422);
      expect((await envelope(res)).code).toBe("validation_failed");
    }
  });

  it("404s a foreign document as not_found, not preview_not_rendered (§15.1)", async () => {
    const harness = makeHarness();
    harness.previewCache.seed(ORG_B, DOC_B, 1024, 3);
    const res = await getPreview(harness, DOC_A, "?w=1024", TOKEN_B);
    expect(res.status).toBe(404);
    expect((await envelope(res)).code).toBe("not_found");
  });

  it("500s internal_error when the cache returns a foreign key (§15.1 re-guard)", async () => {
    const harness = makeHarness();
    harness.previewCache.seedRaw(DOC_A, 1024, {
      storageKey: `renders/organizations/${ORG_B}/documents/${DOC_A}/preview-1024-7.png`,
      revision: 7,
    });
    const res = await getPreview(harness, DOC_A, "?w=1024");
    expect(res.status).toBe(500);
    expect((await envelope(res)).code).toBe("internal_error");
  });

  it("500s storage_error when signing fails", async () => {
    const harness = makeHarness();
    harness.previewCache.seed(ORG_A, DOC_A, 1024, 7);
    harness.signer.failNext = true;
    const res = await getPreview(harness, DOC_A, "?w=1024");
    expect(res.status).toBe(500);
    expect((await envelope(res)).code).toBe("storage_error");
  });

  it("serves previews to viewers (documents:read, §15.2)", async () => {
    const harness = makeHarness();
    harness.previewCache.seed(ORG_A, DOC_A, 1024, 7);
    const res = await getPreview(harness, DOC_A, "?w=1024", TOKEN_VIEWER);
    expect(res.status).toBe(200);
  });

  it("401s unauthenticated requests", async () => {
    const harness = makeHarness();
    const res = await getPreview(harness, DOC_A, "?w=1024", "nope");
    expect(res.status).toBe(401);
  });
});

// --- GET /v1/documents/:id/exports (list) ----------------------------------------

describe("GET /v1/documents/:id/exports (§13.1 list)", () => {
  it("lists org-scoped jobs and signs fresh URLs for succeeded artifacts", async () => {
    const harness = makeHarness();
    const created = new Date("2025-01-02T00:00:00.000Z");
    harness.status.seed({
      exportId: "exp-1",
      documentId: DOC_A,
      organizationId: ORG_A,
      format: "png",
      status: "succeeded",
      revision: 7,
      width: 4000,
      height: 3000,
      storageKey: `exports/organizations/${ORG_A}/documents/${DOC_A}/png-exp-1.png`,
      createdAt: created,
      finishedAt: new Date("2025-01-02T00:00:05.000Z"),
    });
    harness.status.seed({
      exportId: "exp-2",
      documentId: DOC_A,
      organizationId: ORG_A,
      format: "pcraft",
      status: "queued",
      revision: 7,
      createdAt: new Date("2025-01-03T00:00:00.000Z"),
    });
    harness.status.seed({
      exportId: "exp-3",
      documentId: DOC_B,
      organizationId: ORG_B,
      format: "jpg",
      status: "succeeded",
      revision: 3,
      createdAt,
    });

    const res = await listExports(harness, DOC_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exports: {
        export_id: string;
        format: string;
        status: string;
        revision: number;
        url: string | null;
        created_at: string;
        finished_at: string | null;
      }[];
    };
    // Org+document scoped, newest first; only the succeeded own-org row gets a URL.
    expect(body.exports.map((row) => row.export_id)).toEqual(["exp-2", "exp-1"]);
    const succeeded = body.exports.find((row) => row.export_id === "exp-1");
    expect(succeeded?.url).toContain("https://objects.example.test/");
    expect(succeeded?.finished_at).toBe("2025-01-02T00:00:05.000Z");
    const queued = body.exports.find((row) => row.export_id === "exp-2");
    expect(queued?.url).toBeNull();
    expect(harness.signer.calls).toHaveLength(1); // signed once, ttl 900
    expect(harness.signer.calls[0]?.ttlSeconds).toBe(PREVIEW_URL_TTL_SECONDS);
  });

  it("answers 200 with an empty list before the worker-side store lands", async () => {
    const harness = makeHarness();
    const res = await listExports(harness, DOC_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exports: [] });
  });

  it("honors the limit bound and 404s foreign documents (§15.1)", async () => {
    const harness = makeHarness();
    for (const id of ["l1", "l2", "l3"]) {
      harness.status.seed({
        exportId: id,
        documentId: DOC_A,
        organizationId: ORG_A,
        format: "png",
        status: "failed",
        revision: 7,
        createdAt: new Date(`2025-01-0${id.slice(1)}T00:00:00.000Z`),
      });
    }
    const limited = await listExports(harness, DOC_A, "?limit=2");
    const body = (await limited.json()) as { exports: unknown[] };
    expect(limited.status).toBe(200);
    expect(body.exports).toHaveLength(2);

    const badLimit = await listExports(harness, DOC_A, "?limit=101");
    expect(badLimit.status).toBe(422);

    const foreign = await listExports(harness, DOC_A, "", TOKEN_B);
    expect(foreign.status).toBe(404);
    expect((await envelope(foreign)).code).toBe("not_found");
  });
});
