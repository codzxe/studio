import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { HistoryPageView } from "@/components/versions/history-view";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";

/**
 * The project history route (BUILD_PLAN §M7 task 4): `/w/:slug/history` —
 * the version timeline (labels, §9.3 restore-with-confirmation, diff
 * summaries) and the activity feed, plus the admin-only audit export.
 *
 * RSC resolution mirrors the editor route: the project is resolved by slug
 * across the user's workspaces (`/v1/me → memberships`, then each workspace's
 * project pages matched on `slug` — there is no by-slug gateway endpoint).
 * `?ws=<id or slug>` narrows the scan (the workspace-switcher seam; an
 * explicit-but-unknown `?ws` is a 404, hard rule 3).
 *
 * - Missing project, soft-deleted project, or a project in a workspace this
 *   user is not a member of → `notFound()` (hard rule 3: cross-tenant 404).
 * - Expired session → `/sign-in` with a `next` round-trip.
 * - No memberships → an honest empty state (never a stack, law #1).
 *
 * The client view owns every list fetch and mutation through
 * `@studio/api-client` same-origin with the workspace header; this route
 * hands over ONE serializable payload: ids, display name, the current
 * version id, the caller's role-derived permissions, the caller's user id
 * (`viewerId` — hub "You" labels) and the project's creator id (`ownerId` —
 * resolved to a name on the Overview tab), and an `nowIso` stamp
 * (deterministic relative times).
 */

// ---------------------------------------------------------------------------
// Wire shapes consumed (§7.2, type-only restatements — see lib/gateway.ts)
// ---------------------------------------------------------------------------

interface MembershipWire {
  readonly workspaceId: string;
  readonly role: "owner" | "admin" | "editor" | "viewer";
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
}

interface ProjectRowWire {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly deletedAt: string | null;
  readonly currentVersionId: string | null;
  readonly createdBy: string | null;
}

/** Bounded slug scan: §7.2 pages are 50 rows; 4 pages per workspace is ample. */
const PROJECT_PAGE_LIMIT = 50;
const MAX_PROJECT_PAGES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemberships(value: unknown): MembershipWire[] {
  if (!isRecord(value) || !Array.isArray(value.memberships)) return [];
  const out: MembershipWire[] = [];
  for (const raw of value.memberships) {
    if (!isRecord(raw) || !isRecord(raw.workspace)) continue;
    if (
      typeof raw.workspaceId !== "string" ||
      typeof raw.workspace.id !== "string" ||
      typeof raw.workspace.name !== "string" ||
      typeof raw.workspace.slug !== "string" ||
      typeof raw.role !== "string"
    ) {
      continue;
    }
    const role =
      raw.role === "owner" || raw.role === "admin" || raw.role === "editor" || raw.role === "viewer"
        ? raw.role
        : "viewer";
    out.push({
      workspaceId: raw.workspaceId,
      role,
      workspace: {
        id: raw.workspace.id,
        name: raw.workspace.name,
        slug: raw.workspace.slug,
      },
    });
  }
  return out;
}

/** The calling user's id from `/v1/me` (hub "You" labels); malformed → null. */
function parseViewerId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  return typeof value.user.id === "string" ? value.user.id : null;
}

function parseProjectRow(value: unknown): ProjectRowWire | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.name !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    deletedAt: typeof value.deletedAt === "string" ? value.deletedAt : null,
    currentVersionId: typeof value.currentVersionId === "string" ? value.currentVersionId : null,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : null,
  };
}

async function listProjects(
  workspaceId: string,
  cursor?: string,
): Promise<{ items: ProjectRowWire[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(PROJECT_PAGE_LIMIT) });
  if (cursor !== undefined) query.set("cursor", cursor);
  const data = await gatewayCall<{ items?: unknown; nextCursor?: unknown }>(
    `/v1/projects?${query.toString()}`,
    { workspaceId },
  );
  const rows = Array.isArray(data?.items) ? data.items : [];
  const items = rows.map(parseProjectRow).filter((row): row is ProjectRowWire => row !== null);
  return { items, nextCursor: typeof data?.nextCursor === "string" ? data.nextCursor : null };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface HistoryPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

interface HistoryResolutionProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly currentVersionId: string | null;
  readonly createdBy: string | null;
}

