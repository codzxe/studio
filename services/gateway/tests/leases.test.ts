// W3-gw — single-writer lease semantics over HTTP against live Postgres
// (§9.3, §11): acquire, refusal (read-only) for a different editor, renew by
// re-acquire, release, and expiry via a short LEASE_TTL_MS.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  unique,
  uniqueEmail,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

/** Short TTL for the expiry test (leases repo enforces ≥1000ms). */
const SHORT_TTL_MS = 1500;

let server: RunningTestServer;

beforeAll(async () => {
  server = await bootServer({
    env: { LEASE_TTL_MS: String(SHORT_TTL_MS), LEASE_HEARTBEAT_MS: "1000" },
  });
}, 30_000);

afterAll(async () => {
  await server?.close();
});

interface Workspace {
  readonly id: string;
  readonly ownerJar: CookieJar;
}

async function newWorkspaceWithEditor(): Promise<{ ws: Workspace; editorJar: CookieJar }> {
  // owner
  const ownerJar = new CookieJar();
  let response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar: ownerJar,
    body: {
      email: uniqueEmail("leaseowner"),
      password: "Passw0rd!longenough",
      name: "Lease Owner",
    },
  });
  expect(response.status).toBe(200);
  response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar: ownerJar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Lease WS"), slug: unique("lease-ws") },
  });
  const wsBody = (await response.json()) as { data: { id: string } };
  expect(response.status).toBe(201);
  const ws: Workspace = { id: wsBody.data.id, ownerJar };

  // invite an editor (leases require ≥ editor)
  const editorEmail = uniqueEmail("leaseeditor");
  response = await api(server.base, `/v1/workspaces/${ws.id}/invites`, {
    method: "POST",
    jar: ownerJar,
    headers: { "idempotency-key": unique("invite") },
    body: { email: editorEmail, role: "editor" },
  });
  expect(response.status).toBe(201);
  const invite = (await response.json()) as { data: { id: string } };

  const editorJar = new CookieJar();
  response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar: editorJar,
    body: { email: editorEmail, password: "Passw0rd!longenough", name: "Lease Editor" },
  });
  expect(response.status).toBe(200);
  response = await api(server.base, `/v1/invites/${invite.data.id}/accept`, {
    method: "POST",
    jar: editorJar,
    headers: { "idempotency-key": unique("accept") },
  });
  expect(response.status).toBe(200);

  return { ws, editorJar };
}

async function createProject(ws: Workspace, jar: CookieJar): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Leased Project") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

interface LeaseDecisionDto {
  readonly acquired: boolean;
  readonly holderName: string | null;
  readonly expiresAt: string;
  readonly readOnly: boolean;
}

async function acquire(
  ws: Workspace,
  jar: CookieJar,
  projectId: string,
  sessionId: string,
): Promise<{ status: number; body: LeaseDecisionDto; errCode?: string }> {
  const response = await api(server.base, `/v1/projects/${projectId}/lease`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("lease") },
    body: { sessionId },
  });
  const parsed = (await response.json()) as { data?: LeaseDecisionDto; error?: { code: string } };
  return {
    status: response.status,
    body:
      parsed.data ??
      ({ acquired: false, holderName: null, expiresAt: "", readOnly: false } as LeaseDecisionDto),
    errCode: parsed.error?.code,
  };
}

async function release(
  ws: Workspace,
  jar: CookieJar,
  projectId: string,
): Promise<{ released: boolean }> {
  const response = await api(server.base, `/v1/projects/${projectId}/lease`, {
    method: "DELETE",
    jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { data: { released: boolean } };
  return parsed.data;
}

d("lease lifecycle (§9.3, §11)", () => {
  let ws: Workspace;
  let editorJar: CookieJar;
  let projectId: string;

  beforeAll(async () => {
    const setup = await newWorkspaceWithEditor();
    ws = setup.ws;
    editorJar = setup.editorJar;
    projectId = await createProject(ws, ws.ownerJar);
  });

  it("the first editor acquires the lease (acquired:true, readOnly:false)", async () => {
    const { status, body } = await acquire(ws, ws.ownerJar, projectId, "session-owner-0001");
    expect(status).toBe(200);
    const decision = body as LeaseDecisionDto;
    expect(decision.acquired).toBe(true);
    expect(decision.readOnly).toBe(false);
    expect(decision.holderName).toBe("Lease Owner");
    expect(new Date(decision.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("a second editor's acquire is refused: acquired:false, readOnly:true, holder reported", async () => {
    const { status, body } = await acquire(ws, editorJar, projectId, "session-editor-0002");
    expect(status).toBe(200);
    const decision = body as LeaseDecisionDto;
    expect(decision.acquired).toBe(false);
    expect(decision.readOnly).toBe(true);
    expect(decision.holderName).toBe("Lease Owner");
  });

  it("the holder re-acquiring renews the lease (expiresAt extends)", async () => {
    const first = (await acquire(ws, ws.ownerJar, projectId, "session-owner-0003"))
      .body as LeaseDecisionDto;
    const later = (await acquire(ws, ws.ownerJar, projectId, "session-owner-0004"))
      .body as LeaseDecisionDto;
    expect(later.acquired).toBe(true);
    expect(later.readOnly).toBe(false);
    expect(new Date(later.expiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.expiresAt).getTime(),
    );
  });

  it("the holder releases; the other editor can then acquire", async () => {
    const released = await release(ws, ws.ownerJar, projectId);
    expect(released.released).toBe(true);
    const taken = (await acquire(ws, editorJar, projectId, "session-editor-0005"))
      .body as LeaseDecisionDto;
    expect(taken.acquired).toBe(true);
    expect(taken.holderName).toBe("Lease Editor");
  });

  it("releasing an unheld lease reports released:false", async () => {
    await release(ws, editorJar, projectId);
    const released = await release(ws, editorJar, projectId);
    expect(released.released).toBe(false);
  });

  it("an expired lease can be stolen (short TTL via env)", async () => {
    await acquire(ws, ws.ownerJar, projectId, "session-owner-0006");
    // TTL is 1500ms — the other editor waits it out and takes over.
    await new Promise((resolve) => setTimeout(resolve, SHORT_TTL_MS + 600));
    const stolen = (await acquire(ws, editorJar, projectId, "session-editor-0007"))
      .body as LeaseDecisionDto;
    expect(stolen.acquired).toBe(true);
    expect(stolen.holderName).toBe("Lease Editor");
  });
});

d("lease + tenancy (§12.1)", () => {
  it("a project in another workspace cannot be leased (404, never a leak)", async () => {
    const setupA = await newWorkspaceWithEditor();
    const projectId = await createProject(setupA.ws, setupA.ws.ownerJar);
    const setupB = await newWorkspaceWithEditor();
    const response = await api(server.base, `/v1/projects/${projectId}/lease`, {
      method: "POST",
      jar: setupB.editorJar,
      headers: { "x-workspace-id": setupB.ws.id, "idempotency-key": unique("lease") },
      body: { sessionId: "session-foreign-0008" },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});
