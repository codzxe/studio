import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";

import { ProjectsListView } from "@/components/projects/projects-list-view";
import {
  PROJECTS_PAGE_LIMIT,
  type ProjectsListRow,
  parseProjectsPage,
} from "@/components/projects/projects-wire";
import { gatewayCall } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";
import {
  canEditProjects,
  classifyGatewayError,
  parseMemberships,
  resolveActiveWorkspace,
  signInPath,
} from "@/lib/workspace-membership";

/**
 * The projects browser route (W2-04, UI_DESIGN_SYSTEM §8.5).
 *
 * `/w/projects` — ONE server-side list read (`GET /v1/projects?limit=50`, the
 * ACTIVE unarchived window) through the RSC gateway seam, then the client
 * view (`components/projects/projects-list-view.tsx`) owns every interaction:
 * filters, sorts, debounced search (the loaded window — see the honest-limit
 * note there), bulk actions and "Load more" cursor pages (the
 * `loadProjectsPage` server action in ./actions.ts).
 *
 * - Workspace resolution: `/v1/me → memberships` honoring `?ws=<id or slug>`
 *   (the workspace-switcher seam — v1 defaults to the first membership); an
 *   explicit-but-unknown `?ws` is a 404 (hard rule 3).
 * - Expired session → `/sign-in` with a `next` round-trip.
 * - `me.user.id` rides the payload (the Mine/Shared client-side filters);
 *   the role maps to the bulk-mutation affordances (`canEditProjects` — the
 *   gateway re-checks every capability).
 * - Malformed rows are skipped, never a crash (law #1); a malformed page
 *   degrades to the honest empty window and the client can still load.
 */

export const metadata = pageMetadata({
  title: "Projects",
  description: "Every project in this workspace.",
  path: "/w/projects",
});

/** The `/v1/me` user block — only `id` matters for Mine/Shared. */
function parseUserId(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { user?: unknown }).user === "object" &&
    (value as { user: unknown }).user !== null
  ) {
    const user = (value as { user: Record<string, unknown> }).user;
    if (typeof user.id === "string") return user.id;
  }
  return "";
}

const SIGN_IN_NEXT = "/w/projects";

interface ProjectsPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const { ws } = await searchParams;

  // -- membership resolution (the W2-01 lib seam) ------------------------------
  let me: unknown;
  try {
    me = await gatewayCall<unknown>("/v1/me");
  } catch (error) {
    const verdict = classifyGatewayError(error, SIGN_IN_NEXT);
    if (verdict.action === "sign-in") redirect(signInPath(verdict.next));
    if (verdict.action === "not-found") notFound();
    throw verdict.error;
  }

  const memberships = parseMemberships(me);
  const resolution = resolveActiveWorkspace(memberships, ws);
  if (resolution.status === "no-workspace") {
    // The (shell) layout redirects no-membership users to /onboarding before
    // this renders; kept as the honest arm, never a crash.
    return (
      <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
        <EmptyState
          data-testid="projects-no-workspace"
          title="You don't belong to a workspace yet."
          secondaryLink={{ label: "Back to the site", href: "/" }}
        />
      </main>
    );
  }
  if (resolution.status === "unknown-workspace") {
    // Hard rule 3: an explicit-but-unknown ?ws is a 404, never a 403.
    notFound();
  }

  const membership = resolution.membership;

  // -- the ONE list read: active window, page 1 (limit 50) ----------------------
  let page: { items: readonly ProjectsListRow[]; nextCursor: string | null };
  try {
    const payload = await gatewayCall<unknown>(`/v1/projects?limit=${PROJECTS_PAGE_LIMIT}`, {
      workspaceId: membership.workspaceId,
    });
    const parsed = parseProjectsPage(payload);
    page = { items: parsed.items, nextCursor: parsed.nextCursor };
  } catch (error) {
    const verdict = classifyGatewayError(error, SIGN_IN_NEXT);
    if (verdict.action === "sign-in") redirect(signInPath(verdict.next));
    if (verdict.action === "not-found") notFound();
    throw verdict.error;
  }

  return (
    <ProjectsListView
      workspaceId={membership.workspaceId}
      workspaceName={membership.workspace.name}
      userId={parseUserId(me)}
      canEdit={canEditProjects(membership.role)}
      initialItems={page.items}
      initialNextCursor={page.nextCursor}
      nowIso={new Date().toISOString()}
    />
  );
}
