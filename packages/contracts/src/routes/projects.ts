// @studio/contracts — /v1/projects (PRODUCT_ARCHITECTURE.md §7.2, §9.1),
// including the manifest response (current version + asset manifest + signed URLs).
//
// W1-c additions (AUD-1 gaps #4/#5/#6): the PATCH-able `archived` lifecycle
// flag (§9.1 — orthogonal to the deleted_at soft delete), the `archived` list
// filter (default EXCLUDES archived), and POST /v1/projects/:id/duplicate
// (copies the project + its current version snapshot as "<name> (copy)";
// response = the new Project row, 201; no body; respects the plan's
// maxProjects quota with 429 QUOTA_EXCEEDED).

import { z } from "zod";

import { type Id, PAGINATION_QUERY_SCHEMA } from "./common.js";

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
    // §9.1 lifecycle toggle (W1-c): archived projects stay readable (GET,
    // manifest, versions) and drop out of the default list view.
    archived: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined || body.description !== undefined || body.archived !== undefined,
    "at least one of name, description or archived is required",
  );

export type PatchProjectRequest = z.infer<typeof PATCH_PROJECT_SCHEMA>;

/**
 * `GET /v1/projects` query (W1-c): pagination plus the `archived` filter.
 * Omitted/false → exclude archived projects (the default view);
 * true → ONLY archived projects.
 */
export const PROJECTS_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA.extend({
  archived: z.boolean().optional(),
});

export type ProjectsQuery = z.input<typeof PROJECTS_QUERY_SCHEMA>;

/** `DELETE /v1/projects/:id` is a soft delete (§9.1 `deleted_at`); no body. */
export const DELETE_PROJECT_SCHEMA = z.strictObject({});

/** Project row (§9.1 `projects`). */
export interface Project {
  readonly id: Id;
  readonly workspaceId: Id;
  readonly name: string;
  readonly slug: string;
  readonly thumbnailUrl: string | null;
  /** §9.1 lifecycle flag (W1-c): archived ≠ deleted — rows stay readable. */
  readonly archived: boolean;
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

/**
 * `POST /v1/projects/:id/duplicate` (W1-c, §9.1): copies the project and its
 * CURRENT version snapshot into a new project named "<name> (copy)". No body;
 * the response is the new `Project` row (201). Cross-tenant ids are 404
 * (§12.1) and a workspace at its plan's maxProjects cap gets 429
 * QUOTA_EXCEEDED. The copy starts unarchived with no versions when the
 * source has none; project-scoped assets are NOT re-linked in v1 (the
 * workspace library travels with the workspace and stays visible).
 */
export type DuplicateProjectResponse = Project;
