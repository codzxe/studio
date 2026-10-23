// @studio/web — lazy workspace+project scope resolution for the render
// surfaces (M8-I).
//
// WHY this exists: the render region mounts inside the CHAT HEADER, which is
// an additive overlay (D-18) with NO access to the editor session's payload
// (the RSC page keeps workspaceId/projectId server-side; the ChatProvider's
// api deliberately hides them). The CommentsRegion precedent solves the same
// problem by receiving the ids as props from the page — the header cannot.
// So the region resolves the scope itself, ONCE, on first use, mirroring the
// editor RSC route's own bounded scan (`app/(app)/w/[slug]/editor/page.tsx`):
//
//   1. `/v1/me` on a BARE client (no workspace header needed) → memberships.
//   2. Per membership: `GET /v1/projects` (50/page, ≤ 4 pages) → the first
//      LIVE project (deletedAt null) whose slug matches the route's slug.
//   3. The winning workspace's scoped client becomes the render client.
//
// The result is cached by the REGION (resolve once per page load); every
// failure is typed + honest and the surfaces offer Retry.

import { type ApiClient, createApiClient, isApiError } from "@studio/api-client";
import type { RenderScopeResolver, RenderScopeResult } from "./types";

/** Same-origin API root (session-client.ts precedent). */
const API_BASE_URL = "/v1";

/** Bounded scan bounds — identical to the editor RSC route. */
const PROJECT_PAGE_LIMIT = 50;
const MAX_PROJECT_PAGES = 4;

/** The client surface the resolver needs (structural — tests inject fakes). */
export type RenderScopeClient = Pick<ApiClient, "me" | "projects" | "renders">;

/** The scoped slug of the editor route: `/w/<slug>/…` → `<slug>`. */
export function editorSlugFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2 || segments[0] !== "w") return null;
  return segments[1] ?? null;
}

export interface RouteScopeResolverOptions {
  /** Client factory by workspace scope (null = the bare /v1 client). */
  readonly createClient?: (workspaceId: string | null) => RenderScopeClient;
  /** Pathname source (default `window.location.pathname`, read per call). */
  readonly pathname?: () => string;
}

/**
 * Builds the region's scope resolver. Deterministic, never throws: every
 * outcome is a typed {@link RenderScopeResult}.
 */
export function createRouteScopeResolver(
  options: RouteScopeResolverOptions = {},
): RenderScopeResolver {
  const createClient =
    options.createClient ??
    ((workspaceId: string | null): RenderScopeClient =>
      createApiClient({
        baseUrl: API_BASE_URL,
        headers: workspaceId === null ? {} : { "x-workspace-id": workspaceId },
      }));
  const pathname = options.pathname ?? ((): string => window.location.pathname);

  return async (): Promise<RenderScopeResult> => {
    const slug = editorSlugFromPath(pathname());
    if (slug === null) return { kind: "error", problem: "no-route" };

    let memberships: readonly { readonly workspaceId: string }[];
    try {
      const bare = createClient(null);
      const me = await bare.me.get();
      memberships = me.memberships.map((membership) => ({ workspaceId: membership.workspaceId }));
    } catch (error) {
      if (isApiError(error) && (error.code === "UNAUTHORIZED" || error.status === 401)) {
        return { kind: "error", problem: "unauthorized" };
      }
      return { kind: "error", problem: "failed" };
    }

    // The RSC scan order: first workspace whose project list has the slug.
    for (const membership of memberships) {
      const scoped = createClient(membership.workspaceId);
      let cursor: string | undefined = undefined;
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        let result: {
          readonly items: readonly {
            readonly id: string;
            readonly name: string;
            readonly slug: string;
            readonly deletedAt: string | null;
          }[];
          readonly nextCursor: string | null;
        };
        try {
          const queried = await scoped.projects.list({
            limit: PROJECT_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          });
          result = queried;
        } catch (error) {
          if (isApiError(error) && (error.code === "UNAUTHORIZED" || error.status === 401)) {
            return { kind: "error", problem: "unauthorized" };
          }
          return { kind: "error", problem: "failed" };
        }
        const match = result.items.find(
          (project) => project.slug === slug && project.deletedAt === null,
        );
        if (match !== undefined) {
          return {
            kind: "ok",
            scope: {
              client: scoped,
              projectId: match.id,
              projectName: match.name,
            },
          };
        }
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
    }
    return { kind: "error", problem: "not-found" };
  };
}
