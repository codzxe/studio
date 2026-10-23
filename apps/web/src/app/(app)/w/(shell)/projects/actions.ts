"use server";

// /w/projects list loads (W2-04, §8.5) — the ONE server seam the projects
// browser reads pages through, next to the RSC route's initial read.
//
// WHY a server action (documented honest limit, not a workaround in silence):
// `@studio/api-client`'s `projects.list` validates the query with the bare
// PAGINATION_QUERY_SCHEMA (client.ts `paginated()`), which STRIPS the W1-c
// `archived` param — the type accepts it, the wire never sees it, so a
// client-side `projects.list({ archived: true })` would silently return the
// DEFAULT (unarchived) list. Cursor continuations must also stay
// window-consistent (an archived-window cursor sent without `archived=true`
// pages the wrong view). Until the api-client switches that one call to
// `queryOf(PROJECTS_QUERY_SCHEMA, query)` (a one-line fix for its owner),
// every list page the browser loads after the RSC initial read goes through
// this action — same `gatewayCall` seam, same gateway route, real
// `archived=true` param, tenant-scoped by the `x-workspace-id` header and
// re-checked by `requireWorkspace` (§12.1).
//
// Failures return the typed `ok: false` envelope (law #1: Ok/Err semantics,
// §7.3 message + hint + request id) instead of throwing — server actions
// serialize thrown errors down to `message`, which would lose the code/hint
// the UI surfaces.

import {
  PROJECTS_PAGE_LIMIT,
  type ProjectsPageResult,
  parseProjectsPage,
} from "@/components/projects/projects-wire";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";

/** Query for one list page — mirrors PROJECTS_QUERY_SCHEMA (cursor/limit/archived). */
export interface LoadProjectsPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
  /** true → archived-only; absent/false → the default unarchived view (§9.1). */
  readonly archived?: boolean;
}

/**
 * One `GET /v1/projects` page for the browser window (active or archived).
 * Never throws: every failure lands in the typed `error` arm.
 */
export async function loadProjectsPage(
  workspaceId: string,
  query: LoadProjectsPageQuery = {},
): Promise<ProjectsPageResult> {
  const params = new URLSearchParams({ limit: String(query.limit ?? PROJECTS_PAGE_LIMIT) });
  if (query.cursor !== undefined && query.cursor !== "") {
    params.set("cursor", query.cursor);
  }
  if (query.archived === true) {
    params.set("archived", "true");
  }

  try {
    const payload: unknown = await gatewayCall(`/v1/projects?${params.toString()}`, {
      workspaceId,
    });
    return parseProjectsPage(payload);
  } catch (error) {
    if (isGatewayHttpError(error)) {
      return {
        ok: false,
        error: {
          message: error.message,
          hint: error.hint,
          requestId: error.requestId,
        },
      };
    }
    return {
      ok: false,
      error: {
        message: "The projects list could not be loaded.",
        hint: "Try again in a moment.",
      },
    };
  }
}
