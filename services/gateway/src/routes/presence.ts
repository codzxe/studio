// @studio/gateway — /v1/projects/:id/presence (§7.2, §9.1 `presence_heartbeats`,
// §11; BUILD_PLAN §M7 task 2): who is viewing, active comp, playhead.
//
// ═══════════════════════════════════════════════════════════════════════════
// WEB POLLING CADENCE — intended client recipe (documented only; the M7 web
// agent implements this in the editor SPA):
//
//   * While the editor tab is VISIBLE, beat every LEASE_HEARTBEAT_MS
//     (120s, from @studio/contracts): `client.presence.beatPresence(
//     projectId, { compId, playheadTicks, clientNonce })`. The beat response
//     IS the viewers poll — you learn who else is there in the same
//     round-trip; there is no SSE stream for presence in v1.
//   * On `visibilitychange` → hidden: PAUSE the heartbeat timer (no beats
//     while hidden — no fake "I'm here").
//   * On `visibilitychange` → visible: beat IMMEDIATELY, then resume the
//     interval. `pagehide`/`beforeunload` need no "leave" call in v1: your
//     heartbeat row goes stale on its own and the repo TTL sweep
//     (PRESENCE_TTL_MS, default LEASE_HEARTBEAT_MS × 2 = 240s) drops you
//     from everyone's list two missed beats later.
//   * A bare `{}` body is a valid beat: "still here, comp/playhead
//     unchanged" (the row keeps its last values).
//   * GET (client.presence.listPresence) is for surfaces that render the
//     list WITHOUT writing (read-only share view, hidden tab that still
//     wants to render): poll at the same 120s cadence or slower; it does
//     NOT refresh your own heartbeat.
//   * `clientNonce`: a per-tab random string (≤ 64 chars). Reuse the SAME
//     nonce only when retrying that same beat after a network blip — the
//     (project_id, user_id) PK makes the upsert idempotent, so a retried
//     beat never creates a duplicate row. Use a fresh nonce per new beat.
//   * Render "last seen" against lastSeenAgoMs; PRESENCE_TTL_MS
//     (@studio/contracts) is the horizon after which a viewer is swept
//     server-side and will stop appearing.
//
// ═══════════════════════════════════════════════════════════════════════════
// HARD SCOPE LINE (BUILD_PLAN §M7 task 2, PRODUCT_ARCHITECTURE.md §11):
// presence v1 is who-is-viewing + active comp + playhead ONLY. No cursor/
// mouse/selection telemetry. The beat body is PRESENCE_BEAT_SCHEMA — a Zod
// STRICT object — so unknown keys (`cursorX`, `mouse`, `selection`, …) are
// rejected at this boundary with VALIDATION_FAILED: co-editing telemetry can
// never creep in silently. Widening requires a DECISIONS.md ruling plus a
// deliberate contracts change (packages/contracts/src/routes/presence.ts).
//
// No audit entries: a heartbeat is ephemeral viewing telemetry, not a project
// mutation — auditing every beat would flood audit_log (§7.1 audit-on-
// mutation covers project-data mutations; presence rows are swept, not kept).
//
// Env: the effective sweep TTL is PRESENCE_TTL_MS (contracts default =
// LEASE_HEARTBEAT_MS × 2), overridable via the `PRESENCE_TTL_MS` process-env
// var (whole ms, ≥ 1000; invalid values fall back to the default). The
// gateway env module has no additive seam for it yet — @studio/config env.ts
// would need a 4-part ENV_VAR_SPECS + schema + grouped-interface change
// (config-owner task) — so the override is read directly here and handed to
// the repo sweep (`repos.presence` takes ttlMs per its pinned signature).

import { Hono } from "hono";

import { StudioError } from "@studio/config";
import { PRESENCE_BEAT_SCHEMA, PRESENCE_TTL_MS, type PresenceViewer } from "@studio/contracts";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { type RouteClass, createInMemoryRateLimiter } from "../rate-limit.js";

