// Perf round — `GET /v1/projects/resolve/:slug` end-to-end over HTTP against
// live Postgres: the ONE-call by-slug resolution (auth pass + joined SQL +
// manifest + signed URLs) that replaced the RSC `/v1/me` + per-workspace
// project-page fan-out. Cross-tenant slugs are indistinguishable 404s (hard
// rule 3), soft-deleted and archived rows are unresolvable (list-view parity),
// and `?workspace=<id-or-slug>` narrows the search without leaking foreign
// workspaces.

import { createHash } from "node:crypto";

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
  readonly slug: string;
}

async function newWorkspace(): Promise<Workspace> {
  const jar = new CookieJar();
  const response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail(), password: "Passw0rd!longenough", name: "Resolver" },
  });
  expect(response.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Resolve WS"), slug: unique("resolve-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string; slug: string } };
  return { jar, id: ws.data.id, slug: ws.data.slug };
}

async function createProject(ws: Workspace, name: string): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string; slug: string } };
  return body.data.id;
}

async function resolve(jar: CookieJar | null, slug: string, ws?: string): Promise<Response> {
  const query = ws === undefined ? "" : `?workspace=${encodeURIComponent(ws)}`;
  return api(server.base, `/v1/projects/resolve/${encodeURIComponent(slug)}${query}`, {
    jar,
  });
}

interface ResolveBody {
  readonly data: {
    readonly workspaceId: string;
    readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
    readonly viewerId: string;
    readonly role: string;
    readonly project: {
      readonly id: string;
      readonly name: string;
      readonly slug: string;
      readonly archived: boolean;
      readonly currentVersionId: string | null;
    };
    readonly manifest: {
      readonly projectId: string;
      readonly currentVersion: {
        readonly id: string;
        readonly version: number;
        readonly sha256: string;
        readonly url: string;
      } | null;
      readonly assets: readonly { readonly id: string; readonly url: string }[];
    };
  };
}

d("project resolution by slug", () => {
  let ws: Workspace;
  let otherWs: Workspace;
  let slug = "";
  let projectId = "";
  const fixture = Buffer.from('{"format":"ecproj","version":1,"compositions":[]}');
  const fixtureSha = createHash("sha256").update(fixture).digest("hex");

  it("resolves in ONE call: workspace + role + viewer + project + manifest", async () => {
    ws = await newWorkspace();
    projectId = await createProject(ws, unique("Resolve Me"));
    const me = (await (await api(server.base, "/v1/me", { jar: ws.jar })).json()) as {
      data: { project?: never; user: { id: string } };
    };
    // The project's slug (create derives it from the name).
    const row = (await (
      await api(server.base, `/v1/projects/${projectId}`, {
        jar: ws.jar,
        headers: { "x-workspace-id": ws.id },
      })
    ).json()) as { data: { slug: string } };
    slug = row.data.slug;

    const response = await resolve(ws.jar, slug);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ResolveBody;
    expect(body.data.workspaceId).toBe(ws.id);
    expect(body.data.workspace.id).toBe(ws.id);
    expect(body.data.workspace.slug).toBe(ws.slug);
    expect(body.data.viewerId).toBe(me.data.user.id);
    expect(body.data.role).toBe("owner");
    expect(body.data.project.id).toBe(projectId);
    expect(body.data.project.slug).toBe(slug);
    expect(body.data.project.archived).toBe(false);
    // No versions yet: the start-from-scratch editor boot shape.
    expect(body.data.manifest.projectId).toBe(projectId);
    expect(body.data.manifest.currentVersion).toBeNull();
  });

  it("carries the current version with a signed URL after an upload", async () => {
    const query = new URLSearchParams({
      sha256: fixtureSha,
      sizeBytes: String(fixture.byteLength),
    });
    const upload = await api(
      server.base,
      `/v1/projects/${projectId}/versions?${query.toString()}`,
      {
        method: "POST",
        jar: ws.jar,
        headers: {
          "x-workspace-id": ws.id,
          "idempotency-key": unique("upload"),
          "content-type": "application/octet-stream",
        },
        rawBody: new Uint8Array(fixture),
      },
    );
    expect(upload.status).toBe(201);

    const response = await resolve(ws.jar, slug);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ResolveBody;
    expect(body.data.manifest.currentVersion).not.toBeNull();
    expect(body.data.manifest.currentVersion?.version).toBe(1);
    expect(body.data.manifest.currentVersion?.sha256).toBe(fixtureSha);
    expect(body.data.manifest.currentVersion?.url).toMatch(/^https?:\/\//);
    expect(body.data.project.currentVersionId).toBe(body.data.manifest.currentVersion?.id);
  });

  it("404s the same slug for a foreign session (cross-tenant = indistinguishable)", async () => {
    const foreign = await newWorkspace();
    const response = await resolve(foreign.jar, slug);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("401s without a session", async () => {
    const response = await resolve(null, slug);
    expect(response.status).toBe(401);
  });

  it("404s archived projects (list-view parity)", async () => {
    const archived = await api(server.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "content-type": "application/json" },
      body: { archived: true },
    });
    expect(archived.status).toBe(200);

    expect((await resolve(ws.jar, slug)).status).toBe(404);
  });

  it("404s soft-deleted projects", async () => {
    const other = await createProject(ws, unique("Doomed"));
    const row = (await (
      await api(server.base, `/v1/projects/${other}`, {
        jar: ws.jar,
        headers: { "x-workspace-id": ws.id },
      })
    ).json()) as { data: { slug: string } };
    const del = await api(server.base, `/v1/projects/${other}`, {
      method: "DELETE",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(del.status).toBe(200);
    expect((await resolve(ws.jar, row.data.slug)).status).toBe(404);
  });

  it("narrows with ?workspace=<slug> and never leaks foreign workspaces", async () => {
    // A fresh workspace (same user) with its own project; the OLD slug lives
    // only in the first workspace.
    otherWs = await newWorkspace();
    const otherProject = await createProject(otherWs, unique("Other Project"));
    const row = (await (
      await api(server.base, `/v1/projects/${otherProject}`, {
        jar: otherWs.jar,
        headers: { "x-workspace-id": otherWs.id },
      })
    ).json()) as { data: { slug: string } };

    // ?workspace=<B slug> finds B's project …
    const hit = await resolve(otherWs.jar, row.data.slug, otherWs.slug);
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as ResolveBody;
    expect(body.data.workspaceId).toBe(otherWs.id);
    // … and does NOT resolve the first workspace's project (filtered, not
    // fallen back: a wrong filter is a 404, never a silent other-workspace
    // answer).
    expect((await resolve(ws.jar, row.data.slug, ws.slug)).status).toBe(404);
    // Id form works too.
    const byId = await resolve(otherWs.jar, row.data.slug, otherWs.id);
    expect(byId.status).toBe(200);
  });
});
