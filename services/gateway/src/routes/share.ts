// @studio/gateway — share links (§7.2, §9.1 `share_tokens`; BUILD_PLAN §M7
// task 5): the public /s/:token review surface + the authed issue/list/revoke.
//
// Two routers in ONE file (mounted at different points of app.ts):
//   sharePublicRoutes — /v1/share/* — NO auth middleware: the token (or
//     token + x-share-password) IS the capability. Mounted BEFORE the
//     idempotency middleware so anonymous POSTs (guest comments via the
//     pinned M7-A handler, request-access) never require an Idempotency-Key
//     header — browsers on a share page don't send one; the routes enforce
//     their own per-IP fixed windows + password gates instead.
//   shareAuthedRoutes — POST/GET /v1/projects/:id/share-links +
//     DELETE /v1/share/:id — member surface, mounted with the other authed
//     routes (issue goes through the idempotency middleware like every
//     §7.2 mutation; a replay re-returns the SAME raw token, which is the
//     correct once-only mint: a retry must never mint a second token).
//
// SECURITY PINS (§M7 task 5, §12.1):
// - The raw token is minted here (node:crypto randomBytes → base64url),
//   hashed with sha256, stored ONLY as the hash, returned exactly once.
// - Password gates are enforced on manifest + comments (GET and POST) via
//   the `x-share-password` header; verification is scrypt (format
//   `scrypt$salt$hash` produced at issue time, node:crypto — no external
//   crypto deps), timing-safe compared, and per-IP throttled.
// - The public manifest carries NO internal ids; anonymous visitors get the
//   web player surface, never the editor (v1).
// - Cross-tenant/unknown ids are 404s everywhere (§12.1).

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import {
  ISSUE_SHARE_LINK_SCHEMA,
  REQUEST_ACCESS_SCHEMA,
  SHARE_COMMENTS_QUERY_SCHEMA,
  SHARE_GUEST_COMMENT_LIMIT_PER_MIN,
  SHARE_PASSWORD_ATTEMPT_LIMIT_PER_MIN,
  SHARE_PASSWORD_HEADER,
  SHARE_REQUEST_ACCESS_LIMIT_PER_MIN,
  SHARE_TOKEN_PATH_SCHEMA,
  type ShareComment,
  type ShareInfo,
  type ShareLinkIssued,
  type ShareLinkView,
  type ShareManifest,
  type ShareManifestAsset,
} from "@studio/contracts";

import type { Comment, ShareToken } from "@studio/db";
import { StudioError } from "@studio/config";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { clientIp, requireAuth, requireWorkspace, resolveWorkspaceContext } from "../middleware.js";
import { SIGNED_URL_TTL_SECONDS } from "../signing.js";
import { createGuestComment } from "./comments.js";
import { audit } from "./projects.js";

// ---------------------------------------------------------------------------
// Token minting + password hashing (node:crypto only)
// ---------------------------------------------------------------------------

/** Mint a raw share token: 256-bit random, base64url (43 url-safe chars). */
function mintShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256(raw token), lowercase hex — the ONLY material the repo stores. */
function hashShareToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** scrypt key length in bytes (64 → 128 hex chars in the stored string). */
const SCRYPT_KEYLEN = 64;

/** `scrypt$<saltHex(32)>$<hashHex(128)>` — the format the repo validates. */
function scryptPasswordHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Timing-safe password verification against the stored `scrypt$salt$hash`.
 * Returns false for a malformed stored string (never throws) so a corrupt
 * row reads as "wrong password", not a 500.
 */
function verifySharePassword(supplied: string | undefined, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1] ?? "", "hex");
  const expected = Buffer.from(parts[2] ?? "", "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = scryptSync(supplied ?? "", salt, expected.length);
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Per-IP fixed windows (guest abuse limits, §M7 task 1/5)
// ---------------------------------------------------------------------------

interface FixedWindow {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Minimal fixed-window limiter, keyed per (name, ip): at most `limit` hits
 * per rolling `windowMs`. Fresh per app instance (created inside the router
 * factory → per-process, per-test-file isolation); the global
 * rateLimitMiddleware still runs first with its coarser buckets.
 */
function createFixedWindowLimiter(window: FixedWindow) {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  return {
    check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
      const existing = buckets.get(key);
      if (existing === undefined || now - existing.windowStart >= window.windowMs) {
        buckets.set(key, { count: 1, windowStart: now });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (existing.count < window.limit) {
        existing.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const waitedMs = existing.windowStart + window.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitedMs / 1000)) };
    },
  };
}

