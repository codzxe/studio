import type { StudioDb } from "../db.js";
import { type WorkspaceId } from "./shared.js";
/**
 * Presence repository — §M7 task 2: who is viewing, active comp, playhead.
 * Heartbeat upsert + TTL sweep; no cursor co-editing (out of scope by design).
 *
 * Ephemeral by contract: `beat` upserts the (project_id, user_id) row (one
 * row per viewer — a retried beat can never duplicate) and sweeps rows whose
 * `last_seen_at` is older than the TTL; `viewers` performs the same sweep and
 * returns the survivors. The sweep is per-project (other projects' rows are
 * never touched) and the TTL is a repo parameter so the gateway/tests can
 * tune it.
 *
 * TTL resolution (pinned by @studio/contracts routes/presence.ts, landed by
 * M7-B): explicit `ttlMs` param → else the `PRESENCE_TTL_MS` process-env var
 * (whole ms, ≥ 1000; read HERE at the sweep site because @studio/config's
 * env seam doesn't carry it yet) → else the documented default below, which
 * MUST equal contracts' `PRESENCE_TTL_MS` = LEASE_HEARTBEAT_MS × 2
 * (two missed 2-minute heartbeats and the viewer is gone). The db package
 * cannot import @studio/contracts — keep the values in sync deliberately.
 */
/** Documented default sweep window — MUST equal contracts' PRESENCE_TTL_MS. */
export declare const PRESENCE_TTL_MS = 240000;
/**
 * Repo-level viewer row. The GATEWAY presence route (M7-B) maps this onto the
 * wire `PresenceViewer` (contracts): `lastSeenAt` becomes `lastSeenAgoMs` and
 * the route stamps `self` on the caller's own entry — the repo is
 * caller-agnostic on purpose.
 */
export interface PresenceViewer {
    readonly userId: string;
    readonly displayName: string;
    readonly compId: string | null;
    readonly playheadTicks: number | null;
    /** ISO-8601 timestamp of the viewer's last heartbeat. */
    readonly lastSeenAt: string;
}
export interface PresenceBeatInput {
    readonly projectId: string;
    readonly userId: string;
    readonly displayName: string;
    readonly compId?: string | null;
    readonly playheadTicks?: number | null;
    /** Sweep window override (ms); default = env PRESENCE_TTL_MS / 240s. */
    readonly ttlMs?: number | null;
}
export interface PresenceViewersOptions {
    readonly ttlMs?: number | null;
}
export interface PresenceRepo {
    /** Upsert this user's heartbeat, sweep stale rows, return live viewers. */
    beat(workspaceId: WorkspaceId, input: PresenceBeatInput): Promise<PresenceViewer[]>;
    /** Sweep stale rows and return the project's live viewers. */
    viewers(workspaceId: WorkspaceId, projectId: string, options?: PresenceViewersOptions): Promise<PresenceViewer[]>;
}
export declare function createPresenceRepo(db: StudioDb): PresenceRepo;
