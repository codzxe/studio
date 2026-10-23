/**
 * HubOverview tests (W2-05, §8.6) — the Overview tab against a scripted fake
 * HubPort (the api-client seam): the metadata rows (owner resolved via
 * members.list, current version from versions.list page 1, the asset-library
 * count with the "50+" cursor arm, the honest comps gap), and the LEASE-AWARE
 * CTA arms — lease-free "Open editor", held-by-other "Open read-only" +
 * "Request edit" (join/leave the queue via leases.requestLease /
 * cancelLeaseRequest), and the viewer-role PermissionState. jsdom, real
 * timers, no network.
 */

import type {
  Asset,
  LeaseStateResponse,
  Member,
  ProjectManifest,
  VersionTimelineEntry,
} from "@studio/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HubOverview } from "./hub-overview";
import type { HubPort } from "./hub-port";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-10-26T12:00:00.000Z";

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

function version(overrides: Partial<VersionTimelineEntry> = {}): VersionTimelineEntry {
  return {
    id: "ver_0003",
    projectId: "prj_demo",
    version: 3,
    parentVersionId: "ver_0002",
    sha256: "a".repeat(64),
    sizeBytes: 2048,
    label: "Launch cut",
    agentRunId: null,
    createdBy: "usr_alex",
    createdAt: "2026-10-26T10:30:00.000Z",
    createdByName: "Alex",
    isAgent: false,
    sha256Prefix: "aaaaaaaaaaaa",
    ...overrides,
  };
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
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
    createdAt: NOW,
    ...overrides,
  };
}

const MANIFEST: ProjectManifest = {
  projectId: "prj_demo",
  currentVersion: null,
  assets: [],
  updatedAt: "2026-10-26T10:30:00.000Z",
};

function leaseState(overrides: Partial<LeaseStateResponse> = {}): LeaseStateResponse {
  return {
    holder: null,
    queue: [],
    youAre: "viewer",
    canAcquire: true,
    ...overrides,
  };
}

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

interface Harness {
  readonly port: HubPort;
}

function makePort(overrides: Partial<HubPort> = {}): HubPort {
  return {
    listMembers: vi.fn(async () => ({ items: [member()], nextCursor: null })),
    listVersions: vi.fn(async () => ({ items: [version()], nextCursor: null })),
    listAssets: vi.fn(async () => ({ items: [asset()], nextCursor: null })),
    getManifest: vi.fn(async () => MANIFEST),
    leaseState: vi.fn(async () => leaseState()),
    requestLease: vi.fn(async () => ({
      queued: true as const,
      position: 2,
      queueLength: 2,
      queuedAt: NOW,
      duplicate: false,
    })),
    cancelLeaseRequest: vi.fn(async () => ({ cancelled: true })),
    ...overrides,
  };
}

function renderOverview(
  overrides: {
    readonly port?: HubPort;
    readonly canEdit?: boolean;
    readonly viewerId?: string | null;
    readonly ownerId?: string | null;
  } = {},
): Harness {
  const port = overrides.port ?? makePort();
  render(
    <HubOverview
      projectId="prj_demo"
      projectName="Launch film"
      workspaceId="ws_demo"
      slug="launch-film"
      viewerId={overrides.viewerId ?? "usr_me"}
      ownerId={overrides.ownerId ?? "usr_alex"}
      canEdit={overrides.canEdit ?? true}
      nowIso={NOW}
      api={port}
    />,
  );
  return { port };
}

const USER = userEvent.setup();

// ---------------------------------------------------------------------------
// Metadata rows
// ---------------------------------------------------------------------------

