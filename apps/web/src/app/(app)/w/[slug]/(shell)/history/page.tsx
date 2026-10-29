import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { HistoryPageView } from "@/components/versions/history-view";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";
import type { ProjectResolve } from "@studio/contracts";

/**
 * The project history route (BUILD_PLAN §M7 task 4): `/w/:slug/history` —
 * the version timeline (labels, §9.3 restore-with-confirmation, diff
 * summaries) and the activity feed, plus the admin-only audit export.
 *
 * RSC resolution: `GET /v1/projects/resolve/:slug` — ONE gateway call (one
 * auth pass + one joined SQL; the perf round's TTFB fix). The pre-fix code
 * mirrored the editor route's fan-out (`/v1/me` → per-workspace project
 * pages → manifest-shaped reads), paying the auth+workspace middleware once
 * per call — ~90 sequential DB roundtrips on a many-workspace account.
 * `?ws=<id or slug>` narrows the resolution (the workspace-switcher seam; an
 * explicit-but-unknown `?ws` 404s, hard rule 3). On a 404 the resolution
 * falls back to a single `/v1/me` ONLY to keep the honest empty state: a
 * user with no workspaces at all sees `no-workspace`, everyone else a 404.
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
// (parseViewerId removed with the scan: the resolve endpoint carries
// `viewerId` directly.)

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
    const query = ws === undefined ? "" : `?workspace=${encodeURIComponent(ws)}`;
    let resolved: ProjectResolve;
    try {
      resolved = await gatewayCall<ProjectResolve>(
        `/v1/projects/resolve/${encodeURIComponent(slug)}${query}`,
      );
    } catch (error) {
      // Keep the two honest 404 flavors: a user with NO workspaces at all
      // sees the no-workspace empty state; everyone else a plain 404. This
      // single `/v1/me` fires only on the resolution-404 path.
      if (isGatewayHttpError(error) && error.isNotFound) {
        const me = await gatewayCall<unknown>("/v1/me");
        if (parseMemberships(me).length === 0) {
          return { status: "no-workspace" };
        }
        return { status: "missing" };
      }
      throw error;
    }
    return {
      status: "ready",
      payload: {
        project: {
          id: resolved.project.id,
          name: resolved.project.name,
          slug: resolved.project.slug,
          currentVersionId: resolved.project.currentVersionId,
          createdBy: resolved.project.createdBy,
        },
        workspaceId: resolved.workspaceId,
        // Gateway re-checks every capability (viewer+ reads, editor+
        // mutations, admin export); these flags only shape the UI.
        canEdit:
          resolved.role === "owner" || resolved.role === "admin" || resolved.role === "editor",
        canExport: resolved.role === "owner" || resolved.role === "admin",
        viewerId: resolved.viewerId,
      },
    };
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
