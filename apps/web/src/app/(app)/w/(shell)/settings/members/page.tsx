import type { Member } from "@studio/contracts";
import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";

import { MembersTable } from "@/components/settings/members-table";
import { RolesExplainer } from "@/components/settings/roles-explainer";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";
import {
  classifyGatewayError,
  parseMemberships,
  resolveActiveWorkspace,
  signInPath,
} from "@/lib/workspace-membership";

/**
 * The Members settings route (W2-06, §8.9): `/w/settings/members`.
 *
 * RSC resolution mirrors `/w/billing` through the shared
 * workspace-membership seam: `GET /v1/me → memberships`, `?ws=<id or slug>`
 * wins; no `?ws` → the first membership; an explicit-but-unknown `?ws` is a
 * 404 (hard rule 3). Then TWO workspace-scoped reads:
 *
 * - `GET /v1/workspaces/:id/members` — the roster, bounded pages (the §7.2
 *   page is cursor-paginated; MAX_MEMBER_PAGES × 100 rows is ample for v1 —
 *   a longer roster renders as "N+" rather than lying with a count).
 * - `GET /v1/billing/state` — the plan's seat LIMIT only
 *   (`entitlements.seats`; the seats-used display pairs it with the roster
 *   count). Tolerant: any failure degrades to `seatsLimit: null` (the page
 *   shows the member count alone — never a broken page).
 *
 * The client table (`components/settings/members-table.tsx`) owns every
 * mutation: role changes, removal, ownership transfer and invites, all
 * through `@studio/api-client` same-origin with the workspace header.
 */

export const metadata = pageMetadata({
  title: "Members",
  description: "Invite people to your workspace and manage their roles.",
  path: "/w/settings/members",
});

/** The sign-in round-trip target (this page's canonical path). */
const PAGE_PATH = "/w/settings/members";

/** §7.2 page size ceiling (PAGINATION_QUERY_SCHEMA max). */
const MEMBER_PAGE_LIMIT = 100;

/** Bounded roster load: 4 × 100 rows; beyond that the count renders "N+". */
const MAX_MEMBER_PAGES = 4;

// ---------------------------------------------------------------------------
// Wire shapes consumed (§7.2, type-only restatements — see lib/gateway.ts)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseRole(value: unknown): "owner" | "admin" | "editor" | "viewer" | null {
  return value === "owner" || value === "admin" || value === "editor" || value === "viewer"
    ? value
    : null;
}

/** One `Member` row (contracts routes/members.ts), parsed tolerantly. */
function parseMemberRow(value: unknown): Member | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  const role = parseRole(value.role);
  if (role === null) return null;
  return {
    id: value.id,
    name: stringOrNull(value.name),
    email: stringOrNull(value.email),
    role,
    // v1 wire carries "active" only (contracts MemberStatus); the column is
    // the growth seam — a row never hides over a status we can't render.
    status: "active",
    lastActiveAt: stringOrNull(value.lastActiveAt),
    isCurrentUser: value.isCurrentUser === true,
  };
}

interface RosterLoad {
  readonly members: readonly Member[];
  /** True when the bounded load stopped before the roster ended. */
  readonly truncated: boolean;
}

/**
 * Bounded cursor-paged roster read; `null` = malformed payload (the honest
 * "unavailable" arm — never a stack, law #1).
 */
async function loadRoster(workspaceId: string): Promise<RosterLoad | null> {
  const members: Member[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(MEMBER_PAGE_LIMIT) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const data = await gatewayCall<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members?${query.toString()}`,
      { workspaceId },
    );
    if (!isRecord(data) || !Array.isArray(data.items)) return null;
    for (const row of data.items) {
      const parsed = parseMemberRow(row);
      if (parsed !== null) members.push(parsed);
    }
    if (typeof data.nextCursor !== "string" || data.nextCursor === "") {
      return { members, truncated: false };
    }
    cursor = data.nextCursor;
  }
  return { members, truncated: true };
}

/** The plan's seat limit from `GET /v1/billing/state` (tolerant — never throws). */
async function readSeatsLimit(workspaceId: string): Promise<number | null> {
  try {
    const state = await gatewayCall<unknown>("/v1/billing/state", { workspaceId });
    const entitlements =
      isRecord(state) && isRecord(state.entitlements) ? state.entitlements : null;
    if (entitlements === null) return null;
    const seats = entitlements.seats;
    return typeof seats === "number" && Number.isFinite(seats) && seats >= 0 ? seats : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type MembersResolution =
  | { readonly status: "empty" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly payload: {
        readonly workspaceId: string;
        readonly workspaceName: string;
        readonly currentRole: "owner" | "admin" | "editor" | "viewer";
        readonly members: readonly Member[];
        readonly truncated: boolean;
        readonly seatsLimit: number | null;
      };
    };

async function loadMembersPage(ws: string | undefined): Promise<MembersResolution> {
  let me: unknown;
  try {
    me = await gatewayCall<unknown>("/v1/me");
  } catch (error) {
    const verdict = classifyGatewayError(error, PAGE_PATH);
    if (verdict.action === "sign-in") redirect(signInPath(verdict.next));
    if (verdict.action === "not-found") notFound();
    throw verdict.error;
  }

  const resolution = resolveActiveWorkspace(parseMemberships(me), ws);
  if (resolution.status === "unknown-workspace") {
    notFound();
  }
  if (resolution.status === "no-workspace") {
    return { status: "empty" };
  }
  const { membership } = resolution;

  let roster: RosterLoad | null;
  try {
    roster = await loadRoster(membership.workspaceId);
  } catch (error) {
    if (isGatewayHttpError(error)) {
      if (error.status === 401 || error.code === "UNAUTHORIZED") {
        redirect(signInPath(PAGE_PATH));
      }
      if (error.isNotFound) notFound();
    }
    throw error;
  }
  if (roster === null) {
    return { status: "unavailable" };
  }

  return {
    status: "ready",
    payload: {
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspace.name,
      currentRole: membership.role,
      members: roster.members,
      truncated: roster.truncated,
      seatsLimit: await readSeatsLimit(membership.workspaceId),
    },
  };
}

interface MembersPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

export default async function MembersSettingsPage({ searchParams }: MembersPageProps) {
  const { ws } = await searchParams;
  const resolution = await loadMembersPage(ws);

  if (resolution.status === "empty") {
    return (
      <EmptyState
        data-testid="members-no-workspace"
        title="You don't belong to a workspace yet."
        secondaryLink={{ label: "Back to the site", href: "/" }}
      />
    );
  }

  if (resolution.status === "unavailable") {
    return (
      <EmptyState
        data-testid="members-unavailable"
        title="Members are unavailable right now."
        secondaryLink={{ label: "Back to workspace", href: "/w" }}
      />
    );
  }

  const { workspaceId, workspaceName, currentRole, members, truncated, seatsLimit } =
    resolution.payload;
  return (
    <div data-testid="members-page" className="flex flex-col gap-10">
      <MembersTable
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        currentRole={currentRole}
        initialMembers={members}
        membersTruncated={truncated}
        seatsLimit={seatsLimit}
      />
      <RolesExplainer />
    </div>
  );
}
