import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { type Executor, type StudioDb, getDialect } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { Render, RenderStatus } from "../schema.js";
import { assertRenderTransition } from "../statuses.js";
import { tablesFor } from "../tables.js";
import {
  type WorkspaceId,
  requireNonEmpty,
  requireNonNegativeInt,
  requirePositiveInt,
} from "./shared.js";

/**
 * Renders repository — the Postgres-backed JOB QUEUE (§9.1, §M8).
 *
 * Status machine: queued → running → completed | failed | cancelled, plus the
 * M8-A crash-recovery `running → queued` requeue (legal ONLY from
 * `requeueStale`, guarded by attempts + heartbeat age — see statuses.ts).
 * Any illegal transition is a typed CONFLICT.
 *
 * Worker contract (the M8 worker wave codes against EXACTLY this interface):
 * - `claimNext` is the ONE trusted-internal, workspace-free entry point: the
 *   worker owns every workspace, so it must not be forced to name one up
 *   front. It claims with `SELECT … FOR UPDATE SKIP LOCKED` (safe under any
 *   number of concurrent workers), and every returned row carries its
 *   resolved `workspaceId` so all further calls (heartbeat / mark* / …) can
 *   stay workspace-first per the tenant-isolation law.
 * - Sweeps (`requeueStale`, `listExpiredOutputs`) are likewise internal and
 *   workspace-free; the retention sweep resolves workspaceId per row the same
 *   way claimNext does before calling `markOutputExpired`.
 *
 * Cancellation is cooperative: `requestCancel` only raises the
 * `cancel_requested` flag (idempotently, from queued or running). A queued
 * row keeps its status and is skipped at claim time; a running row is
 * observed by its worker, which terminal-transitions it (markCancelled).
 */

export interface RenderCreateInput {
  readonly projectId: string;
  /**
   * M8-A: the immutable project_versions.id this render is pinned to (§9.3) —
   * required; a queued job must never render "whatever is current later".
   */
  readonly versionId: string;
  readonly compId: string;
  readonly format: string;
  readonly settingsJson?: unknown;
  readonly credits?: number;
  readonly createdBy: string;
  /**
   * M8-G (additive): the §9.2 output key, pre-created by the gateway route at
   * QUEUE time so the worker never guesses key layout — it reads `objectKey`
   * off the row it claimed (renderKey(ws, pid, rid, ext) in the gateway's
   * storage.ts). The row id is generated INSIDE create(), so the route cannot
   * know it up front: pass the key with the literal `{renderId}` placeholder
   * in the id segment and create() resolves it against the fresh id. A string
   * WITHOUT the placeholder is stored verbatim (for callers that already own
   * the id); absent → NULL (M8-A callers and internal rows are unaffected).
   */
  readonly objectKey?: string;
}

/** The placeholder token create() substitutes with the freshly generated id. */
const RENDER_ID_PLACEHOLDER = "{renderId}";

/** Resolves the route-precreated §9.2 key against the generated row id. */
function resolveObjectKey(template: string | undefined, renderId: string): string | null {
  if (template === undefined) return null;
  const key = requireNonEmpty(template, "objectKey");
  return key.includes(RENDER_ID_PLACEHOLDER)
    ? key.replaceAll(RENDER_ID_PLACEHOLDER, renderId)
    : key;
}

export interface RenderListOptions {
  readonly projectId?: string;
  readonly status?: RenderStatus;
  readonly limit?: number;
  readonly cursor?: string | null;
}

/** Render row + the workspace it belongs to (resolved via projects). */
export interface ScopedRender extends Render {
  readonly workspaceId: WorkspaceId;
}

/**
 * BIL-02 (2026-10-30 audit): requeueStale's result. The terminal branch
 * reports each failed row (id + owning workspace) so the worker sweep can
 * refund the stranded credit hold — pre-fix the reserve was locked forever.
 */
export interface RequeueStaleResult {
  /** Rows sent back to queued (attempts remaining). */
  readonly requeued: number;
  /** Rows terminally failed — their credit holds need releasing. */
  readonly failed: ReadonlyArray<{ readonly id: string; readonly workspaceId: WorkspaceId }>;
}