type HistoryResolution =
  | { readonly status: "no-workspace" }
  | { readonly status: "missing" }
  | {
      readonly status: "ready";
      readonly payload: {
        readonly project: HistoryResolutionProject;
        readonly workspaceId: string;
        readonly canEdit: boolean;
        readonly canExport: boolean;
        readonly viewerId: string | null;
      };
    };

/**
 * Resolve the project by slug (optionally narrowed to `?ws`), wrapped in
 * `cache()` so `generateMetadata` and the page share ONE resolution.
 */
const resolveHistoryProject = cache(
  async (slug: string, ws: string | undefined): Promise<HistoryResolution> => {
    const me = await gatewayCall<unknown>("/v1/me");
    const memberships = parseMemberships(me);
    if (memberships.length === 0) {
      return { status: "no-workspace" };
    }
    const viewerId = parseViewerId(me);

    // ?ws=<id or slug> — the workspace-switcher seam; unknown → 404 (rule 3).
    const scoped =
      ws === undefined
        ? memberships
        : memberships.filter(
            (membership) =>
              membership.workspaceId === ws ||
              membership.workspace.slug === ws ||
              membership.workspace.id === ws,
          );
    if (ws !== undefined && scoped.length === 0) {
      return { status: "missing" };
    }

    for (const membership of scoped) {
      let cursor: string | undefined = undefined;
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        const { items, nextCursor } = await listProjects(membership.workspaceId, cursor);
        const match = items.find((project) => project.slug === slug && project.deletedAt === null);
        if (match !== undefined) {
          return {
            status: "ready",
            payload: {
              project: {
                id: match.id,
                name: match.name,
                slug: match.slug,
                currentVersionId: match.currentVersionId,
                createdBy: match.createdBy,
              },
              workspaceId: membership.workspaceId,
              // Gateway re-checks every capability (viewer+ reads, editor+
              // mutations, admin export); these flags only shape the UI.
              canEdit:
                membership.role === "owner" ||
                membership.role === "admin" ||
                membership.role === "editor",
              canExport: membership.role === "owner" || membership.role === "admin",
              viewerId,
            },
          };
        }
        if (nextCursor === null) break;
        cursor = nextCursor;
      }
    }
    return { status: "missing" };
  },
);

async function loadHistoryPage(slug: string, ws: string | undefined): Promise<HistoryResolution> {
  try {
    return await resolveHistoryProject(slug, ws);
  } catch (error) {
    if (isGatewayHttpError(error)) {
      if (error.status === 401 || error.code === "UNAUTHORIZED") {
        redirect(`/sign-in?next=${encodeURIComponent(`/w/${slug}/history`)}`);
      }
      if (error.isNotFound) notFound();
      // Other gateway failures: sanitized typed error → the Next error boundary.
      throw error;
    }
    throw error;
  }
}

export async function generateMetadata({ params, searchParams }: HistoryPageProps) {
  const { slug } = await params;
  const { ws } = await searchParams;
  const resolution = await loadHistoryPage(slug, ws);
  const name = resolution.status === "ready" ? resolution.payload.project.name : undefined;
  return pageMetadata({
    title: name === undefined ? "History" : `${name} — history`,
    description:
      name === undefined
        ? "The version timeline and activity for a project."
        : `Versions and activity for “${name}”.`,
    path: `/w/${slug}/history`,
  });
}

export default async function HistoryPage({ params, searchParams }: HistoryPageProps) {
  const { slug } = await params;
  const { ws } = await searchParams;
  const resolution = await loadHistoryPage(slug, ws);

  if (resolution.status === "no-workspace") {
    return (
      <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
        <EmptyState
          data-testid="history-no-workspace"
          title="You don't belong to a workspace yet."
          secondaryLink={{ label: "Back to the site", href: "/" }}
        />
      </main>
    );
  }

  if (resolution.status === "missing") {
    notFound();
  }

  const { project, workspaceId, canEdit, canExport, viewerId } = resolution.payload;
  return (
    <HistoryPageView
      projectId={project.id}
      projectName={project.name}
      workspaceId={workspaceId}
      slug={project.slug}
      currentVersionId={project.currentVersionId}
      canEdit={canEdit}
      canExport={canExport}
      viewerId={viewerId}
      ownerId={project.createdBy}
      nowIso={new Date().toISOString()}
    />
  );
}
