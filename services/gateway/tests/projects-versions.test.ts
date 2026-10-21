// W3-gw — projects, versions and the §9.3 optimistic-concurrency protocol,
// end-to-end over HTTP against live Postgres: upload v1, advance to v2,
// reject a stale base (409 PROJECT_VERSION_CONFLICT, row NOT created), the
// manifest with signed URLs, and restore-as-new-version.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CookieJar,
  HAS_DATABASE,
  api,
  bootServer,
  unique,
  uniqueEmail,
  type RunningTestServer,
} from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

let server: RunningTestServer;

beforeAll(async () => {
  server = await bootServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

interface Workspace {
  readonly jar: CookieJar;
  readonly id: string;
}

async function newWorkspace(): Promise<Workspace> {
  const jar = new CookieJar();
  const response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail(), password: "Passw0rd!longenough", name: "Versioner" },
  });
  expect(response.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Versions WS"), slug: unique("ver-ws") },
  });
  const ws = (await wsResponse.json()) as { data: { id: string } };
  expect(wsResponse.status).toBe(201);
  return { jar, id: ws.data.id };
}

interface VersionDto {
  readonly id: string;
  readonly version: number;
  readonly parentVersionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly label: string | null;
}

async function createProject(ws: Workspace, name: string): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string; currentVersionId: string | null } };
  expect(body.data.currentVersionId).toBeNull();
  return body.data.id;
}

function ecprojBytes(text: string): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(text, "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function uploadRaw(
  ws: Workspace,
  projectId: string,
  fixture: { bytes: Buffer; sha256: string },
  options: { baseVersionId?: string | null; label?: string } = {},
): Promise<Response> {
  const query = new URLSearchParams({ sha256: fixture.sha256, sizeBytes: String(fixture.bytes.byteLength) });
  // A null base means "first snapshot" — omit the parameter entirely.
  if (typeof options.baseVersionId === "string") query.set("baseVersionId", options.baseVersionId);
  if (options.label !== undefined) query.set("label", options.label);
  return api(server.base, `/v1/projects/${projectId}/versions?${query.toString()}`, {
    method: "POST",
    jar: ws.jar,
    headers: {
      "x-workspace-id": ws.id,
      "idempotency-key": unique("upload"),
      "content-type": "application/octet-stream",
    },
    rawBody: new Uint8Array(fixture.bytes),
  });
}

async function uploadMultipart(
  ws: Workspace,
  projectId: string,
  fixture: { bytes: Buffer; sha256: string },
  baseVersionId: string | null,
): Promise<Response> {
  const descriptor = JSON.stringify({
    baseVersionId,
    sha256: fixture.sha256,
    sizeBytes: fixture.bytes.byteLength,
  });
  const form = new FormData();
  form.append("descriptor", descriptor);
  form.append("file", new Blob([new Uint8Array(fixture.bytes)]), "project.ecproj");
  // No content-type header: fetch derives multipart/form-data + boundary.
  return api(server.base, `/v1/projects/${projectId}/versions`, {
    method: "POST",
    jar: ws.jar,
    headers: {
      "x-workspace-id": ws.id,
      "idempotency-key": unique("upload"),
    },
    rawBody: form,
  });
}

