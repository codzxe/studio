/**
 * TopBar tests (W2-01, §8.4) — the workspace switcher (members.switchWorkspace
 * then SAME path + ?ws=<slug>), the credits area (numeric balance + meter +
 * top-up link → /w/billing; null-credits degrade), and sign-out
 * (authClient.signOut → push "/"). next/navigation and the better-auth client
 * are mocked; the api port is faked (the fakePort/asBillingPort house
 * pattern — no network).
 */

import { ApiError } from "@studio/api-client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceMembership } from "@/lib/workspace-membership";
import { TopBar, type ShellPort } from "./top-bar";

const { routerPush, pathname, searchParams } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  pathname: { current: "/w/billing" },
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams.current,
}));

const signOutMock = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signOut: (...args: unknown[]) => signOutMock(...args),
  },
  SESSION_COOKIE_NAME: "better-auth.session_token",
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIRST: WorkspaceMembership = {
  workspaceId: "ws_first",
  role: "owner",
  workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
};

const SECOND: WorkspaceMembership = {
  workspaceId: "ws_second",
  role: "viewer",
  workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
};

const MEMBERSHIPS: readonly WorkspaceMembership[] = [FIRST, SECOND];

const CREDITS = { balance: 12_345_678, reserved: 250_000 };
const ALLOWANCE = 20_000_000;

function fakePort(
  overrides: { readonly switchWorkspace?: ReturnType<typeof vi.fn> } = {},
): ShellPort {
  return {
    members: {
      switchWorkspace: overrides.switchWorkspace ?? vi.fn().mockResolvedValue(undefined),
    },
    billing: { state: vi.fn() },
    projects: { list: vi.fn() },
  };
}

function view(
  overrides: {
    readonly memberships?: readonly WorkspaceMembership[];
    readonly activeMembership?: WorkspaceMembership;
    readonly credits?: { readonly balance: number; readonly reserved: number } | null;
    readonly monthlyAllowanceMicrocredits?: number | null;
    readonly port?: ShellPort;
  } = {},
) {
  const memberships = overrides.memberships ?? MEMBERSHIPS;
  const active = overrides.activeMembership ?? memberships[0] ?? FIRST;
  return render(
    <TopBar
      email="alex@example.com"
      userName="Alex Jordan"
      memberships={memberships}
      activeMembership={active}
      credits={overrides.credits === undefined ? CREDITS : overrides.credits}
      monthlyAllowanceMicrocredits={
        overrides.monthlyAllowanceMicrocredits === undefined
          ? ALLOWANCE
          : overrides.monthlyAllowanceMicrocredits
      }
      onOpenPalette={vi.fn()}
      port={overrides.port ?? fakePort()}
    />,
  );
}

beforeEach(() => {
  routerPush.mockClear();
  signOutMock.mockReset().mockResolvedValue({ data: null, error: null });
  pathname.current = "/w/billing";
  searchParams.current = new URLSearchParams();
});

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

describe("TopBar — chrome", () => {
  it("shows the active workspace, the numeric credits link and the avatar initials", async () => {
    view();
    expect(screen.getByTestId("workspace-switcher")).toHaveTextContent("First Films");
    const credits = screen.getByTestId("topbar-credits");
    // D-12: RAW µc → 2-decimal credits at the boundary.
    expect(credits).toHaveTextContent("12.35 credits");
    expect(screen.getByRole("link", { name: /Credits balance 12\.35/ })).toHaveAttribute(
      "href",
      "/w/billing",
    );
    expect(screen.getByTestId("account-menu")).toBeInTheDocument();
    // Radix Avatar fallback mounts on a timer — initials appear async.
    expect(await screen.findByText("AJ")).toBeInTheDocument();
  });

  it("degrades to a quiet Billing link when credits are unavailable", () => {
    view({ credits: null, monthlyAllowanceMicrocredits: null });
    expect(screen.queryByTestId("topbar-credits")).not.toBeInTheDocument();
    const fallback = screen.getByTestId("topbar-credits-unavailable");
    expect(fallback).toHaveAttribute("href", "/w/billing");
    expect(fallback).toHaveTextContent("Billing");
  });

  it("renders the search trigger that opens the palette (⌘K hint stays)", async () => {
    const user = userEvent.setup();
    const onOpenPalette = vi.fn();
    render(
      <TopBar
        email="alex@example.com"
        userName="Alex Jordan"
        memberships={MEMBERSHIPS}
        activeMembership={FIRST}
        credits={CREDITS}
        monthlyAllowanceMicrocredits={ALLOWANCE}
        onOpenPalette={onOpenPalette}
        port={fakePort()}
      />,
    );
    const search = screen.getByTestId("topbar-search");
    expect(search).toHaveAttribute("readonly");
    expect(onOpenPalette).not.toHaveBeenCalled();
    await user.click(search);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Workspace switcher
// ---------------------------------------------------------------------------

describe("TopBar — workspace switcher", () => {
  it("lists every membership with its role and switches via ?ws=<slug>", async () => {
    const user = userEvent.setup();
    const switchWorkspace = vi.fn().mockResolvedValue({
      workspaceId: "ws_second",
      name: "Second Studio",
      slug: "second-studio",
    });
    view({ port: fakePort({ switchWorkspace }) });

    await user.click(screen.getByTestId("workspace-switcher"));
    expect(screen.getByTestId("switcher-first-films")).toHaveTextContent("First Films");
    expect(screen.getByTestId("switcher-second-studio")).toHaveTextContent("Second Studio");
    expect(screen.getByText("viewer")).toBeInTheDocument();

    await user.click(screen.getByTestId("switcher-second-studio"));
    expect(switchWorkspace).toHaveBeenCalledWith("ws_second");
    expect(routerPush).toHaveBeenCalledWith("/w/billing?ws=second-studio");
  });

  it("preserves other search params when switching", async () => {
    const user = userEvent.setup();
    searchParams.current = new URLSearchParams("tab=ledger");
    const switchWorkspace = vi.fn().mockResolvedValue({
      workspaceId: "ws_second",
      name: "Second Studio",
      slug: "second-studio",
    });
    view({ port: fakePort({ switchWorkspace }) });

    await user.click(screen.getByTestId("workspace-switcher"));
    await user.click(screen.getByTestId("switcher-second-studio"));
    expect(routerPush).toHaveBeenCalledWith("/w/billing?tab=ledger&ws=second-studio");
  });

  it("does NOT navigate when the switch call fails (typed error, no push)", async () => {
    const user = userEvent.setup();
    const switchWorkspace = vi.fn().mockRejectedValue(
      new ApiError({
        code: "WORKSPACE_NOT_FOUND",
        message: "That workspace is gone.",
        status: 404,
        requestId: "req_deadbeef",
      }),
    );
    view({ port: fakePort({ switchWorkspace }) });

    await user.click(screen.getByTestId("workspace-switcher"));
    await user.click(screen.getByTestId("switcher-second-studio"));
    expect(switchWorkspace).toHaveBeenCalledWith("ws_second");
    expect(routerPush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

describe("TopBar — account menu / sign out", () => {
  it("shows the caller's email and signs out via the auth client, then pushes /", async () => {
    const user = userEvent.setup();
    view();

    await user.click(screen.getByTestId("account-menu"));
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
    await user.click(screen.getByTestId("sign-out"));

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/");
  });

  it("stays put when sign-out fails (typed failure, no navigation)", async () => {
    const user = userEvent.setup();
    signOutMock.mockRejectedValue(new Error("network down"));
    view();

    await user.click(screen.getByTestId("account-menu"));
    await user.click(screen.getByTestId("sign-out"));
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
  });
});
