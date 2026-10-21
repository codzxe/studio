// W4-I — uploads & asset library route tests. §13.1 (POST /v1/uploads,
// GET /v1/assets, GET/DELETE /v1/assets/:id) + §20.2 (25 MB cap, EXIF stripped,
// 60 MP bomb rejected with a clear error) + §15.1 (cross-tenant 404s) + §22
// (delete audits) + §15.2 (viewer 403, one file per request).
//
// ALL fixtures are synthetic byte arrays crafted in-test per the W2-O
// conventions (packages/storage/tests/validate.test.ts): hand-rolled PNG
// chunks with an independent table-driven CRC-32 and literal JPEG segments —
// no image library, no binary fixtures (§21 synthetic-only policy). Fakes
// implement the AssetsStore / Storage seams; no network, deterministic clocks.

import pino from "pino";
import { describe, expect, it } from "vitest";

import type { Asset } from "@studio/db";
import { Hono, type MiddlewareHandler } from "hono";

import type {
  PutOptions,
  SignOptions,
  SignedUrl,
  Storage,
  StorageObject,
} from "../../../packages/storage/src/types.js";
import { storageErrorFromFailure, storageFailure } from "../../../packages/storage/src/types.js";

import { errorMapper } from "../src/middleware/error-mapper.js";
import {
  contentLengthOverCap,
  uploadRoutes,
  type AuthContext,
  type UploadsEnv,
} from "../src/routes/uploads.js";
import {
  ASSET_SIGN_TTL_SECONDS,
  type AssetCursor,
  type AssetsPage,
  type AssetsStore,
  DEFAULT_UPLOAD_LIMITS,
  type ExifPlanJson,
  type ExifStripJob,
  type MemberRole,
  type RegisterAssetInput,
  type UploadLimitsConfig,
  createAssetsService,
} from "../src/services/assets.js";

// ---------------------------------------------------------------------------
// Fixture helpers — PNG (sig + IHDR + stub IDAT + IEND; dimensions are claims)
// ---------------------------------------------------------------------------

