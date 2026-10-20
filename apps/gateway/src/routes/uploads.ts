// @studio/gateway — uploads & asset library routes (W4-I). Spec anchors:
//   §13.1  POST /v1/uploads (multipart + register asset), GET /v1/assets
//          (asset library), GET /v1/assets/:id (signed URL), DELETE
//   §13.3  typed envelopes `{ ok:false, code, message, hint, retryable }`
//   §15.1  storage keys are tenant-scoped (assertTenant in the service layer)
//          and object URLs are short-lived signed URLs (≤ 15 min)
//   §15.2  uploads: MIME sniffing by magic bytes (never the Content-Type
//          header), size caps, filename sanitising, EXIF stripping in the
//          worker; RBAC (viewer read, editor+ write) enforced server-side
//   §20.2  25 MB cap, 60 MP bomb ceiling, EXIF stripped — the gates live in
//          @studio/storage validate.ts; limits come from @studio/config
//   §22    deletions are audited (service appends the audit_log row)
//
// MOUNT CONTRACT (routes/index.ts wiring task): this router is a bare `const`
// (no deps factory). Mount it on the /v1 sub-app and have middleware set the
// two context variables BEFORE it runs:
//
//   v1.use("*", uploadsContext(deps));   // sets `uploadsDeps` (service+limits)
//   v1.use("*", authMiddleware);         // sets `auth` (userId/org/role)
//   v1.route("/", uploadRoutes);
//
// Missing variables surface as typed 401/503 envelopes (fail loudly, never
// silently default — AGENTS.md). The errorMapper mounted in src/app.ts renders
// every AppError this file throws.
//
// Idempotency (§13: mutating endpoints): upload idempotency is byte-based —
// the service dedupes on (organization, sha256 checksum, §12.1) and reports
// `duplicate: true`; a second DELETE of the same id is a 404, never a repeat
// effect.
//
// RECONCILIATION (storage imports): see services/assets.ts — until gateway
// declares the `@studio/storage` dependency and @studio/storage exports a
// `./validate` subpath, validate.ts is imported via the sibling source path.

import type { Failure } from "@studio/config";
import { type Context, Hono } from "hono";
import { z } from "zod";

import {
  type UploadFailure,
  stripExifPlan,
  validateUpload,
} from "../../../../packages/storage/src/validate.js";

import { AppError } from "../middleware/error-mapper.js";
import {
  type AssetsService,
  type MemberRole,
  type UploadLimitsConfig,
  roleAtLeast,
} from "../services/assets.js";
import type { AppEnv } from "../types.js";

// ---------------------------------------------------------------------------
// Context contract (set by upstream middleware; guarded per request)
// ---------------------------------------------------------------------------

/** Requester as resolved by the auth middleware: user + tenant + RBAC role. */
export interface AuthContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: MemberRole;
}

/** Route-level dependencies: the asset service + upload limits. */
export interface UploadsDeps {
  readonly service: AssetsService;
  readonly limits: UploadLimitsConfig;
}

/** Hono env for this router; extends the gateway-wide AppEnv (§22 logger etc.). */
export interface UploadsEnv extends AppEnv {
  readonly Variables: AppEnv["Variables"] & {
    readonly auth: AuthContext | undefined;
    readonly uploadsDeps: UploadsDeps | undefined;
  };
}

// ---------------------------------------------------------------------------
// Small guards/helpers
// ---------------------------------------------------------------------------

function requireAuth(c: Context<UploadsEnv>): AuthContext {
  const auth = c.get("auth");
  if (auth === undefined) {
    throw new AppError(401, "unauthorized", "Authentication required.", {
      hint: "Sign in or present a scoped API key to use the asset endpoints.",
    });
  }
  return auth;
}

function requireDeps(c: Context<UploadsEnv>): UploadsDeps {
  const deps = c.get("uploadsDeps");
  if (deps === undefined) {
    throw new AppError(503, "service_unavailable", "The asset service is not wired.", {
      hint: "The gateway bootstrap must set the uploads deps before this router runs.",
    });
  }
  return deps;
}

/**
 * Multipart framing overhead (boundary + text fields) tolerated on top of the
 * file cap when pre-screening the declared Content-Length.
 */
export const MULTIPART_OVERHEAD_SLACK_BYTES = 8 * 1024;

/**
 * §20.2 early gate — reject on the DECLARED Content-Length before buffering
 * anything. Malformed/absent headers pass through (the actual bytes are
 * re-checked by validateUpload; §15.2: headers lie).
 */
