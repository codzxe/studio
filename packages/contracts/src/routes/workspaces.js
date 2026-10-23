// @studio/contracts — /v1/workspaces (PRODUCT_ARCHITECTURE.md §7.2, §7.1).
import { z } from "zod";
import { ID_SCHEMA } from "./common.js";
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
const PATCH_WORKSPACE_SHAPE = {
    name: WORKSPACE_NAME_SCHEMA.optional(),
    slug: WORKSPACE_SLUG_SCHEMA.optional(),
};
/** `PATCH /v1/workspaces/:id` body — at least one field required. */
export const PATCH_WORKSPACE_SCHEMA = z
    .strictObject(PATCH_WORKSPACE_SHAPE)
    .refine((body) => body.name !== undefined || body.slug !== undefined, "at least one of name or slug is required");
//# sourceMappingURL=workspaces.js.map