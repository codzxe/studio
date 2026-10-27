// @studio/gateway — /v1/projects/:id/lease* (§7.2, §9.3, §11): the
// single-writer lease + the M7 lease UX (BUILD_PLAN §M7 task 3 — "Alex is
// editing" banner; request edit; release on close; expiry).
//
//   POST   /v1/projects/:id/lease          acquire or renew (same body)
//   DELETE /v1/projects/:id/lease          release — then elects the OLDEST
//                                          queued requester as the notified
//                                          next holder (takeover on close)
//   POST   /v1/projects/:id/lease-request  join the edit queue (dedupe per
//                                          user, cap 20 — typed QUOTA_EXCEEDED)
//   DELETE /v1/projects/:id/lease-request  leave the queue
//   GET    /v1/projects/:id/lease-state    THE banner endpoint: holder, queue,
//                                          youAre, canAcquire
//
// The loser of an acquire opens read-only until the lease is released or
// expires (2-min heartbeat, 5-min TTL from @studio/db lease-logic). Read-only
// enforcement itself lives in ../lease-guard.ts (D-23: chat stays allowed).
//
// Law #1: display names in human copy, never ids — unknown members render as
// "Someone" (memberDisplayName).

import { Hono } from "hono";

import { ACQUIRE_LEASE_SCHEMA, type LeaseQueueEntry } from "@studio/contracts";
import { leaseDecision } from "@studio/db";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { memberDisplayName } from "../lease-guard.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { audit } from "./projects.js";

export function leasesRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  app.post(
    "/v1/projects/:id/lease",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const parsed = ACQUIRE_LEASE_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Send the editor session id (8-128 chars) as sessionId.",
          requestId: c.get("requestId"),
        });
      }

      const result = await deps.repos.leases.acquire(workspace.id, pathParam(c, "id"), {
        userId: c.get("auth").user.id,
        sessionId: parsed.data.sessionId,
        ttlMs: deps.env.lease.ttlMs,
      });

      const holderName =
        result.holderId === c.get("auth").user.id
          ? c.get("auth").user.name
          : memberDisplayName(c, result.holderId);

      if (result.acquired) {
        await audit(deps, c, workspace.id, "lease.acquired", pathParam(c, "id"), {
          expiresAt: result.expiresAt.toISOString(),
        });
      }
      return ok(c, {
        acquired: result.acquired,
        holderName,
        expiresAt: result.expiresAt.toISOString(),
        // §9.3: a refused acquire means the caller opens read-only.
        readOnly: !result.acquired,
      });
    },
  );

  app.delete(
    "/v1/projects/:id/lease",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const result = await deps.repos.leases.release(workspace.id, projectId, {
        userId: c.get("auth").user.id,
      });

      // §M7 task 3 "release on close": a release hands the baton to the OLDEST
      // queued requester — they are the notified next holder and may acquire
      // instantly (the atomic upsert stays the single writer arbiter).
      let nextHolder: LeaseQueueEntry | null = null;
      if (result.released) {
        const elected = await deps.repos.leases.electNextHolder(workspace.id, projectId);
        if (elected !== null) {
          nextHolder = {
            userId: elected.userId,
            displayName: memberDisplayName(c, elected.userId),
            queuedAt: elected.queuedAt.toISOString(),
          };
        }
        await audit(deps, c, workspace.id, "lease.released", projectId, {
          nextHolderUserId: nextHolder?.userId ?? null,
        });
      }
      return ok(c, { released: result.released, nextHolder });
    },
  );

  app.post(
    "/v1/projects/:id/lease-request",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const result = await deps.repos.leases.queueRequest(workspace.id, {
        projectId,
        userId: c.get("auth").user.id,
      });
      await audit(deps, c, workspace.id, "lease.requested", projectId, {
        position: result.position,
        duplicate: result.duplicate,
      });
      return ok(c, {
        queued: result.queued,
        position: result.position,
        queueLength: result.queueLength,
        queuedAt: result.queuedAt.toISOString(),
        duplicate: result.duplicate,
      });
    },
  );

  app.delete(
    "/v1/projects/:id/lease-request",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const result = await deps.repos.leases.cancelRequest(workspace.id, {
        projectId,
        userId: c.get("auth").user.id,
      });
      if (result.cancelled) {
        await audit(deps, c, workspace.id, "lease.request_cancelled", projectId);
      }
      return ok(c, { cancelled: result.cancelled });
    },
  );

  app.get(
    "/v1/projects/:id/lease-state",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const projectId = pathParam(c, "id");
      const callerId = c.get("auth").user.id;
      const now = new Date();

      const snapshot = await deps.repos.leases.get(workspace.id, projectId);
      const queue = await deps.repos.leases.requestQueue(workspace.id, projectId);

      // §M7 task 3 "expiry": a lease row that has gone dead is observed HERE
      // (lazily — there is no sweeper): holder reads null, canAcquire turns
      // true, everyone sees the project is free. W3-b02 (w1-a26 S244): the
      // state poll is a PURE READ — it never elects. The old
      // electNextHolder-on-poll popped the OLDEST queued entry on EVERY GET,
      // so any viewer polling the banner drained the whole edit queue while
      // nobody acquired. Election happens only on real transitions: the
      // release path (DELETE /lease elects and pops) and the takeover itself
      // (acquire consumes the winner's own queue entry).

      const active = snapshot?.isHeld ? snapshot.lease : null;
      const holder =
        active === null
          ? null
          : {
              userId: active.userId,
              displayName: memberDisplayName(c, active.userId),
              // The row persists no tenure start: acquiredAt is DERIVED as the
              // start of the holder's current renewal window (expiresAt − TTL).
              // The banner's countdown must read expiresAt.
              acquiredAt: new Date(active.expiresAt.getTime() - deps.env.lease.ttlMs).toISOString(),
              expiresAt: active.expiresAt.toISOString(),
            };

      const queuedEntry = queue.find((entry) => entry.userId === callerId);
      const youAre =
        active !== null && active.userId === callerId
          ? "holder"
          : queuedEntry !== undefined
            ? "queued"
            : "viewer";

      // canAcquire: a POST /lease right now would win — free, expired, or
      // already ours (re-acquire renews). Same classifier the acquire path
      // uses, so the banner can never promise what the upsert would refuse.
      const canAcquire =
        leaseDecision(
          active === null ? null : { userId: active.userId, expiresAt: active.expiresAt },
          callerId,
          now,
        ).action === "acquire";

      return ok(c, {
        holder,
        queue: queue.map((entry) => ({
          userId: entry.userId,
          displayName: memberDisplayName(c, entry.userId),
          queuedAt: entry.queuedAt.toISOString(),
        })),
        youAre,
        canAcquire,
      });
    },
  );

  return app;
}
