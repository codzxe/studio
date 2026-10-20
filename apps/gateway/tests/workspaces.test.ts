// Workspace routes + service tests (W4-E) — deterministic, no network, no DB:
// the DbLike/BillingLike/AuditLike seams are faked in-memory and the app is
// exercised end-to-end through buildApp().request() so every response flows
// through the real middleware stack (request-id, logger, error-mapper).
//
// Covers the W4-E acceptance list:
//   - create workspace happy path (+ trial grant called exactly once)
//   - invite role validation (owner/invalid → 422; admin/editor/viewer → 201)
//   - last-owner protection
//   - cross-tenant 403 table (§15.1 boundary, task-pinned 403)
//   - audit entries written (§22)
//   - RBAC ladder, accept flow, slug rules, 401, PATCH rename/brand tokens

import { describe, expect, it } from "vitest";
import pino from "pino";
import { ok, type Result } from "@studio/config";
import type { TrialGrantOutcome } from "@studio/billing";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import { createWorkspaceAuth, inviteRoutes, workspaceRoutes } from "../src/routes/workspaces.js";
import type { AuthContext } from "../src/routes/workspaces.js";
import { assertCan, slugify } from "../src/services/workspaces.js";
import type {
  AuditEntry,
  AuditLike,
  BillingLike,
  DbLike,
  InvitationRow,
  InvitationStatus,
  InviteRole,
  MemberRow,
  NewInvitationRow,
  NewMemberRow,
  NewWorkspaceRow,
  WorkspaceAction,
  WorkspaceRole,
  WorkspaceRow,
  WorkspaceSummaryRow
} from "../src/services/workspaces.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-01-15T10:00:00.000Z");

const ALICE: AuthContext = { userId: "user-alice", email: "alice@example.com" };
const BOB: AuthContext = { userId: "user-bob", email: "bob@example.com" };
const CAROL: AuthContext = { userId: "user-carol", email: "carol@example.com" };

/** In-memory DbLike over the three auth tables. */
class FakeDb implements DbLike {
  readonly organizations: WorkspaceRow[] = [];
  readonly memberships: MemberRow[] = [];
  readonly invitations: InvitationRow[] = [];

  constructor(private readonly clock: () => Date) {}

  async listWorkspacesForUser(userId: string): Promise<WorkspaceSummaryRow[]> {
    const rows: WorkspaceSummaryRow[] = [];
    for (const m of this.memberships) {
      if (m.userId !== userId) {
        continue;
      }
      const org = this.organizations.find((o) => o.id === m.organizationId);
      if (org === undefined) {
        continue;
      }
      rows.push({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        role: m.role
      });
    }
    return rows;
  }

  async findWorkspace(workspaceId: string): Promise<WorkspaceRow | null> {
    return this.organizations.find((o) => o.id === workspaceId) ?? null;
  }

  async findWorkspaceBySlug(slug: string): Promise<WorkspaceRow | null> {
    return this.organizations.find((o) => o.slug === slug) ?? null;
  }

  async findMembership(userId: string, workspaceId: string): Promise<MemberRow | null> {
    return (
      this.memberships.find(
        (m) => m.userId === userId && m.organizationId === workspaceId
      ) ?? null
    );
  }

  async listMembers(workspaceId: string): Promise<MemberRow[]> {
    return this.memberships.filter((m) => m.organizationId === workspaceId);
  }

  async listOwners(workspaceId: string): Promise<string[]> {
    return this.memberships
      .filter((m) => m.organizationId === workspaceId && m.role === "owner")
      .map((m) => m.userId);
  }

  async insertOrganization(input: NewWorkspaceRow): Promise<WorkspaceRow> {
    const created: WorkspaceRow = {
      id: input.id,
      name: input.name,
      slug: input.slug,
      logo: input.logo ?? null,
      metadata: input.metadata ?? null,
      createdAt: input.createdAt ?? this.clock()
    };
    this.organizations.push(created);
    return created;
  }

  async insertMember(input: NewMemberRow): Promise<MemberRow> {
    const created: MemberRow = {
      id: input.id,
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role ?? "viewer",
      createdAt: input.createdAt ?? this.clock()
    };
    this.memberships.push(created);
    return created;
  }

