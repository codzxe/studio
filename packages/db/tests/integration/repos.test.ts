import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { type StudioDb, createDb } from "../../src/db.js";
import { DbError } from "../../src/errors-lite.js";
import { migrateDatabase } from "../../src/migrate.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import * as schema from "../../src/schema.js";

/**
 * Integration tests — require a real Postgres.
 * Auto-run only when DATABASE_URL is a postgres URL (CI / staging):
 *   `DATABASE_URL=postgres://… pnpm --filter @studio/db test`
 * The sandbox DATABASE_URL points at a sqlite file (superseded product) —
 * the suite is skipped there, not failed.
 */
const pgUrl = process.env.DATABASE_URL ?? "";
const hasDb = /^postgres(ql)?:/.test(pgUrl);

describe.skipIf(!hasDb)("repos (integration)", { timeout: 30_000 }, () => {
  let db: StudioDb;
  let repos: Repos;
  const wsA = `ws_test_${randomUUID().slice(0, 8)}`;
  const wsB = `ws_test_${randomUUID().slice(0, 8)}`;
  const userId = `usr_test_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    db = createDb(url);
    await migrateDatabase(db);
    repos = createRepos(db);
    // fixture: two workspaces + a member user
    await db
      .insert(schema.organization)
      .values([
        { id: wsA, name: "A", slug: wsA },
        { id: wsB, name: "B", slug: wsB },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.user)
      .values({ id: userId, name: "T", email: `${userId}@studio.test`, emailVerified: true })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it("projects: create → get → patch → soft-delete → hidden from list", async () => {
    const project = await repos.projects.create(wsA, {
      name: "Integration One",
      createdBy: userId,
    });
    expect(project.slug).toBe("integration-one");

    const fetched = await repos.projects.get(wsA, project.id);
    expect(fetched.id).toBe(project.id);

    const patched = await repos.projects.patch(wsA, project.id, { name: "Renamed" });
    expect(patched.name).toBe("Renamed");

    // tenant isolation: wsB cannot see wsA's project (§12.1 — 404, not 403)
    await expect(repos.projects.get(wsB, project.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const listed = await repos.projects.list(wsA, { limit: 10 });
    expect(listed.items.some((p) => p.id === project.id)).toBe(true);

    await repos.projects.softDelete(wsA, project.id);
    const afterDelete = await repos.projects.list(wsA, { limit: 10 });
    expect(afterDelete.items.some((p) => p.id === project.id)).toBe(false);
    const withDeleted = await repos.projects.list(wsA, { limit: 10, includeDeleted: true });
    expect(withDeleted.items.some((p) => p.id === project.id)).toBe(true);
  });

  it("versions: upload advances current; stale base → PROJECT_VERSION_CONFLICT", async () => {
    const project = await repos.projects.create(wsA, {
      name: "Versioned",
      createdBy: userId,
    });

    const v1 = await repos.versions.upload(wsA, {
      projectId: project.id,
      expectedVersionId: null,
      objectKey: `workspaces/${wsA}/projects/${project.id}/versions/v1/project.ecproj`,
      sha256: "aa",
      sizeBytes: 10,
      createdBy: userId,
    });
    expect(v1.version.version).toBe(1);
    expect(v1.project.currentVersionId).toBe(v1.version.id);

    const v2 = await repos.versions.upload(wsA, {
      projectId: project.id,
      expectedVersionId: v1.version.id,
      objectKey: `workspaces/${wsA}/projects/${project.id}/versions/v2/project.ecproj`,
      sha256: "bb",
      sizeBytes: 12,
      createdBy: userId,
    });
    expect(v2.version.version).toBe(2);
    expect(v2.version.parentVersionId).toBe(v1.version.id);

    // stale expected → 409 typed conflict
    await expect(
      repos.versions.upload(wsA, {
        projectId: project.id,
        expectedVersionId: v1.version.id,
        objectKey: "x",
        sha256: "cc",
        sizeBytes: 10,
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_VERSION_CONFLICT", status: 409 });

    // restore creates a NEW version with parent = the restored one (§9.3)
    const restored = await repos.versions.restore(wsA, {
      projectId: project.id,
      versionId: v1.version.id,
      createdBy: userId,
    });
    expect(restored.version.version).toBe(3);
    expect(restored.version.parentVersionId).toBe(v1.version.id);
    expect(restored.version.sha256).toBe("aa");
  });

  it("leases: single writer, refusal, renewal, release", async () => {
    const project = await repos.projects.create(wsA, { name: "Leased", createdBy: userId });
    // The second writer is a REAL user row: project_leases.user_id has an FK
    // to "user" (previously "usr_other" had no row — 23503 on acquire).
    const otherUserId = `usr_test_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.user)
      .values({
        id: otherUserId,
        name: "Other",
        email: `${otherUserId}@studio.test`,
        emailVerified: true,
      })
      .onConflictDoNothing();
    const first = await repos.leases.acquire(wsA, project.id, {
      userId,
      sessionId: "sess_1",
    });
    expect(first.acquired).toBe(true);

    const second = await repos.leases.acquire(wsA, project.id, {
      userId: otherUserId,
      sessionId: "sess_2",
    });
    expect(second.acquired).toBe(false);
    expect(second.holderId).toBe(userId);

    const renewed = await repos.leases.renew(wsA, project.id, {
      userId,
      sessionId: "sess_1",
    });
    expect(renewed.renewed).toBe(true);

    const released = await repos.leases.release(wsA, project.id, { userId });
    expect(released.released).toBe(true);

    const again = await repos.leases.acquire(wsA, project.id, {
      userId: otherUserId,
      sessionId: "sess_2",
    });
    expect(again.acquired).toBe(true);
  });

  it("ledger: grant → reserve → settle is idempotent and balance-correct", async () => {
    const runId = `run_test_${randomUUID().slice(0, 8)}`;

    const grant1 = await repos.ledger.grant(wsA, {
      amount: 100,
      idempotencyKey: `${runId}:grant`,
    });
    expect(grant1.entry.balanceAfter).toBe(100);
    expect(grant1.replayed).toBe(false);

    const grant2 = await repos.ledger.grant(wsA, {
      amount: 100,
      idempotencyKey: `${runId}:grant`,
    });
    expect(grant2.replayed).toBe(true);
    expect(grant2.entry.id).toBe(grant1.entry.id);
    expect(await repos.ledger.balance(wsA)).toBe(100);

    const reserve = await repos.ledger.reserve(wsA, {
      runId,
      amount: 24,
      idempotencyKey: `${runId}:reserve`,
    });
    expect(reserve.entry.balanceAfter).toBe(76);

    // insufficient credits is a typed error before any model call (§8.8)
    await expect(
      repos.ledger.reserve(wsA, {
        runId,
        amount: 1000,
        idempotencyKey: `${runId}:reserve2`,
      }),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      details: { required: 1000, available: 76 },
    });

    const settle1 = await repos.ledger.settle(wsA, {
      runId,
      actualCost: 18,
      idempotencyKey: `${runId}:settle`,
    });
    expect(settle1.commit?.amount).toBe(-18);
    expect(settle1.refund?.amount).toBe(24);
    // net effect: −18 (hold 24 released in full, actual 18 committed);
    // balance back to 82
    expect(await repos.ledger.balance(wsA)).toBe(82);

    const settle2 = await repos.ledger.settle(wsA, {
      runId,
      actualCost: 18,
      idempotencyKey: `${runId}:settle`,
    });
    expect(settle2.replayed).toBe(true);
    expect(await repos.ledger.balance(wsA)).toBe(82); // unchanged — idempotent

    // cross-workspace key reuse is a conflict
    await db
      .insert(schema.organization)
      .values({ id: wsB, name: "B", slug: wsB })
      .onConflictDoNothing();
    await expect(
      repos.ledger.grant(wsB, { amount: 1, idempotencyKey: `${runId}:grant` }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("runs and renders enforce their status machines", async () => {
    const project = await repos.projects.create(wsA, { name: "Runflow", createdBy: userId });
    const thread = await repos.threads.create(wsA, {
      projectId: project.id,
      createdBy: userId,
    });
    const run = await repos.runs.create(wsA, {
      threadId: thread.id,
      projectId: project.id,
      model: "fast",
      reservedCredits: 10,
    });
    await repos.runs.update(wsA, run.id, { status: "running" });
    await repos.runs.addStep(wsA, {
      runId: run.id,
      seq: 0,
      tool: "engine.batch",
      status: "success",
      durationMs: 5,
    });
    const withSteps = await repos.runs.get(wsA, run.id);
    expect(withSteps.run.status).toBe("running");
    expect(withSteps.steps.length).toBe(1);
    const completedRun = await repos.runs.update(wsA, run.id, { status: "completed" });
    expect(completedRun.status).toBe("completed");
    expect(completedRun.completedAt).not.toBeNull();
    await expect(repos.runs.update(wsA, run.id, { status: "running" })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // M8-A: renders are pinned to a version (§9.3) — upload one first.
    const pinnedVersion = await repos.versions.upload(wsA, {
      projectId: project.id,
      expectedVersionId: null,
      objectKey: `workspaces/${wsA}/projects/${project.id}/versions/v1/project.ecproj`,
      sha256: "ab",
      sizeBytes: 8,
      createdBy: userId,
    });
    const render = await repos.renders.create(wsA, {
      projectId: project.id,
      versionId: pinnedVersion.version.id,
      compId: "comp_main",
      format: "mp4",
      createdBy: userId,
    });
    expect(render.versionId).toBe(pinnedVersion.version.id);
    await repos.renders.markRunning(wsA, render.id);
    const done = await repos.renders.markCompleted(wsA, render.id, {
      objectKey: "workspaces/x/renders/r/output.mp4",
    });
    expect(done.status).toBe("completed");
    expect(done.objectKey).toBeDefined();
    await expect(repos.renders.markCancelled(wsA, render.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("round 12 agent loop: tool step lifecycle + heartbeat/stale/abandon + transcript (migration 0008)", async () => {
    const project = await repos.projects.create(wsA, { name: "Looped", createdBy: userId });
    const thread = await repos.threads.create(wsA, {
      projectId: project.id,
      createdBy: userId,
    });
    const run = await repos.runs.create(wsA, {
      threadId: thread.id,
      projectId: project.id,
      model: "studio-fast",
    });

    // step lifecycle: issued → success, keyed by the model's toolCallId
    const step = await repos.runs.insertToolCallStep({
      runId: run.id,
      threadId: thread.id,
      stepIndex: 0,
      toolCallId: `call_${randomUUID().slice(0, 8)}`,
      tool: "studio.get_context",
      argsJson: { comp: "comp_main" },
    });
    expect(step.status).toBe("issued");
    expect(step.toolCallId).toBeTruthy();
    const settled = await repos.runs.completeToolStep({
      toolCallId: step.toolCallId ?? "",
      resultJson: { ok: true },
    });
    expect(settled.status).toBe("success");
    expect(settled.seq).toBe(step.seq);

    // transcript rows + user-run link
    const userRow = await repos.threads.addMessage(wsA, {
      threadId: thread.id,
      role: "user",
      contentJson: { message: "make it blue" },
    });
    const linked = await repos.threads.linkUserMessageToRun({
      messageId: userRow.id,
      runId: run.id,
    });
    expect(linked.runId).toBe(run.id);
    await repos.threads.insertToolMessageRow({
      threadId: thread.id,
      runId: run.id,
      toolCallId: step.toolCallId ?? "",
      tool: "studio.get_context",
      payload: { ok: true },
    });
    await repos.threads.insertAssistantMessageRow({
      threadId: thread.id,
      runId: run.id,
      text: "done",
      status: "completed",
    });

    // heartbeat: running + last_step_index + credits; fresh ⇒ not stale
    const touched = await repos.runs.touchRunHeartbeat({
      runId: run.id,
      lastStepIndex: 1,
      creditsCommitted: 2,
    });
    expect(touched.status).toBe("running");
    expect(touched.lastStepIndex).toBe(1);
    expect(touched.committedCredits).toBe(2);
    expect(touched.heartbeatAt).not.toBeNull();
    expect((await repos.runs.getStaleRunningRuns()).some((r) => r.id === run.id)).toBe(false);

    // backdate past the 5-minute default → stale → abandoned (cancelled)
    await db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));
    const stale = await repos.runs.getStaleRunningRuns();
    const mine = stale.find((r) => r.id === run.id);
    expect(mine?.workspaceId).toBe(wsA);
    const abandoned = await repos.runs.markRunAbandoned({ runId: run.id });
    expect(abandoned.status).toBe("cancelled");
    expect(abandoned.errorCode).toBe("RUN_ABANDONED");
    expect((await repos.runs.getStaleRunningRuns()).some((r) => r.id === run.id)).toBe(false);

    // history: oldest-first transcript incl. the tool row
    const history = await repos.threads.loadThreadHistory(thread.id);
    expect(history.map((entry) => entry.role)).toEqual(["user", "tool", "assistant"]);
    expect(history[0]?.runId).toBe(run.id);
    expect(history[1]?.contentJson).toMatchObject({ kind: "tool" });
  });

  it("comments resolve and unresolve idempotently", async () => {
    const project = await repos.projects.create(wsA, { name: "Commented", createdBy: userId });
    const comment = await repos.comments.create(wsA, {
      projectId: project.id,
      compId: "comp_main",
      body: "looks good but the logo drifts",
      authorId: userId,
    });
    const resolved = await repos.comments.resolve(wsA, {
      commentId: comment.id,
      resolvedBy: userId,
    });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy).toBe(userId);
    const open = await repos.comments.list(wsA, project.id, { resolved: false });
    expect(open.items.some((c) => c.id === comment.id)).toBe(false);
    const unresolved = await repos.comments.unresolve(wsA, comment.id);
    expect(unresolved.resolvedAt).toBeNull();
    expect(unresolved.resolvedBy).toBeNull();
    // cross-tenant comment is 404
    await expect(repos.comments.get(wsB, comment.id)).rejects.toBeInstanceOf(DbError);
  });

  it("the resolved filter is thread-aware (a filter never splits a thread)", async () => {
    // First-live m7-collab finding (2026-10-24): the filter was row-level,
    // splitting resolved roots from their replies on fresh fetches. The
    // thread ROOT's resolvedAt decides every row of the thread.
    const project = await repos.projects.create(wsA, { name: "Threaded", createdBy: userId });
    const root = await repos.comments.create(wsA, {
      projectId: project.id,
      compId: "comp_main",
      body: "thread root",
      authorId: userId,
    });
    const replyRow = await repos.comments.createReply(wsA, {
      commentId: root.id,
      body: "reply under the root",
      authorId: userId,
    });
    const deep = await repos.comments.createReply(wsA, {
      commentId: replyRow.id,
      body: "depth-3 reply",
      authorId: userId,
    });
    await repos.comments.resolve(wsA, { commentId: root.id, resolvedBy: userId });

    const done = await repos.comments.listThreaded(wsA, project.id, { resolved: true });
    const doneIds = new Set(done.items.map((c) => c.id));
    expect(doneIds.has(root.id)).toBe(true);
    expect(doneIds.has(replyRow.id)).toBe(true); // the first-live RED row
    expect(doneIds.has(deep.id)).toBe(true); // the two-hop root walk

    const open = await repos.comments.listThreaded(wsA, project.id, { resolved: false });
    expect(open.items.some((c) => c.id === root.id || c.id === replyRow.id)).toBe(false);

    // The flat `list` variant carries the same thread-aware semantics.
    const doneFlat = await repos.comments.list(wsA, project.id, { resolved: true });
    expect(doneFlat.items.some((c) => c.id === deep.id)).toBe(true);
  });

  it("audit entries append and paginate", async () => {
    await repos.audit.append(wsA, { actorId: userId, action: "test.action", ip: "127.0.0.1" });
    const page = await repos.audit.list(wsA, { limit: 1 });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.action).toBe("test.action");
    if (page.nextCursor) {
      const next = await repos.audit.list(wsA, { limit: 10, cursor: page.nextCursor });
      expect(next.items.length).toBeGreaterThanOrEqual(0);
    }
  });
});
