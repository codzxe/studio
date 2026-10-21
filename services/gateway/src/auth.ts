// @studio/gateway — Better Auth seam (ADR-0003, PRODUCT_ARCHITECTURE §7.1).
//
// The gateway talks to auth through this narrow interface so that:
//   * production uses the real instance from @studio/db `createAuth`
//     (organization + apiKey + admin plugins, Drizzle adapter);
//   * tests inject a fake without any better-auth coupling.
//
// Hono mounting (verified against installed better-auth 1.7.12):
//   `app.on(["POST", "GET"], "/v1/auth/*", (c) => auth.handler(c.req.raw))`
//   `handler(request: Request) => Promise<Response>` — better-auth builds the
//   full Response (cookies included); Hono passes it through untouched.
//
// Server-side org endpoints are NOT present on the widened `Auth` type
// (plugins are generified away), so `adaptBetterAuth` reaches them through
// one narrow structural cast — endpoint names verified against the installed
// dist (`/organization/create`, `/organization/invite-member`,
// `/organization/accept-invitation`, `/organization/get-full-organization`,
// `/organization/check-slug`, `/organization/update`, `/organization/list`).

import { APIError } from "better-auth";

import type { Auth } from "@studio/db";
import { GatewayError } from "./errors.js";

export interface AuthUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

export interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly activeOrganizationId: string | null;
}

export interface AuthContext {
  readonly user: AuthUser;
  readonly session: AuthSession;
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string | null;
  readonly metadata: unknown;
}

export interface WorkspaceMemberInfo {
  readonly userId: string;
  readonly role: string;
  readonly userName: string | null;
  readonly userEmail: string | null;
}

export interface FullWorkspace {
  readonly organization: WorkspaceSummary;
  readonly members: readonly WorkspaceMemberInfo[];
}

export interface InviteInfo {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: string | null;
}

export interface AcceptedInviteInfo {
  readonly inviteId: string;
  readonly organizationId: string;
  readonly role: string;
}

/** The auth surface the gateway consumes. */
export interface GatewayAuth {
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthContext | null>;
  listOrganizations(headers: Headers): Promise<readonly WorkspaceSummary[]>;
  /** Resolves by id or slug; null when absent OR the caller is not a member (§12.1). */
  getFullWorkspace(headers: Headers, candidate: string): Promise<FullWorkspace | null>;
  createWorkspace(headers: Headers, body: { name: string; slug: string; userId?: string }): Promise<WorkspaceSummary>;
  updateWorkspace(
    headers: Headers,
    body: { organizationId: string; data: { name?: string; slug?: string; metadata?: unknown } },
  ): Promise<WorkspaceSummary>;
  inviteMember(headers: Headers, body: { organizationId: string; email: string; role: string }): Promise<InviteInfo>;
  acceptInvitation(headers: Headers, invitationId: string): Promise<AcceptedInviteInfo>;
  checkSlug(headers: Headers, slug: string): Promise<{ available: boolean }>;
}

// ---------------------------------------------------------------------------
// Error mapping — better-auth APIError → typed GatewayError. Raw provider
// messages never reach the envelope; only well-known codes map to hints.
// ---------------------------------------------------------------------------

function apiErrorMessage(error: APIError): string {
  const body = (error as { body?: { message?: unknown } }).body;
  return typeof body?.message === "string" ? body.message : String(error.message ?? "auth error");
}

