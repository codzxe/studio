// M7-A — comments backend (§7.2, §9.1, §11; BUILD_PLAN §M7 task 1; D-15).
//
// DB-gated suite (real HTTP + Postgres): the anchor matrix (project/comp/
// layer/time present+absent), reply threading + the depth ≤ 3 cap, idempotent
// resolve with resolvedBy recorded, the SERVER-side compId filter (D-15),
// cursor pagination, tenant 404s, and hostile bodies as inert data.
// No-DB suite: the pinned guest handler (`createGuestComment`) via direct
// deps injection — body validation, per-IP rate-limit seam, audit shape.

import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Repos } from "@studio/db";

import { type AppBindings, type GatewayDeps } from "../src/context.js";
import { toErrorEnvelope } from "../src/errors.js";
import { createInMemoryRateLimiter } from "../src/rate-limit.js";
import { createGuestComment } from "../src/routes/comments.js";
import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  stubDeps,
  testEnv,
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
  readonly id: string;
  readonly ownerJar: CookieJar;
  readonly editorJar: CookieJar;
}

/** Owner workspace + one invited editor (two member identities to resolve with). */
async function newWorkspaceWithEditor(): Promise<Workspace> {
  const ownerJar = new CookieJar();
  let response = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar: ownerJar,
    body: {
      email: uniqueEmail("cmtowner"),
      password: "Passw0rd!longenough",
      name: "Comment Owner",
    },
  });
  expect(response.status).toBe(200);
  response = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar: ownerJar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Comments WS"), slug: unique("comments-ws") },
  });
  expect(response.status).toBe(201);
  const wsBody = (await response.json()) as { data: { id: string } };

  const editorEmail = uniqueEmail("cmteditor");
  response = await api(server.base, `/v1/workspaces/${wsBody.data.id}/invites`, {
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
    body: {
      email: editorEmail,
      password: "Passw0rd!longenough",
      name: "Comment Editor",
    },
  });
  expect(response.status).toBe(200);
  response = await api(server.base, `/v1/invites/${invite.data.id}/accept`, {
    method: "POST",
    jar: editorJar,
    headers: { "idempotency-key": unique("accept") },
  });
  expect(response.status).toBe(200);

  return { id: wsBody.data.id, ownerJar, editorJar };
}

async function createProject(ws: Workspace, jar: CookieJar): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("Commented Project") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

interface CommentDto {
  readonly id: string;
  readonly projectId: string;
  readonly compId: string;
  readonly layerId: string | null;
  readonly timeTicks: number | null;
  readonly parentCommentId: string | null;
  readonly body: string;
  readonly authorId: string | null;
  readonly guestName: string | null;
  readonly guestEmail: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly createdAt: string;
}

async function createComment(
  ws: Workspace,
  jar: CookieJar,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; comment?: CommentDto; code?: string }> {
  const response = await api(server.base, `/v1/projects/${projectId}/comments`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("cmt") },
    body,
  });
  const parsed = (await response.json()) as { data?: CommentDto; error?: { code: string } };
  return { status: response.status, comment: parsed.data, code: parsed.error?.code };
}

/** Narrowing helper: the caller asserts presence, this returns the row. */
function expectComment(result: {
  status: number;
  comment?: CommentDto;
  code?: string;
}): CommentDto {
  expect(result.comment).toBeDefined();
  return result.comment as CommentDto;
}

async function reply(
  ws: Workspace,
  jar: CookieJar,
  commentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; comment?: CommentDto; code?: string }> {
  const response = await api(server.base, `/v1/comments/${commentId}/replies`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("rpl") },
    body,
  });
  const parsed = (await response.json()) as { data?: CommentDto; error?: { code: string } };
  return { status: response.status, comment: parsed.data, code: parsed.error?.code };
}

async function resolveComment(
  ws: Workspace,
  jar: CookieJar,
  commentId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; comment?: CommentDto; code?: string }> {
  const response = await api(server.base, `/v1/comments/${commentId}/resolve`, {
    method: "POST",
    jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("res") },
    body,
  });
  const parsed = (await response.json()) as { data?: CommentDto; error?: { code: string } };
  return { status: response.status, comment: parsed.data, code: parsed.error?.code };
}

