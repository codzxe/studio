/**
 * The API keys RSC route tests (W2-07) — workspace resolution
 * (`/v1/me → memberships` + the `?ws=` switcher seam), the owner/admin
 * `canManage` bit, and the 404/redirect/empty-state semantics (hard rule 3;
 * §7.3 sanitized errors). `@/lib/gateway` is mocked (the seam's own tests
 * cover the unwrap); `ApiKeysView` is stubbed so this stays an RSC-logic
 * test (the billing route's page.test.tsx pattern).
 */

import type { ApiKeysViewProps } from "@/components/settings/api-keys-view";
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

let lastViewProps: ApiKeysViewProps | null = null;
vi.mock("@/components/settings/api-keys-view", () => ({
  ApiKeysView: (props: ApiKeysViewProps) => {
    lastViewProps = props;
    return <div data-testid="api-keys-view-stub" data-workspace={props.workspaceId} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import ApiKeysPage from "./page";

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
    role: "viewer",
    workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
  },
];

async function renderPage(ws?: string): Promise<React.ReactNode> {
  return ApiKeysPage({ searchParams: Promise.resolve(ws === undefined ? {} : { ws }) });
}

beforeEach(() => {
  lastViewProps = null;
  gatewayMock.mockReset();
});

describe("api-keys RSC route", () => {
  it("resolves the first membership and mounts the view with canManage for owners", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("api-keys-view-stub")).toBeInTheDocument();
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(lastViewProps).not.toBeNull();
    const props = lastViewProps as ApiKeysViewProps;
    expect(props.workspaceId).toBe("ws_first");
    expect(props.canManage).toBe(true);
    expect(Number.isNaN(Date.parse(props.nowIso))).toBe(false);
  });

  it("honors ?ws= by slug and maps viewer to canManage=false (no doomed 403 fetch)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("second-studio");
    render(page);
    const props = lastViewProps as ApiKeysViewProps;
    expect(props.workspaceId).toBe("ws_second");
    expect(props.canManage).toBe(false);
  });

  it("404s an explicit but unknown ?ws= (cross-tenant = 404, hard rule 3)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
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
    await expect(renderPage()).rejects.toThrow(
      "__REDIRECT__:/sign-in?next=%2Fw%2Fsettings%2Fapi-keys",
    );
  });

  it("404s the gateway's NOT_FOUND on the me read", async () => {
    gatewayMock.mockImplementation(() =>
      Promise.reject(
        new GatewayHttpError({
          status: 404,
          code: "NOT_FOUND",
          message: "Not found.",
        }),
      ),
    );
    await expect(renderPage()).rejects.toThrow("__NOT_FOUND__");
  });

  it("renders the honest empty state when the user has no workspace", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: [] });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    expect(screen.getByTestId("api-keys-no-workspace")).toBeInTheDocument();
    expect(screen.getByText("You don't belong to a workspace yet.")).toBeInTheDocument();
  });
});
