import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { type Page, clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { type StudioDb, type StudioTx, getDialect } from "../db.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import type { Asset, Project, ProjectVersion } from "../schema.js";
import { ensureUniqueSlug, slugify } from "../slug.js";
import { tablesFor } from "../tables.js";
import { type WorkspaceId, isUniqueViolation } from "./shared.js";

/**
 * Projects repository — tenant-scoped (§12.1): every method filters by
 * workspaceId; cross-tenant ids read as NOT_FOUND. Signed URLs are NOT built
 * here — the manifest returns `objectKey`s only; the gateway signs.
 */
export interface ProjectCreateInput {
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly thumbnailUrl?: string;
  readonly createdBy: string;
}

export interface ProjectPatchInput {
  readonly name?: string;
  readonly description?: string;
  readonly thumbnailUrl?: string;
  /** W1-c (§9.1): lifecycle toggle — orthogonal to the deletedAt soft delete. */
  readonly archived?: boolean;
}

export interface ProjectListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly includeDeleted?: boolean;
  /**
   * W1-c (§9.1): default (false/omitted) EXCLUDES archived projects;
   * true returns ONLY archived ones. Soft-deleted rows stay excluded
   * unless `includeDeleted` is set.
   */
  readonly archivedOnly?: boolean;
}

export interface AssetManifestEntry {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationTicks: number | null;
}

export interface ProjectManifest {
  readonly project: Project;
  readonly currentVersion: ProjectVersion | null;
  readonly assets: readonly AssetManifestEntry[];
}

