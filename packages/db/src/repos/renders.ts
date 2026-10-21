import { and, desc, eq, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { type Render, type RenderStatus, projects, renders } from "../schema.js";
import { assertRenderTransition } from "../statuses.js";
import { type WorkspaceId, requireNonEmpty, requireNonNegativeInt } from "./shared.js";

/**
 * Renders repository — queued outputs (§9.1). Status machine:
 * queued → running → completed | failed | cancelled (§7.4, §8.9).
 * Any illegal transition is a typed CONFLICT.
 */
export interface RenderCreateInput {
  readonly projectId: string;
  readonly compId: string;
  readonly format: string;
  readonly settingsJson?: unknown;
  readonly credits?: number;
  readonly createdBy: string;
}

export interface RenderListOptions {
  readonly projectId?: string;
  readonly status?: RenderStatus;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface RendersRepo {
  create(workspaceId: WorkspaceId, input: RenderCreateInput): Promise<Render>;
  markRunning(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  markCompleted(
    workspaceId: WorkspaceId,
    renderId: string,
    result: { objectKey: string },
  ): Promise<Render>;
  markFailed(
    workspaceId: WorkspaceId,
    renderId: string,
    result: { error: string },
  ): Promise<Render>;
  markCancelled(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  get(workspaceId: WorkspaceId, renderId: string): Promise<Render>;
  list(workspaceId: WorkspaceId, options?: RenderListOptions): Promise<Page<Render>>;
}

export function createRendersRepo(db: StudioDb): RendersRepo {
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
    async create(workspaceId, input) {
      const compId = requireNonEmpty(input.compId, "compId");
      const format = requireNonEmpty(input.format, "format");
      requireNonEmpty(input.createdBy, "createdBy");
      requireNonNegativeInt(input.credits ?? 0, "credits");

      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!project) throw DbError.notFound("project");

      const [render] = await db
        .insert(renders)
        .values({
          id: createId("rdr"),
          projectId: project.id,
          compId,
          format,
          settingsJson: input.settingsJson,
          status: "queued",
          credits: input.credits ?? 0,
          createdBy: input.createdBy,
        })
        .returning();
      if (!render) throw DbError.conflict("Could not queue render");
      return render;
    },

    markRunning: (workspaceId, renderId) => transition(workspaceId, renderId, "running", {}),

    markCompleted: (workspaceId, renderId, result) =>
      transition(workspaceId, renderId, "completed", {
        objectKey: result.objectKey,
        completedAt: new Date(),
      }),

    markFailed: (workspaceId, renderId, result) =>
      transition(workspaceId, renderId, "failed", {
        error: result.error,
        completedAt: new Date(),
      }),

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
  };
}
