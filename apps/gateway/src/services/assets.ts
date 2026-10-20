// @studio/gateway — asset library service (W4-I). HTTP-free domain layer for
// §13.1 `POST /v1/uploads` + `GET /v1/assets` (+ `:id`, DELETE `:id`).
//
// Spec anchors:
//   §12.1  assets table — binaries in object storage, `checksum` = sha256 hex,
//          dedupe on (organization, checksum) is the SERVICE layer's job
//   §12.2  every query is composite-scoped by organization_id — never
//          "find by id then check"
//   §13.1  uploads → register asset; asset library; signed URLs
//   §15.1  storage keys embed organizations/<orgId>; assertTenant runs before
//          ANY storage effect; signed URLs ≤ 15 min (900 s here)
//   §15.2  filename sanitising; EXIF stripped on upload (colour profiles kept)
//   §20.2  the byte/megapixel gates live in @studio/storage validate.ts and
//          the limits in @studio/config (the route enforces; this layer stores)
//   §22    asset deletion appends an audit_log row ("delete with audit")
//
// RECONCILIATION (storage imports): apps/gateway does not (yet) declare the
// `@studio/storage` workspace dependency, and @studio/storage's package.json
// exports only the root barrel — validate.ts is deliberately not re-exported
// from it (W2-O/W2-M note). Until gateway's package.json gains
// `"@studio/storage": "workspace:*"` AND @studio/storage adds a `./validate`
// subpath export, these imports reach the sibling package's sources directly
// (fleet precedent: engine-pool's local mirror, worker's makePreviewKey note).
// tsc resolves them through the shared program (tsconfig paths + no rootDir,
// W2-Q normalization); vitest resolves them as plain relative files. Swap to
// bare specifiers when the dependency lands — do NOT mirror this code.
//
// RECONCILIATION (Drizzle-backed AssetsStore): `AssetsStore` is the structural
// seam (billing's LedgerStore precedent). The production implementation over
// Drizzle (packages/db) must:
//   * registerAsset   — `db.insert(assets).values(row).returning()`, and
//                       persist `metadata.exifPlan` once the assets table gains
//                       a `meta jsonb` column (§12.1 lists it; the landed W1-D
//                       schema has none — flagged) or a side table lands;
//   * findByChecksum  — WHERE (organization_id, checksum) — the §12.1 dedupe
//                       lookup (no unique index exists yet; dedupe stays
//                       best-effort at this layer);
//   * listAssets      — ORDER BY created_at DESC, id DESC with the keyset
//                       predicate (created_at < c) OR (created_at = c AND
//                       id < c), fetching limit+1 rows to compute hasMore;
//   * getAsset        — WHERE (organization_id, id) only;
//   * deleteAsset     — ONE transaction: DELETE the row + INSERT the append-only
//                       audit_log row (§22). The assets table has no soft-delete
//                       column (W1-D schema), so the audit entry IS the durable
//                       record of the deleted asset.

import { randomUUID } from "node:crypto";

import {
  type Failure,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MEGAPIXELS,
  type Result,
  err,
  ok,
} from "@studio/config";
import type { Asset, NewAsset } from "@studio/db";
import type { Logger } from "pino";
import { z } from "zod";

import {
  assetKey,
  assertTenant,
  isSafeFilename,
  parseStorageKey,
} from "../../../../packages/storage/src/keys.js";
import {
  MAX_SIGN_TTL_SECONDS,
  type SignedUrl,
  type Storage,
  isStorageError,
} from "../../../../packages/storage/src/types.js";
import { checksum as sha256Checksum } from "../../../../packages/storage/src/validate.js";

// ---------------------------------------------------------------------------
// Limits, roles, constants
// ---------------------------------------------------------------------------

/**
 * Upload caps injected into the route (§20.2). Defaults mirror
 * @studio/config `MAX_UPLOAD_BYTES` / `MAX_UPLOAD_MEGAPIXELS`, which @studio/storage's
 * validate.ts also restates — config stays the single source of truth.
 */
