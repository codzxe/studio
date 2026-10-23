import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type Asset } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
/** Assets repository — workspace library + optional project scope (§9.1, §9.2). */
export interface AssetCreateInput {
    readonly projectId?: string | null;
    readonly name: string;
    readonly mime: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly objectKey: string;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly durationTicks?: number | null;
    readonly createdBy: string;
}
export interface AssetListOptions {
    readonly projectId?: string | null;
    readonly limit?: number;
    readonly cursor?: string | null;
}
export interface AssetQuota {
    readonly count: number;
    readonly totalBytes: number;
}
export interface AssetsRepo {
    create(workspaceId: WorkspaceId, input: AssetCreateInput): Promise<Asset>;
    list(workspaceId: WorkspaceId, options?: AssetListOptions): Promise<Page<Asset>>;
    get(workspaceId: WorkspaceId, assetId: string): Promise<Asset>;
    /** Dedupe lookup by content hash (§9.2 content-addressed). */
    bySha256(workspaceId: WorkspaceId, sha256: string): Promise<Asset | null>;
    quota(workspaceId: WorkspaceId): Promise<AssetQuota>;
}
export declare function createAssetsRepo(db: StudioDb): AssetsRepo;
