// RBAC + tenant-guard tests (§15.1 isolation, §15.2 RBAC matrix, §20 #11 gate).
//
// Deterministic, network-free units (<5 s, AGENTS.md). Two things matter here:
//   1. The full permission × role matrix matches ADR-0003's table — expected
//      values are HAND-TRANSCRIBED in this file, never imported from src, so
//      the tests catch drift instead of echoing it.
//   2. The tenant guard rejects foreign organizations with the DISTINCT typed
//      `cross_tenant_denied` error, logs the attempt with the request id
//      (§22), and never leaks ids into envelopes.

import { describe, expect, it } from "vitest";
import pino from "pino";
import { buildApp } from "../src/app.js";
import { createResourceGuard, CrossTenantDeniedError, ForbiddenError } from "../src/authz/guard.js";
import type { GuardContext, GuardLogger, TypedResourceGuard } from "../src/authz/guard.js";
import {
  ADR_RBAC_TABLE,
  assertMatrixMatchesAdr,
  auditMatrix,
  PERMISSION_MATRIX
} from "../src/authz/matrix.js";
import type { RbacMatrixAudit } from "../src/authz/matrix.js";
import {
  ALL_PERMISSIONS,
  can,
  isPermission,
  isRole,
  PERMISSIONS,
  ROLE_RANK,
  ROLES
} from "../src/authz/roles.js";
import type { Permission, Role } from "../src/authz/roles.js";
import { AppError } from "../src/middleware/error-mapper.js";
import { gatewayTransportSchema } from "../src/env.js";
import { stubProbes } from "../src/routes/health.js";

// ---------------------------------------------------------------------------
// Hand-transcribed expectations (independent of src — do not import these).
// ---------------------------------------------------------------------------

const EXPECTED_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3
};

// In ALL_PERMISSIONS order: viewer grants, then editor, admin, owner-only.
const EXPECTED_PERMISSIONS_BY_ROLE: Readonly<Record<Role, readonly Permission[]>> = {
  viewer: ["comments:create", "documents:read"],
  editor: ["assets:upload", "documents:write", "exports:create", "runs:create"],
  admin: ["apikeys:manage", "billing:manage", "brand:manage", "members:manage"],
  owner: [
    "comments:create",
    "documents:read",
    "assets:upload",
    "documents:write",
    "exports:create",
    "runs:create",
    "apikeys:manage",
    "billing:manage",
    "brand:manage",
    "members:manage",
    "workspace:delete",
    "workspace:transfer"
  ]
};

