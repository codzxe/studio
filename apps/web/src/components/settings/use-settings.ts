"use client";

// apps/web — settings data hooks (W8-L). The ONLY module the settings tabs
// use for server state: workspace detail/rename/brand-tokens, members,
// invites, and API keys. Two transports, both served by the gateway (§13):
//
//   REST /v1/* via src/lib/api.ts — the §13.1 surface owned by W4-E:
//     GET    /workspaces/:id                     read (any member)
//     PATCH  /workspaces/:id                     rename / brand_tokens (admin+)
//     GET    /workspaces/:id/members             list members (admin+)
//     DELETE /workspaces/:id/members/:userId     remove (admin+; last-owner 409)
//     GET    /workspaces/:id/invites             list invites (admin+)
//     POST   /workspaces/:id/invites             create invite (admin+)
//     DELETE /workspaces/:id/invites/:inviteId   cancel (admin+)
//     {GET,POST} /workspaces/:id/api-keys        PLANNED — see the API KEYS
//     PATCH|DELETE /api-keys/:id                 note below (§15.2 flags)
//
//   Better Auth /api/auth/* via the W8-B authClient (src/lib/auth.ts) — the
//   §13.1 `POST /v1/auth/*` surface (organisations + invites + keys):
//     organization.getFullOrganization           member display names/emails
//     organization.updateMemberRole               role change (admin+, enforced
//                                               by the plugin's AC — no gateway
//                                               route exists; member:update)
//     organization.deleteOrganization            owner-only workspace delete
//     organization.leaveOrganization              self-remove with last-owner
//                                               protection (server-enforced)
//   Client call shapes verified against better-auth 1.2.12 + 1.6.4 dists
//   (flat body, camelCase action names) — same verification stance as the
//   invite page (W8-B).
//
// API KEYS — HONEST STATE (§15.2): the Better Auth apiKey plugin is mounted
// server-side, but (a) @studio/db's api_key table lacks the plugin's
// prefix/config_id/request_count/refill_* columns (W4-A gap), so NO plugin
// key endpoint works yet, and (b) the plugin's create endpoint refuses
// `permissions` (scopes) from browser requests entirely — server-only
// property. Keys therefore MUST be minted by a gateway route that calls
// auth.api.createApiKey server-side with buildApiKeyScopes (W4-A design).
// These hooks target that planned REST contract (flagged for the gateway
// owner); until it lands the API-keys tab renders its typed "not available
// yet" state instead of pretending.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { z } from "zod";
import {
  ApiError,
  createGatewayClientFromEnv,
  isApiError,
  type GatewayClient,
} from "@/lib/api";
import { authClient, toAuthFormError } from "@/lib/auth";
import { coerceBrandTokens, type BrandTokens } from "./brand-model";

// ---------------------------------------------------------------------------
// Wire schemas (zod at every boundary; mirrors of apps/gateway/src/openapi.ts)
// ---------------------------------------------------------------------------

/** §15.2 RBAC ladder (openapi ROLE_ENUM; ADR-0003). */
export const workspaceRoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/** Roles an invite may carry (§13.1: never owner; routes/workspaces.ts). */
export const invitableRoleSchema = z.enum(["admin", "editor", "viewer"]);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

/** openapi WorkspaceDetail — GET/PATCH /v1/workspaces/:id body. */
const workspaceDetailSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string(),
  logo: z.string().nullable(),
  brand_tokens: z.record(z.string(), z.unknown()),
  created_at: z.coerce.date(),
});

const workspaceResponseSchema = z.object({
  ok: z.literal(true),
  workspace: workspaceDetailSchema,
  role: workspaceRoleSchema,
});

const patchWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  workspace: workspaceDetailSchema,
});

/**
 * openapi MemberView. NOTE(flag → gateway owner): the wire contract today is
 * { id, user_id, role, created_at } (services/workspaces.ts toMemberView) —
 * name/email are accepted here as OPTIONAL so the settings table can show
 * them the moment the view is extended with a users join (see members
 * fallback: display names come from the Better Auth directory meanwhile).
 */
const memberSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  role: workspaceRoleSchema,
  created_at: z.coerce.date(),
  name: z.string().optional(),
  email: z.string().optional(),
});

const membersResponseSchema = z.object({
  ok: z.literal(true),
  members: z.array(memberSchema),
});

/** openapi InviteView (token == invitation id until the email wave, W4-E). */
const inviteSchema = z.object({
  token: z.string().min(1),
  organization_id: z.string().min(1),
  organization_name: z.string(),
  email: z.string(),
  role: invitableRoleSchema,
  status: z.enum(["pending", "accepted", "canceled", "rejected"]),
  expires_at: z.coerce.date(),
});

const invitesResponseSchema = z.object({
  ok: z.literal(true),
  invites: z.array(inviteSchema),
});

const createInviteResponseSchema = z.object({
  ok: z.literal(true),
  invite: inviteSchema,
});

/** Generic `{ ok: true }` ack (DELETE endpoints). */
const okResponseSchema = z.object({ ok: z.literal(true) });

/**
 * API-key wire contract (PLANNED gateway routes — flagged above and in the
 * worklog; §15.2: scoped, revocable, last-used metadata, per-key rate limits).
 * `scopes` echoes the §15.2 vocabulary (documents:read | documents:write |
 * runs:create | exports:create) plus the reserved org:<id> binding entry.
 */
export const API_KEY_SCOPES = [
  "documents:read",
  "documents:write",
  "runs:create",
  "exports:create",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const apiKeySchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  enabled: z.boolean(),
  created_at: z.coerce.date(),
  last_used_at: z.coerce.date().nullable(),
  scopes: z.array(z.string()),
});

const apiKeysResponseSchema = z.object({
  ok: z.literal(true),
  api_keys: z.array(apiKeySchema),
});

const createApiKeyResponseSchema = z.object({
  ok: z.literal(true),
  api_key: apiKeySchema,
  /** The raw key — shown ONCE at creation (§15.2; never stored or re-fetched). */
  key: z.string().min(1),
});

const updateApiKeyResponseSchema = z.object({
  ok: z.literal(true),
  api_key: apiKeySchema,
});

// ---------------------------------------------------------------------------
// Better Auth directory schema (getFullOrganization — member + user join)
// ---------------------------------------------------------------------------

/**
 * Defensive mirror of the organization plugin's full-org payload (verified
 * against better-auth 1.2.12/1.6.4 dists: members carry `user` with name +
 * email). Parsed loosely (passthrough, nullish) — plugin payloads are typed
 * from client inference only (W8-B typing note) and must never be trusted.
 */
const directoryMemberSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    role: z.string().min(1),
    createdAt: z.coerce.date(),
    user: z
      .object({
        id: z.string().min(1),
        name: z.string().nullish(),
        email: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const directorySchema = z
  .object({
    id: z.string().min(1),
    members: z.array(directoryMemberSchema),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

/** Workspace read model for the settings tabs. */
export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  /** Caller's role in this workspace (§15.2 guards). */
  readonly role: WorkspaceRole;
  /** Leniently coerced brand tokens (§7.5 fallback; brand-model.ts). */
  readonly brandTokens: BrandTokens;
}

/** One member row for the table (gateway MemberView ∪ directory names). */
export interface MemberRow {
  /** Member row id — the join key across both sources. */
  readonly id: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly joinedAt: Date;
  readonly name: string | null;
  readonly email: string | null;
}

export interface InviteRow {
  readonly token: string;
  readonly email: string;
  readonly role: InvitableRole;
  readonly status: "pending" | "accepted" | "canceled" | "rejected";
  readonly expiresAt: Date;
}

export interface ApiKeyRow {
  readonly id: string;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly scopes: readonly string[];
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const settingsKeys = {
  all: ["settings"] as const,
  workspace: (workspaceId: string | null) => [...settingsKeys.all, "workspace", workspaceId] as const,
  members: (workspaceId: string | null) => [...settingsKeys.all, "members", workspaceId] as const,
  invites: (workspaceId: string | null) => [...settingsKeys.all, "invites", workspaceId] as const,
  directory: (workspaceId: string | null) => [...settingsKeys.all, "directory", workspaceId] as const,
  apiKeys: (workspaceId: string | null) => [...settingsKeys.all, "api-keys", workspaceId] as const,
};

// ---------------------------------------------------------------------------
// Gateway client (lazy singleton — env parsing must not run at build time)
// ---------------------------------------------------------------------------

let clientRef: GatewayClient | undefined;

/** One browser-session gateway client (src/lib/env.ts lazy-parse note). */
function gateway(): GatewayClient {
  clientRef ??= createGatewayClientFromEnv();
  return clientRef;
}

// ---------------------------------------------------------------------------
// Errors → view models (§13.3: message + hint, never internals)
// ---------------------------------------------------------------------------

export interface SettingsError {
  readonly code: string;
  readonly message: string;
  readonly hint: string | undefined;
  readonly retryable: boolean;
}

/**
 * Normalize any failure into a display envelope. ApiError carries the
 * gateway's flat envelope already; anything else (ZodError drift, auth
 * errors, thrown strings) collapses to a generic message so internals never
 * reach the UI (§13.3). Local twin of documents/use-documents.ts
 * toErrorEnvelope — kept per feature module, both must stay aligned.
 */
export function toSettingsError(error: unknown): SettingsError {
  if (isApiError(error)) {
    return { code: error.code, message: error.message, hint: error.hint, retryable: error.retryable };
  }
  return {
    code: "unexpected_error",
    message: "Something went wrong on our side.",
    hint: "Please try again in a moment.",
    retryable: true,
  };
}

interface AuthErrorLike {
  readonly status?: unknown;
}

/**
 * Better Auth client failures → ApiError, so every settings error renders
 * through one envelope. The message/code/hint come from toAuthFormError
 * (W8-B, §15.2-safe copy); the HTTP status is kept when the better-fetch
 * error object carries it (forbidden detection in members-table).
 */
function authFailure(error: unknown): ApiError {
  const form = toAuthFormError(error);
  const raw = typeof error === "object" && error !== null ? (error as AuthErrorLike).status : null;
  const status = typeof raw === "number" && Number.isInteger(raw) ? raw : 0;
  return new ApiError({
    code: form.code,
    message: form.message,
    hint: form.hint,
    status,
    retryable: false,
  });
}

/**
 * True when an API-key call failed because the planned gateway routes are not
 * implemented yet (404 / unexpected_response from Hono's default 404). The
 * tab shows its "not available yet" explainer instead of a scary error.
 */
export function isApiKeysUnavailable(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.code === "unexpected_response");
}

// ---------------------------------------------------------------------------
// Role helpers (§15.2 ladder; ADR-0003 matrix)
// ---------------------------------------------------------------------------

const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/** The §15.2 ladder as display rows (highest first). */
export const ROLE_LADDER: readonly WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

/** admin+ (members, invites, billing) — the settings management floor. */
export function canManageWorkspace(role: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}

export function isWorkspaceOwner(role: WorkspaceRole): boolean {
  return role === "owner";
}

export const ROLE_DESCRIPTIONS: Readonly<Record<WorkspaceRole, string>> = {
  owner: "Full control of the workspace, including billing and deletion.",
  admin: "Manage members, brand and invites.",
  editor: "Run the agent and edit documents.",
  viewer: "View and comment on documents.",
};

/** One-line invitation copy for each invitable role (§13.1: never owner). */
export const INVITABLE_ROLE_OPTIONS: readonly { role: InvitableRole; label: string }[] = [
  { role: "admin", label: "Admin — manage members, brand and invites" },
  { role: "editor", label: "Editor — run the agent and edit documents" },
  { role: "viewer", label: "Viewer — view and comment only" },
];

// ---------------------------------------------------------------------------
// Formatting (deterministic; dashboard-view.tsx precedent)
// ---------------------------------------------------------------------------

const DATE_FORMAT = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** "Mar 4, 2025" — for joined/created columns. */
export function formatDate(value: Date | string | null): string {
  if (value === null) {
    return "—";
  }
  const date = typeof value === "string" ? new Date(value) : value;
  return DATE_FORMAT.format(date);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** GET /v1/workspaces/:id — any member; carries the caller's role (§15.2). */
export function useWorkspace(workspaceId: string | null) {
  const query = useQuery({
    queryKey: settingsKeys.workspace(workspaceId),
    enabled: workspaceId !== null,
    queryFn: async (): Promise<WorkspaceView> => {
      const response = await gateway().get(
        `/workspaces/${encodeURIComponent(workspaceId as string)}`,
        { schema: workspaceResponseSchema },
      );
      return {
        id: response.workspace.id,
        name: response.workspace.name,
        slug: response.workspace.slug,
        createdAt: response.workspace.created_at,
        role: response.role,
        brandTokens: coerceBrandTokens(response.workspace.brand_tokens),
      };
    },
  });
  return {
    workspace: query.data ?? null,
    status: query.isPending ? ("loading" as const) : query.isError ? ("error" as const) : ("ready" as const),
    message: query.isError ? toSettingsError(query.error).message : null,
    error: query.isError ? toSettingsError(query.error) : null,
    refetch: query.refetch,
  };
}

/**
 * GET /v1/workspaces/:id/members — admin+ (§15.2). Viewers/editers receive a
 * typed forbidden envelope; the members table degrades to the Better Auth
 * directory (any member can read it) with management actions hidden.
 */
export function useMembers(workspaceId: string | null) {
  return useQuery({
    queryKey: settingsKeys.members(workspaceId),
    enabled: workspaceId !== null,
    queryFn: async (): Promise<readonly MemberRow[]> => {
      const response = await gateway().get(
        `/workspaces/${encodeURIComponent(workspaceId as string)}/members`,
        { schema: membersResponseSchema },
      );
      return response.members.map((member) => ({
        id: member.id,
        userId: member.user_id,
        role: member.role,
        joinedAt: member.created_at,
        name: member.name ?? null,
        email: member.email ?? null,
      }));
    },
  });
}

/** GET /v1/workspaces/:id/invites — admin+ (all statuses; pending first). */
export function useInvites(workspaceId: string | null) {
  return useQuery({
    queryKey: settingsKeys.invites(workspaceId),
    enabled: workspaceId !== null,
    queryFn: async (): Promise<readonly InviteRow[]> => {
      const response = await gateway().get(
        `/workspaces/${encodeURIComponent(workspaceId as string)}/invites`,
        { schema: invitesResponseSchema },
      );
      return response.invites.map((invite) => ({
        token: invite.token,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expires_at,
      }));
    },
  });
}

/**
 * Member display directory via Better Auth (getFullOrganization) — the
 * members⇄users join the §13.1 MemberView does not carry yet. Any member of
 * the workspace can read it (plugin membership check); failures degrade to
 * masked user ids in the table, never a dead tab.
 */
export function useMemberDirectory(workspaceId: string | null) {
  return useQuery({
    queryKey: settingsKeys.directory(workspaceId),
    enabled: workspaceId !== null,
    queryFn: async (): Promise<ReadonlyMap<string, MemberRow>> => {
      const { data, error } = await authClient.organization.getFullOrganization({
        query: { organizationId: workspaceId as string },
      });
      if (error !== null && error !== undefined) {
        throw authFailure(error);
      }
      const parsed = directorySchema.safeParse(data);
      if (!parsed.success) {
        throw new ApiError({
          code: "unexpected_response",
          message: "The member directory could not be read.",
          status: 0,
          retryable: false,
        });
      }
      const rows = new Map<string, MemberRow>();
      for (const member of parsed.data.members) {
        rows.set(member.id, {
          id: member.id,
          userId: member.userId,
          role: workspaceRoleSchema.parse(member.role),
          joinedAt: member.createdAt,
          name: member.user?.name ?? null,
          email: member.user?.email ?? null,
        });
      }
      return rows;
    },
  });
}

/**
 * GET /v1/workspaces/:id/api-keys — PLANNED route (see file header). No
 * retry: a 404 today is the known not-implemented state, not a blip.
 */
export function useApiKeys(workspaceId: string | null) {
  return useQuery({
    queryKey: settingsKeys.apiKeys(workspaceId),
    enabled: workspaceId !== null,
    retry: false,
    queryFn: async (): Promise<readonly ApiKeyRow[]> => {
      const response = await gateway().get(
        `/workspaces/${encodeURIComponent(workspaceId as string)}/api-keys`,
        { schema: apiKeysResponseSchema },
      );
      return response.api_keys.map((key) => ({
        id: key.id,
        name: key.name,
        enabled: key.enabled,
        createdAt: key.created_at,
        lastUsedAt: key.last_used_at,
        scopes: key.scopes,
      }));
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations — workspace (PATCH /v1/workspaces/:id; W4-E contract)
// ---------------------------------------------------------------------------

export interface UpdateWorkspaceInput {
  /** Trimmed 1..120 chars (routes/workspaces.ts patchWorkspaceSchema). */
  readonly name?: string;
  /** Canonical BrandTokens (brand-model.ts save gate). */
  readonly brandTokens?: BrandTokens;
}

/** PATCH /v1/workspaces/:id — rename and/or save brand tokens (admin+). */
export function useUpdateWorkspace(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateWorkspaceInput): Promise<WorkspaceView["name"]> => {
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) {
        body.name = input.name;
      }
      if (input.brandTokens !== undefined) {
        // §7.5/§10.2: the gateway stores the record opaquely; the agent
        // consumes it as BrandTokens (packages/agent/src/brand/tokens.ts).
        body.brand_tokens = input.brandTokens;
      }
      const response = await gateway().request(
        `/workspaces/${encodeURIComponent(workspaceId as string)}`,
        { method: "PATCH", body, schema: patchWorkspaceResponseSchema },
      );
      return response.workspace.name;
    },
    onSuccess: () => {
      // Workspace cache (role/name/brand) + the shell's workspace switcher.
      void queryClient.invalidateQueries({ queryKey: settingsKeys.workspace(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ["session", "workspaces"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations — members & invites
// ---------------------------------------------------------------------------

/**
 * Role change via Better Auth (POST /organization/update-member-role) — the
 * plugin enforces member:update (admin+ per ADR-0003) plus owner protections
 * server-side; no gateway route exists yet (flag for W4+ contract wave).
 */
export function useChangeMemberRole(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly memberId: string;
      readonly role: Exclude<WorkspaceRole, "owner">;
    }): Promise<void> => {
      const { error } = await authClient.organization.updateMemberRole({
        memberId: input.memberId,
        role: input.role,
        organizationId: workspaceId as string,
      });
      if (error !== null && error !== undefined) {
        throw authFailure(error);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.members(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.directory(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.workspace(workspaceId) });
    },
  });
}

/**
 * DELETE /v1/workspaces/:id/members/:userId — admin+; the gateway protects
 * the last owner (409 conflict envelope, W4-E removeMember).
 */
export function useRemoveMember(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string): Promise<void> => {
      await gateway().request(
        `/workspaces/${encodeURIComponent(workspaceId as string)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE", schema: okResponseSchema },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.members(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.directory(workspaceId) });
    },
  });
}

export interface CreateInviteInput {
  readonly email: string;
  readonly role: InvitableRole;
}

/** POST /v1/workspaces/:id/invites — admin+ (§13.1). */
export function useCreateInvite(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInviteInput): Promise<InviteRow> => {
      const response = await gateway().post(
        `/workspaces/${encodeURIComponent(workspaceId as string)}/invites`,
        { body: { email: input.email, role: input.role }, schema: createInviteResponseSchema },
      );
      return {
        token: response.invite.token,
        email: response.invite.email,
        role: response.invite.role,
        status: response.invite.status,
        expiresAt: response.invite.expires_at,
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.invites(workspaceId) });
    },
  });
}

/** DELETE /v1/workspaces/:id/invites/:inviteId — cancel (admin+). */
export function useCancelInvite(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteToken: string): Promise<void> => {
      await gateway().request(
        `/workspaces/${encodeURIComponent(workspaceId as string)}/invites/${encodeURIComponent(inviteToken)}`,
        { method: "DELETE", schema: okResponseSchema },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.invites(workspaceId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations — API keys (PLANNED routes; see file header)
// ---------------------------------------------------------------------------

export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
}

export interface CreatedApiKey {
  readonly row: ApiKeyRow;
  /** Raw key — lives ONLY in this value; the UI shows it once, then drops it. */
  readonly key: string;
}

/** POST /v1/workspaces/:id/api-keys — the key is returned ONCE (§15.2). */
export function useCreateApiKey(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateApiKeyInput): Promise<CreatedApiKey> => {
      const response = await gateway().post(
        `/workspaces/${encodeURIComponent(workspaceId as string)}/api-keys`,
        { body: { name: input.name, scopes: input.scopes }, schema: createApiKeyResponseSchema },
      );
      return {
        row: {
          id: response.api_key.id,
          name: response.api_key.name,
          enabled: response.api_key.enabled,
          createdAt: response.api_key.created_at,
          lastUsedAt: response.api_key.last_used_at,
          scopes: response.api_key.scopes,
        },
        key: response.key,
      };
    },
    onSuccess: () => {
      // NEVER cache the raw key: onSuccess receives it but only invalidates.
      void queryClient.invalidateQueries({ queryKey: settingsKeys.apiKeys(workspaceId) });
    },
  });
}

/** PATCH /v1/api-keys/:id — enable/disable (§15.2 revocable ⇒ enabled=false). */
export function useSetApiKeyEnabled(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }): Promise<void> => {
      await gateway().request(`/api-keys/${encodeURIComponent(input.id)}`, {
        method: "PATCH",
        body: { enabled: input.enabled },
        schema: updateApiKeyResponseSchema,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.apiKeys(workspaceId) });
    },
  });
}

/** DELETE /v1/api-keys/:id — permanent revoke (§15.4 audit server-side). */
export function useRevokeApiKey(workspaceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (keyId: string): Promise<void> => {
      await gateway().request(`/api-keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        schema: okResponseSchema,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.apiKeys(workspaceId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations — danger zone (Better Auth organization plugin, owner-aware)
// ---------------------------------------------------------------------------

/**
 * POST /organization/delete — owner-only (organization:delete grant, ADR-0003
 * matrix). Better Auth removes the organization + members + invitations; the
 * §15.4 document/asset wipe + audit entry are gateway-side jobs (flagged —
 * the UI copy must not promise them). Session caches are cleared and the app
 * returns to /dashboard, where the shell picks the next workspace.
 */
export function useDeleteWorkspace(workspaceId: string | null) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const { error } = await authClient.organization.deleteOrganization({
        organizationId: workspaceId as string,
      });
      if (error !== null && error !== undefined) {
        throw authFailure(error);
      }
    },
    onSuccess: () => {
      queryClient.clear(); // the workspace (and every scoped cache) is gone
      router.replace("/dashboard");
    },
  });
}

/**
 * POST /organization/leave — self-remove; the plugin refuses the last owner
 * (YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER). Same cache reset as
 * deletion: the caller is no longer a member of this workspace.
 */
export function useLeaveWorkspace(workspaceId: string | null) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const { error } = await authClient.organization.leaveOrganization({
        organizationId: workspaceId as string,
      });
      if (error !== null && error !== undefined) {
        throw authFailure(error);
      }
    },
    onSuccess: () => {
      queryClient.clear();
      router.replace("/dashboard");
    },
  });
}
