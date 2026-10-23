import { isGatewayHttpError } from "./gateway";

/**
 * Workspace membership resolution (W2-01, the app-shell task) — the RSC seam
 * every `/w` page shares, extracted from the billing/history route pattern so
 * Wave-2 pages (W2-02..08) resolve workspaces identically:
 *
 * 1. `GET /v1/me → memberships` (the wire restated by {@link parseMemberships}
 *    — apps/web never runtime-imports the contracts barrel; the api-client
 *    zod-validates CLIENT-side refreshes).
 * 2. `?ws=<id or slug>` — the workspace-switcher seam. No `?ws` → the FIRST
 *    membership (the established v1 default; the gateway's session-scoped
 *    active org is kept in sync by `members.switchWorkspace`). An
 *    explicit-but-unknown `?ws` is a 404 (hard rule 3: cross-tenant = 404,
 *    never 403).
 * 3. 401/UNAUTHORIZED on any gateway read → `/sign-in?next=<current path>`
 *    (the proxy only checks cookie presence; the gateway checks validity).
 *
 * SERVER-ONLY: this module imports `@/lib/gateway` (which imports
 * `next/headers`). RSC layouts/pages import it; client components must NOT —
 * client-side `?ws` matching is a plain inline find over the parsed payload.
 */

/** Workspace roles as the wire carries them (contracts `Role`). */
export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

/** One membership row of `GET /v1/me` (contracts `Membership`). */
export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
}

// ---------------------------------------------------------------------------
// Wire parsing (the §7.2 shape restated — malformed rows are skipped, never
// crash the page; law #1: no stack ever reaches the user)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRole(value: unknown): WorkspaceRole {
  return value === "owner" || value === "admin" || value === "editor" || value === "viewer"
    ? value
    : "viewer";
}

/**
 * Parse the `GET /v1/me` payload's `memberships` array. Anything malformed →
 * an empty/shorter list (the caller decides what an empty list means for its
 * page; the shell layout redirects to `/onboarding`).
 */
export function parseMemberships(value: unknown): WorkspaceMembership[] {
  if (!isRecord(value) || !Array.isArray(value.memberships)) return [];
  const out: WorkspaceMembership[] = [];
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
    out.push({
      workspaceId: raw.workspaceId,
      role: parseRole(raw.role),
      workspace: {
        id: raw.workspace.id,
        name: raw.workspace.name,
        slug: raw.workspace.slug,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ?ws resolution
// ---------------------------------------------------------------------------

/**
 * Match a `?ws=` candidate (org id, workspace id or slug) against the parsed
 * memberships. `null` when the candidate matches nothing (the caller's 404
 * arm — hard rule 3).
 */
export function findMembership(
  memberships: readonly WorkspaceMembership[],
  candidate: string,
): WorkspaceMembership | null {
  return (
    memberships.find(
      (membership) =>
        membership.workspaceId === candidate ||
        membership.workspace.id === candidate ||
        membership.workspace.slug === candidate,
    ) ?? null
  );
}

/** The outcome of resolving the active workspace for one page load. */
export type WorkspaceResolution =
  | { readonly status: "no-workspace" }
  | { readonly status: "unknown-workspace" }
  | { readonly status: "ready"; readonly membership: WorkspaceMembership };

/**
 * Resolve the active workspace: `?ws` wins; no `?ws` → the FIRST membership
 * (v1 default — mirrors the billing/history routes); no memberships at all →
 * `no-workspace`; an explicit-but-unknown `?ws` → `unknown-workspace` (404).
 */
export function resolveActiveWorkspace(
  memberships: readonly WorkspaceMembership[],
  ws: string | undefined,
): WorkspaceResolution {
  if (memberships.length === 0) return { status: "no-workspace" };
  if (ws === undefined) {
    const first = memberships[0];
    if (first === undefined) return { status: "no-workspace" };
    return { status: "ready", membership: first };
  }
  const match = findMembership(memberships, ws);
  if (match === null) return { status: "unknown-workspace" };
  return { status: "ready", membership: match };
}

// ---------------------------------------------------------------------------
// 401/404 semantics (§7.3 sanitized errors at the RSC boundary)
// ---------------------------------------------------------------------------

/** What a page does with a gateway failure (the redirect/404/raise arms). */
export type GatewayErrorAction =
  | { readonly action: "sign-in"; readonly next: string }
  | { readonly action: "not-found" }
  | { readonly action: "raise"; readonly error: unknown };

/**
 * Classify a caught gateway error: 401/UNAUTHORIZED → the sign-in redirect
 * with a `next` round-trip; NOT_FOUND (incl. cross-tenant WORKSPACE_NOT_FOUND)
 * → the 404 arm (hard rule 3); anything else rethrows via `raise` (the Next
 * error boundary renders the sanitized §7.3 message — never a stack).
 */
export function classifyGatewayError(error: unknown, currentPath: string): GatewayErrorAction {
  if (isGatewayHttpError(error)) {
    if (error.status === 401 || error.code === "UNAUTHORIZED") {
      return { action: "sign-in", next: currentPath };
    }
    if (error.isNotFound) return { action: "not-found" };
  }
  return { action: "raise", error };
}

/** `/sign-in?next=<encoded path>` — the expired-session round-trip. */
export function signInPath(next: string): string {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

// ---------------------------------------------------------------------------
// Role helpers (gateway re-checks every capability; these only shape the UI)
// ---------------------------------------------------------------------------

/** owner/admin — billing + member management surfaces (`manageBilling`). */
export function canManageWorkspace(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

/** owner/admin/editor — project mutations (`editProjects`). */
export function canEditProjects(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}
