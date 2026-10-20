// W4-P — §15.2 RBAC matrix through the mounted surface: "viewer can GET,
// cannot POST runs; editor cannot invite; admin manages; owner everything"
// — plus the ADR-0003 matrix cells at the pure `can()` layer and the guard's
// effective-grants (API-key scope) narrowing.
//
// MOUNTED SURFACE: workspaces + invites + runs + uploads/assets + documents,
// all over the harness fakes. Where a router landed its own enforcement it is
// exercised here end-to-end:
//   - documents mutations enforce `documents:write` via can() (W4-F)
//   - uploads enforce roleAtLeast(role, "editor") (W4-I)
//   - workspace routes enforce the W4-E service ladder (admin+ for members/
//     invites)
//   - POST /v1/runs is enforced by the W4-C guard composed ahead of the
//     handler in the harness (the documented wiring contract — the runs auth
//     seam is role-less today, so routes/index.ts must compose exactly this).
//
// BILLING RECONCILIATION (deliberate, pinned): the W4-P task text said
// "admin cannot access billing", but ADR-0003 — the authoritative RBAC source
// (docs/adr/0003-auth-and-orgs.md "RBAC matrix") — grants Billing at ADMIN
// (viewer ❌ / editor ❌ / admin ✅ / owner ✅). W4-C reconciled the same
// conflict in src/authz/roles.ts and matrix.ts audits the cell; this suite
// pins the ADR cell. There is no billing router yet, so the cell is asserted
// at the can() + guard layers; when the billing wave lands, its routes must
// enforce the same permission and this suite's route loop must grow a probe.