async function listComments(
  ws: Workspace,
  projectId: string,
  query: string,
): Promise<{ status: number; items: CommentDto[]; nextCursor: string | null; code?: string }> {
  const response = await api(server.base, `/v1/projects/${projectId}/comments${query}`, {
    method: "GET",
    jar: ws.ownerJar,
    headers: { "x-workspace-id": ws.id },
  });
  const parsed = (await response.json()) as {
    data?: { items: CommentDto[]; nextCursor: string | null };
    error?: { code: string };
  };
  return {
    status: response.status,
    items: parsed.data?.items ?? [],
    nextCursor: parsed.data?.nextCursor ?? null,
    code: parsed.error?.code,
  };
}

d("comment anchors (§M7 task 1: project/comp/layer/time)", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithEditor();
    projectId = await createProject(ws, ws.ownerJar);
  });

  it("anchors to comp alone; layer/time stay null", async () => {
    const { status, comment } = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: "Anchor: comp only",
    });
    expect(status).toBe(201);
    expect(comment?.compId).toBe("comp_main");
    expect(comment?.layerId).toBeNull();
    expect(comment?.timeTicks).toBeNull();
    expect(comment?.parentCommentId).toBeNull();
    expect(comment?.authorId).not.toBeNull();
    expect(comment?.guestName).toBeNull();
    expect(comment?.guestEmail).toBeNull();
    expect(comment?.resolvedAt).toBeNull();
    expect(comment?.resolvedBy).toBeNull();
  });

  it("anchors to comp+layer, comp+time and comp+layer+time", async () => {
    const layerOnly = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      layerId: "layer_logo",
      body: "comp+layer",
    });
    expect(layerOnly.comment?.layerId).toBe("layer_logo");
    expect(layerOnly.comment?.timeTicks).toBeNull();

    const timeOnly = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      timeTicks: 1200,
      body: "comp+time",
    });
    expect(timeOnly.comment?.layerId).toBeNull();
    expect(timeOnly.comment?.timeTicks).toBe(1200);

    const full = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      layerId: "layer_logo",
      timeTicks: 2400,
      body: "comp+layer+time",
    });
    expect(full.comment?.layerId).toBe("layer_logo");
    expect(full.comment?.timeTicks).toBe(2400);
  });

  it("rejects a comment with no comp anchor and negative/fractional time", async () => {
    const noAnchor = await createComment(ws, ws.ownerJar, projectId, { body: "no anchor" });
    expect(noAnchor.status).toBe(400);
    expect(noAnchor.code).toBe("VALIDATION_FAILED");

    const negative = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      timeTicks: -1,
      body: "negative time",
    });
    expect(negative.status).toBe(400);

    const fractional = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      timeTicks: 1.5,
      body: "fractional time",
    });
    expect(fractional.status).toBe(400);
  });
});

d("replies thread via parentCommentId; depth capped at 3 (§M7 task 1)", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithEditor();
    projectId = await createProject(ws, ws.ownerJar);
  });

  it("a reply inherits the parent's full anchor and links the thread", async () => {
    const root = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      layerId: "layer_logo",
      timeTicks: 900,
      body: "root: does the title land at 1s?",
    });
    expect(root.status).toBe(201);
    const rootRow = expectComment(root);

    const first = await reply(ws, ws.editorJar, rootRow.id, { body: "reply: yes, mostly" });
    expect(first.status).toBe(201);
    const firstRow = expectComment(first);
    expect(firstRow.parentCommentId).toBe(rootRow.id);
    // Inherited anchor: same comp/layer/time as the thread root.
    expect(firstRow.compId).toBe("comp_main");
    expect(firstRow.layerId).toBe("layer_logo");
    expect(firstRow.timeTicks).toBe(900);

    const second = await reply(ws, ws.ownerJar, firstRow.id, { body: "reply: agree" });
    expect(second.status).toBe(201);
    expect(expectComment(second).parentCommentId).toBe(firstRow.id);
  });

  it("a reply under a depth-3 comment is refused (400, typed)", async () => {
    const root = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_depth",
      body: "depth 1 root",
    });
    const rootRow = expectComment(root);
    const depth2 = await reply(ws, ws.ownerJar, rootRow.id, { body: "depth 2" });
    expect(depth2.status).toBe(201);
    const depth2Row = expectComment(depth2);
    const depth3 = await reply(ws, ws.ownerJar, depth2Row.id, { body: "depth 3" });
    expect(depth3.status).toBe(201);
    const depth3Row = expectComment(depth3);
    const depth4 = await reply(ws, ws.ownerJar, depth3Row.id, {
      body: "depth 4 — refused",
    });
    expect(depth4.status).toBe(400);
    expect(depth4.code).toBe("VALIDATION_FAILED");
  });

  it("replying to an unknown comment is a 404 (never a leak)", async () => {
    const missing = await reply(ws, ws.ownerJar, "cmt_does_not_exist", { body: "reply to void" });
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("COMMENT_NOT_FOUND");
  });
});

