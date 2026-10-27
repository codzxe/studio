// @studio/worker — the M8 CLI-gated INTEGRATION suite (BUILD_PLAN §M8 task 5).
//
// REAL Postgres queue + REAL studio-cli renders + REAL ledger settlement,
// through the REAL pipeline (runJob / runOnce). Each test proves one §M8 exit
// criterion or M8 task-5 obligation:
//
//   golden       queue → claim → runOnce → completed; output in storage; the
//                ledger nets EXACTLY −estimateRenderCostUc (D-20, integer µc);
//                retention expiry set by plan.
//   png-seq      the sequence journey → one zipped artifact (PK signature,
//                EOCD, ≥2 entries), §9.2 .zip key.
//   cancel       cooperative cancel mid-render → cancelled + FULL refund.
//   timeout      jobTimeoutSeconds=1 → failed RENDER_TIMEOUT + full refund.
//   crash        a dead worker's stale running row is requeued by the sweep,
//                the retry completes it; SAME objectKey, attempts==2, and the
//                ledger still nets exactly ONE charge (no double-charge).
//   missing-asset  asset bytes absent → RENDER_ASSET_MISSING and the CLI was
//                NEVER spawned (pre-validation, spike §4).
//   malformed    garbage version bytes → RENDER_PROJECT_INVALID, refund intact.
//
// Gates: skips cleanly (reason in the describe title) when DATABASE_URL is
// not a postgres URL or the studio-cli binary cannot be resolved. On this
// box both gates pass and the suite RUNS.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { estimateRenderCostUc } from "@studio/config";

import { failureText } from "../../src/errors.js";
import { runOnce } from "../../src/index.js";
import {
  GRANT_UC,
  LONG_COMP,
  MAIN_COMP,
  type QueuedRender,
  type SeededProject,
  type SpyLogger,
  type WorkerWorld,
  balanceOf,
  createWorld,
  harnessEnv,
  hasPostgres,
  loadPhotoFixture,
  loadProjectFixture,
  makeDeps,
  queueRender,
  readOutput,
  renderLedger,
  resolveTestCli,
  scratchEntries,
  seedWorkspace,
  spyLogger,
  sweepQueueTerminal,
  waitFor,
} from "./harness.js";

const hasDb = hasPostgres();
const cli = resolveTestCli();
const skipReason =
  hasDb === false
    ? "DATABASE_URL is not a postgres URL (DB-gated suite)"
    : cli === null
      ? "studio-cli binary not found (repo build or STUDIO_ENGINE_CLI_PATH)"
      : null;
const RUNS = skipReason === null;

const DAY_MS = 86_400_000;

/** Trial plan retention (plans.ts) — the expires_at expectation. */
const TRIAL_RETENTION_DAYS = 3;

