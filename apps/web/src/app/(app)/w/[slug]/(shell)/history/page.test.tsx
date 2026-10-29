/**
 * The history RSC route tests — project resolution by slug through the ONE
 * `GET /v1/projects/resolve/:slug` call (the perf round's TTFB fix), the
 * `?ws=` switcher seam, the role-derived permission flags handed to the
 * client view, and the 404/redirect/empty-state semantics (hard rule 3;
 * §7.3 sanitized errors). `@/lib/gateway` is mocked (the seam's own tests
 * cover the unwrap); `HistoryPageView` is stubbed so this stays an
 * RSC-logic test.
 */

import type { HistoryPageViewProps } from "@/components/versions/history-view";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
  redirect: (to: string) => {
    throw new Error(`__REDIRECT__:${to}`);
  },
}));

const gatewayMock = vi.fn();
vi.mock("@/lib/gateway", () => ({
  GatewayHttpError: class GatewayHttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(init: { status: number; code: string; message: string }) {
      super(init.message);
      this.status = init.status;
      this.code = init.code;
    }
    get isNotFound(): boolean {
      return (
        this.status === 404 || this.code === "NOT_FOUND" || this.code === "WORKSPACE_NOT_FOUND"
      );
    }
  },
  isGatewayHttpError: (error: unknown): boolean =>
    error instanceof Error && error.constructor.name === "GatewayHttpError",
  gatewayCall: (path: string, init?: { workspaceId?: string }) => gatewayMock(path, init),
}));

