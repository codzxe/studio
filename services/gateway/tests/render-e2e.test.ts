// M8-L — the M8 RENDER EXIT-CRITERIA proof at the JOURNEY level (BUILD_PLAN
// §M8): the REAL gateway app + REAL Postgres + the REAL worker
// (services/worker, driven IN-PROCESS) + the REAL studio-cli binary.
//
// EXIT-CRITERIA SCORECARD (criterion → the journey that proves it):
//   * "A user can render a project and download a playable file."
//       → journey 1 (estimate identity → queue → server-pinned version →
//         µc reserve → one real worker tick → real CLI render → signed
//         download: ftyp signature + real size) and journey 4 (the png-seq
//         half: ZIP magic + one entry per rendered frame).
//   * "Job survives worker restart; no duplicate outputs on retry."
//       → the API-visible half in journey 1 (re-queue with the SAME
//         Idempotency-Key replays the SAME row — no duplicate job; the
//         §9.2 output key is pre-created at QUEUE time so a retry attempt
//         can only ever overwrite the same object). The worker-restart half
//         is M8-K's repo-level proof (services/worker/tests/integration).
//   * "Credits are charged only for completed renders."
//       → journey 1's ledger (reserve −N, commit −N, refund +N ⇒ the render
//         nets EXACTLY −N, D-20, where N is the single estimateRenderCostUc
//         integer), journey 2 (cancel → FULL refund, balance restored to
//         the pre-reserve integer exactly), journey 3 (every entitlement
//         gate refuses BEFORE any row or ledger write).
//
// GATES (both documented, both required — the file skips without them,
// reason in every describe title, W4-GWI):
//   1. DATABASE_URL must resolve to the POSTGRES dialect (helpers'
//      HAS_POSTGRES): the sqlite dev twin does not carry FOR UPDATE SKIP
//      LOCKED, which this file's surgical claim needs.
//   2. The real CLI binary must exist at
//      <repo>/editor/target/release/studio-cli (the spike §1
//      repo-build resolution order; never committed — CI rebuilds it).
//
// FIXTURE RECIPE (spike §4, CLI-validated on this box):
//   * The uploaded VERSION is a hand-authored minimal VALID .ecproj in the
//     real browser-saved shape: `items{"1": Footage, "2": Comp}` where the
//     Footage path is the BROWSER-VIRTUAL leading-slash form ("/noise.png")
//     and the Comp carries one Footage LAYER (masks/effects/transform prop
//     groups, full 14-field switches, blend Normal, anchor/position at the
//     comp center). Verified against the real binary: `info --json` opens
//     it and `render` draws the footage (the same project with the file
//     absent renders the missing-placeholder — the spike §4 A/B proof).
//   * The ASSET bytes are a deterministic seeded-noise PNG generated
//     in-file (zlib IDAT + hand CRC-32, node:zlib deflate): a blank comp
//     renders a 3.7 KB placeholder-sized mp4 — under the playable-file bar
//     — while the 640×360 noise fixture renders a ~470 KB mp4, so the
//     download assertions prove REAL rendered footage, not placeholders.
//   * Journey 2's cancel fixture is the same recipe at 1920×1080 × 10 s —
//     measured ~33 s of real render time on this box: plenty of margin to
//     cancel a running job and prove the cooperative kill + full refund.
//
// WORKER-DRIVING RECIPE (for future E2E waves):
//   * ONE real `bootServer()` per file (house rule). Build the worker's
//     deps IN-PROCESS: `createDb/createRepos` on the SAME DATABASE_URL the
//     app uses, `storage` = the SERVER's own driver instance wrapped as a
//     StorageChoice (`{ driver: server.deps.storage, local:
//     server.deps.local }`) so §9.2 keys and signed-token registries are
//     the SAME objects, `env` via the helpers' testEnv, `nullLogger`.
//   * `runOnce(deps)` = the deterministic tick (claims + renders + settles
//     to completion synchronously) — journeys 1/4/5. `startWorker(deps)`
//     = the real claim loop with RENDER_POLL_INTERVAL_MS=100 — journey 2.
//   * SURGICAL CLAIM: the repo's `claimNext` is GLOBAL and workspace-free
//     BY CONTRACT (the worker owns every workspace). In the shared
//     parallel test database that FIFO would steal other suites' queued
//     rows (and theirs would steal this file's), so the harness claim is
//     the repo's own transactional SQL (FOR UPDATE SKIP LOCKED + the
//     running/started_at/heartbeat_at/attempts stamps — the exact
//     claimNext update) with one added `id IN (this file's queued ids)`
//     filter, and the global sweeps (requeueStale/listExpiredOutputs) are
//     inerted. The repo-level claim/sweep mechanics themselves are pinned
//     by packages/db's integration suite (M8-A) — this journey proves the
//     END-TO-END path and never disturbs a foreign suite's rows.
//   * The worker scratch dir is `<repo>/.local/render-jobs/<renderId>-*`
//     (gitignored); every journey's row is terminal before the file ends
//     and afterAll refunds any outstanding hold (no queued debris left).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type StudioEnv, estimateRenderCostUc } from "@studio/config";
import {
  type EstimateResult,
  RENDER_STATUSES,
  RENDER_STATUS_SCHEMA,
  type RenderJob,
} from "@studio/contracts";
import {
  type Repos,
  type StudioDb,
  createDb,
  createRepos,
  projects as projectsTable,
  renders as rendersTable,
} from "@studio/db";

import type { LocalFSDriver, StorageDriver } from "../src/storage.js";

import {
  CookieJar,
  DATABASE_URL,
  HAS_POSTGRES,
  type RunningTestServer,
  api,
  bootServer,
  closeDb,
  testEnv,
  unique,
  uniqueEmail,
} from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// The worker's exported surface, as a structural view
// ───────────────────────────────────────────────────────────────────────────

/** The worker's ScopedRenderRow — derived from the SAME repo type it is. */
type ScopedRenderRow = Awaited<ReturnType<Repos["renders"]["claimNext"]>>[number];