export function contentLengthOverCap(contentLength: string | undefined, maxBytes: number): boolean {
  if (contentLength === undefined) {
    return false;
  }
  const trimmed = contentLength.trim();
  const parsed = /^([0-9]{1,19})$/.exec(trimmed);
  if (parsed === null) {
    return false;
  }
  return Number(parsed[1]) > maxBytes + MULTIPART_OVERHEAD_SLACK_BYTES;
}

/** validate.ts upload rejections → HTTP (§13.3: 413 size, 400 validation). */
function throwUploadFailure(failure: UploadFailure): never {
  const status = failure.code === "upload_too_large" ? 413 : 400;
  throw new AppError(status, failure.code, failure.message, {
    hint: failure.hint,
    retryable: false,
  });
}

/** Service Result failures (config catalog codes) → AppError. */
function throwServiceFailure(failure: Failure): never {
  throw new AppError(failureStatus(failure.code), failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.retryable ?? false,
  });
}

function failureStatus(code: string): number {
  switch (code) {
    case "validation_failed":
    case "quota_exceeded":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
    case "cross_tenant_denied":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "storage_error":
    case "engine_unavailable":
      return 503;
    default:
      return 500;
  }
}

/** Zod issue summary safe for a client hint (field paths, never user data). */
function hintFromIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Zod request schemas (§13.3: 400 on malformed request input)
// ---------------------------------------------------------------------------

