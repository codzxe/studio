import { z } from "zod";
/** Slug: lowercase alnum + inner hyphens, 1-64 chars (URL-safe). */
export declare const WORKSPACE_SLUG_SCHEMA: z.ZodString;
export declare const WORKSPACE_NAME_SCHEMA: z.ZodString;
/** `POST /v1/workspaces` body. */
export declare const CREATE_WORKSPACE_SCHEMA: z.ZodObject<{
    name: z.ZodString;
    slug: z.ZodString;
}, z.core.$strict>;
export type CreateWorkspaceRequest = z.infer<typeof CREATE_WORKSPACE_SCHEMA>;
/** `PATCH /v1/workspaces/:id` body — at least one field required. */
export declare const PATCH_WORKSPACE_SCHEMA: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    slug: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type PatchWorkspaceRequest = z.infer<typeof PATCH_WORKSPACE_SCHEMA>;
/** Workspace row (§7.2 list/get). */
export interface Workspace {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}
