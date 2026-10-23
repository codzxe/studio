import type { StudioDb } from "../db.js";
import { type ShareToken } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
export interface ShareTokenIssueInput {
    readonly projectId: string;
    readonly createdBy: string;
    /** sha256(raw token), lowercase hex — minted by the calling route. */
    readonly tokenHash: string;
    /** Finished `scrypt$salt$hash` string; null/undefined = no password gate. */
    readonly passwordHash?: string | null;
    /** Whole days from now; null/undefined = never expires. */
    readonly expiresInDays?: number | null;
}
export interface ShareTokenRevokeInput {
    readonly id: string;
    /** Acting user (authorization is the route's job; recorded for the audit). */
    readonly byUserId: string;
}
/**
 * A share-token row WITHOUT secrets for member-facing lists — the raw token
 * does not exist anymore and the hash/password never leave the db package.
 */
export interface ShareTokenView {
    readonly id: string;
    readonly projectId: string;
    readonly createdBy: string;
    readonly createdAt: Date;
    readonly expiresAt: Date | null;
    readonly revokedAt: Date | null;
    readonly hasPassword: boolean;
}
/** Share token + the owning project/workspacae context resolved by hash. */
export interface ResolvedShare {
    readonly token: ShareToken;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly projectName: string;
}
export interface ShareTokensRepo {
    issue(workspaceId: WorkspaceId, input: ShareTokenIssueInput): Promise<ShareToken>;
    /** Public capability check scoped to a known project; revoked/expired → null. */
    verifyByHash(projectId: string, tokenHash: string): Promise<ShareToken | null>;
    /** Public capability check by hash alone (the share page knows only the token). */
    getByHash(tokenHash: string): Promise<ShareToken | null>;
    /** Public lookup + project/workspace resolution in one query. */
    resolveByHash(tokenHash: string): Promise<ResolvedShare | null>;
    /** Row + owning workspaceId by share-token id (for the authed revoke route). */
    findById(id: string): Promise<(ShareToken & {
        workspaceId: string;
    }) | null>;
    list(workspaceId: WorkspaceId, projectId: string): Promise<ShareTokenView[]>;
    revoke(workspaceId: WorkspaceId, input: ShareTokenRevokeInput): Promise<ShareToken>;
}
export declare function createShareTokensRepo(db: StudioDb): ShareTokensRepo;