export interface UploadLimitsConfig {
  readonly maxBytes: number;
  readonly maxMegapixels: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimitsConfig = {
  maxBytes: MAX_UPLOAD_BYTES,
  maxMegapixels: MAX_UPLOAD_MEGAPIXELS,
};

/** Signed-URL lifetime for asset reads: the §15.1 maximum (15 min). */
export const ASSET_SIGN_TTL_SECONDS = MAX_SIGN_TTL_SECONDS; // 900

/**
 * Workspace RBAC ladder (§15.2: viewer < editor < admin < owner). Mirrors
 * `member.role` (packages/db schema/auth.ts); keep the two in sync.
 */
export type MemberRole = "owner" | "admin" | "editor" | "viewer";

export const ASSET_ROLE_RANK: Readonly<Record<MemberRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/** §15.2 RBAC check: `roleAtLeast(role, "editor")` gates run-level writes. */
export function roleAtLeast(role: MemberRole, minimum: MemberRole): boolean {
  return ASSET_ROLE_RANK[role] >= ASSET_ROLE_RANK[minimum];
}

// ---------------------------------------------------------------------------
// Filename sanitising (§15.2) — safe by construction, never echoed
// ---------------------------------------------------------------------------

/**
 * Turn a client-supplied filename into a storage-key-safe segment: last path
 * segment only, charset allowlist ([A-Za-z0-9._-]), collapses, length cap
 * (128, keys.ts MAX_FILENAME_LENGTH), must start alphanumeric and must not be
 * a Windows device name. Falls back to `upload` (plus an extension derived
 * from the sniffed MIME) when nothing safe remains. Total — never throws.
 */
export function sanitizeStoredFilename(raw: string, extension?: string): string {
  const lastSegment = raw.split(/[\\/]/).pop() ?? "";
  let out = "";
  for (const char of lastSegment) {
    out += /[A-Za-z0-9._-]/.test(char) ? char : "-";
  }
  out = out
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[.]+$/, "");
  if (out.length === 0) {
    out = "upload";
  }
  // 120 leaves headroom for the "." + extension below under the 128-char cap.
  if (out.length > 120) {
    out = out.slice(0, 120).replace(/[.]+$/, "");
  }
  if (out.length === 0) {
    out = "upload";
  }
  if (extension !== undefined && extension.length > 0 && !out.includes(".")) {
    out = `${out}.${extension}`;
  }
  // Device-name fixups (CON.png, LPT1.jpg, …) — prefix instead of rejecting:
  // the client name is display data, the key segment just has to be safe.
  if (!isSafeFilename(out)) {
    out = `file-${out}`;
  }
  if (!isSafeFilename(out) || out.length > 128) {
    out = "upload";
  }
  return out;
}

/** Extension derived from the sniffed MIME (never from client input). */
function extensionForMime(mime: string): string {
  return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "bin";
}

// ---------------------------------------------------------------------------
// Tenant-guarded storage keys (§15.1)
// ---------------------------------------------------------------------------

/**
 * Build `assets/organizations/<orgId>/assets/<assetId>[/<filename>]` and run
 * the cross-tenant guard on the result. Every storage effect in this service
 * goes through here or through `assertTenant` on a row's stored key.
 */
export function buildTenantAssetKey(input: {
  readonly organizationId: string;
  readonly assetId: string;
  readonly filename?: string;
}): Result<string> {
  const built = assetKey(input);
  if (!built.ok) {
    // Programmed inputs (fresh uuid + sanitizeStoredFilename) — impossible by
    // construction; surfaced as internal, never echoed.
    return err("internal_error", "The asset storage key could not be derived.");
  }
  const guarded = assertTenant(built.value, input.organizationId);
  if (!guarded.ok) {
    return err("cross_tenant_denied", guarded.message, {
      hint: guarded.hint ?? "storage keys must embed the caller's own organization id",
    });
  }
  return ok(guarded.value);
}

/**
 * Display name for an asset row: the filename segment of its storage key when
 * parseable, else the row id. Tolerates legacy/seed keys (parse failure never
 * breaks listing — §13.3 no internal-key leaking either way).
 */