async function listVersions(ws: Workspace, projectId: string): Promise<VersionDto[]> {
  const response = await api(server.base, `/v1/projects/${projectId}/versions?limit=100`, {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { items: VersionDto[] } };
  return body.data.items;
}

d("version lifecycle (§9.3)", () => {
  let ws: Workspace;
  let projectId: string;
  const v1 = ecprojBytes('{"format":"ecproj","version":1,"compositions":[]}');
  const v2 = ecprojBytes('{"format":"ecproj","version":2,"compositions":[{"id":"comp-main"}]}');
  const stale = ecprojBytes('{"format":"ecproj","version":3,"compositions":[]}');

  let v1Id = "";
  let v2Id = "";

  it("creates a project with no current version", async () => {
    ws = await newWorkspace();
    projectId = await createProject(ws, unique("Lifecycle"));
  });

  it("uploads version 1 (raw bytes, base omitted) → version 1, parent null", async () => {
    const response = await uploadRaw(ws, projectId, v1, { baseVersionId: null, label: "first save" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: VersionDto };
    expect(body.data.version).toBe(1);
    expect(body.data.parentVersionId).toBeNull();
    expect(body.data.sha256).toBe(v1.sha256);
    expect(body.data.label).toBe("first save");
    v1Id = body.data.id;
  });

  it("uploads version 2 (multipart) with the correct base → version 2, parent = v1", async () => {
    const response = await uploadMultipart(ws, projectId, v2, v1Id);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: VersionDto };
    expect(body.data.version).toBe(2);
    expect(body.data.parentVersionId).toBe(v1Id);
    v2Id = body.data.id;
  });

  it("rejects a STALE base with 409 PROJECT_VERSION_CONFLICT and creates no row", async () => {
    const before = await listVersions(ws, projectId);
    expect(before.length).toBe(2);
    const response = await uploadMultipart(ws, projectId, stale, v1Id);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("PROJECT_VERSION_CONFLICT");
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.requestId).toBe("string");
    const after = await listVersions(ws, projectId);
    expect(after.length).toBe(2);
  });

  it("rejects mismatched sha256 (SHA256_MISMATCH, nothing stored)", async () => {
    const lying = {
      bytes: ecprojBytes("honest bytes for the mismatch test").bytes,
      sha256: createHash("sha256").update("different bytes").digest("hex"),
    };
    const rejected = await uploadRaw(ws, projectId, lying, { baseVersionId: v2Id });
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SHA256_MISMATCH");
    const history = await listVersions(ws, projectId);
    expect(history.length).toBe(2);
  });

  it("manifest returns the current version (v2) with a 10-minute signed URL", async () => {
    const response = await api(server.base, `/v1/projects/${projectId}/manifest`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        projectId: string;
        currentVersion: { id: string; version: number; sha256: string; url: string } | null;
        assets: unknown[];
        updatedAt: string;
      };
    };
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.currentVersion).not.toBeNull();
    expect(body.data.currentVersion?.version).toBe(2);
    expect(body.data.currentVersion?.sha256).toBe(v2.sha256);
    // LocalFS driver: signed URLs are unguessable tokens served by the gateway
    expect(body.data.currentVersion?.url).toContain("/v1/local-storage/");
    expect(body.data.assets).toEqual([]);
  });

  it("restore v1 creates a NEW version row (version 3, parent = v1); history is never rewritten", async () => {
    const response = await api(server.base, `/v1/projects/${projectId}/versions/${v1Id}/restore`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("restore") },
      body: { note: "roll back to the first save" },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: VersionDto };
    expect(body.data.version).toBe(3);
    expect(body.data.parentVersionId).toBe(v1Id);
    expect(body.data.sha256).toBe(v1.sha256);
    expect(body.data.label).toBe("roll back to the first save");

    const history = await listVersions(ws, projectId);
    expect(history.length).toBe(3);
    const v1Row = history.find((entry) => entry.version === 1);
    const v2Row = history.find((entry) => entry.version === 2);
    expect(v1Row?.sha256).toBe(v1.sha256);
    expect(v2Row?.sha256).toBe(v2.sha256);

    const project = await api(server.base, `/v1/projects/${projectId}`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const projectBody = (await project.json()) as { data: { currentVersionId: string } };
    expect(projectBody.data.currentVersionId).toBe(body.data.id);
  });

  it("uploading after the restore needs the new base (the restore advanced the head)", async () => {
    const v4 = ecprojBytes('{"format":"ecproj","version":4}');
    const staleBase = await uploadRaw(ws, projectId, v4, { baseVersionId: v2Id });
    expect(staleBase.status).toBe(409);
    const history = await listVersions(ws, projectId);
    const head = history.find((entry) => entry.version === 3);
    expect(head).toBeDefined();
    const ok = await uploadRaw(ws, projectId, v4, { baseVersionId: head?.id });
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { data: VersionDto };
    expect(okBody.data.version).toBe(4);
  });
});

d("project scoping (§12.1)", () => {
  it("a project from another workspace reads as 404 PROJECT_NOT_FOUND", async () => {
    const wsA = await newWorkspace();
    const wsB = await newWorkspace();
    const projectId = await createProject(wsA, unique("Private"));
    const response = await api(server.base, `/v1/projects/${projectId}`, {
      jar: wsB.jar,
      headers: { "x-workspace-id": wsB.id },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("soft-delete removes a project from the list but keeps direct reads off (§7.2 DELETE)", async () => {
    const ws = await newWorkspace();
    const projectId = await createProject(ws, unique("Doomed"));
    const response = await api(server.base, `/v1/projects/${projectId}`, {
      method: "DELETE",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(response.status).toBe(200);
    const list = await api(server.base, "/v1/projects?limit=100", {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const listBody = (await list.json()) as { data: { items: { id: string }[] } };
    expect(listBody.data.items.some((entry) => entry.id === projectId)).toBe(false);
    const gone = await api(server.base, `/v1/projects/${projectId}`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(gone.status).toBe(404);
  });
});
