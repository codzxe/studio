// W4-P — §20 #11: the automated cross-tenant isolation suite (§21 Security row:
// "Cross-tenant access, IDOR").
//
// Two DOCUMENTED tenant seams (src/authz/guard.ts header, ADR-0003):
//   1. LOOKUPS stay 404: composite org+id scoping means a foreign resource is
//      simply not resolved — documents, runs, assets and the SSE stream all
//      answer not_found (§13.3: never confirm existence to strangers).
//   2. ASSERTIONS throw 403 cross_tenant_denied: once a resource IS in hand
//      (workspace routes resolve membership first — W4-E service assertTenant),
//      the denial is typed so probing is distinguishable from a miss in the
//      audit trail — while the envelope never leaks ids.
// Plus the storage-path tenant-key guard: every object key embeds
// `…/organizations/<orgId>/…` and packages/storage keys.ts assertTenant is
// table-driven here across all five namespaces (assets / renders / exports /
// documents / checkpoints). The preview/export object spaces have no HTTP
// route yet (W4-K), so this table is where their tenant guard is pinned.
//
// Both directions are probed (org A → org B and org B → org A), always with
// the attacking org's OWNER token: if the most privileged member of another
// tenant cannot cross, no weaker session can either.

import { describe, expect, it } from "vitest";
import {
  assetKey,
  assertTenant as assertStorageTenant,
  checkpointKey,
  documentKey,
  exportKey,
  previewKey,
} from "../../../../packages/storage/src/keys.js";
import type { StorageResult } from "../../../../packages/storage/src/types.js";
import { CrossTenantDeniedError, createResourceGuard } from "../../src/authz/guard.js";
import type { GuardContext, GuardLogger } from "../../src/authz/guard.js";
import { PERMISSIONS } from "../../src/authz/roles.js";
import {
  bearerHeaders,
  buildGateway,
  get,
  jsonHeaders,
  ORG_A,
  ORG_B,
  postJson,
  TOKENS,
  uploadPng,
  USERS,
  type ErrorEnvelope,
  type GatewayHarness,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Fixtures — one document + asset + run + invite per organization, via the API
// ---------------------------------------------------------------------------

interface OrgResources {
  readonly documentId: string;
  readonly versionId: string;
  readonly assetId: string;
  readonly runId: string;
  readonly inviteToken: string;
  readonly editorUserId: string;
  /** Body needles that must never appear in an attacker's response. */
  readonly docName: string;
  readonly prompt: string;
  readonly assetChecksum: string;
  readonly victimOrgId: string;
}

async function seedOrgResources(
  h: GatewayHarness,
  creatorToken: string,
  ownerToken: string,
  orgName: string,
  victimOrgId: string,
): Promise<OrgResources> {
  const docName = `Victim doc ${orgName}`;
  const docRes = await postJson(
    h,
    "/v1/documents",
    { name: docName, width: 1080, height: 1080 },
    creatorToken,
  );
  expect(docRes.status).toBe(201);
  const docBody = (await docRes.json()) as { document: { id: string }; version: { id: string } };

  const assetRes = await uploadPng(h, creatorToken, `victim-${orgName}.png`);
  expect(assetRes.status).toBe(201);
  const assetBody = (await assetRes.json()) as { asset: { id: string; checksum: string } };

  const prompt = `secret ${orgName} brief`;
  const runRes = await postJson(
    h,
    "/v1/runs",
    { documentId: docBody.document.id, prompt, tier: "standard" },
    creatorToken,
    { "idempotency-key": `seed-${orgName}` },
  );
  expect(runRes.status).toBe(201);
  const runBody = (await runRes.json()) as { run_id: string };

  const inviteRes = await postJson(
    h,
    `/v1/workspaces/${victimOrgId}/invites`,
    { email: `new-${orgName}@example.test`, role: "editor" },
    ownerToken,
  );
  expect(inviteRes.status).toBe(201);
  const inviteBody = (await inviteRes.json()) as { invite: { token: string } };

  return {
    documentId: docBody.document.id,
    versionId: docBody.version.id,
    assetId: assetBody.asset.id,
    runId: runBody.run_id,
    inviteToken: inviteBody.invite.token,
    editorUserId: victimOrgId === ORG_A ? USERS.editorA : USERS.editorB,
    docName,
    prompt,
    assetChecksum: assetBody.asset.checksum,
    victimOrgId,
  };
}

/** Seeds BOTH orgs (documents, assets, runs, invites) through the real routes. */
async function seedBothOrgs(h: GatewayHarness): Promise<{ a: OrgResources; b: OrgResources }> {
  const a = await seedOrgResources(h, TOKENS.editorA, TOKENS.ownerA, "alpha", ORG_A);
  const b = await seedOrgResources(h, TOKENS.editorB, TOKENS.ownerB, "bravo", ORG_B);
  return { a, b };
}

// ---------------------------------------------------------------------------
// Denial probes — every mounted route that touches another tenant's resource
// ---------------------------------------------------------------------------

interface DenialProbe {
  readonly name: string;
  readonly expected: 403 | 404;
  readonly expectedCode: string;
  readonly request: (
    h: GatewayHarness,
    victim: OrgResources,
    attacker: string,
  ) => Promise<Response>;
  /** Side-effect check: the attack left no trace on the victim's data. */
  readonly effects?: (h: GatewayHarness, victim: OrgResources) => Promise<void> | void;
}

const DENIAL_PROBES: readonly DenialProbe[] = [
  {
    name: "read a foreign run (GET /v1/runs/:id)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) => get(h, `/v1/runs/${victim.runId}`, attacker),
  },
  {
    name: "command a foreign run (POST /v1/runs/:id/cancel)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/runs/${victim.runId}/cancel`, {
        method: "POST",
        headers: jsonHeaders(attacker),
        body: JSON.stringify({}),
      }),
    effects: async (h, victim) => {
      expect((await h.runsStore.getRun(victim.victimOrgId, victim.runId))?.status).toBe("queued");
      expect(h.ledger.entriesOfKind("refund", victim.victimOrgId)).toHaveLength(0);
      expect(h.cancelEvents.cancelled).toHaveLength(0);
    },
  },
  {
    name: "create a run against a foreign document (POST /v1/runs)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) =>
      postJson(
        h,
        "/v1/runs",
        { documentId: victim.documentId, prompt: "hijack attempt", tier: "quick" },
        attacker,
        { "idempotency-key": "cross-tenant-hijack" },
      ),
    effects: (h) => {
      expect(h.runsStore.all()).toHaveLength(2); // only the two seeded runs
      expect(h.enqueue.calls).toHaveLength(2); // …and only their two enqueues
    },
  },
  {
    name: "stream a foreign run's events (GET /v1/runs/:id/events — §13.2)",
    expected: 404,
    expectedCode: "run_not_found",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/runs/${victim.runId}/events`, {
        method: "GET",
        headers: bearerHeaders(attacker),
      }),
    effects: (h) => {
      // The bus is never subscribed — the tenant gate runs before any stream.
      expect(h.sseBus.subscriptions).toHaveLength(0);
    },
  },
  {
    name: "read a foreign document (GET /v1/documents/:id)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) => get(h, `/v1/documents/${victim.documentId}`, attacker),
  },
  {
    name: "rename a foreign document (PATCH /v1/documents/:id)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/documents/${victim.documentId}`, {
        method: "PATCH",
        headers: jsonHeaders(attacker),
        body: JSON.stringify({ name: "Stolen" }),
      }),
    effects: (h, victim) => {
      expect(h.docsStore.documents.find((d) => d.id === victim.documentId)?.name).toBe(victim.docName);
    },
  },
  {
    name: "archive a foreign document (DELETE /v1/documents/:id)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/documents/${victim.documentId}`, {
        method: "DELETE",
        headers: bearerHeaders(attacker),
      }),
    effects: (h, victim) => {
      expect(h.docsStore.documents.find((d) => d.id === victim.documentId)?.archivedAt).toBeNull();
    },
  },
  {
    name: "read a foreign document's version timeline (GET /v1/documents/:id/versions)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) =>
      get(h, `/v1/documents/${victim.documentId}/versions`, attacker),
  },
  {
    name: "restore a foreign document version (POST …/versions/:versionId/restore)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) =>
      h.app.request(
        `/v1/documents/${victim.documentId}/versions/${victim.versionId}/restore`,
        {
          method: "POST",
          headers: jsonHeaders(attacker),
          body: JSON.stringify({}),
        },
      ),
    effects: (h, victim) => {
      // History untouched — §10.4: nothing was appended to the victim's doc.
      expect(h.docsStore.versions.filter((v) => v.documentId === victim.documentId)).toHaveLength(1);
    },
  },
  {
    name: "read a foreign asset / mint a signed URL (GET /v1/assets/:id)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) => get(h, `/v1/assets/${victim.assetId}`, attacker),
    effects: (h) => {
      expect(h.assetStorage.signedKeys).toHaveLength(0); // §15.1: never for strangers
    },
  },
  {
    name: "delete a foreign asset (DELETE /v1/assets/:id)",
    expected: 404,
    expectedCode: "not_found",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/assets/${victim.assetId}`, {
        method: "DELETE",
        headers: bearerHeaders(attacker),
      }),
    effects: (h, victim) => {
      expect(h.assetsStore.rows.has(victim.assetId)).toBe(true);
      expect(h.assetStorage.deleteCount).toBe(0);
      expect(h.assetsStore.audits).toHaveLength(0); // §22: no phantom delete audit
    },
  },
  {
    name: "read a foreign workspace (GET /v1/workspaces/:id)",
    expected: 403,
    expectedCode: "cross_tenant_denied",
    request: (h, victim, attacker) => get(h, `/v1/workspaces/${victim.victimOrgId}`, attacker),
  },
  {
    name: "list a foreign workspace's members (GET /v1/workspaces/:id/members)",
    expected: 403,
    expectedCode: "cross_tenant_denied",
    request: (h, victim, attacker) =>
      get(h, `/v1/workspaces/${victim.victimOrgId}/members`, attacker),
  },
  {
    name: "list a foreign workspace's invites (GET /v1/workspaces/:id/invites)",
    expected: 403,
    expectedCode: "cross_tenant_denied",
    request: (h, victim, attacker) =>
      get(h, `/v1/workspaces/${victim.victimOrgId}/invites`, attacker),
  },
  {
    name: "invite into a foreign workspace (POST /v1/workspaces/:id/invites)",
    expected: 403,
    expectedCode: "cross_tenant_denied",
    request: (h, victim, attacker) =>
      postJson(
        h,
        `/v1/workspaces/${victim.victimOrgId}/invites`,
        { email: "mole@example.test", role: "admin" },
        attacker,
      ),
    effects: (h, victim) => {
      expect(
        h.wsDb.invitations.filter(
          (i) => i.organizationId === victim.victimOrgId && i.email === "mole@example.test",
        ),
      ).toHaveLength(0);
    },
  },
  {
    name: "rename a foreign workspace (PATCH /v1/workspaces/:id)",
    expected: 403,
    expectedCode: "cross_tenant_denied",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/workspaces/${victim.victimOrgId}`, {
        method: "PATCH",
        headers: jsonHeaders(attacker),
        body: JSON.stringify({ name: "Hijacked" }),
      }),
    effects: (h, victim) => {
      expect(h.wsDb.organizations.find((o) => o.id === victim.victimOrgId)?.name).not.toBe(
        "Hijacked",
      );
    },
  },
  {
    name: "remove a member from a foreign workspace (DELETE /v1/workspaces/:id/members/:userId)",
    expected: 403,
    expectedCode: "cross_tenant_denied",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/workspaces/${victim.victimOrgId}/members/${victim.editorUserId}`, {
        method: "DELETE",
        headers: bearerHeaders(attacker),
      }),
    effects: (h, victim) => {
      // The victim's member ladder is intact — nobody was removed.
      expect(
        h.wsDb.memberships.filter((m) => m.organizationId === victim.victimOrgId).length,
      ).toBe(4);
    },
  },
  {
    name: "cancel a foreign workspace's invitation by token (DELETE /v1/invites/:token)",
    expected: 403,
    expectedCode: "cross_tenant_denied",
    request: (h, victim, attacker) =>
      h.app.request(`/v1/invites/${victim.inviteToken}`, {
        method: "DELETE",
        headers: bearerHeaders(attacker),
      }),
    effects: (h, victim) => {
      expect(h.wsDb.invitations.find((i) => i.id === victim.inviteToken)?.status).toBe("pending");
    },
  },
];

const DIRECTIONS = [
  { name: "org A member → org B resources", attacker: TOKENS.ownerA, victim: "b" as const },
  { name: "org B member → org A resources", attacker: TOKENS.ownerB, victim: "a" as const },
] as const;

describe.each(DIRECTIONS)("§20 #11 cross-tenant isolation ($name)", (direction) => {
  it.each(DENIAL_PROBES)("cannot $name", async (probe) => {
    const h = buildGateway();
    const both = await seedBothOrgs(h);
    const victim = direction.victim === "b" ? both.b : both.a;

    const res = await probe.request(h, victim, direction.attacker);

    // Documented guard semantics: 403 cross_tenant_denied (assertions) or 404
    // (composite-scoped lookups) — NEVER a 2xx carrying the other org's data.
    expect(res.status).toBe(probe.expected);
    expect([403, 404]).toContain(res.status);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.ok).toBe(false);
    expect(body.code).toBe(probe.expectedCode);

    // Never the victim's data in the envelope (§13.3): no ids, names, prompts
    // or checksums of the target cross the boundary.
    const text = JSON.stringify(body);
    expect(text).not.toContain(victim.docName);
    expect(text).not.toContain(victim.prompt);
    expect(text).not.toContain(victim.assetId);
    expect(text).not.toContain(victim.assetChecksum);
    expect(text).not.toContain(victim.documentId);
    expect(text).not.toContain(victim.runId);
    expect(text).not.toContain(victim.victimOrgId);

    if (probe.effects !== undefined) {
      await probe.effects(h, victim);
    }
  });

  it("list endpoints never surface the other org's rows", async () => {
    const h = buildGateway();
    const both = await seedBothOrgs(h);
    const own = direction.attacker === TOKENS.ownerA ? both.a : both.b;
    const other = direction.attacker === TOKENS.ownerA ? both.b : both.a;

    const runs = (await (await get(h, "/v1/runs", direction.attacker)).json()) as {
      runs: { run_id: string }[];
    };
    expect(runs.runs.map((r) => r.run_id)).toEqual([own.runId]);
    expect(JSON.stringify(runs)).not.toContain(other.runId);

    const docs = (await (await get(h, "/v1/documents", direction.attacker)).json()) as {
      documents: { id: string }[];
    };
    expect(docs.documents.map((d) => d.id)).toEqual([own.documentId]);
    expect(JSON.stringify(docs)).not.toContain(other.documentId);
    expect(JSON.stringify(docs)).not.toContain(other.docName);

    const assets = (await (await get(h, "/v1/assets", direction.attacker)).json()) as {
      assets: { id: string }[];
    };
    expect(assets.assets.map((a) => a.id)).toEqual([own.assetId]);
    expect(JSON.stringify(assets)).not.toContain(other.assetId);

    const workspaces = (await (await get(h, "/v1/workspaces", direction.attacker)).json()) as {
      workspaces: { id: string }[];
    };
    expect(workspaces.workspaces.map((w) => w.id)).toEqual([
      direction.attacker === TOKENS.ownerA ? ORG_A : ORG_B,
    ]);

    // A foreign document filter answers empty — never the other org's rows.
    const filtered = (await (
      await get(h, `/v1/runs?document_id=${other.documentId}`, direction.attacker)
    ).json()) as { runs: unknown[] };
    expect(filtered.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §13.3 IDOR: foreign ids are indistinguishable from missing ones
// ---------------------------------------------------------------------------

describe("§20 #11 / §13.3 — cross-tenant is indistinguishable from not-found", () => {
  it("documents, runs and assets answer the SAME envelope for foreign and missing ids", async () => {
    const h = buildGateway();
    const { b } = await seedBothOrgs(h);

    const cases: readonly { path: (id: string) => string; foreign: string; missing: string }[] = [
      {
        path: (id) => `/v1/documents/${id}`,
        foreign: b.documentId,
        missing: "doc-does-not-exist",
      },
      { path: (id) => `/v1/runs/${id}`, foreign: b.runId, missing: "run-does-not-exist" },
      { path: (id) => `/v1/assets/${id}`, foreign: b.assetId, missing: "asset-does-not-exist" },
    ];

    for (const probe of cases) {
      const foreign = await get(h, probe.path(probe.foreign), TOKENS.ownerA);
      const missing = await get(h, probe.path(probe.missing), TOKENS.ownerA);
      expect(foreign.status).toBe(missing.status);
      const foreignBody = (await foreign.json()) as ErrorEnvelope;
      const missingBody = (await missing.json()) as ErrorEnvelope;
      expect(foreignBody.code).toBe(missingBody.code);
      expect(foreignBody.message).toBe(missingBody.message);
    }
  });

  it("the auth gate runs before the tenant gate — unauthenticated probes learn nothing", async () => {
    const h = buildGateway();
    const { b } = await seedBothOrgs(h);

    const expected401 = async (res: Response): Promise<void> => {
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrorEnvelope).code).toBe("unauthorized");
    };

    await expected401(await h.app.request(`/v1/runs/${b.runId}`, { method: "GET" }));
    await expected401(await h.app.request(`/v1/runs/${b.runId}/events`, { method: "GET" }));
    await expected401(await h.app.request(`/v1/documents/${b.documentId}`, { method: "GET" }));
    await expected401(await h.app.request(`/v1/assets/${b.assetId}`, { method: "GET" }));
    await expected401(await h.app.request(`/v1/workspaces/${ORG_B}`, { method: "GET" }));
    expect(h.sseBus.subscriptions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §15.1 storage-path tenant-key guard — assertTenant table (all five namespaces)
// ---------------------------------------------------------------------------

describe("storage-path tenant-key guard (keys.ts assertTenant, §15.1)", () => {
  const OWN = ORG_A;
  const OTHER = ORG_B;

  function expectKey(result: StorageResult<string>): string {
    expect(result.ok).toBe(true);
    return result.ok ? result.value : "";
  }

  /** One key per §3.1 object namespace, all built for OWN (victim org here). */
  const keysByNamespace: readonly { namespace: string; key: string }[] = [
    {
      namespace: "assets (uploads)",
      key: expectKey(assetKey({ organizationId: OWN, assetId: "asset-1", filename: "photo.png" })),
    },
    {
      namespace: "renders (previews)",
      key: expectKey(previewKey({ organizationId: OWN, documentId: "doc-1", width: 512, revision: 3 })),
    },
    {
      namespace: "exports",
      key: expectKey(
        exportKey({ organizationId: OWN, documentId: "doc-1", format: "png", versionId: "ver-1" }),
      ),
    },
    {
      namespace: "documents (.pcraft versions)",
      key: expectKey(documentKey({ organizationId: OWN, documentId: "doc-1", versionId: "ver-1" })),
    },
    {
      namespace: "checkpoints (engine sessions)",
      key: expectKey(
        checkpointKey({ organizationId: OWN, documentId: "doc-1", sessionId: "ses-1", revision: 7 }),
      ),
    },
  ];

  it.each(keysByNamespace)("$namespace: own tenant accepted", ({ key }) => {
    const guarded = assertStorageTenant(key, OWN);
    expect(guarded.ok).toBe(true);
    if (guarded.ok) {
      expect(guarded.value).toBe(key);
    }
  });

  it.each(keysByNamespace)("$namespace: foreign tenant denied with cross_tenant_key", ({ key }) => {
    const guarded = assertStorageTenant(key, OTHER);
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) {
      expect(guarded.code).toBe("cross_tenant_key");
      // §13.3: the failure names fields, never echoes the key or the ids.
      expect(guarded.message).not.toContain(OWN);
      expect(guarded.message).not.toContain(OTHER);
    }
  });

  it("invalid keys and unsafe tenant arguments fail closed (storage_invalid_key)", () => {
    const valid = expectKey(assetKey({ organizationId: OWN, assetId: "asset-1" }));
    expect(valid.length).toBeGreaterThan(0);

    // Malformed key: the tenant segment is missing entirely.
    const malformed = assertStorageTenant("assets/asset-1/photo.png", OWN);
    expect(malformed.ok).toBe(false);
    // Unsafe org argument (path-traversal-shaped): rejected before comparison.
    const unsafeOrg = assertStorageTenant(valid, "../../etc");
    expect(unsafeOrg.ok).toBe(false);
    if (!unsafeOrg.ok) {
      expect(unsafeOrg.code).toBe("storage_invalid_key");
    }
    // Empty org argument: fail closed.
    const emptyOrg = assertStorageTenant(valid, "");
    expect(emptyOrg.ok).toBe(false);
    if (!emptyOrg.ok) {
      expect(emptyOrg.code).toBe("storage_invalid_key");
    }
  });

  it("every stored object lands under the caller's own organizations/<orgId> prefix", async () => {
    const h = buildGateway();
    await uploadPng(h, TOKENS.editorA, "alpha.png");
    await uploadPng(h, TOKENS.editorB, "bravo.png");
    await postJson(h, "/v1/documents", { name: "Doc A", width: 800, height: 600 }, TOKENS.editorA);

    expect(h.assetStorage.objects.size).toBe(2);
    for (const key of h.assetStorage.objects.keys()) {
      const isA = key.startsWith(`assets/organizations/${ORG_A}/`);
      const isB = key.startsWith(`assets/organizations/${ORG_B}/`);
      // Exactly one tenant prefix — and only one of the two known tenants.
      expect(isA !== isB).toBe(true);
    }
    expect([...h.assetStorage.objects.keys()].some((k) => k.includes(ORG_A))).toBe(true);
    expect([...h.assetStorage.objects.keys()].some((k) => k.includes(ORG_B))).toBe(true);

    // Document version bytes: documents/organizations/<orgId>/… (§3.1).
    expect(h.docStorage.puts).toHaveLength(1);
    expect(h.docStorage.puts[0]?.key.startsWith(`documents/organizations/${ORG_A}/`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §15.1 typed resource guard — the assertTenant assertion seam (guard.ts)
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

class CapturingGuardLogger implements GuardLogger {
  readonly warns: CapturedCall[] = [];
  readonly errors: CapturedCall[] = [];

  warn(fields: Record<string, unknown>, message: string): void {
    this.warns.push({ fields, message });
  }

  error(fields: Record<string, unknown>, message: string): void {
    this.errors.push({ fields, message });
  }
}

describe("guard.assertTenant (§15.1 assertion seam — typed 403, never 404-masked)", () => {
  const callerContext = (organizationId: string): GuardContext => ({
    userId: "user-probe",
    organizationId,
    role: "admin",
    permissions: PERMISSIONS.admin,
  });

  it("table: same-tenant passes; foreign/empty ids fail closed with 403 cross_tenant_denied", () => {
    const logger = new CapturingGuardLogger();
    const guard = createResourceGuard({ logger, requestId: "req-001" });

    // Same tenant → passes silently.
    expect(() => guard.assertTenant({ organizationId: ORG_A }, callerContext(ORG_A))).not.toThrow();

    const table: readonly { resourceOrg: string; callerOrg: string; reason: string }[] = [
      { resourceOrg: ORG_B, callerOrg: ORG_A, reason: "foreign_tenant" },
      { resourceOrg: ORG_A, callerOrg: ORG_B, reason: "foreign_tenant" },
      { resourceOrg: "", callerOrg: ORG_A, reason: "missing_tenant_scope" },
      { resourceOrg: ORG_A, callerOrg: "", reason: "missing_tenant_scope" },
      { resourceOrg: "", callerOrg: "", reason: "missing_tenant_scope" },
    ];

    for (const row of table) {
      let denied: unknown = null;
      try {
        guard.assertTenant({ organizationId: row.resourceOrg }, callerContext(row.callerOrg));
      } catch (error) {
        denied = error;
      }
      expect(denied, `resource=${row.resourceOrg} caller=${row.callerOrg}`).toBeInstanceOf(
        CrossTenantDeniedError,
      );
      const typed = denied as CrossTenantDeniedError;
      expect(typed.status).toBe(403);
      expect(typed.code).toBe("cross_tenant_denied");
      // §13.3: the envelope names fields, never ids.
      expect(typed.message).not.toContain(row.resourceOrg);
      expect(typed.hint ?? "").not.toContain(row.callerOrg);

      const last = logger.warns[logger.warns.length - 1];
      expect(last?.message).toBe("cross_tenant_denied");
      expect(last?.fields).toMatchObject({
        request_id: "req-001",
        workspace_id: row.callerOrg,
        resource_organization_id: row.resourceOrg,
        reason: row.reason,
      });
    }
  });

  it("assertDocAccess is the same seam with resource_kind=document", () => {
    const logger = new CapturingGuardLogger();
    const guard = createResourceGuard({ logger, requestId: "req-002" });

    expect(() => guard.assertDocAccess(ORG_A, callerContext(ORG_A))).not.toThrow();

    let denied: unknown = null;
    try {
      guard.assertDocAccess(ORG_B, callerContext(ORG_A));
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(CrossTenantDeniedError);
    const last = logger.warns[logger.warns.length - 1];
    expect(last?.fields).toMatchObject({
      request_id: "req-002",
      resource_kind: "document",
      reason: "foreign_tenant",
    });
  });

  it("workspace routes surface the same typed 403 through the full HTTP stack", async () => {
    const h = buildGateway();
    const res = await get(h, `/v1/workspaces/${ORG_B}`, TOKENS.ownerA);
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.code).toBe("cross_tenant_denied");
    expect(JSON.stringify(body)).not.toContain(ORG_A);
    expect(JSON.stringify(body)).not.toContain(ORG_B);
  });
});