d("resolve is idempotent and records the resolver (§M7 task 1)", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithEditor();
    projectId = await createProject(ws, ws.ownerJar);
  });

  it("resolving twice never rewrites the first resolution", async () => {
    const root = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: "resolve me once",
    });
    const rootRow = expectComment(root);

    const first = await resolveComment(ws, ws.editorJar, rootRow.id);
    expect(first.status).toBe(200);
    const firstRow = expectComment(first);
    expect(firstRow.resolvedAt).not.toBeNull();
    expect(firstRow.resolvedBy).not.toBeNull();

    // A second member resolving later changes nothing: first resolver wins.
    const second = await resolveComment(ws, ws.ownerJar, rootRow.id);
    expect(second.status).toBe(200);
    const secondRow = expectComment(second);
    expect(secondRow.resolvedAt).toBe(firstRow.resolvedAt);
    expect(secondRow.resolvedBy).toBe(firstRow.resolvedBy);

    const open = await listComments(ws, projectId, "?resolved=false");
    expect(open.items.some((row) => row.id === rootRow.id)).toBe(false);
    const done = await listComments(ws, projectId, "?resolved=true");
    expect(done.items.some((row) => row.id === rootRow.id)).toBe(true);
  });

  it("resolved:false reopens the thread and clears the resolver", async () => {
    const root = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: "reopen me",
    });
    const rootRow = expectComment(root);
    const resolved = await resolveComment(ws, ws.ownerJar, rootRow.id);
    expect(expectComment(resolved).resolvedBy).not.toBeNull();

    const reopened = await resolveComment(ws, ws.editorJar, rootRow.id, {
      resolved: false,
    });
    expect(reopened.status).toBe(200);
    const reopenedRow = expectComment(reopened);
    expect(reopenedRow.resolvedAt).toBeNull();
    expect(reopenedRow.resolvedBy).toBeNull();
  });

  it("resolving an unknown comment is a 404", async () => {
    const missing = await resolveComment(ws, ws.ownerJar, "cmt_does_not_exist");
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("COMMENT_NOT_FOUND");
  });
});

