import { and, desc, eq, lt, or } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import type { StudioDb, StudioTx } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { type Project, type ProjectVersion, projectVersions, projects } from "../schema.js";
import { assertExpectedVersion, buildRestorePlan, nextVersionNumber } from "../version-logic.js";
import { lockProject } from "./projects.js";
import { type WorkspaceId, requireNonEmpty, requireNonNegativeInt } from "./shared.js";

/**
 * Versions repository — immutable snapshots (§9.3).
 *
 * - `upload` is an optimistic-concurrency transaction: the project row is
 *   locked FOR UPDATE, `expectedVersionId` must equal `projects.currentVersionId`
 *   or the caller gets a typed PROJECT_VERSION_CONFLICT, then the version row
 *   is inserted and `currentVersionId` advanced — atomically.
 * - No update paths exist: a version row is written once and never mutated.
 * - `restore` creates a NEW version whose parent is the restored one.
 */
export interface VersionUploadInput {
  readonly projectId: string;
  /** Optimistic concurrency token — must equal the project's currentVersionId. */
  readonly expectedVersionId: string | null;
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly label?: string;
  readonly agentRunId?: string;
  readonly createdBy: string;
}

export interface VersionRestoreInput {
  readonly projectId: string;
  readonly versionId: string;
  readonly createdBy: string;
  /** Optional: stricter than "current at restore time". */
  readonly expectedVersionId?: string | null;
  readonly label?: string;
}

export interface VersionListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface VersionsRepo {
  upload(
    workspaceId: WorkspaceId,
    input: VersionUploadInput,
  ): Promise<{ version: ProjectVersion; project: Project }>;
  restore(
    workspaceId: WorkspaceId,
    input: VersionRestoreInput,
  ): Promise<{ version: ProjectVersion; project: Project }>;
  list(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: VersionListOptions,
  ): Promise<Page<ProjectVersion>>;
  get(workspaceId: WorkspaceId, projectId: string, versionId: string): Promise<ProjectVersion>;
}

interface InsertVersionArgs {
  readonly projectId: string;
  readonly version: number;
  readonly parentVersionId: string | null;
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly label?: string;
  readonly agentRunId?: string;
  readonly createdBy: string;
}

async function insertVersion(tx: StudioTx, args: InsertVersionArgs): Promise<ProjectVersion> {
  const [version] = await tx
    .insert(projectVersions)
    .values({ id: createId("ver"), ...args })
    .returning();
  if (!version) throw DbError.conflict("Could not insert version");
  return version;
}

async function advanceCurrentVersion(
  tx: StudioTx,
  projectId: string,
  versionId: string,
): Promise<Project> {
  const [project] = await tx
    .update(projects)
    .set({ currentVersionId: versionId, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();
  if (!project) throw DbError.notFound("project");
  return project;
}

export function createVersionsRepo(db: StudioDb): VersionsRepo {
  return {
    async upload(workspaceId, input) {
      requireNonEmpty(input.projectId, "projectId");
      requireNonEmpty(input.objectKey, "objectKey");
      requireNonEmpty(input.sha256, "sha256");
      requireNonNegativeInt(input.sizeBytes, "sizeBytes");
      requireNonEmpty(input.createdBy, "createdBy");

      return db.transaction(async (tx) => {
        const project = await lockProject(tx, workspaceId, input.projectId);
        assertExpectedVersion(project.currentVersionId, input.expectedVersionId);

        let parentVersion: number | null = null;
        if (input.expectedVersionId !== null) {
          const [parent] = await tx
            .select({ version: projectVersions.version })
            .from(projectVersions)
            .where(
              and(
                eq(projectVersions.id, input.expectedVersionId),
                eq(projectVersions.projectId, input.projectId),
              ),
            )
            .limit(1);
          if (!parent) throw DbError.notFound("base version");
          parentVersion = parent.version;
        }

        const version = await insertVersion(tx, {
          projectId: input.projectId,
          version: nextVersionNumber(parentVersion),
          parentVersionId: input.expectedVersionId,
          objectKey: input.objectKey,
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
          label: input.label,
          agentRunId: input.agentRunId,
          createdBy: input.createdBy,
        });
        const updated = await advanceCurrentVersion(tx, input.projectId, version.id);
        return { version, project: updated };
      });
    },

    async restore(workspaceId, input) {
      return db.transaction(async (tx) => {
        const project = await lockProject(tx, workspaceId, input.projectId);
        const expected = input.expectedVersionId ?? project.currentVersionId;
        assertExpectedVersion(project.currentVersionId, expected);

        let currentVersionNumber: number | null = null;
        if (project.currentVersionId) {
          const [current] = await tx
            .select({ version: projectVersions.version })
            .from(projectVersions)
            .where(
              and(
                eq(projectVersions.id, project.currentVersionId),
                eq(projectVersions.projectId, input.projectId),
              ),
            )
            .limit(1);
          if (!current) throw DbError.notFound("current version");
          currentVersionNumber = current.version;
        }

        const [source] = await tx
          .select()
          .from(projectVersions)
          .where(
            and(
              eq(projectVersions.id, input.versionId),
              eq(projectVersions.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (!source) throw DbError.notFound("version");

        // §9.3: restoring creates a NEW version with parent = the restored one.
        const plan = buildRestorePlan({
          currentVersionNumber,
          source: {
            id: source.id,
            version: source.version,
            objectKey: source.objectKey,
            sha256: source.sha256,
            sizeBytes: source.sizeBytes,
          },
          label: input.label,
        });

        const version = await insertVersion(tx, {
          projectId: input.projectId,
          version: plan.version,
          parentVersionId: plan.parentVersionId,
          objectKey: plan.objectKey,
          sha256: plan.sha256,
          sizeBytes: plan.sizeBytes,
          label: plan.label,
          createdBy: input.createdBy,
        });
        const updated = await advanceCurrentVersion(tx, input.projectId, version.id);
        return { version, project: updated };
      });
    },

    async list(workspaceId, projectId, options) {
      // Cross-tenant project ids read as 404 (§12.1).
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (project.length === 0) throw DbError.notFound("project");

      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select()
        .from(projectVersions)
        .where(
          and(
            eq(projectVersions.projectId, projectId),
            cursor
              ? or(
                  lt(projectVersions.createdAt, new Date(cursor.t)),
                  and(
                    eq(projectVersions.createdAt, new Date(cursor.t)),
                    lt(projectVersions.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(projectVersions.createdAt), desc(projectVersions.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
      };
    },

    async get(workspaceId, projectId, versionId) {
      const [row] = await db
        .select({ version: projectVersions })
        .from(projectVersions)
        .innerJoin(projects, eq(projectVersions.projectId, projects.id))
        .where(
          and(
            eq(projectVersions.id, versionId),
            eq(projectVersions.projectId, projectId),
            eq(projects.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!row) throw DbError.notFound("version");
      return row.version;
    },
  };
}