describe.skipIf(skipReason !== null)(
  `worker render pipeline end-to-end (CLI-gated integration)${RUNS ? "" : ` — SKIPPED: ${skipReason}`}`,
  { timeout: 120_000 },
  () => {
    let world: WorkerWorld;

    beforeAll(async () => {
      world = await createWorld(harnessEnv());
      // Queue hygiene: terminal-fail debris from aborted earlier runs so the
      // global claim/sweep surface sees only this suite's rows.
      await sweepQueueTerminal(world.repos);
    }, 60_000);

    afterAll(async () => {
      await world?.dispose();
    });

    // ── shared per-test journey helpers ─────────────────────────────────────

    interface Scenario {
      readonly seeded: SeededProject;
      readonly queued: QueuedRender;
      readonly logger: SpyLogger;
    }

    /** Per-test render settings (the RENDER_SETTINGS fields the suite uses). */
    interface ScenarioSettings {
      readonly width?: number;
      readonly height?: number;
      readonly quality?: "draft" | "good" | "best";
    }

    async function seedAndQueue(options: {
      readonly comp: typeof MAIN_COMP | typeof LONG_COMP;
      readonly format: "mp4" | "png-seq";
      readonly settings?: ScenarioSettings;
      readonly versionBytes?: Buffer;
      readonly assetBytes?: Buffer | null;
    }): Promise<Scenario> {
      const logger = spyLogger();
      const seeded = await seedWorkspace(world, {
        versionBytes: options.versionBytes ?? loadProjectFixture(),
        assetBytes: options.assetBytes === undefined ? loadPhotoFixture() : options.assetBytes,
      });
      const queued = await queueRender({
        world,
        seeded,
        comp: options.comp,
        format: options.format,
        settings: options.settings,
      });
      return { seeded, queued, logger };
    }

    /** Assert the full-refund shape: reserve + refundAll, net balance zero. */
    async function expectFullRefund(scenario: Scenario, label: string): Promise<void> {
      const entries = await renderLedger(
        world,
        scenario.seeded.workspaceId,
        scenario.queued.render.id,
      );
      expect(entries.length, `${label}: exactly reserve + refundAll rows`).toBe(2);
      const kinds = entries.map((entry) => entry.kind).sort();
      expect(kinds).toEqual(["refund", "reserve"]);
      const keys = entries.map((entry) => entry.idempotencyKey).sort();
      expect(keys).toEqual(
        [
          `render:refund:${scenario.queued.render.id}`,
          `render:reserve:${scenario.queued.render.id}`,
        ].sort(),
      );
      const balance = await balanceOf(world, scenario.seeded.workspaceId);
      expect(balance, `${label}: full refund — balance unchanged`).toBe(GRANT_UC);
    }

    // ── 1. GOLDEN RENDER ────────────────────────────────────────────────────

    it(
      "golden: queue → claim → runOnce → completed; storage output is a real mp4; ledger nets exactly −estimate",
      { timeout: 90_000 },
      async () => {
        const scenario = await seedAndQueue({
          comp: MAIN_COMP,
          format: "mp4",
          // 1080p + best keeps the charge above the minimum so the integer
          // equality proves the frames-based ACTUAL derivation, not the clamp.
          settings: { width: 1920, height: 1080, quality: "best" },
        });
        const deps = makeDeps(
          world,
          harnessEnv({ RENDER_JOB_TIMEOUT_SECONDS: "90" }),
          scenario.logger,
        );
        const renderId = scenario.queued.render.id;

        const startedAt = Date.now();
        const tick = await runOnce(deps);
        const wallMs = Date.now() - startedAt;

        expect(tick.claimed).toBe(1);
        const outcome = tick.outcomes.find((entry) => entry.renderId === renderId);
        expect(outcome?.outcome).toBe("completed");
        if (outcome?.outcome !== "completed") return;

        const row = await world.repos.renders.get(scenario.seeded.workspaceId, renderId);
        expect(row.status).toBe("completed");
        expect(row.error).toBeNull();
        expect(row.errorCode).toBeNull();
        // The §9.2 key was pre-created at queue time — the worker reused it.
        expect(row.objectKey).toBe(scenario.queued.render.objectKey);
        // CLI-observed progress persisted (heartbeat path, spike §3 grammar).
        expect(row.framesTotal).toBeGreaterThan(0);
        expect(row.startedAt).not.toBeNull();

        // Storage reads the REAL output back: an mp4 (ftyp box) with body.
        const bytes = await readOutput(world, row.objectKey ?? "");
        expect(bytes).not.toBeNull();
        if (bytes === null) return;
        expect(bytes.length).toBeGreaterThan(100 * 1024);
        expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
        expect(row.sizeBytes).toBe(bytes.length);

        // Retention: trial plan → expires_at ~3 days out.
        const expiresIn =
          row.expiresAt === null ? -1 : (row.expiresAt.getTime() - Date.now()) / DAY_MS;
        expect(expiresIn).toBeGreaterThan(TRIAL_RETENTION_DAYS - 0.5);
        expect(expiresIn).toBeLessThan(TRIAL_RETENTION_DAYS + 0.5);

        // D-20: the NET ledger effect is EXACTLY −estimateRenderCostUc(...)
        // for the quoted inputs (integer µc, one formula, no drift).
        const expectedUc = estimateRenderCostUc({
          format: "mp4",
          outputSeconds: scenario.queued.outputSeconds,
          longEdgePx: scenario.queued.longEdgePx,
          quality: "best",
        });
        expect(expectedUc).toBeGreaterThan(250_000); // not masked by the min clamp
        const balance = await balanceOf(world, scenario.seeded.workspaceId);
        expect(balance).toBe(GRANT_UC - expectedUc);

        // Ledger shape: reserve → settle (commit actual + release the FULL
        // hold), exactly one row per idempotency key. The settle sub-keys ride
        // the db layer's deriveIdempotencyKey (`:` → `%3A` inside each part).
        const entries = await renderLedger(world, scenario.seeded.workspaceId, renderId);
        expect(entries.length).toBe(3);
        const keys = entries.map((entry) => entry.idempotencyKey).sort();
        expect(keys).toEqual(
          [
            `render:reserve:${renderId}`,
            `render%3Asettle%3A${renderId}:commit`,
            `render%3Asettle%3A${renderId}:refund`,
          ].sort(),
        );
        expect(new Set(keys).size).toBe(3);
        const byKind = new Map(entries.map((entry) => [entry.kind, entry.amount]));
        expect(byKind.get("reserve")).toBe(-expectedUc);
        expect(byKind.get("commit")).toBe(-expectedUc);
        expect(byKind.get("refund")).toBe(expectedUc);

        // Sanity log (not a hard gate): a 2 s comp must render well under 60 s.
        scenario.logger.info("test_golden_wall_ms", { wallMs });
        expect(wallMs).toBeLessThan(60_000);
      },
    );

    // ── 2. PNG SEQUENCE → ONE ZIPPED ARTIFACT ────────────────────────────────

    it(
      "png-seq: the sequence journey completes and stores ONE valid zip at the §9.2 .zip key",
      { timeout: 60_000 },
      async () => {
        const scenario = await seedAndQueue({ comp: MAIN_COMP, format: "png-seq" });
        const deps = makeDeps(
          world,
          harnessEnv({ RENDER_JOB_TIMEOUT_SECONDS: "90" }),
          scenario.logger,
        );
        const renderId = scenario.queued.render.id;

        const tick = await runOnce(deps);
        const outcome = tick.outcomes.find((entry) => entry.renderId === renderId);
        expect(outcome?.outcome).toBe("completed");

        const row = await world.repos.renders.get(scenario.seeded.workspaceId, renderId);
        expect(row.status).toBe("completed");
        expect(row.objectKey).not.toBeNull();
        if (row.objectKey === null) return;
        expect(row.objectKey.endsWith(".zip")).toBe(true); // spike §5 artifact rule

        const bytes = await readOutput(world, row.objectKey);
        expect(bytes).not.toBeNull();
        if (bytes === null) return;
        // ZIP structure: local-header signature, EOCD present, ≥2 entries.
        expect(bytes.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
        const eocd = bytes.length - 22; // zipStore writes no archive comment
        expect(bytes.readUInt32LE(eocd)).toBe(0x06054b50);
        const entries = bytes.readUInt16LE(eocd + 10);
        expect(entries).toBeGreaterThanOrEqual(2);
        expect(bytes.toString("latin1").includes("frame_00000.png")).toBe(true);
        expect(row.sizeBytes).toBe(bytes.length);

        // The single formula again: png-seq 2 s @ 640 px good → min charge.
        const expectedUc = estimateRenderCostUc({
          format: "png-seq",
          outputSeconds: scenario.queued.outputSeconds,
          longEdgePx: scenario.queued.longEdgePx,
          quality: "good",
        });
        const balance = await balanceOf(world, scenario.seeded.workspaceId);
        expect(balance).toBe(GRANT_UC - expectedUc);
      },
    );

    // ── 3. COOPERATIVE CANCEL MID-RENDER ─────────────────────────────────────

    it(
      "cancel: requestCancel mid-render → cancelled + FULL refund, balance unchanged",
      { timeout: 60_000 },
      async () => {
        // A 10 s comp at 1080p renders for ~40 s on this box — plenty of
        // margin for the ~2 s cooperative poll to catch the cancel.
        const scenario = await seedAndQueue({
          comp: LONG_COMP,
          format: "mp4",
          settings: { width: 1920, height: 1080 },
        });
        const deps = makeDeps(
          world,
          harnessEnv({ RENDER_JOB_TIMEOUT_SECONDS: "120" }),
          scenario.logger,
        );
        const renderId = scenario.queued.render.id;
        const ws = scenario.seeded.workspaceId;

        const done = runOnce(deps);

        // Wait until the row is claimed and running (bounded).
        await waitFor(
          "render row flips to running",
          async () =>
            (await world.repos.renders.get(ws, renderId)).status === "running" ? true : null,
          { deadlineMs: 10_000, stepMs: 250 },
        );

        await world.repos.renders.requestCancel(ws, renderId);
        const tick = await done;

        const outcome = tick.outcomes.find((entry) => entry.renderId === renderId);
        expect(outcome?.outcome).toBe("cancelled");

        const row = await world.repos.renders.get(ws, renderId);
        expect(row.status).toBe("cancelled");
        expect(row.cancelRequested).toBe(true);
        expect(row.completedAt).not.toBeNull();
        // No output was ever produced for this render.
        const bytes = await readOutput(world, scenario.queued.render.objectKey ?? "");
        expect(bytes).toBeNull();

        await expectFullRefund(scenario, "cancel");
      },
    );

    // ── 4. HARD TIMEOUT ─────────────────────────────────────────────────────

    it(
      "timeout: jobTimeoutSeconds=1 → failed RENDER_TIMEOUT + full refund, completedAt set",
      { timeout: 60_000 },
      async () => {
        const scenario = await seedAndQueue({
          comp: LONG_COMP,
          format: "mp4",
          settings: { width: 1920, height: 1080 },
        });
        const deps = makeDeps(
          world,
          harnessEnv({ RENDER_JOB_TIMEOUT_SECONDS: "1" }),
          scenario.logger,
        );
        const renderId = scenario.queued.render.id;
        const ws = scenario.seeded.workspaceId;

        const tick = await runOnce(deps);
        const outcome = tick.outcomes.find((entry) => entry.renderId === renderId);
        expect(outcome?.outcome).toBe("failed");
        if (outcome?.outcome !== "failed") return;
        expect(outcome.errorCode).toBe("RENDER_TIMEOUT");

        const row = await world.repos.renders.get(ws, renderId);
        expect(row.status).toBe("failed");
        expect(row.errorCode).toBe("RENDER_TIMEOUT");
        expect(row.error).toBe(failureText("RENDER_TIMEOUT")); // sanitized catalog copy
        expect(row.completedAt).not.toBeNull();
        expect(row.expiresAt).toBeNull();
        const bytes = await readOutput(world, scenario.queued.render.objectKey ?? "");
        expect(bytes).toBeNull();

        await expectFullRefund(scenario, "timeout");
      },
    );

    // ── 5. CRASH RECOVERY: NO DUPLICATE OUTPUTS, NO DOUBLE CHARGE ───────────

    it(
      "crash recovery: a dead worker's stale row is requeued and the retry completes it — same objectKey, attempts==2, ledger nets ONE charge",
      { timeout: 90_000 },
      async () => {
        const scenario = await seedAndQueue({ comp: MAIN_COMP, format: "mp4" });
        const deps = makeDeps(
          world,
          harnessEnv({
            RENDER_HEARTBEAT_STALE_SECONDS: "2",
            RENDER_MAX_ATTEMPTS: "2",
            RENDER_JOB_TIMEOUT_SECONDS: "90",
          }),
          scenario.logger,
        );
        const renderId = scenario.queued.render.id;
        const ws = scenario.seeded.workspaceId;

        // Simulate a worker that claimed the job and DIED silently: the row is
        // running, attempts=1, and its heartbeat goes stale (no pings).
        const claimed = await world.repos.renders.claimNext("m8k-dead-worker", { limit: 5 });
        const mine = claimed.find((row) => row.id === renderId);
        expect(mine).toBeDefined();
        if (mine === undefined) return;
        expect(mine.status).toBe("running");
        expect(mine.attempts).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 3_500)); // > stale window

        // The next tick: sweep requeues the stale row, then claims + runs it.
        const tick = await runOnce(deps);
        expect(tick.swept.requeuedOrFailed).toBeGreaterThanOrEqual(1);
        expect(tick.claimed).toBe(1);
        const outcome = tick.outcomes.find((entry) => entry.renderId === renderId);
        expect(outcome?.outcome).toBe("completed");
        if (outcome?.outcome !== "completed") return;
        expect(outcome.alreadyDone).toBe(false);

        const row = await world.repos.renders.get(ws, renderId);
        expect(row.status).toBe("completed");
        expect(row.attempts).toBe(2); // initial claim + the retry
        // SAME deterministic §9.2 key — the retry OVERWROTE, no duplicate.
        expect(row.objectKey).toBe(scenario.queued.render.objectKey);
        const bytes = await readOutput(world, row.objectKey ?? "");
        expect(bytes).not.toBeNull();
        if (bytes === null) return;
        expect(bytes.length).toBeGreaterThan(100 * 1024);

        // Exactly ONE charge: the dead attempt never refunded (silent crash),
        // the retry's settle consumed the hold — reserve + commit + refund,
        // and NO render:refund:<id> row exists.
        const expectedUc = estimateRenderCostUc({
          format: "mp4",
          outputSeconds: scenario.queued.outputSeconds,
          longEdgePx: scenario.queued.longEdgePx,
          quality: "good",
        });
        const entries = await renderLedger(world, ws, renderId);
        expect(entries.length).toBe(3);
        const keys = entries.map((entry) => entry.idempotencyKey);
        expect(keys).toContain(`render:reserve:${renderId}`);
        expect(keys).toContain(`render%3Asettle%3A${renderId}:commit`);
        expect(keys).toContain(`render%3Asettle%3A${renderId}:refund`);
        expect(keys).not.toContain(`render:refund:${renderId}`);
        expect(entries.filter((entry) => entry.kind === "commit").length).toBe(1);
        const balance = await balanceOf(world, ws);
        expect(balance).toBe(GRANT_UC - expectedUc);
      },
    );

    // ── 6. MISSING ASSET — PRE-VALIDATED, CLI NEVER SPAWNED ─────────────────

    it(
      "missing asset: absent asset bytes → RENDER_ASSET_MISSING and the CLI was NEVER spawned",
      { timeout: 60_000 },
      async () => {
        const scenario = await seedAndQueue({
          comp: MAIN_COMP,
          format: "mp4",
          assetBytes: null, // the asset ROW exists; its bytes never hit storage
        });
        const deps = makeDeps(world, harnessEnv(), scenario.logger);
        const renderId = scenario.queued.render.id;
        const ws = scenario.seeded.workspaceId;

        // Leak regression: a job that fails inside hydration must clean its
        // confined workdir (found by this suite: failing hydrates stranded
        // dirs under .local/render-jobs — fixed in hydrate.ts).
        const scratchBefore = await scratchEntries();

        const tick = await runOnce(deps);
        const outcome = tick.outcomes.find((entry) => entry.renderId === renderId);
        expect(outcome?.outcome).toBe("failed");
        if (outcome?.outcome !== "failed") return;
        expect(outcome.errorCode).toBe("RENDER_ASSET_MISSING");

        const scratchAfter = await scratchEntries();
        expect(scratchAfter.filter((name) => !scratchBefore.includes(name))).toEqual([]);

        const row = await world.repos.renders.get(ws, renderId);
        expect(row.status).toBe("failed");
        expect(row.errorCode).toBe("RENDER_ASSET_MISSING");
        expect(row.error).toBe(failureText("RENDER_ASSET_MISSING"));
        expect(row.completedAt).not.toBeNull();

        // Spike §4: the CLI would render placeholder frames and exit 0 — the
        // pre-validation MUST have refused to spawn it at all.
        expect(scenario.logger.count("render_spawn")).toBe(0);

        await expectFullRefund(scenario, "missing asset");
      },
    );

    // ── 7. MALFORMED PROJECT BYTES ──────────────────────────────────────────

    it(
      "malformed project: garbage version bytes → RENDER_PROJECT_INVALID, refund intact",
      { timeout: 60_000 },
      async () => {
        const scenario = await seedAndQueue({
          comp: MAIN_COMP,
          format: "mp4",
          versionBytes: Buffer.from(
            "this is definitely not json <html>M8-K malformed-version fixture</html>\n",
            "utf8",
          ),
        });
        const deps = makeDeps(world, harnessEnv(), scenario.logger);
        const renderId = scenario.queued.render.id;
        const ws = scenario.seeded.workspaceId;

        const tick = await runOnce(deps);
        const outcome = tick.outcomes.find((entry) => entry.renderId === renderId);
        expect(outcome?.outcome).toBe("failed");
        if (outcome?.outcome !== "failed") return;
        expect(outcome.errorCode).toBe("RENDER_PROJECT_INVALID");

        const row = await world.repos.renders.get(ws, renderId);
        expect(row.status).toBe("failed");
        expect(row.errorCode).toBe("RENDER_PROJECT_INVALID");
        expect(row.error).toBe(failureText("RENDER_PROJECT_INVALID"));
        expect(scenario.logger.count("render_spawn")).toBe(0);

        await expectFullRefund(scenario, "malformed project");
      },
    );
  },
);
