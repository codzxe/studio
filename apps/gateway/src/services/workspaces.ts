// Workspace / membership / invitation domain service (W4-E).
//
// Spec anchors:
//   §13.1  REST surface — POST /v1/workspaces, GET /v1/workspaces/:id, members,
//          invites, POST /v1/invites/:token/accept
//   §1.4/§14.1  one-time trial credit grant on workspace creation (no free tier)
//   §15.2  RBAC ladder enforced server-side: viewer (read) < editor (runs +
//          commands) < admin (billing/invites/members) < owner
//   §22    audit log appends for role changes, invites and deletes, with the
//          request id threaded through for `request_id → workspace_id` correlation
//
// SEAMS (all injected — buildApp deps-injection pattern; structural typing
// allowed per the W4-E task contract):
//   DbLike      — narrow storage seam over the auth schema tables. The real
//                 Drizzle adapter (createWorkspaceDb) is typed directly against
//                 the schema files' exports from @studio/db (organization,
//                 member, invitation, auditLog); tests fake the seam.
//   BillingLike — trial grant. Adapter: createLedgerBilling over @studio/billing's
//                 trialGrant (idempotency key `trial-grant:<orgId>` per §14.2 r6).
//   AuditLike   — §22 append-only audit log. Adapter: createDrizzleAudit over
//                 the auditLog table.
//
// W4-C (authz/guard.ts) reconciliation: `assertTenant` here mirrors the parallel
// guard contract (403 cross_tenant_denied for non-members, §15.1 scoping) and
// `assertCan` the §15.2 ladder. When W4-C's guard lands, W4-O can either keep
// these (they are the service-side truth over the member table) or adapt the
// guard's implementations to satisfy the same signatures.
//
// Known cross-schema note (flag for the schema owner, not fixable here):
// audit_log.organization_id / actor_id are uuid columns while Better Auth ids
// are free-form text — this service always mints uuid-shaped organization ids
// (newId defaults to randomUUID) so audit appends stay valid for the flows it
// owns; user ids from other auth flows must be uuid-shaped to be auditable.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, invitation, member, organization } from "@studio/db";
import type { Db } from "@studio/db";
import { trialGrant } from "@studio/billing";
import type { LedgerStore, TrialGrantOutcome } from "@studio/billing";
import type { Result } from "@studio/config";
import { AppError } from "../middleware/error-mapper.js";

// ---------------------------------------------------------------------------
// Schema-derived row types (typed against the schema files' exports)
// ---------------------------------------------------------------------------

export type WorkspaceRow = typeof organization.$inferSelect;
export type NewWorkspaceRow = typeof organization.$inferInsert;
export type MemberRow = typeof member.$inferSelect;
export type NewMemberRow = typeof member.$inferInsert;
export type InvitationRow = typeof invitation.$inferSelect;
export type NewInvitationRow = typeof invitation.$inferInsert;

/** RBAC roles per §15.2, derived from the member table enum. */
export type WorkspaceRole = MemberRow["role"];
/** §13.1 invites may grant admin/editor/viewer — never owner. */
export type InviteRole = Exclude<WorkspaceRole, "owner">;
export type InvitationStatus = InvitationRow["status"];

/** Actions the RBAC ladder gates (§15.2). */
export type WorkspaceAction =
  | "workspace.read"
  | "workspace.update"
  | "members.list"
  | "members.remove"
  | "invites.list"
  | "invites.create"
  | "invites.cancel";

// ---------------------------------------------------------------------------
// Pure RBAC + slug helpers
// ---------------------------------------------------------------------------

const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3
};

const ACTION_MIN_RANK: Readonly<Record<WorkspaceAction, number>> = {
  "workspace.read": 0,
  "workspace.update": 2,
  "members.list": 2,
  "members.remove": 2,
  "invites.list": 2,
  "invites.create": 2,
  "invites.cancel": 2
};

/**
 * §15.2 RBAC check. Throws the typed 403 `forbidden` envelope when the role is
 * below the action's minimum rank. Server-side on every endpoint — UI hiding
 * is not enforcement.
 */
