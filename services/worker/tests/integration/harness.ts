// @studio/worker — CLI-gated integration harness (BUILD_PLAN §M8 task 5).
//
// Shared test infrastructure for tests/integration/render-pipeline.test.ts.
// Builds the REAL WorkerDeps the production worker process gets:
//   - a real Postgres `createDb` with migrations applied (same discipline as
//     packages/db/tests/integration — createWorld runs migrateDatabase once),
//   - the real repo bundle (createRepos) incl. the render-scoped ledger,
//   - the worker's OWN storage module (createWorkerStorage → the gateway's
//     LocalFS driver under an isolated `.local/worker-it/` root, gitignored),
//   - a typed env from @studio/config parseEnv (the gateway test env source,
//     plus the `render` group overrides each test needs).
//
// Fixture discipline (mirrors the db integration suite): every test seeds a
// THROWAWAY workspace (unique organization id per run) with its own user /
// project / pinned version / asset rows, writes the version + asset bytes
// through the same §9.2 keys the gateway would use, and never touches another
// test's rows. A beforeAll hygiene sweep terminal-fails queue debris from
// aborted earlier runs so global queue operations (claimNext / requeueStale)
// see only this suite's rows.
//
// Gates: the suite only runs when BOTH (a) DATABASE_URL is a postgres URL and
// (b) the effectcraft-cli binary resolves (env → repo build → PATH). The test
// file encodes the skip reason in the describe title.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type StudioEnv, estimateRenderCostDetailUc, parseEnv } from "@studio/config";
import {
  type Render,
  type Repos,
  type StudioDb,
  createDb,
  createRepos,
  migrateDatabase,
  organization,
  user,
} from "@studio/db";
import {
  type StorageChoice,
  assetKey,
  renderKey,
  sha256Hex,
  snapshotKey,
} from "@studio/gateway/storage";

import { resolveRenderKnobs } from "../../src/cli.js";
import type { ScopedRenderRow, WorkerDeps, WorkerLogFields, WorkerLogger } from "../../src/deps.js";
import { type CompFacts, scratchRoot } from "../../src/hydrate.js";
import { createWorkerStorage, defaultRepoRoot } from "../../src/storage.js";

// ───────────────────────────────────────────────────────────────────────────
// Gates
// ───────────────────────────────────────────────────────────────────────────

/** DB gate — same regex as the packages/db integration suites. */
export function hasPostgres(): boolean {
  return /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");
}

export interface ResolvedTestCli {
  readonly path: string;
  readonly source: "env" | "repo-build" | "path";
}

/**
 * CLI gate — the worker's own resolution order (spike §1): EFFECTCRAFT_CLI_PATH
 * → <repo>/editor/target/release/effectcraft-cli → PATH lookup. Returns null
 * when the binary cannot be found (suite skips with a written reason).
 */
export function resolveTestCli(): ResolvedTestCli | null {
  const fromEnv = process.env.EFFECTCRAFT_CLI_PATH?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return existsSync(fromEnv) ? { path: fromEnv, source: "env" } : null;
  }
  const repoBuild = join(defaultRepoRoot(), "editor", "target", "release", "effectcraft-cli");
  if (existsSync(repoBuild)) {
    return { path: repoBuild, source: "repo-build" };
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "effectcraft-cli");
    if (existsSync(candidate)) {
      return { path: candidate, source: "path" };
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Env (the gateway test env source + the render group)
// ───────────────────────────────────────────────────────────────────────────

export type HarnessEnvOverrides = Readonly<Record<string, string | undefined>>;

/**
 * A complete, test-safe env source — the gateway integration helper's proven
 * set (APP_ENV=local so storage uses the LocalFS driver), plus the `render`
 * group passthrough/overrides the worker reads (EFFECTCRAFT_CLI_PATH,
 * RENDER_*).
 */
export function harnessEnvSource(overrides: HarnessEnvOverrides = {}): Record<string, string> {
  const base: Record<string, string> = {
    APP_URL: "http://127.0.0.1:3999",
    APP_ENV: "local",
    LOG_LEVEL: "error",
    MOCK_MODEL: "true",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://studio:studio@127.0.0.1:5432/studio",
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
    // Blank = unset (config's blank-unset rule) → repo-build / PATH resolution.
    EFFECTCRAFT_CLI_PATH: process.env.EFFECTCRAFT_CLI_PATH ?? "",
  };
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined || value === "") continue;
    source[key] = value;
  }
  return source;
}

