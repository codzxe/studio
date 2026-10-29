import { asc, eq } from "drizzle-orm";

import type { StudioDb } from "../db.js";
import { tablesFor } from "../tables.js";
import { requireNonEmpty } from "./shared.js";

/**
 * Memberships repository — the /v1/me TTFB fix (perf round, part 2): the
 * caller's workspace memberships in ONE joined SQL.
 *
 * The pre-fix route looped better-auth's `getFullWorkspace` per organization —
 * fetching EVERY organization's full member list to find one role, ~3 DB
 * queries per workspace, sequential: a 30-workspace account paid a measured
 * ~2 s `/v1/me` (and every shell-wrapped page with it, e.g. history at
 * ~2.1 s while the bare editor route sat at 0.2 s). One member × organization
 * join replaces the whole loop; the roles pass through as better-auth stores
 * them (owner | admin | member | editor | viewer) and the route keeps its own
 * wire-role coercion — the repo adds no vocabulary of its own.
 *
 * Ordering is `member.created_at` ascending (join order — the old
 * activeWorkspaceId = first-membership fallback relied on it), with the
 * member id as a deterministic tiebreaker.
 */

export interface MembershipRow {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  /** better-auth org role: owner | admin | member | editor | viewer. */
  readonly role: string;
}

export interface MembershipsRepo {
  /** Every workspace the user belongs to, oldest membership first. */
  listForUser(userId: string): Promise<readonly MembershipRow[]>;
}

export function createMembershipsRepo(db: StudioDb): MembershipsRepo {
  const { member, organization } = tablesFor(db);
  return {
    async listForUser(userId) {
      const caller = requireNonEmpty(userId, "userId");
      const rows = await db
        .select({
          workspaceId: member.organizationId,
          workspaceName: organization.name,
          workspaceSlug: organization.slug,
          role: member.role,
        })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.userId, caller))
        .orderBy(asc(member.createdAt), asc(member.id));
      return rows;
    },
  };
}
