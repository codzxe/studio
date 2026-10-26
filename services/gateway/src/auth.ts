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
  /**
   * Staff role from better-auth (the admin plugin's column): 'admin' marks a
   * platform admin and gates the TOP pricing tier everywhere (plan.ts). null /
   * 'user' for regular accounts. Optional so test fakes stay valid.
   */
  readonly role?: string | null;
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

/**
 * W1-b — the result of minting an API key (better-auth apiKey plugin server
 * API). `key` is the PLAINTEXT key and crosses this seam exactly ONCE (the
 * plugin hashes it at rest and never returns it again).
 */
export interface ApiKeyMintResult {
  readonly id: string;
  readonly name: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly enabled: boolean;
  /** First characters of the key (prefix included) for UI identification. */
  readonly start: string | null;
  readonly key: string;
}

/** The auth surface the gateway consumes. */
export interface GatewayAuth {
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthContext | null>;
  listOrganizations(headers: Headers): Promise<readonly WorkspaceSummary[]>;
  /** Resolves by id or slug; null when absent OR the caller is not a member (§12.1). */
  getFullWorkspace(headers: Headers, candidate: string): Promise<FullWorkspace | null>;
  createWorkspace(
    headers: Headers,
    body: { name: string; slug: string; userId?: string },
  ): Promise<WorkspaceSummary>;
  updateWorkspace(
    headers: Headers,
    body: { organizationId: string; data: { name?: string; slug?: string; metadata?: unknown } },
  ): Promise<WorkspaceSummary>;
  inviteMember(
    headers: Headers,
    body: { organizationId: string; email: string; role: string },
  ): Promise<InviteInfo>;
  acceptInvitation(headers: Headers, invitationId: string): Promise<AcceptedInviteInfo>;
  checkSlug(headers: Headers, slug: string): Promise<{ available: boolean }>;
  // ── W1-b (§M1 tasks 1+2, AUD-1 gap #2): workspace API keys ────────────────
  /**
   * Mint a workspace API key via the apiKey plugin server API (hashing,
   * show-once plaintext and `enabled: true` are the plugin's). The caller
   * (route) has ALREADY enforced the owner/admin capability + workspace
   * membership; the seam only carries the plugin's server-only fields.
   */
  createWorkspaceApiKey(input: {
    readonly userId: string;
    readonly workspaceId: string;
    readonly name: string;
    /** Lifetime in seconds; null = never expires. */
    readonly expiresInSeconds: number | null;
    /** Better-auth access-control statements (see @studio/contracts api-keys). */
    readonly statements: Record<string, string[]>;
  }): Promise<ApiKeyMintResult>;
  /**
   * Revoke (disable) a key via the plugin's server-only `userId` ownership
   * path: `referenceId` is the KEY's minting user, not the caller — the
   * route did the authorization and the workspace-binding tenant gate.
   * Revoked keys fail every later verification (401).
   */
  revokeApiKey(keyId: string, referenceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error mapping — better-auth APIError → typed GatewayError. Raw provider
// messages never reach the envelope; only well-known failures map to hints.
//
// W3-gw bugfix: better-auth 1.7.12 throws HUMAN messages ("Organization not
// found", "User is not a member of the organization"), not the UPPER_SNAKE
// code names the original mapping matched — so membership/existence leaks
// surfaced as 400 VALIDATION_FAILED instead of the §12.1 404. Match phrases,
// case-insensitively.
// ---------------------------------------------------------------------------

function apiErrorMessage(error: APIError): string {
  const body = (error as { body?: { message?: unknown } }).body;
  return typeof body?.message === "string" ? body.message : String(error.message ?? "auth error");
}

function throwFromAuthError(error: unknown): never {
  if (error instanceof APIError) {
    const status = error.statusCode;
    const message = apiErrorMessage(error);
    const lower = message.toLowerCase();
    // §12.1: membership and existence are never confirmed to strangers —
    // both the missing-workspace and the not-a-member failures read as 404.
    if (lower.includes("invitation not found")) {
      throw new GatewayError("INVITE_NOT_FOUND", "That invite is no longer available.", {
        status: 404,
      });
    }
    if (
      lower.includes("user is not a member of the organization") ||
      lower.includes("organization not found")
    ) {
      throw new GatewayError("NOT_FOUND", "Workspace not found.", { status: 404 });
    }
    if (lower.includes("slug already taken")) {
      throw new GatewayError("CONFLICT", "That workspace slug is taken.", {
        status: 409,
        hint: "Pick a different slug.",
      });
    }
    if (lower.includes("recipient of the invitation")) {
      throw new GatewayError(
        "INVITE_RECIPIENT_MISMATCH",
        "This invite was issued to a different email.",
        { status: 403 },
      );
    }
    if (status === 404) {
      throw new GatewayError("NOT_FOUND", "That resource was not found.", {
        status: 404,
        hint: message,
      });
    }
    if (status === 409) {
      throw new GatewayError("CONFLICT", "That request conflicted with the current state.", {
        status: 409,
        hint: message,
      });
    }
    if (status === 403 || lower.includes("you are not")) {
      throw new GatewayError("FORBIDDEN", "You don't have permission to do that.", {
        status: 403,
        hint: "Ask a workspace admin for access.",
      });
    }
    if (status === 400 || status === 422) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: message,
      });
    }
    throw new GatewayError("INTERNAL", "Something went wrong on our side.", {
      status: 500,
      cause: error,
    });
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

/** ISO-string view of a possibly-absent date field from a plugin row. */
function asIsoDate(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) {
    return new Date(value as string | number | Date).toISOString();
  }
  return null;
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
      let result: unknown;
      try {
        result = await auth.api.getSession({ headers });
      } catch (error) {
        // W1-b: with the apiKey plugin's session hook enabled, an invalid,
        // revoked or expired `Authorization: Bearer <key>` makes better-auth
        // throw an APIError out of getSession. That is a NEGATIVE auth
        // result, not a server failure: return null so requireAuth renders
        // 401 AUTH_REQUIRED (a valid cookie session, if any, still wins via
        // the header-stripped retry below). Cookie-only requests rethrow —
        // infrastructure failures must stay loud.
        if (headers.get("authorization") !== null && error instanceof APIError) {
          const withoutBearer = new Headers(headers);
          withoutBearer.delete("authorization");
          try {
            result = await auth.api.getSession({ headers: withoutBearer });
          } catch {
            return null;
          }
          if (result === null || result === undefined) return null;
        } else {
          throw error;
        }
      }
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
          role: asString(user.role),
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
      // W3-gw bugfix: better-auth 1.7.12 generates 32-char random org ids
      // (e.g. "L5aBWdZBmJ36vTtxK6pwzR8n471hm1MQ"), so the previous
      // startsWith("org_") id-vs-slug heuristic classified EVERY id as a
      // slug and every workspace-by-id resolution failed. Try the id first,
      // then fall back to the slug; a missing org AND a non-member both read
      // as null so the middleware renders the §12.1 404 (never a leak).
      let raw: unknown;
      try {
        raw = await call<unknown>("getFullOrganization", {
          headers,
          query: { organizationId: candidate },
        });
      } catch (error) {
        if (error instanceof GatewayError && error.code === "NOT_FOUND") {
          try {
            raw = await call<unknown>("getFullOrganization", {
              headers,
              query: { organizationSlug: candidate },
            });
          } catch (again) {
            if (again instanceof GatewayError && again.code === "NOT_FOUND") return null;
            throw again;
          }
        } else {
          throw error;
        }
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
      // W3-gw bugfix: better-auth 1.7.12 exposes invite creation as
      // `createInvitation` (POST /organization/invite-member) — the previously
      // used `inviteMember` does not exist on the installed api surface, so
      // every POST /v1/workspaces/:id/invites failed with INTERNAL. Body and
      // response shapes are identical (id, email, role, organizationId,
      // status, expiresAt).
      const raw = await call<unknown>("createInvitation", { headers, body });
      const record = asRecord(raw);
      const expiresAt = record.expiresAt;
      return {
        id: asString(record.id) ?? "",
        organizationId: asString(record.organizationId) ?? "",
        email: asString(record.email) ?? "",
        role: asString(record.role) ?? "viewer",
        status: asString(record.status) ?? "pending",
        expiresAt:
          typeof expiresAt === "string" ||
          typeof expiresAt === "number" ||
          expiresAt instanceof Date
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
        organizationId:
          asString(member.organizationId) ?? asString(invitation.organizationId) ?? "",
        role: asString(member.role) ?? "viewer",
      };
    },

