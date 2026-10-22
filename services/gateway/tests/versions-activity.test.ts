// M7-D — versions/activity (BUILD_PLAN §M7 task 4) over live Postgres:
// the complete timeline shape, §9.3 restore (NEW version + head move + the
// ORIGINAL row untouched — the immutability pin), confirm-with-confirmation
// semantics, double-restore idempotency (same key → replay; fresh key → a
// distinct append-only row — pinned honestly), labels as the ONLY mutable
// field, exact diff deltas, the merged activity feed with cursor pagination,
// and the admin-only bounded audit export.

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
  readonly name: string;
  readonly email: string;
}

async function newWorkspace(): Promise<Workspace> {
  const jar = new CookieJar();
  const name = unique("Restorer");
  const email = uniqueEmail();
  const response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name },
  });
  expect(response.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Versions WS"), slug: unique("ver-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { jar, id: ws.data.id, name, email };
}

interface TimelineEntry {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly parentVersionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly label: string | null;
  readonly agentRunId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly createdByName: string | null;
  readonly isAgent: boolean;
  readonly sha256Prefix: string;
}

interface VersionRow {
  readonly id: string;
  readonly version: number;
  readonly parentVersionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly label: string | null;
}

interface ActivityEntry {
  readonly id: string;
  readonly projectId: string | null;
  readonly actorId: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

interface DiffResponse {
  readonly fromParent: {
    readonly parentVersionId: string;
    readonly parentVersion: number;
    readonly sizeDeltaBytes: number;
    readonly labelChanged: boolean;
    readonly authorChanged: boolean;
    readonly createdGapMs: number;
  } | null;
  readonly summary: string;
}

async function createProject(ws: Workspace, name: string): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
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
): Promise<VersionRow> {
  const query = new URLSearchParams({
    sha256: fixture.sha256,
    sizeBytes: String(fixture.bytes.byteLength),
  });
  if (typeof options.baseVersionId === "string") query.set("baseVersionId", options.baseVersionId);
  if (options.label !== undefined) query.set("label", options.label);
  const response = await api(
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
      rawBody: new Uint8Array(fixture.bytes),
    },
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: VersionRow };
  return body.data;
}

