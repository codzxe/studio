/**
 * The billing RSC route tests — workspace resolution (`/v1/me → memberships`
 * + the `?ws=` switcher seam), the ONE gateway state read, and the
 * 404/redirect/empty-state semantics (hard rule 3; §7.3 sanitized errors).
 * `@/lib/gateway` is mocked (the seam's own tests cover the unwrap);
 * `BillingPageView` is stubbed so this stays an RSC-logic test (the editor
 * route's page.test.tsx pattern).
 */

import type { BillingPageViewProps } from "@/components/billing/page-billing-view";
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

let lastViewProps: BillingPageViewProps | null = null;
vi.mock("@/components/billing/page-billing-view", () => ({
  BillingPageView: (props: BillingPageViewProps) => {
    lastViewProps = props;
    return <div data-testid="billing-view-stub" data-workspace={props.workspaceName} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import BillingPage from "./page";

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

const BILLING_STATE = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: "2026-11-01T00:00:00Z",
  trialEnd: null,
  cancelAtPeriodEnd: false,
  graceEnd: null,
  entitlements: {
    seats: 5,
    models: ["studio-fast", "studio-smart"],
    maxProjects: 50,
    storageBytes: 200 * 1024 ** 3,
    renderMinutesPerMonth: 600,
    monthlyCreditAllowance: 2_000_000_000,
  },
  credits: { balance: 12_345_678, reserved: 250_000 },
  topUpPacks: [
    { packId: "credits100", credits: 100 },
    { packId: "credits500", credits: 500 },
  ],
};

async function renderPage(ws?: string): Promise<React.ReactNode> {
  return BillingPage({ searchParams: Promise.resolve(ws === undefined ? {} : { ws }) });
}

beforeEach(() => {
  lastViewProps = null;
  gatewayMock.mockReset();
});

describe("billing RSC route", () => {
  it("resolves the first membership, reads state once through the seam and renders the view", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path === "/v1/billing/state") {
        expect(init?.workspaceId).toBe("ws_first");
        return Promise.resolve(BILLING_STATE);
      }
      if (path === "/v1/billing/invoices?limit=25") {
        // W1-e tail: the REAL invoice history read (newest-first page).
        return Promise.resolve({
          items: [
            {
              id: "inv_row_1",
              stripeInvoiceId: "in_test1",
              amountCents: 2900,
              currency: "usd",
              status: "paid",
              periodStart: null,
              periodEnd: null,
              hostedUrl: "https://billing.example/in_test1",
              pdfUrl: null,
              createdAt: "2026-10-01T00:00:00Z",
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);

    expect(screen.getByTestId("billing-view-stub")).toBeInTheDocument();
    const calls = gatewayMock.mock.calls.map(([path]) => path);
    expect(calls).toEqual(["/v1/me", "/v1/billing/state", "/v1/billing/invoices?limit=25"]);
    expect(lastViewProps).not.toBeNull();
    const props = lastViewProps as BillingPageViewProps;
    expect(props.workspaceId).toBe("ws_first");
    expect(props.workspaceName).toBe("First Films");
    expect(props.canManage).toBe(true);
    expect(props.initialState.plan).toBe("pro");
    expect(props.initialState.credits.balance).toBe(12_345_678);
    expect(props.invoices).toEqual([
      {
        id: "inv_row_1",
        date: "2026-10-01T00:00:00Z",
        amountCents: 2900,
        currency: "usd",
        status: "paid",
        hostedUrl: "https://billing.example/in_test1",
        pdfUrl: null,
      },
    ]);
    expect(Number.isNaN(Date.parse(props.nowIso))).toBe(false);
  });

  it("honors ?ws= by id or slug and maps the role to canManage", async () => {
    gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path === "/v1/billing/state") {
        expect(init?.workspaceId).toBe("ws_second");
        return Promise.resolve(BILLING_STATE);
      }
      if (path === "/v1/billing/invoices?limit=25") {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("second-studio");
    render(page);
    const props = lastViewProps as BillingPageViewProps;
    expect(props.workspaceName).toBe("Second Studio");
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
    await expect(renderPage()).rejects.toThrow("__REDIRECT__:/sign-in?next=%2Fw%2Fbilling");
  });

  it("404s the gateway's NOT_FOUND on the state read", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
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
    expect(screen.getByTestId("billing-no-workspace")).toBeInTheDocument();
    expect(screen.getByText("You don't belong to a workspace yet.")).toBeInTheDocument();
  });

  it("renders the unavailable state when the billing payload is malformed (never a stack)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path === "/v1/billing/state") return Promise.resolve({ plan: "pro" });
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage();
    render(page);
    expect(screen.getByTestId("billing-unavailable")).toBeInTheDocument();
    expect(screen.getByText("Billing is unavailable right now.")).toBeInTheDocument();
  });
});
