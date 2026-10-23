/**
 * The (shell) RSC layout tests (W2-01) — the session bootstrap every `/w`
 * hub page mounts into: `/v1/me` membership parse, the no-membership →
 * `/onboarding` redirect, the 401 → `/sign-in?next=/w` round-trip, and the
 * billing degrade policy (401 mid-load still redirects; 404/5xx/malformed →
 * `credits/entitlements: null`, the shell never blocks on a secondary read).
 * `@/lib/gateway` is mocked (the seam's own tests cover the unwrap);
 * `AppShell` is stubbed so this stays an RSC-logic test (the billing route's
 * page.test.tsx pattern).
 */

import type { ShellPayload } from "@/components/shell/app-shell";
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

let lastShellProps: ShellPayload | null = null;
vi.mock("@/components/shell/app-shell", () => ({
  AppShell: (props: { payload: ShellPayload; children: React.ReactNode }) => {
    lastShellProps = props.payload;
    return <div data-testid="app-shell-stub">{props.children}</div>;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import ShellLayout from "./layout";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const ME_BODY = {
  user: { id: "user_1", name: "Alex Jordan", email: "alex@example.com" },
  plan: { plan: "pro", creditsBalance: 1, includedCredits: 2, renewsAt: null },
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
};

const BILLING_STATE = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  graceEnd: null,
  entitlements: {
    seats: 5,
    models: ["studio-fast", "studio-smart"],
    maxProjects: 50,
    storageBytes: 200 * 1024 ** 3,
    renderMinutesPerMonth: 600,
    monthlyCreditAllowance: 20_000_000,
  },
  credits: { balance: 12_345_678, reserved: 250_000 },
  topUpPacks: [],
};

async function renderLayout(): Promise<void> {
  const tree = await ShellLayout({ children: <p data-testid="page-content">Page</p> });
  render(tree);
}

beforeEach(() => {
  lastShellProps = null;
  gatewayMock.mockReset();
});

describe("(shell) layout (RSC)", () => {
  it("bootstraps the shell: /v1/me + billing/state for the first membership, serializable payload", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve(ME_BODY);
      if (path === "/v1/billing/state") {
        expect(init?.workspaceId).toBe("ws_first");
        return Promise.resolve(BILLING_STATE);
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await renderLayout();

    expect(screen.getByTestId("app-shell-stub")).toBeInTheDocument();
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    const calls = gatewayMock.mock.calls.map(([path]: [string]) => path);
    expect(calls).toEqual(["/v1/me", "/v1/billing/state"]);

    expect(lastShellProps).not.toBeNull();
    const props = lastShellProps as ShellPayload;
    expect(props.user).toEqual({
      id: "user_1",
      name: "Alex Jordan",
      email: "alex@example.com",
    });
    expect(props.memberships).toHaveLength(2);
    expect(props.activeWorkspaceId).toBe("ws_first");
    expect(props.activeWorkspaceSlug).toBe("first-films");
    expect(props.credits).toEqual({ balance: 12_345_678, reserved: 250_000 });
    expect(props.entitlements?.monthlyCreditAllowance).toBe(20_000_000);
  });

  it("redirects an expired session to /sign-in with a next round-trip", async () => {
    gatewayMock.mockRejectedValue(
      new GatewayHttpError({ status: 401, code: "UNAUTHORIZED", message: "Sign in to continue." }),
    );
    await expect(renderLayout()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw");
  });

  it("redirects a user with NO workspace membership to /onboarding", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ ...ME_BODY, memberships: [] });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderLayout()).rejects.toThrow("__REDIRECT__:/onboarding");
  });

  it("still redirects when the session dies between the two reads (billing 401)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_BODY);
      return Promise.reject(
        new GatewayHttpError({ status: 401, code: "UNAUTHORIZED", message: "Sign in." }),
      );
    });
    await expect(renderLayout()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw");
  });

  it("degrades to credits=null on a billing 404 race (pages own their 404s)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_BODY);
      return Promise.reject(
        new GatewayHttpError({
          status: 404,
          code: "WORKSPACE_NOT_FOUND",
          message: "Not found.",
        }),
      );
    });
    await renderLayout();
    expect(screen.getByTestId("app-shell-stub")).toBeInTheDocument();
    const props = lastShellProps as ShellPayload;
    expect(props.credits).toBeNull();
    expect(props.entitlements).toBeNull();
    expect(props.memberships).toHaveLength(2);
  });

  it("degrades to credits=null on a billing 5xx (the shell never blocks)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_BODY);
      return Promise.reject(
        new GatewayHttpError({
          status: 503,
          code: "INTERNAL_ERROR",
          message: "Something went wrong on our side.",
        }),
      );
    });
    await renderLayout();
    expect(screen.getByTestId("app-shell-stub")).toBeInTheDocument();
    expect((lastShellProps as ShellPayload).credits).toBeNull();
  });

  it("degrades to credits=null on a malformed billing payload (never a stack)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve(ME_BODY);
      if (path === "/v1/billing/state") return Promise.resolve({ plan: "pro" });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await renderLayout();
    expect(screen.getByTestId("app-shell-stub")).toBeInTheDocument();
    expect((lastShellProps as ShellPayload).credits).toBeNull();
  });

  it("rethrows non-gateway failures for the error boundary (sanitized §7.3)", async () => {
    gatewayMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(renderLayout()).rejects.toThrow(TypeError);
  });
});
