import { z } from "zod";
import type { Id } from "./common.js";
export declare const PROJECT_NAME_SCHEMA: z.ZodString;
export declare const PROJECT_DESCRIPTION_SCHEMA: z.ZodString;
/** `POST /v1/projects` body. */
export declare const CREATE_PROJECT_SCHEMA: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type CreateProjectRequest = z.infer<typeof CREATE_PROJECT_SCHEMA>;
/** `PATCH /v1/projects/:id` body — at least one field required. */
export declare const PATCH_PROJECT_SCHEMA: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type PatchProjectRequest = z.infer<typeof PATCH_PROJECT_SCHEMA>;
/** `DELETE /v1/projects/:id` is a soft delete (§9.1 `deleted_at`); no body. */
export declare const DELETE_PROJECT_SCHEMA: z.ZodObject<{}, z.core.$strict>;
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
