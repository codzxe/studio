"use server";

// /w/projects list loads (W2-04, §8.5; W2-B3) — one `GET /v1/projects` page
// for the browser window (active OR archived), served through
// `@studio/api-client`'s `projects.list`.
//
// History (the retired workaround): this action used to hand-build the query
// string on top of `gatewayCall` because the api-client validated the list
// query with the bare PAGINATION_QUERY_SCHEMA, silently stripping the W1-c
// `archived` param (§9.1) — a client-side `projects.list({ archived: true })`
// would have paged the wrong view. W2-B3 fixed the client
// (client.ts routes the query through PROJECTS_QUERY_SCHEMA), so the
// hand-rolled param building is gone: the action is now a thin typed adapter
// that exists ONLY because `components/projects/projects-list-view.tsx`
// (another owner's file) imports it. Once that view binds
// `client.projects.list` directly in `createProjectsListPort` (safe since
// the fix), DELETE this file.
//
// Server-side api-client wiring (same laws as lib/gateway.ts):
// - baseUrl: `GATEWAY_INTERNAL_URL` + `/v1` — the Next server cannot use the
//   browser's same-origin `/v1` root the client components use.
// - The better-auth session cookie is forwarded on every call (the gateway's
//   auth middleware reads the session from it).
// - `x-workspace-id` scopes the read and is re-checked server-side by
//   `requireWorkspace` (§12.1).
//
// Failures return the typed `ok: false` envelope (law #1: Ok/Err semantics,
// §7.3 message + hint + request id) instead of throwing — server actions
// serialize thrown errors down to `message`, which would lose the code/hint
// the UI surfaces.

import { cookies } from "next/headers";

import { createApiClient, isApiError } from "@studio/api-client";

import {
  PROJECTS_PAGE_LIMIT,
  type ProjectsPageResult,
  parseProjectsPage,
} from "@/components/projects/projects-wire";

/** Gateway origin default — mirrors lib/gateway.ts (single env source). */
const DEFAULT_GATEWAY_INTERNAL_URL = "http://127.0.0.1:8787";

/** Query for one list page — mirrors PROJECTS_QUERY_SCHEMA (cursor/limit/archived). */
export interface LoadProjectsPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
  /** true → archived-only; absent/false → the default unarchived view (§9.1). */
  readonly archived?: boolean;
}

/** The forwarded session cookies → one `cookie` header value ("" when none). */
async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * One `GET /v1/projects` page for the browser window (active or archived).
 * Never throws: every failure lands in the typed `error` arm.
 */
export async function loadProjectsPage(
  workspaceId: string,
  query: LoadProjectsPageQuery = {},
): Promise<ProjectsPageResult> {
  const gatewayInternalUrl = process.env.GATEWAY_INTERNAL_URL ?? DEFAULT_GATEWAY_INTERNAL_URL;
  const cookie = await cookieHeader();
  const client = createApiClient({
    baseUrl: `${gatewayInternalUrl.replace(/\/+$/, "")}/v1`,
    headers:
      cookie === "" ? { "x-workspace-id": workspaceId } : { cookie, "x-workspace-id": workspaceId },
  });

  try {
    // The fixed seam: PROJECTS_QUERY_SCHEMA carries cursor/limit/archived,
    // so an archived-window continuation stays window-consistent.
    const page = await client.projects.list({
      cursor: query.cursor,
      limit: query.limit ?? PROJECTS_PAGE_LIMIT,
      archived: query.archived,
    });
    // Tolerant final seam (law #1): parseProjectsPage keeps the row shape the
    // view consumes. NOTE: the api-client's own PAGE_PROJECTS_SCHEMA is
    // stricter than the old gatewayCall path — a MALFORMED row now fails the
    // whole page into the typed error arm below (honest failure, never a
    // crash) instead of silently dropping the row.
    return parseProjectsPage(page);
  } catch (error) {
    if (isApiError(error)) {
      // §7.3-safe fields only (ApiError surfaces envelope message/hint +
      // request id; client-local codes carry generic safe strings).
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
