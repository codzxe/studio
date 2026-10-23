// @studio/gateway — /v1/assets (§7.2, §9.1, §9.2, §12.3): two-phase upload —
// POST a descriptor, PUT the bytes to the returned signed URL.
//
// W1-c (AUD-1 gap #5 / M2.2 + M2.5) wires the previously-unwired hardening:
//   * SHA-256 dedupe on the descriptor path (repos.assets.bySha256): same
//     workspace + same sha + compatible project scope → the EXISTING row is
//     returned with `upload: null` (no second copy of the bytes, nothing to
//     PUT) and `duplicate: true`. No row is created.
//   * Per-plan storageBytes quota (§M2.5): projected usage vs the plan's
//     storageBytes, resolved through the resolvePlan seam → 429
//     QUOTA_EXCEEDED BEFORE the signed PUT URL is minted. The flat env cap
//     ASSET_MAX_BYTES stays the OUTER bound (413).
//   * POST /v1/assets/:id/complete — the EXPLICIT VERIFY STEP the descriptor
//     flow calls when the client PUT finishes. DESIGN NOTE (why an explicit
//     step): in the two-phase flow the bytes go straight from the client to
//     object storage over the signed URL — the gateway observes neither the
//     PUT nor its completion, so a silent "verify after PUT" hook is
//     architecturally impossible without proxying bytes through the gateway
//     (which would break the 24MP/100MB no-full-buffering requirement). The
//     honest minimal design is therefore a completion call the client makes:
//     the gateway reads ONLY the object HEAD (first 512 KiB via the storage
//     driver's ranged read — never the full bytes), magic-byte-sniffs the true
//     MIME (@studio/storage validate.ts — first product consumer), rejects
//     mismatches with 415 ASSET_TYPE_MISMATCH, probes image dimensions where
//     cheap (PNG IHDR / JPEG SOF header parse) and enforces the 60 MP bomb
//     ceiling. Video/audio/font types are NOT sniffable by the library and
//     pass the head check for now (deep verification stays owed to the worker
//     wave, as the original header comment noted). The api-client's
//     `assets.upload` helper always calls complete, so product flows verify.
//
// §M7 task 3 (read-only): an upload scoped to a project via the OPTIONAL
// `projectId` query parameter goes through the lease gate — only the ACTIVE
// holder may add project-scoped assets while someone is editing. Unscoped
// uploads target the shared workspace library and are never lease-blocked
// (the lease governs the project, not the team library).

import { Hono } from "hono";

import {
  type Asset as AssetDto,
  CREATE_ASSET_SCHEMA,
  type CreateAssetResponse,
  PAGINATION_QUERY_SCHEMA,
  type VerifyAssetResponse,
} from "@studio/contracts";

import { type Asset, createId } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireLeaseForMutation } from "../lease-guard.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { SIGNED_URL_TTL_SECONDS } from "../signing.js";
import { assetKey, sanitizeName } from "../storage.js";
import { audit, planEntitlements } from "./projects.js";

// @studio/storage is a declared dependency of @studio/gateway (W4-KILL, audit
// REPLACE-6 — the old relative ../../packages/storage/src/validate.js vendor
// seam ran a stale committed tsc snapshot at runtime); validate.ts is pure
// zero-dependency byte parsing (node:crypto only; see the Vitest suite in
// packages/storage/tests), imported through its "./validate" subpath export.
import { DEFAULT_MAX_UPLOAD_MEGAPIXELS, dimensions, sniffMime } from "@studio/storage/validate";

/**
 * Head budget for the verify step: enough for a PNG IHDR and a JPEG header
 * walk (even with a bulky EXIF thumbnail) while staying four orders of
 * magnitude under the 100 MB video / 24 MP image ceiling — the verify read
 * is bounded by construction and NEVER buffers the whole object.
 */
const SNIFF_HEAD_BYTES = 512 * 1024;