const MINUTE_MS = 60_000;

/** Unknown/revoked/expired share id or token → the §12.1 404 (typed never). */
function shareNotFound(c: AppContext): never {
  throw new GatewayError("NOT_FOUND", "Not found.", {
    status: 404,
    hint: "This share link doesn't exist, expired, or was revoked.",
    requestId: c.get("requestId"),
  });
}

// ---------------------------------------------------------------------------
// PUBLIC router — /v1/share/*
// ---------------------------------------------------------------------------

export function sharePublicRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  const guestCommentLimiter = createFixedWindowLimiter({
    limit: SHARE_GUEST_COMMENT_LIMIT_PER_MIN,
    windowMs: MINUTE_MS,
  });
  const passwordLimiter = createFixedWindowLimiter({
    limit: SHARE_PASSWORD_ATTEMPT_LIMIT_PER_MIN,
    windowMs: MINUTE_MS,
  });
  const requestAccessLimiter = createFixedWindowLimiter({
    limit: SHARE_REQUEST_ACCESS_LIMIT_PER_MIN,
    windowMs: MINUTE_MS,
  });

  /** Resolve + gate the token. Unknown/revoked/expired → 404 (§12.1). */
  async function resolveShare(c: AppContext) {
    const raw = pathParam(c, "token");
    const parsed = SHARE_TOKEN_PATH_SCHEMA.safeParse(raw);
    if (!parsed.success) shareNotFound(c);
    const resolved = await deps.repos.shareTokens.resolveByHash(hashShareToken(raw));
    if (resolved === null) shareNotFound(c);
    return resolved;
  }

  /** Throw the typed 429 (with Retry-After) — mirrors rateLimitMiddleware. */
  function rateLimited(c: AppContext, retryAfterSeconds: number): never {
    c.header("retry-after", String(retryAfterSeconds));
    throw new StudioError("RATE_LIMITED", {
      requestId: c.get("requestId"),
      retryable: true,
    });
  }

  /**
   * Password gate for protected tokens: the header must verify. Missing and
   * wrong are the SAME 401 (no oracle); attempts count against a per-IP
   * window BEFORE the comparison so brute force can't outrun the throttle.
   */
  async function gatePassword(c: AppContext, token: ShareToken): Promise<void> {
    if (token.passwordHash === null) return; // open link
    const ip = clientIp(c);
    const decision = passwordLimiter.check(ip);
    if (!decision.allowed) rateLimited(c, decision.retryAfterSeconds);
    if (!verifySharePassword(c.req.header(SHARE_PASSWORD_HEADER), token.passwordHash)) {
      throw new GatewayError("AUTH_REQUIRED", "This share link is protected.", {
        status: 401,
        hint: `Enter the share password and send it in the ${SHARE_PASSWORD_HEADER} header.`,
        requestId: c.get("requestId"),
      });
    }
  }

  // GET /v1/share/:token — metadata only, never content (§M7 task 5).
  app.get("/v1/share/:token", async (c: AppContext): Promise<Response> => {
    const { token, projectId, projectName } = await resolveShare(c);
    const body: ShareInfo = {
      projectId,
      projectName,
      compId: null, // v1: a token shares the whole project
      expiresAt: token.expiresAt !== null ? token.expiresAt.toISOString() : null,
      hasPassword: token.passwordHash !== null,
      requestAccessEmail: null, // v1: the audit row IS the notification
    };
    return ok(c, body);
  });

  // GET /v1/share/:token/manifest — the web player's read surface.
  app.get("/v1/share/:token/manifest", async (c: AppContext): Promise<Response> => {
    const { token, workspaceId, projectId } = await resolveShare(c);
    await gatePassword(c, token);

    const manifest = await deps.repos.projects.manifest(workspaceId, projectId);
    let currentVersion: ShareManifest["currentVersion"] = null;
    if (manifest.currentVersion !== null) {
      const version = manifest.currentVersion;
      const signed = await deps.storage.getSignedUrl(version.objectKey, SIGNED_URL_TTL_SECONDS, {
        method: "GET",
      });
      currentVersion = {
        version: version.version,
        label: version.label,
        sizeBytes: version.sizeBytes,
        createdAt: version.createdAt.toISOString(),
        url: signed.url,
      };
    }
    const assets: ShareManifestAsset[] = await Promise.all(
      manifest.assets.map(async (asset): Promise<ShareManifestAsset> => {
        const signed = await deps.storage.getSignedUrl(asset.objectKey, SIGNED_URL_TTL_SECONDS, {
          method: "GET",
        });
        return {
          name: asset.name,
          mime: asset.mime,
          width: asset.width,
          height: asset.height,
          durationTicks: asset.durationTicks,
          url: signed.url,
        };
      }),
    );
    const body: ShareManifest = {
      currentVersion,
      assets,
      updatedAt: manifest.project.updatedAt.toISOString(),
    };
    return ok(c, body);
  });

  // GET /v1/share/:token/comments — public, id-stripped comment list.
  app.get("/v1/share/:token/comments", async (c: AppContext): Promise<Response> => {
    const { token, workspaceId, projectId } = await resolveShare(c);
    await gatePassword(c, token);

    const parsed = SHARE_COMMENTS_QUERY_SCHEMA.safeParse({
      compId: c.req.query("compId"),
      resolved: c.req.query("resolved"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Check the query parameters.",
        requestId: c.get("requestId"),
      });
    }
    const result = await deps.repos.comments.listThreaded(workspaceId, projectId, {
      compId: parsed.data.compId,
      resolved: parsed.data.resolved,
      cursor: parsed.data.cursor ?? null,
      limit: parsed.data.limit,
    });
    return page(c, result.items.map(toShareComment), result.nextCursor);
  });

  // POST /v1/share/:token/comments — guest comment via M7-A's pinned handler
  // (body validation + repo insert + audit live THERE); this route adds the
  // tighter §M7 5/min per-IP window on top of the handler's own bucket and
  // re-maps the 201 body onto the PUBLIC ShareComment shape (the handler's
  // DTO is member-shaped — authorId/guestEmail/resolvedBy must NOT reach an
  // anonymous reviewer; failures throw and bubble to onError untouched).
  const guestHandler = createGuestComment(deps);
  app.post("/v1/share/:token/comments", async (c: AppContext): Promise<Response> => {
    const { token, workspaceId, projectId } = await resolveShare(c);
    await gatePassword(c, token);

    const decision = guestCommentLimiter.check(clientIp(c));
    if (!decision.allowed) rateLimited(c, decision.retryAfterSeconds);

    const result = await guestHandler(c, {
      workspaceId,
      projectId,
      shareTokenId: token.id,
    });
    if (result.status !== 201) return result;
    // The handler's 201 DTO is member-shaped; pick ONLY the public fields
    // (no authorId, no guestEmail, no resolvedBy — never to a stranger).
    const payload = (await result.json().catch(() => null)) as {
      data?: {
        id: string;
        compId: string;
        layerId: string | null;
        timeTicks: number | null;
        parentCommentId: string | null;
        body: string;
        guestName: string | null;
        resolvedAt: string | null;
        createdAt: string;
      };
    } | null;
    const row = payload?.data;
    if (row === undefined) return result;
    return ok(
      c,
      {
        id: row.id,
        compId: row.compId,
        layerId: row.layerId,
        timeTicks: row.timeTicks,
        parentCommentId: row.parentCommentId,
        body: row.body,
        guestName: row.guestName,
        resolvedAt: row.resolvedAt,
        createdAt: row.createdAt,
      } satisfies ShareComment,
      201,
    );
  });

  // POST /v1/share/:token/request-access — records the audit row (v1
  // notification = the workspace's activity feed). No password gate: someone
  // locked out by the password is exactly who requests access.
  app.post("/v1/share/:token/request-access", async (c: AppContext): Promise<Response> => {
    const resolved = await resolveShare(c);
    const decision = requestAccessLimiter.check(clientIp(c));
    if (!decision.allowed) rateLimited(c, decision.retryAfterSeconds);

    const parsed = REQUEST_ACCESS_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Send your email so the workspace can reach you.",
        requestId: c.get("requestId"),
      });
    }

    // §7.1 audit-on-mutation, actorless; a hiccup must not fail the request.
    try {
      await deps.repos.audit.append(resolved.workspaceId, {
        actorId: null,
        action: "share.request_access",
        targetType: "project",
        targetId: resolved.projectId,
        metadata: {
          shareTokenId: resolved.token.id,
          email: parsed.data.email,
          message: parsed.data.message ?? null,
        },
        ip: clientIp(c),
      });
    } catch (error) {
      deps.logger.warn("audit_failed", {
        action: "share.request_access",
        workspaceId: resolved.workspaceId,
        detail: error instanceof Error ? error.message : "unknown",
      });
    }
    return ok(c, { ok: true } as const, 201);
  });

  return app;
}

