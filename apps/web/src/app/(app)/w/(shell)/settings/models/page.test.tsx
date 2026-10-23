/**
 * The models & preferences RSC route tests (W2-07) — workspace resolution
 * (`/v1/me → memberships` + the `?ws=` switcher seam) and the
 * 404/redirect/empty-state semantics (hard rule 3). `@/lib/gateway` is
 * mocked; `ModelsPreferencesView` is stubbed so this stays an RSC-logic test
 * (the billing route's page.test.tsx pattern). No role gating — models.list
 * is viewer-floored and auto-apply is per-USER, not per-workspace.
 */

import type { ModelsPreferencesViewProps } from "@/components/settings/models-preferences-view";
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

let lastViewProps: ModelsPreferencesViewProps | null = null;
vi.mock("@/components/settings/models-preferences-view", () => ({
  ModelsPreferencesView: (props: ModelsPreferencesViewProps) => {
    lastViewProps = props;
    return <div data-testid="models-view-stub" data-workspace={props.workspaceId} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import ModelsPage from "./page";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const MEMBERSHIPS = [
  {
    workspaceId: "ws_first",
    role: "editor",
    workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
  },
];

async function renderPage(ws?: string): Promise<React.ReactNode> {
  return ModelsPage({ searchParams: Promise.resolve(ws === undefined ? {} : { ws }) });
}

beforeEach(() => {
  lastViewProps = null;
  gatewayMock.mockReset();
});

describe("models & preferences RSC route", () => {
  it("resolves the membership and mounts the view — editors included", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("models-view-stub")).toBeInTheDocument();
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(lastViewProps).not.toBeNull();
    expect((lastViewProps as ModelsPreferencesViewProps).workspaceId).toBe("ws_first");
  });

  it("honors ?ws= by slug", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("first-films");
    render(page);
    expect((lastViewProps as ModelsPreferencesViewProps).workspaceId).toBe("ws_first");
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
      "__REDIRECT__:/sign-in?next=%2Fw%2Fsettings%2Fmodels",
    );
  });

  it("renders the honest empty state when the user has no workspace", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: [] });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    expect(screen.getByTestId("models-no-workspace")).toBeInTheDocument();
  });
});
