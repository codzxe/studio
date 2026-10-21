// @studio/gateway — /v1/assets (§7.2, §9.1, §9.2, §12.3): two-phase upload —
// POST a descriptor, PUT the bytes to the returned signed URL. v1 accepts
// client-declared sha256+size and trusts object-storage HEAD on read
// (verify-by-head lands with the worker wave).

import { Hono } from "hono";

import {
  CREATE_ASSET_SCHEMA,
  PAGINATION_QUERY_SCHEMA,
  type Asset as AssetDto,
  type CreateAssetResponse,
} from "@studio/contracts";

import { ok, page, pathParam } from "../http.js";
import { GatewayError } from "../errors.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { SIGNED_URL_TTL_SECONDS } from "../signing.js";
import { assetKey, sanitizeName } from "../storage.js";
import { audit } from "./projects.js";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { createId, type Asset } from "@studio/db";

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

  app.get("/v1/assets/:id/url", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const asset = await deps.repos.assets.get(c.get("workspace").id, pathParam(c, "id"));
    const signed = await deps.storage.getSignedUrl(asset.objectKey, SIGNED_URL_TTL_SECONDS, { method: "GET" });
    return ok(c, { url: signed.url, expiresAt: signed.expiresAt.toISOString() });
  });

  return app;
}