export function assertCan(role: WorkspaceRole, action: WorkspaceAction): void {
  if (ROLE_RANK[role] < ACTION_MIN_RANK[action]) {
    throw new AppError(403, "forbidden", "Your workspace role does not allow this action.", {
      hint: "Owners and admins manage members, invites and workspace settings (§15.2).",
      retryable: false
    });
  }
}

/** Lowercase, dash-separated slug derived from a workspace name. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

// ---------------------------------------------------------------------------
// Storage / billing / audit seams (structural, injected)
// ---------------------------------------------------------------------------

/** One row of the "my workspaces" join (member ⋈ organization). */
export interface WorkspaceSummaryRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly role: WorkspaceRole;
}

/**
 * Narrow storage seam over the auth schema tables. The Drizzle adapter below
 * implements this against @studio/db's exported tables; tests implement it
 * with an in-memory fake (structural typing allowed).
 */
export interface DbLike {
  listWorkspacesForUser(userId: string): Promise<WorkspaceSummaryRow[]>;
  findWorkspace(workspaceId: string): Promise<WorkspaceRow | null>;
  findWorkspaceBySlug(slug: string): Promise<WorkspaceRow | null>;
  findMembership(userId: string, workspaceId: string): Promise<MemberRow | null>;
  listMembers(workspaceId: string): Promise<MemberRow[]>;
  /** userIds of the owner-role members (last-owner protection, §15.2). */
  listOwners(workspaceId: string): Promise<string[]>;
  insertOrganization(input: NewWorkspaceRow): Promise<WorkspaceRow>;
  insertMember(input: NewMemberRow): Promise<MemberRow>;
  deleteMember(workspaceId: string, userId: string): Promise<boolean>;
  updateOrganization(
    workspaceId: string,
    patch: { name?: string; metadata?: string }
  ): Promise<WorkspaceRow | null>;
  findInvitation(token: string): Promise<InvitationRow | null>;
  listInvitations(workspaceId: string): Promise<InvitationRow[]>;
  insertInvitation(input: NewInvitationRow): Promise<InvitationRow>;
  updateInvitationStatus(token: string, status: InvitationStatus): Promise<InvitationRow | null>;
}

/** §1.4/§14.1 trial grant seam (adapter: createLedgerBilling). */
export interface BillingLike {
  grantTrial(organizationId: string): Promise<Result<TrialGrantOutcome>>;
}

/** §22 audit append (immutable, append-only). */
export interface AuditEntry {
  readonly organizationId: string;
  readonly actorId: string | null;
  readonly action: string;
  /** Stable "<type>:<id>" so exports stay readable after the row is gone (§22). */
  readonly target: string;
  /** JSON-safe context; never secrets. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditLike {
  append(entry: AuditEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public view shapes (snake_case wire fields per §13 conventions)
// ---------------------------------------------------------------------------

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: WorkspaceRole;
  readonly created_at: string;
}

export interface WorkspaceDetail {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logo: string | null;
  readonly brand_tokens: Record<string, unknown>;
  readonly created_at: string;
}

export interface MemberView {
  readonly id: string;
  readonly user_id: string;
  readonly role: WorkspaceRole;
  readonly created_at: string;
}

export interface InviteView {
  /** The email token seam: today token == invitation.id (TODO(email), see routes). */
  readonly token: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly email: string;
  readonly role: InviteRole;
  readonly status: InvitationStatus;
  readonly expires_at: string;
}

export interface CreateWorkspaceResult {
  readonly workspace: WorkspaceDetail;
  readonly role: WorkspaceRole;
  readonly trial: {
    readonly granted: boolean;
    readonly credits: number;
    readonly duplicate: boolean;
  };
}

export interface AcceptInviteResult {
  readonly workspaceId: string;
  readonly role: InviteRole;
}

export interface TenantContext {
  readonly workspace: WorkspaceRow;
  readonly membership: MemberRow;
}

export interface InviteInput {
  readonly email: string;
  readonly role: InviteRole;
  readonly expiresInDays?: number;
}

