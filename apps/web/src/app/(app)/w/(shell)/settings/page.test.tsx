/**
 * The General settings RSC route tests (W2-06) — workspace resolution through
 * the shared workspace-membership seam (`/v1/me → memberships` + the `?ws=`
 * switcher), the 404/redirect/empty-state semantics (hard rule 3; §7.3
 * sanitized errors). `@/lib/gateway` is mocked (the seam's own tests cover
 * the unwrap); `GeneralForm` is stubbed so this stays an RSC-logic test (the
 * billing page.test.tsx pattern).
 */

import type { GeneralFormProps } from "@/components/settings/general-form";
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

let lastFormProps: GeneralFormProps | null = null;
vi.mock("@/components/settings/general-form", () => ({
  GeneralForm: (props: GeneralFormProps) => {
    lastFormProps = props;
    return <div data-testid="general-form-stub" data-workspace={props.workspaceName} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import GeneralSettingsPage from "./page";

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
  return GeneralSettingsPage({ searchParams: Promise.resolve(ws === undefined ? {} : { ws }) });
}

beforeEach(() => {
  lastFormProps = null;
  gatewayMock.mockReset();
});

describe("settings General RSC route", () => {
  it("resolves the first membership and renders the form with name/slug/canManage", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("general-form-stub")).toBeInTheDocument();
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock).toHaveBeenCalledWith("/v1/me", undefined);
    expect(lastFormProps).not.toBeNull();
    const props = lastFormProps as GeneralFormProps;
    expect(props.workspaceId).toBe("ws_first");
    expect(props.workspaceName).toBe("First Films");
    expect(props.workspaceSlug).toBe("first-films");
    expect(props.canManage).toBe(true);
  });

  it("honors ?ws= by slug and maps the role to canManage=false for viewers", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("second-studio");
    render(page);
    const props = lastFormProps as GeneralFormProps;
    expect(props.workspaceId).toBe("ws_second");
    expect(props.workspaceName).toBe("Second Studio");
    expect(props.workspaceSlug).toBe("second-studio");
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
    await expect(renderPage()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw%2Fsettings");
  });

  it("404s the gateway's NOT_FOUND on the me read", async () => {
    gatewayMock.mockImplementation(() =>
      Promise.reject(
        new GatewayHttpError({
          status: 404,
          code: "WORKSPACE_NOT_FOUND",
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
    expect(screen.getByTestId("settings-no-workspace")).toBeInTheDocument();
    expect(screen.getByText("You don't belong to a workspace yet.")).toBeInTheDocument();
  });

  it("rethrows unexpected gateway failures for the error boundary (never a stack)", async () => {
    gatewayMock.mockImplementation(() =>
      Promise.reject(
        new GatewayHttpError({
          status: 503,
          code: "INTERNAL_ERROR",
          message: "Something went wrong on our side.",
        }),
      ),
    );
    await expect(renderPage()).rejects.toThrow("Something went wrong on our side.");
  });
});
