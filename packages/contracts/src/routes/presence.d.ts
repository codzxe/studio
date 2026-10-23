import { z } from "zod";
import { type Id } from "./common.js";
/**
 * Stale-sweep horizon: a viewer whose heartbeat is older than this stops
 * appearing in the viewers list (the sweep happens in the repo query —
 * `repos.presence.beat/viewers` in @studio/db — per the pinned M7-E
 * signature).
 *
 * Default = LEASE_HEARTBEAT_MS × 2 (BUILD_PLAN §M7 task 2): two missed
 * 2-minute heartbeats and you are gone. Deployments may override it with the
 * `PRESENCE_TTL_MS` process-env var (whole ms, ≥ 1000) — @studio/config's
 * env.ts has no additive seam for it yet (a 4-edit ENV_VAR_SPECS + schema +
 * grouped-interface change owned by the config owner), so the override is
 * read directly at the sweep site and this constant is the documented
 * default. The web client imports this value to render "last seen" states
 * consistently with what the server will sweep.
 */
export declare const PRESENCE_TTL_MS: number;
/** Active comp id as sent by the editor: opaque, bounded (≤ 120 chars). */
export declare const PRESENCE_COMP_ID_SCHEMA: z.ZodString;
/** Playhead in engine ticks: integer ≥ 0, ≤ 36_000_000 (BUILD_PLAN bound). */
export declare const PRESENCE_PLAYHEAD_TICKS_MAX = 36000000;
export declare const PRESENCE_PLAYHEAD_TICKS_SCHEMA: z.ZodNumber;
/** Per-tab beat nonce: opaque, ≤ 64 chars. See PRESENCE_BEAT_SCHEMA. */
export declare const PRESENCE_CLIENT_NONCE_SCHEMA: z.ZodString;
/**
 * `POST /v1/projects/:id/presence` body — STRICT: unknown keys are rejected
 * (the no-cursor scope pin). All fields optional: a bare `{}` beat means
 * "still here, context unchanged" (the row keeps its last comp/playhead).
 *
 * `clientNonce` is a client-side retry marker: it is validated but never
 * persisted (the table has no nonce column) — server-side dedup is inherent
 * in the (project_id, user_id) PK upsert, so the same nonce replayed within a
 * minute (or ever) cannot create a duplicate row. Tabs send a fresh nonce per
 * beat and reuse it only when retrying that same beat after a network blip.
 */
export declare const PRESENCE_BEAT_SCHEMA: z.ZodObject<{
    compId: z.ZodOptional<z.ZodString>;
    playheadTicks: z.ZodOptional<z.ZodNumber>;
    clientNonce: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type PresenceBeatRequest = z.input<typeof PRESENCE_BEAT_SCHEMA>;
/**
 * One active viewer on the wire. Every entry carries `self` — the gateway
 * sets `self: true` on the caller's own entry (the repo layer is
 * caller-agnostic); others carry the viewing context + recency.
 */
export interface PresenceViewer {
    readonly userId: Id;
    /** Display name resolved by the gateway from the auth user / member list. */
    readonly displayName: string;
    /** Active composition id, or null when the viewer has not reported one. */
    readonly compId: string | null;
    /** Playhead in engine ticks, or null when the viewer has not reported one. */
    readonly playheadTicks: number | null;
    /** Milliseconds since this viewer's last heartbeat (≥ 0, always fresh —
     * stale entries are swept before the list is built). */
    readonly lastSeenAgoMs: number;
    /** `true` on the caller's own entry. */
    readonly self: boolean;
}
export declare const PRESENCE_VIEWER_SCHEMA: z.ZodObject<{
    userId: z.ZodString;
    displayName: z.ZodString;
    compId: z.ZodNullable<z.ZodString>;
    playheadTicks: z.ZodNullable<z.ZodNumber>;
    lastSeenAgoMs: z.ZodNumber;
    self: z.ZodBoolean;
}, z.core.$strip>;
/** Response of BOTH `POST` (after the upsert) and `GET /v1/projects/:id/presence`. */
export interface PresenceViewersResponse {
    readonly viewers: readonly PresenceViewer[];
}
export declare const PRESENCE_VIEWERS_SCHEMA: z.ZodObject<{
    viewers: z.ZodArray<z.ZodObject<{
        userId: z.ZodString;
        displayName: z.ZodString;
        compId: z.ZodNullable<z.ZodString>;
        playheadTicks: z.ZodNullable<z.ZodNumber>;
        lastSeenAgoMs: z.ZodNumber;
        self: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
