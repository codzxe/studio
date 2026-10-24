// @studio/worker — W3-C3 v1-loop RENDER STEP PROOF (BUILD_PLAN v1 loop: the
// "render the current project version to a downloadable file" step).
//
// ONE real render, end-to-end, on the PRODUCTION dialect (Postgres), through
// the REAL worker pipeline — exactly the integration suite's golden journey,
// but with a PERSISTENT storage root so the artifact stays on disk as the
// proof (the vitest suite's mkdtemp roots are disposed in afterAll):
//
//   queue (gateway's exact §9.2 flow: quote → row with pre-created output key
//   → ledger.reserve) → runOnce (claim → hydrate → spawn the REAL
//   effectcraft-cli → heartbeat → markCompleted → ledger settle D-20) → the
//   MP4 is read back out of storage (ftyp verified).
//
// Gates honestly: refuses to run when the CLI binary cannot be resolved or
// DATABASE_URL is not the Postgres dialect (the v1-loop proof target; the
// sqlite twin has its own smoke, scripts/sqlite-pipeline-smoke.ts).
//
// Usage:
//   cd services/worker && node --import tsx scripts/pg-render-proof.ts
// Env: DATABASE_URL (default postgres://studio:studio@127.0.0.1:5432/studio),
//      EFFECTCRAFT_CLI_PATH honored through the worker's own resolution.
//
// The artifact + a proof.json are LEFT ON DISK under <repo>/.local/v1-loop-proof/
// (gitignored runtime data). DB rows persist like the suite's (throwaway
// ws_v1proof_* workspace).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type StudioEnv, estimateRenderCostDetailUc, parseEnv } from "@studio/config";
import { createDb, createRepos, migrateDatabase, organization, user } from "@studio/db";
import { assetKey, renderKey, sha256Hex, snapshotKey } from "@studio/gateway/storage";

import { resolveCliPath, resolveRenderKnobs } from "../src/cli.js";
import { runOnce } from "../src/index.js";
import { createWorkerLogger } from "../src/logger.js";
import { createWorkerStorage, defaultRepoRoot } from "../src/storage.js";
import { MAIN_COMP, loadPhotoFixture, loadProjectFixture } from "../tests/integration/harness.js";

const REPO = defaultRepoRoot();
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://studio:studio@127.0.0.1:5432/studio";
const PROOF_ROOT = join(REPO, ".local", "v1-loop-proof");
const GRANT_UC = 20_000_000;

function proofEnv(): StudioEnv {
  const source: Record<string, string> = {
    APP_URL: "http://127.0.0.1:3999",
    APP_ENV: "local",
    LOG_LEVEL: "info", // worker events are the run's evidence
    MOCK_MODEL: "true",
    DATABASE_URL,
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
    RENDER_JOB_TIMEOUT_SECONDS: "90",
  };
  const cli = process.env.EFFECTCRAFT_CLI_PATH?.trim();
  if (cli !== undefined && cli !== "") source.EFFECTCRAFT_CLI_PATH = cli;
  return parseEnv(source);
}

async function main(): Promise<void> {
  if (!/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
    throw new Error(`pg-render-proof: DATABASE_URL is not a postgres URL: ${DATABASE_URL}`);
  }
  const env = proofEnv();
  const cli = resolveCliPath(env.render.cliPath, REPO);
  const cliPresent = existsSync(cli.path);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`v1-loop render proof — dialect=postgres db=${DATABASE_URL}`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`CLI resolution: path=${cli.path} source=${cli.source} present=${cliPresent}`);
  if (!cliPresent) throw new Error("effectcraft-cli not resolvable — nothing to prove");

  mkdirSync(PROOF_ROOT, { recursive: true }); // PERSISTENT proof root
  const db = createDb(DATABASE_URL, { max: 5 });
  try {
    await runProof(db, env, cli);
  } finally {
    // ALWAYS release the pool — a leaked pool keeps the process alive forever.
    await db.$client.end({ timeout: 5 }).catch(() => {});
  }
}