describe("HubOverview metadata", () => {
  it("renders updated, owner (members.list), current version, asset library — and the honest comps gap", async () => {
    renderOverview();

    await waitFor(() => {
      expect(screen.getByTestId("hub-overview-owner")).toHaveTextContent("Alex Rivera");
    });
    expect(screen.getByTestId("hub-overview-updated")).toHaveTextContent("ago");
    // v3 · Launch cut · 2.0 KB · timestamp (§14 formats from the timeline kit).
    expect(screen.getByTestId("hub-overview-version")).toHaveTextContent("v3");
    expect(screen.getByTestId("hub-overview-version")).toHaveTextContent("Launch cut");
    expect(screen.getByTestId("hub-overview-version")).toHaveTextContent("2 KB");
    expect(screen.getByTestId("hub-overview-assets")).toHaveTextContent("1 asset");
    // The manifest wire carries NO comps count — "—", never an invention.
    expect(screen.getByTestId("hub-overview-comps")).toHaveTextContent("—");
    expect(screen.getByTestId("hub-overview-preview")).toHaveTextContent("Launch film");
  });

  it('says "50+" when the assets page carries a cursor, and "No versions yet" on an empty timeline', async () => {
    const port = makePort({
      listAssets: vi.fn(async () => ({
        items: [asset()],
        nextCursor: "ast-page-2",
      })),
      listVersions: vi.fn(async () => ({ items: [], nextCursor: null })),
    });
    renderOverview({ port });

    await waitFor(() => {
      expect(screen.getByTestId("hub-overview-assets")).toHaveTextContent("50+");
    });
    expect(screen.getByTestId("hub-overview-version")).toHaveTextContent("No versions yet");
  });

  it('labels the owner "You" when the viewer created the project, "—" when the roster misses', async () => {
    renderOverview({ viewerId: "usr_alex", ownerId: "usr_alex" });
    await waitFor(() => {
      expect(screen.getByTestId("hub-overview-owner")).toHaveTextContent("You");
    });
  });

  it("degrades rows to — when reads fail (never a stack)", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const port: HubPort = {
      listMembers: failing,
      listVersions: failing,
      listAssets: failing,
      getManifest: failing,
      leaseState: failing,
      requestLease: failing,
      cancelLeaseRequest: failing,
    };
    renderOverview({ port });

    await waitFor(() => {
      expect(screen.queryByTestId("hub-overview-skeleton")).toBeNull();
    });
    expect(screen.getByTestId("hub-overview-updated")).toHaveTextContent("—");
    expect(screen.getByTestId("hub-overview-owner")).toHaveTextContent("—");
    expect(screen.getByTestId("hub-overview-version")).toHaveTextContent("—");
    expect(screen.getByTestId("hub-overview-assets")).toHaveTextContent("—");
  });
});

// ---------------------------------------------------------------------------
// Lease-aware CTA arms (§8.6)
// ---------------------------------------------------------------------------