d("threaded list: D-15 server-side compId filter + cursor pagination", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithEditor();
    projectId = await createProject(ws, ws.ownerJar);
    // 3 comments in comp A, then 2 in comp B (created last so a client-side
    // filter would surface comp B rows in the first unfiltered page).
    for (const body of ["A1", "A2", "A3"]) {
      await createComment(ws, ws.ownerJar, projectId, { compId: "comp_A", body });
    }
    for (const body of ["B1", "B2"]) {
      await createComment(ws, ws.ownerJar, projectId, { compId: "comp_B", body });
    }
  });

  it("compId filters SERVER-side (D-15): full pages of comp A, none of comp B", async () => {
    const page1 = await listComments(ws, projectId, "?compId=comp_A&limit=2");
    expect(page1.status).toBe(200);
    expect(page1.items).toHaveLength(2);
    expect(page1.items.every((row) => row.compId === "comp_A")).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listComments(
      ws,
      projectId,
      `?compId=comp_A&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.items).toHaveLength(1);
    expect(page2.items.every((row) => row.compId === "comp_A")).toBe(true);
    expect(page2.nextCursor).toBeNull();

    const compA = new Set([...page1.items, ...page2.items].map((row) => row.body));
    expect([...compA].sort()).toEqual(["A1", "A2", "A3"]);
  });

  it("the resolved filter composes with the comp filter", async () => {
    const target = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_B",
      body: "B3 — to resolve",
    });
    const targetRow = expectComment(target);
    await resolveComment(ws, ws.ownerJar, targetRow.id);

    const openB = await listComments(ws, projectId, "?compId=comp_B&resolved=false");
    expect(openB.items.every((row) => row.compId === "comp_B")).toBe(true);
    expect(openB.items.some((row) => row.id === targetRow.id)).toBe(false);

    const doneB = await listComments(ws, projectId, "?compId=comp_B&resolved=true");
    expect(doneB.items).toHaveLength(1);
    expect(doneB.items[0]?.id).toBe(targetRow.id);
  });

  it("walks the cursor chain without duplicates or gaps", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const query = `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const result = await listComments(ws, projectId, query);
      expect(result.status).toBe(200);
      seen.push(...result.items.map((row) => row.id));
      pages += 1;
      cursor = result.nextCursor;
      if (cursor === null) break;
      expect(pages).toBeLessThan(20);
    }
    // 6 comments live in this project (5 seeded + B3 from the filter test).
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
  });

  it("a garbage cursor is a typed 400", async () => {
    const bad = await listComments(ws, projectId, "?cursor=not-a-cursor");
    expect(bad.status).toBe(400);
    expect(bad.code).toBe("VALIDATION_FAILED");
  });

  it("a foreign workspace listing reads as 404 PROJECT_NOT_FOUND (§12.1)", async () => {
    const foreign = await newWorkspaceWithEditor();
    const response = await api(server.base, `/v1/projects/${projectId}/comments`, {
      method: "GET",
      jar: foreign.ownerJar,
      headers: { "x-workspace-id": foreign.id },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

d("tenant isolation on the comment object routes (§12.1)", () => {
  it("replying/resolving across tenants is a 404, never 403", async () => {
    const home = await newWorkspaceWithEditor();
    const projectId = await createProject(home, home.ownerJar);
    const root = await createComment(home, home.ownerJar, projectId, {
      compId: "comp_main",
      body: "stay in your lane",
    });
    const rootRow = expectComment(root);

    const foreign = await newWorkspaceWithEditor();
    const foreignReply = await reply(foreign, foreign.ownerJar, rootRow.id, {
      body: "trespassing reply",
    });
    expect(foreignReply.status).toBe(404);
    expect(foreignReply.code).toBe("COMMENT_NOT_FOUND");

    const foreignResolve = await resolveComment(foreign, foreign.ownerJar, rootRow.id);
    expect(foreignResolve.status).toBe(404);
    expect(foreignResolve.code).toBe("COMMENT_NOT_FOUND");

    // The thread was untouched.
    const still = await listComments(home, projectId, "?compId=comp_main");
    expect(still.items).toHaveLength(1);
    expect(still.items[0]?.resolvedAt).toBeNull();
  });
});

d("hostile bodies are bounded or inert data (§8.9, style gates)", () => {
  let ws: Workspace;
  let projectId: string;

  beforeAll(async () => {
    ws = await newWorkspaceWithEditor();
    projectId = await createProject(ws, ws.ownerJar);
  });

  it("body is capped at 2000 chars (2000 ok, 2001 rejected)", async () => {
    const atBound = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: "x".repeat(2000),
    });
    expect(atBound.status).toBe(201);

    const overBound = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: "x".repeat(2001),
    });
    expect(overBound.status).toBe(400);
    expect(overBound.code).toBe("VALIDATION_FAILED");
  });

  it("dunder keys ride the body as inert data; extra JSON keys are rejected", async () => {
    const dunder = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: "review: __proto__ and constructor pollution stays text",
    });
    expect(dunder.status).toBe(201);
    expect(dunder.comment?.body).toContain("__proto__");

    const extraKey = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: "strict object",
      resolvedAt: "2020-01-01T00:00:00Z",
    });
    expect(extraKey.status).toBe(400); // strictObject: unknown keys rejected
  });

  it("RTL/bidi override characters survive as data, byte-identical", async () => {
    const sneaky = "phase ‮ so this reads backwards ‍ an emoji: 🎬";
    const made = await createComment(ws, ws.ownerJar, projectId, {
      compId: "comp_main",
      body: sneaky,
    });
    expect(made.status).toBe(201);
    expect(made.comment?.body).toBe(sneaky);
  });
});