/** Parsed typed env — a FRESH parse per call (no getEnv caching in tests). */
export function harnessEnv(overrides: HarnessEnvOverrides = {}): StudioEnv {
  return parseEnv(harnessEnvSource(overrides));
}

// ───────────────────────────────────────────────────────────────────────────
// Fixtures (tests/fixtures — generated ONCE from the real CLI, committed)
// ───────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/**
 * The `Main` comp of tests/fixtures/project.ecproj: 640×360, 30 fps, 2.0 s,
 * one photo.png footage layer — small enough for a sub-second render, big
 * enough that the golden wall stays under the §M8 sanity budget.
 */
export const MAIN_COMP: FixtureComp = {
  compId: "Main",
  width: 640,
  height: 360,
  frameRate: 30,
  durationSeconds: 2,
};

/**
 * The `Long` comp: identical size/rate but a 10 s duration. Rendered with
 * {width:1920, height:1080} settings it takes ~40 s wall on this box — the
 * cancel/timeout tests need a job that is still running when they act.
 */
export const LONG_COMP: FixtureComp = {
  compId: "Long",
  width: 640,
  height: 360,
  frameRate: 30,
  durationSeconds: 10,
};

export interface FixtureComp {
  readonly compId: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
}

/** The committed browser-shaped .ecproj (footage path `/photo.png`). */
export function loadProjectFixture(): Buffer {
  return readFileSync(join(FIXTURES_DIR, "project.ecproj"));
}

/** The committed 640×360 noise photo — high-entropy footage so the encoded
 * outputs are big enough for the golden size assertions (>100 KB). */
export function loadPhotoFixture(): Buffer {
  return readFileSync(join(FIXTURES_DIR, "photo.png"));
}

// ───────────────────────────────────────────────────────────────────────────
// Spy logger (asserts "the CLI was NEVER spawned" via the render_spawn event)
// ───────────────────────────────────────────────────────────────────────────

export interface SpyLogEvent {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly fields: WorkerLogFields | undefined;
}

export interface SpyLogger extends WorkerLogger {
  readonly events: readonly SpyLogEvent[];
  count(msg: string): number;
}