type WorkerLogger = {
  debug(msg: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  info(msg: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  warn(msg: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  error(msg: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
};

/** The worker's StorageChoice — same env, same driver, same §9.2 keys. */
interface StorageChoice {
  readonly driver: StorageDriver;
  readonly local: LocalFSDriver | null;
}

/** The worker's WorkerDeps (services/worker/src/deps.ts, mirrored). */
interface WorkerDeps {
  readonly db: StudioDb;
  readonly repos: Repos;
  readonly ledger: Repos["ledger"];
  readonly storage: StorageChoice;
  readonly env: StudioEnv;
  readonly logger: WorkerLogger;
  readonly signal?: AbortSignal | undefined;
}

type RenderJobOutcome =
  | {
      readonly renderId: string;
      readonly outcome: "completed";
      readonly objectKey: string;
      readonly sizeBytes: number;
      readonly costUc: number;
      readonly alreadyDone: boolean;
    }
  | { readonly renderId: string; readonly outcome: "failed"; readonly errorCode: string }
  | { readonly renderId: string; readonly outcome: "cancelled" }
  | { readonly renderId: string; readonly outcome: "lost" };

interface TickResult {
  readonly claimed: number;
  readonly outcomes: readonly RenderJobOutcome[];
  readonly swept: { readonly requeuedOrFailed: number; readonly outputsExpired: number };
}

interface WorkerHandle {
  readonly workerId: string;
  stop(): Promise<void>;
  readonly stopped: Promise<void>;
}

interface WorkerModule {
  runOnce(deps: WorkerDeps): Promise<TickResult>;
  startWorker(deps: WorkerDeps): Promise<WorkerHandle>;
  readonly nullLogger: WorkerLogger;
}

// The worker is loaded as SOURCE through a RELATIVE path, NOT a package
// devDependency: worker -> @studio/gateway (for the storage seam) is the ONE
// legal edge; a gateway -> worker devDep would close a cycle turbo refuses
// to plan (gateway#build <-> worker#build). Its @studio/editor-bridge
// dependency is authored extensionless (Bundler-style — see the worker's
// own tsconfig). vitest's bundler resolution loads it perfectly at RUNTIME,
// but the gateway's NodeNext typecheck program cannot include those
// sources, so the module is loaded DYNAMICALLY through a query-suffixed
// specifier (a literal tsc cannot resolve; the query is a no-op for vite's
// resolver) and bound to the structural view above — every type in that
// view is derived from the same @studio/db, @studio/config and
// gateway-storage types the worker itself compiles against, so drift breaks
// loudly at the first journey tick.
const loadWorkerModule = async (): Promise<WorkerModule> => {
  // @ts-expect-error TS2307: the worker module is resolved by vitest, not tsc
  return (await import("../../worker/src/index?gateway-render-e2e")) as unknown as WorkerModule;
};

// ───────────────────────────────────────────────────────────────────────────
// Gates: the Postgres dialect + the real CLI binary (reasons in the titles)
// ───────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Spike §1 resolution order, step 2: the repo build (STUDIO_ENGINE_CLI_PATH unset). */
const CLI_PATH = join(REPO_ROOT, "editor", "target", "release", "studio-cli");
const HAS_CLI = existsSync(CLI_PATH);

/**
 * File-level gates (both must hold; the reason rides the describe titles so a
 * skip is never silent — the W4-GWI honest-skip contract):
 *  - Postgres dialect (helpers' HAS_POSTGRES): the surgical claim below is
 *    the repo's own FOR UPDATE SKIP LOCKED transactional SQL and the raw
 *    table builders resolve the canonical pg schema.
 *  - the real CLI binary at <repo>/editor/target/release/studio-cli
 *    (the spike §1 repo-build resolution order; never committed — CI
 *    rebuilds it).
 */
const SKIP_REASON = !HAS_POSTGRES
  ? "requires the Postgres dialect (FOR UPDATE SKIP LOCKED surgical claim + pg-schema table builders)"
  : !HAS_CLI
    ? `studio-cli binary not found at ${CLI_PATH} (repo build; CI rebuilds it)`
    : null;

const TITLE_SUFFIX = SKIP_REASON === null ? "" : ` — SKIPPED: ${SKIP_REASON}`;

/** describe with the file's skip reason appended to every title (never silent). */
function d(name: string, fn: () => void): void {
  const suite = SKIP_REASON === null ? describe : describe.skip;
  suite(`${name}${TITLE_SUFFIX}`, fn);
}

/** 1 credit = 1_000_000 µc (D-12) — grants are RAW ledger µc. */
const MICRO = 1_000_000;

// ───────────────────────────────────────────────────────────────────────────
// The deterministic seeded-noise PNG fixture (real rendered footage)
// ───────────────────────────────────────────────────────────────────────────

/** IEEE CRC-32 (the worker's zip.ts dialect, inlined — no @types gamble). */
const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const row = CRC_TABLE[(crc ^ byte) & 0xff];
    crc = (row ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministic mulberry32 stream — identical bytes on every run. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded full-entropy RGB PNG (8-bit, no interlace). Real rendered
 * footage: a comp drawing this asset encodes to a real-size mp4, never the
 * 3.7 KB placeholder-sized output of an empty comp.
 */
function noisePng(width: number, height: number, seed: number): Buffer {
  const next = seededRandom(seed);
  const stride = 1 + width * 3; // per-scanline filter byte + RGB
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // PNG filter: none
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = Math.floor(next() * 256);
      raw[at + 1] = Math.floor(next() * 256);
      raw[at + 2] = Math.floor(next() * 256);
    }
  }
  const chunk = (tag: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ───────────────────────────────────────────────────────────────────────────
// The browser-shaped .ecproj fixture (spike §4; validated against the CLI)
// ───────────────────────────────────────────────────────────────────────────

/** EffectCraft exact media time: integer ticks at 254 016 000 000/s. */
const TICKS_PER_SECOND = 254_016_000_000;

interface FixtureSpec {
  /** The comp's editor id + display name (queueing pins either). */
  readonly compName: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
}

/**
 * A minimal VALID .ecproj in the browser-saved shape: the Footage item's
 * path is the web editor's single-segment VIRTUAL path (`/<asset-name>` —
 * the web `path_for` keeps only the last path segment), exactly what the
 * hydration recipe strips (spike §4: without the strip the native render
 * draws the missing-placeholder even with the file present).
 *
 * The Comp's required serde fields (validated by `info --json` on the real
 * binary): settings{bit_depth, linearize, time_display, frame_start,
 * audio_sample_rate}, Comp{shutter_angle, shutter_phase,
 * motion_blur_samples} and the full Footage/Layer/PropGroup shapes.
 */
function browserEcproj(assetName: string, spec: FixtureSpec): Buffer {
  const durationTicks = Math.round(spec.durationSeconds * TICKS_PER_SECOND);

  type Prop = {
    uid: number;
    match: string;
    name: string;
    value: { t: string; v: unknown };
    spatial?: boolean;
    shown_dims?: number;
    three_d_only?: boolean;
  };
  const prop = (
    uid: number,
    match: string,
    name: string,
    t: string,
    v: unknown,
    extra?: Partial<Prop>,
  ): Prop => ({
    uid,
    match,
    name,
    value: { t, v },
    ...(extra ?? {}),
  });
  const group = (uid: number, match: string, name: string, children: unknown[]) => ({
    uid,
    match,
    name,
    children,
  });

  // One Footage layer: masks + effects + the standard Transform group
  // (anchor/position at the comp centre → the asset covers the frame).
  const root = group(10, "layer", assetName, [
    {
      node: "Group",
      ...group(11, "masks", "Masks", []),
    },
    {
      node: "Group",
      ...group(12, "effects", "Effects", []),
    },
    {
      node: "Group",
      ...group(20, "transform", "Transform", [
        {
          node: "Prop",
          ...prop(21, "anchor", "Anchor Point", "Vec3", [spec.width / 2, spec.height / 2, 0], {
            spatial: true,
            shown_dims: 2,
          }),
        },
        {
          node: "Prop",
          ...prop(22, "position", "Position", "Vec3", [spec.width / 2, spec.height / 2, 0], {
            spatial: true,
            shown_dims: 2,
          }),
        },
        { node: "Prop", ...prop(23, "scale", "Scale", "Vec3", [100, 100, 100], { shown_dims: 2 }) },
        {
          node: "Prop",
          ...prop(24, "orientation", "Orientation", "Vec3", [0, 0, 0], { three_d_only: true }),
        },
        {
          node: "Prop",
          ...prop(25, "rotationX", "X Rotation", "Scalar", 0, { three_d_only: true }),
        },
        {
          node: "Prop",
          ...prop(26, "rotationY", "Y Rotation", "Scalar", 0, { three_d_only: true }),
        },
        { node: "Prop", ...prop(27, "rotation", "Rotation", "Scalar", 0) },
        { node: "Prop", ...prop(28, "opacity", "Opacity", "Scalar", 100) },
      ]),
    },
  ]);

  const layer = {
    id: 3,
    name: assetName,
    source: { type: "Footage", item: 1 },
    label: "None",
    comment: "",
    start_time: 0,
    in_point: 0,
    out_point: durationTicks,
    stretch: 100.0,
    switches: {
      video: true,
      audio: false,
      solo: false,
      locked: false,
      shy: false,
      collapse: false,
      quality: "Best",
      sampling: "Bilinear",
      effects: true,
      frame_blend: "Off",
      motion_blur: false,
      adjustment: false,
      three_d: false,
      guide: false,
    },
    blend_mode: "Normal",
    auto_orient: "Off",
    props: root,
  };

  const project = {
    schema: 2,
    settings: {
      bit_depth: "Bpc8",
      linearize: false,
      time_display: "Timecode",
      frame_start: 0,
      audio_sample_rate: 48000,
    },
    items: {
      1: {
        id: 1,
        name: assetName,
        label: "None",
        comment: "",
        parent: null,
        kind: {
          type: "Footage",
          path: `/${assetName}`,
          kind: "Still",
          width: spec.width,
          height: spec.height,
          pixel_aspect: 1.0,
          frame_rate: { num: 30, den: 1 },
          duration: 2 * TICKS_PER_SECOND,
          has_video: true,
          has_audio: false,
          alpha: "Straight",
        },
      },
      2: {
        id: 2,
        name: spec.compName,
        label: "None",
        comment: "",
        parent: null,
        kind: {
          type: "Comp",
          width: spec.width,
          height: spec.height,
          pixel_aspect: 1.0,
          frame_rate: { num: spec.fps, den: 1 },
          duration: durationTicks,
          display_start: 0,
          background: [24, 28, 32],
          work_area: [0, durationTicks],
          layers: [layer],
          markers: [],
          shutter_angle: 180.0,
          shutter_phase: 0.0,
          motion_blur_samples: 16,
        },
      },
    },
    next_id: 40,
  };
  return Buffer.from(JSON.stringify(project), "utf8");
}

// ───────────────────────────────────────────────────────────────────────────
// Server boot + the in-process worker deps
// ───────────────────────────────────────────────────────────────────────────

let server: RunningTestServer;
/** The worker's own pool on the SAME database (repos + surgical claim). */
let workerDb: ReturnType<typeof createDb> | undefined;
let workerDeps: WorkerDeps;
let worker: WorkerModule;
/** Every render row this file queues (drives the surgical claim + cleanup). */
const ownedRenders: { wsId: string; renderId: string }[] = [];

beforeAll(async () => {
  // The file-level gates (no Postgres dialect / no CLI binary): skip cleanly.
  if (SKIP_REASON !== null) return;
  if (DATABASE_URL === null) throw new Error("render-e2e requires DATABASE_URL");
  server = await bootServer();
  worker = await loadWorkerModule();

  workerDb = createDb(DATABASE_URL, { max: 3 });
  const baseRepos: Repos = createRepos(workerDb);

  // SURGICAL CLAIM (see the file header): the repo's claimNext update with
  // one added `id IN (owned)` filter — byte-equivalent for this file's
  // rows, invisible to every other suite's queued rows.
  const claimOwned = async (): Promise<ScopedRenderRow[]> => {
    const db = workerDb;
    const targets = ownedRenders.map((entry) => entry.renderId);
    if (db === undefined || targets.length === 0) return [];
    return db.transaction(async (tx) => {
      const queued = await tx
        .select({ id: rendersTable.id })
        .from(rendersTable)
        .where(
          and(
            eq(rendersTable.status, "queued"),
            eq(rendersTable.cancelRequested, false),
            inArray(rendersTable.id, targets),
          ),
        )
        .orderBy(asc(rendersTable.createdAt), asc(rendersTable.id))
        .for("update", { skipLocked: true });
      if (queued.length === 0) return [];
      const now = new Date();
      const claimed = await tx
        .update(rendersTable)
        .set({
          status: "running",
          startedAt: now,
          heartbeatAt: now,
          attempts: sql`${rendersTable.attempts} + 1`,
        })
        .where(
          and(
            inArray(
              rendersTable.id,
              queued.map((row) => row.id),
            ),
            eq(rendersTable.status, "queued"),
          ),
        )
        .returning();
      if (claimed.length === 0) return [];
      const scoped = await tx
        .select({ render: rendersTable, workspaceId: projectsTable.workspaceId })
        .from(rendersTable)
        .innerJoin(projectsTable, eq(rendersTable.projectId, projectsTable.id))
        .where(
          inArray(
            rendersTable.id,
            claimed.map((row) => row.id),
          ),
        );
      return scoped.map((row) => ({ ...row.render, workspaceId: row.workspaceId }));
    });
  };

  const surgicalRepos: Repos = {
    ...baseRepos,
    renders: {
      ...baseRepos.renders,
      claimNext: async () => claimOwned(),
      // Inert sweeps in the shared parallel test DB (requeue/retention are
      // proven by the db suite; a journey tick must never touch foreign rows).
      requeueStale: async () => ({ requeued: 0, failed: [] }),
      listExpiredOutputs: async () => [],
    },
  };

  workerDeps = {
    db: workerDb,
    repos: surgicalRepos,
    ledger: baseRepos.ledger,
    // The SERVER's own driver instance — same §9.2 keys, same token registry.
    storage: { driver: server.deps.storage, local: server.deps.local },
    env: testEnv({
      RENDER_POLL_INTERVAL_MS: "100",
      RENDER_WORKER_CONCURRENCY: "1",
      RENDER_HEARTBEAT_STALE_SECONDS: "999999999",
    }),
    logger: worker.nullLogger,
  };
}, 30_000);

afterAll(async () => {
  // Cleanup (no queued debris from this file): terminalize every owned row
  // and release any outstanding hold — refundAll is idempotent, and rows
  // that already reached their terminal state CONFLICT harmlessly.
  const db = workerDb;
  if (db !== undefined) {
    const repos = createRepos(db);
    for (const owned of ownedRenders) {
      try {
        await repos.renders.markRunning(owned.wsId, owned.renderId);
      } catch {
        // already running/terminal
      }
      try {
        await repos.renders.markCancelled(owned.wsId, owned.renderId);
      } catch {
        // already terminal
      }
      try {
        await repos.ledger.refundAll(owned.wsId, {
          renderId: owned.renderId,
          idempotencyKey: `render-e2e-cleanup:${owned.renderId}`,
        });
      } catch {
        // nothing outstanding (or already refunded)
      }
    }
  }
  await server?.close();
  try {
    await closeDb(workerDb);
  } catch {
    // already closed
  }
}, 30_000);

// ───────────────────────────────────────────────────────────────────────────
// Journey harness (house helpers: at()/unique stamps/one server boot)
// ───────────────────────────────────────────────────────────────────────────

interface Workspace {
  readonly jar: CookieJar;
  readonly id: string;
  readonly userId: string;
}

async function newWorkspace(): Promise<Workspace> {
  const jar = new CookieJar();
  const signUp = await api(server.base, "/v1/auth/sign-up/email", {
    method: "POST",
    jar,
    body: {
      email: uniqueEmail("m8l"),
      password: "Passw0rd!longenough",
      name: "M8 Journey",
    },
  });
  expect(signUp.status).toBe(200);
  const wsResponse = await api(server.base, "/v1/workspaces", {
    method: "POST",
    jar,
    headers: { "idempotency-key": unique("ws") },
    body: { name: unique("M8L WS"), slug: unique("m8l-ws") },
  });
  expect(wsResponse.status).toBe(201);
  const ws = (await wsResponse.json()) as { data: { id: string } };
  const me = (await (await api(server.base, "/v1/me", { jar })).json()) as {
    data: { user: { id: string } };
  };
  return { jar, id: ws.data.id, userId: me.data.user.id };
}

async function grant(ws: Workspace, credits: number): Promise<void> {
  await server.deps.repos.ledger.grant(ws.id, {
    amount: credits * MICRO,
    idempotencyKey: unique("grant"),
  });
}

async function createProject(ws: Workspace): Promise<string> {
  const response = await api(server.base, "/v1/projects", {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
    body: { name: unique("M8L Project") },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/** Upload an ASSET through the real routes: descriptor → signed PUT → bytes. */
async function uploadAsset(
  ws: Workspace,
  projectId: string,
  name: string,
  bytes: Buffer,
  width: number,
  height: number,
): Promise<void> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await api(server.base, `/v1/assets?projectId=${projectId}`, {
    method: "POST",
    jar: ws.jar,
    headers: { "x-workspace-id": ws.id, "idempotency-key": unique("asset") },
    body: { name, mime: "image/png", sizeBytes: bytes.byteLength, sha256, width, height },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { upload: { url: string } } };
  // The signed PUT resolves through the gateway's local-storage route; the
  // token IS the credential (the browser would PUT to the same path on the
  // app origin — the ephemeral test server serves it here).
  const target = new URL(body.data.upload.url).pathname;
  const put = await fetch(`${server.base}${target}`, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
}

/** Upload the browser-shaped .ecproj as the project's FIRST version (→ head). */
async function uploadVersion(ws: Workspace, projectId: string, bytes: Buffer): Promise<string> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const query = new URLSearchParams({ sha256, sizeBytes: String(bytes.byteLength) });
  const response = await api(server.base, `/v1/projects/${projectId}/versions?${query}`, {
    method: "POST",
    jar: ws.jar,
    headers: {
      "x-workspace-id": ws.id,
      "idempotency-key": unique("ver"),
      "content-type": "application/octet-stream",
    },
    rawBody: new Uint8Array(bytes),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/** The shared fixture: seeded-noise asset + the browser-shaped version. */
async function renderableWorkspace(
  spec: FixtureSpec,
  seed: number,
): Promise<{
  ws: Workspace;
  projectId: string;
  versionId: string;
}> {
  const ws = await newWorkspace();
  const projectId = await createProject(ws);
  const asset = noisePng(spec.width, spec.height, seed);
  await uploadAsset(ws, projectId, "noise.png", asset, spec.width, spec.height);
  const versionId = await uploadVersion(ws, projectId, browserEcproj("noise.png", spec));
  return { ws, projectId, versionId };
}

interface Envelope<T> {
  readonly status: number;
  readonly data?: T;
  readonly error?: { code: string };
}

async function call<T>(
  ws: Workspace,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string>; key?: string } = {
    method: "GET",
  },
): Promise<Envelope<T>> {
  const headers: Record<string, string> = { "x-workspace-id": ws.id, ...init.headers };
  if (init.key !== undefined) headers["idempotency-key"] = init.key;
  const response = await api(server.base, path, {
    method: init.method,
    jar: ws.jar,
    headers,
    body: init.body,
  });
  const parsed = (await response.json()) as { data?: T; error?: { code: string } };
  return { status: response.status, data: parsed.data, error: parsed.error };
}

async function queue(
  ws: Workspace,
  projectId: string,
  compId: string,
  format: string,
  idempotencyKey: string,
): Promise<Envelope<RenderJob>> {
  const result = await call<RenderJob>(ws, "/v1/renders", {
    method: "POST",
    body: { projectId, compId, format, settings: {}, idempotencyKey },
    key: idempotencyKey,
  });
  const id = result.data?.id;
  if (id !== undefined) ownedRenders.push({ wsId: ws.id, renderId: id });
  return result;
}

async function estimate(
  ws: Workspace,
  projectId: string,
  compId: string,
  format: string,
): Promise<Envelope<EstimateResult>> {
  return call<EstimateResult>(ws, "/v1/renders/estimate", {
    method: "POST",
    body: { projectId, compId, format, settings: {} },
  });
}

async function getJob(ws: Workspace, renderId: string): Promise<RenderJob> {
  const result = await call<RenderJob>(ws, `/v1/renders/${renderId}`, { method: "GET" });
  expect(result.status).toBe(200);
  const job = result.data;
  if (job === undefined) throw new Error(`render ${renderId} did not come back`);
  return job;
}

/** Bounded poll (250 ms granularity, house waitFor discipline — no sleeps). */
async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
}

/**
 * The signed download, followed: the LocalFS driver binds an unguessable
 * token to the object key and the gateway's /v1/local-storage/:token route
 * serves it — the test re-targets the app-origin URL at the ephemeral test
 * server (same path, same token, no session needed, §9.2 audience rule).
 */
async function downloadResult(ws: Workspace, job: RenderJob): Promise<Buffer> {
  expect(job.resultUrl).not.toBeNull();
  const target = new URL(job.resultUrl ?? "").pathname;
  const response = await fetch(`${server.base}${target}`);
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

function expectIsoTimestamp(value: string | null, description: string): string {
  expect(value).not.toBeNull();
  const parsed = value ?? "";
  expect(Number.isNaN(Date.parse(parsed))).toBe(false);
  expect(parsed).toEqual(new Date(parsed).toISOString());
  return parsed;
}

// The shared journey fixtures.
/** 2 s @ 640×360, 30 fps — renders in ~0.8 s (the 1–2 s comp the task pins). */
const SMALL: FixtureSpec = {
  compName: "Main",
  width: 640,
  height: 360,
  fps: 30,
  durationSeconds: 2,
};
/** 10 s @ 1920×1080 — ~33 s of real render time: the cancel-journey margin. */
const LONG: FixtureSpec = {
  compName: "Long",
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 10,
};

// ───────────────────────────────────────────────────────────────────────────
// JOURNEY 1 — queue → render → download → ledger (THE exit criterion)
// ───────────────────────────────────────────────────────────────────────────

d("journey 1: queue → real worker → real CLI → signed download → exact ledger", () => {
  it("renders a real project and downloads a playable mp4, charging exactly the single formula", async () => {
    const { ws, projectId, versionId } = await renderableWorkspace(SMALL, 20261023);
    await grant(ws, 10);

    // THE PURE-READ ESTIMATE, before any queue — the one-formula identity.
    const expectedUc = estimateRenderCostUc({
      format: "mp4",
      outputSeconds: 2,
      longEdgePx: 640,
      quality: "good",
    });
    // 100_000 µc/s × 2 s × ½ tier = 100_000 µc < the 250_000 minimum → clamped.
    expect(expectedUc).toBe(250_000);
    // Pure read: the estimate queued nothing and wrote no ledger row
    // (the only ledger entry so far is the fixture's own grant).
    const ledgerBefore = (await server.deps.repos.ledger.list(ws.id, {})).items.length;
    const quote = await estimate(ws, projectId, "Main", "mp4");
    expect(quote.status).toBe(200);
    expect(quote.data).toEqual({
      credits: 0.25,
      outputSeconds: 2,
      longEdgePx: 640,
      format: "mp4",
      quality: "good",
      minApplied: true,
    });
    expect((await server.deps.repos.renders.list(ws.id, { projectId })).items).toHaveLength(0);
    expect((await server.deps.repos.ledger.list(ws.id, {})).items).toHaveLength(ledgerBefore);

    // QUEUE (Idempotency-Key): the row, the pinned version, the precreated key.
    const key = unique("queue");
    const queued = await queue(ws, projectId, "Main", "mp4", key);
    expect(queued.status).toBe(201);
    const job = queued.data;
    if (job === undefined) throw new Error("queue did not return a job");
    expect(job.id).toMatch(/^rdr_/);
    expect(job.status).toBe("queued"); // D-11 vocabulary
    expect(job.versionId).toBe(versionId); // SERVER-pinned head, never client-supplied
    expect(job.credits).toBe(quote.data?.credits); // the wire identity: estimate == reserve display
    expect(job.progress).toEqual({ framesDone: 0, framesTotal: 0, percent: 0 });
    expect(job.resultUrl).toBeNull();
    expect(job.settings).toMatchObject({ frameRate: 30 }); // effective fps materialized
    expect(job.createdBy).toBe(ws.userId);
    expectIsoTimestamp(job.createdAt, "createdAt");

    const row = await server.deps.repos.renders.get(ws.id, job.id);
    // The §9.2 output key was pre-created at queue time (worker never guesses).
    expect(row.objectKey).toBe(
      `workspaces/${ws.id}/projects/${projectId}/renders/${job.id}/output.mp4`,
    );
    // The row's credits COLUMN is the integer µc hold (the reconciliation dialect).
    expect(row.credits).toBe(expectedUc);

    // The hold is visible on the API: GET /v1/credits reports balance + reserved.
    const creditsView = await call<{ balance: number; reserved: number }>(ws, "/v1/credits", {
      method: "GET",
    });
    expect(creditsView.status).toBe(200);
    expect(creditsView.data?.balance).toBe(10 * MICRO - expectedUc);
    expect(creditsView.data?.reserved).toBe(expectedUc);

    // Drive the REAL worker: ONE deterministic tick claims + hydrates +
    // renders with the real CLI + settles (D-20) — synchronously.
    const tick = await worker.runOnce(workerDeps);
    expect(tick.claimed).toBe(1);
    const outcome = tick.outcomes.at(0);
    expect(outcome?.outcome).toBe("completed");
    if (outcome?.outcome !== "completed") throw new Error("the worker tick did not complete");
    expect(outcome.renderId).toBe(job.id);
    expect(outcome.objectKey).toBe(row.objectKey);
    expect(outcome.costUc).toBe(expectedUc); // actual == estimate == reserve
    expect(outcome.sizeBytes).toBeGreaterThan(10_000);

    // Poll the API until the terminal state is visible (bounded ≤ 30 s).
    let completed: RenderJob | undefined;
    await waitFor(
      "the render to reach completed on the API",
      async () => {
        completed = await getJob(ws, job.id);
        return completed.status === "completed";
      },
      30_000,
    );
    const done = completed ?? (await getJob(ws, job.id));
    expect(done.status).toBe("completed");
    // Progress fields present (framesTotal > 0): 2 s × 30 fps = 60 frames.
    expect(done.progress.framesTotal).toBe(60);
    expect(done.progress.framesDone).toBeLessThanOrEqual(60);
    expect(done.progress.percent).toBe(
      Math.min(100, Math.floor((done.progress.framesDone * 100) / done.progress.framesTotal)),
    );
    expect(done.sizeBytes).toBe(outcome.sizeBytes);
    expectIsoTimestamp(done.startedAt, "startedAt");
    expectIsoTimestamp(done.completedAt, "completedAt");
    expect(done.errorCode).toBeNull();
    expect(done.error).toBeNull();

    // THE DOWNLOAD: follow the signed URL → real bytes, playable mp4.
    const bytes = await downloadResult(ws, done);
    expect(bytes.length).toBe(done.sizeBytes);
    expect(bytes.length).toBeGreaterThan(10_000); // not a placeholder-sized stub
    expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp"); // MP4 box signature

    // THE LEDGER (D-20): reserve −N, commit −N, refund +N ⇒ nets EXACTLY −N.
    // (The /v1/credits/ledger wire DTO drops renderId — the documented M6-K
    // finding — so the render-scoped proof reads the repos directly.)
    const entries = await server.deps.repos.ledger.list(ws.id, { renderId: job.id });
    const byKind = new Map<string, number[]>();
    for (const entry of entries.items) {
      byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry.amount]);
    }
    expect(byKind.get("reserve")).toEqual([-expectedUc]);
    expect(byKind.get("commit")).toEqual([-expectedUc]);
    expect(byKind.get("refund")).toEqual([expectedUc]); // the FULL hold released (D-20)
    const net = entries.items.reduce((sum, entry) => sum + entry.amount, 0);
    expect(net).toBe(-expectedUc); // charged exactly the completed render's cost
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(10 * MICRO - expectedUc);
    // The hold is fully consumed: nothing outstanding any more.
    const after = await call<{ reserved: number }>(ws, "/v1/credits", { method: "GET" });
    expect(after.data?.reserved).toBe(0);

    // No duplicate outputs on retry (API-visible half): re-queue with the
    // SAME Idempotency-Key replays the stored result — the SAME row.
    const replay = await queue(ws, projectId, "Main", "mp4", key);
    expect(replay.status).toBe(201); // §7.2 replay returns the stored result
    expect(replay.data?.id).toBe(job.id);
    const history = await server.deps.repos.renders.list(ws.id, { projectId });
    expect(history.items).toHaveLength(1);
    expect(history.items.at(0)?.id).toBe(job.id);
  }, 45_000);
});

// ───────────────────────────────────────────────────────────────────────────
// JOURNEY 2 — cancel a running render → cooperative kill → FULL refund
// ───────────────────────────────────────────────────────────────────────────

d("journey 2: cancel + full refund", () => {
  it("cancels a real 1080p render mid-flight and refunds the hold exactly", async () => {
    const { ws, projectId } = await renderableWorkspace(LONG, 424242);
    await grant(ws, 5);

    // 10 s @ 1080p good mp4: 100_000 µc/s × 10 s × 1 = 1_000_000 µc.
    const expectedUc = estimateRenderCostUc({
      format: "mp4",
      outputSeconds: 10,
      longEdgePx: 1920,
      quality: "good",
    });
    expect(expectedUc).toBe(1_000_000);

    const queued = await queue(ws, projectId, "Long", "mp4", unique("queue"));
    expect(queued.status).toBe(201);
    const job = queued.data;
    if (job === undefined) throw new Error("queue did not return a job");
    expect(job.credits).toBe(1); // whole-credit display of the µc hold
    const balanceAfterReserve = await server.deps.repos.ledger.balance(ws.id);
    expect(balanceAfterReserve).toBe(5 * MICRO - expectedUc);

    // Start the REAL worker loop (100 ms polls): it claims the row and
    // spawns the real CLI — a ~33 s render on this box, so the cancel
    // below lands mid-flight with generous margin.
    const handle = await worker.startWorker(workerDeps);
    try {
      await waitFor(
        "the render to be claimed (running)",
        async () => (await getJob(ws, job.id)).status === "running",
        15_000,
      );
      const running = await getJob(ws, job.id);
      // The claim stamped started_at — visible on the wire while running.
      expectIsoTimestamp(running.startedAt, "startedAt");
      // The CLI's progress reaches the wire while the render is live.
      await waitFor(
        "worker frames to reach the wire",
        async () => (await getJob(ws, job.id)).progress.framesTotal === 300,
        15_000,
      );

      // Cancel (Idempotency-Key): the cooperative flag, mid-render.
      const cancel = await call<RenderJob>(ws, `/v1/renders/${job.id}/cancel`, {
        method: "POST",
        body: { reason: "journey cancel" },
        key: unique("cancel"),
      });
      expect(cancel.status).toBe(200);
      expect(cancel.data?.cancelRequested).toBe(true);

      // The worker observes the flag (≤ 2 s poll), kills the CLI process
      // group, terminal-transitions the row and refunds the FULL hold.
      await waitFor(
        "the render to reach cancelled",
        async () => (await getJob(ws, job.id)).status === "cancelled",
        30_000,
      );
      const cancelled = await getJob(ws, job.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.resultUrl).toBeNull();
      expect(cancelled.errorCode).toBeNull();
      expectIsoTimestamp(cancelled.completedAt, "completedAt");
    } finally {
      await handle.stop(); // stop claiming; nothing in flight any more
    }

    // No output was ever written: the precreated key has no object.
    const row = await server.deps.repos.renders.get(ws.id, job.id);
    expect(row.objectKey).not.toBeNull();
    expect(await server.deps.storage.read(row.objectKey ?? "none")).toBeNull();

    // FULL refund (D-20 failure/cancel path): reserve −N, refund +N, net 0.
    const entries = await server.deps.repos.ledger.list(ws.id, { renderId: job.id });
    const byKind = new Map<string, number[]>();
    for (const entry of entries.items) {
      byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry.amount]);
    }
    expect(byKind.get("reserve")).toEqual([-expectedUc]);
    expect(byKind.get("refund")).toEqual([expectedUc]);
    expect(byKind.get("commit")).toBeUndefined(); // charged NOTHING
    const net = entries.items.reduce((sum, entry) => sum + entry.amount, 0);
    expect(net).toBe(0);
    // The balance is back to the pre-reserve amount, exactly (integer µc).
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(5 * MICRO);
  }, 90_000);
});

// ───────────────────────────────────────────────────────────────────────────
// JOURNEY 3 — the entitlement gates (each typed, each on a fresh workspace)
// ───────────────────────────────────────────────────────────────────────────

d("journey 3: entitlement gates fire typed, before any ledger write", () => {
  it("(a) a declared-but-disabled format is 415 RENDER_UNSUPPORTED_FORMAT (D-2)", async () => {
    const { ws, projectId } = await renderableWorkspace(SMALL, 11111);
    await grant(ws, 10);
    const result = await queue(ws, projectId, "Main", "prores", unique("queue"));
    expect(result.status).toBe(415);
    expect(result.error?.code).toBe("RENDER_UNSUPPORTED_FORMAT");
    // Nothing queued, nothing held.
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(10 * MICRO);
  });

  it("(b) a second concurrent render is 429 RENDER_CONCURRENCY_LIMIT (trial cap = 1)", async () => {
    const { ws, projectId } = await renderableWorkspace(SMALL, 22222);
    await grant(ws, 10);
    const first = await queue(ws, projectId, "Main", "mp4", unique("queue"));
    expect(first.status).toBe(201);
    const second = await queue(ws, projectId, "Main", "mp4", unique("queue"));
    expect(second.status).toBe(429);
    expect(second.error?.code).toBe("RENDER_CONCURRENCY_LIMIT");
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(1);

    // Release the slot honestly: cancel the queued holder (cooperative flag;
    // claim-skip is row-level), then the gate reopens.
    const cancel = await call<RenderJob>(ws, `/v1/renders/${first.data?.id}/cancel`, {
      method: "POST",
      body: {},
      key: unique("cancel"),
    });
    expect(cancel.status).toBe(200);
    expect(cancel.data?.cancelRequested).toBe(true);
  });

  it("(c) exhausted monthly render minutes are 429 RENDER_QUOTA_EXCEEDED", async () => {
    const { ws, projectId, versionId } = await renderableWorkspace(SMALL, 33333);
    await grant(ws, 10);
    // The honest fixture (renderSecondsUsed reads Σ frames_total/frameRate
    // over completed rows since the UTC month start): seed the trial's full
    // 5 minutes = 300 s of completed output this billing month.
    const seeded = await server.deps.repos.renders.create(ws.id, {
      projectId,
      versionId,
      compId: "seed",
      format: "mp4",
      settingsJson: { frameRate: 30 },
      createdBy: ws.userId,
    });
    await server.deps.repos.renders.markRunning(ws.id, seeded.id);
    await server.deps.repos.renders.heartbeat(ws.id, seeded.id, { framesTotal: 300 * 30 });
    await server.deps.repos.renders.markCompleted(ws.id, seeded.id, { objectKey: "seed/out.mp4" });
    // The same monthly window the queue route uses (UTC calendar month).
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    expect(await server.deps.repos.renders.renderSecondsUsed(ws.id, monthStart)).toBe(300);

    const result = await queue(ws, projectId, "Main", "mp4", unique("queue"));
    expect(result.status).toBe(429);
    expect(result.error?.code).toBe("RENDER_QUOTA_EXCEEDED");
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
    expect(await server.deps.repos.ledger.balance(ws.id)).toBe(10 * MICRO);
  });

  it("(d) an uncoverable hold is 402 INSUFFICIENT_CREDITS with no row and no ledger write", async () => {
    const { ws, projectId } = await renderableWorkspace(SMALL, 44444);
    // No grant at all: balance 0 cannot cover the 250_000 µc hold.
    const result = await queue(ws, projectId, "Main", "mp4", unique("queue"));
    expect(result.status).toBe(402);
    expect(result.error?.code).toBe("INSUFFICIENT_CREDITS");
    expect((await server.deps.repos.renders.list(ws.id, {})).items).toHaveLength(0);
    expect((await server.deps.repos.ledger.list(ws.id, {})).items).toHaveLength(0);
  });

  it("(e) the estimate is a pure read: priced, gated by nothing, writes nothing", async () => {
    const { ws, projectId } = await renderableWorkspace(SMALL, 55555);
    const before = (await server.deps.repos.ledger.list(ws.id, {})).items.length;
    const quote = await estimate(ws, projectId, "Main", "mp4");
    expect(quote.status).toBe(200);
    expect(quote.data?.credits).toBeGreaterThan(0);
    expect((await server.deps.repos.ledger.list(ws.id, {})).items).toHaveLength(before);
    expect(await server.deps.repos.renders.countActive(ws.id)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// JOURNEY 4 — PNG sequence → the ZIP artifact rule (spike §5)
// ───────────────────────────────────────────────────────────────────────────

d("journey 4: png-seq queues, renders and downloads as a ZIP with one entry per frame", () => {
  it("produces a real ZIP whose entry count equals the rendered frame count", async () => {
    const { ws, projectId } = await renderableWorkspace(SMALL, 666666);
    await grant(ws, 10);

    // png-seq costs 50_000 µc/s × 2 s × ½ = 50_000 → the 250_000 minimum.
    const expectedUc = estimateRenderCostUc({
      format: "png-seq",
      outputSeconds: 2,
      longEdgePx: 640,
      quality: "good",
    });
    expect(expectedUc).toBe(250_000);

    const queued = await queue(ws, projectId, "Main", "png-seq", unique("queue"));
    expect(queued.status).toBe(201);
    const job = queued.data;
    if (job === undefined) throw new Error("queue did not return a job");
    expect(job.format).toBe("png-seq");
    // The output key rule (spike §5): sequences download as output.ZIP.
    const row = await server.deps.repos.renders.get(ws.id, job.id);
    expect(row.objectKey).toBe(
      `workspaces/${ws.id}/projects/${projectId}/renders/${job.id}/output.zip`,
    );

    const tick = await worker.runOnce(workerDeps);
    expect(tick.claimed).toBe(1);
    const outcome = tick.outcomes.at(0);
    expect(outcome?.outcome).toBe("completed");

    let completed: RenderJob | undefined;
    await waitFor(
      "the png-seq render to complete on the API",
      async () => {
        completed = await getJob(ws, job.id);
        return completed.status === "completed";
      },
      30_000,
    );
    const done = completed ?? (await getJob(ws, job.id));
    expect(done.progress.framesTotal).toBe(60); // 2 s × 30 fps
    const frames = done.progress.framesTotal;
    expect(frames).toBeGreaterThanOrEqual(2);

    const bytes = await downloadResult(ws, done);
    expect(bytes.length).toBe(done.sizeBytes);

    // ZIP magic: local file header first, a real end-of-central-directory.
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("PK\u0003\u0004");
    const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let eocdAt = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 66_000); at -= 1) {
      if (bytes.subarray(at, at + 4).equals(EOCD_SIGNATURE)) {
        eocdAt = at;
        break;
      }
    }
    expect(eocdAt).toBeGreaterThan(0);
    const entryCount = bytes.readUInt16LE(eocdAt + 8);
    expect(entryCount).toBe(frames); // one archive member per rendered frame
  }, 45_000);
});

// ───────────────────────────────────────────────────────────────────────────
// JOURNEY 5 — render history + the full v2 RenderJob shape + expiry
// ───────────────────────────────────────────────────────────────────────────

d("journey 5: render history, cursor pages and the v2 RenderJob shape", () => {
  it("lists completed renders with the contracts shape, field by field", async () => {
    const { ws, projectId, versionId } = await renderableWorkspace(SMALL, 777777);
    await grant(ws, 10);

    // Two completed renders in this workspace (sequential, so the trial's
    // maxConcurrentRenders=1 gate stays satisfied at every instant).
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const queued = await queue(ws, projectId, "Main", "mp4", unique("queue"));
      expect(queued.status).toBe(201);
      const id = queued.data?.id;
      if (id === undefined) throw new Error("queue did not return a job");
      const tick = await worker.runOnce(workerDeps);
      expect(tick.claimed).toBe(1);
      await waitFor(
        `render ${index + 1} to complete`,
        async () => (await getJob(ws, id)).status === "completed",
        30_000,
      );
      ids.push(id);
    }

    // History: workspace scope, newest first, both filters.
    const list = await call<{ items: RenderJob[]; nextCursor: string | null }>(
      ws,
      `/v1/renders?projectId=${projectId}`,
      { method: "GET" },
    );
    expect(list.status).toBe(200);
    expect(list.data?.items).toHaveLength(2);
    expect(list.data?.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
    const filtered = await call<{ items: RenderJob[] }>(
      ws,
      `/v1/renders?projectId=${projectId}&status=completed`,
      { method: "GET" },
    );
    expect(filtered.data?.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);

    // Cursor pagination (house Page convention).
    const pageOne = await call<{ items: RenderJob[]; nextCursor: string | null }>(
      ws,
      `/v1/renders?projectId=${projectId}&limit=1`,
      { method: "GET" },
    );
    expect(pageOne.data?.items).toHaveLength(1);
    expect(pageOne.data?.items.at(0)?.id).toBe(ids[1]);
    expect(pageOne.data?.nextCursor).not.toBeNull();
    const pageTwo = await call<{ items: RenderJob[]; nextCursor: string | null }>(
      ws,
      `/v1/renders?projectId=${projectId}&limit=1&cursor=${pageOne.data?.nextCursor ?? ""}`,
      { method: "GET" },
    );
    expect(pageTwo.data?.items.at(0)?.id).toBe(ids[0]);
    expect(pageTwo.data?.nextCursor).toBeNull();

    // THE SHAPE — the full v2 RenderJob, field by field, against the
    // contracts type (compile-time `RenderJob` + runtime assertions).
    const job: RenderJob = list.data?.items.at(0) ?? ({} as RenderJob);
    expect(job.id).toMatch(/^rdr_/);
    expect(job.projectId).toBe(projectId);
    expect(job.compId).toBe("Main");
    expect(job.versionId).toBe(versionId);
    expect(job.format).toBe("mp4");
    expect(job.settings).toMatchObject({ frameRate: 30 });
    // D-11: the DB status vocabulary IS the wire vocabulary.
    expect(job.status).toBe("completed");
    expect(RENDER_STATUSES).toContain(job.status);
    expect(RENDER_STATUSES).not.toContain("succeeded");
    expect(RENDER_STATUS_SCHEMA.safeParse(job.status).success).toBe(true);
    expect(job.cancelRequested).toBe(false);
    expect(job.progress).toEqual({
      framesDone: expect.any(Number),
      framesTotal: 60,
      percent: expect.any(Number),
    });
    expect(job.credits).toBe(0.25); // D-12 whole-credit display number
    expect(typeof job.resultUrl).toBe("string");
    expect(job.errorCode).toBeNull();
    expect(job.error).toBeNull();
    expect(job.sizeBytes).toBeGreaterThan(10_000);
    expect(job.createdBy).toBe(ws.userId);
    const createdAt = expectIsoTimestamp(job.createdAt, "createdAt");
    const startedAt = expectIsoTimestamp(job.startedAt, "startedAt");
    const completedAt = expectIsoTimestamp(job.completedAt, "completedAt");
    // Retention by plan: completed outputs carry a future expiresAt
    // (trial = 3 days) — the retention sweep's input, visible on the wire.
    const expiresAt = expectIsoTimestamp(job.expiresAt, "expiresAt");
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.parse(completedAt));
    expect(Date.parse(expiresAt) - Date.parse(completedAt)).toBeGreaterThanOrEqual(3 * 86_400_000);
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(Date.parse(createdAt));
    expect(Date.parse(completedAt)).toBeGreaterThanOrEqual(Date.parse(startedAt));
  }, 60_000);
});
