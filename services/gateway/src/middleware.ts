// @studio/gateway — middleware chain (§5.1 trust boundaries, §7.1, §7.3, §12.1).
//
// Order inside buildApp:
//   requestId → logger → CORS → rate-limit → better-auth mount →
//   idempotency (POST /v1 mutations) → routes
// with app.onError (§7.3 envelope, never leak internals) and app.notFound
// ({code: NOT_FOUND}) wrapping everything.

import { createHash, randomUUID } from "node:crypto";
import { isIPv6 } from "node:net";

import type { MiddlewareHandler } from "hono";

import { StudioError } from "@studio/config";
import { apiKeyStatementsToScopes } from "@studio/contracts";
import { type Role, atLeast, can } from "@studio/db";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiKeyPrincipal, AppBindings, WorkspaceContext } from "./context.js";
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
    // AUD-L1: charset-validated, not just length-checked — a hostile header
    // value otherwise rides verbatim into logs and the echoed response header.
    const id =
      incoming !== undefined && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : `req_${randomUUID().replaceAll("-", "")}`;
    c.set("requestId", id);
    await next();
    c.header("x-request-id", id);
  };
}

/** Request ids are opaque tokens — printable ASCII, no control/whitespace. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:\-]{1,128}$/;

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
    // AUD-A6 (2026-10-30 deep audit): X-Forwarded-For APPENDS one entry per
    // proxy hop — the client-supplied spoof sits FIRST, the trusted edge's
    // verdict LAST (Vercel and the §14 Caddy edge both append). Reading the
    // FIRST entry let any caller mint a fresh rate-limit bucket per request
    // (unlimited turns, brute-forceable auth + share passwords).
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const trusted = parts[parts.length - 1];
    if (trusted !== undefined && trusted !== "") return normalizeRateLimitIp(trusted);
  }
  return normalizeRateLimitIp(c.req.header("x-real-ip") ?? "unknown");
}

/**
 * SEC-05 (2026-10-30 audit follow-up): IPv6 rate-limit keys normalize to the
 * /64 prefix. A /64 is the standard ISP delegation — one attacker cycling
 * host bits (every interface identifier inside their allocation) otherwise
 * mints an unbounded number of fresh limiter buckets and brute-forces the
 * scrypt share-password gate (and every other (ip, route-class) limit) at
 * full speed. IPv4 and unparseable values pass through untouched.
 */
export function normalizeRateLimitIp(ip: string): string {
  const bare = (ip.split("%")[0] ?? ip).trim();
  // IPv4-mapped/compatible forms ("::ffff:192.0.2.1") carry a dotted quad —
  // they cannot be split into hex groups; pass through per-address (no
  // worse than the pre-fix posture, and never merges unrelated clients).
  if (bare === "" || bare.includes(".") || !isIPv6(bare)) return ip;
  // Expand "::" compression to the full 8 groups, then keep the first 4
  // (the /64 network half). Groups are lowercase hex without leading zeros —
  // the canonical form makes every host inside the /64 share ONE key.
  const halves = bare.split("::");
  if (halves.length > 2) return ip; // malformed (multiple ::) — untouched
  const toGroups = (text: string): number[] =>
    text
      .split(":")
      .filter((group) => group !== "")
      .map((group) => Number.parseInt(group, 16));
  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 8) {
    return ip; // not a shape we can safely expand — untouched
  }
  const middle = Array.from({ length: 8 - head.length - tail.length }, () => 0);
  const groups = [...head, ...middle, ...tail].map((group) => group.toString(16));
  return `${groups.slice(0, 4).join(":")}::/64`;
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

    // AUD-A7 (2026-10-30 deep audit): the store key is namespaced by the
    // CALLER IDENTITY — a sha256 of the credential material the request
    // itself carries (Authorization header + cookie jar + workspace hint).
    // Pre-fix the store keyed the RAW header only and replayed BEFORE
    // requireAuth, so a leaked/colliding key returned ANOTHER user's stored
    // response body cross-tenant with zero authentication. With the scope
    // hash, an identical key + body from a different session reads as a
    // different store key — the replay is confined to the credential that
    // originally produced it.
    const storeKey = `${idempotencyScopeOf(c)}::${key}`;

    const payloadHash = await fingerprintPayload(c.req.raw);
    const stored = deps.idempotency.lookup(storeKey);
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
        await deps.idempotency.waitFor(storeKey);
        const after = deps.idempotency.lookup(storeKey);
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

    if (!deps.idempotency.begin(storeKey, payloadHash)) {
      // Lost a begin race: wait for the in-flight handler, then replay.
      await deps.idempotency.waitFor(storeKey);
      const after = deps.idempotency.lookup(storeKey);
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
        storeKey,
        payloadHash,
        c.res.status,
        safeJsonParse(body),
        contentTypeOf(c.res.headers),
      );
    } catch (error) {
      deps.idempotency.release(storeKey);
      throw error;
    }
  };
}

