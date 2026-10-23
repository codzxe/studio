import { and, asc, eq, isNull, lt } from "drizzle-orm";

import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, requireNonEmpty, requirePositiveInt } from "./shared.js";

/**
 * Presence repository — §M7 task 2: who is viewing, active comp, playhead.
 * Heartbeat upsert + TTL sweep; no cursor co-editing (out of scope by design).
 *
 * Ephemeral by contract: `beat` upserts the (project_id, user_id) row (one
 * row per viewer — a retried beat can never duplicate) and sweeps rows whose
 * `last_seen_at` is older than the TTL; `viewers` performs the same sweep and
 * returns the survivors. The sweep is per-project (other projects' rows are
 * never touched) and the TTL is a repo parameter so the gateway/tests can
 * tune it.
 *
 * TTL resolution (pinned by @studio/contracts routes/presence.ts, landed by
 * M7-B): explicit `ttlMs` param → else the `PRESENCE_TTL_MS` process-env var
 * (whole ms, ≥ 1000; read HERE at the sweep site because @studio/config's
 * env seam doesn't carry it yet) → else the documented default below, which
 * MUST equal contracts' `PRESENCE_TTL_MS` = LEASE_HEARTBEAT_MS × 2
 * (two missed 2-minute heartbeats and the viewer is gone). The db package
 * cannot import @studio/contracts — keep the values in sync deliberately.
 */

/** Documented default sweep window — MUST equal contracts' PRESENCE_TTL_MS. */
export const PRESENCE_TTL_MS = 240_000;

/** Comp id bound (contracts PRESENCE_COMP_ID_SCHEMA). */
const COMP_ID_MAX = 120;

/** Playhead bound (contracts PRESENCE_PLAYHEAD_TICKS_MAX, engine ticks). */
const PLAYHEAD_TICKS_MAX = 36_000_000;

/**
 * Repo-level viewer row. The GATEWAY presence route (M7-B) maps this onto the
 * wire `PresenceViewer` (contracts): `lastSeenAt` becomes `lastSeenAgoMs` and
 * the route stamps `self` on the caller's own entry — the repo is
 * caller-agnostic on purpose.
 */
export interface PresenceViewer {
  readonly userId: string;
  readonly displayName: string;
  readonly compId: string | null;
  readonly playheadTicks: number | null;
  /** ISO-8601 timestamp of the viewer's last heartbeat. */
  readonly lastSeenAt: string;
}

export interface PresenceBeatInput {
  readonly projectId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly compId?: string | null;
  readonly playheadTicks?: number | null;
  /** Sweep window override (ms); default = env PRESENCE_TTL_MS / 240s. */
  readonly ttlMs?: number | null;
}

export interface PresenceViewersOptions {
  readonly ttlMs?: number | null;
}

export interface PresenceRepo {
  /** Upsert this user's heartbeat, sweep stale rows, return live viewers. */
  beat(workspaceId: WorkspaceId, input: PresenceBeatInput): Promise<PresenceViewer[]>;
  /** Sweep stale rows and return the project's live viewers. */
  viewers(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: PresenceViewersOptions,
  ): Promise<PresenceViewer[]>;
}

/** Env override for the sweep window (contracts pin: read at the sweep site). */
function envTtlMs(): number | null {
  const raw = process.env.PRESENCE_TTL_MS;
  if (raw === undefined || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1000) return null;
  return parsed;
}

function ttlMsOf(value: number | null | undefined): number {
  return value === undefined || value === null
    ? (envTtlMs() ?? PRESENCE_TTL_MS)
    : requirePositiveInt(value, "ttlMs");
}

export function createPresenceRepo(db: StudioDb): PresenceRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { presenceHeartbeats, projects, user } = tablesFor(db);
  async function assertProject(workspaceId: WorkspaceId, projectId: string): Promise<string> {
    const id = requireNonEmpty(projectId, "projectId");
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, id), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)),
      )
      .limit(1);
    if (!project) throw DbError.notFound("project");
    return project.id;
  }

  async function assertUser(userId: string): Promise<string> {
    const id = requireNonEmpty(userId, "userId");
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
    if (!row) throw DbError.notFound("user");
    return id;
  }

  /** Per-project sweep: rows idle past the TTL are deleted (ephemeral state). */
  async function sweep(projectId: string, ttlMs: number): Promise<void> {
    const cutoff = new Date(Date.now() - ttlMs);
    await db
      .delete(presenceHeartbeats)
      .where(
        and(eq(presenceHeartbeats.projectId, projectId), lt(presenceHeartbeats.lastSeenAt, cutoff)),
      );
  }

  async function live(projectId: string): Promise<PresenceViewer[]> {
    const rows = await db
      .select({
        userId: presenceHeartbeats.userId,
        displayName: presenceHeartbeats.displayName,
        compId: presenceHeartbeats.compId,
        playheadTicks: presenceHeartbeats.playheadTicks,
        lastSeenAt: presenceHeartbeats.lastSeenAt,
      })
      .from(presenceHeartbeats)
      .where(eq(presenceHeartbeats.projectId, projectId))
      .orderBy(asc(presenceHeartbeats.displayName), asc(presenceHeartbeats.userId));
    return rows.map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      compId: row.compId,
      playheadTicks: row.playheadTicks,
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  }

  return {
    async beat(workspaceId, input) {
      const displayName = requireNonEmpty(input.displayName, "displayName").slice(0, 200);
      const projectId = await assertProject(workspaceId, input.projectId);
      const userId = await assertUser(input.userId);
      const compId =
        input.compId === undefined || input.compId === null ? null : requireCompId(input.compId);
      const playheadTicks =
        input.playheadTicks === undefined || input.playheadTicks === null
          ? null
          : requirePlayheadTicks(input.playheadTicks);
      const ttlMs = ttlMsOf(input.ttlMs);

      const now = new Date();
      await db
        .insert(presenceHeartbeats)
        .values({ projectId, userId, displayName, compId, playheadTicks, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [presenceHeartbeats.projectId, presenceHeartbeats.userId],
          set: { displayName, compId, playheadTicks, lastSeenAt: now },
        });

      await sweep(projectId, ttlMs);
      return live(projectId);
    },

    async viewers(workspaceId, projectId, options) {
      const id = await assertProject(workspaceId, projectId);
      await sweep(id, ttlMsOf(options?.ttlMs));
      return live(id);
    },
  };
}

/** Comp id bound (contracts PRESENCE_COMP_ID_SCHEMA: 1..120 chars). */
function requireCompId(value: string): string {
  const compId = requireNonEmpty(value, "compId");
  if (compId.length > COMP_ID_MAX) {
    throw DbError.validation(`compId must be at most ${COMP_ID_MAX} characters`);
  }
  return compId;
}

/** Playhead bound (contracts PRESENCE_PLAYHEAD_TICKS_MAX; engine ticks ≥ 0). */
function requirePlayheadTicks(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > PLAYHEAD_TICKS_MAX) {
    throw DbError.validation(`playheadTicks must be an integer in [0, ${PLAYHEAD_TICKS_MAX}]`);
  }
  return value;
}
