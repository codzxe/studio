// @studio/gateway — middleware chain (§5.1 trust boundaries, §7.1, §7.3, §12.1).
//
// Order inside buildApp:
//   requestId → logger → CORS → rate-limit → better-auth mount →
//   idempotency (POST /v1 mutations) → routes
// with app.onError (§7.3 envelope, never leak internals) and app.notFound
// ({code: NOT_FOUND}) wrapping everything.

import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import { StudioError } from "@studio/config";
import { type Role, atLeast, can } from "@studio/db";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppBindings, WorkspaceContext } from "./context.js";
import { GatewayError } from "./errors.js";
import { fingerprintPayload } from "./idempotency.js";
import type { RouteClass } from "./rate-limit.js";
import { routeClassFor } from "./route-class.js";

function asStatus(status: number): ContentfulStatusCode {
  return (status >= 200 && status < 600 ? status : 200) as ContentfulStatusCode;
}

/** 1. Request id: fresh `req_…` per request, echoed as x-request-id. */
export function requestIdMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id =
      incoming !== undefined && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : `req_${randomUUID().replaceAll("-", "")}`;
    c.set("requestId", id);
    await next();
    c.header("x-request-id", id);
  };
}

/** 2. Access log: method, path, status, ms, requestId, workspaceId (never bodies). */
export function accessLogMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const deps = c.get("deps");
    deps.logger.info("http_request", {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - start,
      workspaceId: safeWorkspace(c),
    });
  };
}

function safeWorkspace(c: Parameters<MiddlewareHandler<AppBindings>>[0]): string | undefined {
  const workspace = c.get("workspace");
  return workspace === undefined ? undefined : workspace.id;
}

/**
 * 3. CORS: same-origin app, no wildcard. Only the configured APP_URL origin
 * is allowed (§14: Caddy fronts /v1/* same-origin), plus preflight handling.
 */
export function corsMiddleware(appUrl: string): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin === appUrl) {
      c.header("access-control-allow-origin", origin);
      c.header("access-control-allow-credentials", "true");
      c.header("vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      c.header(
        "access-control-allow-headers",
        "content-type, x-workspace-id, x-request-id, idempotency-key, x-idempotency-key, last-event-id, authorization",
      );
      c.header("access-control-max-age", "86400");
      return c.body(null, 204);
    }
    await next();
  };
}

/** 4. Rate limit: token bucket per (ip, route-class); §7.3 RATE_LIMITED + Retry-After. */
export function rateLimitMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const deps = c.get("deps");
    const ip = clientIp(c);
    const routeClass: RouteClass = routeClassFor(c.req.method, c.req.path);
    const decision = deps.limiter.check(ip, routeClass);
    if (!decision.allowed) {
      c.header("retry-after", String(decision.retryAfterSeconds));
      throw new StudioError("RATE_LIMITED", {
        requestId: c.get("requestId"),
        retryable: true,
      });
    }
    await next();
  };
}

export function clientIp(c: Parameters<MiddlewareHandler<AppBindings>>[0]): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

const IDEMPOTENCY_EXCLUDED_PATHS = [
  /^\/v1\/auth(\/|$)/,
  /^\/v1\/threads\/[^/]+\/chat$/,
  // ROUND-12: the turn route carries its OWN durable idempotency (the
  // `Idempotency-Key: runId:stepIndex` header + the assistant-row turnKey
  // replay inside routes/turn.ts) — the generic body-store middleware would
  // wrap the SSE stream in a JSON envelope and kill the replay path.
  /^\/v1\/threads\/[^/]+\/turn$/,
  /^\/v1\/webhooks\//,
  // M8-G (M8-C pin): POST /v1/renders/estimate is a PURE READ — the body has
  // no idempotencyKey and no hold is taken; the Idempotency-Key header gate
  // would make every quote need a throwaway key for nothing.
  /^\/v1\/renders\/estimate$/,
];

/**
 * 5. Idempotency for POST /v1 mutations (§7.2): Idempotency-Key (or
 * X-Idempotency-Key) required; replay returns the stored result; a key
 * reused with a different payload is VALIDATION_FAILED. Excluded: better-auth
 * (its own semantics), the SSE chat route (body idempotencyKey), the Stripe
 * webhook (signature-idempotent) and the render ESTIMATE read (M8-C pin: a
 * pure read carries no key anywhere).
 */
