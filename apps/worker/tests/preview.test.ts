/**
 * Unit tests for the W2-N preview pipeline (src/preview.ts) and export job
 * processor (src/render-jobs.ts). Vitest fakes only — no engine, no storage SDK,
 * no BullMQ, no network; deterministic, table-driven, < 5 s (docs/AGENTS.md).
 *
 * Graded areas (task W2-N): clamp table (1024 agent / 2048 max), magic-byte
 * validation, 6 MiB budget rejection, key construction, signed-URL ttl ≤ 900,
 * the psd experimental error, and the pcraft/png export happy paths.
 */
import { describe, expect, it } from "vitest";
import { ENGINE_PNG_MAX_BYTES } from "@studio/config";
import {
  PREVIEW_URL_TTL_SECONDS,
  PreviewPipeline,
  clampPreviewWidth,
  decodeBase64,
  isPng,
  makePreviewKey,
  type ObjectStorage,
  type PreviewEngine,
  type PreviewRenderInput,
  type PreviewRenderReply,
  type RenderPreviewRequest,
  type SignedObjectUrl,
} from "../src/preview.js";
import {
  EXPORT_URL_TTL_SECONDS,
  checkExportMegapixels,
  isJpeg,
  makeExportStorageKey,
  processExportJob,
  type EngineDocumentSummary,
  type EngineSaveInput,
  type EngineSaveResult,
  type ExportEngine,
  type ExportJobContext,
} from "../src/render-jobs.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const PCRAFT_BYTES = new Uint8Array([0x50, 0x43, 0x52, 0x46, 0x01, 0x02, 0x03]);
const ORGANIZATION_ID = "org_01";
const DOCUMENT_ID = "doc_02";
const REVISION = 7;
const IDEMPOTENCY_KEY = "exp_9f2a";
const FIXED_NOW_MS = 1_700_000_000_000;
const PREVIEW_KEY = "renders/organizations/org_01/documents/doc_02/preview-1024-7.png";

type AnyOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
      readonly retryable?: boolean;
      readonly data?: unknown;
    };

const unwrap = <T>(outcome: AnyOutcome<T>): T => {
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    return outcome.value;
  }
  throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
};

const failureOf = <T>(outcome: AnyOutcome<T>) => {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error("expected a typed failure envelope");
  }
  return outcome;
};

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly putCalls: { key: string; bytes: number }[] = [];
  readonly signCalls: { key: string; ttlSeconds: number }[] = [];
  putError: Error | undefined;
  signError: Error | undefined;

  async put(key: string, data: Uint8Array): Promise<void> {
    if (this.putError) {
      throw this.putError;
    }
    this.putCalls.push({ key, bytes: data.byteLength });
    this.objects.set(key, data);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async sign(key: string, options: { readonly ttlSeconds: number }): Promise<SignedObjectUrl> {
    if (this.signError) {
      throw this.signError;
    }
    this.signCalls.push({ key, ttlSeconds: options.ttlSeconds });
    return {
      url: `https://objects.example.test/${key}?token=signed`,
      expiresAt: FIXED_NOW_MS + options.ttlSeconds * 1000,
    };
  }
}

/** One fake engine session covering both the preview and the export seams. */
class FakeEngine implements ExportEngine, PreviewEngine {
  readonly renderInputs: PreviewRenderInput[] = [];
  readonly saveInputs: EngineSaveInput[] = [];
  readonly files = new Map<string, Uint8Array>();
  canvas: EngineDocumentSummary = { width: 1920, height: 1080, revision: REVISION };
  renderReply: PreviewRenderReply = { mime: "image/png", base64: toBase64(PNG_BYTES) };
  /** When set, a file-arm render writes these bytes; `undefined` simulates a missing file. */
  renderFileBytes: Uint8Array | undefined = PNG_BYTES;
  renderError: Error | undefined;
  saveError: Error | undefined;
  saveWarnings: readonly string[] = [];
  savedBytes: Uint8Array = PNG_BYTES;

  async renderDocument(input: PreviewRenderInput): Promise<PreviewRenderReply> {
    this.renderInputs.push(input);
    if (this.renderError) {
      throw this.renderError;
    }
    if ("path" in this.renderReply && this.renderFileBytes !== undefined) {
      this.files.set(this.renderReply.path, this.renderFileBytes);
    }
    return this.renderReply;
  }