const EXPECTED_PERMISSION_BY_ADR_ROW: Readonly<Record<string, Permission>> = {
  "Read documents/assets/runs/versions": "documents:read",
  "Comment (with position)": "comments:create",
  "Create runs (`POST /runs`, tiers)": "runs:create",
  "Manual commands / undo / redo / restore": "documents:write",
  "Exports (`exports:create`)": "exports:create",
  "Upload assets / register templates": "assets:upload",
  "Manage members + invites": "members:manage",
  "Billing (checkout/portal, credit packs)": "billing:manage",
  "API key management": "apikeys:manage",
  'Delete workspace (§15.2 "owner: delete")': "workspace:delete",
  "Transfer ownership / dissolve": "workspace:transfer"
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function catchTypedError<T extends Error>(fn: () => void): T {
  try {
    fn();
  } catch (error) {
    return error as T;
  }
  throw new Error("expected the guard to throw, but it did not");
}

interface CapturedLog {
  readonly level: "warn" | "error";
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function captureLogger(): { logger: GuardLogger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  return {
    entries,
    logger: {
      warn: (fields, message) => {
        entries.push({ level: "warn", fields, message });
      },
      error: (fields, message) => {
        entries.push({ level: "error", fields, message });
      }
    }
  };
}

function makeSession(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    userId: "user-1",
    organizationId: "org-1",
    role: "viewer",
    permissions: PERMISSIONS.viewer,
    ...overrides
  };
}

function makeGuard(): { guard: TypedResourceGuard; entries: CapturedLog[] } {
  const { logger, entries } = captureLogger();
  return { guard: createResourceGuard({ logger, requestId: "req-1" }), entries };
}

// ---------------------------------------------------------------------------
// ROLE_RANK + derived lists
// ---------------------------------------------------------------------------

describe("ROLE_RANK (W4-C contract)", () => {
  it("is exactly { viewer:0, editor:1, admin:2, owner:3 }", () => {
    expect({ ...ROLE_RANK }).toEqual(EXPECTED_RANK);
  });

  it("ROLES is ascending privilege", () => {
    expect(ROLES).toEqual(["viewer", "editor", "admin", "owner"]);
  });

  const roleCases: [Role][] = ROLES.map((role): [Role] => [role]);

  it.each(roleCases)("PERMISSIONS.%s lists exactly the expected grants", (role) => {
    expect([...PERMISSIONS[role]]).toEqual([...EXPECTED_PERMISSIONS_BY_ROLE[role]]);
  });
});

// ---------------------------------------------------------------------------
// can() — the full permission × role matrix
// ---------------------------------------------------------------------------

describe("can() — full matrix, every role × every permission (§15.2)", () => {
  const matrixCases: [Role, Permission, boolean][] = ALL_PERMISSIONS.flatMap((permission) =>
    ROLES.map(
      (role): [Role, Permission, boolean] => [
        role,
        permission,
        EXPECTED_PERMISSIONS_BY_ROLE[role].includes(permission)
      ]
    )
  );

  it.each(matrixCases)("can(%s, %s) → %s", (role, permission, expected) => {
    expect(can(role, permission)).toBe(expected);
  });

  it("cumulativity: a grant at rank N reaches every role ≥ N", () => {
    for (const permission of ALL_PERMISSIONS) {
      for (const [index, role] of ROLES.entries()) {
        const lower = index > 0 ? ROLES[index - 1] : undefined;
        if (lower !== undefined && can(lower, permission) && !can(role, permission)) {
          throw new Error(`non-cumulative: ${lower} grants ${permission} but ${role} does not`);
        }
      }
    }
  });
});

describe("can() vs the ADR-0003 RBAC table (docs/adr/0003-auth-and-orgs.md)", () => {
  it("enforces every ADR row with exactly one permission, cell-matched", () => {
    const problems: string[] = [];
    for (const row of ADR_RBAC_TABLE) {
      const expected = EXPECTED_PERMISSION_BY_ADR_ROW[row.capability];
      const mapped = PERMISSION_MATRIX.filter((entry) => entry.source.adrRow === row.capability);
      const entry = mapped.length === 1 ? mapped[0] : undefined;
      if (entry === undefined || entry.permission !== expected) {
        problems.push(
          `"${row.capability}": expected exactly one permission "${String(expected)}", ` +
            `found [${mapped.map((m) => m.permission).join(", ")}]`
        );
        continue;
      }
      for (const role of ROLES) {
        if (can(role, entry.permission) !== row.grants[role]) {
          problems.push(
            `"${row.capability}" [${role}]: can(${entry.permission}) should be ${String(row.grants[role])}`
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("ADR_RBAC_TABLE transcribes all 11 ADR rows", () => {
    expect(ADR_RBAC_TABLE).toHaveLength(11);
    expect(Object.keys(EXPECTED_PERMISSION_BY_ADR_ROW)).toHaveLength(11);
  });
});

describe("matrix.ts self-test (CI completeness gate)", () => {
  it("auditMatrix reports a clean matrix", () => {
    const audit = auditMatrix();
    expect(audit.ok).toBe(true);
    expect(audit.problems).toEqual([]);
    expect(audit.adrRows).toBe(11);
    expect(audit.permissions).toBe(12);
    expect(audit.roleChecks).toBeGreaterThanOrEqual(92);
  });

  it("assertMatrixMatchesAdr passes on the live matrix", () => {
    expect(() => assertMatrixMatchesAdr()).not.toThrow();
  });

  it("assertMatrixMatchesAdr throws with every problem listed on a failed audit", () => {
    const broken: RbacMatrixAudit = {
      ok: false,
      problems: ["sample drift row", "another drift cell"],
      adrRows: 11,
      permissions: 12,
      roleChecks: 92
    };
    expect(() => assertMatrixMatchesAdr(broken)).toThrowError(/sample drift row/);
    expect(() => assertMatrixMatchesAdr(broken)).toThrowError(/another drift cell/);
  });
});

describe("runtime guards (fail closed, §15.2)", () => {
  it("isRole accepts only the four wire-stable roles", () => {
    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }
    expect(isRole("superadmin")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(42)).toBe(false);
  });

  it("isPermission accepts only known permissions", () => {
    expect(isPermission("documents:read")).toBe(true);
    expect(isPermission("brand:manage")).toBe(true);
    expect(isPermission("documents:hax")).toBe(false);
    expect(isPermission(undefined)).toBe(false);
  });

  it("can() fails closed on runtime garbage (cast callers)", () => {
    expect(can("superadmin" as Role, "documents:read")).toBe(false);
    expect(can("viewer", "nope" as Permission)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertCan — the RBAC seam
// ---------------------------------------------------------------------------

describe("assertCan", () => {
  const acceptCases: [Role, Permission][] = ROLES.flatMap((role) =>
    PERMISSIONS[role].map((permission): [Role, Permission] => [role, permission])
  );

  it.each(acceptCases)("grants %s → %s (member session)", (role, permission) => {
    const { guard, entries } = makeGuard();
    const ctx = makeSession({ role, permissions: PERMISSIONS[role] });
    expect(() => guard.assertCan(role, permission, ctx)).not.toThrow();
    expect(entries).toHaveLength(0);
  });

  const rejectCases: [Role, Permission][] = ROLES.flatMap((role) =>
    ALL_PERMISSIONS.filter((permission) => !can(role, permission)).map(
      (permission): [Role, Permission] => [role, permission]
    )
  );

  it.each(rejectCases)("denies %s → %s with a typed forbidden error", (role, permission) => {
    const { guard, entries } = makeGuard();
    const ctx = makeSession({ role, permissions: PERMISSIONS[role] });
    const error = catchTypedError<ForbiddenError>(() => guard.assertCan(role, permission, ctx));
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.code).toBe("forbidden");
    expect(error.status).toBe(403);
    expect(error.permission).toBe(permission);
    expect(error.hint).toContain(permission); // the needed permission, per W4-C
    expect(error.message).not.toContain("org-1");
    expect(error.message).not.toContain("user-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("rbac_denied");
    expect(entries[0]?.level).toBe("warn");
    expect(entries[0]?.fields.request_id).toBe("req-1");
  });

  it("denies an editor-role API key whose scope omits the permission (ADR-0003 key narrowing)", () => {
    const { guard, entries } = makeGuard();
    const ctx = makeSession({ role: "editor", permissions: ["documents:read"] });
    const error = catchTypedError<ForbiddenError>(() => guard.assertCan("editor", "runs:create", ctx));
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.hint).toContain("runs:create");
    expect(entries[0]?.message).toBe("rbac_denied");
    expect(entries[0]?.fields.reason).toBe("session_scope");
  });

  it("allows an editor-role API key whose scope includes the permission", () => {
    const { guard } = makeGuard();
    const ctx = makeSession({ role: "editor", permissions: ["runs:create"] });
    expect(() => guard.assertCan("editor", "runs:create", ctx)).not.toThrow();
  });

  it("fail closed: an empty effective grant list grants nothing", () => {
    const { guard } = makeGuard();
    const ctx = makeSession({ role: "viewer", permissions: [] });
    const error = catchTypedError<ForbiddenError>(() =>
      guard.assertCan("viewer", "documents:read", ctx)
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.hint).toContain("documents:read");
  });

  it("never grants when the enforced role is not the session's own role (handler bug)", () => {
    const { guard, entries } = makeGuard();
    const ctx = makeSession({ role: "viewer", permissions: PERMISSIONS.admin });
    const error = catchTypedError<ForbiddenError>(() =>
      guard.assertCan("admin", "members:manage", ctx)
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.permission).toBe("members:manage");
    expect(error.hint).toContain("members:manage");
    expect(entries[0]?.message).toBe("guard_role_mismatch");
    expect(entries[0]?.level).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// assertTenant / assertDocAccess — the cross-tenant seam (§15.1, §20 #11)
// ---------------------------------------------------------------------------

describe("assertTenant", () => {
  const tenantCases: [string, string, string, boolean][] = [
    ["same organization → allowed, nothing logged", "org-1", "org-1", false],
    ["foreign organization → cross_tenant_denied", "org-2", "org-1", true],
    ["empty resource org → denied (fail closed)", "", "org-1", true],
    ["empty session org → denied (fail closed)", "org-1", "", true],
    ["both empty → denied (never equal-by-garbage)", "", "", true]
  ];

  it.each(tenantCases)("%s", (label, resourceOrgId, ctxOrgId, expectDenied) => {
    const { guard, entries } = makeGuard();
    const ctx = makeSession({ organizationId: ctxOrgId });
    if (!expectDenied) {
      expect(() => guard.assertTenant({ organizationId: resourceOrgId }, ctx)).not.toThrow();
      expect(entries).toHaveLength(0);
      return;
    }
    const error = catchTypedError<CrossTenantDeniedError>(() =>
      guard.assertTenant({ organizationId: resourceOrgId }, ctx)
    );
    expect(error).toBeInstanceOf(CrossTenantDeniedError);
    expect(error.code).toBe("cross_tenant_denied");
    expect(error.status).toBe(403); // @studio/config registry mapping
    expect(error.hint).toBeDefined();
    // §22: the attempt is logged with the request id + actor + caller
    // workspace + attempted target (logs only — never the envelope).
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("cross_tenant_denied");
    expect(entries[0]?.level).toBe("warn");
    expect(entries[0]?.fields.request_id).toBe("req-1");
    expect(entries[0]?.fields.workspace_id).toBe(ctxOrgId);
    expect(entries[0]?.fields.user_id).toBe("user-1");
    expect(entries[0]?.fields.resource_organization_id).toBe(resourceOrgId);
    expect(entries[0]?.fields.resource_kind).toBe("resource");
    if (resourceOrgId !== "") {
      expect(error.message).not.toContain(resourceOrgId);
      expect(error.hint ?? "").not.toContain(resourceOrgId);
    }
    if (ctxOrgId !== "") {
      expect(error.message).not.toContain(ctxOrgId);
    }
  });

  it("assertDocAccess routes documents through the same seam (resource_kind: document)", () => {
    const { guard, entries } = makeGuard();
    const ctx = makeSession();
    expect(() => guard.assertDocAccess("org-1", ctx)).not.toThrow();
    expect(() => guard.assertDocAccess("org-doc-foreign", ctx)).toThrowError(CrossTenantDeniedError);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fields.resource_kind).toBe("document");
    expect(entries[0]?.fields.resource_organization_id).toBe("org-doc-foreign");
  });

  it("fail closed on runtime garbage: undefined ids never equal a tenant (§15.1)", () => {
    const { guard } = makeGuard();
    const ctx = makeSession();
    const undefinedId = undefined as unknown as string;
    expect(() => guard.assertTenant({ organizationId: undefinedId }, ctx)).toThrowError(
      CrossTenantDeniedError
    );
    expect(() => guard.assertDocAccess(undefinedId, ctx)).toThrowError(CrossTenantDeniedError);
    const badCtx = makeSession({ organizationId: undefinedId });
    expect(() => guard.assertTenant({ organizationId: "org-1" }, badCtx)).toThrowError(
      CrossTenantDeniedError
    );
  });

  it("never masks a denial as 404/not_found (distinct typed code)", () => {
    const { guard } = makeGuard();
    const error = catchTypedError<AppError>(() =>
      guard.assertTenant({ organizationId: "org-2" }, makeSession())
    );
    expect(error.code).not.toBe("not_found");
    expect(error.status).not.toBe(404);
  });
});

describe("error shapes (§13.3 typed envelopes)", () => {
  it("ForbiddenError and CrossTenantDeniedError are AppErrors the mapper understands", () => {
    expect(new ForbiddenError("m", { hint: "h" })).toBeInstanceOf(AppError);
    expect(new CrossTenantDeniedError("m", { hint: "h" })).toBeInstanceOf(AppError);
    expect(new ForbiddenError("m").retryable).toBe(false);
    expect(new CrossTenantDeniedError("m").retryable).toBe(false);
  });

  it("the guard object is immutable (routes cannot widen it)", () => {
    expect(Object.isFrozen(makeGuard().guard)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wire round trip through the real error mapper (§13.3)
// ---------------------------------------------------------------------------

describe("wire envelopes (error-mapper round trip)", () => {
  const silentLogger = pino({ enabled: false });

  function makeApp(mount: (app: ReturnType<typeof buildApp>) => void): ReturnType<typeof buildApp> {
    return buildApp({
      env: gatewayTransportSchema.parse({}),
      logger: silentLogger,
      version: "0.0.0-test",
      probes: stubProbes(),
      startedAt: Date.now(),
      mount
    });
  }

  it("maps CrossTenantDeniedError to 403 cross_tenant_denied without leaking internals", async () => {
    const app = makeApp((a) => {
      a.get("/v1/guarded", (c) => {
        const guard = createResourceGuard({
          logger: c.get("logger"),
          requestId: c.get("requestId")
        });
        guard.assertTenant({ organizationId: "org-secret-foreign" }, makeSession());
        return c.json({ ok: true });
      });
    });
    const res = await app.request("/v1/guarded");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; code: string; message: string; hint?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("cross_tenant_denied");
    expect(body.hint).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("org-secret-foreign");
    expect(JSON.stringify(body)).not.toContain("user-1");
  });

  it("maps ForbiddenError to 403 forbidden with the needed permission in the hint", async () => {
    const app = makeApp((a) => {
      a.get("/v1/guarded", (c) => {
        const guard = createResourceGuard({
          logger: c.get("logger"),
          requestId: c.get("requestId")
        });
        guard.assertCan("viewer", "runs:create", makeSession({ role: "viewer" }));
        return c.json({ ok: true });
      });
    });
    const res = await app.request("/v1/guarded");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; code: string; message: string; hint?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("forbidden");
    expect(body.hint).toContain("runs:create");
  });

  it("passes a permitted, same-organization request through to the handler", async () => {
    const app = makeApp((a) => {
      a.get("/v1/guarded", (c) => {
        const guard = createResourceGuard({
          logger: c.get("logger"),
          requestId: c.get("requestId")
        });
        const session = makeSession({ role: "editor", permissions: PERMISSIONS.editor });
        guard.assertCan("editor", "runs:create", session);
        guard.assertTenant({ organizationId: "org-1" }, session);
        return c.json({ ok: true });
      });
    });
    const res = await app.request("/v1/guarded");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