import { describe, expect, it } from "vitest";
import { createResourceGuard, ForbiddenError } from "../../src/authz/guard.js";
import type { GuardContext, GuardLogger } from "../../src/authz/guard.js";
import { ALL_PERMISSIONS, can, PERMISSIONS, type Role } from "../../src/authz/roles.js";
import {
  bearerHeaders,
  buildGateway,
  get,
  jsonHeaders,
  ORG_A,
  postJson,
  TOKENS,
  uploadPng,
  USERS,
  type ErrorEnvelope,
  type GatewayHarness,
  type TestSession,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Seeds — one editable document + one run in org A, created by the editor
// ---------------------------------------------------------------------------

interface MatrixFixtures {
  readonly documentId: string;
  readonly runId: string;
  readonly assetId: string;
}

async function seedFixtures(h: GatewayHarness): Promise<MatrixFixtures> {
  const doc = await postJson(
    h,
    "/v1/documents",
    { name: "Matrix doc", width: 1080, height: 1080 },
    TOKENS.editorA,
  );
  expect(doc.status).toBe(201);
  const docBody = (await doc.json()) as { document: { id: string } };

  const run = await postJson(
    h,
    "/v1/runs",
    { documentId: docBody.document.id, prompt: "seed run", tier: "quick" },
    TOKENS.editorA,
    { "idempotency-key": "rbac-seed-run" },
  );
  expect(run.status).toBe(201);
  const runBody = (await run.json()) as { run_id: string };

  const asset = await uploadPng(h, TOKENS.editorA, "matrix.png");
  expect(asset.status).toBe(201);
  const assetBody = (await asset.json()) as { asset: { id: string } };

  return {
    documentId: docBody.document.id,
    runId: runBody.run_id,
    assetId: assetBody.asset.id,
  };
}

async function expectForbidden(h: GatewayHarness, path: string, method: string, token: string, body?: unknown): Promise<void> {
  const res = await h.app.request(path, {
    method,
    headers: body === undefined ? bearerHeaders(token) : jsonHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(res.status).toBe(403);
  const envelope = (await res.json()) as ErrorEnvelope;
  expect(envelope.code).toBe("forbidden");
}

// ---------------------------------------------------------------------------
// Route-level ladder
// ---------------------------------------------------------------------------

describe("§15.2 route-level RBAC (viewer < editor < admin < owner)", () => {
  it("viewer can GET reads, cannot POST runs / upload / mutate documents or assets / manage", async () => {
    const h = buildGateway();
    const f = await seedFixtures(h);

    // Reads are viewer+ (documents:read — ADR-0003 "Read documents/assets/runs").
    expect((await get(h, "/v1/documents", TOKENS.viewerA)).status).toBe(200);
    expect((await get(h, `/v1/documents/${f.documentId}`, TOKENS.viewerA)).status).toBe(200);
    expect((await get(h, "/v1/runs", TOKENS.viewerA)).status).toBe(200);
    expect((await get(h, `/v1/runs/${f.runId}`, TOKENS.viewerA)).status).toBe(200);
    expect((await get(h, "/v1/assets", TOKENS.viewerA)).status).toBe(200);
    expect((await get(h, `/v1/assets/${f.assetId}`, TOKENS.viewerA)).status).toBe(200);
    expect((await get(h, `/v1/workspaces/${ORG_A}`, TOKENS.viewerA)).status).toBe(200);

    // Writes are editor+.
    await expectForbidden(h, "/v1/runs", "POST", TOKENS.viewerA, {
      documentId: f.documentId,
      prompt: "viewer tries a run",
      tier: "quick",
      idempotencyKey: "viewer-run-attempt",
    });
    await expectForbidden(h, "/v1/uploads", "POST", TOKENS.viewerA);
    await expectForbidden(
      h,
      `/v1/documents/${f.documentId}`,
      "PATCH",
      TOKENS.viewerA,
      { name: "Viewer Rename" },
    );
    await expectForbidden(h, `/v1/assets/${f.assetId}`, "DELETE", TOKENS.viewerA);

    // Member/invite management is admin+ (W4-E service ladder).
    await expectForbidden(
      h,
      `/v1/workspaces/${ORG_A}/invites`,
      "POST",
      TOKENS.viewerA,
      { email: "someone@example.test", role: "editor" },
    );
    expect((await get(h, `/v1/workspaces/${ORG_A}/members`, TOKENS.viewerA)).status).toBe(403);

    // And nothing was written behind the 403s.
    expect(h.runsStore.all().filter((r) => r.userId === USERS.viewerA)).toHaveLength(0);
    expect(h.assetStorage.putCount).toBe(1); // the editor's seed upload only
  });

  it("editor can run/upload/mutate documents, but cannot invite or list members", async () => {
    const h = buildGateway();
    const f = await seedFixtures(h);

    expect(
      (
        await postJson(
          h,
          "/v1/runs",
          { documentId: f.documentId, prompt: "editor run", tier: "quick" },
          TOKENS.editorA,
          { "idempotency-key": "editor-run-ok" },
        )
      ).status,
    ).toBe(201);

    expect((await uploadPng(h, TOKENS.editorA, "editor-upload.png")).status).toBe(201);

    const rename = await h.app.request(`/v1/documents/${f.documentId}`, {
      method: "PATCH",
      headers: jsonHeaders(TOKENS.editorA),
      body: JSON.stringify({ name: "Editor Rename" }),
    });
    expect(rename.status).toBe(200);

    expect((await get(h, `/v1/workspaces/${ORG_A}`, TOKENS.editorA)).status).toBe(200);

    await expectForbidden(
      h,
      `/v1/workspaces/${ORG_A}/invites`,
      "POST",
      TOKENS.editorA,
      { email: "friend@example.test", role: "viewer" },
    );
    expect((await get(h, `/v1/workspaces/${ORG_A}/members`, TOKENS.editorA)).status).toBe(403);
    expect(h.wsDb.invitations).toHaveLength(0); // the invite never landed
  });

  it("admin manages members and invites, but the danger zone stays owner-only", async () => {
    const h = buildGateway();
    await seedFixtures(h);

    const invite = await postJson(
      h,
      `/v1/workspaces/${ORG_A}/invites`,
      { email: "hiring@example.test", role: "viewer" },
      TOKENS.adminA,
    );
    expect(invite.status).toBe(201);

    expect((await get(h, `/v1/workspaces/${ORG_A}/members`, TOKENS.adminA)).status).toBe(200);

    const rename = await h.app.request(`/v1/workspaces/${ORG_A}`, {
      method: "PATCH",
      headers: jsonHeaders(TOKENS.adminA),
      body: JSON.stringify({ name: "Renamed by admin" }),
    });
    expect(rename.status).toBe(200);

    const removed = await h.app.request(
      `/v1/workspaces/${ORG_A}/members/${USERS.viewerA}`,
      { method: "DELETE", headers: bearerHeaders(TOKENS.adminA) },
    );
    expect(removed.status).toBe(200);
    expect(h.wsDb.memberships.find((m) => m.userId === USERS.viewerA)).toBeUndefined();

    // Owner-only capabilities stay closed at admin (ADR-0003 danger zone).
    expect(can("admin", "workspace:delete")).toBe(false);
    expect(can("admin", "workspace:transfer")).toBe(false);
  });

  it("owner inherits everything the matrix grants (cumulative, ADR-0003)", async () => {
    const h = buildGateway();
    const f = await seedFixtures(h);

    // The owner's session role resolves through the SAME seams.
    expect(
      (
        await postJson(
          h,
          "/v1/runs",
          { documentId: f.documentId, prompt: "owner run", tier: "quick" },
          TOKENS.ownerA,
          { "idempotency-key": "owner-run-ok" },
        )
      ).status,
    ).toBe(201);
    expect((await uploadPng(h, TOKENS.ownerA, "owner-upload.png")).status).toBe(201);
    expect((await get(h, `/v1/workspaces/${ORG_A}/members`, TOKENS.ownerA)).status).toBe(200);
    const invite = await postJson(
      h,
      `/v1/workspaces/${ORG_A}/invites`,
      { email: "owner-invite@example.test", role: "admin" },
      TOKENS.ownerA,
    );
    expect(invite.status).toBe(201);
    const cancel = await h.app.request(`/v1/runs/${f.runId}/cancel`, {
      method: "POST",
      headers: jsonHeaders(TOKENS.ownerA),
      body: JSON.stringify({}),
    });
    expect(cancel.status).toBe(200);

    // Pure layer: the owner holds every permission in the catalog.
    expect([...PERMISSIONS.owner]).toEqual([...ALL_PERMISSIONS]);
  });
});

// ---------------------------------------------------------------------------
// API-key scope narrowing (§15.2 / ADR-0003: a key is never wider than its
// creator, and the session's effective grants intersect the key scopes)
// ---------------------------------------------------------------------------

describe("§15.2 effective-grants narrowing through the runs guard", () => {
  it("an editor-role session with narrowed grants cannot start runs", async () => {
    const h = buildGateway();
    const f = await seedFixtures(h);
    const narrowSession: TestSession = {
      userId: "user-apikey-editor",
      email: "apikey@example.test",
      organizationId: ORG_A,
      role: "editor",
      permissions: ["documents:read"], // API key scoped to reads only
    };
    h.addSession("tok-narrowed-editor", narrowSession);

    // The role alone would grant runs:create — the guard must still deny
    // (assertCan check 3: effective grants, fail closed).
    await expectForbidden(
      h,
      "/v1/runs",
      "POST",
      "tok-narrowed-editor",
      {
        documentId: f.documentId,
        prompt: "narrow key run",
        tier: "quick",
        idempotencyKey: "narrow-key-run",
      },
    );
    expect(h.runsStore.all()).toHaveLength(1); // only the editor's seed run
  });

  it("an editor session with EMPTY grants grants nothing (fail closed)", async () => {
    const h = buildGateway();
    const f = await seedFixtures(h);
    h.addSession("tok-empty-grants", {
      userId: "user-apikey-empty",
      email: "apikey@example.test",
      organizationId: ORG_A,
      role: "editor",
      permissions: [],
    });

    await expectForbidden(
      h,
      "/v1/runs",
      "POST",
      "tok-empty-grants",
      {
        documentId: f.documentId,
        prompt: "empty key run",
        tier: "quick",
        idempotencyKey: "empty-key-run",
      },
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0003 matrix cells (pure can() + guard.assertCan) — the billing row pinned
// ---------------------------------------------------------------------------

interface SilentLogger extends GuardLogger {}

class NullLogger implements SilentLogger {
  warn(): void {
    // assertions only — logging is covered in cross-tenant.test.ts
  }

  error(): void {
    // no-op
  }
}

const MATRIX_CELLS: readonly { role: Role; permission: string; expected: boolean }[] = [
  { role: "viewer", permission: "documents:read", expected: true },
  { role: "viewer", permission: "comments:create", expected: true },
  { role: "viewer", permission: "runs:create", expected: false },
  { role: "viewer", permission: "documents:write", expected: false },
  { role: "viewer", permission: "exports:create", expected: false },
  { role: "viewer", permission: "assets:upload", expected: false },
  { role: "viewer", permission: "members:manage", expected: false },
  { role: "viewer", permission: "billing:manage", expected: false },
  { role: "editor", permission: "runs:create", expected: true },
  { role: "editor", permission: "documents:write", expected: true },
  { role: "editor", permission: "exports:create", expected: true },
  { role: "editor", permission: "assets:upload", expected: true },
  { role: "editor", permission: "members:manage", expected: false },
  { role: "editor", permission: "billing:manage", expected: false },
  { role: "admin", permission: "members:manage", expected: true },
  { role: "admin", permission: "apikeys:manage", expected: true },
  // ADR-0003 Billing row: admin ✅ (W4-C reconciliation — see the file header).
  { role: "admin", permission: "billing:manage", expected: true },
  { role: "admin", permission: "workspace:delete", expected: false },
  { role: "owner", permission: "workspace:delete", expected: true },
  { role: "owner", permission: "workspace:transfer", expected: true },
  { role: "owner", permission: "billing:manage", expected: true },
];

describe("ADR-0003 matrix cells (§15.2)", () => {
  it.each(MATRIX_CELLS)("$role × $permission → $expected", ({ role, permission, expected }) => {
    expect(can(role, permission as Parameters<typeof can>[1])).toBe(expected);
  });

  it("the guard enforces the same cells with typed 403s", () => {
    const guard = createResourceGuard({ logger: new NullLogger(), requestId: "req-matrix" });
    const context = (role: Role): GuardContext => ({
      userId: `user-${role}`,
      organizationId: ORG_A,
      role,
      permissions: PERMISSIONS[role],
    });

    // Denied cells throw the typed RBAC error.
    for (const cell of MATRIX_CELLS.filter((row) => !row.expected)) {
      expect(() =>
        guard.assertCan(cell.role, cell.permission as Parameters<typeof can>[1], context(cell.role)),
      ).toThrow(ForbiddenError);
    }
    // Granted cells pass silently.
    for (const cell of MATRIX_CELLS.filter((row) => row.expected)) {
      expect(() =>
        guard.assertCan(cell.role, cell.permission as Parameters<typeof can>[1], context(cell.role)),
      ).not.toThrow();
    }
  });
});
