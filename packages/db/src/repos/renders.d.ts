import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type Render, type RenderStatus } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
/**
 * Renders repository — the Postgres-backed JOB QUEUE (§9.1, §M8).
 *
 * Status machine: queued → running → completed | failed | cancelled, plus the
 * M8-A crash-recovery `running → queued` requeue (legal ONLY from
 * `requeueStale`, guarded by attempts + heartbeat age — see statuses.ts).
 * Any illegal transition is a typed CONFLICT.
 *
 * Worker contract (the M8 worker wave codes against EXACTLY this interface):
 * - `claimNext` is the ONE trusted-internal, workspace-free entry point: the
 *   worker owns every workspace, so it must not be forced to name one up
 *   front. It claims with `SELECT … FOR UPDATE SKIP LOCKED` (safe under any
 *   number of concurrent workers), and every returned row carries its
 *   resolved `workspaceId` so all further calls (heartbeat / mark* / …) can
 *   stay workspace-first per the tenant-isolation law.
 * - Sweeps (`requeueStale`, `listExpiredOutputs`) are likewise internal and
 *   workspace-free; the retention sweep resolves workspaceId per row the same
 *   way claimNext does before calling `markOutputExpired`.
 *
 * Cancellation is cooperative: `requestCancel` only raises the
 * `cancel_requested` flag (idempotently, from queued or running). A queued
 * row keeps its status and is skipped at claim time; a running row is
 * observed by its worker, which terminal-transitions it (markCancelled).
 */
export interface RenderCreateInput {
    readonly projectId: string;
    /**
     * M8-A: the immutable project_versions.id this render is pinned to (§9.3) —
     * required; a queued job must never render "whatever is current later".
     */
    readonly versionId: string;
    readonly compId: string;
    readonly format: string;
    readonly settingsJson?: unknown;
    readonly credits?: number;
    readonly createdBy: string;
    /**
     * M8-G (additive): the §9.2 output key, pre-created by the gateway route at
     * QUEUE time so the worker never guesses key layout — it reads `objectKey`
     * off the row it claimed (renderKey(ws, pid, rid, ext) in the gateway's
     * storage.ts). The row id is generated INSIDE create(), so the route cannot
     * know it up front: pass the key with the literal `{renderId}` placeholder
     * in the id segment and create() resolves it against the fresh id. A string
     * WITHOUT the placeholder is stored verbatim (for callers that already own
     * the id); absent → NULL (M8-A callers and internal rows are unaffected).
     */
    readonly objectKey?: string;
}
export interface RenderListOptions {
    readonly projectId?: string;
    readonly status?: RenderStatus;
    readonly limit?: number;
    readonly cursor?: string | null;
}
/** Render row + the workspace it belongs to (resolved via projects). */
export interface ScopedRender extends Render {
    readonly workspaceId: WorkspaceId;
}
/** Progress payload for `heartbeat` — both fields optional, monotonic once set. */
export interface RenderHeartbeatInput {
    readonly framesDone?: number;
    readonly framesTotal?: number;
}
export interface RenderCompleteResult {
    readonly objectKey: string;
    /** M8-A: output size in bytes (retention/UX metadata). */
    readonly sizeBytes?: number;
    /** M8-A: when the downloadable output becomes ineligible (retention sweep). */
    readonly expiresAt?: Date;
}
export interface RenderFailResult {
    readonly error: string;
    /** M8-A: machine-readable code (e.g. RENDER_TIMEOUT, RENDER_INTERNAL). */
    readonly errorCode?: string;
}
export interface RenderClaimOptions {
    readonly limit?: number;
}
export interface RendersRepo {
    create(workspaceId: WorkspaceId, input: RenderCreateInput): Promise<Render>;
    markRunning(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
    markCompleted(workspaceId: WorkspaceId, renderId: string, result: RenderCompleteResult): Promise<Render>;
    markFailed(workspaceId: WorkspaceId, renderId: string, result: RenderFailResult): Promise<Render>;
    markCancelled(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
    get(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
    list(workspaceId: WorkspaceId, options?: RenderListOptions): Promise<Page<Render>>;
    /**
     * Claim up to `limit` queued renders for a worker (FIFO by created_at).
     * Rows with `cancel_requested` are skipped at claim time. Claimed rows flip
     * to running with started_at=now, heartbeat_at=now, attempts=attempts+1.
     * Trusted-internal (workspace-free by design); each returned row carries
     * its resolved workspaceId for all subsequent workspace-first calls.
     */
    claimNext(workerId: string, options?: RenderClaimOptions): Promise<ScopedRender[]>;
    /** Idempotent progress ping: bumps heartbeat_at; frames only ever advance. */
    heartbeat(workspaceId: WorkspaceId, renderId: string, progress?: RenderHeartbeatInput): Promise<Render>;
    /**
     * Cooperative cancel: raises `cancel_requested` (idempotent). Legal from
     * queued (row stays queued, skipped at claim time) or running (the worker
     * observes the flag and terminal-transitions). Terminal rows → CONFLICT.
     */
    requestCancel(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
    /**
     * Crash-recovery sweep (trusted-internal, workspace-free): running rows
     * whose heartbeat is older than `staleSeconds` go back to queued while
     * attempts < maxAttempts (the sanctioned running→queued transition;
     * cancel_requested is reset), otherwise they fail terminally with
     * error 'worker lost mid-render' / error_code RENDER_INTERNAL.
     * Returns the number of affected rows.
     */
    requeueStale(staleSeconds: number, maxAttempts: number): Promise<number>;
    /**
     * Retention sweep input (trusted-internal, workspace-free): completed rows
     * whose expires_at is before `before`, oldest first. After deleting the
     * stored object the sweeper calls `markOutputExpired` per row.
     */
    listExpiredOutputs(before: Date): Promise<ScopedRender[]>;
    /**
     * Marks the output of a completed render as deleted (retention). Clears
     * objectKey/expiresAt/sizeBytes but KEEPS the row as history; the API layer
     * treats a completed render with a missing objectKey as "expired".
     * Idempotent; non-completed rows → CONFLICT.
     */
    markOutputExpired(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
    /**
     * Honest output-seconds sum for the renderMinutesPerMonth quota:
     * Σ frames_total / frameRate over completed renders (completedAt >= since).
     * frameRate comes from settingsJson (RENDER_SETTINGS_SCHEMA); rows without
     * a usable frameRate or frames contribute 0 (documented fallback). The sum
     * may be fractional — the caller rounds for display/enforcement.
     */
    renderSecondsUsed(workspaceId: WorkspaceId, since: Date): Promise<number>;
    /** queued + running count for the per-workspace concurrency gate. */
    countActive(workspaceId: WorkspaceId): Promise<number>;
}
export declare function createRendersRepo(db: StudioDb): RendersRepo;