export interface ProjectsRepo {
  create(workspaceId: WorkspaceId, input: ProjectCreateInput): Promise<Project>;
  list(workspaceId: WorkspaceId, options?: ProjectListOptions): Promise<Page<Project>>;
  get(
    workspaceId: WorkspaceId,
    projectId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Project>;
  patch(workspaceId: WorkspaceId, projectId: string, input: ProjectPatchInput): Promise<Project>;
  softDelete(workspaceId: WorkspaceId, projectId: string): Promise<Project>;
  manifest(workspaceId: WorkspaceId, projectId: string): Promise<ProjectManifest>;
  /**
   * By-slug resolution across the USER's own memberships (the perf fix for
   * the /w/:slug/editor TTFB: replaces the RSC's `/v1/me` + per-workspace
   * project-page scan + manifest fetch — ~90 sequential DB roundtrips on a
   * many-workspace account — with ONE joined query). List-view parity: only
   * LIVE projects (deleted_at NULL, archived FALSE) are resolvable, matching
   * what the page scan could ever see. `workspaceFilter` (id or slug)
   * narrows the search (the history page's `?ws=`); a slug living in several
   * of the user's workspaces resolves most-recently-updated first.
   */
  resolveBySlug(
    userId: string,
    slug: string,
    workspaceFilter?: string | null,
  ): Promise<{
    workspaceId: WorkspaceId;
    workspaceName: string;
    workspaceSlug: string;
    role: string;
    project: Project;
  } | null>;
  /**
   * W1-c (§M2.5 maxProjects quota): live (non-soft-deleted) project count
   * for a workspace. Archived rows COUNT — archiving hides a project from
   * the default list but its bytes stay in storage, so it keeps consuming
   * the plan's project allowance; only the deleted_at recovery window
   * releases a slot.
   */
  countActive(workspaceId: WorkspaceId): Promise<number>;
}

/** Lock a project row in a transaction (single-writer / version-advance path). */
export async function lockProject(
  tx: StudioTx,
  workspaceId: WorkspaceId,
  projectId: string,
): Promise<Project> {
  // Dialect-aware tables: the pg table's defaults/mappers never run on a
  // sqlite dev handle (tables.ts seam).
  const { projects } = tablesFor(tx);
  // SQLite dev server: one serialized connection — the row lock is dropped
  // (the surrounding transaction is already exclusive); pg keeps FOR UPDATE.
  const baseQuery = tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  const [project] = getDialect(tx) === "sqlite" ? await baseQuery : await baseQuery.for("update");
  if (!project) throw DbError.notFound("project");
  return project;
}

export function createProjectsRepo(db: StudioDb): ProjectsRepo {
  // Dialect-aware tables (W3-A): on a sqlite dev handle these are the twin
  // tables (integer-ms timestamps, 0/1 booleans) — the pg table's now()
  // defaults and Date→ISO mappers are unrunnable there.
  const { projects, projectVersions, assets } = tablesFor(db);
  return {
    async create(workspaceId, input) {
      const name = input.name.trim();
      if (!name) throw DbError.validation("Project name is required");
      const createdBy = input.createdBy.trim();
      if (!createdBy) throw DbError.validation("createdBy is required");

      const slugBase = slugify(input.slug !== undefined && input.slug !== "" ? input.slug : name);
      const takenRows = await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId));
      const taken = new Set(takenRows.map((row) => row.slug));
      const slug = ensureUniqueSlug(slugBase, taken);

      try {
        const [project] = await db
          .insert(projects)
          .values({
            id: createId("prj"),
            workspaceId,
            name,
            slug,
            description: input.description,
            thumbnailUrl: input.thumbnailUrl,
            createdBy,
            currentVersionId: null,
          })
          .returning();
        if (!project) throw DbError.conflict("Could not create project");
        return project;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw DbError.conflict(
            "Project slug already taken in this workspace",
            "Try another name.",
          );
        }
        throw error;
      }
    },

    async list(workspaceId, options) {
      const limit = clampLimit(options?.limit);
      const cursor = decodeCursor(options?.cursor ?? null);
      const rows = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            options?.includeDeleted ? undefined : isNull(projects.deletedAt),
            // W1-c: archived filter (§9.1) — default view hides archived rows;
            // archivedOnly flips to the archived-only view.
            options?.archivedOnly ? eq(projects.archived, true) : eq(projects.archived, false),
            cursor
              ? or(
                  lt(projects.updatedAt, new Date(cursor.t)),
                  and(eq(projects.updatedAt, new Date(cursor.t)), lt(projects.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(projects.updatedAt), desc(projects.id))
        .limit(limit + 1);

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }) : null,
      };
    },

    async get(workspaceId, projectId, options) {
      const [project] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.workspaceId, workspaceId),
            options?.includeDeleted ? undefined : isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project) throw DbError.notFound("project");
      return project;
    },

    async patch(workspaceId, projectId, input) {
      const values: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw DbError.validation("Project name cannot be empty");
        values.name = name;
      }
      if (input.description !== undefined) values.description = input.description;
      if (input.thumbnailUrl !== undefined) values.thumbnailUrl = input.thumbnailUrl;
      // W1-c (§9.1): archived is a lifecycle toggle, not a deletion — the row
      // keeps its versions, leases and audit trail and stays readable by id.
      if (input.archived !== undefined) values.archived = input.archived;

      const [project] = await db
        .update(projects)
        .set(values)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.workspaceId, workspaceId),
            isNull(projects.deletedAt),
          ),
        )
        .returning();
      if (!project) throw DbError.notFound("project");
      return project;
    },

    async softDelete(workspaceId, projectId) {
      const now = new Date();
      const [project] = await db
        .update(projects)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.workspaceId, workspaceId),
            isNull(projects.deletedAt),
          ),
        )
        .returning();
      if (!project) throw DbError.notFound("project");
      return project;
    },

    async countActive(workspaceId) {
      const [row] = await db
        .select({ count: sql<string>`count(*)` })
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)));
      return Number(row?.count ?? 0);
    },

    async manifest(workspaceId, projectId) {
      const project = await this.get(workspaceId, projectId);
      const currentVersion = project.currentVersionId
        ? ((
            await db
              .select()
              .from(projectVersions)
              .where(eq(projectVersions.id, project.currentVersionId))
              .limit(1)
          ).at(0) ?? null)
        : null;

      // Project-scoped assets + the workspace library (projectId IS NULL).
      const rows: Asset[] = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.workspaceId, workspaceId),
            or(eq(assets.projectId, projectId), isNull(assets.projectId)),
          ),
        )
        .orderBy(desc(assets.createdAt));

      return {
        project,
        currentVersion,
        assets: rows.map((asset) => ({
          id: asset.id,
          projectId: asset.projectId,
          name: asset.name,
          mime: asset.mime,
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
          objectKey: asset.objectKey,
          width: asset.width,
          height: asset.height,
          durationTicks: asset.durationTicks,
        })),
      };
    },

    async resolveBySlug(userId, slug, workspaceFilter) {
      // ONE joined query: memberships × live projects with this slug. The
      // member_user_idx carries the user cut; organization joins in for the
      // slug form of the workspace filter (id-or-slug, the history ?ws=).
      const { projects, member, organization } = tablesFor(db);
      const [row] = await db
        .select({
          project: projects,
          workspaceId: member.organizationId,
          workspaceName: organization.name,
          workspaceSlug: organization.slug,
          role: member.role,
        })
        .from(member)
        .innerJoin(projects, eq(projects.workspaceId, member.organizationId))
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(
            eq(member.userId, userId),
            eq(projects.slug, slug),
            isNull(projects.deletedAt),
            eq(projects.archived, false),
            workspaceFilter
              ? or(eq(member.organizationId, workspaceFilter), eq(organization.slug, workspaceFilter))
              : undefined,
          ),
        )
        .orderBy(desc(projects.updatedAt), desc(projects.id))
        .limit(1);
      if (row === undefined) return null;
      return {
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        workspaceSlug: row.workspaceSlug,
        role: row.role,
        project: row.project,
      };
    },
  };
}
