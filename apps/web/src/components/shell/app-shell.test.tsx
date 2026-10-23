/**
 * AppShell tests (W2-01, §8.4) — the client shell root: rail + top bar +
 * children composition, the manifest payload arms (no credits, viewer role,
 * many workspaces), the ?ws display refinement (client-side billing.state
 * refetch through the workspace-scoped port), and the keyboard wiring
 * (⌘K palette per D-5; ⌘N new-project per W2-B4). next/navigation and the
 * better-auth client are mocked; the port factory is faked (the
 * fakePort/asBillingPort house pattern — no network).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceMembership } from "@/lib/workspace-membership";
import { AppShell, type ShellPayload } from "./app-shell";
import type { ShellPort } from "./top-bar";

const { routerPush, pathname, searchParams } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  pathname: { current: "/w" },
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams.current,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signOut: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
  SESSION_COOKIE_NAME: "better-auth.session_token",
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER: WorkspaceMembership = {
  workspaceId: "ws_first",
  role: "owner",
  workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
};

const VIEWER: WorkspaceMembership = {
  workspaceId: "ws_second",
  role: "viewer",
  workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
};

const THIRD: WorkspaceMembership = {
  workspaceId: "ws_third",
  role: "admin",
  workspace: { id: "ws_third", name: "Third Pictures", slug: "third-pictures" },
};

const BILLING_STATE_FIRST = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  graceEnd: null,
  entitlements: {
    seats: 5,
    models: ["studio-fast"],
    maxProjects: 50,
    storageBytes: 1,
    renderMinutesPerMonth: 600,
    monthlyCreditAllowance: 20_000_000,
  },
  credits: { balance: 12_345_678, reserved: 0 },
  topUpPacks: [],
};

const BILLING_STATE_SECOND = {
  ...BILLING_STATE_FIRST,
  credits: { balance: 500_000, reserved: 0 },
};

function payload(overrides: Partial<ShellPayload> = {}): ShellPayload {
  return {
    user: { id: "user_1", name: "Alex Jordan", email: "alex@example.com" },
    memberships: [OWNER, VIEWER],
    activeWorkspaceId: "ws_first",
    activeWorkspaceSlug: "first-films",
    credits: { balance: 12_345_678, reserved: 250_000 },
    entitlements: {
      seats: 5,
      models: ["studio-fast"],
      maxProjects: 50,
      storageBytes: 200 * 1024 ** 3,
      renderMinutesPerMonth: 600,
      monthlyCreditAllowance: 20_000_000,
    },
    ...overrides,
  };
}

function fakePort(stateMock?: ReturnType<typeof vi.fn>): ShellPort {
  return {
    members: { switchWorkspace: vi.fn().mockResolvedValue(undefined) },
    billing: { state: stateMock ?? vi.fn().mockResolvedValue(BILLING_STATE_FIRST) },
    projects: {
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    },
  };
}

/** A port factory that records the workspace it was built for. */
function fakePortFactory(builtFor: string[], stateMock?: ReturnType<typeof vi.fn>) {
  return (workspaceId: string): ShellPort => {
    builtFor.push(workspaceId);
    return fakePort(stateMock);
  };
}

beforeEach(() => {
  routerPush.mockClear();
  pathname.current = "/w";
  searchParams.current = new URLSearchParams();
});

describe("AppShell — composition", () => {
  it("renders rail + top bar + children from the server payload", async () => {
    render(
      <AppShell payload={payload()} createPort={fakePortFactory([])}>
        <p data-testid="page-content">Dashboard page</p>
      </AppShell>,
    );

    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-rail")).toBeInTheDocument();
    expect(screen.getByTestId("shell-top-bar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-switcher")).toHaveTextContent("First Films");
    expect(screen.getByTestId("topbar-credits")).toHaveTextContent("12.35 credits");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    // Palette + offline banner start closed/absent.
    expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shell-offline-banner")).not.toBeInTheDocument();
  });

  it("no-credits arm: the top bar degrades to the billing link, children still render", () => {
    render(
      <AppShell
        payload={payload({ credits: null, entitlements: null })}
        createPort={fakePortFactory([])}
      >
        <p data-testid="page-content">Dashboard page</p>
      </AppShell>,
    );
    expect(screen.queryByTestId("topbar-credits")).not.toBeInTheDocument();
    expect(screen.getByTestId("topbar-credits-unavailable")).toHaveTextContent("Billing");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("viewer-role arm: the shell renders for a viewer (role visible in the switcher)", async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        payload={payload({
          memberships: [OWNER, VIEWER],
          activeWorkspaceId: "ws_second",
          activeWorkspaceSlug: "second-studio",
        })}
        createPort={fakePortFactory([])}
      >
        <p data-testid="page-content">Viewer page</p>
      </AppShell>,
    );
    expect(screen.getByTestId("workspace-switcher")).toHaveTextContent("Second Studio");
    await user.click(screen.getByTestId("workspace-switcher"));
    expect(screen.getByTestId("switcher-second-studio")).toHaveTextContent("viewer");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("many-workspaces arm: the switcher lists every membership", async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        payload={payload({ memberships: [OWNER, VIEWER, THIRD] })}
        createPort={fakePortFactory([])}
      >
        <p data-testid="page-content">Dashboard page</p>
      </AppShell>,
    );
    await user.click(screen.getByTestId("workspace-switcher"));
    expect(screen.getByTestId("switcher-first-films")).toBeInTheDocument();
    expect(screen.getByTestId("switcher-second-studio")).toBeInTheDocument();
    expect(screen.getByTestId("switcher-third-pictures")).toBeInTheDocument();
  });
});