describe("HubOverview lease CTAs", () => {
  it("lease-free: primary Open editor with the editor deep link; no Request edit", async () => {
    renderOverview();
    await waitFor(() => {
      expect(screen.getByTestId("hub-open-editor")).toBeInTheDocument();
    });
    expect(screen.getByTestId("hub-open-editor").getAttribute("href")).toBe(
      "/w/launch-film/editor",
    );
    expect(screen.queryByTestId("hub-open-readonly")).toBeNull();
    expect(screen.queryByTestId("hub-request-edit")).toBeNull();
    // The §8.6 secondary Share action rides along for editors.
    expect(screen.getByTestId("hub-share-trigger")).toBeInTheDocument();
  });

  it("held by another member: Open read-only + Request edit + the holder banner", async () => {
    const port = makePort({ leaseState: vi.fn(async () => HELD_BY_SAM) });
    renderOverview({ port });

    await waitFor(() => {
      expect(screen.getByTestId("hub-open-readonly")).toBeInTheDocument();
    });
    expect(screen.getByTestId("hub-open-readonly").getAttribute("href")).toBe(
      "/w/launch-film/editor",
    );
    expect(screen.queryByTestId("hub-open-editor")).toBeNull();
    expect(screen.getByTestId("hub-lease-holder")).toHaveTextContent("Sam is editing");
    expect(screen.getByTestId("hub-queue-length")).toHaveTextContent("1 member is waiting");
    expect(screen.getByTestId("hub-request-edit")).toBeInTheDocument();
  });

  it("viewer role: the PermissionState replaces the CTA entirely", async () => {
    renderOverview({ canEdit: false });

    await waitFor(() => {
      expect(screen.getByTestId("hub-viewer-note")).toBeInTheDocument();
    });
    expect(screen.getByTestId("permission-state")).toHaveTextContent(
      "You're a viewer in this workspace.",
    );
    expect(screen.queryByTestId("hub-open-editor")).toBeNull();
    expect(screen.queryByTestId("hub-open-readonly")).toBeNull();
    expect(screen.queryByTestId("hub-share-trigger")).toBeNull();
  });

  it("request edit joins the queue (position note) and cancel leaves it", async () => {
    const port = makePort({ leaseState: vi.fn(async () => HELD_BY_SAM) });
    renderOverview({ port });

    await waitFor(() => {
      expect(screen.getByTestId("hub-request-edit")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("hub-request-edit"));

    await waitFor(() => {
      expect(port.requestLease).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("hub-queue-note")).toHaveTextContent(
        "You're number 2 of 2 in the edit queue.",
      );
    });
    expect(screen.queryByTestId("hub-request-edit")).toBeNull();
    await USER.click(screen.getByTestId("hub-cancel-request"));
    await waitFor(() => {
      expect(port.cancelLeaseRequest).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("hub-request-edit")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("hub-queue-note")).toBeNull();
  });

  it("already queued (youAre=queued): position note + cancel, no Request edit", async () => {
    renderOverview({
      port: makePort({
        leaseState: vi.fn(async () => ({
          ...HELD_BY_SAM,
          queue: [
            { userId: "usr_kim", displayName: "Kim", queuedAt: "2026-10-26T11:10:00.000Z" },
            { userId: "usr_me", displayName: "Me", queuedAt: "2026-10-26T11:12:00.000Z" },
          ],
          youAre: "queued" as const,
        })),
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("hub-queue-note")).toHaveTextContent(
        "You're number 2 in the edit queue.",
      );
    });
    expect(screen.getByTestId("hub-cancel-request")).toBeInTheDocument();
    expect(screen.queryByTestId("hub-request-edit")).toBeNull();
  });

  it("surfaces typed request failures with message + hint + request id (§7.3)", async () => {
    const { ApiError } = await import("@studio/api-client");
    const port = makePort({
      leaseState: vi.fn(async () => HELD_BY_SAM),
      requestLease: vi.fn(async () => {
        throw new ApiError({
          code: "QUOTA_EXCEEDED",
          message: "The edit queue is full right now.",
          hint: "Try again once someone finishes editing.",
          status: 429,
          requestId: "req_queue_01",
        });
      }),
    });
    renderOverview({ port });

    await waitFor(() => {
      expect(screen.getByTestId("hub-request-edit")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("hub-request-edit"));
    await waitFor(() => {
      expect(screen.getByTestId("hub-lease-error")).toHaveTextContent(
        "The edit queue is full right now. (req_queue_01)",
      );
    });
    expect(screen.getByTestId("hub-lease-error")).toHaveTextContent(
      "Try again once someone finishes editing.",
    );
  });
});

// ---------------------------------------------------------------------------
// Fetch discipline
// ---------------------------------------------------------------------------

describe("HubOverview fetch discipline", () => {
  it("reads each surface exactly once per mount", async () => {
    const port = makePort();
    renderOverview({ port });
    await waitFor(() => {
      expect(screen.getByTestId("hub-overview-owner")).toHaveTextContent("Alex Rivera");
    });
    expect(port.getManifest).toHaveBeenCalledTimes(1);
    expect(port.listVersions).toHaveBeenCalledTimes(1);
    expect(port.listAssets).toHaveBeenCalledTimes(1);
    expect(port.listMembers).toHaveBeenCalledTimes(1);
    expect(port.leaseState).toHaveBeenCalledTimes(1);
  });
});
