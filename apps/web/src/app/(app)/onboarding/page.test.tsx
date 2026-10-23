/**
 * The onboarding RSC route tests — the ONE gateway read (`/v1/me`), the 401
 * sign-in round-trip, the has-membership redirect to `/w`, and the render
 * arm. `@/lib/gateway` is mocked (the seam's own tests cover the unwrap);
 * `OnboardingFlow` is stubbed so this stays an RSC-logic test (the billing
 * page.test.tsx pattern).
 */

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

vi.mock("@/components/onboarding/onboarding-flow", () => ({
  OnboardingFlow: () => <div data-testid="onboarding-flow-stub" />,
}));

import { GatewayHttpError } from "@/lib/gateway";
import OnboardingPage from "./page";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const ME_WITH_MEMBERSHIP = {
  user: { id: "user_1", name: "Alex", email: "alex@example.com" },
  memberships: [
    {
      workspaceId: "ws_first",
      role: "owner",
      workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
    },
  ],
  plan: { plan: "starter", creditsBalance: 0, includedCredits: 0, renewsAt: null },
};

const ME_WITHOUT_MEMBERSHIP = {
  user: { id: "user_2", name: "Sam", email: "sam@example.com" },
  memberships: [],
  plan: { plan: "trial", creditsBalance: 0, includedCredits: 0, renewsAt: null },
};

beforeEach(() => {
  gatewayMock.mockReset();
});

describe("onboarding RSC route", () => {
  it("renders the flow for a signed-in user with no memberships", async () => {
    gatewayMock.mockResolvedValue(ME_WITHOUT_MEMBERSHIP);
    const page = await OnboardingPage();
    render(page);

    expect(screen.getByTestId("onboarding-flow-stub")).toBeInTheDocument();
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock).toHaveBeenCalledWith("/v1/me");
  });

  it("redirects an expired session to /sign-in with a next round-trip", async () => {
    gatewayMock.mockRejectedValue(
      new GatewayHttpError({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Sign in to continue.",
      }),
    );
    await expect(OnboardingPage()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fonboarding");
  });

  it("redirects a user who already belongs to a workspace straight to /w", async () => {
    gatewayMock.mockResolvedValue(ME_WITH_MEMBERSHIP);
    await expect(OnboardingPage()).rejects.toThrow("__REDIRECT__:/w");
  });

  it("treats a malformed /v1/me as no-memberships and renders the flow (never a stack)", async () => {
    gatewayMock.mockResolvedValue({ memberships: "not-an-array" });
    const page = await OnboardingPage();
    render(page);

    expect(screen.getByTestId("onboarding-flow-stub")).toBeInTheDocument();
  });

  it("rethrows non-auth gateway failures (the error boundary owns them)", async () => {
    gatewayMock.mockRejectedValue(
      new GatewayHttpError({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "The database is not reachable right now.",
      }),
    );
    await expect(OnboardingPage()).rejects.toThrow(
      "The database is not reachable right now.",
    );
  });
});