async function listTimeline(ws: Workspace, projectId: string): Promise<TimelineEntry[]> {
  const response = await api(server.base, `/v1/projects/${projectId}/versions?limit=100`, {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { items: TimelineEntry[] } };
  return body.data.items;
}

async function restore(
  ws: Workspace,
  projectId: string,
  versionId: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return api(server.base, `/v1/projects/${projectId}/versions/${versionId}/restore`, {
    method: "POST",
    jar: ws.jar,
    headers: {
      "x-workspace-id": ws.id,
      "idempotency-key": idempotencyKey ?? unique("restore"),
    },
    body,
  });
}

async function getDiff(ws: Workspace, projectId: string, versionId: string): Promise<Response> {
  return api(server.base, `/v1/projects/${projectId}/versions/${versionId}/diff`, {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
}

async function listActivity(
  ws: Workspace,
  projectId: string,
  query?: { limit?: number; cursor?: string },
): Promise<{ items: ActivityEntry[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) params.set("limit", String(query.limit));
  if (query?.cursor !== undefined) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await api(server.base, `/v1/projects/${projectId}/activity${suffix}`, {
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { items: ActivityEntry[]; nextCursor: string | null };
  };
  return body.data;
}

/** Invite a member (auth-workspace precedent) and return their cookie jar. */
async function inviteMember(
  ws: Workspace,
  role: "editor" | "viewer",
): Promise<{ jar: CookieJar; email: string }> {
  const email = uniqueEmail(role);
  const invite = await api(server.base, `/v1/workspaces/${ws.id}/invites`, {
    method: "POST",
    jar: ws.jar,
    headers: { "idempotency-key": unique("invite") },
    body: { email, role },
  });
  expect(invite.status).toBe(201);
  const inviteBody = (await invite.json()) as { data: { id: string } };
  const jar = new CookieJar();
  const signUp = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email, password: "Passw0rd!longenough", name: unique("Member") },
  });
  expect(signUp.status).toBe(200);
  const accept = await api(server.base, `/v1/invites/${inviteBody.data.id}/accept`, {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("accept") },
    body: {},
  });
  expect(accept.status).toBe(200);
  return { jar, email };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

d("timeline (§9.3): complete shape with author + agent presence", () => {
  let ws: Workspace;
  let projectId: string;
  const v1 = ecprojBytes('{"format":"ecproj","version":1,"compositions":[]}');
  const v2 = ecprojBytes(
    '{"format":"ecproj","version":2,"compositions":[{"id":"comp-main","layers":[{"id":"text-1"}]}]}',
  );
  let v1Id = "";
  let v2Id = "";

  it("uploads two versions", async () => {
    ws = await newWorkspace();
    projectId = await createProject(ws, unique("Timeline"));
    const first = await uploadRaw(ws, projectId, v1, { baseVersionId: null, label: "first save" });
    expect(first.version).toBe(1);
    v1Id = first.id;
    const second = await uploadRaw(ws, projectId, v2, { baseVersionId: v1Id });
    expect(second.version).toBe(2);
    v2Id = second.id;
  });
  it("list returns the complete timeline entry for every row (newest first)", async () => {
    const items = await listTimeline(ws, projectId);
    expect(items.length).toBe(2);
    const [head, root] = items;
    expect(head?.version).toBe(2);
    expect(root?.version).toBe(1);
    for (const entry of items) {
      expect(entry.projectId).toBe(projectId);
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
      // Author: the id plus the DISPLAY NAME for the timeline UI.
      expect(entry.createdBy).toBe(items[0]?.createdBy);
      expect(entry.createdByName).toBe(ws.name);
      // Agent-run presence: these were human uploads (agentRunId null).
      expect(entry.agentRunId).toBeNull();
      expect(entry.isAgent).toBe(false);
      // sha256 present for content addressing, but the UI copy field is the
      // 12-char prefix only.
      expect(entry.sha256Prefix).toBe(entry.sha256.slice(0, 12));
      expect(entry.sha256Prefix).toHaveLength(12);
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
    expect(items[0]?.sha256).toBe(v2.sha256);
    expect(items[0]?.sizeBytes).toBe(v2.bytes.byteLength);
    expect(items[0]?.label).toBeNull();
    expect(items[1]?.sha256).toBe(v1.sha256);
    expect(items[1]?.label).toBe("first save");
    // Parent linkage: v2 → v1 → null.
    expect(items[0]?.parentVersionId).toBe(v1Id);
    expect(items[1]?.parentVersionId).toBeNull();
    expect(items[0]?.id).toBe(v2Id);
    expect(items[1]?.id).toBe(v1Id);
  });

  it("cross-tenant project id reads as 404 (law #3)", async () => {
    const stranger = await newWorkspace();
    const response = await api(server.base, `/v1/projects/${projectId}/versions?limit=10`, {
      jar: stranger.jar,
      headers: { "x-workspace-id": stranger.id },
    });
    expect(response.status).toBe(404);
  });
});

d("restore (§9.3): NEW version, head moves, history NEVER rewritten", () => {
  let ws: Workspace;
  let projectId: string;
  const v1 = ecprojBytes('{"format":"ecproj","version":1,"compositions":[]}');
  const v2 = ecprojBytes('{"format":"ecproj","version":2,"compositions":[{"id":"comp-main"}]}');
  let v1Id = "";
  let v2Id = "";
  let restoredId = "";

  it("sets up v1 (labelled) + v2", async () => {
    ws = await newWorkspace();
    projectId = await createProject(ws, unique("Restore"));
    v1Id = (await uploadRaw(ws, projectId, v1, { baseVersionId: null, label: "first save" })).id;
    v2Id = (await uploadRaw(ws, projectId, v2, { baseVersionId: v1Id })).id;
  });

  it("refuses BARE restores — a confirmation label is required", async () => {
    const noBody = await restore(ws, projectId, v1Id, undefined);
    expect(noBody.status).toBe(400);
    expect(await errorCode(noBody)).toBe("VALIDATION_FAILED");
    const empty = await restore(ws, projectId, v1Id, {});
    expect(empty.status).toBe(400);
    expect(await errorCode(empty)).toBe("VALIDATION_FAILED");
    const blank = await restore(ws, projectId, v1Id, { confirmLabel: "" });
    expect(blank.status).toBe(400);
    expect(await errorCode(blank)).toBe("VALIDATION_FAILED");
    const noteOnly = await restore(ws, projectId, v1Id, { note: "no confirmation" });
    expect(noteOnly.status).toBe(400);
    const still = await listTimeline(ws, projectId);
    expect(still.length).toBe(2); // nothing was created
  });

  it("refuses cross-tenant restores with 404 (never 403)", async () => {
    const stranger = await newWorkspace();
    const response = await restore(stranger, projectId, v1Id, { confirmLabel: "first save" });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).not.toBe("FORBIDDEN");
  });

  it("restore creates a NEW version (parent = restored one), head moves, original untouched", async () => {
    const response = await restore(ws, projectId, v1Id, {
      confirmLabel: "first save",
      note: "roll back",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: VersionRow };
    expect(body.data.version).toBe(3);
    // §9.3 pin: the new row's parent IS the restored version — content
    // lineage; the version NUMBER continues from the head (4 > 3 never used).
    expect(body.data.parentVersionId).toBe(v1Id);
    expect(body.data.sha256).toBe(v1.sha256);
    expect(body.data.sizeBytes).toBe(v1.bytes.byteLength);
    expect(body.data.label).toBe("Restored from v1");
    restoredId = body.data.id;

    // Head moved to the new row.
    const project = await api(server.base, `/v1/projects/${projectId}`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const projectBody = (await project.json()) as { data: { currentVersionId: string | null } };
    expect(projectBody.data.currentVersionId).toBe(restoredId);

    // Immutability pin: the ORIGINAL v1 row is byte-for-byte untouched.
    const items = await listTimeline(ws, projectId);
    expect(items.length).toBe(3);
    const root = items.find((entry) => entry.version === 1);
    expect(root?.id).toBe(v1Id);
    expect(root?.sha256).toBe(v1.sha256);
    expect(root?.sizeBytes).toBe(v1.bytes.byteLength);
    expect(root?.label).toBe("first save");
    expect(root?.parentVersionId).toBeNull();
    expect(root?.createdAt).not.toBe(items.find((entry) => entry.version === 3)?.createdAt);
    const middle = items.find((entry) => entry.version === 2);
    expect(middle?.id).toBe(v2Id);
  });

  it("diff of the restored version reports the identical snapshot exactly", async () => {
    const response = await getDiff(ws, projectId, restoredId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: DiffResponse };
    expect(body.data.fromParent?.parentVersionId).toBe(v1Id);
    expect(body.data.fromParent?.parentVersion).toBe(1);
    expect(body.data.fromParent?.sizeDeltaBytes).toBe(0);
    expect(body.data.fromParent?.labelChanged).toBe(true); // "Restored from v1" vs "first save"
    expect(body.data.fromParent?.authorChanged).toBe(false);
    expect(body.data.fromParent?.createdGapMs).toBeGreaterThanOrEqual(0);
    expect(body.data.summary).toContain("Identical snapshot");
    // Human-safe copy: never the raw 64-char hash.
    expect(body.data.summary).not.toContain(v1.sha256);
  });

  it("diff of v2 reports the exact size delta vs v1; v1 diff has no parent", async () => {
    const v2Diff = await getDiff(ws, projectId, v2Id);
    expect(v2Diff.status).toBe(200);
    const v2Body = (await v2Diff.json()) as { data: DiffResponse };
    expect(v2Body.data.fromParent?.parentVersionId).toBe(v1Id);
    expect(v2Body.data.fromParent?.sizeDeltaBytes).toBe(v2.bytes.byteLength - v1.bytes.byteLength);
    expect(v2Body.data.fromParent?.labelChanged).toBe(true); // null vs "first save"
    expect(v2Body.data.fromParent?.authorChanged).toBe(false);
    expect(v2Body.data.fromParent?.createdGapMs).toBeGreaterThanOrEqual(0);
    expect(v2Body.data.summary).toContain("larger");

    const v1Diff = await getDiff(ws, projectId, v1Id);
    expect(v1Diff.status).toBe(200);
    const v1Body = (await v1Diff.json()) as { data: DiffResponse };
    expect(v1Body.data.fromParent).toBeNull();
    expect(v1Body.data.summary).toContain("First version");
  });

  it("diff is tenant-scoped (404) for strangers and unknown versions", async () => {
    const stranger = await newWorkspace();
    const cross = await getDiff(stranger, projectId, v1Id);
    expect(cross.status).toBe(404);
    const unknown = await getDiff(ws, projectId, "ver_does_not_exist");
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("VERSION_NOT_FOUND");
  });

  it("double-restore: SAME idempotency key replays byte-equal, creating no row", async () => {
    const key = unique("restore-replay");
    const first = await restore(ws, projectId, v1Id, { confirmLabel: "first save" }, key);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: VersionRow };
    const replay = await restore(ws, projectId, v1Id, { confirmLabel: "first save" }, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    const replayBody = (await replay.json()) as { data: VersionRow };
    expect(replayBody.data.id).toBe(firstBody.data.id);
    expect(replayBody.data.version).toBe(firstBody.data.version);
    const items = await listTimeline(ws, projectId);
    expect(items.length).toBe(4); // 3 + exactly ONE restore row
  });

  it("double-restore with a FRESH key creates a DISTINCT row (append-only, pinned honestly: not 409)", async () => {
    const second = await restore(ws, projectId, v1Id, { confirmLabel: "first save" });
    expect(second.status).toBe(201);
    const body = (await second.json()) as { data: VersionRow };
    expect(body.data.version).toBe(5); // head + 1 again
    expect(body.data.parentVersionId).toBe(v1Id);
    expect(body.data.label).toBe("Restored from v1");
    expect(body.data.id).not.toBe(restoredId);

    const items = await listTimeline(ws, projectId);
    expect(items.length).toBe(5);
    // Head moved to the newest restore; the ORIGINAL v1 row is STILL untouched.
    const project = await api(server.base, `/v1/projects/${projectId}`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const projectBody = (await project.json()) as { data: { currentVersionId: string | null } };
    expect(projectBody.data.currentVersionId).toBe(body.data.id);
    const root = items.find((entry) => entry.version === 1);
    expect(root?.id).toBe(v1Id);
    expect(root?.sha256).toBe(v1.sha256);
    expect(root?.label).toBe("first save");
  });

  it("labels: the ONLY mutable field — set, validate, and pin immutability of the rest", async () => {
    const response = await api(server.base, `/v1/projects/${projectId}/versions/${v2Id}/label`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("label") },
      body: { label: "shipped cut" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: VersionRow };
    expect(body.data.label).toBe("shipped cut");
    expect(body.data.sha256).toBe(v2.sha256); // everything else immutable
    expect(body.data.parentVersionId).toBe(v1Id);
    expect(body.data.version).toBe(2);

    const items = await listTimeline(ws, projectId);
    const v2Row = items.find((entry) => entry.version === 2);
    expect(v2Row?.label).toBe("shipped cut");
    expect(v2Row?.sha256).toBe(v2.sha256);

    // Bounds: 1–120 chars (D-24 candidate).
    const empty = await api(server.base, `/v1/projects/${projectId}/versions/${v2Id}/label`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("label") },
      body: { label: "" },
    });
    expect(empty.status).toBe(400);
    const tooLong = await api(server.base, `/v1/projects/${projectId}/versions/${v2Id}/label`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("label") },
      body: { label: "x".repeat(121) },
    });
    expect(tooLong.status).toBe(400);
    const unknown = await api(
      server.base,
      `/v1/projects/${projectId}/versions/ver_does_not_exist/label`,
      {
        method: "POST",
        jar: ws.jar,
        headers: { "x-workspace-id": ws.id, "idempotency-key": unique("label") },
        body: { label: "nope" },
      },
    );
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("VERSION_NOT_FOUND");
    const stranger = await newWorkspace();
    const cross = await api(server.base, `/v1/projects/${projectId}/versions/${v2Id}/label`, {
      method: "POST",
      jar: stranger.jar,
      headers: { "x-workspace-id": stranger.id, "idempotency-key": unique("label") },
      body: { label: "not mine" },
    });
    expect(cross.status).toBe(404);
    expect(await errorCode(cross)).not.toBe("FORBIDDEN");
  });
});