let lastViewProps: HistoryPageViewProps | null = null;
vi.mock("@/components/versions/history-view", () => ({
  HistoryPageView: (props: HistoryPageViewProps) => {
    lastViewProps = props;
    return <div data-testid="history-view-stub" data-project={props.projectName} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import HistoryPage from "./page";

/** The captured stub props — throws loudly when the stub never mounted. */
function capturedProps(): HistoryPageViewProps {
  if (lastViewProps === null) throw new Error("HistoryPageView stub was never mounted");
  return lastViewProps;
}

// ---------------------------------------------------------------------------
// Wire fixture (the real §7.2 ProjectResolve shape the endpoint returns)
// ---------------------------------------------------------------------------

const RESOLVE_BASE = {
  workspaceId: "ws_second",
  workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
  viewerId: "usr_viewer_01",
  role: "admin",
  project: {
    id: "prj_demo_launch_film",
    workspaceId: "ws_second",
    name: "Launch film",
    slug: "launch-film",
    thumbnailUrl: null,
    archived: false,
    currentVersionId: "ver_demo_2",
    createdBy: "usr_owner_01",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
    deletedAt: null,
  },
  manifest: {
    projectId: "prj_demo_launch_film",
    currentVersion: null,
    assets: [],
    updatedAt: "2026-10-21T00:00:00Z",
  },
};

/** Script the single by-slug resolution call (overridable fixture pieces). */
function scriptResolve(overrides: Record<string, unknown> = {}): void {
  gatewayMock.mockImplementation((path: string) => {
    if (path.startsWith("/v1/projects/resolve/")) {
      return Promise.resolve({ ...RESOLVE_BASE, ...overrides });
    }
    throw new Error(`unexpected gateway path: ${path}`);
  });
}

/** Script the resolution 404 + the `/v1/me` fallback the page needs for its
 * honest empty state (the fallback fires ONLY on the 404 path). */
function scriptResolve404(memberships: unknown[]): void {
  gatewayMock.mockImplementation((path: string) => {
    if (path.startsWith("/v1/projects/resolve/")) {
      return Promise.reject(
        new GatewayHttpError({
          status: 404,
          code: "PROJECT_NOT_FOUND",
          message: "We couldn't find that project.",
        }),
      );
    }
    if (path === "/v1/me") return Promise.resolve({ memberships });
    throw new Error(`unexpected gateway path: ${path}`);
  });
}

async function renderPage(slug: string, ws?: string): Promise<React.ReactNode> {
  return HistoryPage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(ws === undefined ? {} : { ws }),
  });
}

beforeEach(() => {
  lastViewProps = null;
  gatewayMock.mockReset();
});

describe("history RSC route", () => {
  it("resolves the project by slug in ONE gateway call and passes the mapped payload", async () => {
    scriptResolve();
    const page = await renderPage("launch-film");
    render(page);

    expect(screen.getByTestId("history-view-stub")).toHaveAttribute("data-project", "Launch film");
    const props = capturedProps();
    expect(props.projectId).toBe("prj_demo_launch_film");
    expect(props.projectName).toBe("Launch film");
    expect(props.slug).toBe("launch-film");
    expect(props.workspaceId).toBe("ws_second");
    expect(props.currentVersionId).toBe("ver_demo_2");
    // Admin membership: editor+ AND export capabilities.
    expect(props.canEdit).toBe(true);
    expect(props.canExport).toBe(true);
    expect(typeof props.nowIso).toBe("string");
    expect(Number.isNaN(Date.parse(props.nowIso))).toBe(false);
    // THE PERF PIN: exactly ONE gateway call — no `/v1/me`, no project pages.
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock).toHaveBeenCalledWith("/v1/projects/resolve/launch-film", undefined);
  });

  it("hands the hub the viewer id (resolve.viewerId) and the project's createdBy (ownerId)", async () => {
    scriptResolve();
    const page = await renderPage("launch-film");
    render(page);

    const props = capturedProps();
    expect(props.viewerId).toBe("usr_viewer_01");
    expect(props.ownerId).toBe("usr_owner_01");
  });

  it("narrows the resolution to the ?ws workspace (the switcher seam)", async () => {
    // The ?ws= filter rides the resolve call as ?workspace= (id or slug —
    // the repo join narrows; the RSC never fans out to /v1/me here).
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/projects/resolve/launch-film?workspace=second-studio") {
        return Promise.resolve(RESOLVE_BASE);
      }
      if (path === "/v1/projects/resolve/launch-film") {
        return Promise.resolve({
          ...RESOLVE_BASE,
          workspaceId: "ws_first",
          workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
        });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("launch-film", "second-studio");
    render(page);
    expect(capturedProps().workspaceId).toBe("ws_second");

    // Without ?ws the unfiltered resolution answers.
    const first = await renderPage("launch-film");
    render(first);
    expect(capturedProps().workspaceId).toBe("ws_first");
  });

  it("404s an explicit-but-unknown ?ws (hard rule 3)", async () => {
    scriptResolve404([
      {
        workspaceId: "ws_first",
        role: "viewer",
        // The page's parseMemberships is STRICT (a malformed row is skipped,
        // not half-honored): every workspace field it reads must be present,
        // or the fixture silently degrades to the no-workspace state.
        workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
      },
    ]);
    await expect(renderPage("launch-film", "ws_nope")).rejects.toThrow("__NOT_FOUND__");
    // The resolve call plus the one `/v1/me` fallback — nothing else.
    expect(gatewayMock).toHaveBeenCalledTimes(2);
    expect(gatewayMock).toHaveBeenCalledWith(
      "/v1/projects/resolve/launch-film?workspace=ws_nope",
      undefined,
    );
  });

  it("derives the permission flags per role (viewer reads; editor edits; admin exports)", async () => {
    const roles = [
      ["owner", true, true],
      ["admin", true, true],
      ["editor", true, false],
      ["viewer", false, false],
    ] as const;
    for (const [role, canEdit, canExport] of roles) {
      lastViewProps = null;
      gatewayMock.mockReset();
      scriptResolve({ role });
      const page = await renderPage("launch-film");
      render(page);
      const props = capturedProps();
      expect(props.canEdit).toBe(canEdit);
      expect(props.canExport).toBe(canExport);
    }
  });

  it("404s an unresolvable slug — the resolution-404 path checks /v1/me exactly once", async () => {
    scriptResolve404([
      {
        workspaceId: "ws_first",
        role: "viewer",
        // The page's parseMemberships is STRICT (a malformed row is skipped,
        // not half-honored): every workspace field it reads must be present,
        // or the fixture silently degrades to the no-workspace state.
        workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
      },
    ]);
    await expect(renderPage("launch-film")).rejects.toThrow("__NOT_FOUND__");
    expect(gatewayMock).toHaveBeenCalledTimes(2);
  });

  it("redirects an expired session to /sign-in with a next round-trip", async () => {
    gatewayMock.mockImplementation(() =>
      Promise.reject(
        new GatewayHttpError({
          status: 401,
          code: "UNAUTHORIZED",
          message: "Sign in to continue.",
        }),
      ),
    );
    await expect(renderPage("launch-film")).rejects.toThrow(
      "__REDIRECT__:/sign-in?next=%2Fw%2Flaunch-film%2Fhistory",
    );
  });

  it("renders an honest empty state for a user with no workspace", async () => {
    // The resolution 404s, the single /v1/me fallback reveals zero
    // memberships — the no-workspace empty state, never a 404 (law #1).
    scriptResolve404([]);
    const page = await renderPage("launch-film");
    render(page);
    expect(screen.getByTestId("history-no-workspace")).toHaveTextContent(
      "You don't belong to a workspace yet.",
    );
    expect(lastViewProps).toBeNull();
    expect(gatewayMock).toHaveBeenCalledTimes(2);
  });
});
