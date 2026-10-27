// @studio/worker — W5-10 LIVE sqlite pipeline smoke (verifiable on any box).
//
// END-TO-END verification of the M8 render pipeline on the SQLITE dev dialect
// (the dev-server default since W1-03/W3-A). Everything is REAL — no mocks:
//   - a real throwaway sqlite database (createDb("file:…") auto-bootstraps the
//     twin schema) + the real repo bundle (createRepos) with every dialect
//     fork live (SKIP LOCKED dropped, advisory lock skipped, greatest→max,
//     count(*)::int, now()→unixepoch defaults);
//   - the worker's own storage seam (createWorkerStorage → the gateway's
//     LocalFS driver) under an isolated throwaway root;
//   - the committed M8-E fixtures (tests/fixtures/project.ecproj + photo.png)
//     seeded exactly the way the gateway would persist them (§9.2 keys);
//   - the REAL pipeline drivers: runOnce (deterministic tick) and startWorker
//     (the long-lived claim loop).
//
// The ONLY external dependency is the studio-cli binary:
//   - PRESENT (env STUDIO_ENGINE_CLI_PATH → repo build → PATH): the full
//     success path runs — claim → hydrate → spawn → heartbeat → output object
//     → markCompleted → ledger settle (D-20).
//   - ABSENT (this box today): the HONEST degrade path runs — claim → hydrate
//     → spawn ENOENT → typed RENDER_CLI_MISSING → markFailed + idempotent
//     ledger refund (render:refund:<id>). That IS the deliverable when the
//     binary cannot exist (per W5-10 rules: no mocks).
//
// Repo-level dialect-fork proofs (Phase 1) run regardless of the CLI:
//   claimNext / heartbeat (monotonic max()) / countActive / requeueStale
//   (both crash-recovery branches) / ledger reserve→settle (D-20 + idempotent
//   replay, advisory-lock fork).
//
// Usage (idempotent — wipes its own throwaway files first):
//   cd services/worker && node --import tsx scripts/sqlite-pipeline-smoke.ts
// Env: W5_10_SMOKE_DB (default <repo>/.local/w5-10-smoke.db),
//      STUDIO_ENGINE_CLI_PATH honored through the worker's own resolution.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type StudioEnv, estimateRenderCostDetailUc, parseEnv } from "@studio/config";
import { createDb, createRepos, tablesFor } from "@studio/db";
import { assetKey, renderKey, sha256Hex, snapshotKey } from "@studio/gateway/storage";

import { resolveCliPath, resolveRenderKnobs } from "../src/cli.js";
import { runOnce, startWorker } from "../src/index.js";
import { createWorkerLogger } from "../src/logger.js";
import { createWorkerStorage, defaultRepoRoot } from "../src/storage.js";

// ───────────────────────────────────────────────────────────────────────────
// Harness (mirrors tests/integration/harness.ts — the PG suite's real-deps
// wiring, pointed at the sqlite twin instead)
// ───────────────────────────────────────────────────────────────────────────

const REPO = defaultRepoRoot();
const SMOKE_DB = process.env.W5_10_SMOKE_DB ?? join(REPO, ".local", "w5-10-smoke.db");
const GRANT_UC = 20_000_000;

function smokeEnv(): StudioEnv {
  const source: Record<string, string> = {
    APP_URL: "http://127.0.0.1:3999",
    APP_ENV: "local",
    LOG_LEVEL: "info", // worker events are the run's evidence
    MOCK_MODEL: "true",
    DATABASE_URL: `file:${SMOKE_DB}`,
    ASSET_MAX_BYTES: "10485760",
    PROJECT_MAX_BYTES: "20971520",
    STRIPE_WEBHOOK_SECRET: "whsec_test_not_configured",
    STRIPE_PRICE_IDS: '{"starter":"price_test","pro":"price_test","studio":"price_test"}',
    AUTH_SECRET: "test-secret-test-secret-test-secret-32",
    AUTH_GOOGLE_ID: "disabled",
    AUTH_GOOGLE_SECRET: "disabled",
    AUTH_GITHUB_ID: "disabled",
    AUTH_GITHUB_SECRET: "disabled",
    LITELLM_BASE_URL: "http://127.0.0.1:4000",
    LITELLM_API_KEY: "sk-test-not-configured",
    CHAT_MAX_STEPS: "20",
    RENDER_POLL_INTERVAL_MS: "300", // snappy loop for the startWorker phase
  };
  const cli = process.env.STUDIO_ENGINE_CLI_PATH?.trim();
  if (cli !== undefined && cli !== "") source.STUDIO_ENGINE_CLI_PATH = cli;
  return parseEnv(source);
}