// Repo row shape, derived from the pinned Repos surface (the row type is not
// re-exported from the @studio/db main barrel — follow-up for the db owner:
// `export type { PresenceViewer }` there; deriving it keeps this route
// drift-proof against repos/presence.ts either way).
type PresenceViewerRow = Awaited<ReturnType<GatewayDeps["repos"]["presence"]["beat"]>>[number];

/**
 * Effective presence sweep horizon for this process (ms): the documented
 * `PRESENCE_TTL_MS` env override, else the contracts default (240s). Read
 * per call (cheap) so tests/processes can flip it without a rebuild.
 */
export function effectivePresenceTtlMs(): number {
  const raw = process.env.PRESENCE_TTL_MS;
  if (raw === undefined || raw.trim() === "") return PRESENCE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1000) return PRESENCE_TTL_MS;
  return parsed;
}

/** Caller's display name for the presence list (auth name → member list → neutral fallback). */
function displayNameFor(c: AppContext): string {
  const user = c.get("auth").user;
  if (user.name !== null && user.name !== "") return user.name;
  const member = c.get("workspace").members.find((entry) => entry.userId === user.id);
  return member?.userName ?? "Viewer";
}

/** Repo row → wire viewer: recency as `lastSeenAgoMs` + the caller's `self` flag. */
function toWireViewer(row: PresenceViewerRow, callerId: string, now: number): PresenceViewer {
  return {
    userId: row.userId,
    displayName: row.displayName,
    compId: row.compId,
    playheadTicks: row.playheadTicks,
    // Clock-skew guard: a row written "in the future" reports 0ms ago.
    lastSeenAgoMs: Math.max(0, now - new Date(row.lastSeenAt).getTime()),
    self: row.userId === callerId,
  };
}

export function presenceRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  // Per-USER beat bucket (in addition to the global per-IP route-class
  // middleware): reuses rate-limit.ts's in-memory limiter with the userId as
  // the bucket key — "mutation" class = 60/min/user. The heartbeat cadence
  // is 1 beat / 120s / visible tab, so this is ~120× headroom per tab while
  // still bounding a runaway client to 1 DB write/sec. Fresh per buildApp
  // call; single-instance posture (see rate-limit.ts's Valkey TODO).
  const beatLimiter = createInMemoryRateLimiter();
  const beatClass: RouteClass = "mutation";

  app.post(
    "/v1/projects/:id/presence",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const callerId = c.get("auth").user.id;

      // STRICT body (the no-cursor scope pin): unknown keys are rejected.
      const parsed = PRESENCE_BEAT_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Presence carries compId, playheadTicks and clientNonce only — no cursor or pointer data.",
          requestId: c.get("requestId"),
        });
      }

      const decision = beatLimiter.check(callerId, beatClass);
      if (!decision.allowed) {
        c.header("retry-after", String(decision.retryAfterSeconds));
        throw new StudioError("RATE_LIMITED", {
          requestId: c.get("requestId"),
          retryable: true,
        });
      }

      // The heartbeat IS the poll: upsert + sweep + return the survivors.
      const rows = await deps.repos.presence.beat(workspace.id, {
        projectId: pathParam(c, "id"),
        userId: callerId,
        displayName: displayNameFor(c),
        compId: parsed.data.compId ?? null,
        playheadTicks: parsed.data.playheadTicks ?? null,
        ttlMs: effectivePresenceTtlMs(),
      });

      const now = Date.now();
      return ok(c, { viewers: rows.map((row) => toWireViewer(row, callerId, now)) });
    },
  );

  app.get(
    "/v1/projects/:id/presence",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const callerId = c.get("auth").user.id;

      const rows = await deps.repos.presence.viewers(workspace.id, pathParam(c, "id"), {
        ttlMs: effectivePresenceTtlMs(),
      });

      const now = Date.now();
      return ok(c, { viewers: rows.map((row) => toWireViewer(row, callerId, now)) });
    },
  );

  return app;
}