/** Progress payload for `heartbeat` — both fields optional, monotonic once set. */
export interface RenderHeartbeatInput {
  readonly framesDone?: number;
  readonly framesTotal?: number;
}

export interface RenderCompleteResult {
  readonly objectKey: string;
  /** M8-A: output size in bytes (retention/UX metadata). */
  readonly sizeBytes?: number;
  /** M8-A: when the downloadable output becomes ineligible (retention sweep). */
  readonly expiresAt?: Date;
}

export interface RenderFailResult {
  readonly error: string;
  /** M8-A: machine-readable code (e.g. RENDER_TIMEOUT, RENDER_INTERNAL). */
  readonly errorCode?: string;
}

export interface RenderClaimOptions {
  readonly limit?: number;
}

export interface RendersRepo {
  /**
   * AUD-M1: `limits.maxConcurrent` re-asserts the plan's concurrency cap
   * INSIDE a workspace-keyed advisory-locked transaction (the route-level
   * countActive pre-check is check-then-act). Optional — legacy callers
   * and test fakes keep the bare shape.
   */
  create(
    workspaceId: WorkspaceId,
    input: RenderCreateInput,
    limits?: { readonly maxConcurrent: number },
  ): Promise<Render>;
  markRunning(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  markCompleted(
    workspaceId: WorkspaceId,
    renderId: string,
    result: RenderCompleteResult,
  ): Promise<Render>;
  markFailed(workspaceId: WorkspaceId, renderId: string, result: RenderFailResult): Promise<Render>;
  markCancelled(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  get(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  list(workspaceId: WorkspaceId, options?: RenderListOptions): Promise<Page<Render>>;

  // ── M8-A job-queue surface (additive; the worker wave consumes these) ──────

  /**
   * Claim up to `limit` queued renders for a worker (FIFO by created_at).
   * Rows with `cancel_requested` are skipped at claim time. Claimed rows flip
   * to running with started_at=now, heartbeat_at=now, attempts=attempts+1.
   * Trusted-internal (workspace-free by design); each returned row carries
   * its resolved workspaceId for all subsequent workspace-first calls.
   */
  claimNext(workerId: string, options?: RenderClaimOptions): Promise<ScopedRender[]>;
  /** Idempotent progress ping: bumps heartbeat_at; frames only ever advance. */
  heartbeat(
    workspaceId: WorkspaceId,
    renderId: string,
    progress?: RenderHeartbeatInput,
  ): Promise<Render>;
  /**
   * Cooperative cancel: raises `cancel_requested` (idempotent). Legal from
   * queued (row stays queued, skipped at claim time) or running (the worker
   * observes the flag and terminal-transitions). Terminal rows → CONFLICT.
   */
  requestCancel(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  /**
   * Crash-recovery sweep (trusted-internal, workspace-free): running rows
   * whose heartbeat is older than `staleSeconds` go back to queued while
   * attempts < maxAttempts (the sanctioned running→queued transition;
   * cancel_requested is reset), otherwise they fail terminally with
   * error 'worker lost mid-render' / error_code RENDER_INTERNAL.
   * BIL-02 (2026-10-30 audit): the result reports each terminally-failed
   * row (id + owning workspace) so the worker sweep can refund the
   * stranded credit hold.
   */
  requeueStale(staleSeconds: number, maxAttempts: number): Promise<RequeueStaleResult>;
  /**
   * Retention sweep input (trusted-internal, workspace-free): completed rows
   * whose expires_at is before `before`, oldest first. After deleting the
   * stored object the sweeper calls `markOutputExpired` per row.
   */
  listExpiredOutputs(before: Date): Promise<ScopedRender[]>;
  /**
   * Marks the output of a completed render as deleted (retention). Clears
   * objectKey/expiresAt/sizeBytes but KEEPS the row as history; the API layer
   * treats a completed render with a missing objectKey as "expired".
   * Idempotent; non-completed rows → CONFLICT.
   */
  markOutputExpired(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  /**
   * Honest output-seconds sum for the renderMinutesPerMonth quota:
   * Σ frames_total / frameRate over completed renders (completedAt >= since).
   * frameRate comes from settingsJson (RENDER_SETTINGS_SCHEMA); rows without
   * a usable frameRate or frames contribute 0 (documented fallback). The sum
   * may be fractional — the caller rounds for display/enforcement.
   */
  renderSecondsUsed(workspaceId: WorkspaceId, since: Date): Promise<number>;
  /** queued + running count for the per-workspace concurrency gate. */
  countActive(workspaceId: WorkspaceId): Promise<number>;
}

/** Upper bound for a single claim batch — a worker must never hog the queue. */
const MAX_CLAIM_LIMIT = 25;

/** frameRate from settingsJson (RENDER_SETTINGS_SCHEMA.frameRate); null if absent/invalid. */
function frameRateOf(settings: unknown): number | null {
  if (typeof settings !== "object" || settings === null) return null;
  const fps = (settings as { frameRate?: unknown }).frameRate;
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : null;
}

function requireValidDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw DbError.validation(`${field} must be a valid Date`);
  }
  return value;
}

/**
 * Dialect fork (W1-03 sqlite dev server): pg `greatest(a, b)` vs sqlite
 * `max(a, b)` — both clamp-to-the-larger; the spelling differs.
 */
function greatest<TColumn>(db: StudioDb, column: TColumn, value: number) {
  return getDialect(db) === "sqlite"
    ? sql`max(${column}, ${value})`
    : sql`greatest(${column}, ${value})`;
}

/** Dialect fork: pg `count(*)::int` cast vs sqlite's plain integer count. */
function countStarInt(db: StudioDb) {
  return getDialect(db) === "sqlite" ? sql<number>`count(*)` : sql<number>`count(*)::int`;
}

export function createRendersRepo(db: StudioDb): RendersRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { projectVersions, projects, renders } = tablesFor(db);
  async function requireRender(workspaceId: WorkspaceId, renderId: string): Promise<Render> {
    const [row] = await db
      .select({ render: renders })
      .from(renders)
      .innerJoin(projects, eq(renders.projectId, projects.id))
      .where(and(eq(renders.id, renderId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw DbError.notFound("render");
    return row.render;
  }

  async function transition(
    workspaceId: WorkspaceId,
    renderId: string,
    to: RenderStatus,
    extra: Partial<typeof renders.$inferInsert>,
  ): Promise<Render> {
    const render = await requireRender(workspaceId, renderId);
    assertRenderTransition(render.status, to);
    const [updated] = await db
      .update(renders)
      .set({ status: to, ...extra })
      .where(and(eq(renders.id, render.id), eq(renders.status, render.status)))
      .returning();
    if (!updated) throw DbError.conflict("Render state changed concurrently");
    return updated;
  }

  return {
    async create(workspaceId, input, limits) {
      const compId = requireNonEmpty(input.compId, "compId");
      const format = requireNonEmpty(input.format, "format");
      const versionId = requireNonEmpty(input.versionId, "versionId");
      requireNonEmpty(input.createdBy, "createdBy");
      requireNonNegativeInt(input.credits ?? 0, "credits");

      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!project) throw DbError.notFound("project");

      // The pinned version must belong to the SAME project (§9.3) — a version
      // of another project (or another tenant's, or unknown) reads as 404.
      const [version] = await db
        .select({ id: projectVersions.id })
        .from(projectVersions)
        .where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, project.id)))
        .limit(1);
      if (!version) throw DbError.notFound("version");

      // AUD-M1 (2026-10-30 deep audit): when the route passes the plan's
      // concurrency cap, the active-count is RE-ASSERTED inside a
      // workspace-keyed advisory-locked transaction — the route-level
      // countActive pre-check was check-then-act, so N parallel queue POSTs
      // all passed it before any row existed. The sqlite dev twin is one
      // serialized connection (the lock is a no-op there).
      const doInsert = async (exec: Executor): Promise<Render> => {
        const renderId = createId("rdr");
        const [render] = await exec
          .insert(renders)
          .values({
            id: renderId,
            projectId: project.id,
            versionId: version.id,
            compId,
            format,
            settingsJson: input.settingsJson,
            status: "queued",
            credits: input.credits ?? 0,
            createdBy: input.createdBy,
            // M8-G: the route-precreated §9.2 output key (queue-time, so the
            // worker never guesses layout); NULL when the caller omits it.
            objectKey: resolveObjectKey(input.objectKey, renderId),
            // Job-queue defaults come from the DB (migration 0005):
            // attempts=0, frames_done=0, frames_total=0, cancel_requested=false.
          })
          .returning();
        if (!render) throw DbError.conflict("Could not queue render");
        return render;
      };

      if (limits !== undefined) {
        const cap = requirePositiveInt(limits.maxConcurrent, "maxConcurrent");
        return db.transaction(async (tx) => {
          if (getDialect(db) === "postgres") {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
          }
          const { renders: rendersTx, projects: projectsTx } = tablesFor(tx);
          // Portable cast: `::int` is Postgres-only, sqlite rejects it.
          const [row] = await tx
            .select({ count: sql<number>`cast(count(*) as int)` })
            .from(rendersTx)
            .innerJoin(projectsTx, eq(rendersTx.projectId, projectsTx.id))
            .where(
              and(
                eq(projectsTx.workspaceId, workspaceId),
                or(eq(rendersTx.status, "queued"), eq(rendersTx.status, "running")),
              ),
            );
          if ((row?.count ?? 0) >= cap) {
            throw DbError.conflict("RENDER_CONCURRENCY_LIMIT");
          }
          return doInsert(tx);
        });
      }
      return doInsert(db);
    },

    markRunning: (workspaceId, renderId) => transition(workspaceId, renderId, "running", {}),

    markCompleted: (workspaceId, renderId, result) => {
      const objectKey = requireNonEmpty(result.objectKey, "objectKey");
      const extra: Partial<typeof renders.$inferInsert> = {
        objectKey,
        completedAt: new Date(),
      };
      if (result.sizeBytes !== undefined) {
        extra.sizeBytes = requireNonNegativeInt(result.sizeBytes, "sizeBytes");
      }
      if (result.expiresAt !== undefined) {
        extra.expiresAt = requireValidDate(result.expiresAt, "expiresAt");
      }
      return transition(workspaceId, renderId, "completed", extra);
    },

    markFailed: (workspaceId, renderId, result) => {
      const error = requireNonEmpty(result.error, "error");
      return transition(workspaceId, renderId, "failed", {
        error,
        errorCode: result.errorCode ?? null,
        completedAt: new Date(),
      });
    },

    markCancelled: (workspaceId, renderId) =>
      transition(workspaceId, renderId, "cancelled", { completedAt: new Date() }),

    async get(workspaceId, renderId) {
      return requireRender(workspaceId, renderId);
    },

    async list(workspaceId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select({ render: renders })
        .from(renders)
        .innerJoin(projects, eq(renders.projectId, projects.id))
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            options?.projectId === undefined ? undefined : eq(renders.projectId, options.projectId),
            options?.status === undefined ? undefined : eq(renders.status, options.status),
            cursor
              ? or(
                  lt(renders.createdAt, new Date(cursor.t)),
                  and(eq(renders.createdAt, new Date(cursor.t)), lt(renders.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(renders.createdAt), desc(renders.id))
        .limit(limit + 1);

      const items = rows.map((row) => row.render).slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async claimNext(workerId, options) {
      // workerId is required for call-site auditability (each claim is
      // attributable in logs/metrics); the M8-A column set intentionally
      // does not persist a claimer id — liveness is heartbeat-scoped.
      requireNonEmpty(workerId, "workerId");
      const limit =
        options?.limit === undefined
          ? 1
          : Math.min(requirePositiveInt(options.limit, "limit"), MAX_CLAIM_LIMIT);

      return db.transaction(async (tx) => {
        // SELECT … FOR UPDATE SKIP LOCKED: concurrent workers never block each
        // other or double-claim — locked rows are simply skipped.
        // (SQLite dev server: better-sqlite3 is one serialized connection —
        // the whole transaction is exclusive, so the lock clause is dropped;
        // single-writer semantics give the same no-double-claim guarantee.)
        const dialect = getDialect(db);
        const baseQuery = tx
          .select({ id: renders.id })
          .from(renders)
          .where(and(eq(renders.status, "queued"), eq(renders.cancelRequested, false)))
          .orderBy(asc(renders.createdAt), asc(renders.id))
          .limit(limit);
        const queued =
          dialect === "sqlite"
            ? await baseQuery
            : await baseQuery.for("update", { skipLocked: true });
        if (queued.length === 0) return [];

        const now = new Date();
        const claimed = await tx
          .update(renders)
          .set({
            status: "running",
            startedAt: now,
            heartbeatAt: now,
            attempts: sql`${renders.attempts} + 1`,
          })
          // queued → running is a legal public transition; the rows are locked
          // by this transaction, so the status guard cannot race.
          .where(
            and(
              inArray(
                renders.id,
                queued.map((row) => row.id),
              ),
              eq(renders.status, "queued"),
            ),
          )
          .returning();
        if (claimed.length === 0) return [];

        // Resolve workspaceId per row (renders scope through projects) so the
        // worker can make workspace-first calls for everything else. Returned
        // in claim (FIFO) order.
        const scoped = await tx
          .select({ render: renders, workspaceId: projects.workspaceId })
          .from(renders)
          .innerJoin(projects, eq(renders.projectId, projects.id))
          .where(
            inArray(
              renders.id,
              claimed.map((row) => row.id),
            ),
          )
          .orderBy(asc(renders.createdAt), asc(renders.id));
        return scoped.map((row) => ({ ...row.render, workspaceId: row.workspaceId }));
      });
    },

    async heartbeat(workspaceId, renderId, progress) {
      const framesDone =
        progress?.framesDone === undefined
          ? undefined
          : requireNonNegativeInt(progress.framesDone, "framesDone");
      const framesTotal =
        progress?.framesTotal === undefined
          ? undefined
          : requireNonNegativeInt(progress.framesTotal, "framesTotal");

      const render = await requireRender(workspaceId, renderId);
      if (render.status !== "running") {
        throw DbError.conflict(`Cannot heartbeat a ${render.status} render`);
      }
      // Monotonic frames: greatest(col, value) — a late/duplicate ping can
      // never rewind progress. Idempotent: re-sending the same values is a no-op
      // apart from the heartbeat_at bump.
      const [updated] = await db
        .update(renders)
        .set({
          heartbeatAt: new Date(),
          ...(framesDone === undefined
            ? {}
            : { framesDone: greatest(db, renders.framesDone, framesDone) }),
          ...(framesTotal === undefined
            ? {}
            : { framesTotal: greatest(db, renders.framesTotal, framesTotal) }),
        })
        .where(and(eq(renders.id, render.id), eq(renders.status, "running")))
        .returning();
      if (!updated) throw DbError.conflict("Render state changed concurrently");
      return updated;
    },

    async requestCancel(workspaceId, renderId) {
      const render = await requireRender(workspaceId, renderId);
      if (render.status !== "queued" && render.status !== "running") {
        throw DbError.conflict(`Cannot cancel a ${render.status} render`);
      }
      if (render.cancelRequested) return render; // idempotent while still cancelable
      const [updated] = await db
        .update(renders)
        .set({ cancelRequested: true })
        .where(and(eq(renders.id, render.id), inArray(renders.status, ["queued", "running"])))
        .returning();
      if (!updated) throw DbError.conflict("Render state changed concurrently");
      return updated;
    },

    async requeueStale(staleSeconds, maxAttempts) {
      requirePositiveInt(staleSeconds, "staleSeconds");
      requirePositiveInt(maxAttempts, "maxAttempts");
      const cutoff = new Date(Date.now() - staleSeconds * 1000);
      // Stale = running with no heartbeat at all, or one older than the cutoff.
      const stale = and(
        eq(renders.status, "running"),
        or(isNull(renders.heartbeatAt), lt(renders.heartbeatAt, cutoff)),
      );

      // Branch 1: attempts left → back to queued. This is the ONLY sanctioned
      // running→queued transition (statuses.ts); cancel_requested is reset so
      // a fresh claim is possible (the previous attempt's cancel died with it).
      const requeued = await db
        .update(renders)
        .set({ status: "queued", cancelRequested: false, startedAt: null, heartbeatAt: null })
        .where(and(stale, lt(renders.attempts, maxAttempts)))
        .returning({ id: renders.id });

      // Branch 2: out of attempts → honest terminal failure. BIL-02
      // (2026-10-30 audit): SELECT-first so the caller learns each failed
      // row's owning workspace — the worker sweep refunds the stranded
      // credit hold (pre-fix the terminal branch just failed the row and
      // the user's reserve was locked forever with no recovery path).
      // The UPDATE re-asserts the stale conditions so nothing races in
      // between the two statements.
      const doomed = await db
        .select({ id: renders.id, workspaceId: projects.workspaceId })
        .from(renders)
        .innerJoin(projects, eq(renders.projectId, projects.id))
        .where(and(stale, gte(renders.attempts, maxAttempts)));
      const failed: Array<{ id: string; workspaceId: WorkspaceId }> = [];
      if (doomed.length > 0) {
        const terminal = await db
          .update(renders)
          .set({
            status: "failed",
            error: "worker lost mid-render",
            errorCode: "RENDER_INTERNAL",
            completedAt: new Date(),
          })
          .where(
            and(
              stale,
              gte(renders.attempts, maxAttempts),
              inArray(
                renders.id,
                doomed.map((row) => row.id),
              ),
            ),
          )
          .returning({ id: renders.id });
        const terminalIds = new Set(terminal.map((row) => row.id));
        for (const row of doomed) {
          if (terminalIds.has(row.id)) failed.push(row);
        }
      }

      return { requeued: requeued.length, failed };
    },

    async listExpiredOutputs(before) {
      requireValidDate(before, "before");
      const rows = await db
        .select({ render: renders, workspaceId: projects.workspaceId })
        .from(renders)
        .innerJoin(projects, eq(renders.projectId, projects.id))
        // lt() alone excludes expires_at IS NULL rows (SQL NULL semantics).
        .where(and(eq(renders.status, "completed"), lt(renders.expiresAt, before)))
        .orderBy(asc(renders.expiresAt), asc(renders.id));
      return rows.map((row) => ({ ...row.render, workspaceId: row.workspaceId }));
    },

    async markOutputExpired(workspaceId, renderId) {
      const render = await requireRender(workspaceId, renderId);
      if (render.status !== "completed") {
        throw DbError.conflict("Only completed renders have an expirable output");
      }
      if (render.objectKey === null) return render; // already expired — idempotent
      const [updated] = await db
        .update(renders)
        .set({ objectKey: null, expiresAt: null, sizeBytes: null })
        .where(and(eq(renders.id, render.id), eq(renders.status, "completed")))
        .returning();
      if (!updated) throw DbError.conflict("Render state changed concurrently");
      return updated;
    },

    async renderSecondsUsed(workspaceId, since) {
      requireValidDate(since, "since");
      const rows = await db
        .select({ framesTotal: renders.framesTotal, settingsJson: renders.settingsJson })
        .from(renders)
        .innerJoin(projects, eq(renders.projectId, projects.id))
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            eq(renders.status, "completed"),
            gte(renders.completedAt, since),
          ),
        );
      let seconds = 0;
      for (const row of rows) {
        const fps = frameRateOf(row.settingsJson);
        // Honest fallback (documented): without a usable frameRate or frames
        // the row contributes 0 — never a guess.
        if (fps === null || row.framesTotal <= 0) continue;
        seconds += row.framesTotal / fps;
      }
      return seconds;
    },

    async countActive(workspaceId) {
      const [row] = await db
        .select({ total: countStarInt(db) })
        .from(renders)
        .innerJoin(projects, eq(renders.projectId, projects.id))
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            inArray(renders.status, ["queued", "running"]),
          ),
        );
      return row?.total ?? 0;
    },
  };
}