const FIXTURES = join(REPO, "services", "worker", "tests", "fixtures");
const MAIN_COMP = { compId: "Main", width: 640, height: 360, frameRate: 30, durationSeconds: 2 };

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log(`  ✓ ${label}`);
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  deadlineMs: number,
): Promise<void> {
  const deadlineAt = Date.now() + deadlineMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadlineAt) throw new Error(`waitFor: ${label} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function main(): Promise<void> {
  // Idempotent reruns: the smoke owns its throwaway files.
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${SMOKE_DB}${suffix}`, { force: true });
  const scratchParent = join(REPO, ".local", "w5-10-smoke");
  rmSync(scratchParent, { recursive: true, force: true });
  mkdirSync(scratchParent, { recursive: true });
  const storageRoot = mkdtempSync(join(scratchParent, "storage-"));

  const env = smokeEnv();
  const db = createDb(`file:${SMOKE_DB}`); // sqlite branch + auto-bootstrap
  const repos = createRepos(db);
  const storage = createWorkerStorage(env, storageRoot);
  const logger = createWorkerLogger(env);
  const deps = { db, repos, ledger: repos.ledger, storage, env, logger };

  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log(`W5-10 sqlite pipeline smoke — db=${SMOKE_DB} storage=${storageRoot}`);

  // ── Seed: throwaway workspace exactly like the gateway would persist it ──
  const tables = tablesFor(db);
  const workspaceId = `ws_w510_${randomUUID().slice(0, 8)}`;
  const userId = `usr_w510_${randomUUID().slice(0, 8)}`;
  await db
    .insert(tables.organization)
    .values({ id: workspaceId, name: "W5-10 Smoke", slug: workspaceId })
    .onConflictDoNothing();
  await db
    .insert(tables.user)
    .values({ id: userId, name: "W5-10", email: `${userId}@studio.test`, emailVerified: true })
    .onConflictDoNothing();
  await repos.ledger.grant(workspaceId, {
    amount: GRANT_UC,
    idempotencyKey: `w510:grant:${workspaceId}`,
    metadata: { smoke: "W5-10" },
  });
  assert((await repos.ledger.balance(workspaceId)) === GRANT_UC, "ledger.grant on sqlite");

  const projectBytes = readFileSync(join(FIXTURES, "project.ecproj"));
  const photoBytes = readFileSync(join(FIXTURES, "photo.png"));

  async function seedProject(withAssetBytes: boolean): Promise<{
    projectId: string;
    versionId: string;
  }> {
    const project = await repos.projects.create(workspaceId, {
      name: `W5-10 ${randomUUID().slice(0, 8)}`,
      createdBy: userId,
    });
    const sha = sha256Hex(projectBytes);
    const versionKey = snapshotKey(workspaceId, project.id, sha);
    const { version } = await repos.versions.upload(workspaceId, {
      projectId: project.id,
      expectedVersionId: null,
      objectKey: versionKey,
      sha256: sha,
      sizeBytes: projectBytes.length,
      createdBy: userId,
    });
    await storage.driver.put(versionKey, projectBytes);

    const assetId = `ast_w510_${randomUUID().slice(0, 8)}`;
    const key = assetKey(workspaceId, assetId, "photo.png");
    await repos.assets.create(workspaceId, {
      projectId: project.id,
      name: "photo.png",
      mime: "image/png",
      sizeBytes: withAssetBytes ? photoBytes.length : 0,
      sha256: withAssetBytes ? sha256Hex(photoBytes) : sha256Hex(Buffer.alloc(0)),
      objectKey: key,
      width: 640,
      height: 360,
      createdBy: userId,
    });
    if (withAssetBytes) await storage.driver.put(key, photoBytes);
    return { projectId: project.id, versionId: version.id };
  }

  /** Queue exactly the way the M8-G gateway route does (quote → row → hold). */
  async function queueRender(seeded: { projectId: string; versionId: string }) {
    const knobs = resolveRenderKnobs({
      format: "mp4",
      settings: {},
      comp: {
        width: MAIN_COMP.width,
        height: MAIN_COMP.height,
        frameRate: MAIN_COMP.frameRate,
        durationSeconds: MAIN_COMP.durationSeconds,
      },
    });
    const detail = estimateRenderCostDetailUc({
      format: "mp4",
      outputSeconds: knobs.effective.outputSeconds,
      longEdgePx: knobs.effective.longEdgePx,
      quality: knobs.effective.quality,
    });
    const render = await repos.renders.create(workspaceId, {
      projectId: seeded.projectId,
      versionId: seeded.versionId,
      compId: MAIN_COMP.compId,
      format: "mp4",
      settingsJson: {},
      credits: detail.totalUc,
      createdBy: userId,
      objectKey: renderKey(workspaceId, seeded.projectId, "{renderId}", "mp4"),
    });
    await repos.ledger.reserve(workspaceId, {
      renderId: render.id,
      amount: detail.totalUc,
      idempotencyKey: `render:reserve:${render.id}`,
      metadata: { smoke: "W5-10" },
    });
    return { render, estimateUc: detail.totalUc };
  }

  let expectedBalance = GRANT_UC;

  // ── PHASE 1 — dialect forks at repo level (no CLI involved) ──────────────
  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log("\n[Phase 1] renders/ledger repo dialect forks on sqlite");
  {
    const seeded = await seedProject(true);
    const { render: renderA } = await queueRender(seeded);

    const [rowA] = await repos.renders.claimNext("w510-forks", { limit: 5 });
    if (rowA === undefined) throw new Error("claimNext returned nothing");
    assert(rowA.id === renderA.id, "claimNext claims the queued row");
    assert(rowA.status === "running", "claim flips queued → running (no SKIP LOCKED needed)");
    assert(rowA.attempts === 1, "claim bumps attempts 0 → 1");
    assert(
      rowA.startedAt !== null && rowA.heartbeatAt !== null,
      "claim sets started_at + heartbeat_at",
    );
    assert(
      rowA.workspaceId === workspaceId,
      "claim resolves workspaceId (tenant-scoped follow-ups)",
    );
    const key = rowA.objectKey;
    assert(key?.includes(renderA.id) === true, "M8-G {renderId} placeholder resolved at create()");

    await repos.renders.heartbeat(workspaceId, renderA.id, { framesDone: 30, framesTotal: 60 });
    const hb = await repos.renders.heartbeat(workspaceId, renderA.id, {
      framesDone: 10, // a late/duplicate ping — must NEVER rewind progress
      framesTotal: 90,
    });
    assert(hb.framesDone === 30, "heartbeat monotonic: framesDone stays 30 (sqlite max() fork)");
    assert(hb.framesTotal === 90, "heartbeat advances framesTotal 60 → 90");
    assert((await repos.renders.countActive(workspaceId)) === 1, "countActive via count(*) fork");

    // requeueStale branch 1: attempts left → back to queued (running→queued).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const swept1 = await repos.renders.requeueStale(1, 3);
    const afterSweep1 = await repos.renders.get(workspaceId, renderA.id);
    assert(
      swept1 === 1 && afterSweep1.status === "queued" && afterSweep1.attempts === 1,
      "requeueStale: stale running → queued (branch 1)",
    );
    // claim again (attempt 2), go stale again → still under maxAttempts.
    const [row2] = await repos.renders.claimNext("w510-forks", { limit: 5 });
    assert(row2 !== undefined && row2.attempts === 2, "re-claim after requeue → attempts 2");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await repos.renders.requeueStale(1, 3);
    const [row3] = await repos.renders.claimNext("w510-forks", { limit: 5 });
    assert(row3 !== undefined && row3.attempts === 3, "third claim → attempts 3");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const swept2 = await repos.renders.requeueStale(1, 3);
    const terminal = await repos.renders.get(workspaceId, renderA.id);
    assert(
      swept2 === 1 &&
        terminal.status === "failed" &&
        terminal.errorCode === "RENDER_INTERNAL" &&
        terminal.error === "worker lost mid-render",
      "requeueStale: out of attempts → terminal failed RENDER_INTERNAL (branch 2)",
    );

    // The sweep is repo-level (no ledger calls); the WORKER's refund for a
    // terminally-failed attempt is the idempotency-keyed refundAll below —
    // the exact call pipeline.ts's fail() path makes.
    await repos.ledger.refundAll(workspaceId, {
      renderId: renderA.id,
      idempotencyKey: `render:refund:${renderA.id}`,
      metadata: { reason: "smoke: sweep terminal-failed the attempt" },
    });
    assert(
      (await repos.ledger.balance(workspaceId)) === expectedBalance,
      "ledger.refundAll releases the failed attempt's hold (idempotency-keyed)",
    );

    // Ledger D-20 on sqlite: reserve (above) → settle commits ACTUAL < hold.
    const seededB = await seedProject(true);
    const { render: renderB, estimateUc: estB } = await queueRender(seededB);
    const actualB = Math.max(1, estB - 12345);
    await repos.ledger.settle(workspaceId, {
      renderId: renderB.id,
      actualCost: actualB,
      idempotencyKey: `render:settle:${renderB.id}`,
      metadata: { smoke: "W5-10" },
    });
    expectedBalance -= actualB;
    assert(
      (await repos.ledger.balance(workspaceId)) === expectedBalance,
      "ledger.settle commits actual + releases hold (D-20, advisory lock skipped)",
    );
    await repos.ledger.settle(workspaceId, {
      renderId: renderB.id,
      actualCost: actualB,
      idempotencyKey: `render:settle:${renderB.id}`, // replay — same key
      metadata: { smoke: "W5-10" },
    });
    assert(
      (await repos.ledger.balance(workspaceId)) === expectedBalance,
      "ledger.settle idempotent replay (no double charge)",
    );
    // B must be terminal before the Phase-3 loop boots (no dangling queued row):
    // claim it and fail it at repo level (running → failed is legal).
    const [claimedB] = await repos.renders.claimNext("w510-forks", { limit: 5 });
    assert(claimedB !== undefined && claimedB.id === renderB.id, "claim render B");
    await repos.renders.markFailed(workspaceId, renderB.id, {
      error: "smoke: repo-level terminal transition",
      errorCode: "RENDER_INTERNAL",
    });
  }

  // ── PHASE 2 — LIVE pipeline: runOnce drives claim → hydrate → spawn ──────
  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log("\n[Phase 2] runOnce: live claim → hydrate → spawn → honest terminal");
  const cli = resolveCliPath(env.render.cliPath, REPO);
  const cliPresent = cli.source === "env" || (cli.source === "repo-build" && existsSync(cli.path));
  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log(`  CLI resolution: path=${cli.path} source=${cli.source} present=${cliPresent}`);
  let renderCId = "";
  {
    const seeded = await seedProject(true);
    const { render: renderC } = await queueRender(seeded);
    renderCId = renderC.id;
    assert(
      (await repos.renders.get(workspaceId, renderCId)).status === "queued",
      "render queued before the tick",
    );

    const tick = await runOnce(deps);
    assert(tick.claimed === 1, "runOnce claims the queued row on sqlite");
    assert(tick.outcomes.length === 1, "runOnce drives the job to a terminal outcome");

    const row = await repos.renders.get(workspaceId, renderCId);
    const outcome = tick.outcomes[0];
    if (outcome === undefined) throw new Error("runOnce produced no outcome");
    if (outcome.outcome === "failed" && outcome.errorCode === "RENDER_CLI_MISSING") {
      assert(
        row.status === "failed" && row.errorCode === "RENDER_CLI_MISSING",
        "honest failed RENDER_CLI_MISSING (no mock success)",
      );
      assert(row.completedAt !== null, "failure is terminal (completed_at set)");
      assert(
        (await repos.ledger.balance(workspaceId)) === expectedBalance,
        "refund restored the reserve (balance back to pre-hold)",
      );
      const page = await repos.ledger.list(workspaceId, { renderId: renderCId });
      const kinds = page.items.map((entry) => `${entry.kind}:${entry.amount}`).join(", ");
      // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
      console.log(`  ledger rows for render: ${kinds}`);
      assert(
        kinds.includes("reserve:-") && kinds.includes("refund:"),
        "ledger has reserve + refund rows for the render",
      );
      const output = await storage.driver.read(row.objectKey ?? "");
      assert(output === null, "no output object on the failed path (honest)");
    } else if (outcome.outcome === "completed") {
      const output = await storage.driver.read(outcome.objectKey);
      assert(output !== null && output.length > 0, "output object stored under the §9.2 key");
      expectedBalance -= outcome.costUc;
      assert(
        (await repos.ledger.balance(workspaceId)) === expectedBalance,
        "settle committed the ACTUAL cost (D-20)",
      );
    } else {
      throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
    }
  }

  // ── PHASE 3 — the long-lived loop: startWorker + graceful stop ────────────
  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log("\n[Phase 3] startWorker loop: claims, terminal-fails, stops cleanly");
  {
    const seededD = await seedProject(true); // CLI missing → RENDER_CLI_MISSING
    const seededE = await seedProject(false); // asset bytes absent → RENDER_ASSET_MISSING
    const d = await queueRender(seededD);
    const e = await queueRender(seededE);

    const handle = await startWorker(deps);
    await waitFor(
      "both queued rows reach a terminal state",
      async () => {
        const rowD = await repos.renders.get(workspaceId, d.render.id);
        const rowE = await repos.renders.get(workspaceId, e.render.id);
        return (
          (rowD.status === "failed" || rowD.status === "completed") &&
          (rowE.status === "failed" || rowE.status === "completed")
        );
      },
      20_000,
    );
    await handle.stop();

    const rowD = await repos.renders.get(workspaceId, d.render.id);
    const rowE = await repos.renders.get(workspaceId, e.render.id);
    if (cliPresent) {
      assert(rowD.status === "completed", "worker loop completes a render when the CLI exists");
    } else {
      assert(
        rowD.status === "failed" && rowD.errorCode === "RENDER_CLI_MISSING",
        "worker loop → honest RENDER_CLI_MISSING",
      );
    }
    assert(
      rowE.status === "failed" && rowE.errorCode === "RENDER_ASSET_MISSING",
      "missing asset fails typed BEFORE spawn (hydrate pre-validation)",
    );
    // D's settle (if the CLI ran) is the only balance delta; E refunds fully.
    const pageD = await repos.ledger.list(workspaceId, { renderId: d.render.id });
    for (const entry of pageD.items) {
      if (entry.kind === "commit") expectedBalance += entry.amount; // negative
    }
    assert(
      (await repos.ledger.balance(workspaceId)) === expectedBalance,
      `both loop jobs settled/refunded honestly (balance ${expectedBalance})`,
    );
  }

  // ── Hygiene: no leaked render workdirs, throwaway files removed ──────────
  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log("\n[Hygiene]");
  {
    const entries = (
      await import("node:fs/promises").then((fs) =>
        fs.readdir(join(REPO, ".local", "render-jobs")).catch(() => [] as string[]),
      )
    ).filter((name) => name.includes("rdr_"));
    assert(entries.length === 0, `no leaked render workdirs (found ${entries.length})`);
  }

  const sqliteClient = (db as unknown as { $client: { close(): void } }).$client;
  sqliteClient.close();
  rmSync(scratchParent, { recursive: true, force: true });
  for (const suffix of ["", "-shm", "-wal"]) rmSync(`${SMOKE_DB}${suffix}`, { force: true });

  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.log(
    `\nW5-10 SMOKE PASS — sqlite pipeline verified (CLI ${
      cliPresent ? "PRESENT — full success path" : "ABSENT — honest degrade path"
    }).`,
  );
}

main().catch((error: unknown) => {
  // biome-ignore lint/suspicious/noConsole: CLI smoke script — console progress/results are its interface
  console.error("W5-10 SMOKE FAIL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