export function spyLogger(): SpyLogger {
  const events: SpyLogEvent[] = [];
  const make =
    (level: SpyLogEvent["level"]) =>
    (msg: string, fields?: WorkerLogFields): void => {
      events.push({ level, msg, fields });
    };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    get events() {
      return events;
    },
    count(msg: string): number {
      return events.filter((event) => event.msg === msg).length;
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The world (real db + repos + storage; one per suite run)
// ───────────────────────────────────────────────────────────────────────────

/** Credits granted to every seeded workspace (20 credits — covers every hold). */
export const GRANT_UC = 20_000_000;

export interface WorkerWorld {
  readonly db: StudioDb;
  readonly repos: Repos;
  readonly storage: StorageChoice;
  readonly storageRoot: string;
  readonly userId: string;
  dispose(): Promise<void>;
}

/**
 * Boot the shared world: migrate, repos, the worker's LocalFS storage under an
 * isolated `.local/worker-it/` root and a throwaway user row. Call ONCE per
 * suite (beforeAll); `dispose` ends the pool and removes the storage root.
 */
export async function createWorld(env: StudioEnv): Promise<WorkerWorld> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("createWorld: DATABASE_URL is not set");
  const db = createDb(url, { max: 5 });
  await migrateDatabase(db);
  const repos = createRepos(db);
  const workerItRoot = join(defaultRepoRoot(), ".local", "worker-it");
  mkdirSync(workerItRoot, { recursive: true }); // mkdtemp needs the parent
  const storageRoot = mkdtempSync(join(workerItRoot, "storage-"));
  const storage = createWorkerStorage(env, storageRoot);
  const userId = `usr_m8k_${randomUUID().slice(0, 8)}`;
  await db
    .insert(user)
    .values({ id: userId, name: "M8-K", email: `${userId}@studio.test`, emailVerified: true })
    .onConflictDoNothing();
  return {
    db,
    repos,
    storage,
    storageRoot,
    userId,
    dispose: async () => {
      rmSync(storageRoot, { recursive: true, force: true });
      await db.$client.end({ timeout: 5 });
    },
  };
}

/**
 * Queue hygiene (the db integration suite's determinism sweep, terminal
 * variant): aborted earlier runs may leave queued/running debris; the global
 * claim/sweep surface must see only this suite's rows. requeueStale(1,1)
 * terminal-fails stale running debris, the drain claims every still-queued
 * row and terminal-fails it too (running → failed is legal; these rows have
 * no owner — aborted runs — so this is the production recovery semantic).
 */
export async function sweepQueueTerminal(repos: Repos): Promise<void> {
  await repos.renders.requeueStale(1, 1);
  for (let batch = 0; batch < 25; batch += 1) {
    const rows: ScopedRenderRow[] = await repos.renders.claimNext("m8k-hygiene", { limit: 25 });
    if (rows.length === 0) break;
    for (const row of rows) {
      await repos.renders
        .markFailed(row.workspaceId, row.id, {
          error: "Integration suite queue hygiene (stale debris).",
          errorCode: "RENDER_INTERNAL",
        })
        .catch(() => {});
    }
  }
}

/**
 * Build the real WorkerDeps for one test: the shared world's db/repos/ledger/
 * storage, the per-test env (render-group overrides) and a per-test spy logger
 * (default: a silent one, so suites stay quiet).
 */
export function makeDeps(
  world: WorkerWorld,
  env: StudioEnv,
  logger: WorkerLogger = spyLogger(),
): WorkerDeps {
  return {
    db: world.db,
    repos: world.repos,
    ledger: world.repos.ledger,
    storage: world.storage,
    env,
    logger,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-test fixture seeding (throwaway workspace per call)
// ───────────────────────────────────────────────────────────────────────────

export interface SeedOptions {
  /** The .ecproj bytes to pin (the fixture, or garbage for the malformed test). */
  readonly versionBytes: Buffer;
  /** Photo bytes to store under the asset key; null = NEVER stored (missing-asset test). */
  readonly assetBytes: Buffer | null;
}

export interface SeededProject {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/**
 * Seed one throwaway workspace: organization + granted credits + user's project
 * + a pinned version (bytes written through the §9.2 snapshot key) + one
 * photo.png asset (bytes through the §9.2 asset key, unless deliberately
 * absent). Mirrors exactly what the gateway would have persisted.
 */
export async function seedWorkspace(
  world: WorkerWorld,
  options: SeedOptions,
): Promise<SeededProject> {
  const { repos } = world;
  const workspaceId = `ws_m8k_${randomUUID().slice(0, 8)}`;
  const db = world.db;
  await db
    .insert(organization)
    .values({ id: workspaceId, name: "M8-K IT", slug: workspaceId })
    .onConflictDoNothing();

  await repos.ledger.grant(workspaceId, {
    amount: GRANT_UC,
    idempotencyKey: `m8k:grant:${workspaceId}`,
    metadata: { suite: "worker-integration" },
  });

  const project = await repos.projects.create(workspaceId, {
    name: `Render IT ${randomUUID().slice(0, 8)}`,
    createdBy: world.userId,
  });

  const sha = sha256Hex(options.versionBytes);
  const versionKey = snapshotKey(workspaceId, project.id, sha);
  const { version } = await repos.versions.upload(workspaceId, {
    projectId: project.id,
    expectedVersionId: null,
    objectKey: versionKey,
    sha256: sha,
    sizeBytes: options.versionBytes.length,
    createdBy: world.userId,
  });
  await world.storage.driver.put(versionKey, options.versionBytes);

  const assetId = `ast_m8k_${randomUUID().slice(0, 8)}`;
  const key = assetKey(workspaceId, assetId, "photo.png");
  await repos.assets.create(workspaceId, {
    projectId: project.id,
    name: "photo.png",
    mime: "image/png",
    sizeBytes: options.assetBytes?.length ?? 0,
    sha256:
      options.assetBytes === null ? sha256Hex(Buffer.alloc(0)) : sha256Hex(options.assetBytes),
    objectKey: key,
    width: 640,
    height: 360,
    createdBy: world.userId,
  });
  if (options.assetBytes !== null) {
    await world.storage.driver.put(key, options.assetBytes);
  }

  return { workspaceId, projectId: project.id, versionId: version.id };
}

// ───────────────────────────────────────────────────────────────────────────
// Queue a render exactly the way the gateway route does
// ───────────────────────────────────────────────────────────────────────────

/** The render-relevant settings subset (RENDER_SETTINGS_SCHEMA fields). */
export type QueueSettings = {
  readonly timeFrom?: number;
  readonly timeTo?: number;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly quality?: "draft" | "good" | "best";
};

export interface QueuedRender {
  readonly render: Render;
  readonly workspaceId: string;
  /** The quote the harness reserved at queue time (the gateway's exact flow). */
  readonly estimateUc: number;
  readonly outputSeconds: number;
  readonly longEdgePx: number;
}

/**
 * Queue + reserve one render row — the M8-G queue route's exact sequence:
 * derive the quote via the worker's own knob resolution (same formula
 * inputs as the gateway), create the row with the `{renderId}` placeholder
 * §9.2 key, then ledger.reserve with `render:reserve:<id>`.
 */
export async function queueRender(args: {
  readonly world: WorkerWorld;
  readonly seeded: SeededProject;
  readonly comp: FixtureComp;
  readonly format: "mp4" | "png-seq";
  readonly settings?: QueueSettings;
}): Promise<QueuedRender> {
  const comp: CompFacts = {
    width: args.comp.width,
    height: args.comp.height,
    frameRate: args.comp.frameRate,
    durationSeconds: args.comp.durationSeconds,
  };
  const knobs = resolveRenderKnobs({
    format: args.format,
    settings: args.settings ?? {},
    comp,
  });
  const detail = estimateRenderCostDetailUc({
    format: args.format,
    outputSeconds: knobs.effective.outputSeconds,
    longEdgePx: knobs.effective.longEdgePx,
    quality: knobs.effective.quality,
  });
  const objectKey = renderKey(
    args.seeded.workspaceId,
    args.seeded.projectId,
    "{renderId}",
    args.format === "png-seq" ? "zip" : "mp4",
  );
  const render = await args.world.repos.renders.create(args.seeded.workspaceId, {
    projectId: args.seeded.projectId,
    versionId: args.seeded.versionId,
    compId: args.comp.compId,
    format: args.format,
    settingsJson: args.settings ?? {},
    credits: detail.totalUc,
    createdBy: args.world.userId,
    objectKey,
  });
  await args.world.repos.ledger.reserve(args.seeded.workspaceId, {
    renderId: render.id,
    amount: detail.totalUc,
    idempotencyKey: `render:reserve:${render.id}`,
    metadata: {
      versionId: args.seeded.versionId,
      format: args.format,
      outputSeconds: knobs.effective.outputSeconds,
      longEdgePx: knobs.effective.longEdgePx,
      quality: knobs.effective.quality,
    },
  });
  return {
    render,
    workspaceId: args.seeded.workspaceId,
    estimateUc: detail.totalUc,
    outputSeconds: knobs.effective.outputSeconds,
    longEdgePx: knobs.effective.longEdgePx,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Small assert helpers
// ───────────────────────────────────────────────────────────────────────────

/** Bounded poll: probe every `stepMs` until it returns non-null or the
 * deadline hits — then fail with the label (a hung CLI never hangs CI). */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null>,
  options: { readonly deadlineMs: number; readonly stepMs?: number },
): Promise<T> {
  const stepMs = options.stepMs ?? 250;
  const deadlineAt = Date.now() + options.deadlineMs;
  for (;;) {
    const found = await probe();
    if (found !== null) return found;
    if (Date.now() + stepMs >= deadlineAt) {
      throw new Error(`waitFor: ${label} did not happen within ${options.deadlineMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Read a render output back from the shared storage (LocalFS is authoritative). */
export async function readOutput(world: WorkerWorld, objectKey: string): Promise<Buffer | null> {
  return world.storage.driver.read(objectKey);
}

/**
 * Current render workdirs under the worker's scratch root
 * (`<repo>/.local/render-jobs`) — the leak regression check: a job that fails
 * INSIDE hydration must still clean up its confined dir.
 */
export async function scratchEntries(): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(scratchRoot(defaultRepoRoot())).catch(() => []);
  return entries.filter((name) => name.includes("rdr_"));
}

/** The ledger rows scoped to one render (newest first). */
export async function renderLedger(
  world: WorkerWorld,
  workspaceId: string,
  renderId: string,
): Promise<readonly { idempotencyKey: string; kind: string; amount: number }[]> {
  const page = await world.repos.ledger.list(workspaceId, { renderId });
  return page.items.map((entry) => ({
    idempotencyKey: entry.idempotencyKey,
    kind: entry.kind,
    amount: entry.amount,
  }));
}

/** Workspace balance (integer µc) — the net-effect assertion input. */
export async function balanceOf(world: WorkerWorld, workspaceId: string): Promise<number> {
  return world.repos.ledger.balance(workspaceId);
}