  async deleteMember(workspaceId: string, userId: string): Promise<boolean> {
    const index = this.memberships.findIndex(
      (m) => m.organizationId === workspaceId && m.userId === userId
    );
    if (index === -1) {
      return false;
    }
    this.memberships.splice(index, 1);
    return true;
  }

  async updateOrganization(
    workspaceId: string,
    patch: { name?: string; metadata?: string }
  ): Promise<WorkspaceRow | null> {
    const org = this.organizations.find((o) => o.id === workspaceId);
    if (org === undefined) {
      return null;
    }
    if (patch.name !== undefined) {
      org.name = patch.name;
    }
    if (patch.metadata !== undefined) {
      org.metadata = patch.metadata;
    }
    return { ...org };
  }

  async findInvitation(token: string): Promise<InvitationRow | null> {
    return this.invitations.find((i) => i.id === token) ?? null;
  }

  async listInvitations(workspaceId: string): Promise<InvitationRow[]> {
    return this.invitations.filter((i) => i.organizationId === workspaceId);
  }

  async insertInvitation(input: NewInvitationRow): Promise<InvitationRow> {
    const created: InvitationRow = {
      id: input.id,
      organizationId: input.organizationId,
      email: input.email,
      role: input.role,
      status: input.status ?? "pending",
      expires: input.expires,
      inviterId: input.inviterId
    };
    this.invitations.push(created);
    return created;
  }

  async updateInvitationStatus(
    token: string,
    status: InvitationStatus
  ): Promise<InvitationRow | null> {
    const invite = this.invitations.find((i) => i.id === token);
    if (invite === undefined) {
      return null;
    }
    invite.status = status;
    return { ...invite };
  }
}

class FakeBilling implements BillingLike {
  readonly calls: string[] = [];

  async grantTrial(organizationId: string): Promise<Result<TrialGrantOutcome>> {
    this.calls.push(organizationId);
    return ok({ organizationId, granted: true, credits: 30, duplicate: false });
  }
}

class FakeAudit implements AuditLike {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly db: FakeDb;
  readonly billing: FakeBilling;
  readonly audit: FakeAudit;
  readonly newId: () => string;
  actAs(user: AuthContext | null): void;
  advanceDays(days: number): void;
}

function makeHarness(): Harness {
  let now = FIXED_NOW;
  const clock = (): Date => new Date(now.getTime());
  let idSeq = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;

  const db = new FakeDb(clock);
  const billing = new FakeBilling();
  const audit = new FakeAudit();
  let actingUser: AuthContext | null = ALICE;
  const auth = createWorkspaceAuth(() => actingUser);

  const deps = { db, billing, audit, auth, clock, newId };
  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: Date.now(),
    mount(a) {
      a.route("/v1/workspaces", workspaceRoutes(deps));
      a.route("/v1/invites", inviteRoutes(deps));
    }
  } satisfies AppDeps);

  return {
    app,
    db,
    billing,
    audit,
    newId,
    actAs(user: AuthContext | null) {
      actingUser = user;
    },
    advanceDays(days: number) {
      now = new Date(now.getTime() + days * 86_400_000);
    }
  };
}