/**
 * AUD-A7: stable, non-reversible scope for the idempotency store key — the
 * credential material THIS request carries. Same session + same workspace →
 * same scope → same-key replays stay inside one caller. A different session
 * (or an anonymous replay of a leaked key) lands in a different namespace
 * and can never read the original response.
 */
function idempotencyScopeOf(c: Parameters<MiddlewareHandler<AppBindings>>[0]): string {
  const authorization = c.req.header("authorization") ?? "";
  const cookie = c.req.header("cookie") ?? "";
  const workspace = c.req.header("x-workspace-id") ?? "";
  if (authorization === "" && cookie === "") return "anon";
  return createHash("sha256")
    .update(`${authorization}\n${cookie}\n${workspace}`)
    .digest("hex")
    .slice(0, 32);
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
    const requestId = c.get("requestId");
    const session = await deps.auth.getSession(c.req.raw.headers);
    if (session === null) {
      throw new StudioError("AUTH_REQUIRED", { requestId });
    }
    if (session.viaApiKey === true) {
      // SEC-03 (2026-10-30 deep audit follow-up): API-key sessions were
      // confined to the data plane but the key's stored scopes were NEVER
      // consulted — a `projects:read` key could spend credits, delete
      // projects and drive the full agent loop. The better-auth apiKey
      // plugin's Bearer session-mock sets session.id = apiKey.id, so the
      // row (statements + workspace binding) resolves by that id; the id
      // comes from the authenticated session, never from request input.
      const record = await deps.repos.apiKeys.findById(session.session.id);
      if (record === null) {
        // Verified by the plugin but no row — treat as unauthenticated.
        throw new StudioError("AUTH_REQUIRED", { requestId });
      }
      const principal: ApiKeyPrincipal = {
        id: record.id,
        workspaceId: workspaceBindingOf(record.metadata),
        scopes: scopesOfKey(record.permissions),
      };
      c.set("auth", { user: session.user, session: session.session, apiKey: principal });
      enforceApiKeyAccess(principal, c.req.method, c.req.path, requestId);
    } else {
      c.set("auth", { user: session.user, session: session.session });
    }
    await next();
  };
}

/** `metadata.workspaceId` — null when absent or unparseable (fails closed). */
function workspaceBindingOf(metadata: string | null): string | null {
  if (metadata === null) return null;
  try {
    const parsed = JSON.parse(metadata) as { workspaceId?: unknown };
    return typeof parsed.workspaceId === "string" ? parsed.workspaceId : null;
  } catch {
    return null;
  }
}

/** Stored statements JSON → wire scopes; null/garbage → [] (fail safe). */
function scopesOfKey(permissions: string | null): readonly string[] {
  if (permissions === null) return [];
  try {
    return apiKeyStatementsToScopes(JSON.parse(permissions) as unknown);
  } catch {
    return [];
  }
}

/** What a Bearer API-key session may do with one route (SEC-03). */
export type ApiKeyRouteAccess =
  | { readonly kind: "any-key" }
  | { readonly kind: "scope"; readonly scope: string }
  | { readonly kind: "cookie-only"; readonly surface: string };

/**
 * SEC-03: the v1 API-key capability table. Cookie sessions bypass it
 * entirely. `any-key` = principal introspection every authenticated caller
 * needs; `scope` = the @studio/contracts vocabulary the settings UI sells;
 * `cookie-only` = surfaces a key may NEVER touch regardless of scopes.
 * UNMAPPED /v1 ROUTES DEFAULT TO cookie-only — a new route must declare its
 * key posture here or keys are locked out of it (fail closed).
 */