export function idempotencyMiddleware(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const path = c.req.path;
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    if (!path.startsWith("/v1/")) {
      await next();
      return;
    }
    for (const pattern of IDEMPOTENCY_EXCLUDED_PATHS) {
      if (pattern.test(path)) {
        await next();
        return;
      }
    }

    const key = c.req.header("idempotency-key") ?? c.req.header("x-idempotency-key");
    const deps = c.get("deps");
    const requestId = c.get("requestId");
    if (key === undefined || key.length < 8 || key.length > 128) {
      throw new GatewayError("VALIDATION_FAILED", "Mutations require an Idempotency-Key header.", {
        status: 400,
        hint: "Send a unique Idempotency-Key (8-128 chars) with every POST; the same key replays the same result.",
        requestId,
      });
    }

    const payloadHash = await fingerprintPayload(c.req.raw);
    const stored = deps.idempotency.lookup(key);
    if (stored !== null) {
      if (stored.payloadHash !== payloadHash) {
        throw new GatewayError(
          "VALIDATION_FAILED",
          "This Idempotency-Key was used with a different payload.",
          {
            status: 400,
            hint: "Generate a fresh key for a new request.",
            requestId,
          },
        );
      }
      if (!stored.complete) {
        // Concurrent duplicate: wait for the in-flight handler, then replay.
        await deps.idempotency.waitFor(key);
        const after = deps.idempotency.lookup(key);
        if (after?.complete) {
          c.header("x-idempotent-replay", "true");
          return c.newResponse(JSON.stringify(after.body), asStatus(after.status), {
            "content-type": after.contentType,
          });
        }
        await next();
        return;
      }
      c.header("x-idempotent-replay", "true");
      return c.newResponse(JSON.stringify(stored.body), asStatus(stored.status), {
        "content-type": stored.contentType,
      });
    }

    if (!deps.idempotency.begin(key, payloadHash)) {
      // Lost a begin race: wait for the in-flight handler, then replay.
      await deps.idempotency.waitFor(key);
      const after = deps.idempotency.lookup(key);
      if (after?.complete) {
        c.header("x-idempotent-replay", "true");
        return c.newResponse(JSON.stringify(after.body), asStatus(after.status), {
          "content-type": after.contentType,
        });
      }
      throw new GatewayError("CONFLICT", "An identical request is already in progress.", {
        status: 409,
        retryable: true,
        hint: "Retry with the same Idempotency-Key shortly.",
        requestId,
      });
    }

    try {
      await next();
      // W3-gw bugfix: read the body from a CLONE of the response. Consuming
      // c.res's live stream directly leaves it "disturbed", and the requestId
      // middleware later calls c.header("x-request-id") — Hono rebuilds the
      // Response from res.body for every finalized header set, which throws
      // "Response body object should not be disturbed or locked". Net effect
      // pre-fix: every idempotent POST /v1 mutation returned INTERNAL *after*
      // the mutation had already committed. The clone is tee'd by undici, so
      // the client still receives the original bytes.
      const snapshot = c.res.clone();
      const body = await snapshot.text();
      deps.idempotency.complete(
        key,
        payloadHash,
        c.res.status,
        safeJsonParse(body),
        contentTypeOf(c.res.headers),
      );
    } catch (error) {
      deps.idempotency.release(key);
      throw error;
    }
  };
}

function contentTypeOf(headers: Headers): string {
  return headers.get("content-type")?.split(";")[0] ?? "application/json";
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { data: body };
  }
}

// ---------------------------------------------------------------------------
// Auth + workspace middlewares (§5.1, §7.1, §12.1)
// ---------------------------------------------------------------------------

/** 6. requireAuth: session from better-auth (cookie or Authorization). */
export function requireAuth(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const deps = c.get("deps");
    const session = await deps.auth.getSession(c.req.raw.headers);
    if (session === null) {
      throw new StudioError("AUTH_REQUIRED", { requestId: c.get("requestId") });
    }
    c.set("auth", { user: session.user, session: session.session });
    await next();
  };
}

/**
 * 7. requireWorkspace(minimumRole): resolves the workspace from the
 * x-workspace-id header (org id or slug — the editor SPA knows its
 * workspace; routes with the workspace in the path use
 * `resolveWorkspaceContext` instead). Unknown workspace / no membership →
 * NOT_FOUND (§12.1: never confirm existence to strangers); insufficient
 * in-workspace role → FORBIDDEN (within-workspace denials are explainable).
 */
export function requireWorkspace(minimumRole: Role): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const candidate = c.req.header("x-workspace-id") ?? "";
    await resolveWorkspaceContext(c, candidate, minimumRole);
    await next();
  };
}

/** Shared resolver: candidate is an org id or slug; enforces the role floor. */
export async function resolveWorkspaceContext(
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
  candidate: string,
  minimumRole: Role,
): Promise<WorkspaceContext> {
  const deps = c.get("deps");
  const requestId = c.get("requestId");
  if (candidate === "") {
    throw new GatewayError("VALIDATION_FAILED", "Missing workspace.", {
      status: 400,
      hint: "Send the workspace id or slug in the x-workspace-id header.",
      requestId,
    });
  }
  const full = await deps.auth.getFullWorkspace(c.req.raw.headers, candidate);
  if (full === null) {
    // §12.1: cross-tenant lookups 404 — never FORBIDDEN.
    throw new StudioError("WORKSPACE_NOT_FOUND", { requestId });
  }
  const role = roleForUser(full, c.get("auth").user.id);
  if (role === null) {
    throw new StudioError("WORKSPACE_NOT_FOUND", { requestId });
  }
  if (!atLeast(role, minimumRole)) {
    throw new StudioError("FORBIDDEN", { requestId });
  }
  const context: WorkspaceContext = {
    id: full.organization.id,
    slug: full.organization.slug,
    role,
    members: full.members,
    organization: full.organization,
  };
  c.set("workspace", context);
  return context;
}

function roleForUser(
  full: { members: readonly { userId: string; role: string }[] },
  userId: string,
): Role | null {
  const member = full.members.find((entry) => entry.userId === userId);
  if (member === undefined) return null;
  const role = member.role.split(",")[0]?.trim() ?? "";
  return isRoleOrNull(role);
}

function isRoleOrNull(value: string): Role | null {
  return value === "owner" || value === "admin" || value === "editor" || value === "viewer"
    ? value
    : null;
}

/** Capability helper for routes that gate on §3.3 capabilities, not raw roles. */
export function assertCapability(
  capability: Parameters<typeof can>[1],
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
): void {
  const workspace = c.get("workspace");
  if (!can(workspace.role, capability)) {
    throw new StudioError("FORBIDDEN", { requestId: c.get("requestId") });
  }
}
