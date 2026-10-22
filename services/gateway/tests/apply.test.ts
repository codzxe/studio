// M5-E — POST /v1/runs/:id/apply + /v1/runs/:id/undo, end-to-end over HTTP
// against live Postgres (BUILD_PLAN §M5.4/§M5.5, PA §8.7/§8.8/§8.9, D-20).
//
// Covers: happy apply (run row + D-20 ledger commit + idempotent replay →
// identical response, single commit), route-level replay with a fresh
// transport key, double-apply 409, cross-tenant 404 (law #3), unknown run
// 404, wrong-project / wrong-run version 404, base-version conflict 409
// VERSION_CONFLICT (§M5.5), head-moved conflict, insufficient credits 402
// with NO ledger entry, status guard 409, undo happy (free — no ledger
// mutation), undo-before-apply 409, undo replay idempotent.
//
// Runs are seeded through the real repos (the chat SSE loop is M5-C's
// surface); versions are uploaded through the REAL versions route with
// agentRunId = run id, exactly like the client does after saveNow("agent-apply").

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EDIT_PLAN_SCHEMA } from "@studio/contracts";

import {
  CookieJar,
  HAS_DATABASE,
  type RunningTestServer,
  api,
  bootServer,
  envelope,
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Workspace {
  readonly jar: CookieJar;
  readonly id: string;
}

async function newWorkspace(prefix: string): Promise<Workspace> {
  const jar = new CookieJar();
  const signup = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: { email: uniqueEmail(prefix), password: "Passw0rd!longenough", name: "Apply Tester" },
  });
  expect(signup.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("Apply WS"), slug: unique("apply-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  return { jar, id: ws.data.id };
}

async function grantCredits(workspaceId: string, amount: number): Promise<void> {
  await server.deps.repos.ledger.grant(workspaceId, {
    amount,
    idempotencyKey: unique("grant"),
  });
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

function contentBytes(text: string): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(text, "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Uploads a version through the REAL route (raw-bytes form). `baseVersionId`
 * omitted ⇒ the project's first snapshot; `agentRunId` set ⇒ the apply flow
 * (the version was created by this run's autosave).
 */
async function uploadVersion(
  ws: Workspace,
  projectId: string,
  options: { baseVersionId?: string | null; agentRunId?: string; label?: string } = {},
): Promise<string> {
  const fixture = contentBytes(`{"apply-fixture":"${unique("v")}"}`);
  const query = new URLSearchParams({
    sha256: fixture.sha256,
    sizeBytes: String(fixture.bytes.byteLength),
  });
  if (typeof options.baseVersionId === "string") {
    query.set("baseVersionId", options.baseVersionId);
  }
  if (options.agentRunId !== undefined) query.set("agentRunId", options.agentRunId);
  if (options.label !== undefined) query.set("label", options.label);
  const response = await api(server.base, `/v1/projects/${projectId}/versions?${query}`, {
    method: "POST",
    jar: ws.jar,
    headers: {
      "x-workspace-id": ws.id,
      "idempotency-key": unique("ver"),
      "content-type": "application/octet-stream",
    },
    rawBody: new Uint8Array(fixture.bytes),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/** A small, valid §8.6 EditPlan — the run row's planJson. */
function agentPlan(estimatedCredits: number): unknown {
  return EDIT_PLAN_SCHEMA.parse({
    intent: "edit",
    summary: "Rename the headline layer",
    risk: "low",
    requiresApproval: false,
    affectedLayers: [{ id: 0, name: "Headline", change: "Rename to Subtitle" }],
    estimatedCredits,
    steps: [
      {
        title: "Rename layer",
        tool: "studio.set_properties",
        args: { layerId: 0, name: "Subtitle" },
        batch: {
          label: "Rename layer",
          steps: [{ command: "layer.rename", params: { id: 0, name: "Subtitle" } }],
        },
      },
    ],
  });
}

interface SeedRunOptions {
  readonly baseVersionId: string | null;
  readonly planCredits?: number;
  readonly reserve?: number;
  readonly status?: "queued" | "running" | "completed" | "cancelled";
  readonly withPlan?: boolean;
}

/** Thread + run row (via real repos) + ledger reserve, with a valid plan. */
async function seedRun(ws: Workspace, projectId: string, options: SeedRunOptions): Promise<string> {
  const threadResponse = await api(server.base, `/v1/projects/${projectId}/threads`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("thr") },
    body: { title: "Apply thread" },
  });
  expect(threadResponse.status).toBe(201);
  const thread = (await threadResponse.json()) as { data: { id: string } };

  const run = await server.deps.repos.runs.create(ws.id, {
    threadId: thread.data.id,
    projectId,
    model: "studio-fast",
    baseVersionId: options.baseVersionId,
    reservedCredits: 0,
    planJson:
      options.withPlan === false ? undefined : agentPlan(options.planCredits ?? 2),
  });
  const reserve = options.reserve ?? 10;
  if (reserve > 0) {
    await server.deps.repos.ledger.reserve(ws.id, {
      runId: run.id,
      amount: reserve,
      idempotencyKey: unique("rsv"),
    });
    await server.deps.repos.runs.update(ws.id, run.id, { reservedCredits: reserve });
  }
  const status = options.status ?? "completed";
  if (status === "running") {
    await server.deps.repos.runs.update(ws.id, run.id, { status: "running" });
  } else if (status === "completed") {
    // D-11: queued → running → completed (the repo enforces the transitions).
    await server.deps.repos.runs.update(ws.id, run.id, { status: "running" });
    await server.deps.repos.runs.update(ws.id, run.id, { status: "completed" });
  } else if (status === "cancelled") {
    await server.deps.repos.runs.update(ws.id, run.id, { status: "cancelled" });
  }
  return run.id;
}

async function runLedger(workspaceId: string, runId: string) {
  const page = await server.deps.repos.ledger.list(workspaceId, { runId, limit: 100 });
  return page.items;
}

async function planStatus(workspaceId: string, runId: string): Promise<string> {
  const state = await server.deps.repos.runs.getPlanState(workspaceId, runId);
  return state.status;
}

interface ApplyBody {
  readonly batchSha256: string;
  readonly versionId: string;
  readonly idempotencyKey: string;
}

function batchSha(): string {
  return createHash("sha256").update(`batch-${unique("sha")}`).digest("hex");
}

async function applyCall(ws: Workspace, runId: string, body: ApplyBody, key?: string) {
  return api(server.base, `/v1/runs/${runId}/apply`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": key ?? body.idempotencyKey },
    body,
  });
}

async function undoCall(ws: Workspace, runId: string, key: string) {
  return api(server.base, `/v1/runs/${runId}/undo`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": key },
    body: { idempotencyKey: key },
  });
}

// ---------------------------------------------------------------------------
// Suite 1 — the apply → undo lifecycle
// ---------------------------------------------------------------------------

d("apply → undo lifecycle (§8.7, §8.8/D-20)", () => {
  let ws: Workspace;
  let projectId: string;
  let baseVersionId: string;
  let runId: string;
  let appliedVersionId: string;
  const undoKey = unique("undo");
  const sha = batchSha();
  const key = unique("apply");

  it("seeds a planned, completed run on a versioned project", async () => {
    ws = await newWorkspace("life");
    await grantCredits(ws.id, 100);
    projectId = await createProject(ws, unique("Lifecycle"));
    baseVersionId = await uploadVersion(ws, projectId); // first snapshot
    runId = await seedRun(ws, projectId, { baseVersionId, planCredits: 2, reserve: 10 });
    // The client applied the batch, autosaved (D-6) and uploaded the version.
    appliedVersionId = await uploadVersion(ws, projectId, {
      baseVersionId,
      agentRunId: runId,
      label: "Agent apply",
    });
  });

  it("applies: 200 Ok, plan credits committed, D-20 releases the FULL hold", async () => {
    const response = await applyCall(ws, runId, { batchSha256: sha, versionId: appliedVersionId, idempotencyKey: key });
    const body = await envelope(response);
    expect(response.status).toBe(200);
    expect(body.ok).toEqual({
      data: { applied: true, versionId: appliedVersionId, creditsCommitted: 2 },
    });

    // Run row: lifecycle columns recorded, linked to the uploaded version.
    expect(await planStatus(ws.id, runId)).toBe("applied");
    const state = await server.deps.repos.runs.getPlanState(ws.id, runId);
    expect(state.appliedBatchSha256).toBe(sha);
    expect(state.appliedVersionId).toBe(appliedVersionId);
    expect(state.baseVersionId).toBe(baseVersionId);

    // §8.8 ledger (D-20): reserve −10, commit −2, refund +10 ⇒ run nets −2.
    const entries = await runLedger(ws.id, runId);
    expect(entries.map((entry) => [entry.kind, entry.amount])).toEqual([
      ["refund", 10],
      ["commit", -2],
      ["reserve", -10],
    ]);
    expect(entries.filter((entry) => entry.kind === "commit")).toHaveLength(1);
    // Workspace balance: 100 granted − 2 committed.
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(98);
  });

  it("replays an identical request: same response, single commit", async () => {
    const response = await applyCall(ws, runId, {
      batchSha256: sha,
      versionId: appliedVersionId,
      idempotencyKey: key,
    });
    const body = await envelope(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-idempotent-replay")).toBe("true");
    expect(body.ok).toEqual({
      data: { applied: true, versionId: appliedVersionId, creditsCommitted: 2 },
    });
    const entries = await runLedger(ws.id, runId);
    expect(entries.filter((entry) => entry.kind === "commit")).toHaveLength(1);
  });

  it("replays the same logical apply with a fresh transport key: 200, no new commit", async () => {
    const response = await applyCall(ws, runId, {
      batchSha256: sha,
      versionId: appliedVersionId,
      idempotencyKey: unique("apply"),
    });
    const body = await envelope(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-idempotent-replay")).toBeNull();
    expect(body.ok).toEqual({
      data: { applied: true, versionId: appliedVersionId, creditsCommitted: 2 },
    });
    const entries = await runLedger(ws.id, runId);
    expect(entries.filter((entry) => entry.kind === "commit")).toHaveLength(1);
  });

  it("a different apply on the same run is 409 RUN_ALREADY_APPLIED", async () => {
    const newVersionId = await uploadVersion(ws, projectId, {
      baseVersionId: appliedVersionId,
      agentRunId: runId,
    });
    const response = await applyCall(ws, runId, {
      batchSha256: sha,
      versionId: newVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(409);
    const body = await envelope(response);
    expect(body.err?.code).toBe("RUN_ALREADY_APPLIED");
    // The rejected apply neither charged nor recorded.
    expect((await runLedger(ws.id, runId)).filter((e) => e.kind === "commit")).toHaveLength(1);
  });

  it("undoes the applied run and keeps every ledger row untouched", async () => {
    const before = await runLedger(ws.id, runId);
    const response = await undoCall(ws, runId, undoKey);
    const body = await envelope(response);
    expect(response.status).toBe(200);
    expect(body.ok).toEqual({ data: { undone: true } });
    expect(await planStatus(ws.id, runId)).toBe("undone");

    const after = await runLedger(ws.id, runId);
    expect(after).toHaveLength(before.length); // undo after a committed apply is free (§8.8)
    const state = await server.deps.repos.runs.getPlanState(ws.id, runId);
    expect(state.appliedVersionId).toBe(appliedVersionId); // linkage survives (§9.3)
  });

  it("undo replays are idempotent: same key and fresh key both answer 200", async () => {
    const sameKey = await undoCall(ws, runId, undoKey);
    const sameBody = await envelope(sameKey);
    expect(sameKey.status).toBe(200);
    expect(sameKey.headers.get("x-idempotent-replay")).toBe("true");
    expect(sameBody.ok).toEqual({ data: { undone: true } });

    const freshKey = unique("undo");
    const fresh = await undoCall(ws, runId, freshKey);
    const freshBody = await envelope(fresh);
    expect(fresh.status).toBe(200);
    expect(freshBody.ok).toEqual({ data: { undone: true } });
    expect(await planStatus(ws.id, runId)).toBe("undone");
  });

  it("re-applying an undone run is 409 (recordApplied is one-per-run; M5-D)", async () => {
    // Upload on the CURRENT head (the version history moved past the first apply).
    const project = await server.deps.repos.projects.get(ws.id, projectId);
    const versionId = await uploadVersion(ws, projectId, {
      baseVersionId: project.currentVersionId,
      agentRunId: runId,
    });
    const response = await applyCall(ws, runId, {
      batchSha256: batchSha(),
      versionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(409);
    const body = await envelope(response);
    expect(body.err?.code).toBe("RUN_ALREADY_APPLIED");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — guards
// ---------------------------------------------------------------------------

d("apply/undo guards (law #3, §8.9, §M5.5)", () => {
  it("unknown run reads as 404 RUN_NOT_FOUND (apply and undo)", async () => {
    const ws = await newWorkspace("guard");
    const missing = "run_missing000000000000000000000";
    const apply = await applyCall(ws, missing, {
      batchSha256: batchSha(),
      versionId: "ver_unknown",
      idempotencyKey: unique("apply"),
    });
    expect(apply.status).toBe(404);
    expect((await envelope(apply)).err?.code).toBe("RUN_NOT_FOUND");
    const undo = await undoCall(ws, missing, unique("undo"));
    expect(undo.status).toBe(404);
    expect((await envelope(undo)).err?.code).toBe("RUN_NOT_FOUND");
  });

  it("a run from another workspace reads as 404, never 403 (law #3)", async () => {
    const wsA = await newWorkspace("tenant-a");
    await grantCredits(wsA.id, 100);
    const projectId = await createProject(wsA, unique("Private"));
    const baseVersionId = await uploadVersion(wsA, projectId);
    const runId = await seedRun(wsA, projectId, { baseVersionId });

    const wsB = await newWorkspace("tenant-b");
    const response = await applyCall(wsB, runId, {
      batchSha256: batchSha(),
      versionId: baseVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(404);
    const body = await envelope(response);
    expect(body.err?.code).toBe("RUN_NOT_FOUND");
    const undo = await undoCall(wsB, runId, unique("undo"));
    expect(undo.status).toBe(404);
  });

  it("a version of ANOTHER project (same workspace) reads as 404", async () => {
    const ws = await newWorkspace("wrong-proj");
    await grantCredits(ws.id, 100);
    const projectA = await createProject(ws, unique("A"));
    const baseA = await uploadVersion(ws, projectA);
    const projectB = await createProject(ws, unique("B"));
    const foreignVersionId = await uploadVersion(ws, projectB);
    const runId = await seedRun(ws, projectA, { baseVersionId: baseA });

    const response = await applyCall(ws, runId, {
      batchSha256: batchSha(),
      versionId: foreignVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(404);
    const body = await envelope(response);
    expect(body.err?.code).toBe("VERSION_NOT_FOUND");
  });

  it("a version the run did not create (agentRunId mismatch) reads as 404", async () => {
    const ws = await newWorkspace("wrong-run");
    await grantCredits(ws.id, 100);
    const projectId = await createProject(ws, unique("RunScope"));
    const baseVersionId = await uploadVersion(ws, projectId);
    const colleaguesVersionId = await uploadVersion(ws, projectId, { baseVersionId });
    const runId = await seedRun(ws, projectId, { baseVersionId });

    const response = await applyCall(ws, runId, {
      batchSha256: batchSha(),
      versionId: colleaguesVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(404);
    expect((await envelope(response)).err?.code).toBe("VERSION_NOT_FOUND");
  });

  it("a plan whose base version no longer matches is 409 VERSION_CONFLICT", async () => {
    const ws = await newWorkspace("stale-base");
    await grantCredits(ws.id, 100);
    const projectId = await createProject(ws, unique("Stale"));
    const baseVersionId = await uploadVersion(ws, projectId); // run proposed on v1
    const runId = await seedRun(ws, projectId, { baseVersionId });
    // A colleague saves v2 while the plan card is open…
    const divergedHeadId = await uploadVersion(ws, projectId, { baseVersionId });
    // …so the client's autosave lands on v2, not the plan's base.
    const appliedVersionId = await uploadVersion(ws, projectId, {
      baseVersionId: divergedHeadId,
      agentRunId: runId,
    });

    const response = await applyCall(ws, runId, {
      batchSha256: batchSha(),
      versionId: appliedVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(409);
    const body = await envelope(response);
    expect(body.err?.code).toBe("VERSION_CONFLICT");
    expect(body.err?.retryable).toBe(false);
    expect(await planStatus(ws.id, runId)).toBe("proposed");
    // Nothing was charged (§M5.5: never overwrite, never charge).
    expect((await runLedger(ws.id, runId)).filter((e) => e.kind === "commit")).toHaveLength(0);
  });

  it("a head that moved past the applied version is 409 VERSION_CONFLICT", async () => {
    const ws = await newWorkspace("moved-head");
    await grantCredits(ws.id, 100);
    const projectId = await createProject(ws, unique("Moved"));
    const baseVersionId = await uploadVersion(ws, projectId);
    const runId = await seedRun(ws, projectId, { baseVersionId });
    const appliedVersionId = await uploadVersion(ws, projectId, {
      baseVersionId,
      agentRunId: runId,
    });
    // Someone saves v3 between the client's upload and the apply POST.
    await uploadVersion(ws, projectId, { baseVersionId: appliedVersionId });

    const response = await applyCall(ws, runId, {
      batchSha256: batchSha(),
      versionId: appliedVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(409);
    expect((await envelope(response)).err?.code).toBe("VERSION_CONFLICT");
  });

  it("a zero balance is 402 INSUFFICIENT_CREDITS with NO ledger entry and no state change", async () => {
    const ws = await newWorkspace("broke");
    // Grant exactly the reserve: after reserving, the balance is 0 (§8.8).
    await grantCredits(ws.id, 10);
    const projectId = await createProject(ws, unique("Broke"));
    const baseVersionId = await uploadVersion(ws, projectId);
    const runId = await seedRun(ws, projectId, { baseVersionId, planCredits: 2, reserve: 10 });
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(0);
    const appliedVersionId = await uploadVersion(ws, projectId, {
      baseVersionId,
      agentRunId: runId,
    });

    const response = await applyCall(ws, runId, {
      batchSha256: batchSha(),
      versionId: appliedVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(402);
    const body = await envelope(response);
    expect(body.err?.code).toBe("INSUFFICIENT_CREDITS");
    // The ONLY run entry is the original reserve — no commit, no refund row.
    const entries = await runLedger(ws.id, runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("reserve");
    // No state change either: still proposed (undo would 409).
    expect(await planStatus(ws.id, runId)).toBe("proposed");
    const undo = await undoCall(ws, runId, unique("undo"));
    expect(undo.status).toBe(409);
  });

  it("a run that has not finished planning (or is dead) cannot be applied: 409", async () => {
    const ws = await newWorkspace("status");
    await grantCredits(ws.id, 100);
    const projectId = await createProject(ws, unique("Status"));
    const baseVersionId = await uploadVersion(ws, projectId);

    const runningRunId = await seedRun(ws, projectId, {
      baseVersionId,
      status: "running",
    });
    const runningResponse = await applyCall(ws, runningRunId, {
      batchSha256: batchSha(),
      versionId: baseVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(runningResponse.status).toBe(409);
    expect((await envelope(runningResponse)).err?.code).toBe("RUN_NOT_ACTIVE");

    const cancelledRunId = await seedRun(ws, projectId, {
      baseVersionId,
      status: "cancelled",
    });
    const cancelledResponse = await applyCall(ws, cancelledRunId, {
      batchSha256: batchSha(),
      versionId: baseVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(cancelledResponse.status).toBe(409);
    expect((await envelope(cancelledResponse)).err?.code).toBe("RUN_NOT_ACTIVE");
  });

  it("a completed run with no plan cannot be applied: 409", async () => {
    const ws = await newWorkspace("no-plan");
    await grantCredits(ws.id, 100);
    const projectId = await createProject(ws, unique("NoPlan"));
    const baseVersionId = await uploadVersion(ws, projectId);
    const runId = await seedRun(ws, projectId, { baseVersionId, withPlan: false });

    const response = await applyCall(ws, runId, {
      batchSha256: batchSha(),
      versionId: baseVersionId,
      idempotencyKey: unique("apply"),
    });
    expect(response.status).toBe(409);
    expect((await envelope(response)).err?.code).toBe("RUN_NOT_ACTIVE");
  });

  it("undo before apply is 409 RUN_NOT_APPLIED", async () => {
    const ws = await newWorkspace("undo-guard");
    await grantCredits(ws.id, 100);
    const projectId = await createProject(ws, unique("UndoGuard"));
    const baseVersionId = await uploadVersion(ws, projectId);
    const runId = await seedRun(ws, projectId, { baseVersionId });

    const response = await undoCall(ws, runId, unique("undo"));
    expect(response.status).toBe(409);
    const body = await envelope(response);
    expect(body.err?.code).toBe("RUN_NOT_APPLIED");
    expect(body.err?.retryable).toBe(false);
  });
});