  async readRootFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (bytes === undefined) {
      throw new Error(`no such write-root file: ${path}`);
    }
    return bytes;
  }

  async inspectDocument(): Promise<EngineDocumentSummary> {
    return this.canvas;
  }

  async saveDocument(input: EngineSaveInput): Promise<EngineSaveResult> {
    if (this.saveError) {
      throw this.saveError;
    }
    this.saveInputs.push(input);
    this.files.set(input.path, this.savedBytes);
    return { path: input.path, warnings: this.saveWarnings };
  }
}

const makePipeline = () => {
  const storage = new MemoryStorage();
  const engine = new FakeEngine();
  return { pipeline: new PreviewPipeline({ storage }), storage, engine };
};

const previewRequest = (overrides: Partial<RenderPreviewRequest> = {}): RenderPreviewRequest => ({
  organizationId: ORGANIZATION_ID,
  documentId: DOCUMENT_ID,
  width: 1024,
  revision: REVISION,
  ...overrides,
});

const exportCtx = (payload: unknown): ExportJobContext => ({ jobId: "job_01", payload, attempt: 1 });

const exportPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  organizationId: ORGANIZATION_ID,
  documentId: DOCUMENT_ID,
  format: "png",
  revision: REVISION,
  plan: "starter",
  idempotencyKey: IDEMPOTENCY_KEY,
  ...overrides,
});

const makeExportDeps = () => {
  const engine = new FakeEngine();
  const storage = new MemoryStorage();
  return { deps: { engine, storage }, engine, storage };
};

// ---------------------------------------------------------------------------
// Preview width clamping — §5.1 ≤1024 agent / §2.2 ≤2048 hard
// ---------------------------------------------------------------------------