const listAssetsQuerySchema = z
  .object({
    cursor: z.string().regex(/^[A-Za-z0-9_-]{8,512}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    // §13.1 lists `?project_id=`; the landed schema has no project column
    // (documents hang off the organization — W1-D), so the parameter is
    // accepted + validated today and filters once a linkage column lands.
    project_id: z.string().min(1).max(200).optional(),
  })
  .strict();

const assetIdSchema = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// Router (mounted on the /v1 sub-app by src/routes/index.ts)
// ---------------------------------------------------------------------------

export const uploadRoutes = new Hono<UploadsEnv>();

/**
 * POST /uploads (§13.1 POST /v1/uploads) — multipart body with one `file`
 * part, optional `kind` (only "image"; fonts are never uploaded) and optional
 * `name`. Flow: Content-Length cap → buffer → validateUpload (§20.2:
 * magic-byte sniff, 60 MP ceiling, polyglot/corruption guards) → EXIF strip
 * plan → tenant-guarded put → register asset row → 201.
 */
uploadRoutes.post("/uploads", async (c) => {
  const auth = requireAuth(c);
  const { service, limits } = requireDeps(c);

  // §15.2 RBAC: uploading writes to the workspace — editor and above.
  if (!roleAtLeast(auth.role, "editor")) {
    throw new AppError(403, "forbidden", "Viewers cannot upload assets.", {
      hint: "An editor, admin or owner must upload assets.",
    });
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError(400, "validation_failed", "Uploads must be sent as multipart/form-data.", {
      hint: "POST one 'file' part plus optional 'kind' and 'name' text fields.",
    });
  }

  if (contentLengthOverCap(c.req.header("content-length"), limits.maxBytes)) {
    throw new AppError(413, "upload_too_large", "The upload exceeds the per-file size cap.", {
      hint: `max ${limits.maxBytes} bytes`,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    throw new AppError(400, "validation_failed", "The multipart body could not be parsed.", {
      hint: "Send a well-formed multipart/form-data body with one 'file' part.",
    });
  }

  const files: File[] = [];
  for (const value of Object.values(body)) {
    if (value instanceof File) {
      files.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item instanceof File) {
          files.push(item);
        }
      }
    }
  }
  if (files.length === 0) {
    throw new AppError(400, "validation_failed", "The multipart body must include a 'file' part.", {
      hint: "Add a file part named 'file' (JPEG or PNG).",
    });
  }
  if (files.length > 1) {
    throw new AppError(400, "validation_failed", "Only one file can be uploaded per request.", {
      hint: "Send exactly one file part per POST.",
    });
  }
  const file = files[0];
  if (file === undefined) {
    throw new AppError(400, "validation_failed", "The multipart body must include a 'file' part.");
  }

  const kindField = body["kind"];
  if (kindField !== undefined && typeof kindField !== "string") {
    throw new AppError(400, "validation_failed", "The 'kind' field must be a text value.");
  }
  const kind = kindField ?? "image";
  if (kind !== "image") {
    throw new AppError(400, "validation_failed", "Only the 'image' asset kind can be uploaded.", {
      hint: "Fonts are managed server-side and are never accepted as uploads.",
    });
  }

  const nameField = body["name"];
  if (nameField !== undefined && typeof nameField !== "string") {
    throw new AppError(400, "validation_failed", "The 'name' field must be a text value.");
  }
  const clientName = nameField !== undefined && nameField.length > 0 ? nameField : file.name;
  if (clientName.length > 200) {
    throw new AppError(400, "validation_failed", "The asset name is too long.", {
      hint: "Use a name of at most 200 characters.",
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const validated = validateUpload(bytes, {
    maxBytes: limits.maxBytes,
    maxMegapixels: limits.maxMegapixels,
  });
  if (!validated.ok) {
    throwUploadFailure(validated);
  }

  // §20.2 EXIF: stripped by the worker from this pure plan; PNG needs no strip.
  // The plan is persisted with the row (service) so the job is stateless.
  const plan = stripExifPlan(bytes);
  if (!plan.ok) {
    throwUploadFailure(plan);
  }
  const exifPlan = plan.needsStrip
    ? { needsStrip: plan.needsStrip, keepBytes: plan.keepBytes, removed: plan.removed }
    : null;

  const outcome = await service.registerUpload({
    organizationId: auth.organizationId,
    uploaderId: auth.userId,
    bytes,
    mime: validated.mime,
    width: validated.width,
    height: validated.height,
    clientName,
    exifPlan,
  });
  if (!outcome.ok) {
    throwServiceFailure(outcome);
  }
  const { asset, duplicate } = outcome.value;

  return c.json(
    {
      ok: true,
      asset: {
        id: asset.id,
        kind: asset.kind,
        bytes: asset.bytes,
        width: validated.width,
        height: validated.height,
        mime: asset.mime,
        checksum: asset.checksum,
      },
      duplicate,
    },
    201,
  );
});

/**
 * GET /assets (§13.1 GET /v1/assets) — the organization's asset library,
 * newest first, keyset-paged by (created_at, id). Any member role may read
 * (§15.2 viewer = read + comment).
 */
uploadRoutes.get("/assets", async (c) => {
  const auth = requireAuth(c);
  const { service } = requireDeps(c);

  const parsed = listAssetsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError(400, "validation_failed", "Invalid query parameters.", {
      hint: hintFromIssues(parsed.error),
    });
  }

  const result = await service.list({
    organizationId: auth.organizationId,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  });
  if (!result.ok) {
    throwServiceFailure(result);
  }
  return c.json({
    ok: true,
    assets: result.value.assets,
    next_cursor: result.value.nextCursor,
  });
});

/** GET /assets/:id — metadata + a short-lived signed URL (§15.1, ttl 900 s). */
uploadRoutes.get("/assets/:id", async (c) => {
  const auth = requireAuth(c);
  const { service } = requireDeps(c);

  const parsed = assetIdSchema.safeParse(c.req.param("id"));
  if (!parsed.success) {
    throw new AppError(400, "validation_failed", "Invalid asset id.", {
      hint: "Asset ids are opaque strings returned by the API.",
    });
  }

  const result = await service.getSigned({
    organizationId: auth.organizationId,
    id: parsed.data,
  });
  if (!result.ok) {
    throwServiceFailure(result);
  }
  const { asset, url } = result.value;
  return c.json({
    ok: true,
    asset,
    url: {
      url: url.url,
      expires_at: url.expiresAt,
      expires_in_seconds: url.expiresInSeconds,
    },
  });
});

/**
 * DELETE /assets/:id — editor+ (§15.2 RBAC; viewer gets 403). The service
 * removes the row, appends the §22 audit entry and best-effort deletes the
 * object. Re-deleting the same id is a 404, never a repeat effect.
 */
uploadRoutes.delete("/assets/:id", async (c) => {
  const auth = requireAuth(c);
  const { service } = requireDeps(c);

  if (!roleAtLeast(auth.role, "editor")) {
    throw new AppError(403, "forbidden", "Viewers cannot delete assets.", {
      hint: "An editor, admin or owner must perform the delete.",
    });
  }

  const parsed = assetIdSchema.safeParse(c.req.param("id"));
  if (!parsed.success) {
    throw new AppError(400, "validation_failed", "Invalid asset id.", {
      hint: "Asset ids are opaque strings returned by the API.",
    });
  }

  const result = await service.remove({
    organizationId: auth.organizationId,
    id: parsed.data,
    actorId: auth.userId,
  });
  if (!result.ok) {
    throwServiceFailure(result);
  }
  return c.json({ ok: true, deleted: true, id: parsed.data });
});
