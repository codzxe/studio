/**
 * The Members settings RSC route tests (W2-06) — workspace resolution through
 * the shared workspace-membership seam, the ONE roster read (bounded pages)
 * and the tolerant billing seat-limit read, plus the 404/redirect/empty/
 * unavailable semantics (hard rule 3; §7.3 sanitized errors). `@/lib/gateway`
 * is mocked (the billing page.test.tsx pattern); `MembersTable` +
 * `RolesExplainer` are stubbed so this stays an RSC-logic test.
 */

import type { MembersTableProps } from "@/components/settings/members-table";
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

let lastTableProps: MembersTableProps | null = null;
vi.mock("@/components/settings/members-table", () => ({
  MembersTable: (props: MembersTableProps) => {
    lastTableProps = props;
    return <div data-testid="members-table-stub" />;
  },
}));
vi.mock("@/components/settings/roles-explainer", () => ({
  RolesExplainer: () => <div data-testid="roles-explainer-stub" />,
}));

import { GatewayHttpError } from "@/lib/gateway";
import MembersSettingsPage from "./page";

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

const MEMBER_ROWS = [
  {
    id: "u_owner",
    name: "Ada Owner",
    email: "ada@example.com",
    role: "owner",
    status: "active",
    lastActiveAt: null,
    isCurrentUser: true,
  },
  {
    id: "u_viewer",
    name: "Cleo Viewer",
    email: "cleo@example.com",
    role: "viewer",
    status: "active",
    lastActiveAt: null,
    isCurrentUser: false,
  },
];

const BILLING_STATE = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: "2026-11-01T00:00:00Z",
  trialEnd: null,
  cancelAtPeriodEnd: false,
  graceEnd: null,
  entitlements: {
    seats: 5,
    models: ["studio-fast"],
    maxProjects: 50,
    storageBytes: 200 * 1024 ** 3,
    renderMinutesPerMonth: 600,
    monthlyCreditAllowance: 2_000_000_000,
  },
  credits: { balance: 1, reserved: 0 },
  topUpPacks: [],
};

/** A gateway mock that answers the members page's three reads. */
function happyGateway(overrides?: {
  readonly membersPage?: unknown;
  readonly billingState?: unknown;
}): typeof gatewayMock {
  return gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
    if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
    if (path.startsWith("/v1/workspaces/") && path.includes("/members")) {
      expect(init?.workspaceId).toBe("ws_first");
      return Promise.resolve(overrides?.membersPage ?? { items: MEMBER_ROWS, nextCursor: null });
    }
    if (path === "/v1/billing/state") {
      expect(init?.workspaceId).toBe("ws_first");
      return Promise.resolve(overrides?.billingState ?? BILLING_STATE);
    }
    throw new Error(`unexpected gateway path: ${path}`);
  });
}

async function renderPage(ws?: string): Promise<React.ReactNode> {
  return MembersSettingsPage({ searchParams: Promise.resolve(ws === undefined ? {} : { ws }) });
}

beforeEach(() => {
  lastTableProps = null;
  gatewayMock.mockReset();
});

describe("members settings RSC route", () => {
  it("resolves the first membership, loads the roster + seat limit, renders table and roles", async () => {
    happyGateway();
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("members-table-stub")).toBeInTheDocument();
    expect(screen.getByTestId("roles-explainer-stub")).toBeInTheDocument();
    const calls = gatewayMock.mock.calls.map(([path]) => path);
    expect(calls).toEqual([
      "/v1/me",
      "/v1/workspaces/ws_first/members?limit=100",
      "/v1/billing/state",
    ]);
    expect(lastTableProps).not.toBeNull();
    const props = lastTableProps as MembersTableProps;
    expect(props.workspaceId).toBe("ws_first");
    expect(props.workspaceName).toBe("First Films");
    expect(props.currentRole).toBe("owner");
    expect(props.seatsLimit).toBe(5);
    expect(props.membersTruncated).toBe(false);
    expect(props.initialMembers).toEqual(MEMBER_ROWS);
  });

  it("honors ?ws= by slug and carries the caller's role through", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/workspaces/") && path.includes("/members")) {
        expect(init?.workspaceId).toBe("ws_second");
        return Promise.resolve({ items: MEMBER_ROWS, nextCursor: null });
      }
      if (path === "/v1/billing/state") {
        return Promise.resolve(BILLING_STATE);
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("second-studio");
    render(page);
    const props = lastTableProps as MembersTableProps;
    expect(props.workspaceName).toBe("Second Studio");
    expect(props.currentRole).toBe("viewer");
  });

  it("follows the cursor across pages and marks a truncated load", async () => {
    let membersCall = 0;
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/workspaces/") && path.includes("/members")) {
        membersCall += 1;
        if (membersCall === 1) {
          return Promise.resolve({ items: MEMBER_ROWS, nextCursor: "cursor_2" });
        }
        // Pages 2-4 answer empty-with-a-cursor: the bounded load gives up at
        // MAX_MEMBER_PAGES and the count renders honestly as truncated.
        return Promise.resolve({ items: [], nextCursor: "cursor_more" });
      }
      if (path === "/v1/billing/state") return Promise.resolve(BILLING_STATE);
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    const membersCalls = gatewayMock.mock.calls
      .map(([path]) => path)
      .filter((path) => path.includes("/members"));
    expect(membersCalls).toHaveLength(4);
    const props = lastTableProps as MembersTableProps;
    expect(props.membersTruncated).toBe(true);
    expect(props.initialMembers).toHaveLength(2);
  });

  it("degrades to seatsLimit=null when the billing read fails (page still renders)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/workspaces/") && path.includes("/members")) {
        return Promise.resolve({ items: MEMBER_ROWS, nextCursor: null });
      }
      if (path === "/v1/billing/state") {
        return Promise.reject(
          new GatewayHttpError({ status: 500, code: "INTERNAL_ERROR", message: "Boom." }),
        );
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    expect((lastTableProps as MembersTableProps).seatsLimit).toBeNull();
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
      "__REDIRECT__:/sign-in?next=%2Fw%2Fsettings%2Fmembers",
    );
  });

  it("404s the gateway's NOT_FOUND on the roster read", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      return Promise.reject(
        new GatewayHttpError({ status: 404, code: "WORKSPACE_NOT_FOUND", message: "Not found." }),
      );
    });
    await expect(renderPage()).rejects.toThrow("__NOT_FOUND__");
  });

  it("renders the honest unavailable state on a malformed roster payload", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/workspaces/") && path.includes("/members")) {
        return Promise.resolve({ items: "not-an-array" });
      }
      if (path === "/v1/billing/state") return Promise.resolve(BILLING_STATE);
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    expect(screen.getByTestId("members-unavailable")).toBeInTheDocument();
    expect(screen.getByText("Members are unavailable right now.")).toBeInTheDocument();
  });

  it("skips malformed member rows instead of crashing (law #1)", async () => {
    happyGateway({
      membersPage: {
        items: [...MEMBER_ROWS, { id: "u_bad", role: "space-wizard" }, { name: "no id" }],
        nextCursor: null,
      },
    });
    const page = await renderPage();
    render(page);
    const props = lastTableProps as MembersTableProps;
    expect(props.initialMembers).toHaveLength(2);
  });

  it("renders the honest empty state when the user has no workspace", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: [] });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    expect(screen.getByTestId("members-no-workspace")).toBeInTheDocument();
  });
});
