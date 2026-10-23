// Projects list wire types (W2-04, §8.5) — the §7.2 `projects` row restated
// for BOTH sides of the /w/projects surface:
//
// - the RSC route + the `loadProjectsPage` server action parse the gateway's
//   payload server-side (tolerantly — malformed rows are skipped, never
//   crash the page; law #1), and
// - the client view (`projects-list-view.tsx`) receives the rows as props /
//   port results.
//
// apps/web never runtime-imports the `@studio/contracts` barrel (Turbopack
// constraint, see lib/gateway.ts) — this module restates the one wire shape
// the page consumes, exactly like the billing page's `MembershipWire`.
//
// W2-B4: `thumbnailUrl` is deliberately NOT restated — the gateway sends the
// field (contracts Project) but nothing consumes it in apps/web (every card
// renders the slate empty state; no producer writes a thumbnail key), so
// restating it here was a dead wire field.

/** One `GET /v1/projects` row (§7.2 `Project`; W1-c `archived` lifecycle). */
export interface ProjectsListRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  /** §9.1 lifecycle flag: archived ≠ deleted — rows stay readable. */
  readonly archived: boolean;
  readonly currentVersionId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** Page size for the projects browser (§8.5 "Load more"; §7.2 max 100). */
export const PROJECTS_PAGE_LIMIT = 50;

/** The RSC/`use client` page result of one list read (typed envelope, law #1). */
export interface ProjectsPageOk {
  readonly ok: true;
  readonly items: readonly ProjectsListRow[];
  readonly nextCursor: string | null;
}

/** §7.3-shaped failure (message + hint + request id — never a stack). */
export interface ProjectsPageError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

export interface ProjectsPageErr {
  readonly ok: false;
  readonly error: ProjectsPageError;
}

export type ProjectsPageResult = ProjectsPageOk | ProjectsPageErr;

// ---------------------------------------------------------------------------
// Tolerant parsing (hostile wire never crashes the page)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** One wire row → {@link ProjectsListRow}; malformed anywhere → null (skipped). */
export function parseProjectsListRow(value: unknown): ProjectsListRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.archived !== "boolean" ||
    typeof value.createdBy !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    name: value.name,
    slug: value.slug,
    archived: value.archived,
    currentVersionId: stringOrNull(value.currentVersionId),
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: stringOrNull(value.deletedAt),
  };
}

/** One `GET /v1/projects` page → ok/err result (malformed payload → empty page). */
export function parseProjectsPage(value: unknown): ProjectsPageOk {
  const items: ProjectsListRow[] = [];
  if (isRecord(value) && Array.isArray(value.items)) {
    for (const raw of value.items) {
      const row = parseProjectsListRow(raw);
      if (row !== null) items.push(row);
    }
  }
  const cursor = isRecord(value) ? stringOrNull(value.nextCursor) : null;
  return { ok: true, items, nextCursor: cursor === null ? null : cursor };
}