export interface UpdateWorkspaceInput {
  readonly name?: string;
  readonly brandTokens?: Record<string, unknown>;
}

/** §22 correlation context threaded from the route layer into audit metadata. */
export interface CallContext {
  readonly requestId?: string;
  readonly idempotencyKey?: string;
}

export interface WorkspaceServiceDeps {
  readonly db: DbLike;
  readonly billing: BillingLike;
  readonly audit: AuditLike;
  /** Injectable clock (invite expiry, timestamps) — deterministic tests. */
  readonly clock?: () => Date;
  /** Id factory; must be uuid-shaped because audit_log ids/org ids are uuid columns. */
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Service API
// ---------------------------------------------------------------------------

export interface WorkspaceService {
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  createWorkspace(
    userId: string,
    input: { name: string; slug?: string },
    ctx?: CallContext
  ): Promise<CreateWorkspaceResult>;
  /** 403 cross_tenant_denied for non-members (§15.1), 404 when the row is gone. */
  assertTenant(userId: string, workspaceId: string): Promise<TenantContext>;
  getWorkspace(tenant: TenantContext): WorkspaceDetail;
  listMembers(tenant: TenantContext): Promise<MemberView[]>;
  listInvites(tenant: TenantContext): Promise<InviteView[]>;
  createInvite(tenant: TenantContext, input: InviteInput, ctx?: CallContext): Promise<InviteView>;
  /** Cancel by token; `workspaceId` additionally scopes org-addressed cancels. */
  cancelInvite(
    userId: string,
    ref: { token: string; workspaceId?: string },
    ctx?: CallContext
  ): Promise<void>;
  /** Pre-accept view by token (the "email link" target). */
  viewInvite(token: string): Promise<InviteView>;
  acceptInvite(userId: string, token: string, ctx?: CallContext): Promise<AcceptInviteResult>;
  /** Last-owner protection + owner-removes-owner rules (§15.2). */
  removeMember(tenant: TenantContext, targetUserId: string, ctx?: CallContext): Promise<void>;
  updateWorkspace(
    tenant: TenantContext,
    input: UpdateWorkspaceInput,
    ctx?: CallContext
  ): Promise<WorkspaceDetail>;
}

/** Default invitation TTL (schema requires a non-null `expires`). */
const INVITE_TTL_DAYS = 7;
const MAX_BRAND_TOKEN_KEYS = 128;
const MAX_METADATA_BYTES = 65_536;

function notFound(message: string, hint: string): AppError {
  return new AppError(404, "not_found", message, { hint, retryable: false });
}

function slugTaken(): AppError {
  return new AppError(409, "slug_taken", "That workspace slug is already in use.", {
    hint: "Pick a different slug or omit it to derive one from the name.",
    retryable: false
  });
}

function parseOrgMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const db = deps.db;
  const billing = deps.billing;
  const audit = deps.audit;
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  async function auditAppend(entry: AuditEntry, ctx?: CallContext): Promise<void> {
    const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    if (ctx?.requestId !== undefined && ctx.requestId !== "") {
      metadata.request_id = ctx.requestId; // §22: request_id → workspace_id correlation
    }
    if (ctx?.idempotencyKey !== undefined && ctx.idempotencyKey !== "") {
      metadata.idempotency_key = ctx.idempotencyKey;
    }
    await audit.append({ ...entry, metadata });
  }

