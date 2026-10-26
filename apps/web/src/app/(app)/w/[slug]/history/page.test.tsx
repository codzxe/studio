/**
 * The history RSC route tests — project resolution by slug across the user's
 * workspaces (the editor-route pattern), the `?ws=` switcher seam, the
 * role-derived permission flags handed to the client view, and the
 * 404/redirect/empty-state semantics (hard rule 3; §7.3 sanitized errors).
 * `@/lib/gateway` is mocked (the seam's own tests cover the unwrap);
 * `HistoryPageView` is stubbed so this stays an RSC-logic test.
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
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const MEMBERSHIPS = [
  {
    workspaceId: "ws_first",
    role: "viewer",
    workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
  },
  {
    workspaceId: "ws_second",
    role: "admin",
    workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
  },
];

const PROJECT_ROW = {
  id: "prj_demo_launch_film",
  name: "Launch film",
  slug: "launch-film",
  deletedAt: null,
  currentVersionId: "ver_demo_2",
};

/** Script `/v1/me` + per-workspace project pages in one go. */
function scriptHappyPath(): void {
  gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
    if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
    if (path.startsWith("/v1/projects?")) {
      // ws_first has one forward page, then empty; the match is in ws_second.
      if (init?.workspaceId === "ws_first" && path.includes("cursor=ws1-page-2")) {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      if (init?.workspaceId === "ws_first") {
        return Promise.resolve({
          items: [{ ...PROJECT_ROW, id: "prj_other", slug: "other-film" }],
          nextCursor: "ws1-page-2",
        });
      }
      return Promise.resolve({ items: [PROJECT_ROW], nextCursor: null });
    }
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
  it("resolves the project by slug across workspaces (paged scan) and passes the mapped payload", async () => {
    scriptHappyPath();
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
  });

  it("narrows the scan to the ?ws workspace (the switcher seam)", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/projects?")) {
        // The viewer workspace is scanned FIRST and matches — ?ws must pin it.
        if (init?.workspaceId === "ws_first") {
          return Promise.resolve({
            items: [{ ...PROJECT_ROW, id: "prj_first", currentVersionId: "ver_first" }],
            nextCursor: null,
          });
        }
        return Promise.resolve({ items: [PROJECT_ROW], nextCursor: null });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("launch-film", "second-studio");
    render(page);
    expect(capturedProps().workspaceId).toBe("ws_second");

    // Without ?ws the first membership wins the same slug.
    const first = await renderPage("launch-film");
    render(first);
    expect(capturedProps().workspaceId).toBe("ws_first");
  });

  it("404s an explicit-but-unknown ?ws (hard rule 3)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage("launch-film", "ws_nope")).rejects.toThrow("__NOT_FOUND__");
    expect(gatewayMock).toHaveBeenCalledTimes(1);
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
      gatewayMock.mockImplementation((path: string) => {
        if (path === "/v1/me") {
          return Promise.resolve({
            memberships: [
              {
                workspaceId: "ws_only",
                role,
                workspace: { id: "ws_only", name: "Only Films", slug: "only-films" },
              },
            ],
          });
        }
        if (path.startsWith("/v1/projects?")) {
          return Promise.resolve({ items: [PROJECT_ROW], nextCursor: null });
        }
        throw new Error(`unexpected gateway path: ${path}`);
      });
      const page = await renderPage("launch-film");
      render(page);
      const props = capturedProps();
      expect(props.canEdit).toBe(canEdit);
      expect(props.canExport).toBe(canExport);
    }
  });

  it("404s when no workspace has the slug, and skips soft-deleted projects", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/projects?")) {
        return Promise.resolve({
          items: [{ ...PROJECT_ROW, deletedAt: "2026-10-22T00:00:00Z" }],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage("launch-film")).rejects.toThrow("__NOT_FOUND__");

    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/projects?")) {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage("launch-film")).rejects.toThrow("__NOT_FOUND__");
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

  it("404s the gateway's NOT_FOUND on the project scan", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      return Promise.reject(
        new GatewayHttpError({ status: 404, code: "NOT_FOUND", message: "Not found." }),
      );
    });
    await expect(renderPage("launch-film")).rejects.toThrow("__NOT_FOUND__");
  });

  it("renders an honest empty state for a user with no workspace", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: [] });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("launch-film");
    render(page);
    expect(screen.getByTestId("history-no-workspace")).toHaveTextContent(
      "You don't belong to a workspace yet.",
    );
    expect(lastViewProps).toBeNull();
  });
});
