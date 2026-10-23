/**
 * The projects RSC route tests (W2-04) — workspace resolution
 * (`/v1/me → memberships` + the `?ws=` switcher seam via
 * lib/workspace-membership), the ONE initial list read
 * (`GET /v1/projects?limit=50`, the active window), and the
 * 404/redirect/empty-state semantics (hard rule 3; §7.3 sanitized errors).
 * `@/lib/gateway` is mocked (the seam's own tests cover the unwrap);
 * `ProjectsListView` is stubbed so this stays an RSC-logic test (the billing
 * page.test.tsx pattern).
 */

import type { ProjectsListViewProps } from "@/components/projects/projects-list-view";
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

let lastViewProps: ProjectsListViewProps | null = null;
vi.mock("@/components/projects/projects-list-view", () => ({
  ProjectsListView: (props: ProjectsListViewProps) => {
    lastViewProps = props;
    return <div data-testid="projects-view-stub" data-workspace={props.workspaceName} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import ProjectsPage from "./page";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const ME_PAYLOAD = {
  user: { id: "user_me", name: "Studio Owner", email: "owner@firstfilms.test" },
  memberships: [
    {
      workspaceId: "ws_first",
      role: "owner",
      workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
    },
    {
      workspaceId: "ws_second",
      role: "viewer",
      workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
    },
  ],
  plan: { plan: "pro", status: "active" },
};

function wireProject(id: string, name: string, slug: string, extra: object = {}) {
  return {
    id,
    workspaceId: "ws_first",
    name,
    slug,
    thumbnailUrl: null,
    archived: false,
    currentVersionId: null,
    createdBy: "user_me",
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-20T09:00:00Z",
    deletedAt: null,
    ...extra,
  };
}

const PROJECTS_PAGE = {
  items: [
    wireProject("prj_alpha", "Launch film", "launch-film"),
    wireProject("prj_beta", "Teaser cut", "teaser-cut", { createdBy: "user_other" }),
    // Malformed row — skipped, never a crash (law #1).
    { id: "prj_broken", name: 42 },
  ],
  nextCursor: "cur_2",
};

async function renderPage(ws?: string): Promise<React.ReactNode> {
  return ProjectsPage({ searchParams: Promise.resolve(ws === undefined ? {} : { ws }) });
}

beforeEach(() => {
  lastViewProps = null;
  gatewayMock.mockReset();
});

describe("projects RSC route (/w/projects)", () => {
  it("resolves the first membership, reads page 1 once and hands the view the payload", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve(ME_PAYLOAD);
      if (path === "/v1/projects?limit=50") {
        expect(init?.workspaceId).toBe("ws_first");
        return Promise.resolve(PROJECTS_PAGE);
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("projects-view-stub")).toBeInTheDocument();
    const calls = gatewayMock.mock.calls.map(([path]) => path);
    expect(calls).toEqual(["/v1/me", "/v1/projects?limit=50"]);

    expect(lastViewProps).not.toBeNull();
    const props = lastViewProps as ProjectsListViewProps;
    expect(props.workspaceId).toBe("ws_first");
    expect(props.workspaceName).toBe("First Films");
    expect(props.userId).toBe("user_me");
    expect(props.canEdit).toBe(true);
    expect(props.initialNextCursor).toBe("cur_2");
    // Malformed rows are skipped: 2 of 3 survive.
    expect(props.initialItems).toHaveLength(2);
    expect(props.initialItems[0]?.id).toBe("prj_alpha");
    expect(Number.isNaN(Date.parse(props.nowIso))).toBe(false);
  });

  it("honors ?ws= by id or slug and maps viewer roles to canEdit=false", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve(ME_PAYLOAD);
      if (path === "/v1/projects?limit=50") {
        expect(init?.workspaceId).toBe("ws_second");
        return Promise.resolve(PROJECTS_PAGE);
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("second-studio");
    render(page);
    const props = lastViewProps as ProjectsListViewProps;
    expect(props.workspaceId).toBe("ws_second");
    expect(props.workspaceName).toBe("Second Studio");
    expect(props.canEdit).toBe(false);
  });

  it("404s an explicit but unknown ?ws= (cross-tenant = 404, hard rule 3)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_PAYLOAD);
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage("ws_gone")).rejects.toThrow("__NOT_FOUND__");
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
    await expect(renderPage()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw%2Fprojects");
  });

  it("redirects a session that dies between the two reads", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_PAYLOAD);
      return Promise.reject(
        new GatewayHttpError({
          status: 401,
          code: "UNAUTHORIZED",
          message: "Sign in to continue.",
        }),
      );
    });
    await expect(renderPage()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw%2Fprojects");
  });

  it("404s the gateway's NOT_FOUND on the projects read (never 403)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_PAYLOAD);
      return Promise.reject(
        new GatewayHttpError({ status: 404, code: "WORKSPACE_NOT_FOUND", message: "Not found." }),
      );
    });
    await expect(renderPage()).rejects.toThrow("__NOT_FOUND__");
  });

  it("renders the honest empty state when the user has no workspace", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: [] });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    expect(screen.getByTestId("projects-no-workspace")).toBeInTheDocument();
    expect(screen.getByText("You don't belong to a workspace yet.")).toBeInTheDocument();
  });

  it("degrades a malformed page payload to the honest empty window", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_PAYLOAD);
      if (path === "/v1/projects?limit=50") return Promise.resolve({ plan: "pro" });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    const props = lastViewProps as ProjectsListViewProps;
    expect(props.initialItems).toEqual([]);
    expect(props.initialNextCursor).toBeNull();
  });
});
