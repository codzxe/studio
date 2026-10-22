import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type StudioDb, createDb } from "../../src/db.js";
import { migrateDatabase } from "../../src/migrate.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import * as schema from "../../src/schema.js";

/**
 * Integration tests — M5 apply/undo persistence (BUILD_PLAN §M5.4/§M5.5).
 * Requires a real Postgres: `DATABASE_URL=postgres://… pnpm --filter @studio/db test`.
 * Skipped (not failed) when DATABASE_URL is not a postgres URL.
 *
 * Covers: apply happy path (columns + version linkage), double-apply rejected,
 * undo happy path (version row survives — §9.3 immutability), undo-before-apply
 * rejected, double-undo rejected, cancelled-run apply rejected, cross-tenant =
 * NOT_FOUND, plan-state transitions, base_version_id FK + scope integrity.
 */
const pgUrl = process.env.DATABASE_URL ?? "";
const hasDb = /^postgres(ql)?:/.test(pgUrl);

const SHA64 = "f1d2d2f924e986ac86fdf7b36c94bcdf32beec15".padEnd(64, "0");

describe.skipIf(!hasDb)("runs apply/undo (integration)", { timeout: 30_000 }, () => {
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
    // fixture: two workspaces + a member user (cross-tenant reads as 404)
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

  /** project + v1 base + thread + run captured on that base (proposal time). */
  async function seedRun(opts?: { baseVersionId?: string | null }) {
    const project = await repos.projects.create(wsA, {
      name: `Apply ${randomUUID().slice(0, 8)}`,
      createdBy: userId,
    });
    const base = await repos.versions.upload(wsA, {
      projectId: project.id,
      expectedVersionId: null,
      objectKey: `workspaces/${wsA}/projects/${project.id}/versions/v1/project.ecproj`,
      sha256: `sha1_${randomUUID().slice(0, 8)}`,
      sizeBytes: 10,
      createdBy: userId,
    });
    const thread = await repos.threads.create(wsA, {
      projectId: project.id,
      createdBy: userId,
    });
    const run = await repos.runs.create(wsA, {
      threadId: thread.id,
      projectId: project.id,
      model: "fast",
      // explicit null must survive (`??` would coerce it back to the base)
      baseVersionId: opts !== undefined ? opts.baseVersionId : base.version.id,
    });
    return { project, base, thread, run };
  }

  /** The version the apply flow created (autosave saveNow("agent-apply")). */
  async function seedAppliedVersion(
    projectId: string,
    expectedVersionId: string | null,
    agentRunId: string,
  ) {
    return repos.versions.upload(wsA, {
      projectId,
      expectedVersionId,
      objectKey: `workspaces/${wsA}/projects/${projectId}/versions/agent/${randomUUID().slice(0, 8)}/project.ecproj`,
      sha256: `sha2_${randomUUID().slice(0, 8)}`,
      sizeBytes: 12,
      label: "Agent apply",
      agentRunId,
      createdBy: userId,
    });
  }

  it("apply happy path: lifecycle columns set, version linked, run status untouched", async () => {
    const { project, base, run } = await seedRun();
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);

    const updated = await repos.runs.recordApplied(wsA, {
      runId: run.id,
      batchSha256: SHA64,
      versionId: applied.version.id,
      baseVersionId: base.version.id,
    });
    expect(updated.appliedAt).toBeInstanceOf(Date);
    expect(updated.appliedBatchSha256).toBe(SHA64);
    expect(updated.appliedVersionId).toBe(applied.version.id);
    expect(updated.baseVersionId).toBe(base.version.id);
    // the applied version doubles as the run's result version (first write wins)
    expect(updated.resultVersionId).toBe(applied.version.id);
    // plan lifecycle is independent from the run status machine
    expect(updated.status).toBe("queued");

    const state = await repos.runs.getPlanState(wsA, run.id);
    expect(state.status).toBe("applied");
    expect(state.appliedVersionId).toBe(applied.version.id);
    expect(state.baseVersionId).toBe(base.version.id);
    expect(state.appliedBatchSha256).toBe(SHA64);
    expect(state.undoneAt).toBeNull();

    // version linkage: the applied version row carries the run id
    const linked = await repos.versions.get(wsA, project.id, applied.version.id);
    expect(linked.agentRunId).toBe(run.id);
    expect(linked.parentVersionId).toBe(base.version.id);
  });

  it("fresh run plan state is proposed with null lifecycle fields", async () => {
    const { base, run } = await seedRun();
    const state = await repos.runs.getPlanState(wsA, run.id);
    expect(state).toEqual({
      status: "proposed",
      appliedAt: null,
      appliedBatchSha256: null,
      appliedVersionId: null,
      baseVersionId: base.version.id,
      undoneAt: null,
    });
  });

  it("double-apply is a typed CONFLICT (route layer owns idempotent replay)", async () => {
    const { project, base, run } = await seedRun();
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    const input = {
      runId: run.id,
      batchSha256: SHA64,
      versionId: applied.version.id,
      baseVersionId: base.version.id,
    };
    await repos.runs.recordApplied(wsA, input);
    await expect(repos.runs.recordApplied(wsA, input)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });

  it("apply on a cancelled run is a typed CONFLICT", async () => {
    const { project, base, run } = await seedRun();
    await repos.runs.update(wsA, run.id, { status: "cancelled" });
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    await expect(
      repos.runs.recordApplied(wsA, {
        runId: run.id,
        batchSha256: SHA64,
        versionId: applied.version.id,
        baseVersionId: base.version.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("undo happy path: run marked undone, version row NEVER deleted (§9.3)", async () => {
    const { project, base, run } = await seedRun();
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    await repos.runs.recordApplied(wsA, {
      runId: run.id,
      batchSha256: SHA64,
      versionId: applied.version.id,
      baseVersionId: base.version.id,
    });

    const undone = await repos.runs.recordUndone(wsA, { runId: run.id, userId });
    expect(undone.undoneAt).toBeInstanceOf(Date);
    expect(undone.undoneBy).toBe(userId);
    expect(undone.appliedVersionId).toBe(applied.version.id); // linkage survives

    // the version row still exists, untouched
    const version = await repos.versions.get(wsA, project.id, applied.version.id);
    expect(version.id).toBe(applied.version.id);

    const state = await repos.runs.getPlanState(wsA, run.id);
    expect(state.status).toBe("undone");
    expect(state.undoneAt).toBeInstanceOf(Date);
    expect(state.appliedVersionId).toBe(applied.version.id);
  });

  it("undo before apply is a typed CONFLICT; so is a double-undo", async () => {
    const { run } = await seedRun();
    await expect(repos.runs.recordUndone(wsA, { runId: run.id, userId })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });

    const { project, base, run: appliedRun } = await seedRun();
    const applied = await seedAppliedVersion(project.id, base.version.id, appliedRun.id);
    await repos.runs.recordApplied(wsA, {
      runId: appliedRun.id,
      batchSha256: SHA64,
      versionId: applied.version.id,
      baseVersionId: base.version.id,
    });
    await repos.runs.recordUndone(wsA, { runId: appliedRun.id, userId });
    await expect(
      repos.runs.recordUndone(wsA, { runId: appliedRun.id, userId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cross-tenant apply/undo/plan-state read as NOT_FOUND, never 403 (§12.1)", async () => {
    const { project, base, run } = await seedRun();
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    await expect(
      repos.runs.recordApplied(wsB, {
        runId: run.id,
        batchSha256: SHA64,
        versionId: applied.version.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(repos.runs.recordUndone(wsB, { runId: run.id, userId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(repos.runs.getPlanState(wsB, run.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    // wsA still sees the untouched proposed plan
    const state = await repos.runs.getPlanState(wsA, run.id);
    expect(state.status).toBe("proposed");
  });

  it("apply is scoped to the run's project: a foreign version (same workspace) is NOT_FOUND", async () => {
    const { project, base, run } = await seedRun();
    const other = await seedRun(); // a second project — its v1 is foreign to `project`
    const foreign = other.base.version;
    expect(foreign.projectId).not.toBe(project.id);

    await expect(
      repos.runs.recordApplied(wsA, {
        runId: run.id,
        batchSha256: SHA64,
        versionId: foreign.id,
        baseVersionId: base.version.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // a foreign BASE version is rejected too, before anything is written
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    await expect(
      repos.runs.recordApplied(wsA, {
        runId: run.id,
        batchSha256: SHA64,
        versionId: applied.version.id,
        baseVersionId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await repos.runs.getPlanState(wsA, run.id)).status).toBe("proposed");
  });

  it("claimed base version must match the recorded base (PROJECT_VERSION_CONFLICT) or backfill it", async () => {
    const { project, base, run } = await seedRun();
    // v2 = the applied version (client saved on top of the base), v3 = what the
    // project moved on to before the user hit Apply on a stale card.
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    const diverged = await repos.versions.upload(wsA, {
      projectId: project.id,
      expectedVersionId: applied.version.id,
      objectKey: `workspaces/${wsA}/projects/${project.id}/versions/v3/project.ecproj`,
      sha256: `sha4_${randomUUID().slice(0, 8)}`,
      sizeBytes: 14,
      createdBy: userId,
    });
    await expect(
      repos.runs.recordApplied(wsA, {
        runId: run.id,
        batchSha256: SHA64,
        versionId: applied.version.id,
        baseVersionId: diverged.version.id, // plan was proposed on base — mismatch
      }),
    ).rejects.toMatchObject({ code: "PROJECT_VERSION_CONFLICT", status: 409 });

    // backfill: a run proposed without a base records the claimed base on apply
    const { project: p2, base: b2, run: r2 } = await seedRun({ baseVersionId: null });
    expect(r2.baseVersionId).toBeNull();
    const applied2 = await seedAppliedVersion(p2.id, b2.version.id, r2.id);
    const backfilled = await repos.runs.recordApplied(wsA, {
      runId: r2.id,
      batchSha256: SHA64,
      versionId: applied2.version.id,
      baseVersionId: b2.version.id,
    });
    expect(backfilled.baseVersionId).toBe(b2.version.id);
  });

  it("base_version_id FK integrity: a dangling version id violates the FK (23503)", async () => {
    const { thread, project } = await seedRun();
    // raw insert (the repo layer guards earlier): the FK constraint itself must
    // hold at the database level — drizzle wraps the PostgresError in `cause`.
    await expect(
      db.insert(schema.agentRuns).values({
        id: `run_fk_${randomUUID().slice(0, 8)}`,
        threadId: thread.id,
        projectId: project.id,
        model: "fast",
        status: "queued",
        baseVersionId: "ver_0000000000000000000000000000missing",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("batchSha256 is validated at the boundary (64 lowercase hex)", async () => {
    const { project, base, run } = await seedRun();
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    for (const bad of ["", "abcd", SHA64.toUpperCase(), `${SHA64}00`]) {
      await expect(
        repos.runs.recordApplied(wsA, {
          runId: run.id,
          batchSha256: bad,
          versionId: applied.version.id,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    }
    expect((await repos.runs.getPlanState(wsA, run.id)).status).toBe("proposed");
  });

  it("undo requires a real user: unknown undoneBy reads as NOT_FOUND", async () => {
    const { project, base, run } = await seedRun();
    const applied = await seedAppliedVersion(project.id, base.version.id, run.id);
    await repos.runs.recordApplied(wsA, {
      runId: run.id,
      batchSha256: SHA64,
      versionId: applied.version.id,
    });
    await expect(
      repos.runs.recordUndone(wsA, { runId: run.id, userId: `usr_test_${"0".repeat(24)}` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // run stays applied — nothing was written
    expect((await repos.runs.getPlanState(wsA, run.id)).status).toBe("applied");
  });

  it("versions.getById fetches by version id, workspace-scoped (M5 apply flow)", async () => {
    const { base } = await seedRun();
    const fetched = await repos.versions.getById(wsA, base.version.id);
    expect(fetched.id).toBe(base.version.id);
    // cross-tenant reads as NOT_FOUND (§12.1)
    await expect(repos.versions.getById(wsB, base.version.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(repos.versions.getById(wsA, "ver_unknown")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
