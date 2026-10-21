// @studio/contracts — /v1/projects (PRODUCT_ARCHITECTURE.md §7.2, §9.1),
// including the manifest response (current version + asset manifest + signed URLs).

import { z } from "zod";

import type { Id } from "./common.js";

export const PROJECT_NAME_SCHEMA = z.string().min(1).max(120);

export const PROJECT_DESCRIPTION_SCHEMA = z.string().max(2000);

/** `POST /v1/projects` body. */
export const CREATE_PROJECT_SCHEMA = z.strictObject({
  name: PROJECT_NAME_SCHEMA,
  description: PROJECT_DESCRIPTION_SCHEMA.optional(),
});

export type CreateProjectRequest = z.infer<typeof CREATE_PROJECT_SCHEMA>;

/** `PATCH /v1/projects/:id` body — at least one field required. */
export const PATCH_PROJECT_SCHEMA = z
  .strictObject({
    name: PROJECT_NAME_SCHEMA.optional(),
    description: PROJECT_DESCRIPTION_SCHEMA.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.description !== undefined,
    "at least one of name or description is required",
  );

export type PatchProjectRequest = z.infer<typeof PATCH_PROJECT_SCHEMA>;

/** `DELETE /v1/projects/:id` is a soft delete (§9.1 `deleted_at`); no body. */
export const DELETE_PROJECT_SCHEMA = z.strictObject({});

/** Project row (§9.1 `projects`). */
export interface Project {
  readonly id: Id;
  readonly workspaceId: Id;
  readonly name: string;
  readonly slug: string;
  readonly thumbnailUrl: string | null;
  readonly currentVersionId: Id | null;
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** Signed, short-lived (5-15 min, §9.2) download URL + metadata. */
export interface SignedUrl {
  readonly url: string;
  readonly method: "GET" | "PUT" | "POST";
  readonly expiresAt: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Manifest asset entry: names/types/dimensions only — never bytes or raw paths (§8.3). */
export interface ManifestAsset {
  readonly id: Id;
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationTicks: number | null;
  readonly url: string;
}

/** `GET /v1/projects/:id/manifest` (§7.2): current version + assets + signed URLs. */
export interface ProjectManifest {
  readonly projectId: Id;
  readonly currentVersion: {
    readonly id: Id;
    readonly version: number;
    readonly sha256: string;
    readonly label: string | null;
    readonly sizeBytes: number;
    readonly createdAt: string;
    readonly url: string;
  } | null;
  readonly assets: readonly ManifestAsset[];
  readonly updatedAt: string;
}