// ---------------------------------------------------------------------------
// AUTHED router — issue / list / revoke (members)
// ---------------------------------------------------------------------------

export function shareAuthedRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());

  const toView = (row: {
    id: string;
    projectId: string;
    createdBy: string;
    createdAt: Date;
    expiresAt: Date | null;
    revokedAt: Date | null;
    hasPassword: boolean;
  }): ShareLinkView => ({
    id: row.id,
    projectId: row.projectId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt !== null ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt !== null ? row.revokedAt.toISOString() : null,
    hasPassword: row.hasPassword,
  });

  // POST /v1/projects/:id/share-links — mint + issue (editor role). NOTE:
  // issuing a share link publishes a READ capability; it is not a project
  // content mutation, so the single-writer lease does not gate it (M7-C's
  // lease helpers are not consulted here by design).
  app.post(
    "/v1/projects/:id/share-links",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const parsed = ISSUE_SHARE_LINK_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Password must be 8-128 characters; expiresInDays a whole number 1-365.",
          requestId: c.get("requestId"),
        });
      }
      const raw = mintShareToken();
      const token = await deps.repos.shareTokens.issue(workspace.id, {
        projectId: pathParam(c, "id"),
        createdBy: c.get("auth").user.id,
        tokenHash: hashShareToken(raw),
        passwordHash:
          parsed.data.password !== undefined ? scryptPasswordHash(parsed.data.password) : null,
        expiresInDays: parsed.data.expiresInDays ?? null,
      });
      await audit(deps, c, workspace.id, "share_link.created", token.projectId, {
        shareTokenId: token.id,
        hasPassword: token.passwordHash !== null,
        expiresAt: token.expiresAt !== null ? token.expiresAt.toISOString() : null,
      });
      const body: ShareLinkIssued = {
        id: token.id,
        token: raw, // shown exactly once — sha256(raw) is all that's stored
        expiresAt: token.expiresAt !== null ? token.expiresAt.toISOString() : null,
        hasPassword: token.passwordHash !== null,
      };
      return ok(c, body, 201);
    },
  );

  // GET /v1/projects/:id/share-links — active links, NO token material.
  app.get(
    "/v1/projects/:id/share-links",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const rows = await deps.repos.shareTokens.list(workspace.id, pathParam(c, "id"));
      return page(c, rows.map(toView), null);
    },
  );

  // DELETE /v1/share/:id — revoke (creator or admin; §12.1 for strangers).
  app.delete("/v1/share/:id", requireAuth(), async (c: AppContext): Promise<Response> => {
    const shareId = pathParam(c, "id");
    const found = await deps.repos.shareTokens.findById(shareId);
    if (found === null) shareNotFound(c);

    // Resolve the OWNING workspace with the caller's session: a stranger
    // gets WORKSPACE_NOT_FOUND (404), a member proceeds to the role check.
    const workspace = await resolveWorkspaceContext(c, found.workspaceId, "viewer");
    const userId = c.get("auth").user.id;
    const isCreator = found.createdBy === userId;
    const isAdmin = workspace.role === "owner" || workspace.role === "admin";
    if (!isCreator && !isAdmin) {
      // In-workspace denial is explainable (§7.1): creator-or-admin only.
      throw new StudioError("FORBIDDEN", { requestId: c.get("requestId") });
    }

    const revoked = await deps.repos.shareTokens.revoke(workspace.id, {
      id: shareId,
      byUserId: userId,
    });
    await audit(deps, c, workspace.id, "share_link.revoked", revoked.projectId, {
      shareTokenId: revoked.id,
    });
    return ok(c, {
      id: revoked.id,
      revokedAt: revoked.revokedAt !== null ? revoked.revokedAt.toISOString() : null,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Local helpers (kept private to this module)
// ---------------------------------------------------------------------------

/** DB comment row → public ShareComment: NO member ids, NO guest emails. */
function toShareComment(comment: Comment): ShareComment {
  return {
    id: comment.id,
    compId: comment.compId,
    layerId: comment.layerId,
    timeTicks: comment.timeTicks,
    parentCommentId: comment.parentId,
    body: comment.body,
    guestName: comment.guestName,
    resolvedAt: comment.resolvedAt !== null ? comment.resolvedAt.toISOString() : null,
    createdAt: comment.createdAt.toISOString(),
  };
}
