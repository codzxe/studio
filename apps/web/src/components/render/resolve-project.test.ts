/**
 * `createRouteScopeResolver` tests — the M8-I lazy render-scope resolution.
 * The perf-round rewrite: ONE same-origin `GET /v1/projects/resolve/:slug`
 * call (fetch seam injected) replaces the old `/v1/me` + per-workspace
 * project-page client fan-out. Every outcome is a typed honest result;
 * the scoped client factory receives the RESOLVED workspace id.
 */

import { describe, expect, it, vi } from "vitest";

import { createRouteScopeResolver, editorSlugFromPath } from "./resolve-project";
import type { RenderClient } from "./types";

/** A fetch-shaped fake answering the resolve call. */
function fetchAnswering(status: number, body: unknown): typeof fetch {
  return (vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown) as typeof fetch;
}

const RESOLVE_BODY = {
  data: {
    workspaceId: "ws_second",
    workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
    viewerId: "usr_demo",
    role: "viewer",
    project: { id: "prj_demo", name: "Launch film", slug: "launch-film" },
    manifest: { projectId: "prj_demo", currentVersion: null, assets: [], updatedAt: "x" },
  },
};

describe("editorSlugFromPath", () => {
  it("extracts the slug from /w/<slug>/… paths", () => {
    expect(editorSlugFromPath("/w/launch-film/editor")).toBe("launch-film");
    expect(editorSlugFromPath("/w/launch-film/history?ws=a")).toBe("launch-film");
  });

  it("rejects non-editor paths", () => {
    expect(editorSlugFromPath("/dashboard")).toBeNull();
    expect(editorSlugFromPath("/w")).toBeNull();
    expect(editorSlugFromPath("")).toBeNull();
  });
});

describe("createRouteScopeResolver", () => {
  it("resolves the scope with ONE fetch call and hands the workspace-scoped client", async () => {
    const fetchImpl = fetchAnswering(200, RESOLVE_BODY);
    const clients: (string | null)[] = [];
    const resolver = createRouteScopeResolver({
      pathname: () => "/w/launch-film/editor",
      fetchImpl,
      createClient: (workspaceId) => {
        clients.push(workspaceId);
        return {} as RenderClient;
      },
    });

    const result = await resolver();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.scope.projectId).toBe("prj_demo");
    expect(result.scope.projectName).toBe("Launch film");
    // The scoped client carries the RESOLVED workspace id.
    expect(clients).toEqual(["ws_second"]);
    // THE PERF PIN: exactly one network call — no /v1/me, no project pages.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl as unknown as { calls: unknown[][] }).calls?.[0]?.[0]).toBe(
      "/v1/projects/resolve/launch-film",
    );
  });

  it("URL-encodes the slug", async () => {
    const fetchImpl = fetchAnswering(200, RESOLVE_BODY);
    const resolver = createRouteScopeResolver({
      pathname: () => "/w/launch film/edit", // slug with a space
      fetchImpl,
      createClient: () => ({}) as RenderClient,
    });
    await resolver();
    expect((fetchImpl as unknown as { calls: unknown[][] }).calls?.[0]?.[0]).toBe(
      "/v1/projects/resolve/launch%20film",
    );
  });

  it("maps 401 → unauthorized, 404 → not-found, 5xx → failed", async () => {
    const cases = [
      [401, "unauthorized"],
      [404, "not-found"],
      [503, "failed"],
    ] as const;
    for (const [status, problem] of cases) {
      const resolver = createRouteScopeResolver({
        pathname: () => "/w/launch-film/editor",
        fetchImpl: fetchAnswering(status, { error: {} }),
        createClient: () => ({}) as RenderClient,
      });
      expect(await resolver()).toEqual({ kind: "error", problem });
    }
  });

  it("maps a network throw and a malformed body to failed (never throws)", async () => {
    const throwing = (vi.fn().mockRejectedValue(new TypeError("offline")) as unknown) as typeof fetch;
    const resolver = createRouteScopeResolver({
      pathname: () => "/w/launch-film/editor",
      fetchImpl: throwing,
      createClient: () => ({}) as RenderClient,
    });
    expect(await resolver()).toEqual({ kind: "error", problem: "failed" });

    const malformed = createRouteScopeResolver({
      pathname: () => "/w/launch-film/editor",
      fetchImpl: fetchAnswering(200, { no: "envelope" }),
      createClient: () => ({}) as RenderClient,
    });
    expect(await malformed()).toEqual({ kind: "error", problem: "failed" });
  });

  it("reports no-route for paths outside /w/<slug>/…", async () => {
    const resolver = createRouteScopeResolver({
      pathname: () => "/w",
      fetchImpl: fetchAnswering(200, RESOLVE_BODY),
      createClient: () => ({}) as RenderClient,
    });
    expect(await resolver()).toEqual({ kind: "error", problem: "no-route" });
  });
});
