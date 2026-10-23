/**
 * HubRightRail tests (W2-05, §8.6) — members with access (members.list),
 * the live lease-status banner ("X is editing", leases.leaseState polled at
 * the injected cadence), and the asset-library count — against a scripted
 * fake HubPort. jsdom, no network; the poll test uses a tiny injected
 * interval with real timers.
 */

import type { LeaseStateResponse, Member } from "@studio/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HubPort } from "./hub-port";
import { HubRightRail } from "./hub-right-rail";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "usr_alex",
    name: "Alex Rivera",
    email: "alex@example.test",
    role: "editor",
    status: "active",
    lastActiveAt: null,
    isCurrentUser: false,
    ...overrides,
  };
}

const FREE: LeaseStateResponse = {
  holder: null,
  queue: [],
  youAre: "viewer",
  canAcquire: true,
};

const HELD_BY_SAM: LeaseStateResponse = {
  holder: {
    userId: "usr_sam",
    displayName: "Sam",
    acquiredAt: "2026-10-26T11:00:00.000Z",
    expiresAt: "2026-10-26T11:05:00.000Z",
  },
  queue: [{ userId: "usr_kim", displayName: "Kim", queuedAt: "2026-10-26T11:10:00.000Z" }],
  youAre: "viewer",
  canAcquire: false,
};

function makePort(overrides: Partial<HubPort> = {}): HubPort {
  return {
    listMembers: vi.fn(async () => ({
      items: [
        member(),
        member({ id: "usr_sam", name: "Sam Okafor", role: "admin" }),
        member({ id: "usr_me", name: "Me Myself", isCurrentUser: true }),
      ],
      nextCursor: null,
    })),
    listVersions: vi.fn(async () => ({ items: [], nextCursor: null })),
    listAssets: vi.fn(async () => ({
      items: [
        {
          id: "ast_0001",
          workspaceId: "ws_demo",
          projectId: "prj_demo",
          name: "logo.png",
          mime: "image/png",
          sizeBytes: 1024,
          sha256: "b".repeat(64),
          width: 512,
          height: 512,
          durationTicks: null,
          createdBy: "usr_alex",
          createdAt: "2026-10-26T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    })),
    getManifest: vi.fn(async () => {
      throw new Error("not part of the rail surface");
    }),
    leaseState: vi.fn(async () => FREE),
    requestLease: vi.fn(async () => {
      throw new Error("not part of the rail surface");
    }),
    cancelLeaseRequest: vi.fn(async () => {
      throw new Error("not part of the rail surface");
    }),
    ...overrides,
  };
}

function renderRail(
  overrides: {
    readonly port?: HubPort;
    readonly canEdit?: boolean;
    readonly viewerId?: string | null;
    readonly pollMs?: number;
  } = {},
): HubPort {
  const port = overrides.port ?? makePort();
  render(
    <HubRightRail
      workspaceId="ws_demo"
      projectId="prj_demo"
      viewerId={overrides.viewerId ?? "usr_me"}
      canEdit={overrides.canEdit ?? true}
      api={port}
      pollMs={overrides.pollMs}
    />,
  );
  return port;
}

// ---------------------------------------------------------------------------
// Lease status banner
// ---------------------------------------------------------------------------

describe("HubRightRail lease status", () => {
  it("shows the holder banner: 'Sam is editing' + the queue count", async () => {
    renderRail({ port: makePort({ leaseState: vi.fn(async () => HELD_BY_SAM) }) });

    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-lease-held")).toHaveTextContent("Sam is editing");
    });
    expect(screen.getByTestId("hub-rail-queue")).toHaveTextContent("1 member is queued");
    expect(screen.queryByTestId("hub-rail-lease-free")).toBeNull();
  });

  it("shows 'Free to edit' when no lease is active", async () => {
    renderRail();
    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-lease-free")).toHaveTextContent("Free to edit");
    });
    expect(screen.queryByTestId("hub-rail-lease-held")).toBeNull();
  });

  it("polls lease-state at the injected cadence (the ~30s recipe, shrunk)", async () => {
    const port = makePort();
    renderRail({ port, pollMs: 20 });

    await waitFor(() => {
      expect(port.leaseState).toHaveBeenCalledTimes(1);
    });
    // The interval keeps re-reading the banner; members/assets stay ONE read
    // each — only the lease polls.
    await waitFor(
      () => {
        expect(port.leaseState.mock.calls.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 2000 },
    );
    expect(port.listMembers).toHaveBeenCalledTimes(1);
    expect(port.listAssets).toHaveBeenCalledTimes(1);
  });

  it("keeps the last banner when a poll fails (silent degrade)", async () => {
    let calls = 0;
    const port = makePort({
      leaseState: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return HELD_BY_SAM;
        throw new Error("poll failed");
      }),
    });
    renderRail({ port, pollMs: 20 });

    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-lease-held")).toHaveTextContent("Sam is editing");
    });
    await waitFor(() => {
      expect(port.leaseState.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByTestId("hub-rail-lease-held")).toHaveTextContent("Sam is editing");
  });
});

// ---------------------------------------------------------------------------
// Members with access
// ---------------------------------------------------------------------------

describe("HubRightRail members", () => {
  it("lists the roster with role badges and the (you) marker", async () => {
    renderRail();

    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-member-usr_sam")).toHaveTextContent("Sam Okafor");
    });
    expect(screen.getByTestId("hub-rail-member-usr_sam")).toHaveTextContent("Admin");
    expect(screen.getByTestId("hub-rail-member-usr_alex")).toHaveTextContent("Editor");
    expect(screen.getByTestId("hub-rail-member-usr_me")).toHaveTextContent("(you)");
  });

  it("empty roster: the honest empty state", async () => {
    renderRail({
      port: makePort({ listMembers: vi.fn(async () => ({ items: [], nextCursor: null })) }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-members-empty")).toHaveTextContent(
        "No other members have access yet.",
      );
    });
  });

  it("caps the roster at 8 rows with '+N more'", async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      member({ id: `usr_${index}`, name: `Member ${index}` }),
    );
    renderRail({
      port: makePort({
        listMembers: vi.fn(async () => ({ items: many, nextCursor: null })),
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-member-usr_7")).toBeInTheDocument();
    });
    // Rows past the cap render as a count, never a wall of avatars.
    expect(screen.queryByTestId("hub-rail-member-usr_8")).toBeNull();
    expect(screen.queryByTestId("hub-rail-member-usr_9")).toBeNull();
    expect(screen.getByTestId("hub-rail-members-more")).toHaveTextContent("+2 more");
  });
});

// ---------------------------------------------------------------------------
// Asset count
// ---------------------------------------------------------------------------

describe("HubRightRail assets", () => {
  it("shows the workspace asset-library count", async () => {
    renderRail();
    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-assets-count")).toHaveTextContent("1 asset");
    });
  });

  it('says "50+" when the first page carries a cursor', async () => {
    renderRail({
      port: makePort({
        listAssets: vi.fn(async () => ({
          items: [
            {
              id: "ast_0001",
              workspaceId: "ws_demo",
              projectId: null,
              name: "logo.png",
              mime: "image/png",
              sizeBytes: 1024,
              sha256: "b".repeat(64),
              width: 512,
              height: 512,
              durationTicks: null,
              createdBy: "usr_alex",
              createdAt: "2026-10-26T12:00:00.000Z",
            },
          ],
          nextCursor: "ast-page-2",
        })),
      }),
    });
    await waitFor(() => {
      expect(screen.getByTestId("hub-rail-assets-count")).toHaveTextContent("50+");
    });
  });
});