/** Media types validate.ts can confirm by magic bytes (§15.2 sniffable set). */
const SNIFFABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/**
 * Dedupe scope rule: the twin is usable by the requesting flow when it is a
 * LIBRARY asset (projectId null — visible to every project's manifest, §9.1)
 * or scoped to the SAME project. A twin pinned to another project stays
 * invisible there, so the upload proceeds with its own row.
 */
function dedupeScopeCompatible(
  twinProjectId: string | null,
  requestedProjectId: string | null,
): boolean {
  return twinProjectId === null || twinProjectId === requestedProjectId;
}

export function assetsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/assets/*", requireAuth());

  const toDto = (asset: Asset): AssetDto => ({
    id: asset.id,
    workspaceId: asset.workspaceId,
    projectId: asset.projectId,
    name: asset.name,
    mime: asset.mime,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    width: asset.width,
    height: asset.height,
    durationTicks: asset.durationTicks,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt.toISOString(),
  });

  app.get("/v1/assets", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const query = PAGINATION_QUERY_SCHEMA.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!query.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Check the pagination parameters.",
        requestId: c.get("requestId"),
      });
    }
    const projectId = c.req.query("projectId");
    const workspaceId = c.get("workspace").id;
    const result = await deps.repos.assets.list(workspaceId, {
      projectId: projectId === undefined ? undefined : projectId === "" ? null : projectId,
      cursor: query.data.cursor ?? null,
      limit: query.data.limit,
    });
    return page(c, result.items.map(toDto), result.nextCursor);
  });

  app.post("/v1/assets", requireWorkspace("editor"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    const parsed = CREATE_ASSET_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Send name, mime, sizeBytes and a sha256 hex digest.",
        requestId: c.get("requestId"),
      });
    }
    const descriptor = parsed.data;
    if (descriptor.sizeBytes > deps.env.storage.assetMaxBytes) {
      throw new GatewayError("ASSET_TOO_LARGE", "This file is larger than your plan allows.", {
        status: 413,
        hint: "Compress the file, or upgrade for bigger uploads.",
        requestId: c.get("requestId"),
      });
    }

    // §M7 task 3: a project-scoped upload (optional ?projectId=) belongs to
    // the lease holder — a non-holder gets 409 LEASE_HELD; cross-tenant or
    // unknown project ids 404 through the gate's tenant-filtered read. The
    // repo re-asserts tenancy on insert, as it always has.
    const scopeProjectId = c.req.query("projectId");
    const requestedProjectId =
      scopeProjectId !== undefined && scopeProjectId !== "" ? scopeProjectId : null;
    if (requestedProjectId !== null) {
      await requireLeaseForMutation(deps, c, requestedProjectId);
    }

    // W1-c (b): SHA-256 dedupe BEFORE the quota gate — a content hit stores
    // zero new bytes, so an at-cap workspace may still reference an asset it
    // already holds (§9.2 content addressing: identical bytes live once).
    // The response carries the EXISTING row (`upload: null` — nothing to PUT)
    // with `duplicate: true`; no row is created. Scope rule above: library
    // twins satisfy any request; same-project twins satisfy project requests.
    const twin = await deps.repos.assets.bySha256(workspace.id, descriptor.sha256);
    if (
      twin !== null &&
      dedupeScopeCompatible(twin.projectId, requestedProjectId) &&
      twin.sizeBytes === descriptor.sizeBytes
    ) {
      await audit(deps, c, workspace.id, "asset.deduped", twin.id, {
        mime: twin.mime,
      });
      const dedupeBody: CreateAssetResponse = {
        asset: toDto(twin),
        upload: null,
        duplicate: true,
      };
      // 200, not 201: nothing was created.
      return ok(c, dedupeBody, 200);
    }

    // W1-c (c): per-plan storageBytes quota (§M2.5) — the INNER gate behind
    // the flat env cap. Projected usage = live usage + this descriptor;
    // check-then-act is not atomic across concurrent uploads (documented
    // deviation — worker-wave usage counters tighten it). Client-declared
    // sizeBytes is the projection input; the verify step true-ups against
    // the object HEAD afterwards.
    const [entitlements, usage] = await Promise.all([
      planEntitlements(workspace.id),
      deps.repos.assets.quota(workspace.id),
    ]);
    if (usage.totalBytes + descriptor.sizeBytes > entitlements.storageBytes) {
      throw new GatewayError("QUOTA_EXCEEDED", "This upload would exceed your plan's storage.", {
        status: 429,
        hint: "Delete unused assets or upgrade your plan for more storage.",
        requestId: c.get("requestId"),
      });
    }

    // Object key per §9.2. The repo mints the row id; the key embeds a
    // pre-generated asset-shaped id (documented deviation: key id ≠ row id —
    // assets are always looked up by row.objectKey, never by reconstructing
    // the key from the row id).
    const keyId = createId("ast");
    const objectKey = assetKey(workspace.id, keyId, sanitizeName(descriptor.name));

    const asset = await deps.repos.assets.create(workspace.id, {
      name: descriptor.name,
      mime: descriptor.mime,
      sizeBytes: descriptor.sizeBytes,
      sha256: descriptor.sha256,
      objectKey,
      width: descriptor.width ?? null,
      height: descriptor.height ?? null,
      durationTicks: descriptor.durationTicks ?? null,
      projectId: requestedProjectId,
      createdBy: c.get("auth").user.id,
    });

    const upload = await deps.storage.getSignedUrl(objectKey, SIGNED_URL_TTL_SECONDS, {
      method: "PUT",
      contentType: descriptor.mime,
      contentLength: descriptor.sizeBytes,
    });

    await audit(deps, c, workspace.id, "asset.created", asset.id, { mime: descriptor.mime });
    const body: CreateAssetResponse = {
      asset: toDto(asset),
      upload: {
        url: upload.url,
        method: "PUT",
        expiresAt: upload.expiresAt.toISOString(),
        headers: upload.headers,
      },
    };
    return ok(c, body, 201);
  });

  app.get(
    "/v1/assets/:id/url",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const asset = await deps.repos.assets.get(c.get("workspace").id, pathParam(c, "id"));
      const signed = await deps.storage.getSignedUrl(asset.objectKey, SIGNED_URL_TTL_SECONDS, {
        method: "GET",
      });
      return ok(c, { url: signed.url, expiresAt: signed.expiresAt.toISOString() });
    },
  );

  // W1-c (a): the explicit verify step — see the module header for the
  // design note. Lease rule: completing an upload the caller just made does
  // not fight the lease (the lease gate already ran at descriptor time), so
  // there is no lease gate here.
  app.post(
    "/v1/assets/:id/complete",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const requestId = c.get("requestId");
      // §12.1: tenant-scoped read first — cross-tenant ids read as 404
      // ASSET_NOT_FOUND before any storage I/O happens.
      const asset = await deps.repos.assets.get(workspace.id, pathParam(c, "id"));

      const rejectUpload = async (code: string, message: string, hint: string): Promise<never> => {
        // Hygiene AFTER the verdict, never before: drop the row and the
        // object so a rejected upload cannot linger as a usable asset.
        // Cleanup failures must not mask the typed rejection. The status is
        // the code's catalog mapping (ASSET_TYPE_MISMATCH/ASSET_REJECTED → 415,
        // SHA256_MISMATCH → 400).
        await deps.repos.assets.remove(workspace.id, asset.id).catch(() => undefined);
        await deps.storage.delete(asset.objectKey).catch(() => undefined);
        throw new GatewayError(code, message, { hint, requestId });
      };

      const meta = await deps.storage.head(asset.objectKey);
      if (meta === null) {
        throw new GatewayError("VALIDATION_FAILED", "The bytes haven't been uploaded yet.", {
          status: 400,
          hint: "PUT the file to the signed URL from the create response first, then complete.",
          requestId,
        });
      }
      // Size truth-up from the object HEAD (never the full bytes): a lying
      // descriptor is rejected the same way the versions route rejects a
      // sha/size mismatch — the stored object must match the descriptor.
      if (meta.size !== null && meta.size !== asset.sizeBytes) {
        await rejectUpload(
          "SHA256_MISMATCH",
          "The stored bytes don't match the descriptor.",
          "The uploaded object's size differs from the declared sizeBytes; re-upload with an updated descriptor.",
        );
      }

      // Bounded head read — the ONLY byte access on this path.
      const headBytes = await deps.storage.readRange(asset.objectKey, SNIFF_HEAD_BYTES);
      if (headBytes === null) {
        throw new GatewayError("VALIDATION_FAILED", "The bytes haven't been uploaded yet.", {
          status: 400,
          hint: "PUT the file to the signed URL from the create response first, then complete.",
          requestId,
        });
      }

      // §15.2: magic bytes, never the client-declared header. Verification
      // applies when the descriptor claims a sniffable image type, or when
      // the sniff CAUGHT an image the descriptor didn't declare (the classic
      // smuggle). Non-sniffable declared types (video/audio/font/gif…) whose
      // head isn't recognisable pass — validate.ts is image-only and deep
      // verification is the worker wave's job (documented deferral).
      const sniffed = sniffMime(headBytes);
      const declaredSniffable = SNIFFABLE_IMAGE_MIMES.has(asset.mime);
      if (declaredSniffable || sniffed.ok) {
        if (!sniffed.ok || sniffed.mime !== asset.mime) {
          await rejectUpload(
            "ASSET_TYPE_MISMATCH",
            "The file content doesn't match its declared type.",
            "Upload the file under its true media type.",
          );
        }
        const dims = dimensions(headBytes);
        if (!dims.ok) {
          await rejectUpload(
            "ASSET_TYPE_MISMATCH",
            "The file content doesn't match its declared type.",
            "The image header could not be verified as well-formed.",
          );
        }
        // §20.2 bomb ceiling, enforced from header dimensions alone (the
        // lib never inflates pixels): a >60 MP image is refused. The ok-arm
        // guard is structural — the !ok arm never returns from above.
        if (dims.ok && dims.megapixels > DEFAULT_MAX_UPLOAD_MEGAPIXELS) {
          await rejectUpload(
            "ASSET_REJECTED",
            "This image exceeds the resolution ceiling.",
            "Images are capped at 60 megapixels.",
          );
        }
        // Back-fill the server-probed dimensions — header-parsed truth wins
        // over client-declared values (§12.3 probe).
        await deps.repos.assets.recordProbe(workspace.id, asset.id, {
          width: dims.ok ? dims.width : null,
          height: dims.ok ? dims.height : null,
        });
      }

      // Complete-time dedupe (race-proofing the descriptor-time check):
      // a concurrent upload of the same content slipped past the earlier
      // bySha256 lookup. The new ROW is removed (the freshly PUT bytes stay
      // in object storage — §9.2 orphans are lifecycle-reclaimed; deleting
      // them is deliberately NOT our call) and the canonical row is returned.
      const twin = await deps.repos.assets.bySha256(workspace.id, asset.sha256, asset.id);
      if (twin !== null && dedupeScopeCompatible(twin.projectId, asset.projectId)) {
        await deps.repos.assets.remove(workspace.id, asset.id);
        await audit(deps, c, workspace.id, "asset.deduped", twin.id, {
          mime: twin.mime,
        });
        const body: VerifyAssetResponse = { asset: toDto(twin), duplicate: true };
        return ok(c, body);
      }

      const verified = await deps.repos.assets.get(workspace.id, asset.id);
      await audit(deps, c, workspace.id, "asset.verified", verified.id, {
        mime: verified.mime,
      });
      const body: VerifyAssetResponse = { asset: toDto(verified), duplicate: false };
      return ok(c, body);
    },
  );

  return app;
}
