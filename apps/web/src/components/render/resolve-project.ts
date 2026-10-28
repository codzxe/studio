// @studio/web — lazy workspace+project scope resolution for the render
// surfaces (M8-I).
//
// WHY this exists: the render region mounts inside the CHAT HEADER, which is
// an additive overlay (D-18) with NO access to the editor session's payload
// (the RSC page keeps workspaceId/projectId server-side; the ChatProvider's
// api deliberately hides them). The CommentsRegion precedent solves the same
// problem by receiving the ids as props from the page — the header cannot.
// So the region resolves the scope itself, ONCE, on first use.
//
// HOW (perf round): `GET /v1/projects/resolve/:slug` — ONE same-origin call
// that resolves the slug across the user's workspaces (one auth pass + one
// joined SQL in the gateway). The pre-fix resolver mirrored the editor RSC
// route's fan-out (`/v1/me` → per-workspace `GET /v1/projects` pages), which
// on a many-workspace account meant ~90 sequential DB roundtrips per
// resolution — client-side, on every editor page load.
//
// The result is cached by the REGION (resolve once per page load); every
// failure is typed + honest and the surfaces offer Retry.

import { createApiClient } from "@studio/api-client";
import type { RenderClient, RenderScopeResolver, RenderScopeResult } from "./types";

/** Same-origin API root (session-client.ts precedent). */
const API_BASE_URL = "/v1";

/** The scoped slug of the editor route: `/w/<slug>/…` → `<slug>`. */
export function editorSlugFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2 || segments[0] !== "w") return null;
  return segments[1] ?? null;
}

export interface RouteScopeResolverOptions {
  /** Client factory by workspace scope (null = the bare /v1 client). */
  readonly createClient?: (workspaceId: string | null) => RenderClient;
  /** Pathname source (default `window.location.pathname`, read per call). */
  readonly pathname?: () => string;
  /**
   * Fetch seam for the by-slug resolution call (tests inject fakes; the
   * default is the global fetch — same-origin, session cookies attached).
   */
  readonly fetchImpl?: typeof fetch;
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
    ((workspaceId: string | null): RenderClient =>
      createApiClient({
        baseUrl: API_BASE_URL,
        headers: workspaceId === null ? {} : { "x-workspace-id": workspaceId },
      }));
  const pathname = options.pathname ?? ((): string => window.location.pathname);
  const doFetch = options.fetchImpl ?? fetch;

  return async (): Promise<RenderScopeResult> => {
    const slug = editorSlugFromPath(pathname());
    if (slug === null) return { kind: "error", problem: "no-route" };

    try {
      const response = await doFetch(
        `${API_BASE_URL}/projects/resolve/${encodeURIComponent(slug)}`,
        { headers: { accept: "application/json" } },
      );
      if (response.status === 401) return { kind: "error", problem: "unauthorized" };
      if (response.status === 404) return { kind: "error", problem: "not-found" };
      if (!response.ok) return { kind: "error", problem: "failed" };
      const body: unknown = await response.json();
      // §7.3 Ok envelope — same structural restatement discipline as the
      // RSC pages (a runtime contracts import is forbidden from apps/web).
      if (
        typeof body !== "object" ||
        body === null ||
        (body as Record<string, unknown>).data === undefined
      ) {
        return { kind: "error", problem: "failed" };
      }
      const data = (body as Record<string, unknown>).data as Record<string, unknown>;
      if (typeof data.workspaceId !== "string" || typeof data.project !== "object") {
        return { kind: "error", problem: "failed" };
      }
      const project = data.project as Record<string, unknown>;
      if (typeof project.id !== "string" || typeof project.name !== "string") {
        return { kind: "error", problem: "failed" };
      }
      return {
        kind: "ok",
        scope: {
          client: createClient(data.workspaceId),
          projectId: project.id,
          projectName: project.name,
        },
      };
    } catch {
      return { kind: "error", problem: "failed" };
    }
  };
}