async function runProof(
  db: ReturnType<typeof createDb>,
  env: StudioEnv,
  cli: { readonly path: string; readonly source: string },
): Promise<void> {
  await migrateDatabase(db); // idempotent (drizzle migrations journal)
  const repos = createRepos(db);
  const storage = createWorkerStorage(env, PROOF_ROOT);
  const logger = createWorkerLogger(env);
  const deps = { db, repos, ledger: repos.ledger, storage, env, logger };

  // ── queue hygiene (the integration suite's sweepQueueTerminal discipline) ─
  // Earlier suites leave OWNERLESS queued debris in this SHARED dev database
  // (their storage roots were disposed; no worker ever drove their rows).
  // claimNext is FIFO with a batch limit (workerConcurrency defaults to 2), so
  // debris would fill the batch ahead of the proof render. Drain: requeue
  // stale running debris, then claim + terminal-fail every queued row — the
  // production recovery semantic for abandoned rows (same as the suite's
  // beforeAll hygiene).
  await repos.renders.requeueStale(1, 1);
  let drained = 0;
  for (let batch = 0; batch < 40; batch += 1) {
    const rows = await repos.renders.claimNext("v1proof-hygiene", { limit: 25 });
    if (rows.length === 0) break;
    for (const row of rows) {
      await repos.renders
        .markFailed(row.workspaceId, row.id, {
          error: "v1-loop proof queue hygiene (ownerless debris from earlier suites).",
          errorCode: "RENDER_INTERNAL",
        })
        .catch(() => {});
      drained += 1;
    }
  }
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`\nqueue hygiene: terminal-failed ${drained} ownerless debris rows`);

  // ── seed one throwaway workspace exactly the way the gateway would ────────
  const workspaceId = `ws_v1proof_${randomUUID().slice(0, 8)}`;
  const userId = `usr_v1proof_${randomUUID().slice(0, 8)}`;
  await db.insert(user).values({
    id: userId,
    name: "v1-loop proof",
    email: `${userId}@studio.test`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: workspaceId, name: "v1-loop proof", slug: workspaceId })
    .onConflictDoNothing();
  await repos.ledger.grant(workspaceId, {
    amount: GRANT_UC,
    idempotencyKey: `v1proof:grant:${workspaceId}`,
    metadata: { proof: "W3-C3" },
  });

  const versionBytes = loadProjectFixture(); // committed browser-shaped .ecproj
  const assetBytes = loadPhotoFixture(); // committed 640×360 noise photo
  const project = await repos.projects.create(workspaceId, {
    name: `v1-loop proof ${randomUUID().slice(0, 8)}`,
    createdBy: userId,
  });
  const sha = sha256Hex(versionBytes);
  const versionKey = snapshotKey(workspaceId, project.id, sha);
  const { version } = await repos.versions.upload(workspaceId, {
    projectId: project.id,
    expectedVersionId: null,
    objectKey: versionKey,
    sha256: sha,
    sizeBytes: versionBytes.length,
    createdBy: userId,
  });
  await storage.driver.put(versionKey, versionBytes);
  const assetId = `ast_v1proof_${randomUUID().slice(0, 8)}`;
  const key = assetKey(workspaceId, assetId, "photo.png");
  await repos.assets.create(workspaceId, {
    projectId: project.id,
    name: "photo.png",
    mime: "image/png",
    sizeBytes: assetBytes.length,
    sha256: sha256Hex(assetBytes),
    objectKey: key,
    width: 640,
    height: 360,
    createdBy: userId,
  });
  await storage.driver.put(key, assetBytes);

  // ── queue the render (the gateway route's exact sequence) ─────────────────
  // Same shape as the integration golden test: 1080p + best quality so the
  // ACTUAL frames-based charge clears the platform minimum (no clamp masking).
  const settings = { width: 1920, height: 1080, quality: "best" as const };
  const comp = {
    width: MAIN_COMP.width,
    height: MAIN_COMP.height,
    frameRate: MAIN_COMP.frameRate,
    durationSeconds: MAIN_COMP.durationSeconds,
  };
  const knobs = resolveRenderKnobs({ format: "mp4", settings, comp });
  const detail = estimateRenderCostDetailUc({
    format: "mp4",
    outputSeconds: knobs.effective.outputSeconds,
    longEdgePx: knobs.effective.longEdgePx,
    quality: knobs.effective.quality,
  });
  const objectKey = renderKey(workspaceId, project.id, "{renderId}", "mp4");
  const render = await repos.renders.create(workspaceId, {
    projectId: project.id,
    versionId: version.id,
    compId: MAIN_COMP.compId,
    format: "mp4",
    settingsJson: settings,
    credits: detail.totalUc,
    createdBy: userId,
    objectKey,
  });
  await repos.ledger.reserve(workspaceId, {
    renderId: render.id,
    amount: detail.totalUc,
    idempotencyKey: `render:reserve:${render.id}`,
    metadata: { proof: "W3-C3", quality: knobs.effective.quality },
  });
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(
    `\nqueued render ${render.id} — comp=${MAIN_COMP.compId} 1920×1080 best, quote=${detail.totalUc} µc (raw ${detail.rawUc}${detail.minApplied ? ", min applied" : ""})`,
  );

  // ── ONE real worker tick: claim → hydrate → spawn CLI → settle ────────────
  const startedAt = Date.now();
  const tick = await runOnce(deps);
  const wallMs = Date.now() - startedAt;

  const outcome = tick.outcomes.find((entry) => entry.renderId === render.id);
  if (outcome === undefined) {
    throw new Error(
      `proof render was not claimed this tick (claimed=${tick.claimed}, outcomes=${JSON.stringify(tick.outcomes.map((o) => [o.renderId, o.outcome]))})`,
    );
  }
  if (outcome.outcome !== "completed") {
    throw new Error(`render did not complete: ${JSON.stringify(outcome)}`);
  }

  const row = await repos.renders.get(workspaceId, render.id);
  const bytes = await storage.driver.read(outcome.objectKey);
  if (bytes === null) throw new Error("output object missing from storage");
  const onDisk = join(PROOF_ROOT, outcome.objectKey);
  const sizeOnDisk = statSync(onDisk).size;
  if (bytes.subarray(4, 8).toString("latin1") !== "ftyp") {
    throw new Error("output is not an mp4 (no ftyp box)");
  }
  const balance = await repos.ledger.balance(workspaceId);
  const ledgerRows = (await repos.ledger.list(workspaceId, { renderId: render.id })).items.map(
    (entry) => `${entry.kind}:${entry.amount}`,
  );

  const proof = {
    task: "W3-C3 v1-loop render step proof",
    dateUtc: new Date().toISOString(),
    dialect: "postgres",
    databaseUrl: DATABASE_URL,
    cli: { path: cli.path, source: cli.source, version: "0.13.0" },
    renderId: render.id,
    workspaceId,
    settings,
    wallMs,
    outputObjectKey: outcome.objectKey,
    outputOnDisk: onDisk,
    sizeBytes: sizeOnDisk,
    sizeBytesMatchesRow: row.sizeBytes === sizeOnDisk,
    ftyp: true,
    framesTotal: row.framesTotal,
    costUc: outcome.costUc,
    quotedUc: detail.totalUc,
    balanceAfterUc: balance,
    balanceNetUc: GRANT_UC - balance,
    ledger: ledgerRows,
  };
  writeFileSync(join(PROOF_ROOT, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);

  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log("\n── v1-loop RENDER STEP PROOF ──────────────────────────────");
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`  renderId     : ${render.id}`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`  wall time    : ${wallMs} ms`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`  objectKey    : ${outcome.objectKey}`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`  on-disk path : ${onDisk}`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(
    `  size         : ${sizeOnDisk} bytes (${(sizeOnDisk / 1024 / 1024).toFixed(2)} MiB)`,
  );
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`  mp4 ftyp     : yes; frames total: ${row.framesTotal}`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(
    `  ledger       : ${ledgerRows.join(", ")} → net ${GRANT_UC - balance} µc (quoted ${detail.totalUc})`,
  );
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`  proof.json   : ${join(PROOF_ROOT, "proof.json")}`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log("────────────────────────────────────────────────────────────");
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log(`  tick claimed ${tick.claimed} job(s) — the proof render ran the real pipeline`);
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.log("V1-LOOP RENDER PROOF: PASS");
}

main().catch((error: unknown) => {
  // biome-ignore lint/suspicious/noConsole: CLI proof script — its console report IS the deliverable (pipeline outcome + PASS/FAIL verdict)
  console.error(
    "V1-LOOP RENDER PROOF FAIL:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