// ---------------------------------------------------------------------------
// Guest handler unit suite (no DB): direct deps injection, pinned seam
// ---------------------------------------------------------------------------

interface FakeCommentRow {
  readonly id: string;
  readonly projectId: string;
  readonly compId: string;
  readonly layerId: string | null;
  readonly timeTicks: number | null;
  readonly parentId: string | null;
  readonly body: string;
  readonly authorId: string | null;
  readonly guestName: string | null;
  readonly guestEmail: string | null;
  readonly shareTokenId: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly createdAt: Date;
}

function fakeCommentRow(input: {
  body: string;
  guestName: string;
  guestEmail: string;
}): FakeCommentRow {
  return {
    id: `cmt_fake_${unique("row")}`,
    projectId: "prj_shared",
    compId: "comp_main",
    layerId: null,
    timeTicks: null,
    parentId: null,
    body: input.body,
    authorId: null,
    guestName: input.guestName,
    guestEmail: input.guestEmail,
    shareTokenId: "sht_verified123",
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date("2026-02-01T00:00:00Z"),
  };
}

describe("createGuestComment (pinned M7-E handler, direct deps injection)", () => {
  interface GuestDeps {
    readonly deps: GatewayDeps;
    readonly createGuestCalls: unknown[];
    readonly auditCalls: unknown[];
    readonly limiterSeen: { ip: string; routeClass: string }[];
  }

  function buildDeps(options?: { readonly allow?: () => boolean }): GuestDeps {
    const createGuestCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const limiterSeen: { ip: string; routeClass: string }[] = [];
    const allow = options?.allow ?? (() => true);
    const commentsRepo = {
      createGuest(_workspaceId: string, input: Record<string, unknown>) {
        createGuestCalls.push(input);
        return fakeCommentRow({
          body: String(input.body),
          guestName: String(input.guestName),
          guestEmail: String(input.guestEmail),
        });
      },
    };
    const auditRepo = {
      append(_workspaceId: string, input: Record<string, unknown>) {
        auditCalls.push(input);
        return {};
      },
    };
    const repos = { comments: commentsRepo, audit: auditRepo } as unknown as Repos;
    const base = stubDeps(testEnv(), { repos });
    const limiter = {
      check(ip: string, routeClass: string) {
        limiterSeen.push({ ip, routeClass });
        return { allowed: allow(), retryAfterSeconds: 7 };
      },
      reset() {},
    };
    const deps: GatewayDeps = { ...base, limiter };
    return { deps, createGuestCalls, auditCalls, limiterSeen };
  }

  function mountGuest(
    deps: GatewayDeps,
    routeClass?: "auth" | "chat" | "mutation" | "read",
  ): Hono<AppBindings> {
    const handler = createGuestComment(
      deps,
      routeClass === undefined ? undefined : { routeClass },
    );
    const app = new Hono<AppBindings>();
    app.use("*", async (c, next) => {
      c.set("deps", deps);
      c.set("requestId", "req_guest_test");
      await next();
    });
    app.onError((error, c) => {
      const { status, envelope } = toErrorEnvelope(error, c.get("requestId") ?? "req_guest_test");
      return c.json(envelope, status as 400);
    });
    app.post("/v1/shares/:token/comments", (c) =>
      handler(c, {
        workspaceId: "ws_shared",
        projectId: "prj_shared",
        shareTokenId: "sht_verified123",
      }),
    );
    return app;
  }

  const guestBody = {
    compId: "comp_main",
    body: "From a client: the logo drifts at 0:12",
    guestName: "Alex Guest",
    guestEmail: "alex@client.test",
  };

  function post(app: Hono<AppBindings>, body: unknown, ip = "203.0.113.9") {
    return app.request("/v1/shares/sht_verified123/comments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body ?? {}),
    });
  }

  /** Raw-bytes POST: a `__proto__` JSON key only survives via raw JSON.parse. */
  function postRaw(app: Hono<AppBindings>, json: string, ip = "203.0.113.9") {
    return app.request("/v1/shares/sht_verified123/comments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: json,
    });
  }

  it("persists a guest row: no author, guest fields + share token recorded", async () => {
    const built = buildDeps();
    const response = await post(mountGuest(built.deps), guestBody);
    expect(response.status).toBe(201);

    const input = built.createGuestCalls[0] as Record<string, unknown>;
    expect(input.authorId).toBeUndefined(); // the repo sets authorId null itself
    expect(input.shareTokenId).toBe("sht_verified123");
    expect(input.projectId).toBe("prj_shared");
    expect(input.guestName).toBe("Alex Guest");
    expect(input.guestEmail).toBe("alex@client.test");

    const data = (await response.json()) as { data: Record<string, unknown> };
    expect(data.data.authorId).toBeNull();
    expect(data.data.guestName).toBe("Alex Guest");
    expect(data.data.guestEmail).toBe("alex@client.test");
  });

  it("audits with no member actor and no guest email in metadata", async () => {
    const built = buildDeps();
    await post(mountGuest(built.deps), guestBody);
    expect(built.auditCalls).toHaveLength(1);
    const entry = built.auditCalls[0] as Record<string, unknown>;
    expect(entry.actorId).toBeNull();
    expect(entry.action).toBe("comment.guest_created");
    expect(entry.targetId).toBe("prj_shared");
    expect(JSON.stringify(entry.metadata)).not.toContain("alex@client.test");
  });

  it("checks the per-IP limiter BEFORE the repo, in the configurable class", async () => {
    const built = buildDeps();
    const app = mountGuest(built.deps);
    await post(app, guestBody, "198.51.100.7");
    expect(built.limiterSeen).toEqual([{ ip: "198.51.100.7", routeClass: "auth" }]);

    const custom = buildDeps();
    const appCustom = mountGuest(custom.deps, "mutation");
    await post(appCustom, guestBody, "198.51.100.8");
    expect(custom.limiterSeen).toEqual([{ ip: "198.51.100.8", routeClass: "mutation" }]);
  });

  it("a disallowed bucket returns 429 RATE_LIMITED with Retry-After, repo untouched", async () => {
    const built = buildDeps({ allow: () => false });
    const response = await post(mountGuest(built.deps), guestBody);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryable).toBe(true);
    expect(built.createGuestCalls).toHaveLength(0);
  });

  it("rejects hostile guest bodies: 2001 chars, 81-char name, malformed email, dunder key", async () => {
    const built = buildDeps();
    const app = mountGuest(built.deps);

    const longBody = await post(app, { ...guestBody, body: "x".repeat(2001) });
    expect(longBody.status).toBe(400);

    const longName = await post(app, { ...guestBody, guestName: "x".repeat(81) });
    expect(longName.status).toBe(400);

    const longEmail = await post(app, { ...guestBody, guestEmail: `${"x".repeat(200)}@e.test` });
    expect(longEmail.status).toBe(400);

    const badEmail = await post(app, { ...guestBody, guestEmail: "not-an-email" });
    expect(badEmail.status).toBe(400);

    // A literal `{ __proto__: … }` never serializes its dunder key (it sets
    // the prototype at literal level); the hostile path is RAW JSON, where
    // JSON.parse creates a real own `__proto__` key — strictObject refuses it.
    const dunder = await postRaw(
      app,
      '{"compId":"comp_main","body":"guest note","guestName":"Alex Guest","guestEmail":"alex@client.test","__proto__":"pollution"}',
    );
    expect(dunder.status).toBe(400);

    expect(built.createGuestCalls).toHaveLength(0);
  });

  it("RTL/bidi text in a guest body is stored as inert data", async () => {
    const built = buildDeps();
    const response = await post(mountGuest(built.deps), {
      ...guestBody,
      body: "client note ‮ hidden text ‍ 🎬",
    });
    expect(response.status).toBe(201);
    const input = built.createGuestCalls[0] as Record<string, unknown>;
    expect(String(input.body)).toContain("\u202e");
  });

  it("uses the shared in-memory limiter shape (per-IP bucket seam)", () => {
    const limiter = createInMemoryRateLimiter();
    const deps = { ...buildDeps().deps, limiter };
    expect(deps.limiter.check("203.0.113.9", "auth").allowed).toBe(true);
    expect(deps.limiter.check("203.0.113.9", "auth").allowed).toBe(true);
    expect(deps.limiter.check("198.51.100.1", "auth").allowed).toBe(true); // different IP, own bucket
  });
});
