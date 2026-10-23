// @studio/contracts — /v1/projects (PRODUCT_ARCHITECTURE.md §7.2, §9.1),
// including the manifest response (current version + asset manifest + signed URLs).
import { z } from "zod";
export const PROJECT_NAME_SCHEMA = z.string().min(1).max(120);
export const PROJECT_DESCRIPTION_SCHEMA = z.string().max(2000);
/** `POST /v1/projects` body. */
export const CREATE_PROJECT_SCHEMA = z.strictObject({
    name: PROJECT_NAME_SCHEMA,
    description: PROJECT_DESCRIPTION_SCHEMA.optional(),
});
/** `PATCH /v1/projects/:id` body — at least one field required. */
export const PATCH_PROJECT_SCHEMA = z
    .strictObject({
    name: PROJECT_NAME_SCHEMA.optional(),
    description: PROJECT_DESCRIPTION_SCHEMA.optional(),
})
    .refine((body) => body.name !== undefined || body.description !== undefined, "at least one of name or description is required");
/** `DELETE /v1/projects/:id` is a soft delete (§9.1 `deleted_at`); no body. */
export const DELETE_PROJECT_SCHEMA = z.strictObject({});
//# sourceMappingURL=projects.js.map