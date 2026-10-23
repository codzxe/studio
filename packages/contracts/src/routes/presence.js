// @studio/contracts — presence (PRODUCT_ARCHITECTURE.md §7.2, §9.1
// `presence_heartbeats`, §11; BUILD_PLAN §M7 task 2).
//
// Who is viewing, active comp, playhead; heartbeat. **NO cursor co-editing.**
//
// HARD SCOPE LINE (BUILD_PLAN §M7 task 2, PRODUCT_ARCHITECTURE.md §11):
// presence v1 carries who-is-viewing + the active composition + the playhead
// ONLY. There is no cursor/mouse/selection telemetry, and the beat body is a
// `z.strictObject` — unknown keys (`cursorX`, `mouse`, `selection`, …) are
// REJECTED at the boundary, so co-editing telemetry can never creep in
// silently. Widening this surface requires a DECISIONS.md ruling plus a
// deliberate schema change in this file.
//
// Wire (gateway `routes/presence.ts`):
//   POST /v1/projects/:id/presence  — upsert my heartbeat, respond with the
//                                     active viewers AFTER the upsert (the
//                                     heartbeat IS the poll; no SSE in v1).
//   GET  /v1/projects/:id/presence  — the active viewers list (no write).
//
// Persistence (M7-E, migration 0004): `presence_heartbeats`
// {project_id, user_id, display_name, comp_id, playhead_ticks, last_seen_at}
// with PK (project_id, user_id) — one row per (project, user); a repeat beat
// upserts (newest wins), so a retried beat can never create a duplicate row.
import { z } from "zod";
import { ID_SCHEMA } from "./common.js";
import { LEASE_HEARTBEAT_MS } from "./leases.js";
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
export const PRESENCE_TTL_MS = LEASE_HEARTBEAT_MS * 2; // 240_000 (4 minutes)
/** Active comp id as sent by the editor: opaque, bounded (≤ 120 chars). */
export const PRESENCE_COMP_ID_SCHEMA = z.string().min(1).max(120);
/** Playhead in engine ticks: integer ≥ 0, ≤ 36_000_000 (BUILD_PLAN bound). */
export const PRESENCE_PLAYHEAD_TICKS_MAX = 36_000_000;
export const PRESENCE_PLAYHEAD_TICKS_SCHEMA = z
    .number()
    .int()
    .min(0)
    .max(PRESENCE_PLAYHEAD_TICKS_MAX);
/** Per-tab beat nonce: opaque, ≤ 64 chars. See PRESENCE_BEAT_SCHEMA. */
export const PRESENCE_CLIENT_NONCE_SCHEMA = z.string().min(1).max(64);
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
export const PRESENCE_BEAT_SCHEMA = z.strictObject({
    compId: PRESENCE_COMP_ID_SCHEMA.optional(),
    playheadTicks: PRESENCE_PLAYHEAD_TICKS_SCHEMA.optional(),
    clientNonce: PRESENCE_CLIENT_NONCE_SCHEMA.optional(),
});
export const PRESENCE_VIEWER_SCHEMA = z.object({
    userId: ID_SCHEMA,
    displayName: z.string(),
    compId: PRESENCE_COMP_ID_SCHEMA.nullable(),
    playheadTicks: PRESENCE_PLAYHEAD_TICKS_SCHEMA.nullable(),
    lastSeenAgoMs: z.number().int().min(0),
    self: z.boolean(),
});
// Response schemas STRIP unknown keys (§7.2 forward compatibility — the api
// client reuses these to runtime-validate gateway responses); only the beat
// BODY is strict (the no-cursor scope pin).
export const PRESENCE_VIEWERS_SCHEMA = z.object({
    viewers: z.array(PRESENCE_VIEWER_SCHEMA),
});
//# sourceMappingURL=presence.js.map