/** Independent table-driven CRC-32 (zlib polynomial 0xEDB88320). */
const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: readonly number[]): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32beBytes(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** PNG chunk: length(4 BE) + type(4 ascii) + data + crc32(type+data)(4 BE). */
function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32([...typeBytes, ...data]);
  return [...u32beBytes(data.length), ...typeBytes, ...data, ...u32beBytes(crc)];
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IDAT = chunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
const IEND = chunk("IEND", []);

function ihdr(width: number, height: number): number[] {
  return chunk("IHDR", [...u32beBytes(width), ...u32beBytes(height), 8, 6, 0, 0, 0]);
}

function toBytes(parts: readonly (readonly number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) {
    flat.push(...part);
  }
  return Uint8Array.from(flat);
}

/** Synthetic PNG (65 bytes): sig + IHDR(w×h) + stub IDAT + IEND. */
function pngFile(width: number, height: number): Uint8Array {
  return toBytes([PNG_SIG, ihdr(width, height), IDAT, IEND]);
}

// ---------------------------------------------------------------------------
// Fixture helpers — JPEG (FF <code> <len16 BE> <payload>; SOF: P Y X Nf)
// ---------------------------------------------------------------------------

function seg(code: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, code, (len >>> 8) & 255, len & 255, ...payload];
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

/** APP1 with "Exif\0\0" + a 10-byte little-endian TIFF header (W2-O shape). */
const APP1_EXIF = seg(0xe1, [
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, // "II*\0" + offset
]);

const DQT = seg(0xdb, [0x00, ...Array<number>(64).fill(0x10)]);

function sof(width: number, height: number): number[] {
  return seg(0xc0, [
    0x08,
    (height >>> 8) & 255,
    height & 255,
    (width >>> 8) & 255,
    width & 255,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
}

const SOS_TAIL = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb, ...EOI];

/** Synthetic JPEG: SOI + header segments + SOF + SOS/entropy/EOI. */
function jpegFile(width: number, height: number, headerParts: number[][] = [DQT]): Uint8Array {
  return toBytes([SOI, ...headerParts, sof(width, height), SOS_TAIL]);
}

const GIF_FILE = Uint8Array.from([..."GIF89a"].map((c) => c.charCodeAt(0)));

// ---------------------------------------------------------------------------
// Fakes (seam implementations; in-memory, deterministic)
// ---------------------------------------------------------------------------

class FakeAssetsStore implements AssetsStore {
  readonly rows = new Map<string, Asset>();
  readonly registered: RegisterAssetInput[] = [];
  readonly audits: {
    readonly organizationId: string | null;
    readonly actorId: string | null;
    readonly action: string;
    readonly target: string;
    readonly metadata: Record<string, unknown>;
  }[] = [];

  async registerAsset(input: RegisterAssetInput): Promise<Asset> {
    const row: Asset = {
      id: input.row.id ?? `row-${this.rows.size + 1}`,
      organizationId: input.row.organizationId,
      uploaderId: input.row.uploaderId,
      kind: input.row.kind,
      storageKey: input.row.storageKey,
      checksum: input.row.checksum,
      bytes: input.row.bytes,
      widthPx: input.row.widthPx ?? null,
      heightPx: input.row.heightPx ?? null,
      mime: input.row.mime,
      exifStripped: input.row.exifStripped ?? false,
      origin: input.row.origin ?? "upload",
      createdAt: input.row.createdAt ?? new Date(0),
    };
    this.rows.set(row.id, row);
    this.registered.push(input);
    return row;
  }

  async findByChecksum(organizationId: string, checksum: string): Promise<Asset | null> {
    for (const row of this.rows.values()) {
      if (row.organizationId === organizationId && row.checksum === checksum) {
        return row;
      }
    }
    return null;
  }

  async listAssets(query: {
    readonly organizationId: string;
    readonly limit: number;
    readonly cursor: AssetCursor | null;
  }): Promise<AssetsPage> {
    const rows = [...this.rows.values()]
      .filter((row) => row.organizationId === query.organizationId)
      .filter((row) => {
        if (query.cursor === null) {
          return true;
        }
        const created = row.createdAt.getTime();
        if (created !== query.cursor.createdAtMs) {
          return created < query.cursor.createdAtMs;
        }
        return row.id < query.cursor.id;
      })
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : 1),
      );
    const page = rows.slice(0, query.limit + 1);
    return { rows: page, hasMore: page.length > query.limit };
  }

  async getAsset(query: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<Asset | null> {
    const row = this.rows.get(query.id);
    return row !== undefined && row.organizationId === query.organizationId ? row : null;
  }

  async deleteAsset(query: {
    readonly organizationId: string;
    readonly id: string;
    readonly actorId: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<Asset | null> {
    const row = this.rows.get(query.id);
    if (row === undefined || row.organizationId !== query.organizationId) {
      return null;
    }
    this.rows.delete(query.id);
    this.audits.push({
      organizationId: query.organizationId,
      actorId: query.actorId,
      action: "asset.delete",
      target: `asset:${query.id}`,
      metadata: query.metadata,
    });
    return row;
  }
}

class FakeStorage implements Storage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  putCount = 0;
  deleteCount = 0;
  lastSignTtl: number | null = null;
  failOnDelete = false;

  async put(key: string, data: Uint8Array, options: PutOptions): Promise<StorageObject> {
    this.putCount += 1;
    this.objects.set(key, { bytes: data, contentType: options.contentType });
    return {
      key,
      bytes: data.byteLength,
      contentType: options.contentType,
      sha256: options.contentSha256 ?? "",
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async delete(key: string): Promise<void> {
    this.deleteCount += 1;
    if (this.failOnDelete) {
      throw storageErrorFromFailure(storageFailure("storage_io_error", "fake delete failure"));
    }
    this.objects.delete(key);
  }

  async sign(key: string, options: SignOptions): Promise<SignedUrl> {
    this.lastSignTtl = options.ttlSeconds;
    return {
      url: `https://objects.test.example/signed?key=${encodeURIComponent(key)}`,
      expiresAt: Date.now() + options.ttlSeconds * 1000,
    };
  }

  async *list(prefix: string): AsyncIterable<string> {
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) {
        yield key;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const logger = pino({ enabled: false });
const ORG_A = "org_alpha";
const ORG_B = "org_beta";
const USER_A = "user_1";
const USER_B = "user_2";

interface Harness {
  readonly app: Hono<UploadsEnv>;
  readonly store: FakeAssetsStore;
  readonly storage: FakeStorage;
  readonly jobs: ExifStripJob[];
  actAs(auth: AuthContext | null): void;
}

function makeHarness(
  opts: {
    readonly role?: MemberRole;
    readonly limits?: UploadLimitsConfig;
    readonly failOnDelete?: boolean;
  } = {},
): Harness {
  const store = new FakeAssetsStore();
  const storage = new FakeStorage();
  storage.failOnDelete = opts.failOnDelete === true;
  const jobs: ExifStripJob[] = [];
  let ids = 0;
  let ticks = 0;
  const service = createAssetsService({
    store,
    storage,
    clock: () => new Date(1_700_000_000_000 + ticks++ * 1000),
    newId: () => `asset-${String(ids++).padStart(3, "0")}`,
    enqueueExifStrip: (job) => {
      jobs.push(job);
    },
  });
  const limits = opts.limits ?? DEFAULT_UPLOAD_LIMITS;

  const current: { auth: AuthContext | null } = {
    auth: { userId: USER_A, organizationId: ORG_A, role: opts.role ?? "editor" },
  };
  const app = new Hono<UploadsEnv>();
  app.use(errorMapper(logger) as unknown as MiddlewareHandler<UploadsEnv>);
  app.use("*", async (c, next) => {
    if (current.auth !== null) {
      c.set("auth", current.auth);
    }
    c.set("uploadsDeps", { service, limits });
    await next();
  });
  app.route("/", uploadRoutes);

  return {
    app,
    store,
    storage,
    jobs,
    actAs: (auth) => {
      current.auth = auth;
    },
  };
}

function multipart(
  bytes: Uint8Array,
  filename: string,
  fields: Record<string, string> = {},
): FormData {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: "image/png" }));
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

async function postUpload(
  app: Hono<UploadsEnv>,
  bytes: Uint8Array,
  filename: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  return app.request("/uploads", { method: "POST", body: multipart(bytes, filename, fields) });
}

/** POST an upload and parse the JSON body as an UploadResponse. */
async function uploadJson(
  app: Hono<UploadsEnv>,
  bytes: Uint8Array,
  filename: string,
): Promise<UploadResponse> {
  const res = await postUpload(app, bytes, filename);
  return (await res.json()) as UploadResponse;
}

interface UploadResponse {
  ok: boolean;
  duplicate: boolean;
  asset: {
    id: string;
    kind: string;
    bytes: number;
    width: number;
    height: number;
    mime: string;
    checksum: string;
  };
}

interface ErrorEnvelopeLike {
  ok: boolean;
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

// ---------------------------------------------------------------------------
// POST /uploads
// ---------------------------------------------------------------------------

describe("POST /uploads (§13.1, §20.2)", () => {
  it("registers the asset, stores the bytes and sanitises the filename", async () => {
    const h = makeHarness();
    const png = pngFile(3, 2);
    const res = await postUpload(h.app, png, "cat photo.png", { kind: "image" });

    expect(res.status).toBe(201);
    const body = (await json(res)) as UploadResponse;
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(body.asset).toMatchObject({
      id: "asset-000",
      kind: "image",
      bytes: 65,
      width: 3,
      height: 2,
      mime: "image/png",
    });
    expect(body.asset.checksum).toMatch(/^[0-9a-f]{64}$/);

    const row = h.store.rows.get(body.asset.id);
    expect(row?.storageKey).toBe(`assets/organizations/${ORG_A}/assets/asset-000/cat-photo.png`);
    expect(row?.exifStripped).toBe(true); // PNG: no EXIF by construction
    expect(row?.origin).toBe("upload");
    expect(row?.uploaderId).toBe(USER_A);
    expect(h.storage.objects.get(row?.storageKey ?? "")?.bytes).toEqual(png);
  });

  it("rejects uploads over the byte cap with 413 upload_too_large", async () => {
    // Same gate as §20.2's 25 MB cap, tightened in the harness for a tiny body.
    const h = makeHarness({
      limits: { maxBytes: 40, maxMegapixels: DEFAULT_UPLOAD_LIMITS.maxMegapixels },
    });
    const res = await postUpload(h.app, pngFile(3, 2), "big.png");
    expect(res.status).toBe(413);
    const body = (await json(res)) as ErrorEnvelopeLike;
    expect(body.code).toBe("upload_too_large");
    expect(body.hint).toBe("max 40 bytes");
    expect(body.retryable).toBe(false);
    expect(h.store.rows.size).toBe(0);
    expect(h.storage.objects.size).toBe(0);
  });

  it("rejects a 61 MP bomb with the §20.2 clear error + hint", async () => {
    const h = makeHarness();
    const res = await postUpload(h.app, pngFile(10000, 6100), "bomb.png");
    expect(res.status).toBe(400);
    const body = (await json(res)) as ErrorEnvelopeLike;
    expect(body.code).toBe("resolution_exceeds_ceiling");
    expect(body.message).toContain("10000×6100");
    expect(body.message).toContain("the cap is 60 megapixels");
    expect(body.hint).toBe("max 60 MP per image");
    expect(body.retryable).toBe(false);
    expect(h.store.rows.size).toBe(0);
  });

  it("rejects polyglot files (trailing JPEG inside a PNG)", async () => {
    const h = makeHarness();
    const polyglot = toBytes([pngFile(2, 2), [0xff, 0xd8, 0xff]]);
    const res = await postUpload(h.app, polyglot, "poly.png");
    expect(res.status).toBe(400);
    const body = (await json(res)) as ErrorEnvelopeLike;
    expect(body.code).toBe("polyglot_detected");
    expect(body.retryable).toBe(false);
  });

  it("rejects unsupported media and malformed requests", async () => {
    const h = makeHarness();

    const gif = await postUpload(h.app, GIF_FILE, "anim.gif");
    expect(gif.status).toBe(400);
    expect(((await json(gif)) as ErrorEnvelopeLike).code).toBe("unsupported_media_type");

    // A valid multipart body with only a text field — no file part at all.
    const noFile = await h.app.request("/uploads", {
      method: "POST",
      body: '--x\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n--x--\r\n',
      headers: { "content-type": "multipart/form-data; boundary=x" },
    });
    expect(noFile.status).toBe(400);
    expect(((await json(noFile)) as ErrorEnvelopeLike).message).toContain("'file' part");

    const notMultipart = await h.app.request("/uploads", {
      method: "POST",
      body: "hi",
      headers: { "content-type": "text/plain" },
    });
    expect(notMultipart.status).toBe(400);

    const font = await postUpload(h.app, pngFile(1, 1), "x.png", { kind: "font" });
    expect(font.status).toBe(400);

    const longName = await postUpload(h.app, pngFile(1, 1), "x.png", { name: "n".repeat(201) });
    expect(longName.status).toBe(400);

    const form = multipart(pngFile(1, 1), "a.png");
    form.append("file", new File([pngFile(2, 2)], "b.png", { type: "image/png" }));
    const twoFiles = await h.app.request("/uploads", { method: "POST", body: form });
    expect(twoFiles.status).toBe(400);
    expect(((await json(twoFiles)) as ErrorEnvelopeLike).message).toContain("one file");
  });

  it("requires an auth context (401) and uploads deps (503)", async () => {
    const h = makeHarness();
    h.actAs(null);
    const res = await postUpload(h.app, pngFile(1, 1), "x.png");
    expect(res.status).toBe(401);
    expect(((await json(res)) as ErrorEnvelopeLike).code).toBe("unauthorized");

    // No uploadsDeps variable at all → typed 503, never a silent default.
    const bare = new Hono<UploadsEnv>();
    bare.use(errorMapper(logger) as unknown as MiddlewareHandler<UploadsEnv>);
    bare.use("*", async (c, next) => {
      c.set("auth", { userId: USER_A, organizationId: ORG_A, role: "owner" });
      await next();
    });
    bare.route("/", uploadRoutes);
    const res2 = await bare.request("/uploads", {
      method: "POST",
      body: multipart(pngFile(1, 1), "x.png"),
    });
    expect(res2.status).toBe(503);
    expect(((await json(res2)) as ErrorEnvelopeLike).code).toBe("service_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Content-Length pre-gate (pure)
// ---------------------------------------------------------------------------

describe("contentLengthOverCap (§20.2 early gate)", () => {
  const cap = DEFAULT_UPLOAD_LIMITS.maxBytes;
  it("rejects only when the declared length exceeds cap + multipart slack", () => {
    expect(contentLengthOverCap(undefined, cap)).toBe(false);
    expect(contentLengthOverCap("", cap)).toBe(false);
    expect(contentLengthOverCap("abc", cap)).toBe(false);
    expect(contentLengthOverCap(`${cap + 8192}`, cap)).toBe(false);
    expect(contentLengthOverCap(`${cap + 8193}`, cap)).toBe(true);
    expect(contentLengthOverCap(`  ${cap + 8193}  `, cap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EXIF strip plan (§20.2 / §15.2)
// ---------------------------------------------------------------------------

describe("EXIF strip plan plumbing", () => {
  it("stores the EXIF plan in row metadata and enqueues the strip stub", async () => {
    const h = makeHarness();
    const res = await postUpload(h.app, jpegFile(30, 20, [APP1_EXIF, DQT]), "photo.jpg");
    expect(res.status).toBe(201);
    const body = (await json(res)) as UploadResponse;
    expect(body.asset.mime).toBe("image/jpeg");
    expect(body.asset.width).toBe(30);
    expect(body.asset.height).toBe(20);

    const row = h.store.rows.get(body.asset.id);
    expect(row?.exifStripped).toBe(false); // pending the worker re-slice

    const registered = h.store.registered[0];
    const plan = registered?.metadata?.exifPlan as ExifPlanJson | undefined;
    expect(plan?.needsStrip).toBe(true);
    expect(plan?.removed?.[0]?.marker).toBe("APP1");

    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]?.assetId).toBe(body.asset.id);
    expect(h.jobs[0]?.storageKey).toBe(row?.storageKey);
    expect(h.jobs[0]?.plan.needsStrip).toBe(true);
  });

  it("marks EXIF-free files as already stripped", async () => {
    const h = makeHarness();
    const res = await postUpload(h.app, jpegFile(10, 10, [DQT]), "clean.jpg");
    expect(res.status).toBe(201);
    const body = (await json(res)) as UploadResponse;
    const row = h.store.rows.get(body.asset.id);
    expect(row?.exifStripped).toBe(true);
    expect(h.store.registered[0]?.metadata).toBeUndefined();
    expect(h.jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dedupe (§12.1)
// ---------------------------------------------------------------------------

describe("upload dedupe on (organization, checksum)", () => {
  it("returns the same asset for identical bytes without a second put", async () => {
    const h = makeHarness();
    const png = pngFile(4, 4);
    const first = await uploadJson(h.app, png, "one.png");
    const second = await uploadJson(h.app, png, "two.png");
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(h.storage.putCount).toBe(1);
    expect(h.store.rows.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/assets + GET /v1/assets/:id
// ---------------------------------------------------------------------------

describe("GET /assets (§13.1 asset library)", () => {
  it("pages newest-first with an opaque cursor", async () => {
    const h = makeHarness();
    await postUpload(h.app, pngFile(1, 1), "a.png");
    await postUpload(h.app, pngFile(2, 1), "b.png");
    await postUpload(h.app, pngFile(3, 1), "c.png");

    const page1 = (await (
      await h.app.request("/assets?limit=2")
    ).json()) as { assets: { id: string }[]; next_cursor?: string };
    expect(page1.assets.map((a) => a.id)).toEqual(["asset-002", "asset-001"]);
    expect(typeof page1.next_cursor).toBe("string");

    const page2 = (await (
      await h.app.request(`/assets?limit=2&cursor=${page1.next_cursor ?? ""}`)
    ).json()) as { assets: { id: string }[]; next_cursor?: string };
    expect(page2.assets.map((a) => a.id)).toEqual(["asset-000"]);
    expect(page2.next_cursor).toBeUndefined();
  });

  it("rejects a malformed cursor with 400", async () => {
    const h = makeHarness();
    const res = await h.app.request("/assets?cursor=!!!!!");
    expect(res.status).toBe(400);
  });

  it("serves a signed URL with the §15.1 ttl (900 s)", async () => {
    const h = makeHarness();
    const up = await uploadJson(h.app, pngFile(3, 2), "cat photo.png");
    const res = await h.app.request(`/assets/${up.asset.id}`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      asset: { name: string; checksum: string; created_at: string };
      url: { url: string; expires_at: string; expires_in_seconds: number };
    };
    expect(body.asset.name).toBe("cat-photo.png");
    expect(body.asset.checksum).toBe(up.asset.checksum);
    expect(body.url.expires_in_seconds).toBe(900);
    expect(body.url.expires_in_seconds).toBe(ASSET_SIGN_TTL_SECONDS);
    expect(body.url.url).toContain("objects.test.example");
    expect(Number.isNaN(Date.parse(body.url.expires_at))).toBe(false);
    expect(h.storage.lastSignTtl).toBe(900);
  });

  it("404s for unknown ids without confirming existence", async () => {
    const h = makeHarness();
    const res = await h.app.request("/assets/nope");
    expect(res.status).toBe(404);
    expect(((await json(res)) as ErrorEnvelopeLike).code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Tenant guard (§15.1 cross-tenant 404s, §20.11)
// ---------------------------------------------------------------------------

describe("cross-tenant isolation", () => {
  it("never serves, lists or deletes another organization's asset", async () => {
    const h = makeHarness();
    const up = await uploadJson(h.app, pngFile(3, 2), "secret.png");

    h.actAs({ userId: USER_B, organizationId: ORG_B, role: "owner" });
    const got = await h.app.request(`/assets/${up.asset.id}`);
    expect(got.status).toBe(404);

    const listed = (await (await h.app.request("/assets")).json()) as { assets: unknown[] };
    expect(listed.assets).toEqual([]);

    const del = await h.app.request(`/assets/${up.asset.id}`, { method: "DELETE" });
    expect(del.status).toBe(404);
    expect(h.storage.deleteCount).toBe(0);
    expect(h.store.audits).toHaveLength(0);
    expect(h.store.rows.has(up.asset.id)).toBe(true);

    // The other org's upload never touched this org's storage prefix.
    for (const key of h.storage.objects.keys()) {
      expect(key.startsWith(`assets/organizations/${ORG_A}/`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/assets/:id (RBAC §15.2, audit §22, best-effort storage delete)
// ---------------------------------------------------------------------------

describe("DELETE /assets/:id", () => {
  it("deletes, audits and removes the object for an editor", async () => {
    const h = makeHarness();
    const up = await uploadJson(h.app, pngFile(3, 2), "gone.png");

    const res = await h.app.request(`/assets/${up.asset.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { ok: boolean; deleted: boolean; id: string };
    expect(body.deleted).toBe(true);
    expect(body.id).toBe(up.asset.id);

    expect(h.store.audits).toHaveLength(1);
    expect(h.store.audits[0]).toMatchObject({
      organizationId: ORG_A,
      actorId: USER_A,
      action: "asset.delete",
      target: `asset:${up.asset.id}`,
    });
    const goneKey = `assets/organizations/${ORG_A}/assets/${up.asset.id}/gone.png`;
    expect(h.storage.objects.has(goneKey)).toBe(false);
    expect(h.store.rows.has(up.asset.id)).toBe(false);

    const after = await h.app.request(`/assets/${up.asset.id}`);
    expect(after.status).toBe(404);
  });

  it("refuses viewers with 403 on both upload and delete", async () => {
    const h = makeHarness({ role: "viewer" });
    const denied = await postUpload(h.app, pngFile(3, 2), "kept.png");
    expect(denied.status).toBe(403);
    expect(((await json(denied)) as ErrorEnvelopeLike).code).toBe("forbidden");
    expect(h.store.rows.size).toBe(0);

    // An editor uploads; the viewer still cannot delete it.
    h.actAs({ userId: USER_A, organizationId: ORG_A, role: "editor" });
    const up = await uploadJson(h.app, pngFile(3, 2), "kept.png");
    h.actAs({ userId: USER_A, organizationId: ORG_A, role: "viewer" });

    const res = await h.app.request(`/assets/${up.asset.id}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(((await json(res)) as ErrorEnvelopeLike).code).toBe("forbidden");
    expect(h.storage.deleteCount).toBe(0);
    expect(h.store.audits).toHaveLength(0);
    expect(h.store.rows.has(up.asset.id)).toBe(true);
  });

  it("still completes the row delete + audit when the object delete fails", async () => {
    const h = makeHarness({ failOnDelete: true });
    const up = await uploadJson(h.app, pngFile(3, 2), "stubborn.png");

    const res = await h.app.request(`/assets/${up.asset.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(h.store.audits).toHaveLength(1);
    expect(h.store.rows.has(up.asset.id)).toBe(false);
  });
});