export function assetDisplayName(row: Asset): string {
  const parsed = parseStorageKey(row.storageKey);
  if (parsed.ok && parsed.value.kind === "asset" && parsed.value.filename !== undefined) {
    return parsed.value.filename;
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// Wire summary (snake_case, safe fields only)
// ---------------------------------------------------------------------------

/** Client-safe asset projection (§13.3: no storage keys, no uploader ids). */
export interface AssetSummary {
  readonly id: string;
  readonly kind: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly mime: string;
  readonly checksum: string;
  readonly name: string;
  readonly created_at: string;
}

export function assetSummary(row: Asset): AssetSummary {
  return {
    id: row.id,
    kind: row.kind,
    bytes: row.bytes,
    width: row.widthPx,
    height: row.heightPx,
    mime: row.mime,
    checksum: row.checksum,
    name: assetDisplayName(row),
    created_at: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Keyset cursor codec (opaque, tamper-proof via zod at the boundary)
// ---------------------------------------------------------------------------

export interface AssetCursor {
  /** Created-at epoch milliseconds (ISO ms — see the precision note in listAssets). */
  readonly createdAtMs: number;
  readonly id: string;
}

const cursorPayloadSchema = z
  .object({
    createdAtMs: z.number().int().min(0),
    id: z.string().min(1).max(200),
  })
  .strict();

export function encodeAssetsCursor(cursor: AssetCursor): string {
  const payload = JSON.stringify({ createdAtMs: cursor.createdAtMs, id: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeAssetsCursor(raw: string): Result<AssetCursor> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return err("validation_failed", "The pagination cursor is malformed.", {
      hint: "Use the cursor exactly as returned by the previous page response.",
    });
  }
  const parsed = cursorPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return err("validation_failed", "The pagination cursor is malformed.", {
      hint: "Use the cursor exactly as returned by the previous page response.",
    });
  }
  return ok({ createdAtMs: parsed.data.createdAtMs, id: parsed.data.id });
}

// ---------------------------------------------------------------------------
// Storage seam + store seam
// ---------------------------------------------------------------------------

/**
 * EXIF strip work item (§15.2 / §20.2). The plan is the pure byte-range
 * description from @studio/storage `stripExifPlan`; the WORKER performs the
 * re-slice. TODO(worker wave): enqueue this as a real Valkey/BullMQ job.
 */
export interface ExifStripJob {
  readonly assetId: string;
  readonly organizationId: string;
  readonly storageKey: string;
  /** Serialized StripExifPlan; kept in row metadata so the job is stateless. */
  readonly plan: ExifPlanJson;
}

/**
 * JSON-serializable form of @studio/storage's StripExifPlan (§15.2: strip
 * EXIF + comments, keep ICC/colour profiles — `keepBytes` re-slices only).
 */
export interface ExifPlanJson {
  readonly needsStrip: boolean;
  readonly keepBytes: readonly { readonly start: number; readonly end: number }[];
  readonly removed: readonly {
    readonly marker: "APP1" | "APP2" | "COM";
    readonly start: number;
    readonly end: number;
  }[];
}

/** In-process sink stub; swapped for the queue producer when the worker lands. */
export type ExifStripJobSink = (job: ExifStripJob) => void | Promise<void>;

/** Register input: bytes are validated (validate.ts ok) before this is called. */
export interface RegisterUploadInput {
  readonly organizationId: string;
  readonly uploaderId: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** Raw client filename/name field; sanitized inside. */
  readonly clientName: string;
  /** Null when the format has no EXIF standard (PNG) or none was found. */
  readonly exifPlan: ExifPlanJson | null;
}

export interface RegisterUploadOutcome {
  readonly asset: Asset;
  readonly duplicate: boolean;
}

export interface AssetsListOutcome {
  readonly assets: readonly AssetSummary[];
  readonly nextCursor?: string;
}

export interface AssetWithUrl {
  readonly asset: AssetSummary;
  readonly url: SignedUrlWire;
}

export interface SignedUrlWire {
  readonly url: string;
  /** ISO timestamp — wire field `expires_at`. */
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
}

export interface RemovedAsset {
  readonly asset: AssetSummary;
}

export interface AssetsPage {
  /** At most `limit + 1` rows; the extra row signals `hasMore`. */
  readonly rows: readonly Asset[];
  readonly hasMore: boolean;
}

export interface RegisterAssetInput {
  readonly row: NewAsset;
  /**
   * Side-band row metadata (§12.1 `meta jsonb`): the EXIF strip plan while the
   * worker has not landed. The Drizzle impl persists it once the column exists.
   */
  readonly metadata?: { readonly exifPlan?: ExifPlanJson };
}

/**
 * The asset persistence seam. Implementations own Drizzle + the audit append;
 * every method is tenant-scoped by (organization_id, …) composite predicates
 * (§12.2 — never "find by id then check").
 */
export interface AssetsStore {
  /** Insert one asset row; resolves the stored (defaulted) row. */
  registerAsset(input: RegisterAssetInput): Promise<Asset>;
  /** §12.1 dedupe lookup: same bytes already in this organization's library. */
  findByChecksum(organizationId: string, checksum: string): Promise<Asset | null>;
  /** Keyset page, newest first (created_at DESC, id DESC), limit + 1 rows. */
  listAssets(query: {
    readonly organizationId: string;
    readonly limit: number;
    readonly cursor: AssetCursor | null;
  }): Promise<AssetsPage>;
  /** Composite (organization_id, id) fetch — null means "not found in org". */
  getAsset(query: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<Asset | null>;
  /**
   * Delete the row + append the audit_log entry in ONE transaction (§22).
   * Resolves the removed row, or null when no row matched. The assets table has
   * no soft-delete column (W1-D), so the audit row is the durable record.
   */
  deleteAsset(query: {
    readonly organizationId: string;
    readonly id: string;
    readonly actorId: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<Asset | null>;
}

export interface AssetsServiceDeps {
  readonly store: AssetsStore;
  /** Object storage seam (@studio/storage Storage, DI per AGENTS.md). */
  readonly storage: Storage;
  /** Injected for deterministic tests; defaults to `new Date()`. */
  readonly clock?: () => Date;
  /** Injected for deterministic tests; defaults to crypto.randomUUID. */
  readonly newId?: () => string;
  readonly logger?: Logger;
  /** TODO(worker wave): the real queue producer replaces this stub. */
  readonly enqueueExifStrip?: ExifStripJobSink;
}

export interface AssetsService {
  registerUpload(input: RegisterUploadInput): Promise<Result<RegisterUploadOutcome>>;
  list(query: {
    readonly organizationId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<Result<AssetsListOutcome>>;
  getSigned(query: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<Result<AssetWithUrl>>;
  remove(query: {
    readonly organizationId: string;
    readonly id: string;
    readonly actorId: string;
  }): Promise<Result<RemovedAsset>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Re-shape a failure envelope at a different Result type (never re-wraps ok). */
function failAs<T>(failure: Failure): Result<T> {
  return err(failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable,
  });
}

/** Client-safe message for a storage rejection (§13.3: no stacks, no keys). */
function storageFailureMessage(error: unknown): string {
  return isStorageError(error) ? error.message : "Object storage is unavailable.";
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function createAssetsService(deps: AssetsServiceDeps): AssetsService {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const warn = (message: string, error?: unknown): void => {
    if (deps.logger !== undefined) {
      deps.logger.warn(error === undefined ? message : { err: error }, message);
    }
  };

  const registerUpload: AssetsService["registerUpload"] = async (input) => {
    const sha = sha256Checksum(input.bytes);

    // §12.1 dedupe: identical bytes already in this organization → same asset.
    const existing = await deps.store.findByChecksum(input.organizationId, sha);
    if (existing !== null) {
      return ok({ asset: existing, duplicate: true });
    }

    const assetId = newId();
    const filename = sanitizeStoredFilename(input.clientName, extensionForMime(input.mime));
    const key = buildTenantAssetKey({
      organizationId: input.organizationId,
      assetId,
      filename,
    });
    if (!key.ok) {
      return failAs(key);
    }

    try {
      await deps.storage.put(key.value, input.bytes, {
        contentType: input.mime,
        contentSha256: sha,
      });
    } catch (error) {
      return err("storage_error", storageFailureMessage(error), { retryable: true });
    }

    // exifStripped semantics: true when the stored bytes carry no EXIF
    // (§20.2 satisfied by construction — PNG never does); false while a JPEG's
    // strip plan is pending the worker re-slice (the plan is persisted in row
    // metadata so the job can rebuild the file from byte ranges alone).
    const needsStrip = input.exifPlan?.needsStrip === true;
    const row: NewAsset = {
      id: assetId,
      organizationId: input.organizationId,
      uploaderId: input.uploaderId,
      kind: "image",
      storageKey: key.value,
      checksum: sha,
      bytes: input.bytes.byteLength,
      widthPx: input.width,
      heightPx: input.height,
      mime: input.mime,
      exifStripped: !needsStrip,
      origin: "upload",
      createdAt: clock(),
    };

    let stored: Asset;
    try {
      stored = await deps.store.registerAsset({
        row,
        metadata: needsStrip && input.exifPlan !== null ? { exifPlan: input.exifPlan } : undefined,
      });
    } catch (error) {
      warn("asset register failed; compensating with a best-effort object delete", error);
      try {
        await deps.storage.delete(key.value);
      } catch (compensationError) {
        warn(
          "asset register compensation delete failed; orphaned object left for the sweeper",
          compensationError,
        );
      }
      return err("internal_error", "The asset could not be registered.");
    }

    if (needsStrip && deps.enqueueExifStrip !== undefined && input.exifPlan !== null) {
      // TODO(worker wave): replace this in-process sink stub with a real
      // Valkey/BullMQ ExifStripJob (§15.2 EXIF stripping happens in the
      // worker; the gateway never re-slices bytes). Failure is non-fatal —
      // the plan stays in row metadata for the sweeper/job to pick up.
      try {
        await deps.enqueueExifStrip({
          assetId,
          organizationId: input.organizationId,
          storageKey: key.value,
          plan: input.exifPlan,
        });
      } catch (error) {
        warn("exif strip enqueue failed; the plan stays in row metadata", error);
      }
    }
    return ok({ asset: stored, duplicate: false });
  };

  const list: AssetsService["list"] = async (query) => {
    let cursor: AssetCursor | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodeAssetsCursor(query.cursor);
      if (!decoded.ok) {
        return failAs(decoded);
      }
      cursor = decoded.value;
    }
    const page = await deps.store.listAssets({
      organizationId: query.organizationId,
      limit: query.limit,
      cursor,
    });
    // Keyset cursors carry epoch milliseconds; timestamptz rows can carry
    // microseconds, so rows created within the same millisecond are ordered
    // (and paged) by id — the (createdAt, id) pair keeps the page order total.
    const rows = page.rows.slice(0, query.limit);
    let nextCursor: string | undefined;
    if (page.hasMore) {
      const last = rows[rows.length - 1];
      if (last !== undefined) {
        nextCursor = encodeAssetsCursor({ createdAtMs: last.createdAt.getTime(), id: last.id });
      }
    }
    return ok({ assets: rows.map(assetSummary), nextCursor });
  };

  const getSigned: AssetsService["getSigned"] = async (query) => {
    const row = await deps.store.getAsset({ organizationId: query.organizationId, id: query.id });
    if (row === null) {
      return err("not_found", "Asset not found.");
    }
    const guarded = assertTenant(row.storageKey, query.organizationId);
    if (!guarded.ok) {
      // The row is this org's (composite fetch above) but its key is not in
      // the tenant layout (legacy/seed data) — never leak the key itself.
      return err("internal_error", "The asset record cannot be served from object storage.");
    }
    let signed: SignedUrl;
    try {
      signed = await deps.storage.sign(guarded.value, { ttlSeconds: ASSET_SIGN_TTL_SECONDS });
    } catch (error) {
      return err("storage_error", storageFailureMessage(error), { retryable: true });
    }
    return ok({
      asset: assetSummary(row),
      url: {
        url: signed.url,
        expiresAt: new Date(signed.expiresAt).toISOString(),
        expiresInSeconds: ASSET_SIGN_TTL_SECONDS,
      },
    });
  };

  const remove: AssetsService["remove"] = async (query) => {
    const row = await deps.store.getAsset({ organizationId: query.organizationId, id: query.id });
    if (row === null) {
      return err("not_found", "Asset not found.");
    }
    // Row first (the DB is the source of truth), then the object — a failed
    // object delete leaves a harmless orphan; the reverse would leave a row
    // signing dead keys. Both deletes are audit-anchored (§22).
    const guarded = assertTenant(row.storageKey, query.organizationId);
    if (guarded.ok) {
      try {
        await deps.storage.delete(guarded.value);
      } catch (error) {
        warn("asset object delete failed; orphaned object left for the sweeper", error);
      }
    } else {
      warn("asset row carries a non-tenant-layout storage key; object left in place");
    }
    const deleted = await deps.store.deleteAsset({
      organizationId: query.organizationId,
      id: query.id,
      actorId: query.actorId,
      metadata: { bytes: row.bytes, mime: row.mime },
    });
    if (deleted === null) {
      return err("not_found", "Asset not found.");
    }
    return ok({ asset: assetSummary(deleted) });
  };

  return { registerUpload, list, getSigned, remove };
}
