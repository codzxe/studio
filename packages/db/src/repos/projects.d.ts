import { type Page } from "../cursor.js";
import type { StudioDb, StudioTx } from "../db.js";
import { type Project, type ProjectVersion } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
/**
 * Projects repository — tenant-scoped (§12.1): every method filters by
 * workspaceId; cross-tenant ids read as NOT_FOUND. Signed URLs are NOT built
 * here — the manifest returns `objectKey`s only; the gateway signs.
 */
export interface ProjectCreateInput {
    readonly name: string;
    readonly slug?: string;
    readonly description?: string;
    readonly thumbnailUrl?: string;
    readonly createdBy: string;
}
export interface ProjectPatchInput {
    readonly name?: string;
    readonly description?: string;
    readonly thumbnailUrl?: string;
}
export interface ProjectListOptions {
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly includeDeleted?: boolean;
}
export interface AssetManifestEntry {
    readonly id: string;
    readonly projectId: string | null;
    readonly name: string;
    readonly mime: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly objectKey: string;
    readonly width: number | null;
    readonly height: number | null;
    readonly durationTicks: number | null;
}
export interface ProjectManifest {
    readonly project: Project;
    readonly currentVersion: ProjectVersion | null;
    readonly assets: readonly AssetManifestEntry[];
}
export interface ProjectsRepo {
    create(workspaceId: WorkspaceId, input: ProjectCreateInput): Promise<Project>;
    list(workspaceId: WorkspaceId, options?: ProjectListOptions): Promise<Page<Project>>;
    get(workspaceId: WorkspaceId, projectId: string, options?: {
        includeDeleted?: boolean;
    }): Promise<Project>;
    patch(workspaceId: WorkspaceId, projectId: string, input: ProjectPatchInput): Promise<Project>;
    softDelete(workspaceId: WorkspaceId, projectId: string): Promise<Project>;
    manifest(workspaceId: WorkspaceId, projectId: string): Promise<ProjectManifest>;
}
/** Lock a project row in a transaction (single-writer / version-advance path). */
export declare function lockProject(tx: StudioTx, workspaceId: WorkspaceId, projectId: string): Promise<Project>;
export declare function createProjectsRepo(db: StudioDb): ProjectsRepo;