  function toDetail(row: WorkspaceRow): WorkspaceDetail {
    const metadata = parseOrgMetadata(row.metadata);
    const brandTokens: unknown = metadata.brandTokens;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      logo: row.logo,
      brand_tokens:
        typeof brandTokens === "object" && brandTokens !== null
          ? (brandTokens as Record<string, unknown>)
          : {},
      created_at: row.createdAt.toISOString()
    };
  }

  function toMemberView(row: MemberRow): MemberView {
    return {
      id: row.id,
      user_id: row.userId,
      role: row.role,
      created_at: row.createdAt.toISOString()
    };
  }

  function toInviteView(row: InvitationRow, organizationName: string): InviteView {
    return {
      token: row.id, // TODO(email): token == invitation.id until the hashed-token/email seam lands
      organization_id: row.organizationId,
      organization_name: organizationName,
      email: row.email,
      role: row.role as InviteRole,
      status: row.status,
      expires_at: row.expires.toISOString()
    };
  }

  async function requireUsableInvitation(token: string): Promise<InvitationRow> {
    const invite = await db.findInvitation(token);
    if (invite === null) {
      throw notFound("Invitation not found.", "Check the invitation link or ask for a new one.");
    }
    const now = clock();
    if (invite.status !== "pending") {
      throw new AppError(409, "invite_unusable", "This invitation is no longer pending.", {
        hint: "Ask a workspace admin for a new invitation.",
        retryable: false
      });
    }
    if (invite.expires.getTime() < now.getTime()) {
      throw new AppError(409, "invite_expired", "This invitation has expired.", {
        hint: "Ask a workspace admin for a new invitation.",
        retryable: false
      });
    }
    return invite;
  }

  const service: WorkspaceService = {
    async listWorkspaces(userId) {
      const rows = await db.listWorkspacesForUser(userId);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        role: row.role,
        created_at: row.createdAt.toISOString()
      }));
    },

    async createWorkspace(userId, input, ctx) {
      // Slug: explicit (validated by the route) or derived; uniqueness via the
      // organization_slug_unique index — races surface as slug_taken below.
      let slug = input.slug;
      if (slug === undefined) {
        const base = slugify(input.name).slice(0, 56);
        slug = base;
        let attempt = 2;
        while (attempt <= 5 && (await db.findWorkspaceBySlug(slug)) !== null) {
          slug = `${base}-${attempt}`;
          attempt += 1;
        }
      }
      if ((await db.findWorkspaceBySlug(slug)) !== null) {
        throw slugTaken();
      }

      const workspaceId = newId();
      const workspaceRow = await db.insertOrganization({
        id: workspaceId,
        name: input.name,
        slug,
        logo: null,
        // metadata carries brandTokens until dedicated columns exist (schema note).
        metadata: JSON.stringify({ brandTokens: {} })
      });
      const memberRow = await db.insertMember({
        id: newId(),
        organizationId: workspaceId,
        userId,
        role: "owner"
      });

      // §22: audit the creation + the owner role assignment before billing so
      // the trail exists even if the trial grant fails.
      await auditAppend(
        {
          organizationId: workspaceId,
          actorId: userId,
          action: "workspace.created",
          target: `workspace:${workspaceId}`,
          metadata: { slug, name: input.name }
        },
        ctx
      );
      await auditAppend(
        {
          organizationId: workspaceId,
          actorId: userId,
          action: "member.created",
          target: `member:${memberRow.id}`,
          metadata: { user_id: userId, role: "owner", via: "workspace.create" }
        },
        ctx
      );

      // §1.4/§14.1: one-time 30-credit trial grant, idempotent per workspace
      // (ledger key `trial-grant:<orgId>`).
      const grant = await billing.grantTrial(workspaceId);
      if (!grant.ok) {
        throw new AppError(
          500,
          "internal_error",
          "The workspace was created but the trial grant failed.",
          { hint: "Contact support to apply the trial grant to this workspace.", retryable: false }
        );
      }
      return {
        workspace: toDetail(workspaceRow),
        role: "owner",
        trial: {
          granted: grant.value.granted,
          credits: grant.value.credits,
          duplicate: grant.value.duplicate
        }
      };
    },

    async assertTenant(userId, workspaceId) {
      const membership = await db.findMembership(userId, workspaceId);
      if (membership === null) {
        // §15.1 tenant boundary + §13.3 catalog code; the W4-E task pins the
        // cross-tenant response to 403 (table-driven in tests).
        throw new AppError(403, "cross_tenant_denied", "You do not have access to this workspace.", {
          hint: "Request access from a workspace admin.",
          retryable: false
        });
      }
      const workspace = await db.findWorkspace(workspaceId);
      if (workspace === null) {
        throw notFound("Workspace not found.", "Check the workspace id.");
      }
      return { workspace, membership };
    },

    getWorkspace(tenant) {
      return toDetail(tenant.workspace);
    },

    async listMembers(tenant) {
      const rows = await db.listMembers(tenant.workspace.id);
      return rows.map(toMemberView);
    },

    async listInvites(tenant) {
      const rows = await db.listInvitations(tenant.workspace.id);
      return rows.map((row) => toInviteView(row, tenant.workspace.name));
    },

    async createInvite(tenant, input, ctx) {
      const now = clock();
      const workspaceId = tenant.workspace.id;
      const existing = await db.listInvitations(workspaceId);
      const duplicatePending = existing.some(
        (row) =>
          row.email === input.email &&
          row.status === "pending" &&
          row.expires.getTime() >= now.getTime()
      );
      if (duplicatePending) {
        throw new AppError(
          409,
          "invite_already_pending",
          "An invitation for this email is already pending.",
          { hint: "Cancel the existing invitation or wait for it to expire.", retryable: false }
        );
      }
      const days = input.expiresInDays ?? INVITE_TTL_DAYS;
      const expires = new Date(now.getTime() + days * 86_400_000);
      const invite = await db.insertInvitation({
        id: newId(),
        organizationId: workspaceId,
        email: input.email,
        role: input.role,
        status: "pending",
        expires,
        inviterId: tenant.membership.userId
      });
      await auditAppend(
        {
          organizationId: workspaceId,
          actorId: tenant.membership.userId,
          action: "invite.created",
          target: `invitation:${invite.id}`,
          metadata: {
            email: input.email,
            role: input.role,
            expires_at: expires.toISOString()
          }
        },
        ctx
      );
      // TODO(email): the token is handed back in-band today; the invitation
      // email delivery (and a hashed token column) lands with the email wave.
      return toInviteView(invite, tenant.workspace.name);
    },

    async cancelInvite(userId, ref, ctx) {
      const invite = await db.findInvitation(ref.token);
      if (invite === null) {
        throw notFound("Invitation not found.", "Check the invitation id or token.");
      }
      if (ref.workspaceId !== undefined && invite.organizationId !== ref.workspaceId) {
        // Org-addressed cancel that points at another workspace's invite: do
        // not confirm its existence here (§13.3).
        throw notFound("Invitation not found.", "Check the invitation id or token.");
      }
      const tenant = await service.assertTenant(userId, invite.organizationId);
      assertCan(tenant.membership.role, "invites.cancel");
      if (invite.status !== "pending") {
        throw new AppError(409, "invite_unusable", "This invitation is no longer pending.", {
          hint: "Only pending invitations can be canceled.",
          retryable: false
        });
      }
      const updated = await db.updateInvitationStatus(ref.token, "canceled");
      if (updated === null) {
        throw notFound("Invitation not found.", "Check the invitation id or token.");
      }
      await auditAppend(
        {
          organizationId: invite.organizationId,
          actorId: userId,
          action: "invite.canceled",
          target: `invitation:${invite.id}`,
          metadata: { email: invite.email }
        },
        ctx
      );
    },

    async viewInvite(token) {
      const invite = await requireUsableInvitation(token);
      const workspace = await db.findWorkspace(invite.organizationId);
      if (workspace === null) {
        throw notFound("Workspace not found.", "This invitation's workspace no longer exists.");
      }
      return toInviteView(invite, workspace.name);
    },

    async acceptInvite(userId, token, ctx) {
      const invite = await requireUsableInvitation(token);
      const workspace = await db.findWorkspace(invite.organizationId);
      if (workspace === null) {
        throw notFound("Workspace not found.", "This invitation's workspace no longer exists.");
      }
      // TODO(email): verify the accepter's email matches invitation.email once
      // the Better Auth email-verification seam (W4-B/W4-C) resolves verified
      // addresses; the unguessable token is the capability today.
      const existing = await db.findMembership(userId, invite.organizationId);
      if (existing !== null) {
        throw new AppError(409, "already_member", "You are already a member of this workspace.", {
          hint: "Leave the workspace first if you want to rejoin with a different role.",
          retryable: false
        });
      }
      const memberRow = await db.insertMember({
        id: newId(),
        organizationId: invite.organizationId,
        userId,
        role: invite.role as InviteRole
      });
      const updated = await db.updateInvitationStatus(token, "accepted");
      if (updated === null) {
        throw notFound("Invitation not found.", "Check the invitation link or ask for a new one.");
      }
      await auditAppend(
        {
          organizationId: invite.organizationId,
          actorId: userId,
          action: "invite.accepted",
          target: `invitation:${invite.id}`,
          metadata: { email: invite.email, role: invite.role, user_id: userId }
        },
        ctx
      );
      await auditAppend(
        {
          organizationId: invite.organizationId,
          actorId: userId,
          action: "member.created",
          target: `member:${memberRow.id}`,
          metadata: { user_id: userId, role: invite.role, via: "invite.accept" }
        },
        ctx
      );
      return { workspaceId: invite.organizationId, role: invite.role as InviteRole };
    },

    async removeMember(tenant, targetUserId, ctx) {
      const workspaceId = tenant.workspace.id;
      const target = await db.findMembership(targetUserId, workspaceId);
      if (target === null) {
        throw notFound("Member not found in this workspace.", "Check the member id.");
      }
      if (target.role === "owner") {
        const owners = await db.listOwners(workspaceId);
        if (owners.length <= 1) {
          // §15.2: never leave a workspace ownerless — this also covers the
          // last owner deleting themselves (self-demotion).
          throw new AppError(409, "last_owner_protection", "The last owner cannot be removed.", {
            hint: "Promote another member to owner before removing this one.",
            retryable: false
          });
        }
        if (tenant.membership.role !== "owner") {
          throw new AppError(403, "forbidden", "Only an owner can remove an owner.", {
            hint: "Ask a workspace owner to perform this removal.",
            retryable: false
          });
        }
      }
      const removed = await db.deleteMember(workspaceId, targetUserId);
      if (!removed) {
        throw notFound("Member not found in this workspace.", "Check the member id.");
      }
      await auditAppend(
        {
          organizationId: workspaceId,
          actorId: tenant.membership.userId,
          action: "member.removed",
          target: `member:${target.id}`,
          metadata: { user_id: targetUserId, role: target.role }
        },
        ctx
      );
    },

    async updateWorkspace(tenant, input, ctx) {
      const workspace = tenant.workspace;
      const patch: { name?: string; metadata?: string } = {};
      const auditMeta: Record<string, unknown> = {};
      if (input.name !== undefined) {
        patch.name = input.name;
        auditMeta.name_changed = true;
      }
      if (input.brandTokens !== undefined) {
        const keys = Object.keys(input.brandTokens);
        if (keys.length > MAX_BRAND_TOKEN_KEYS) {
          throw new AppError(
            422,
            "validation_failed",
            `brand_tokens accepts at most ${MAX_BRAND_TOKEN_KEYS} keys.`,
            { retryable: true }
          );
        }
        const metadata = parseOrgMetadata(workspace.metadata);
        metadata.brandTokens = input.brandTokens;
        const serialized = JSON.stringify(metadata);
        if (serialized.length > MAX_METADATA_BYTES) {
          throw new AppError(422, "validation_failed", "brand_tokens is too large (64 KiB max).", {
            hint: "Trim the token set and retry.",
            retryable: true
          });
        }
        patch.metadata = serialized;
        auditMeta.brand_tokens_changed = true;
      }
      const updated = await db.updateOrganization(workspace.id, patch);
      if (updated === null) {
        throw notFound("Workspace not found.", "Check the workspace id.");
      }
      await auditAppend(
        {
          organizationId: workspace.id,
          actorId: tenant.membership.userId,
          action: "workspace.updated",
          target: `workspace:${workspace.id}`,
          metadata: auditMeta
        },
        ctx
      );
      return toDetail(updated);
    }
  };

  return service;
}