describe("AppShell — ?ws display refinement", () => {
  it("adopts a matching ?ws and refetches billing.state for that workspace", async () => {
    searchParams.current = new URLSearchParams("ws=second-studio");
    const builtFor: string[] = [];
    const stateMock = vi.fn().mockResolvedValue(BILLING_STATE_SECOND);

    render(
      <AppShell payload={payload()} createPort={fakePortFactory(builtFor, stateMock)}>
        <p data-testid="page-content">Billing page</p>
      </AppShell>,
    );

    // The switcher shows the ?ws workspace; its state arrives via the port.
    expect(screen.getByTestId("workspace-switcher")).toHaveTextContent("Second Studio");
    await waitFor(() => {
      expect(screen.getByTestId("topbar-credits")).toHaveTextContent("0.50 credits");
    });
    expect(builtFor).toContain("ws_second");

    // The rail still renders the same four destinations.
    expect(screen.getByTestId("rail-dashboard")).toBeInTheDocument();
  });

  it("falls back to the default workspace when ?ws matches nothing (pages 404)", () => {
    searchParams.current = new URLSearchParams("ws=ws_gone");
    render(
      <AppShell payload={payload()} createPort={fakePortFactory([])}>
        <p data-testid="page-content">Any page</p>
      </AppShell>,
    );
    expect(screen.getByTestId("workspace-switcher")).toHaveTextContent("First Films");
    expect(screen.getByTestId("topbar-credits")).toHaveTextContent("12.35 credits");
  });

  it("keeps the server credits when ?ws points at the active workspace (no refetch)", async () => {
    searchParams.current = new URLSearchParams("ws=first-films");
    const builtFor: string[] = [];
    render(
      <AppShell payload={payload()} createPort={fakePortFactory(builtFor)}>
        <p data-testid="page-content">Dashboard page</p>
      </AppShell>,
    );
    expect(screen.getByTestId("topbar-credits")).toHaveTextContent("12.35 credits");
    await waitFor(() => {
      // Only the interactive port (switcher/palette) was built — no refetch.
      expect(builtFor).toEqual(["ws_first"]);
    });
  });
});

describe("AppShell — ⌘K palette wiring (D-5)", () => {
  it("opens the palette on ⌘K/ctrl+K and closes on Esc", async () => {
    const user = userEvent.setup();
    render(
      <AppShell payload={payload()} createPort={fakePortFactory([])}>
        <p data-testid="page-content">Dashboard page</p>
      </AppShell>,
    );
    expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    expect(await screen.findByTestId("command-input")).toBeInTheDocument();

    await user.click(screen.getByTestId("command-input"));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();
    });
  });

  it("⌘N/ctrl+N runs the New project action — navigate to /w (W2-B4, the palette badge's binding)", async () => {
    render(
      <AppShell payload={payload()} createPort={fakePortFactory([])}>
        <p data-testid="page-content">Billing page</p>
      </AppShell>,
    );
    await act(async () => {
      fireEvent.keyDown(document, { key: "n", metaKey: true });
    });
    expect(routerPush).toHaveBeenCalledWith("/w");

    // Ctrl+N mirrors it for non-macOS layouts, and neither opens the palette.
    routerPush.mockClear();
    await act(async () => {
      fireEvent.keyDown(document, { key: "n", ctrlKey: true });
    });
    expect(routerPush).toHaveBeenCalledWith("/w");
    expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();

    // A bare N (no modifier) is just typing — never a navigation.
    routerPush.mockClear();
    await act(async () => {
      fireEvent.keyDown(document, { key: "n" });
    });
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("does not fetch projects until the palette opens", async () => {
    const listMock = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const factory = (workspaceId: string): ShellPort => ({
      members: { switchWorkspace: vi.fn() },
      billing: { state: vi.fn() },
      projects: { list: listMock },
    });
    render(
      <AppShell payload={payload()} createPort={factory}>
        <p data-testid="page-content">Dashboard page</p>
      </AppShell>,
    );
    expect(listMock).not.toHaveBeenCalled();
  });
});
