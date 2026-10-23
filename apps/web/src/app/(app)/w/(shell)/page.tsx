import { notFound, redirect } from "next/navigation";

import {
  type DashboardLoadError,
  type DashboardProject,
  DashboardView,
} from "@/components/dashboard/dashboard-view";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";
import {
  canEditProjects,
  classifyGatewayError,
  parseMemberships,
  resolveActiveWorkspace,
  signInPath,
} from "@/lib/workspace-membership";

/**
 * The dashboard route (BUILD_PLAN §M9 core page; UI_DESIGN_SYSTEM §8.4).
 *
 * `/w` — the workspace home: greeting, primary actions, the Recent grid.
 * The RSC half resolves the workspace through the shared shell seam
 * (lib/workspace-membership) and fetches the ONE projects read
 * (`GET /v1/projects` page 1, limit 12) through the gateway seam, then
 * hands the client view (`components/dashboard/dashboard-view.tsx`) a
 * serializable payload. Every mutation (create, import) goes through
 * `@studio/api-client` same-origin with the workspace header.
 *
 * - `/v1/me → memberships`, honoring `?ws=<id or slug>` (the
 *   workspace-switcher seam; v1 defaults to the first membership); an
 *   explicit-but-unknown `?ws` is a 404 (hard rule 3).
 * - NO membership → `/onboarding` (the first-run journey, W2-02 — the shell
 *   layout redirects too; the page repeats the redirect so it stays
 *   self-contained).
 * - Expired session → `/sign-in` with a `next` round-trip (the proxy only
 *   checks cookie presence; the gateway checks validity).
 * - A failed projects read does NOT break the page (§8.4 error law): the
 *   view renders with the sanitized §7.3 message + a client-side retry —
 *   the rest of the page stays usable. Only session death (401) and the
 *   cross-tenant/missing-workspace 404 escape as redirects/404.
 */

export const metadata = pageMetadata({
  title: "Workspace",
  description: "Your recent projects and quick actions.",
  path: "/w",
});

// ---------------------------------------------------------------------------
// Wire shapes consumed (§7.2, type-only restatements — see lib/gateway.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `GET /v1/projects` page → dashboard rows. Tolerant by design: malformed
 * rows are dropped, never rendered and never crashed on (law #1).
 */
function parseProjectRows(value: unknown): readonly DashboardProject[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  const out: DashboardProject[] = [];
  for (const raw of value.items) {
    if (!isRecord(raw)) continue;
    if (
      typeof raw.id !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.slug !== "string" ||
      typeof raw.updatedAt !== "string"
    ) {
      continue;
    }
    out.push({ id: raw.id, name: raw.name, slug: raw.slug, updatedAt: raw.updatedAt });
  }
  return out;
}

/** The `GET /v1/me` user block's display name (tolerant; null when absent). */
function parseUserName(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  const name = value.user.name;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface DashboardPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

/** The dashboard's read of the projects list (manifest W2-03: page 1, 12). */
const PROJECTS_QUERY = "/v1/projects?limit=12";

/** `/sign-in` round-trip target — the dashboard's own path. */
const SIGN_IN_NEXT = "/w";

/**
 * Classify a failure on the PROJECTS read (§8.4 error law): session death
 * and cross-tenant/missing-workspace 404s escape (redirect/404); every
 * other failure degrades to the inline banner payload so the page stays
 * usable. Never rethrows raw errors at the user (law #1).
 */
function projectsReadError(error: unknown): DashboardLoadError {
  if (isGatewayHttpError(error)) {
    return { message: error.message, hint: error.hint, requestId: error.requestId };
  }
  return { message: "Your projects could not be loaded.", hint: "Try again in a moment." };
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const { ws } = await searchParams;

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
    // First-run journey (W2-02): create a workspace before entering /w.
    redirect("/onboarding");
  }
  if (resolution.status === "unknown-workspace") {
    notFound();
  }
  const { membership } = resolution;

  let projects: readonly DashboardProject[] | null = null;
  let loadError: DashboardLoadError | null = null;
  try {
    const page = await gatewayCall<unknown>(PROJECTS_QUERY, {
      workspaceId: membership.workspaceId,
    });
    projects = parseProjectRows(page);
  } catch (error) {
    if (isGatewayHttpError(error)) {
      if (error.status === 401 || error.code === "UNAUTHORIZED") {
        redirect(signInPath(SIGN_IN_NEXT));
      }
      if (error.isNotFound) notFound();
    }
    loadError = projectsReadError(error);
  }

  return (
    <DashboardView
      workspaceId={membership.workspaceId}
      userName={parseUserName(me)}
      nowIso={new Date().toISOString()}
      initialProjects={projects}
      initialError={loadError}
      canEdit={canEditProjects(membership.role)}
    />
  );
}