describe("clampPreviewWidth", () => {
  const TABLE: readonly (readonly [number, "agent" | "interactive", number, boolean])[] = [
    [0, "agent", 1024, true], // "no explicit size" → purpose ceiling
    [0, "interactive", 2048, true],
    [512, "agent", 512, false],
    [1024, "agent", 1024, false],
    [1500, "agent", 1024, true], // §5.1 observe previews never exceed 1024
    [4000, "agent", 1024, true],
    [1500, "interactive", 1500, false],
    [2048, "interactive", 2048, false],
    [2049, "interactive", 2048, true], // §2.2 hard engine ceiling
    [4000, "interactive", 2048, true],
    [1024.9, "agent", 1024, true], // fractions floor
  ];

  it("clamps to the purpose ceiling (table)", () => {
    for (const [requested, purpose, expectedWidth, expectedClamped] of TABLE) {
      const clamped = unwrap(clampPreviewWidth(requested, purpose));
      expect(clamped.width, `${requested}px for ${purpose}`).toBe(expectedWidth);
      expect(clamped.clamped, `${requested}px for ${purpose}`).toBe(expectedClamped);
    }
  });

  it("defaults to the agent ceiling and rejects non-finite or negative widths", () => {
    expect(unwrap(clampPreviewWidth(3000)).width).toBe(1024);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const failure = failureOf(clampPreviewWidth(bad));
      expect(failure.code).toBe("invalid_preview_side");
      expect(failure.retryable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure payload helpers — base64 (RFC 4648) + signatures
// ---------------------------------------------------------------------------

describe("decodeBase64", () => {
  it("round-trips every fixture against Node's encoder", () => {
    const fixtures = [PNG_BYTES, JPEG_BYTES, new Uint8Array(1), new Uint8Array(257)];
    for (const bytes of fixtures) {
      expect(decodeBase64(toBase64(bytes))).toEqual(bytes);
    }
    expect(decodeBase64("AA==")).toEqual(new Uint8Array([0]));
    expect(decodeBase64("AAA=")).toEqual(new Uint8Array([0, 0]));
  });

  it("rejects non-canonical input", () => {
    for (const bad of ["", "A", "AAA", "A===", "AB!C", "=====", "AB C"]) {
      expect(decodeBase64(bad)).toBeUndefined();
    }
  });
});

describe("payload signatures", () => {
  it("recognizes PNG and JPEG magic bytes only", () => {
    expect(isPng(PNG_BYTES)).toBe(true);
    expect(isPng(JPEG_BYTES)).toBe(false);
    expect(isPng(PNG_BYTES.subarray(0, 7))).toBe(false);
    expect(isJpeg(JPEG_BYTES)).toBe(true);
    expect(isJpeg(PNG_BYTES)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Storage key construction — documented key-space
// ---------------------------------------------------------------------------

describe("storage key construction", () => {
  it("builds the documented preview key", () => {
    expect(
      makePreviewKey({
        organizationId: ORGANIZATION_ID,
        documentId: DOCUMENT_ID,
        width: 1024,
        revision: REVISION,
      }),
    ).toBe(PREVIEW_KEY);
  });

  it("builds the per-format export keys", () => {
    const base = { organizationId: ORGANIZATION_ID, documentId: DOCUMENT_ID, revision: REVISION, idempotencyKey: IDEMPOTENCY_KEY };
    expect(makeExportStorageKey({ ...base, format: "pcraft" })).toBe(
      "documents/organizations/org_01/documents/doc_02/export-exp_9f2a-r7.pcraft",
    );
    expect(makeExportStorageKey({ ...base, format: "png" })).toBe(
      "exports/organizations/org_01/documents/doc_02/export-exp_9f2a-r7.png",
    );
    expect(makeExportStorageKey({ ...base, format: "jpg" })).toBe(
      "exports/organizations/org_01/documents/doc_02/export-exp_9f2a-r7.jpg",
    );
  });

  it("refuses traversal-unsafe segments", () => {
    expect(() =>
      makePreviewKey({
        organizationId: ORGANIZATION_ID,
        documentId: "../evil",
        width: 1024,
        revision: REVISION,
      }),
    ).toThrow();
    expect(() =>
      makePreviewKey({ organizationId: ORGANIZATION_ID, documentId: DOCUMENT_ID, width: -1, revision: REVISION }),
    ).toThrow();
    expect(() =>
      makeExportStorageKey({
        organizationId: ORGANIZATION_ID,
        documentId: DOCUMENT_ID,
        revision: REVISION,
        idempotencyKey: "a/b",
        format: "png",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PreviewPipeline.renderPreview
// ---------------------------------------------------------------------------

describe("PreviewPipeline.renderPreview", () => {
  it("renders, stores and signs an agent preview end-to-end (inline reply)", async () => {
    const { pipeline, engine, storage } = makePipeline();
    const result = unwrap(await pipeline.renderPreview(engine, previewRequest({ width: 1500 })));

    expect(result.width).toBe(1024); // §5.1: the agent never sees more than 1024 px
    expect(result.storageKey).toBe(PREVIEW_KEY);
    expect(result.previewUrl).toBe(`https://objects.example.test/${PREVIEW_KEY}?token=signed`);
    expect(result.revision).toBe(REVISION);
    expect(result.expiresAt).toBe(FIXED_NOW_MS + PREVIEW_URL_TTL_SECONDS * 1000);
    expect(engine.renderInputs[0]?.maxSide).toBe(1024);
    expect(engine.renderInputs[0]?.path).toBe("renders/preview-1024-r7.png");
    expect(storage.objects.get(PREVIEW_KEY)).toEqual(PNG_BYTES);
    expect(storage.signCalls[0]?.ttlSeconds).toBe(PREVIEW_URL_TTL_SECONDS);
  });

  it("clamps the requested width to the purpose ceiling before rendering (table)", async () => {
    const TABLE = [
      [4000, "agent", 1024],
      [2049, "interactive", 2048],
      [1500, "interactive", 1500],
    ] as const;
    for (const [width, purpose, expected] of TABLE) {
      const { pipeline, engine } = makePipeline();
      const result = unwrap(
        await pipeline.renderPreview(engine, previewRequest({ width, purpose })),
      );
      expect(result.width).toBe(expected);
      expect(result.storageKey).toBe(
        `renders/organizations/org_01/documents/doc_02/preview-${expected}-7.png`,
      );
      expect(engine.renderInputs[0]?.maxSide).toBe(expected);
    }
  });

  it("reads the PNG back from the write root on the file arm", async () => {
    const { pipeline, engine, storage } = makePipeline();
    engine.renderReply = { path: "renders/preview-1024-r7.png", bytes: PNG_BYTES.byteLength };
    const result = unwrap(await pipeline.renderPreview(engine, previewRequest()));
    expect(result.storageKey).toBe(PREVIEW_KEY);
    expect(storage.objects.get(PREVIEW_KEY)).toEqual(PNG_BYTES);
  });

  it("rejects a non-PNG payload on magic bytes (§2.2)", async () => {
    const { pipeline, engine, storage } = makePipeline();
    engine.renderReply = { mime: "image/png", base64: toBase64(JPEG_BYTES) };
    const failure = failureOf(await pipeline.renderPreview(engine, previewRequest()));
    expect(failure.code).toBe("invalid_png");
    expect(storage.putCalls.length).toBe(0);
  });

  it("rejects a non-PNG mime and undecodable base64", async () => {
    const { pipeline, engine } = makePipeline();
    engine.renderReply = { mime: "image/jpeg", base64: toBase64(PNG_BYTES) };
    expect(failureOf(await pipeline.renderPreview(engine, previewRequest())).code).toBe("invalid_png");
    engine.renderReply = { mime: "image/png", base64: "AB!C" };
    expect(failureOf(await pipeline.renderPreview(engine, previewRequest())).code).toBe("invalid_png");
  });

  it("rejects a fake 6 MiB PNG above the 5 MiB engine budget (§2.2)", async () => {
    const { pipeline, engine, storage } = makePipeline();
    const oversized = new Uint8Array(6 * 1024 * 1024); // 6 MiB > 5 MiB
    oversized.set(PNG_BYTES.subarray(0, 8)); // valid magic, invalid budget
    engine.renderReply = { mime: "image/png", base64: toBase64(oversized) };
    const failure = failureOf(await pipeline.renderPreview(engine, previewRequest()));
    expect(failure.code).toBe("png_too_large");
    expect(failure.retryable).toBe(false);
    expect(storage.putCalls.length).toBe(0);
  });

  it("rejects schema violations without touching the engine", async () => {
    const { pipeline, engine } = makePipeline();
    const badRequests = [
      previewRequest({ width: -1 }),
      previewRequest({ revision: 1.5 }),
      previewRequest({ revision: -2 }),
      previewRequest({ documentId: "a/b" }),
    ];
    for (const bad of badRequests) {
      const failure = failureOf(await pipeline.renderPreview(engine, bad));
      expect(failure.code).toBe("invalid_preview_request");
    }
    expect(engine.renderInputs.length).toBe(0);
  });

  it("maps engine throws to typed envelopes with the cause as data (§5.7)", async () => {
    const { pipeline, engine } = makePipeline();
    engine.renderError = new Error("engine exploded");
    const failure = failureOf(await pipeline.renderPreview(engine, previewRequest()));
    expect(failure.code).toBe("engine_render_failed");
    expect(failure.retryable).toBe(true);
    expect(failure.data).toBe("engine exploded");

    engine.renderError = undefined;
    engine.renderReply = { path: "renders/preview-1024-r7.png", bytes: 1 };
    engine.renderFileBytes = undefined; // write-root read fails
    const readFailure = failureOf(await pipeline.renderPreview(engine, previewRequest()));
    expect(readFailure.code).toBe("engine_render_failed");
  });

  it("maps storage failures to typed envelopes", async () => {
    const { pipeline, storage } = makePipeline();
    storage.putError = new Error("s3 down");
    const putFailure = failureOf(await pipeline.renderPreview(new FakeEngine(), previewRequest()));
    expect(putFailure.code).toBe("preview_store_failed");
    expect(putFailure.retryable).toBe(true);

    const { pipeline: pipeline2, storage: storage2 } = makePipeline();
    storage2.signError = new Error("kms down");
    const signFailure = failureOf(await pipeline2.renderPreview(new FakeEngine(), previewRequest()));
    expect(signFailure.code).toBe("preview_sign_failed");
    expect(storage2.putCalls.length).toBe(1); // bytes were stored before signing failed
  });
});

// ---------------------------------------------------------------------------
// processExportJob
// ---------------------------------------------------------------------------

describe("processExportJob", () => {
  it("refuses psd with the typed experimental error (§2.3)", async () => {
    const { deps, engine } = makeExportDeps();
    const failure = failureOf(await processExportJob(deps, exportCtx(exportPayload({ format: "psd" }))));
    expect(failure.code).toBe("experimental_psd");
    expect(failure.retryable).toBe(false);
    expect(failure.hint ?? "").toMatch(/fidelity report/);
    expect(engine.saveInputs.length).toBe(0); // no engine work for a refused format
  });

  it("exports a layered .pcraft end-to-end (doc.save → storage put → sign)", async () => {
    const { deps, engine, storage } = makeExportDeps();
    engine.savedBytes = PCRAFT_BYTES;
    engine.saveWarnings = ["written as pcraft v1"];
    const result = unwrap(await processExportJob(deps, exportCtx(exportPayload({ format: "pcraft" }))));

    expect(result.format).toBe("pcraft");
    const key = "documents/organizations/org_01/documents/doc_02/export-exp_9f2a-r7.pcraft";
    expect(result.storageKey).toBe(key);
    expect(result.url).toBe(`https://objects.example.test/${key}?token=signed`);
    expect(result.expiresAt).toBe(FIXED_NOW_MS + EXPORT_URL_TTL_SECONDS * 1000);
    expect(result.warnings).toEqual(["written as pcraft v1"]);
    expect(engine.saveInputs[0]?.path).toBe("save/export-exp_9f2a-r7.pcraft");
    expect(engine.renderInputs.length).toBe(0); // pcraft saves; it never renders
    expect(storage.objects.get(key)).toEqual(PCRAFT_BYTES);
    expect(storage.signCalls[0]?.ttlSeconds).toBe(EXPORT_URL_TTL_SECONDS);
  });

  it("exports a full-size png end-to-end", async () => {
    const { deps, engine, storage } = makeExportDeps();
    const result = unwrap(await processExportJob(deps, exportCtx(exportPayload())));

    expect(result.format).toBe("png");
    const key = "exports/organizations/org_01/documents/doc_02/export-exp_9f2a-r7.png";
    expect(result.storageKey).toBe(key);
    expect(result.warnings).toEqual([]);
    expect(engine.saveInputs[0]?.path).toBe("save/export-exp_9f2a-r7.png");
    expect(engine.saveInputs[0]?.quality).toBeUndefined(); // lossless: no quality sent
    expect(storage.objects.get(key)).toEqual(PNG_BYTES);
    expect(storage.signCalls[0]?.ttlSeconds).toBeLessThanOrEqual(900);
  });

  it("exports a jpg with the quality pass-through and warns nothing", async () => {
    const { deps, engine } = makeExportDeps();
    engine.savedBytes = JPEG_BYTES;
    const result = unwrap(
      await processExportJob(deps, exportCtx(exportPayload({ format: "jpg", quality: 85 }))),
    );

    expect(result.format).toBe("jpg");
    expect(engine.saveInputs[0]?.quality).toBe(85);
    expect(engine.saveInputs[0]?.path).toBe("save/export-exp_9f2a-r7.jpg");
    expect(result.warnings).toEqual([]);
  });

  it("ignores quality for lossless formats with a warning", async () => {
    const { deps, engine } = makeExportDeps();
    const result = unwrap(await processExportJob(deps, exportCtx(exportPayload({ quality: 90 }))));
    expect(engine.saveInputs[0]?.quality).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("quality"))).toBe(true);
  });

  it("enforces the §14.1 plan MP ceiling before any engine work", async () => {
    const { deps, engine } = makeExportDeps();
    engine.canvas = { width: 9000, height: 8000, revision: REVISION }; // 72 MP
    const failure = failureOf(
      await processExportJob(deps, exportCtx(exportPayload({ plan: "starter" }))), // 32 MP
    );
    expect(failure.code).toBe("canvas_exceeds_plan_limit");
    expect(failure.retryable).toBe(false);
    expect(engine.saveInputs.length).toBe(0);
  });

  it("enforces the plan ceiling on requested export dimensions too", async () => {
    const { deps } = makeExportDeps();
    const failure = failureOf(
      await processExportJob(
        deps,
        exportCtx(exportPayload({ width: 8192, height: 8192 })), // 67 MP > starter 32 MP
      ),
    );
    expect(failure.code).toBe("canvas_exceeds_plan_limit");
    expect(failure.message).toMatch(/requested export size/);
  });

  it("rejects invalid payloads at the boundary (Zod at every edge)", async () => {
    const { deps, engine } = makeExportDeps();
    const badPayloads: unknown[] = [
      exportPayload({ format: "webp" }),
      exportPayload({ revision: 1.5 }),
      exportPayload({ revision: undefined }),
      exportPayload({ documentId: "a/b" }),
      exportPayload({ plan: "enterprise" }),
      exportPayload({ quality: 0 }),
      {},
    ];
    for (const payload of badPayloads) {
      const failure = failureOf(await processExportJob(deps, exportCtx(payload)));
      expect(failure.code).toBe("invalid_export_request");
    }
    expect(engine.saveInputs.length).toBe(0);
  });

  it("rejects empty exports and wrong signatures", async () => {
    const { deps, engine } = makeExportDeps();
    engine.savedBytes = new Uint8Array(0);
    expect(failureOf(await processExportJob(deps, exportCtx(exportPayload()))).code).toBe(
      "invalid_export_bytes",
    );

    const { deps: deps2, engine: engine2 } = makeExportDeps();
    engine2.savedBytes = JPEG_BYTES; // a JPEG delivered for a png export
    expect(failureOf(await processExportJob(deps2, exportCtx(exportPayload()))).code).toBe(
      "invalid_export_bytes",
    );
  });

  it("maps engine and storage failures to typed envelopes", async () => {
    const { deps, engine } = makeExportDeps();
    engine.saveError = new Error("engine exploded");
    const saveFailure = failureOf(await processExportJob(deps, exportCtx(exportPayload())));
    expect(saveFailure.code).toBe("export_engine_failed");
    expect(saveFailure.retryable).toBe(true);
    expect(saveFailure.data).toBe("engine exploded");

    const { deps: deps2, storage } = makeExportDeps();
    storage.putError = new Error("s3 down");
    expect(failureOf(await processExportJob(deps2, exportCtx(exportPayload()))).code).toBe(
      "export_store_failed",
    );

    const { deps: deps3, storage: storage3 } = makeExportDeps();
    storage3.signError = new Error("kms down");
    expect(failureOf(await processExportJob(deps3, exportCtx(exportPayload()))).code).toBe(
      "export_sign_failed",
    );
  });

  it("signs every URL with a ttl of at most 900 s (§13)", async () => {
    expect(PREVIEW_URL_TTL_SECONDS).toBeLessThanOrEqual(900);
    expect(EXPORT_URL_TTL_SECONDS).toBeLessThanOrEqual(900);
    const { pipeline, storage } = makePipeline();
    await pipeline.renderPreview(new FakeEngine(), previewRequest());
    const { deps, storage: exportStorage } = makeExportDeps();
    await processExportJob(deps, exportCtx(exportPayload()));
    for (const call of [...storage.signCalls, ...exportStorage.signCalls]) {
      expect(call.ttlSeconds).toBeLessThanOrEqual(900);
    }
  });
});

// ---------------------------------------------------------------------------
// checkExportMegapixels — pure §14.1 gate (table)
// ---------------------------------------------------------------------------

describe("checkExportMegapixels", () => {
  const TABLE: readonly {
    readonly width: number;
    readonly height: number;
    readonly plan: "starter" | "pro" | "business";
    readonly ok: boolean;
    readonly failureCode?: "canvas_exceeds_plan_limit" | "invalid_export_request";
  }[] = [
    { width: 1920, height: 1080, plan: "starter", ok: true }, // 2.07 MP ≤ 32
    { width: 5600, height: 5600, plan: "starter", ok: true }, // 31.36 MP
    { width: 5800, height: 5800, plan: "starter", ok: false, failureCode: "canvas_exceeds_plan_limit" }, // 33.64 MP
    { width: 9000, height: 8000, plan: "starter", ok: false, failureCode: "canvas_exceeds_plan_limit" }, // 72 MP
    { width: 9000, height: 8000, plan: "pro", ok: false, failureCode: "canvas_exceeds_plan_limit" }, // 72 MP > 64
    { width: 9000, height: 8000, plan: "business", ok: true }, // 72 MP ≤ 128
    { width: 0, height: 10, plan: "starter", ok: false, failureCode: "invalid_export_request" },
  ];

  it("matches the plan ceiling table (§14.1)", () => {
    for (const row of TABLE) {
      const outcome = checkExportMegapixels(row.width, row.height, row.plan);
      expect(outcome.ok, `${row.width}×${row.height} on ${row.plan}`).toBe(row.ok);
      if (row.ok) {
        expect(unwrap(outcome).megapixels).toBe((row.width * row.height) / 1_000_000);
      } else {
        expect(failureOf(outcome).code).toBe(row.failureCode);
      }
    }
  });
});
