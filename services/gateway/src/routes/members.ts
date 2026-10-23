// @studio/gateway — member management (M1.2 gap fix, task W1-a): list, role
// change, removal, ownership transfer and active-workspace switch for
// /v1/workspaces/:id/… (§7.2, §7.1, §3.3, §12.1).
//
// Mutations ride Better Auth's organization plugin (installed 1.7.12) so its
// own permission statements and last-owner guards stay in force behind ours.
// The plugin's server endpoints are not exposed on the gateway's GatewayAuth
// seam (services/gateway/src/auth.ts — owned elsewhere, see worklog W1-a), so
// this router reaches the SAME better-auth instance through the one seam
// member it does expose: `handler(request)` — an in-process Request against
// the /v1/auth/organization/* mount (basePath verified in src/env.ts). The
// caller's session cookie/authorization and Origin are forwarded verbatim,
// so better-auth's own session + CSRF/origin checks apply unchanged.
//
// Endpoint map (verified against node_modules/better-auth@1.7.12 dist):
//   POST /organization/update-member-role  { memberId, role, organizationId? }
//        → 200 member row · 400 MEMBER_NOT_FOUND / last-owner · 403 not-allowed
//   POST /organization/remove-member       { memberIdOrEmail, organizationId? }
//        → 200 { member } (needs member:delete — admin/owner only)
//   POST /organization/leave               { organizationId }
//        → 200 member row (ANY member may leave; last-owner → 400)
//   POST /organization/set-active           { organizationId }
//        → 200 organization row (membership-checked; updates the session row)
//   GET  /organization/get-full-organization?organizationId=
//        → 200 { members: [{ id, userId, role, createdAt, user }] }
//
// Tenant isolation (§12.1): resolveWorkspaceContext 404s unknown workspaces
// and non-members BEFORE anything better-auth is asked; in-route guards
// (admin floor, owner-target rules, last-owner protection) render typed
// 403/409 envelopes; better-auth failures are re-mapped message-first so a
// race can never leak a provider phrase (law #1).
//
// Audit (§7.1): member.role_changed · member.removed ·
// workspace.ownership_transferred — appended best-effort after the mutation
// (an audit write must not fail the user-visible result; see workspaces.ts).

import { Hono } from "hono";

import {
  type Member,
  PAGINATION_QUERY_SCHEMA,
  PATCH_MEMBER_ROLE_SCHEMA,
  type Page,
  SWITCH_WORKSPACE_SCHEMA,
  TRANSFER_OWNERSHIP_SCHEMA,
} from "@studio/contracts";
import { atLeast, decodeCursor, encodeCursor } from "@studio/db";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireAuth, resolveWorkspaceContext } from "../middleware.js";

/** The better-auth internal mount (AUTH_MOUNT_PATH + organization plugin). */
const ORG_BASE = "/v1/auth/organization";

// ---------------------------------------------------------------------------
// Raw better-auth row plumbing (defensive parsing — same style as auth.ts)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A better-auth member row (organization plugin "member" model + user join). */
interface RawMember {
  /** The membership row id — better-auth's mutation key (never on the wire). */
  readonly rowId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAtMs: number;
  readonly name: string | null;
  readonly email: string | null;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

function parseRawMember(entry: unknown): RawMember | null {
  const record = asRecord(entry);
  const rowId = asString(record.id);
  const userId = asString(record.userId);
  if (rowId === null || userId === null) return null;
  const user = asRecord(record.user);
  return {
    rowId,
    userId,
    role: asString(record.role) ?? "viewer",
    createdAtMs: toMillis(record.createdAt),
    name: asString(user.name),
    email: asString(user.email),
  };
}

/** Forwarded headers: session + CSRF origin only (law #1: nothing else rides). */
function forwardedAuthHeaders(c: AppContext): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  for (const name of ["authorization", "cookie", "origin"] as const) {
    const value = c.req.header(name);
    if (value !== undefined && value !== "") headers.set(name, value);
  }
  return headers;
}

interface AuthCall {
  readonly status: number;
  readonly json: unknown;
}

