/**
 * The dashboard RSC route tests (W2-03) — workspace resolution through the
 * shared shell seam (`/v1/me → memberships` + the `?ws=` switcher seam, via
 * lib/workspace-membership), the ONE projects read (`GET /v1/projects` page
 * 1, limit 12), and the redirect/404/§8.4-error semantics: no membership →
 * `/onboarding`; expired session → `/sign-in` with a `next` round-trip;
 * cross-tenant/missing workspace → 404 (hard rule 3); a failed projects
 * read renders the view with the sanitized error payload so the page stays
 * usable (never a thrown stack). `@/lib/gateway` is mocked (the seam's own
 * tests cover the unwrap); `DashboardView` is stubbed so this stays an
 * RSC-logic test (the billing page.test.tsx pattern).
 */

import type { DashboardViewProps } from "@/components/dashboard/dashboard-view";
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

let lastViewProps: DashboardViewProps | null = null;
vi.mock("@/components/dashboard/dashboard-view", () => ({
  DashboardView: (props: DashboardViewProps) => {
    lastViewProps = props;
    return <div data-testid="dashboard-view-stub" data-workspace={props.workspaceId} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import DashboardPage from "./page";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const MEMBERSHIPS = [
  {
    workspaceId: "ws_first",
    role: "owner",
    workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
  },
  {
    workspaceId: "ws_second",
    role: "editor",
    workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
  },
];

const ME = {
  user: { id: "user_1", name: "Alex", email: "alex@example.com" },
  memberships: MEMBERSHIPS,
};

function wireProject(index: number) {
  return {
    id: `prj_${index}`,
    workspaceId: "ws_first",
    name: `Film ${index}`,
    slug: `film-${index}`,
    thumbnailUrl: null,
    archived: false,
    currentVersionId: null,
    createdBy: "user_1",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
    deletedAt: null,
  };
}

async function renderPage(ws?: string): Promise<React.ReactNode> {
  return DashboardPage({ searchParams: Promise.resolve(ws === undefined ? {} : { ws }) });
}

beforeEach(() => {
  lastViewProps = null;
  gatewayMock.mockReset();
});

describe("dashboard RSC route", () => {
  it("resolves the first membership, reads one projects page and renders the view", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve(ME);
      if (path === "/v1/projects?limit=12") {
        expect(init?.workspaceId).toBe("ws_first");
        return Promise.resolve({
          items: [wireProject(0), wireProject(1)],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("dashboard-view-stub")).toBeInTheDocument();
    const calls = gatewayMock.mock.calls.map(([path]) => path);
    expect(calls).toEqual(["/v1/me", "/v1/projects?limit=12"]);
    expect(lastViewProps).not.toBeNull();
    const props = lastViewProps as DashboardViewProps;
    expect(props.workspaceId).toBe("ws_first");
    expect(props.userName).toBe("Alex");
    expect(props.initialError).toBeNull();
    expect(props.initialProjects).toEqual([
      { id: "prj_0", name: "Film 0", slug: "film-0", updatedAt: "2026-10-21T10:00:00Z" },
      { id: "prj_1", name: "Film 1", slug: "film-1", updatedAt: "2026-10-21T10:00:00Z" },
    ]);
    expect(Number.isNaN(Date.parse(props.nowIso))).toBe(false);
  });

  it("honors ?ws= by id or slug and scopes the projects read to it", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve(ME);
      if (path === "/v1/projects?limit=12") {
        expect(init?.workspaceId).toBe("ws_second");
        return Promise.resolve({ items: [], nextCursor: null });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("second-studio");
    render(page);
    const props = lastViewProps as DashboardViewProps;
    expect(props.workspaceId).toBe("ws_second");
    expect(props.initialProjects).toEqual([]);
  });

  it("redirects to /onboarding when the user has no membership (W2-02 first-run)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: [] });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage()).rejects.toThrow("__REDIRECT__:/onboarding");
  });

  it("404s an explicit but unknown ?ws= (cross-tenant = 404, hard rule 3)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME);
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
    await expect(renderPage()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw");
  });

  it("404s the gateway's NOT_FOUND on the me read", async () => {
    gatewayMock.mockImplementation(() =>
      Promise.reject(
        new GatewayHttpError({ status: 404, code: "NOT_FOUND", message: "Not found." }),
      ),
    );
    await expect(renderPage()).rejects.toThrow("__NOT_FOUND__");
  });

  it("degrades a failed projects read to the inline error payload (§8.4: the page stays usable)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME);
      return Promise.reject(
        new GatewayHttpError({
          status: 503,
          code: "INTERNAL_ERROR",
          message: "Something went wrong on our side.",
        }),
      );
    });
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("dashboard-view-stub")).toBeInTheDocument();
    const props = lastViewProps as DashboardViewProps;
    expect(props.initialProjects).toBeNull();
    // The sanitized §7.3 message (the mock's GatewayHttpError carries no
    // hint/request id — those flow through when the real seam provides them).
    expect(props.initialError?.message).toBe("Something went wrong on our side.");
    expect(props.userName).toBe("Alex");
  });

  it("redirects a session that dies between the two reads", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME);
      return Promise.reject(
        new GatewayHttpError({
          status: 401,
          code: "UNAUTHORIZED",
          message: "Sign in to continue.",
        }),
      );
    });
    await expect(renderPage()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw");
  });

  it("404s a WORKSPACE_NOT_FOUND on the projects read (cross-tenant, hard rule 3)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME);
      return Promise.reject(
        new GatewayHttpError({
          status: 404,
          code: "WORKSPACE_NOT_FOUND",
          message: "Not found.",
        }),
      );
    });
    await expect(renderPage()).rejects.toThrow("__NOT_FOUND__");
  });

  it("degrades a non-envelope network failure on the projects read (sanitized, never a stack)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME);
      return Promise.reject(new TypeError("fetch failed"));
    });
    const page = await renderPage();
    render(page);

    const props = lastViewProps as DashboardViewProps;
    expect(props.initialProjects).toBeNull();
    expect(props.initialError).toEqual({
      message: "Your projects could not be loaded.",
      hint: "Try again in a moment.",
    });
  });

  it("tolerates a malformed projects payload (rows dropped, never a crash)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME);
      if (path === "/v1/projects?limit=12") {
        return Promise.resolve({ items: [wireProject(0), { id: "bad" }, null, "nope"] });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    const props = lastViewProps as DashboardViewProps;
    expect(props.initialError).toBeNull();
    expect(props.initialProjects).toEqual([
      { id: "prj_0", name: "Film 0", slug: "film-0", updatedAt: "2026-10-21T10:00:00Z" },
    ]);
  });

  it("tolerates a missing user block (greeting degrades to nameless)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path === "/v1/projects?limit=12") {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    const props = lastViewProps as DashboardViewProps;
    expect(props.userName).toBeNull();
  });

  it("rethrows a non-gateway failure on the me read (the error boundary renders §7.3)", async () => {
    gatewayMock.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));
    await expect(renderPage()).rejects.toThrow("fetch failed");
  });
});
