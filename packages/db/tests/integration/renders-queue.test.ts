import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { type StudioDb, createDb } from "../../src/db.js";
import { DbError } from "../../src/errors-lite.js";
import { migrateDatabase } from "../../src/migrate.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import * as schema from "../../src/schema.js";

/**
 * M8-A integration tests — the renders table as a Postgres-backed JOB QUEUE.
 * Auto-run only when DATABASE_URL is a postgres URL (same gate as the other
 * integration suites):
 *   `DATABASE_URL=postgres://… pnpm --filter @studio/db test`
 *
 * Determinism (why the beforeAll sweep exists): claimNext / requeueStale /
 * listExpiredOutputs are trusted-internal GLOBAL operations, and aborted
 * earlier runs may have left queued/running/expired debris. The sweep
 * (1) fails-or-requeues stale running rows, (2) drains the queue, and
 * (3) purges expired outputs — the exact production recovery/retention
 * flows — so every exact-count assert below sees only this suite's rows.
 */

const pgUrl = process.env.DATABASE_URL ?? "";
const hasDb = /^postgres(ql)?:/.test(pgUrl);

/** ms to sleep between inserts so FIFO ordering by created_at is guaranteed. */
const ORDER_TICK_MS = 3;

describe.skipIf(!hasDb)("renders job queue (integration)", { timeout: 30_000 }, () => {
  let db: StudioDb;
  let repos: Repos;
  const wsA = `ws_rqa_${randomUUID().slice(0, 8)}`;
  const wsB = `ws_rqb_${randomUUID().slice(0, 8)}`;
  const userId = `usr_test_${randomUUID().slice(0, 8)}`;

  async function makePinnedProject(
    workspaceId: string,
    name: string,
  ): Promise<{ projectId: string; versionId: string }> {
    const project = await repos.projects.create(workspaceId, { name, createdBy: userId });
    const { version } = await repos.versions.upload(workspaceId, {
      projectId: project.id,
      expectedVersionId: null,
      objectKey: `workspaces/${workspaceId}/projects/${project.id}/versions/v1/project.ecproj`,
      sha256: randomUUID().replaceAll("-", "").slice(0, 8),
      sizeBytes: 8,
      createdBy: userId,
    });
    return { projectId: project.id, versionId: version.id };
  }

  interface QueueOptions {
    readonly settingsJson?: unknown;
  }

  async function queueRender(
    workspaceId: string,
    pinned: { projectId: string; versionId: string },
    options?: QueueOptions,
  ) {
    const render = await repos.renders.create(workspaceId, {
      projectId: pinned.projectId,
      versionId: pinned.versionId,
      compId: "comp_main",
      format: "mp4",
      settingsJson: options?.settingsJson,
      createdBy: userId,
    });
    await new Promise((resolve) => setTimeout(resolve, ORDER_TICK_MS));
    return render;
  }

  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    db = createDb(url);
    await migrateDatabase(db);
    repos = createRepos(db);
    await db
      .insert(schema.organization)
      .values([
        { id: wsA, name: "QA", slug: wsA },
        { id: wsB, name: "QB", slug: wsB },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.user)
      .values({ id: userId, name: "T", email: `${userId}@studio.test`, emailVerified: true })
      .onConflictDoNothing();

    // Determinism sweep (see file docblock): global queue hygiene. Any
    // debris is from PREVIOUS runs (serial files clean up after themselves),
    // so a 1s staleness window + full drain + output purge is enough to make
    // every exact-count assert below see only this suite's rows.
    await repos.renders.requeueStale(1, 1);
    for (let i = 0; i < 50; i++) {
      const batch = await repos.renders.claimNext("suite-drain", { limit: 25 });
      if (batch.length === 0) break;
    }
    const expired = await repos.renders.listExpiredOutputs(new Date(Date.now() + 86_400_000));
    for (const row of expired) {
      await repos.renders.markOutputExpired(row.workspaceId, row.id);
    }
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it("create pins a version of the same project; foreign/absent versions are typed 404s", async () => {
    const pinned = await makePinnedProject(wsA, "Pinned");
    const otherProject = await makePinnedProject(wsA, "Other Project");
    const tenantB = await makePinnedProject(wsB, "Tenant B");

    const render = await repos.renders.create(wsA, {
      projectId: pinned.projectId,
      versionId: pinned.versionId,
      compId: "comp_main",
      format: "mp4",
      createdBy: userId,
    });
    expect(render.versionId).toBe(pinned.versionId);
    expect(render.status).toBe("queued");
    expect(render.attempts).toBe(0);
    expect(render.framesDone).toBe(0);
    expect(render.framesTotal).toBe(0);
    expect(render.cancelRequested).toBe(false);
    expect(render.startedAt).toBeNull();
    expect(render.heartbeatAt).toBeNull();
    expect(render.expiresAt).toBeNull();
    expect(render.sizeBytes).toBeNull();

    // version of ANOTHER project in the same workspace → 404 (never 403).
    await expect(
      repos.renders.create(wsA, {
        projectId: pinned.projectId,
        versionId: otherProject.versionId,
        compId: "comp_main",
        format: "mp4",
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // cross-tenant version → 404 (§12.1)
    await expect(
      repos.renders.create(wsA, {
        projectId: pinned.projectId,
        versionId: tenantB.versionId,
        compId: "comp_main",
        format: "mp4",
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // unknown version → 404
    await expect(
      repos.renders.create(wsA, {
        projectId: pinned.projectId,
        versionId: "ver_missing",
        compId: "comp_main",
        format: "mp4",
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // empty versionId → typed validation, not a bare throw
    await expect(
      repos.renders.create(wsA, {
        projectId: pinned.projectId,
        versionId: "  ",
        compId: "comp_main",
        format: "mp4",
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // keep the queue clean for the FIFO test below: finish this render.
    await repos.renders.markRunning(wsA, render.id);
    await repos.renders.markCompleted(wsA, render.id, { objectKey: "k/a.mp4" });
  });

  it("create persists the route-precreated §9.2 objectKey (M8-G)", async () => {
    const pinned = await makePinnedProject(wsA, "Keyed");
    // The gateway route cannot know the row id before create() assigns it, so
    // it hands create() the key with the `{renderId}` placeholder — the repo
    // stamps the fresh id (RenderCreateInput.objectKey contract).
    const render = await repos.renders.create(wsA, {
      projectId: pinned.projectId,
      versionId: pinned.versionId,
      compId: "comp_main",
      format: "mp4",
      createdBy: userId,
      objectKey: `workspaces/${wsA}/projects/${pinned.projectId}/renders/{renderId}/output.mp4`,
    });
    expect(render.objectKey).toBe(
      `workspaces/${wsA}/projects/${pinned.projectId}/renders/${render.id}/output.mp4`,
    );

    // absent → NULL (M8-A callers unaffected)
    const bare = await repos.renders.create(wsA, {
      projectId: pinned.projectId,
      versionId: pinned.versionId,
      compId: "comp_main",
      format: "png-seq",
      createdBy: userId,
    });
    expect(bare.objectKey).toBeNull();

    // keep the queue clean for the other tests
    await repos.renders.markRunning(wsA, render.id);
    await repos.renders.markCompleted(wsA, render.id, { objectKey: render.objectKey ?? "k/a.mp4" });
    await repos.renders.markRunning(wsA, bare.id);
    await repos.renders.markCompleted(wsA, bare.id, { objectKey: "k/a.zip" });
  });

  it("claimNext claims FIFO, flips to running, and carries the resolved workspaceId", async () => {
    const pinned = await makePinnedProject(wsA, "FIFO");
    const first = await queueRender(wsA, pinned);
    const second = await queueRender(wsA, pinned);

    const claimed = await repos.renders.claimNext("worker-a", { limit: 10 });
    const ids = claimed.map((row) => row.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    // FIFO: the earlier created_at claims first.
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));

    const mine = claimed.find((row) => row.id === first.id);
    expect(mine?.status).toBe("running");
    expect(mine?.workspaceId).toBe(wsA); // resolved per-row for later calls
    expect(mine?.attempts).toBe(1);
    expect(mine?.startedAt).not.toBeNull();
    expect(mine?.heartbeatAt).not.toBeNull();

    const row = await repos.renders.get(wsA, first.id);
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(1);
    expect(row.startedAt).not.toBeNull();

    // empty queue → no claims
    const again = await repos.renders.claimNext("worker-a", { limit: 10 });
    expect(again.map((r) => r.id)).not.toContain(first.id);
    expect(again.map((r) => r.id)).not.toContain(second.id);

    // default limit is a single row (added a third queued row above? no — use two fresh)
    const third = await queueRender(wsA, pinned);
    const single = await repos.renders.claimNext("worker-a");
    expect(single.length).toBe(1);
    expect(single[0]?.id).toBe(third.id);

    // leave nothing queued behind
    for (const r of [first, second, third]) {
      await repos.renders.markCompleted(wsA, r.id, { objectKey: `k/${r.id}.mp4` });
    }
  });

  it("claimNext under two concurrent claims: SKIP LOCKED never double-claims", async () => {
    const pinned = await makePinnedProject(wsA, "Skip Locked");
    const created = [
      await queueRender(wsA, pinned),
      await queueRender(wsA, pinned),
      await queueRender(wsA, pinned),
      await queueRender(wsA, pinned),
    ];

    const [batchA, batchB] = await Promise.all([
      repos.renders.claimNext("worker-a", { limit: 2 }),
      repos.renders.claimNext("worker-b", { limit: 2 }),
    ]);

    const idsA = batchA.map((row) => row.id);
    const idsB = batchB.map((row) => row.id);
    // every row claimed exactly once — no double claim under SKIP LOCKED
    const claimedIds = [...idsA, ...idsB];
    expect(claimedIds.length).toBe(4);
    expect(new Set(claimedIds).size).toBe(4);
    for (const render of created) {
      expect(claimedIds).toContain(render.id);
    }
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    // each row is now running with one attempt
    for (const render of created) {
      const row = await repos.renders.get(wsA, render.id);
      expect(row.status).toBe("running");
      expect(row.attempts).toBe(1);
    }
    // leave nothing running behind
    for (const render of created) {
      await repos.renders.markFailed(wsA, render.id, { error: "test teardown" });
    }
  });

  it("requestCancel: queued rows stay queued and are skipped at claim time; idempotent", async () => {
    const pinned = await makePinnedProject(wsA, "Cooperative Cancel");
    const cancelled = await queueRender(wsA, pinned);
    const healthy = await queueRender(wsA, pinned);

    const flagged = await repos.renders.requestCancel(wsA, cancelled.id);
    expect(flagged.status).toBe("queued"); // stays queued; worker cancels at claim
    expect(flagged.cancelRequested).toBe(true);

    const flaggedAgain = await repos.renders.requestCancel(wsA, cancelled.id);
    expect(flaggedAgain.cancelRequested).toBe(true); // idempotent

    const claimed = await repos.renders.claimNext("worker-a", { limit: 10 });
    const claimedIds = claimed.map((row) => row.id);
    expect(claimedIds).toContain(healthy.id);
    expect(claimedIds).not.toContain(cancelled.id);

    const stillQueued = await repos.renders.get(wsA, cancelled.id);
    expect(stillQueued.status).toBe("queued");
    expect(stillQueued.cancelRequested).toBe(true);

    // running cancel: flag is observed by the worker, which terminal-transitions
    const flaggedRunning = await repos.renders.requestCancel(wsA, healthy.id);
    expect(flaggedRunning.status).toBe("running");
    expect(flaggedRunning.cancelRequested).toBe(true);
    const terminal = await repos.renders.markCancelled(wsA, healthy.id);
    expect(terminal.status).toBe("cancelled");

    // terminal rows refuse a cancel request (typed CONFLICT)
    await expect(repos.renders.requestCancel(wsA, healthy.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("heartbeat: idempotent pings, monotonic frames, running-only", async () => {
    const pinned = await makePinnedProject(wsA, "Heartbeat");
    const render = await queueRender(wsA, pinned);
    const claimed = (await repos.renders.claimNext("worker-a"))[0];
    if (!claimed) throw new Error("expected a claim");
    expect(claimed.id).toBe(render.id);

    const first = await repos.renders.heartbeat(wsA, render.id, {
      framesDone: 10,
      framesTotal: 30,
    });
    expect(first.framesDone).toBe(10);
    expect(first.framesTotal).toBe(30);
    expect(first.heartbeatAt).not.toBeNull();

    // a late/duplicate ping can never rewind progress
    const rewound = await repos.renders.heartbeat(wsA, render.id, { framesDone: 5 });
    expect(rewound.framesDone).toBe(10);
    const advanced = await repos.renders.heartbeat(wsA, render.id, {
      framesDone: 12,
      framesTotal: 60,
    });
    expect(advanced.framesDone).toBe(12);
    expect(advanced.framesTotal).toBe(60);
    const repeated = await repos.renders.heartbeat(wsA, render.id, {
      framesDone: 12,
      framesTotal: 60,
    });
    expect(repeated.framesDone).toBe(12);
    expect(repeated.framesTotal).toBe(60);

    // non-running rows refuse heartbeats (typed CONFLICT)
    await repos.renders.markCompleted(wsA, render.id, { objectKey: "k/hb.mp4" });
    await expect(repos.renders.heartbeat(wsA, render.id, { framesDone: 20 })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  });

  it("requeueStale: fresh heartbeats untouched; stale requeues under maxAttempts, fails at max", async () => {
    const pinned = await makePinnedProject(wsA, "Requeue");
    const render = await queueRender(wsA, pinned);
    const claimed = (await repos.renders.claimNext("worker-a"))[0];
    if (!claimed) throw new Error("expected a claim");
    expect(claimed.id).toBe(render.id);
    expect(claimed.attempts).toBe(1);

    // fresh heartbeat → nothing is stale
    expect((await repos.renders.requeueStale(3600, 2)).requeued).toBe(0);

    // simulate a crashed worker: heartbeat outside the window
    await db
      .update(schema.renders)
      .set({ heartbeatAt: new Date(Date.now() - 7_200_000) })
      .where(eq(schema.renders.id, render.id));

    expect((await repos.renders.requeueStale(3600, 2)).requeued).toBe(1);
    const requeued = await repos.renders.get(wsA, render.id);
    expect(requeued.status).toBe("queued"); // the sanctioned running→queued edge
    expect(requeued.attempts).toBe(1); // attempts survive; incremented on claim
    expect(requeued.cancelRequested).toBe(false);
    expect(requeued.startedAt).toBeNull();
    expect(requeued.heartbeatAt).toBeNull();

    // a canceled-mid-crash row is requeued with the flag cleared
    const reclaimed = (await repos.renders.claimNext("worker-b"))[0];
    if (!reclaimed) throw new Error("expected a re-claim");
    expect(reclaimed.id).toBe(render.id);
    expect(reclaimed.attempts).toBe(2);
    await db
      .update(schema.renders)
      .set({ heartbeatAt: new Date(Date.now() - 7_200_000) })
      .where(eq(schema.renders.id, render.id));

    // attempts (2) >= maxAttempts (2) → honest terminal failure
    // BIL-02: the result reports the failed row + its workspace so the
    // sweep can refund the stranded hold.
    const terminal = await repos.renders.requeueStale(3600, 2);
    expect(terminal.requeued).toBe(0);
    expect(terminal.failed).toHaveLength(1);
    expect(terminal.failed[0]?.id).toBe(render.id);
    expect(terminal.failed[0]?.workspaceId).toBe(wsA);
    const failed = await repos.renders.get(wsA, render.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("worker lost mid-render");
    expect(failed.errorCode).toBe("RENDER_INTERNAL");
    expect(failed.completedAt).not.toBeNull();

    // running rows with a NULL heartbeat count as stale (pre-M8 rows)
    const legacy = await queueRender(wsA, pinned);
    await db
      .update(schema.renders)
      .set({ status: "running", attempts: 1, heartbeatAt: null, startedAt: new Date() })
      .where(eq(schema.renders.id, legacy.id));
    expect((await repos.renders.requeueStale(3600, 5)).requeued).toBe(1);
    const legacyRow = await repos.renders.get(wsA, legacy.id);
    expect(legacyRow.status).toBe("queued");
    expect(legacyRow.attempts).toBe(1);

    // teardown: claim and fail the legacy row so nothing lingers
    const legacyClaim = (await repos.renders.claimNext("worker-c"))[0];
    if (!legacyClaim) throw new Error("expected a legacy claim");
    await repos.renders.markFailed(wsA, legacyClaim.id, {
      error: "teardown",
      errorCode: "RENDER_TIMEOUT",
    });
  });

  it("markFailed persists the optional machine-readable errorCode", async () => {
    const pinned = await makePinnedProject(wsA, "Error Codes");
    const render = await queueRender(wsA, pinned);
    await repos.renders.markRunning(wsA, render.id);
    const failed = await repos.renders.markFailed(wsA, render.id, {
      error: "encoder exploded",
      errorCode: "RENDER_TIMEOUT",
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("encoder exploded");
    expect(failed.errorCode).toBe("RENDER_TIMEOUT");

    const bare = await queueRender(wsA, pinned);
    await repos.renders.markRunning(wsA, bare.id);
    const failedBare = await repos.renders.markFailed(wsA, bare.id, { error: "no code" });
    expect(failedBare.errorCode).toBeNull();
  });

  it("expire/purge lifecycle: listExpiredOutputs → markOutputExpired keeps history", async () => {
    const pinned = await makePinnedProject(wsA, "Expiry");
    const expiredOne = await queueRender(wsA, pinned);
    const kept = await queueRender(wsA, pinned);
    const neverExpires = await queueRender(wsA, pinned);

    await repos.renders.markRunning(wsA, expiredOne.id);
    const done = await repos.renders.markCompleted(wsA, expiredOne.id, {
      objectKey: "k/expired.mp4",
      sizeBytes: 1234,
      expiresAt: new Date(Date.now() - 1_000), // already expired
    });
    expect(done.sizeBytes).toBe(1234);
    expect(done.expiresAt).not.toBeNull();

    await repos.renders.markRunning(wsA, kept.id);
    await repos.renders.markCompleted(wsA, kept.id, {
      objectKey: "k/kept.mp4",
      sizeBytes: 50,
      expiresAt: new Date(Date.now() + 86_400_000), // a day from now
    });

    await repos.renders.markRunning(wsA, neverExpires.id);
    await repos.renders.markCompleted(wsA, neverExpires.id, { objectKey: "k/no-expiry.mp4" });

    const expired = await repos.renders.listExpiredOutputs(new Date());
    expect(expired.map((row) => row.id)).toEqual([expiredOne.id]);
    expect(expired[0]?.workspaceId).toBe(wsA); // per-row scope for the sweeper
    expect(expired[0]?.objectKey).toBe("k/expired.mp4");

    const purged = await repos.renders.markOutputExpired(wsA, expiredOne.id);
    expect(purged.status).toBe("completed"); // row stays as history…
    expect(purged.objectKey).toBeNull(); // …but the output is gone
    expect(purged.expiresAt).toBeNull();
    expect(purged.sizeBytes).toBeNull();

    // idempotent, and the sweep no longer sees it
    const purgedAgain = await repos.renders.markOutputExpired(wsA, expiredOne.id);
    expect(purgedAgain.objectKey).toBeNull();
    expect(await repos.renders.listExpiredOutputs(new Date())).toEqual([]);

    // non-completed rows refuse the purge
    const queued = await queueRender(wsA, pinned);
    await expect(repos.renders.markOutputExpired(wsA, queued.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await repos.renders.markCancelled(wsA, queued.id);
  });

  it("countActive: queued + running per workspace", async () => {
    const wsCount = `ws_cnt_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.organization)
      .values({ id: wsCount, name: "Count", slug: wsCount })
      .onConflictDoNothing();
    const pinned = await makePinnedProject(wsCount, "Concurrent");

    const r1 = await queueRender(wsCount, pinned);
    await queueRender(wsCount, pinned);
    await queueRender(wsCount, pinned);

    expect(await repos.renders.countActive(wsCount)).toBe(3);

    const claimed = (await repos.renders.claimNext("worker-a"))[0];
    if (!claimed) throw new Error("expected a claim");
    expect(claimed.id).toBe(r1.id);
    expect(await repos.renders.countActive(wsCount)).toBe(3); // running still counts

    await repos.renders.markCompleted(wsCount, r1.id, { objectKey: "k/one.mp4" });
    expect(await repos.renders.countActive(wsCount)).toBe(2);

    // leave nothing queued behind: drain wsCount's two survivors
    const survivors = await repos.renders.claimNext("worker-a", { limit: 2 });
    expect(survivors.map((row) => row.workspaceId)).toEqual([wsCount, wsCount]);
    for (const row of survivors) {
      await repos.renders.markCompleted(wsCount, row.id, { objectKey: `k/${row.id}.mp4` });
    }
    expect(await repos.renders.countActive(wsCount)).toBe(0);

    // tenant isolation: another workspace sees nothing
    expect(await repos.renders.countActive(wsB)).toBe(0);
  });

  it("renderSecondsUsed: Σ frames_total/frameRate over completed renders, honest 0 fallback", async () => {
    const wsUsage = `ws_usg_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.organization)
      .values({ id: wsUsage, name: "Usage", slug: wsUsage })
      .onConflictDoNothing();
    const pinned = await makePinnedProject(wsUsage, "Quota");

    const short = await queueRender(wsUsage, pinned, { settingsJson: { frameRate: 30 } });
    const long = await queueRender(wsUsage, pinned, { settingsJson: { frameRate: 30 } });
    const noFps = await queueRender(wsUsage, pinned, {}); // no frameRate → 0
    const doomed = await queueRender(wsUsage, pinned, { settingsJson: { frameRate: 30 } });

    const claimed = await repos.renders.claimNext("worker-a", { limit: 4 });
    expect(claimed.length).toBe(4);
    await repos.renders.heartbeat(wsUsage, short.id, { framesDone: 30, framesTotal: 30 });
    await repos.renders.heartbeat(wsUsage, long.id, { framesDone: 60, framesTotal: 60 });
    await repos.renders.heartbeat(wsUsage, noFps.id, { framesDone: 30, framesTotal: 30 });
    await repos.renders.markCompleted(wsUsage, short.id, { objectKey: "k/s.mp4" });
    await repos.renders.markCompleted(wsUsage, long.id, { objectKey: "k/l.mp4" });
    await repos.renders.markCompleted(wsUsage, noFps.id, { objectKey: "k/n.mp4" });
    await repos.renders.markFailed(wsUsage, doomed.id, { error: "not counted" });

    const since = new Date(Date.now() - 60_000);
    // 30/30 + 60/30 = 3 seconds; the failed row and the frameRate-less row
    // contribute nothing (documented fallback — never a guess).
    expect(await repos.renders.renderSecondsUsed(wsUsage, since)).toBe(3);
    // `since` in the future → nothing counts yet
    expect(await repos.renders.renderSecondsUsed(wsUsage, new Date(Date.now() + 60_000))).toBe(0);
    // other workspaces see nothing
    expect(await repos.renders.renderSecondsUsed(wsB, since)).toBe(0);
  });

  it("render-scoped ledger: holds settle per render; run XOR render enforced at the repo layer", async () => {
    const wsLedger = `ws_led_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.organization)
      .values({ id: wsLedger, name: "Led", slug: wsLedger })
      .onConflictDoNothing();
    const pinned = await makePinnedProject(wsLedger, "Ledger Scope");
    const render = await repos.renders.create(wsLedger, {
      projectId: pinned.projectId,
      versionId: pinned.versionId,
      compId: "comp_main",
      format: "mp4",
      createdBy: userId,
    });

    const grant = await repos.ledger.grant(wsLedger, {
      amount: 1_000_000, // 1 credit in µc (D-12: integer microcredits only)
      idempotencyKey: `m8a:grant:${render.id}`,
    });
    expect(grant.entry.renderId).toBeNull(); // unscoped grants stay unscoped

    const held = await repos.ledger.reserve(wsLedger, {
      renderId: render.id, // render-scoped hold — no runId
      amount: 500,
      idempotencyKey: `m8a:reserve:${render.id}`,
    });
    expect(held.entry.renderId).toBe(render.id);
    expect(held.entry.runId).toBeNull();
    expect(held.replayed).toBe(false);

    // a ledger row may be scoped to a run OR a render — never both
    await expect(
      repos.ledger.reserve(wsLedger, {
        runId: "run_x",
        renderId: render.id,
        amount: 10,
        idempotencyKey: `m8a:xor:${render.id}`,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // …and hold operations require exactly one producer
    await expect(
      repos.ledger.reserve(wsLedger, {
        amount: 10,
        idempotencyKey: `m8a:noscope:${render.id}`,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // settle commits the actual cost and releases the full hold (D-20)
    const settled = await repos.ledger.settle(wsLedger, {
      renderId: render.id,
      actualCost: 300,
      idempotencyKey: `m8a:settle:${render.id}`,
    });
    expect(settled.commit?.renderId).toBe(render.id);
    expect(settled.commit?.amount).toBe(-300);
    expect(settled.refund?.amount).toBe(500);
    expect(settled.replayed).toBe(false);

    // nothing left to refund for this render
    const refunded = await repos.ledger.refundAll(wsLedger, {
      renderId: render.id,
      idempotencyKey: `m8a:refund-all:${render.id}`,
    });
    expect(refunded.entry).toBeNull();
    expect(refunded.refunded).toBe(0);

    // net: −300 µc for the render
    expect(await repos.ledger.balance(wsLedger)).toBe(1_000_000 - 300);

    // list filters render-scoped entries
    const entries = await repos.ledger.list(wsLedger, { renderId: render.id, limit: 10 });
    expect(entries.items.length).toBe(3); // reserve + commit + refund
    expect(entries.items.every((entry) => entry.renderId === render.id)).toBe(true);

    // run-scoped holds still work unchanged (key unique per run — the ledger
    // idempotency table is GLOBAL)
    const runHeld = await repos.ledger.reserve(wsLedger, {
      runId: "run_x",
      amount: 100,
      idempotencyKey: `m8a:reserve:run_x:${wsLedger}`,
    });
    expect(runHeld.entry.runId).toBe("run_x");
    expect(runHeld.entry.renderId).toBeNull();
  });
});