// ---------------------------------------------------------------------------
// Drizzle adapters (real implementations, typed against @studio/db exports)
// ---------------------------------------------------------------------------

/** Postgres unique-violation (23505) — races on unique indexes surface as 409s. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * DbLike over a real Drizzle database. Queries are written against the schema
 * exports (organization / member / invitation) re-exported by @studio/db; the
 * client is intentionally schema-less (see packages/db/src/client.ts), so the
 * tables are passed per query.
 */
export function createWorkspaceDb(db: Db): DbLike {
  return {
    async listWorkspacesForUser(userId) {
      return db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt,
          role: member.role
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(eq(member.userId, userId));
    },

    async findWorkspace(workspaceId) {
      const rows = await db.select().from(organization).where(eq(organization.id, workspaceId));
      return rows[0] ?? null;
    },

    async findWorkspaceBySlug(slug) {
      const rows = await db.select().from(organization).where(eq(organization.slug, slug));
      return rows[0] ?? null;
    },

    async findMembership(userId, workspaceId) {
      const rows = await db
        .select()
        .from(member)
        .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)));
      return rows[0] ?? null;
    },

    async listMembers(workspaceId) {
      return db.select().from(member).where(eq(member.organizationId, workspaceId));
    },

    async listOwners(workspaceId) {
      const rows = await db
        .select({ userId: member.userId })
        .from(member)
        .where(and(eq(member.organizationId, workspaceId), eq(member.role, "owner")));
      return rows.map((row) => row.userId);
    },

    async insertOrganization(input) {
      try {
        const rows = await db.insert(organization).values(input).returning();
        const created = rows[0];
        if (created === undefined) {
          throw new AppError(500, "internal_error", "Workspace insert returned no row.", {
            retryable: true
          });
        }
        return created;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw slugTaken();
        }
        throw error;
      }
    },

    async insertMember(input) {
      try {
        const rows = await db.insert(member).values(input).returning();
        const created = rows[0];
        if (created === undefined) {
          throw new AppError(500, "internal_error", "Member insert returned no row.", {
            retryable: true
          });
        }
        return created;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(409, "already_member", "That user is already a member.", {
            retryable: false
          });
        }
        throw error;
      }
    },

    async deleteMember(workspaceId, userId) {
      const rows = await db
        .delete(member)
        .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)))
        .returning({ id: member.id });
      return rows.length > 0;
    },

    async updateOrganization(workspaceId, patch) {
      const rows = await db
        .update(organization)
        .set(patch)
        .where(eq(organization.id, workspaceId))
        .returning();
      return rows[0] ?? null;
    },

    async findInvitation(token) {
      const rows = await db.select().from(invitation).where(eq(invitation.id, token));
      return rows[0] ?? null;
    },

    async listInvitations(workspaceId) {
      return db.select().from(invitation).where(eq(invitation.organizationId, workspaceId));
    },

    async insertInvitation(input) {
      const rows = await db.insert(invitation).values(input).returning();
      const created = rows[0];
      if (created === undefined) {
        throw new AppError(500, "internal_error", "Invitation insert returned no row.", {
          retryable: true
        });
      }
      return created;
    },

    async updateInvitationStatus(token, status) {
      const rows = await db
        .update(invitation)
        .set({ status })
        .where(eq(invitation.id, token))
        .returning();
      return rows[0] ?? null;
    }
  };
}

/** AuditLike over the real audit_log table (§22 append-only). */
export function createDrizzleAudit(db: Db): AuditLike {
  return {
    async append(entry) {
      await db.insert(auditLog).values({
        organizationId: entry.organizationId,
        actorId: entry.actorId,
        action: entry.action,
        target: entry.target,
        metadata: entry.metadata ?? {}
      });
    }
  };
}

/** BillingLike over @studio/billing's trialGrant + a LedgerStore. */
export function createLedgerBilling(ledger: LedgerStore): BillingLike {
  return {
    grantTrial(organizationId) {
      return trialGrant(organizationId, ledger);
    }
  };
}