function throwFromAuthError(error: unknown): never {
  if (error instanceof APIError) {
    const status = error.statusCode;
    const message = apiErrorMessage(error);
    // §12.1: membership and existence are never confirmed to strangers.
    if (message.includes("USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION")) {
      throw new GatewayError("NOT_FOUND", "Workspace not found.", { status: 404 });
    }
    if (status === 404 || message.includes("_NOT_FOUND")) {
      const code = message.includes("INVITATION") ? "INVITE_NOT_FOUND" : "NOT_FOUND";
      throw new GatewayError(code, "That resource was not found.", { status: 404, hint: message });
    }
    if (status === 409) {
      throw new GatewayError("CONFLICT", "That request conflicted with the current state.", { status: 409, hint: message });
    }
    if (status === 403 || message.includes("YOU_ARE_NOT")) {
      if (message.includes("RECIPIENT")) {
        throw new GatewayError("INVITE_RECIPIENT_MISMATCH", "This invite was issued to a different email.", { status: 403 });
      }
      throw new GatewayError("FORBIDDEN", "You don't have permission to do that.", {
        status: 403,
        hint: "Ask a workspace admin for access.",
      });
    }
    if (status === 400 || status === 422) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", { status: 400, hint: message });
    }
    throw new GatewayError("INTERNAL", "Something went wrong on our side.", { status: 500, cause: error });
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Narrow structural access to the plugin endpoints
// ---------------------------------------------------------------------------

type AnyEndpoint = (opts: Record<string, unknown>) => Promise<unknown>;

interface AuthEndpointSurface {
  readonly api: Record<string, AnyEndpoint>;
}

function endpoints(auth: Auth): AuthEndpointSurface["api"] {
  // Single confined cast: better-auth's plugin endpoints exist at runtime;
  // the widened `Auth` type (plugins generified away) cannot name them.
  return (auth as unknown as AuthEndpointSurface).api;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toWorkspaceSummary(raw: unknown): WorkspaceSummary {
  const record = asRecord(raw);
  const createdAt = record.createdAt;
  return {
    id: asString(record.id) ?? "",
    name: asString(record.name) ?? "",
    slug: asString(record.slug) ?? "",
    createdAt:
      typeof createdAt === "string" || typeof createdAt === "number" || createdAt instanceof Date
        ? new Date(createdAt as string | number | Date).toISOString()
        : null,
    metadata: record.metadata ?? null,
  };
}

/** Adapts a real `createAuth` instance to the gateway seam. */
export function adaptBetterAuth(auth: Auth): GatewayAuth {
  const api = endpoints(auth);

  async function call<T>(name: string, opts: Record<string, unknown>): Promise<T> {
    const endpoint = api[name];
    if (typeof endpoint !== "function") {
      throw new GatewayError("INTERNAL", "Something went wrong on our side.", {
        status: 500,
        cause: new Error(`better-auth endpoint missing: ${name}`),
      });
    }
    try {
      return (await endpoint(opts)) as T;
    } catch (error) {
      throwFromAuthError(error);
    }
  }

  return {
    handler: (request) => auth.handler(request),

    async getSession(headers) {
      const result = await auth.api.getSession({ headers });
      if (result === null || result === undefined) return null;
      const { session, user } = result as unknown as {
        session: Record<string, unknown>;
        user: Record<string, unknown>;
      };
      return {
        user: {
          id: asString(user.id) ?? "",
          name: asString(user.name),
          email: asString(user.email) ?? "",
        },
        session: {
          id: asString(session.id) ?? "",
          userId: asString(session.userId) ?? "",
          activeOrganizationId: asString(session.activeOrganizationId),
        },
      };
    },

    async listOrganizations(headers) {
      const raw = await call<unknown>("listOrganizations", { headers });
      const list = Array.isArray(raw) ? raw : [];
      return list.map((entry) => {
        // /organization/list entries carry { organization, role } pairs.
        const record = asRecord(entry);
        return toWorkspaceSummary(record.organization ?? record);
      });
    },

    async getFullWorkspace(headers, candidate) {
      const isSlug = !candidate.startsWith("org_");
      let raw: unknown;
      try {
        raw = await call<unknown>("getFullOrganization", {
          headers,
          query: isSlug ? { organizationSlug: candidate } : { organizationId: candidate },
        });
      } catch (error) {
        // ORGANIZATION_NOT_FOUND → null (404 upstream, §12.1).
        if (error instanceof GatewayError && error.code === "NOT_FOUND") return null;
        throw error;
      }
      if (raw === null || raw === undefined) return null;
      const record = asRecord(raw);
      const membersRaw = Array.isArray(record.members) ? record.members : [];
      const members: WorkspaceMemberInfo[] = membersRaw.map((entry) => {
        const m = asRecord(entry);
        const u = asRecord(m.user);
        return {
          userId: asString(m.userId) ?? "",
          role: asString(m.role) ?? "viewer",
          userName: asString(u.name),
          userEmail: asString(u.email),
        };
      });
      return { organization: toWorkspaceSummary(record.organization ?? record), members };
    },

    async createWorkspace(headers, body) {
      const raw = await call<unknown>("createOrganization", { headers, body });
      return toWorkspaceSummary(raw);
    },

    async updateWorkspace(headers, body) {
      const raw = await call<unknown>("updateOrganization", { headers, body });
      return toWorkspaceSummary(raw);
    },

    async inviteMember(headers, body) {
      const raw = await call<unknown>("inviteMember", { headers, body });
      const record = asRecord(raw);
      const expiresAt = record.expiresAt;
      return {
        id: asString(record.id) ?? "",
        organizationId: asString(record.organizationId) ?? "",
        email: asString(record.email) ?? "",
        role: asString(record.role) ?? "viewer",
        status: asString(record.status) ?? "pending",
        expiresAt:
          typeof expiresAt === "string" || typeof expiresAt === "number" || expiresAt instanceof Date
            ? new Date(expiresAt as string | number | Date).toISOString()
            : null,
      };
    },

    async acceptInvitation(headers, invitationId) {
      const raw = await call<unknown>("acceptInvitation", { headers, body: { invitationId } });
      const record = asRecord(raw);
      const invitation = asRecord(record.invitation);
      const member = asRecord(record.member);
      return {
        inviteId: asString(invitation.id) ?? invitationId,
        organizationId: asString(member.organizationId) ?? asString(invitation.organizationId) ?? "",
        role: asString(member.role) ?? "viewer",
      };
    },

    async checkSlug(headers, slug) {
      const raw = await call<unknown>("checkSlug", { headers, query: { slug } });
      const record = asRecord(raw);
      // /organization/check-slug returns { status: false } when taken.
      return { available: record.status !== false };
    },
  };
}
