// @studio/contracts — /v1/workspaces (PRODUCT_ARCHITECTURE.md §7.2, §7.1).

import { z } from "zod";

import { type Id, type Role } from "./common.js";

/** Slug: lowercase alnum + inner hyphens, 1-64 chars (URL-safe). */
export const WORKSPACE_SLUG_SCHEMA = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "must be url-safe lowercase");

export const WORKSPACE_NAME_SCHEMA = z.string().min(1).max(100);

/** `POST /v1/workspaces` body. */
export const CREATE_WORKSPACE_SCHEMA = z.strictObject({
  name: WORKSPACE_NAME_SCHEMA,
  slug: WORKSPACE_SLUG_SCHEMA,
});

export type CreateWorkspaceRequest = z.infer<typeof CREATE_WORKSPACE_SCHEMA>;

const PATCH_WORKSPACE_SHAPE = {
  name: WORKSPACE_NAME_SCHEMA.optional(),
  slug: WORKSPACE_SLUG_SCHEMA.optional(),
} as const;

/** `PATCH /v1/workspaces/:id` body — at least one field required. */
export const PATCH_WORKSPACE_SCHEMA = z
  .strictObject(PATCH_WORKSPACE_SHAPE)
  .refine(
    (body) => body.name !== undefined || body.slug !== undefined,
    "at least one of name or slug is required",
  );

export type PatchWorkspaceRequest = z.infer<typeof PATCH_WORKSPACE_SCHEMA>;

/** Workspace row (§7.2 list/get). */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One roster row of `GET /v1/workspaces/:id` (W5-09): a lighter member view
 * than routes/members.ts `Member` — the detail read carries no status,
 * activity or isCurrentUser flags, just the roster facts better-auth already
 * resolved for the workspace context (name/email null until the user sets
 * them).
 */
export interface WorkspaceMemberSummary {
  readonly userId: Id;
  readonly role: Role;
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * `GET /v1/workspaces/:id` response (W5-09): the workspace row plus the
 * CALLER's role in it and the full roster (the gateway's resolveWorkspaceContext
 * shape). Tenant law (§12.1): a workspace the caller does not belong to reads
 * as 404, never 403.
 */
export interface WorkspaceDetail extends Workspace {
  /** The calling user's role in this workspace. */
  readonly role: Role;
  readonly members: readonly WorkspaceMemberSummary[];
}