/** In-process POST into the mounted better-auth organization endpoints. */
async function authPost(
  deps: GatewayDeps,
  c: AppContext,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<AuthCall> {
  const url = new URL(`${ORG_BASE}/${endpoint}`, deps.env.app.url);
  const response = await deps.auth.handler(
    new Request(url, {
      method: "POST",
      headers: forwardedAuthHeaders(c),
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: await response.json().catch(() => null) };
}

/** In-process GET of the full organization (all members, no limit). */
async function authGet(
  deps: GatewayDeps,
  c: AppContext,
  endpoint: string,
  query: Record<string, string>,
): Promise<AuthCall> {
  const url = new URL(`${ORG_BASE}/${endpoint}`, deps.env.app.url);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await deps.auth.handler(
    new Request(url, { method: "GET", headers: forwardedAuthHeaders(c) }),
  );
  return { status: response.status, json: await response.json().catch(() => null) };
}

function authMessage(json: unknown): string {
  const message = asRecord(json).message;
  return typeof message === "string" ? message : "";
}

/**
 * Map a better-auth failure to a safe typed envelope. Message-first matching
 * (better-auth phrases are human strings — see auth.ts): membership/existence
 * read as 404 (§12.1), permission as 403, owner-protection as 409. Anything
 * else stays server-side via `cause` and renders INTERNAL.
 */
function throwFromAuth(result: AuthCall, requestId: string): never {
  const message = authMessage(result.json);
  const lower = message.toLowerCase();
  if (lower.includes("member not found") || lower.includes("user not found")) {
    throw new GatewayError("NOT_FOUND", "Member not found.", { status: 404, requestId });
  }
  if (
    lower.includes("organization not found") ||
    lower.includes("user is not a member of the organization") ||
    lower.includes("no active organization")
  ) {
    throw new GatewayError("WORKSPACE_NOT_FOUND", "Workspace not found.", {
      status: 404,
      requestId,
    });
  }
  if (lower.includes("only owner") || lower.includes("without an owner")) {
    throw new GatewayError("CONFLICT", "The workspace must keep an owner.", {
      status: 409,
      hint: "Transfer ownership to another member first.",
      requestId,
    });
  }
  if (lower.includes("not allowed") || lower.includes("not the recipient")) {
    throw new GatewayError("FORBIDDEN", "You don't have permission to do that.", {
      status: 403,
      hint: "Ask a workspace admin for access.",
      requestId,
    });
  }
  throw new GatewayError("INTERNAL", "Something went wrong on our side.", {
    status: 500,
    requestId,
    cause: { status: result.status, body: result.json },
  });
}

// ---------------------------------------------------------------------------
// Member shaping + guards
// ---------------------------------------------------------------------------

function normalizeRole(role: string): Member["role"] {
  const first = role.split(",")[0]?.trim() ?? "";
  return first === "owner" || first === "admin" || first === "editor" || first === "viewer"
    ? first
    : "viewer";
}

function toMember(row: RawMember, callerUserId: string): Member {
  return {
    id: row.userId,
    name: row.name,
    email: row.email,
    role: normalizeRole(row.role),
    status: "active",
    lastActiveAt: null,
    isCurrentUser: row.userId === callerUserId,
  };
}

/** Stable member order: (createdAt ASC, row id ASC) — the founder lists first. */
function sortMembers(rows: readonly RawMember[]): RawMember[] {
  return [...rows].sort(
    (a, b) => a.createdAtMs - b.createdAtMs || (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0),
  );
}

function isOwner(row: RawMember): boolean {
  return normalizeRole(row.role) === "owner";
}

function ownersAmong(rows: readonly RawMember[]): number {
  return rows.filter(isOwner).length;
}

/**
 * Fresh member rows for one workspace via the full-organization endpoint.
 * Reads the CURRENT state (races with invite/accept are re-checked here), so
 * every mutation resolves its better-auth member row from this snapshot.
 */
async function fetchMembers(
  deps: GatewayDeps,
  c: AppContext,
  organizationId: string,
  requestId: string,
): Promise<RawMember[]> {
  const result = await authGet(deps, c, "get-full-organization", { organizationId });
  if (result.status !== 200) throwFromAuth(result, requestId);
  const members = asRecord(result.json).members;
  if (!Array.isArray(members)) {
    throw new GatewayError("INTERNAL", "Something went wrong on our side.", {
      status: 500,
      requestId,
      cause: "members surface missing on the auth response",
    });
  }
  return members.map(parseRawMember).filter((row): row is RawMember => row !== null);
}

function findMemberByUserId(rows: readonly RawMember[], userId: string): RawMember | null {
  return rows.find((row) => row.userId === userId) ?? null;
}

function validationFailed(c: AppContext, hint: string): GatewayError {
  return new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
    status: 400,
    hint,
    requestId: c.get("requestId"),
  });
}

function notFoundMember(c: AppContext): GatewayError {
  return new GatewayError("NOT_FOUND", "Member not found.", {
    status: 404,
    requestId: c.get("requestId"),
  });
}

function forbidden(c: AppContext, hint: string): GatewayError {
  return new GatewayError("FORBIDDEN", "You don't have permission to do that.", {
    status: 403,
    hint,
    requestId: c.get("requestId"),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function membersRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/workspaces/*", requireAuth());

  async function audit(
    c: AppContext,
    workspaceId: string,
    action: string,
    targetType: "member" | "workspace",
    targetId: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await deps.repos.audit.append(workspaceId, {
        actorId: c.get("auth").user.id,
        action,
        targetType,
        targetId,
        metadata,
      });
    } catch (error) {
      // Audit is important but must not fail the user-visible mutation.
      deps.logger.warn("audit_failed", {
        action,
        workspaceId,
        detail: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  // -- GET /v1/workspaces/:id/members — list (any member; §12.1 for others) --
  app.get("/v1/workspaces/:id/members", async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "viewer");

    const query = PAGINATION_QUERY_SCHEMA.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!query.success) throw validationFailed(c, "Check the pagination parameters.");

    const rows = sortMembers(await fetchMembers(deps, c, context.id, requestId));

    // Keyset pagination over the sorted rows: the cursor is the last row's
    // (createdAt, membership-row id) — same opaque protocol as the repos.
    let start = 0;
    if (query.data.cursor !== undefined) {
      const cursor = decodeCursor(query.data.cursor);
      if (cursor !== null) {
        const cursorMs = Date.parse(cursor.t);
        start = rows.findIndex(
          (row) =>
            row.createdAtMs > cursorMs || (row.createdAtMs === cursorMs && row.rowId > cursor.id),
        );
        if (start === -1) start = rows.length;
      }
    }
    const limit = query.data.limit;
    const slice = rows.slice(start, start + limit);
    const hasMore = start + limit < rows.length;
    const last = slice.at(-1);
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor({ t: new Date(last.createdAtMs).toISOString(), id: last.rowId })
        : null;

    const callerId = c.get("auth").user.id;
    const body: Page<Member> = {
      items: slice.map((row) => toMember(row, callerId)),
      nextCursor,
    };
    return page(c, body.items, body.nextCursor);
  });

  // -- PATCH /v1/workspaces/:id/members/:memberId — change role --------------
  app.patch("/v1/workspaces/:id/members/:memberId", async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "viewer");
    const memberId = pathParam(c, "memberId");

    const parsed = PATCH_MEMBER_ROLE_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw validationFailed(c, "Send a role of owner, admin, editor or viewer.");
    }
    if (!atLeast(context.role, "admin")) {
      throw forbidden(c, "Only workspace admins can change member roles.");
    }

    const rows = await fetchMembers(deps, c, context.id, requestId);
    const target = findMemberByUserId(rows, memberId);
    if (target === null) throw notFoundMember(c);

    const targetRole = normalizeRole(target.role);
    if (targetRole === "owner" && context.role !== "owner") {
      throw forbidden(c, "Only the workspace owner can change another owner's role.");
    }
    if (targetRole === "owner" && parsed.data.role !== "owner" && ownersAmong(rows) <= 1) {
      throw new GatewayError("CONFLICT", "The workspace must keep an owner.", {
        status: 409,
        hint: "Transfer ownership to another member first.",
        requestId,
      });
    }

    const result = await authPost(deps, c, "update-member-role", {
      organizationId: context.id,
      memberId: target.rowId,
      role: parsed.data.role,
    });
    if (result.status !== 200) throwFromAuth(result, requestId);

    const updatedRole = asString(asRecord(result.json).role);
    await audit(
      c,
      context.id,
      "member.role_changed",
      "member",
      memberId,
      updatedRole !== null
        ? { userId: memberId, from: targetRole, to: normalizeRole(updatedRole) }
        : { userId: memberId, from: targetRole, to: parsed.data.role },
    );

    const callerId = c.get("auth").user.id;
    const body: Member = {
      id: target.userId,
      name: target.name,
      email: target.email,
      role: normalizeRole(updatedRole ?? parsed.data.role),
      status: "active",
      lastActiveAt: null,
      isCurrentUser: target.userId === callerId,
    };
    return ok(c, body);
  });

  // -- DELETE /v1/workspaces/:id/members/:memberId — remove ------------------
  app.delete("/v1/workspaces/:id/members/:memberId", async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "viewer");
    const memberId = pathParam(c, "memberId");

    const rows = await fetchMembers(deps, c, context.id, requestId);
    const target = findMemberByUserId(rows, memberId);
    if (target === null) throw notFoundMember(c);

    const callerId = c.get("auth").user.id;
    const self = target.userId === callerId;
    const targetRole = normalizeRole(target.role);

    if (self) {
      // Self-removal is always allowed — except the last owner (§7.1).
      if (isOwner(target) && ownersAmong(rows) <= 1) {
        throw new GatewayError("CONFLICT", "The workspace must keep an owner.", {
          status: 409,
          hint: "Transfer ownership to another member first.",
          requestId,
        });
      }
      const result = await authPost(deps, c, "leave", { organizationId: context.id });
      if (result.status !== 200) throwFromAuth(result, requestId);
      await audit(c, context.id, "member.removed", "member", memberId, { self: true });
      return ok(c, { id: target.userId, removed: true });
    }

    if (!atLeast(context.role, "admin")) {
      throw forbidden(c, "Only workspace admins can remove members.");
    }
    if (isOwner(target)) {
      if (context.role !== "owner") {
        throw forbidden(c, "Only the workspace owner can remove another owner.");
      }
      if (ownersAmong(rows) <= 1) {
        throw new GatewayError("CONFLICT", "The workspace must keep an owner.", {
          status: 409,
          hint: "Transfer ownership to another member first.",
          requestId,
        });
      }
    }
    const result = await authPost(deps, c, "remove-member", {
      organizationId: context.id,
      memberIdOrEmail: target.rowId,
    });
    if (result.status !== 200) throwFromAuth(result, requestId);
    await audit(c, context.id, "member.removed", "member", memberId, { self: false });
    return ok(c, { id: target.userId, removed: true });
  });

  // -- POST /v1/workspaces/:id/transfer-ownership — owner only ---------------
  app.post("/v1/workspaces/:id/transfer-ownership", async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "viewer");
    const callerId = c.get("auth").user.id;

    if (context.role !== "owner") {
      throw forbidden(c, "Only the workspace owner can transfer ownership.");
    }
    const parsed = TRANSFER_OWNERSHIP_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw validationFailed(c, "Send the id of the member taking over.");

    const rows = await fetchMembers(deps, c, context.id, requestId);
    const target = findMemberByUserId(rows, parsed.data.memberId);
    if (target === null) throw notFoundMember(c);
    if (target.userId === callerId) {
      throw new GatewayError("CONFLICT", "You already own this workspace.", {
        status: 409,
        requestId,
      });
    }

    const caller = findMemberByUserId(rows, callerId);
    if (caller === null) {
      // Unreachable (the caller passed the membership gate as owner), but
      // fail typed rather than hand better-auth a null key.
      throw notFoundMember(c);
    }

    // Promote first, demote second: a failure between the two steps leaves
    // TWO owners (recoverable via PATCH) — never zero. A retry after a
    // partial failure finds the target already an owner and just demotes.
    if (!isOwner(target)) {
      const promote = await authPost(deps, c, "update-member-role", {
        organizationId: context.id,
        memberId: target.rowId,
        role: "owner",
      });
      if (promote.status !== 200) throwFromAuth(promote, requestId);
    }
    const demote = await authPost(deps, c, "update-member-role", {
      organizationId: context.id,
      memberId: caller.rowId,
      role: "admin",
    });
    if (demote.status !== 200) throwFromAuth(demote, requestId);

    await audit(c, context.id, "workspace.ownership_transferred", "workspace", context.id, {
      fromUserId: callerId,
      toUserId: target.userId,
    });

    return ok(c, {
      workspaceId: context.id,
      ownerId: target.userId,
      previousOwnerId: callerId,
    });
  });

  // -- POST /v1/workspaces/:id/switch — set the caller's active workspace -----
  app.post("/v1/workspaces/:id/switch", async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const context = await resolveWorkspaceContext(c, pathParam(c, "id"), "viewer");

    // No body: the path names the workspace (same convention as invite
    // accept). The schema parse exists so the route stays Zod-at-boundary.
    SWITCH_WORKSPACE_SCHEMA.safeParse({});

    const result = await authPost(deps, c, "set-active", { organizationId: context.id });
    if (result.status !== 200) throwFromAuth(result, requestId);

    return ok(c, {
      workspaceId: context.id,
      name: context.organization.name,
      slug: context.organization.slug,
    });
  });

  return app;
}