async function call(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function createWorkspaceAs(
  harness: Harness,
  user: AuthContext,
  name: string
): Promise<string> {
  harness.actAs(user);
  const res = await call(harness.app, "POST", "/v1/workspaces", { name });
  expect(res.status).toBe(201);
  const workspace = res.json.workspace as { id: string };
  return workspace.id;
}

// Keep one shared harness for the flow-heavy tests; cross-tenant isolation is
// not a concern because each scenario owns its workspaces.
const h = makeHarness();

// ---------------------------------------------------------------------------
// Pure helpers (table-driven)
// ---------------------------------------------------------------------------

describe("assertCan (§15.2 RBAC ladder)", () => {
  const table: Array<[WorkspaceRole, WorkspaceAction, boolean]> = [
    ["owner", "workspace.read", true],
    ["owner", "members.remove", true],
    ["admin", "invites.create", true],
    ["admin", "workspace.update", true],
    ["admin", "workspace.read", true],
    ["editor", "workspace.read", true],
    ["viewer", "workspace.read", true],
    ["editor", "members.list", false],
    ["editor", "invites.create", false],
    ["viewer", "workspace.update", false],
    ["viewer", "members.remove", false]
  ];
  it.each(table)("%s → %s → allowed=%s", (role, action, allowed) => {
    if (allowed) {
      expect(() => assertCan(role, action)).not.toThrow();
    } else {
      expect(() => assertCan(role, action)).toThrow(/does not allow/);
    }
  });
});

describe("slugify", () => {
  it("derives lowercase dash slugs and never returns empty", () => {
    expect(slugify("Acme Studio")).toBe("acme-studio");
    expect(slugify("  Weird --- Name!!  ")).toBe("weird-name");
    expect(slugify("ÉCOLE")).toBe("ecole");
    expect(slugify("")).toBe("workspace");
    expect(slugify("A")).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Routes — create + list (happy path; trial grant called once)
// ---------------------------------------------------------------------------

describe("POST /v1/workspaces (create: org + owner + trial grant)", () => {
  it("creates workspace, owner member, one trial grant, and audit entries", async () => {
    const res = await call(h.app, "POST", "/v1/workspaces", { name: "Acme Studio" });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
    const workspace = res.json.workspace as {
      id: string;
      name: string;
      slug: string;
      brand_tokens: Record<string, unknown>;
      created_at: string;
    };
    expect(workspace.name).toBe("Acme Studio");
    expect(workspace.slug).toBe("acme-studio");
    expect(workspace.brand_tokens).toEqual({});
    expect(workspace.created_at).toBe(FIXED_NOW.toISOString());
    expect(res.json.role).toBe("owner");
    const trial = res.json.trial as { granted: boolean; credits: number; duplicate: boolean };
    expect(trial).toEqual({ granted: true, credits: 30, duplicate: false });

    // Trial grant called exactly once, for the new workspace (§1.4).
    expect(h.billing.calls).toHaveLength(1);
    expect(h.billing.calls[0]).toBe(workspace.id);

    // Owner member row exists.
    expect(h.db.memberships).toHaveLength(1);
    expect(h.db.memberships[0]?.userId).toBe("user-alice");
    expect(h.db.memberships[0]?.role).toBe("owner");
    expect(h.db.memberships[0]?.organizationId).toBe(workspace.id);

    // §22 audit: creation + owner role assignment, correlated by request id.
    const actions = h.audit.entries.map((e) => e.action);
    expect(actions).toContain("workspace.created");
    expect(actions).toContain("member.created");
    expect(h.audit.entries[0]?.organizationId).toBe(workspace.id);
    expect(h.audit.entries[0]?.actorId).toBe("user-alice");
    expect(h.audit.entries[0]?.target).toBe(`workspace:${workspace.id}`);
  });

  it("lists only my memberships", async () => {
    const res = await call(h.app, "GET", "/v1/workspaces");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const workspaces = res.json.workspaces as { id: string; role: string }[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.role).toBe("owner");

    h.actAs(BOB);
    const bobList = await call(h.app, "GET", "/v1/workspaces");
    expect((bobList.json.workspaces as unknown[]).length).toBe(0);
    h.actAs(ALICE);
  });

  it("rejects a non-JSON body with a 400 envelope", async () => {
    const raw = await h.app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json"
    });
    expect(raw.status).toBe(400);
    const json = (await raw.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("bad_request");
  });

  it("rejects unknown fields with 422 (strict schema)", async () => {
    const res = await call(h.app, "POST", "/v1/workspaces", { name: "X", extra: 1 });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// Slug rules
// ---------------------------------------------------------------------------

describe("workspace slugs", () => {
  it("derives unique slugs for duplicate names and 409s on explicit conflicts", async () => {
    const first = await call(h.app, "POST", "/v1/workspaces", { name: "Slug Shop" });
    expect(first.status).toBe(201);
    expect((first.json.workspace as { slug: string }).slug).toBe("slug-shop");

    const second = await call(h.app, "POST", "/v1/workspaces", { name: "Slug Shop" });
    expect(second.status).toBe(201);
    expect((second.json.workspace as { slug: string }).slug).toBe("slug-shop-2");

    const clash = await call(h.app, "POST", "/v1/workspaces", {
      name: "Other",
      slug: "slug-shop"
    });
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe("slug_taken");
  });
});

// ---------------------------------------------------------------------------
// Invite role validation + invites surface
// ---------------------------------------------------------------------------

describe("POST /v1/workspaces/:id/invites (role ∈ editor|viewer|admin)", () => {
  it("rejects owner/unknown roles with 422 and accepts the three invitable roles", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Invite Co");

    for (const role of ["owner", "member", "", "OWNER"]) {
      const res = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
        email: "someone@example.com",
        role
      });
      expect(res.status, `role=${role}`).toBe(422);
      expect(res.json.code, `role=${role}`).toBe("validation_failed");
    }

    const missing = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "someone@example.com"
    });
    expect(missing.status).toBe(422);

    for (const role of ["admin", "editor", "viewer"] as const) {
      const res = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
        email: `${role}@example.com`,
        role
      });
      expect(res.status, `role=${role}`).toBe(201);
      const invite = res.json.invite as { role: InviteRole; status: string; token: string };
      expect(invite.role).toBe(role);
      expect(invite.status).toBe("pending");
      expect(invite.token.length).toBeGreaterThan(0);
    }

    // Duplicate pending invite for the same email → 409.
    const dup = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "admin@example.com",
      role: "admin"
    });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe("invite_already_pending");

    // Admin+ listing sees all pending invitations (the duplicate was rejected).
    const list = await call(h.app, "GET", `/v1/workspaces/${workspaceId}/invites`);
    expect(list.status).toBe(200);
    expect((list.json.invites as unknown[]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Invite accept flow (token seam; TODO(email) placeholder)
// ---------------------------------------------------------------------------

describe("invite accept flow (/v1/invites/:token)", () => {
  it("views, accepts, and consumes an invitation", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Accept Co");
    const created = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "bob@example.com",
      role: "editor"
    });
    const token = (created.json.invite as { token: string }).token;

    const view = await call(h.app, "GET", `/v1/invites/${token}`);
    expect(view.status).toBe(200);
    const viewed = view.json.invite as { email: string; role: string; organization_id: string };
    expect(viewed.email).toBe("bob@example.com");
    expect(viewed.role).toBe("editor");
    expect(viewed.organization_id).toBe(workspaceId);

    h.actAs(BOB);
    const accept = await call(h.app, "POST", `/v1/invites/${token}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.json.workspace_id).toBe(workspaceId);
    expect(accept.json.role).toBe("editor");

    // Membership + consumed status.
    expect(
      h.db.memberships.some(
        (m) => m.userId === "user-bob" && m.role === "editor" && m.organizationId === workspaceId
      )
    ).toBe(true);
    expect(h.db.invitations.find((i) => i.id === token)?.status).toBe("accepted");

    // Bob can now read the workspace.
    const read = await call(h.app, "GET", `/v1/workspaces/${workspaceId}`);
    expect(read.status).toBe(200);

    // Second accept → 409 (not pending anymore).
    const second = await call(h.app, "POST", `/v1/invites/${token}/accept`);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("invite_unusable");

    // Already a member → 409 already_member on a fresh invite.
    const again = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "bob@example.com",
      role: "viewer"
    });
    expect(again.status).toBe(201);
    const fresh = (again.json.invite as { token: string }).token;
    const reaccept = await call(h.app, "POST", `/v1/invites/${fresh}/accept`);
    expect(reaccept.status).toBe(409);
    expect(reaccept.json.code).toBe("already_member");
    h.actAs(ALICE);
  });

  it("expires invitations deterministically against the injected clock", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Expiry Co");
    const created = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "carol@example.com",
      role: "viewer",
      expires_in_days: 1
    });
    const token = (created.json.invite as { token: string }).token;

    h.advanceDays(2);
    h.actAs(CAROL);
    const view = await call(h.app, "GET", `/v1/invites/${token}`);
    expect(view.status).toBe(409);
    expect(view.json.code).toBe("invite_expired");
    const accept = await call(h.app, "POST", `/v1/invites/${token}/accept`);
    expect(accept.status).toBe(409);
    expect(accept.json.code).toBe("invite_expired");
    h.actAs(ALICE);
  });

  it("cancels invitations by token and by workspace-scoped id (admin+)", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Cancel Co");
    const created = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "carol@example.com",
      role: "viewer"
    });
    const token = (created.json.invite as { token: string }).token;

    // Cancel by token as the owner.
    const byToken = await call(h.app, "DELETE", `/v1/invites/${token}`);
    expect(byToken.status).toBe(200);
    expect(h.db.invitations.find((i) => i.id === token)?.status).toBe("canceled");

    // Cancel by workspace-scoped id.
    const second = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "other@example.com",
      role: "admin"
    });
    const secondToken = (second.json.invite as { token: string }).token;
    const byId = await call(h.app, "DELETE", `/v1/workspaces/${workspaceId}/invites/${secondToken}`);
    expect(byId.status).toBe(200);
    expect(h.db.invitations.find((i) => i.id === secondToken)?.status).toBe("canceled");

    // Canceling a canceled invite → 409.
    const recancel = await call(h.app, "DELETE", `/v1/invites/${token}`);
    expect(recancel.status).toBe(409);
    expect(recancel.json.code).toBe("invite_unusable");
  });

  it("404s an unknown token", async () => {
    const res = await call(h.app, "POST", "/v1/invites/does-not-exist/accept");
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Last-owner protection (§15.2)
// ---------------------------------------------------------------------------

describe("DELETE /v1/workspaces/:id/members/:userId", () => {
  it("protects the last owner and restricts owner removals", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Owner Co");

    // Self-removal of the only owner → 409 last_owner_protection.
    const self = await call(h.app, "DELETE", `/v1/workspaces/${workspaceId}/members/user-alice`);
    expect(self.status).toBe(409);
    expect(self.json.code).toBe("last_owner_protection");

    // Seed: bob (owner) + carol (admin).
    h.db.memberships.push({
      id: h.newId(),
      organizationId: workspaceId,
      userId: "user-bob",
      role: "owner",
      createdAt: FIXED_NOW
    });
    h.db.memberships.push({
      id: h.newId(),
      organizationId: workspaceId,
      userId: "user-carol",
      role: "admin",
      createdAt: FIXED_NOW
    });

    // Admin cannot remove an owner → 403.
    h.actAs(CAROL);
    const adminRemovesOwner = await call(
      h.app,
      "DELETE",
      `/v1/workspaces/${workspaceId}/members/user-bob`
    );
    expect(adminRemovesOwner.status).toBe(403);
    expect(adminRemovesOwner.json.code).toBe("forbidden");

    // Admin can remove non-owner members.
    h.db.memberships.push({
      id: h.newId(),
      organizationId: workspaceId,
      userId: "user-dave",
      role: "editor",
      createdAt: FIXED_NOW
    });
    const adminRemovesEditor = await call(
      h.app,
      "DELETE",
      `/v1/workspaces/${workspaceId}/members/user-dave`
    );
    expect(adminRemovesEditor.status).toBe(200);
    expect(h.db.memberships.some((m) => m.userId === "user-dave")).toBe(false);

    // Owner can remove another owner.
    h.actAs(ALICE);
    const ownerRemovesOwner = await call(
      h.app,
      "DELETE",
      `/v1/workspaces/${workspaceId}/members/user-bob`
    );
    expect(ownerRemovesOwner.status).toBe(200);

    // Back to a single owner: protected again.
    const last = await call(h.app, "DELETE", `/v1/workspaces/${workspaceId}/members/user-alice`);
    expect(last.status).toBe(409);
    expect(last.json.code).toBe("last_owner_protection");

    // §22: the removal was audited.
    expect(h.audit.entries.some((e) => e.action === "member.removed")).toBe(true);
  });

  it("404s when the target is not a member", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Ghost Co");
    const res = await call(h.app, "DELETE", `/v1/workspaces/${workspaceId}/members/user-nobody`);
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant 403 table (§15.1 boundary; task-pinned 403 cross_tenant_denied)
// ---------------------------------------------------------------------------

describe("cross-tenant access is denied with 403", () => {
  it("denies every org-scoped route to a non-member", async () => {
    const alphaId = await createWorkspaceAs(h, ALICE, "Alpha");
    h.actAs(BOB);
    const betaId = await createWorkspaceAs(h, BOB, "Beta");
    const betaInvite = await call(h.app, "POST", `/v1/workspaces/${betaId}/invites`, {
      email: "x@example.com",
      role: "viewer"
    });
    const token = (betaInvite.json.invite as { token: string }).token;
    h.actAs(ALICE);

    const cases: Array<[string, () => Promise<{ status: number; json: Record<string, unknown> }>]> = [
      ["GET /v1/workspaces/:id", () => call(h.app, "GET", `/v1/workspaces/${betaId}`)],
      ["GET /v1/workspaces/:id/members", () => call(h.app, "GET", `/v1/workspaces/${betaId}/members`)],
      ["GET /v1/workspaces/:id/invites", () => call(h.app, "GET", `/v1/workspaces/${betaId}/invites`)],
      [
        "POST /v1/workspaces/:id/invites",
        () => call(h.app, "POST", `/v1/workspaces/${betaId}/invites`, { email: "y@example.com", role: "editor" })
      ],
      ["PATCH /v1/workspaces/:id", () => call(h.app, "PATCH", `/v1/workspaces/${betaId}`, { name: "Hacked" })],
      [
        "DELETE /v1/workspaces/:id/members/:userId",
        () => call(h.app, "DELETE", `/v1/workspaces/${betaId}/members/user-bob`)
      ],
      [
        "DELETE /v1/workspaces/:id/invites/:inviteId",
        () => call(h.app, "DELETE", `/v1/workspaces/${betaId}/invites/${token}`)
      ],
      ["DELETE /v1/invites/:token", () => call(h.app, "DELETE", `/v1/invites/${token}`)]
    ];

    for (const [name, run] of cases) {
      const res = await run();
      expect(res.status, name).toBe(403);
      expect(res.json.code, name).toBe("cross_tenant_denied");
    }

    // Sanity: alice still reaches her own workspace.
    const own = await call(h.app, "GET", `/v1/workspaces/${alphaId}`);
    expect(own.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// RBAC on org-scoped routes (§15.2)
// ---------------------------------------------------------------------------

describe("RBAC (§15.2) on workspace routes", () => {
  it("lets admins manage, blocks editors/viewers from admin+ routes", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Rbac Co");
    const seed = (userId: string, role: WorkspaceRole): void => {
      h.db.memberships.push({
        id: h.newId(),
        organizationId: workspaceId,
        userId,
        role,
        createdAt: FIXED_NOW
      });
    };
    seed("user-bob", "editor");
    seed("user-carol", "viewer");
    seed("user-dan", "admin");

    // Editor: read OK, admin+ routes 403.
    h.actAs(BOB);
    expect((await call(h.app, "GET", `/v1/workspaces/${workspaceId}`)).status).toBe(200);
    const editorInvite = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "z@example.com",
      role: "viewer"
    });
    expect(editorInvite.status).toBe(403);
    expect((await call(h.app, "GET", `/v1/workspaces/${workspaceId}/members`)).status).toBe(403);
    expect(
      (await call(h.app, "PATCH", `/v1/workspaces/${workspaceId}`, { name: "Nope" })).status
    ).toBe(403);

    // Viewer: read OK, admin+ routes 403.
    h.actAs(CAROL);
    expect((await call(h.app, "GET", `/v1/workspaces/${workspaceId}`)).status).toBe(200);
    expect(
      (await call(h.app, "PATCH", `/v1/workspaces/${workspaceId}`, { name: "Nope" })).status
    ).toBe(403);

    // Admin: full management surface.
    h.actAs({ userId: "user-dan", email: "dan@example.com" });
    const adminInvite = await call(h.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "dan@example.org",
      role: "editor"
    });
    expect(adminInvite.status).toBe(201);
    const members = await call(h.app, "GET", `/v1/workspaces/${workspaceId}/members`);
    expect(members.status).toBe(200);
    expect((members.json.members as unknown[]).length).toBe(4);
    expect((await call(h.app, "PATCH", `/v1/workspaces/${workspaceId}`, { name: "Renamed" })).status).toBe(200);
    h.actAs(ALICE);
  });
});

// ---------------------------------------------------------------------------
// PATCH rename / brand tokens
// ---------------------------------------------------------------------------

describe("PATCH /v1/workspaces/:id (rename, brand tokens)", () => {
  it("renames, stores brand tokens, and rejects empty/unknown patches", async () => {
    const workspaceId = await createWorkspaceAs(h, ALICE, "Patch Co");

    const rename = await call(h.app, "PATCH", `/v1/workspaces/${workspaceId}`, { name: "Renamed" });
    expect(rename.status).toBe(200);
    expect((rename.json.workspace as { name: string; slug: string }).name).toBe("Renamed");
    expect((rename.json.workspace as { slug: string }).slug).toBe("patch-co"); // slug immutable

    const brand = await call(h.app, "PATCH", `/v1/workspaces/${workspaceId}`, {
      brand_tokens: { primary: "#101418", accent: "#E5484D" }
    });
    expect(brand.status).toBe(200);

    const read = await call(h.app, "GET", `/v1/workspaces/${workspaceId}`);
    const detail = read.json.workspace as { brand_tokens: Record<string, string> };
    expect(detail.brand_tokens.primary).toBe("#101418");
    expect(detail.brand_tokens.accent).toBe("#E5484D");

    expect((await call(h.app, "PATCH", `/v1/workspaces/${workspaceId}`, {})).status).toBe(422);
    expect(
      (await call(h.app, "PATCH", `/v1/workspaces/${workspaceId}`, { nope: true })).status
    ).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Audit entries (§22) across the whole surface
// ---------------------------------------------------------------------------

describe("audit log appends (§22)", () => {
  it("records role changes, invites and deletes with actor/org/target/request id", async () => {
    const harness = makeHarness();
    const workspaceId = await createWorkspaceAs(harness, ALICE, "Audit Co");

    const invited = await call(harness.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "bob@example.com",
      role: "editor"
    });
    const token = (invited.json.invite as { token: string }).token;

    harness.actAs(BOB);
    await call(harness.app, "POST", `/v1/invites/${token}/accept`);
    harness.actAs(ALICE);

    const cancelTarget = await call(harness.app, "POST", `/v1/workspaces/${workspaceId}/invites`, {
      email: "gone@example.com",
      role: "viewer"
    });
    await call(harness.app, "DELETE", `/v1/invites/${(cancelTarget.json.invite as { token: string }).token}`);

    await call(harness.app, "DELETE", `/v1/workspaces/${workspaceId}/members/user-bob`);
    await call(harness.app, "PATCH", `/v1/workspaces/${workspaceId}`, { name: "Audited" });

    const actions = harness.audit.entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "workspace.created",
        "member.created",
        "invite.created",
        "invite.accepted",
        "invite.canceled",
        "member.removed",
        "workspace.updated"
      ])
    );

    for (const entry of harness.audit.entries) {
      expect(entry.organizationId).toBe(workspaceId);
      expect(entry.actorId).toBeTruthy();
      expect(entry.target).toMatch(/^[a-z.]+:[0-9a-zA-Z-]+$/);
    }

    // §22 request correlation: the invite creation carries the request id
    // echoed by the requestId middleware (buildApp pipeline).
    const inviteCreated = harness.audit.entries.find((e) => e.action === "invite.created");
    const requestId = (inviteCreated?.metadata as Record<string, unknown> | undefined)?.request_id;
    expect(typeof requestId).toBe("string");
    expect((requestId as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// requireAuth (401 envelope on every router)
// ---------------------------------------------------------------------------

describe("requireAuth", () => {
  it("returns a 401 envelope when no user resolves", async () => {
    const harness = makeHarness();
    await createWorkspaceAs(harness, ALICE, "Auth Co");
    harness.actAs(null);
    for (const [method, path] of [
      ["GET", "/v1/workspaces"],
      ["POST", "/v1/workspaces"],
      ["GET", "/v1/invites/some-token"],
      ["POST", "/v1/invites/some-token/accept"],
      ["DELETE", "/v1/invites/some-token"]
    ] as const) {
      const res = await call(harness.app, method, path, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.json.code, `${method} ${path}`).toBe("unauthorized");
      expect(res.json.ok).toBe(false);
    }
  });
});