    async checkSlug(headers, slug) {
      // W3-gw bugfix: better-auth 1.7.12 exposes the slug check as
      // `checkOrganizationSlug` (POST /organization/check-slug, slug in the
      // body) — the previously used `checkSlug` does not exist on the
      // installed api surface, so POST /v1/workspaces always failed with
      // INTERNAL. The endpoint returns { status: true } for a free slug and
      // throws "Organization slug already taken" for a taken one (mapped by
      // throwFromAuthError to 409 CONFLICT); fold both into the { available }
      // seam so the route renders its typed 409.
      try {
        const raw = await call<unknown>("checkOrganizationSlug", { headers, body: { slug } });
        const record = asRecord(raw);
        return { available: record.status !== false };
      } catch (error) {
        if (error instanceof GatewayError && error.status === 409) {
          return { available: false };
        }
        throw error;
      }
    },

    // ── W1-b: workspace API keys (better-auth apiKey plugin server API) ─────
    async createWorkspaceApiKey(input) {
      // Server-to-server call (no request headers): the plugin accepts its
      // server-only fields on this path — `userId` (minting user → the
      // user-referenced row that the Bearer session hook resolves), the
      // native `permissions` statements (scope enforcement) and the
      // workspace-binding `metadata`. `rateLimitEnabled: false` is the
      // documented W1-b posture: the plugin's default is 10 requests/day per
      // key while the gateway already applies §7.3 per-IP route-class
      // buckets; `lastUsedAt` (last_request) is still tracked on every verify.
      // The `studio_` prefix makes keys identifiable on sight and feeds the
      // plugin's `start` column for the UI.
      const raw = await call<unknown>("createApiKey", {
        body: {
          userId: input.userId,
          name: input.name,
          expiresIn: input.expiresInSeconds,
          permissions: input.statements,
          metadata: { workspaceId: input.workspaceId, createdBy: input.userId },
          prefix: "studio_",
          rateLimitEnabled: false,
        },
      });
      const record = asRecord(raw);
      return {
        id: asString(record.id) ?? "",
        name: asString(record.name),
        createdAt: asIsoDate(record.createdAt) ?? new Date().toISOString(),
        expiresAt: asIsoDate(record.expiresAt),
        enabled: record.enabled !== false,
        start: asString(record.start),
        key: asString(record.key) ?? "",
      };
    },

    async revokeApiKey(keyId, referenceId) {
      // Server-side disable via the plugin's update endpoint — its ownership
      // check (referenceId match) is satisfied by passing the KEY's minting
      // user; the workspace-admin authorization already happened in the
      // route (§12.1 tenant gate via the apiKeys repo). The plugin hard-fails
      // verification for disabled keys, so revoke is effective immediately.
      await call<unknown>("updateApiKey", {
        body: { keyId, userId: referenceId, enabled: false },
      });
    },
  };
}