export function apiKeyRouteAccess(method: string, path: string): ApiKeyRouteAccess {
  const m = method.toUpperCase();
  const p = path;

  // better-auth's own mount — keys never drive auth mutations.
  if (p === "/v1/auth" || p.startsWith("/v1/auth/")) {
    return { kind: "cookie-only", surface: "auth" };
  }
  // Membership mutation (invite acceptance) — account surface.
  if (p.startsWith("/v1/invites/")) {
    return { kind: "cookie-only", surface: "invites" };
  }
  // Principal introspection — every authenticated caller (§7.1).
  if (p === "/v1/me" || p === "/v1/me/settings" || p === "/v1/models") {
    return m === "GET" ? { kind: "any-key" } : { kind: "cookie-only", surface: "account" };
  }

  // Workspace surface: list/show/switch are introspection; EVERYTHING else
  // (create, rename, members, invites, api-key management, audit export,
  // ownership transfer) is administration — cookie-only.
  if (p === "/v1/workspaces" || p.startsWith("/v1/workspaces/")) {
    if (m === "GET" && /^\/v1\/workspaces\/[^/]+$/.test(p)) return { kind: "any-key" };
    if (m === "POST" && /^\/v1\/workspaces\/[^/]+\/switch$/.test(p)) {
      return { kind: "any-key" };
    }
    if (m === "GET" && p === "/v1/workspaces") return { kind: "any-key" };
    return { kind: "cookie-only", surface: "workspace administration" };
  }

  // Money plane: reads are scope-gated (billing:read), mutations and the
  // staff reconcile tool are cookie-only. (/v1/webhooks/stripe is public —
  // signature-verified, never reaches requireAuth.)
  if (p === "/v1/billing" || p.startsWith("/v1/billing/")) {
    return m === "GET"
      ? { kind: "scope", scope: "billing:read" }
      : { kind: "cookie-only", surface: "billing" };
  }
  if (p === "/v1/credits" || p === "/v1/credits/ledger") {
    return m === "GET"
      ? { kind: "scope", scope: "billing:read" }
      : { kind: "cookie-only", surface: "billing" };
  }
  if (p === "/v1/credits/reconcile") {
    return { kind: "cookie-only", surface: "billing" };
  }

  // Share-link management: minting/revoking PUBLIC capability tokens is a
  // cookie-only action by design (§5.3 sketch); listing is project data.
  if (m === "POST" && /^\/v1\/projects\/[^/]+\/share-links$/.test(p)) {
    return { kind: "cookie-only", surface: "share-link minting" };
  }
  if (m === "DELETE" && /^\/v1\/share\/[^/]+$/.test(p)) {
    return { kind: "cookie-only", surface: "share-link management" };
  }

  // The agent loop: threads, turns, tools, runs (incl. apply/undo) — chat:run.
  if (
    /^\/v1\/projects\/[^/]+\/threads$/.test(p) ||
    p.startsWith("/v1/threads/") ||
    p.startsWith("/v1/runs/")
  ) {
    return { kind: "scope", scope: "chat:run" };
  }

  // The render pipeline end-to-end (queue, estimate, poll, cancel).
  if (p === "/v1/renders" || p.startsWith("/v1/renders/")) {
    return { kind: "scope", scope: "renders:queue" };
  }

  // Project content plane: reads → projects:read, mutations → projects:write.
  if (
    p === "/v1/projects" ||
    p.startsWith("/v1/projects/") ||
    p === "/v1/assets" ||
    p.startsWith("/v1/assets/") ||
    p.startsWith("/v1/comments/")
  ) {
    return m === "GET" || m === "HEAD"
      ? { kind: "scope", scope: "projects:read" }
      : { kind: "scope", scope: "projects:write" };
  }

  // Fail closed: unknown surfaces require a cookie session.
  return { kind: "cookie-only", surface: "this surface" };
}

/** Apply the SEC-03 capability table to one authenticated key session. */
function enforceApiKeyAccess(
  principal: ApiKeyPrincipal,
  method: string,
  path: string,
  requestId: string,
): void {
  const access = apiKeyRouteAccess(method, path);
  if (access.kind === "any-key") return;
  if (access.kind === "cookie-only") {
    throw new GatewayError("API_KEY_FORBIDDEN", `API keys cannot use ${access.surface}.`, {
      status: 403,
      hint: "Use a cookie session for this operation.",
      requestId,
    });
  }
  // A "*" key stores the FULL statement map (mint-time expansion), which
  // apiKeyStatementsToScopes normalizes back to ["*"] — grant every scope.
  if (principal.scopes.includes("*") || principal.scopes.includes(access.scope)) return;
  throw new GatewayError(
    "API_KEY_FORBIDDEN",
    `This API key lacks the required scope: ${access.scope}.`,
    {
      status: 403,
      hint: `Mint a key with the "${access.scope}" scope (Settings → API keys) or use a cookie session.`,
      requestId,
    },
  );
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
  // SEC-03: a Bearer API key is bound to the workspace it was minted for
  // (metadata.workspaceId). Even the minting user's OTHER workspaces read as
  // 404 — a leaked key stays inside one tenant, and §12.1 means the denial
  // never confirms the workspace exists. A key with no parsable binding
  // (foreign mint path) fails closed the same way.
  const apiKey = c.get("auth").apiKey;
  if (apiKey !== undefined && apiKey.workspaceId !== full.organization.id) {
    throw new StudioError("WORKSPACE_NOT_FOUND", { requestId });
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