d("activity feed + audit export", () => {
  let ws: Workspace;
  let projectId: string;
  const v1 = ecprojBytes('{"format":"ecproj","version":1}');
  const v2 = ecprojBytes('{"format":"ecproj","version":2,"compositions":[]}');
  let v1Id = "";
  let restoredId = "";

  it("seeds uploads + a restore + a label", async () => {
    ws = await newWorkspace();
    projectId = await createProject(ws, unique("Activity"));
    v1Id = (await uploadRaw(ws, projectId, v1, { baseVersionId: null, label: "first" })).id;
    const v2Row = await uploadRaw(ws, projectId, v2, { baseVersionId: v1Id });
    const restoreResponse = await restore(ws, projectId, v1Id, { confirmLabel: "first" });
    expect(restoreResponse.status).toBe(201);
    restoredId = ((await restoreResponse.json()) as { data: VersionRow }).data.id;
    const labelResponse = await api(
      server.base,
      `/v1/projects/${projectId}/versions/${v2Row.id}/label`,
      {
        method: "POST",
        jar: ws.jar,
        headers: { "x-workspace-id": ws.id, "idempotency-key": unique("label") },
        body: { label: "shipped" },
      },
    );
    expect(labelResponse.status).toBe(200);
  });

  it("feed merges project- AND version-targeted rows with actor names, newest first", async () => {
    const { items } = await listActivity(ws, projectId);
    const actions = items.map((entry) => entry.action).sort();
    expect(actions).toEqual(
      [
        "project.created",
        "version.labeled",
        "version.restored",
        "version.uploaded",
        "version.uploaded",
      ].sort(),
    );
    for (const entry of items) {
      expect(entry.projectId).toBe(projectId);
      expect(entry.actorName).toBe(ws.name);
      expect(entry.actorId).toBeTruthy();
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
    }
    // Version-targeted rows resolve through the version join.
    const restoredRow = items.find((entry) => entry.action === "version.restored");
    expect(restoredRow?.targetType).toBe("version");
    expect(restoredRow?.targetId).toBe(restoredId);
    const labeledRow = items.find((entry) => entry.action === "version.labeled");
    expect(labeledRow?.targetType).toBe("version");
    // Project-targeted rows carry the project as target.
    const createdRow = items.find((entry) => entry.action === "project.created");
    expect(createdRow?.targetType).toBe("project");
    expect(createdRow?.targetId).toBe(projectId);
    // Newest-first ordering by (createdAt, id).
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1];
      const curr = items[i];
      if (prev === undefined || curr === undefined) {
        throw new Error("activity feed ordering walk hit a missing row");
      }
      expect(prev.createdAt >= curr.createdAt).toBe(true);
    }
  });

  it("feed paginates with the cursor (no dupes, order preserved, complete coverage)", async () => {
    const all = await listActivity(ws, projectId);
    expect(all.items.length).toBe(5);
    const collected: ActivityEntry[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listActivity(ws, projectId, { limit: 2, cursor });
      collected.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(collected.length).toBe(all.items.length);
    expect(new Set(collected.map((entry) => entry.id)).size).toBe(collected.length);
    expect(collected.map((entry) => entry.id)).toEqual(all.items.map((entry) => entry.id));
  });

  it("feed is tenant-scoped (404) for strangers", async () => {
    const stranger = await newWorkspace();
    const response = await api(server.base, `/v1/projects/${projectId}/activity?limit=5`, {
      jar: stranger.jar,
      headers: { "x-workspace-id": stranger.id },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("PROJECT_NOT_FOUND");
  });

  it("audit export: admin-only attachment with the raw audit surface (emails allowed HERE)", async () => {
    const response = await api(server.base, `/v1/projects/${projectId}/audit-export`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition.startsWith('attachment; filename="studio-audit-')).toBe(true);
    expect(disposition.endsWith('.json"')).toBe(true);

    const body = (await response.json()) as {
      data: {
        projectId: string;
        generatedAt: string;
        maxRows: number;
        rowCount: number;
        truncated: boolean;
        rows: {
          id: string;
          actorId: string | null;
          actorName: string | null;
          actorEmail: string | null;
          action: string;
          targetType: string | null;
          targetId: string | null;
          metadata: unknown;
          ip: string | null;
          createdAt: string;
        }[];
      };
    };
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.maxRows).toBe(1000); // the bound (AUDIT_EXPORT_MAX_ROWS)
    expect(body.data.truncated).toBe(false);
    expect(body.data.rowCount).toBe(body.data.rows.length);
    expect(body.data.rows.length).toBe(5);
    const restoredRow = body.data.rows.find((row) => row.action === "version.restored");
    expect(restoredRow?.targetType).toBe("version");
    expect(restoredRow?.targetId).toBe(restoredId);
    // Law-#1 nuance: ids/emails are allowed in the ADMIN EXPORT, not UI copy.
    expect(restoredRow?.actorEmail).toBe(ws.email);
    const restoredMetadata = restoredRow?.metadata as {
      restoredFromId?: string;
      confirmLabel?: string;
    };
    expect(restoredMetadata.restoredFromId).toBe(v1Id);
    expect(restoredMetadata.confirmLabel).toBe("first");
  });

  it("audit export: a member (editor) is FORBIDDEN; strangers get 404", async () => {
    const member = await inviteMember(ws, "editor");
    const forbidden = await api(server.base, `/v1/projects/${projectId}/audit-export`, {
      jar: member.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe("FORBIDDEN");

    const stranger = await newWorkspace();
    const cross = await api(server.base, `/v1/projects/${projectId}/audit-export`, {
      jar: stranger.jar,
      headers: { "x-workspace-id": stranger.id },
    });
    expect(cross.status).toBe(404);
    expect(await errorCode(cross)).toBe("PROJECT_NOT_FOUND");
  });
});

d("restore + label respect the single-writer lease (§11, M7-C guard)", () => {
  it("a lease held by another member blocks restore/label with 409 LEASE_HELD", async () => {
    const ws = await newWorkspace();
    const projectId = await createProject(ws, unique("Leased"));
    const v1 = ecprojBytes('{"format":"ecproj","version":1}');
    const v1Id = (await uploadRaw(ws, projectId, v1, { baseVersionId: null })).id;

    const member = await inviteMember(ws, "editor");
    const acquire = await api(server.base, `/v1/projects/${projectId}/lease`, {
      method: "POST",
      jar: member.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("lease") },
      body: { sessionId: unique("sess") },
    });
    expect(acquire.status).toBe(200);
    const acquireBody = (await acquire.json()) as { data: { acquired: boolean } };
    expect(acquireBody.data.acquired).toBe(true);

    const blockedRestore = await restore(ws, projectId, v1Id, { confirmLabel: "first" });
    expect(blockedRestore.status).toBe(409);
    expect(await errorCode(blockedRestore)).toBe("LEASE_HELD");

    const blockedLabel = await api(
      server.base,
      `/v1/projects/${projectId}/versions/${v1Id}/label`,
      {
        method: "POST",
        jar: ws.jar,
        headers: { "x-workspace-id": ws.id, "idempotency-key": unique("label") },
        body: { label: "nope" },
      },
    );
    expect(blockedLabel.status).toBe(409);
    expect(await errorCode(blockedLabel)).toBe("LEASE_HELD");

    // Nothing changed: no restore row was created.
    const items = await listTimeline(ws, projectId);
    expect(items.length).toBe(1);
  });
});
