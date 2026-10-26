/**
 * CommentsRegion tests (M7-F) — the MOUNT: toggle → panel, the self-sufficient
 * bootstraps (default workspace-scoped ApiClient via the mocked
 * createApiClient seam; default bridge discovery via the mocked
 * attachEditorBridge seam), viewer + lease snapshot fetches on open, and the
 * ownership rule that an INJECTED bridge is never attached-over or disposed.
 *
 * jsdom, real timers, no network. `@studio/api-client` and
 * `@studio/editor-bridge` are module-mocked ONLY at the two factory seams the
 * region calls; everything else is the real code path.
 */

import type { Comment } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentsRegion } from "./comments-region";
import type { CommentsClient, LeaseSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Module mocks: the two DEFAULT seams only (injected props bypass them).
// ---------------------------------------------------------------------------

const attachMock = vi.hoisted(() => vi.fn());
vi.mock("@studio/editor-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@studio/editor-bridge")>();
  return { ...actual, attachEditorBridge: attachMock };
});

const createApiClientMock = vi.hoisted(() => vi.fn());
vi.mock("@studio/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@studio/api-client")>();
  return { ...actual, createApiClient: createApiClientMock };
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const VIEWER_ID = "usr_me";

function row(id: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    projectId: "prj_demo",
    compId: "1",
    layerId: null,
    timeTicks: null,
    parentCommentId: null,
    body: `body ${id}`,
    authorId: VIEWER_ID,
    guestName: null,
    guestEmail: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: "2026-10-26T12:00:00.000Z",
    ...overrides,
  };
}

interface FakeRegionClient extends CommentsClient {
  readonly listCalls: () => number;
  readonly meCalls: () => number;
  readonly leaseCalls: () => number;
}

function createFakeRegionClient(
  options: {
    readonly items?: readonly Comment[];
    readonly lease?: LeaseSnapshot | null;
    readonly leaseStateFails?: boolean;
  } = {},
): FakeRegionClient {
  const lease: LeaseSnapshot | null = options.lease ?? null;
  let listCalls = 0;
  let meCalls = 0;
  let leaseCalls = 0;
  return {
    comments: {
      listThreadedComments: async () => {
        listCalls += 1;
        return { items: [...(options.items ?? [])], nextCursor: null };
      },
      create: async (_projectId, body) => row("cmt_new_1", { ...body }),
      replyComment: async (commentId, body) =>
        row("cmt_new_1", { parentCommentId: commentId, ...body }),
      resolveComment: async (commentId) =>
        row(commentId, {
          resolvedAt: "2026-10-26T12:50:00.000Z",
          resolvedBy: VIEWER_ID,
        }),
    },
    me: {
      get: async () => {
        meCalls += 1;
        return {
          user: { id: VIEWER_ID, name: "Me", email: "me@example.com", role: "user" },
          memberships: [],
          plan: { plan: "starter", creditsBalance: 10, includedCredits: 10, renewsAt: null },
        };
      },
    },
    leases: {
      leaseState: async () => {
        leaseCalls += 1;
        if (options.leaseStateFails === true) {
          throw new Error("lease-state unreachable");
        }
        return {
          holder:
            lease === null || lease.holderName === null
              ? null
              : {
                  userId: "usr_holder",
                  displayName: lease.holderName,
                  acquiredAt: "2026-10-26T11:00:00.000Z",
                  expiresAt: "2026-10-26T11:05:00.000Z",
                },
          queue: [],
          youAre: lease === null ? "viewer" : lease.youAre,
          canAcquire: lease === null,
        };
      },
    },
    listCalls: () => listCalls,
    meCalls: () => meCalls,
    leaseCalls: () => leaseCalls,
  };
}

function createFakeBridge(
  options: {
    readonly comps?: ReadonlyArray<{ name: string }>;
    readonly playhead?: number;
  } = {},
): EditorBridge {
  const fake = createFakeEditor({
    comps: options.comps ?? [{ name: "Main" }],
    playhead: options.playhead,
  });
  return attachFakeBridge(fake);
}

interface RegionProps {
  readonly client: FakeRegionClient;
  readonly bridge?: EditorBridge | null;
  readonly projectName?: string;
}

function renderRegion(props: RegionProps): void {
  render(
    <CommentsRegion
      workspaceId="ws_demo"
      projectId="prj_demo"
      projectName={props.projectName ?? "Launch film"}
      client={props.client}
      bridge={props.bridge}
    />,
  );
}

async function openPanelThroughToggle(): Promise<void> {
  await userEvent.click(screen.getByTestId("comments-toggle"));
  await screen.findByTestId("comments-panel");
}

afterEach(() => {
  attachMock.mockReset();
  createApiClientMock.mockReset();
});

// ---------------------------------------------------------------------------
// Toggle + panel open/close
// ---------------------------------------------------------------------------

describe("CommentsRegion — toggle + panel", () => {
  it("renders only the toggle while closed; a click opens the panel; close hides it again", async () => {
    const client = createFakeRegionClient({ items: [row("c1", { body: "First note" })] });
    renderRegion({
      client,
      bridge: createFakeBridge({ playhead: 4 }),
    });

    expect(screen.getByTestId("comments-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-panel")).not.toBeInTheDocument();

    await openPanelThroughToggle();
    expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("comment-body-c1")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("comments-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("comments-panel")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("comments-toggle")).toBeInTheDocument();
    expect(client.listCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Viewer + lease snapshot on open (the D-23 pin at the region level)
// ---------------------------------------------------------------------------

describe("CommentsRegion — viewer + lease snapshot", () => {
  it("fetches /me on open and labels the viewer's own rows 'You'", async () => {
    const client = createFakeRegionClient({ items: [row("c1", { authorId: VIEWER_ID })] });
    renderRegion({ client, bridge: createFakeBridge() });
    await openPanelThroughToggle();
    expect(client.meCalls()).toBe(1);
    expect(screen.getByTestId("comment-author-c1")).toHaveTextContent("You");
  });

  it("fetches lease-state and shows the lease-held note — while commenting stays enabled", async () => {
    const client = createFakeRegionClient({
      items: [],
      lease: { holderName: "Dana Flow", youAre: "viewer" },
    });
    renderRegion({ client, bridge: createFakeBridge({ playhead: 1 }) });
    await openPanelThroughToggle();

    expect(client.leaseCalls()).toBe(1);
    const note = screen.getByTestId("comments-lease-note");
    expect(note).toHaveTextContent("Dana Flow is editing");
    // D-23 pin: the composer stays enabled under another member's lease.
    expect(screen.getByLabelText("Write a comment")).toBeEnabled();
  });

  it("shows no lease note when the viewer holds the lease", async () => {
    const client = createFakeRegionClient({
      items: [],
      lease: { holderName: "Me", youAre: "holder" },
    });
    renderRegion({ client, bridge: createFakeBridge() });
    await openPanelThroughToggle();
    expect(screen.queryByTestId("comments-lease-note")).not.toBeInTheDocument();
  });

  it("degrades to no lease note when the lease-state read fails", async () => {
    const client = createFakeRegionClient({ items: [], leaseStateFails: true });
    renderRegion({ client, bridge: createFakeBridge() });
    await openPanelThroughToggle();
    await waitFor(() => {
      expect(screen.queryByTestId("comments-lease-note")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Default seams: bridge discovery + the workspace-scoped ApiClient
// ---------------------------------------------------------------------------

describe("CommentsRegion — default seams", () => {
  it("discovers the editor iframe and attaches a dedicated bridge (no bridge prop)", async () => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-testid", "editor-iframe");
    document.body.append(iframe);
    const discoveredBridge = createFakeBridge({ comps: [{ name: "Main" }], playhead: 2 });
    attachMock.mockImplementation(async (element: HTMLIFrameElement) => {
      expect(element).toBe(iframe);
      return discoveredBridge;
    });

    const client = createFakeRegionClient({ items: [] });
    renderRegion({ client });
    await openPanelThroughToggle();

    // The discovered bridge reached the panel: the composer shows live chips.
    expect(await screen.findByTestId("comments-composer-anchor-comp")).toHaveTextContent("Main");
    expect(screen.getByTestId("comments-composer-anchor-time")).toHaveTextContent("0:02");
    iframe.remove();
  });

  it("builds the default ApiClient with the workspace header and uses it", async () => {
    const client = createFakeRegionClient({ items: [row("c1")] });
    createApiClientMock.mockReturnValue(client);
    render(<CommentsRegion workspaceId="ws_demo" projectId="prj_demo" />);
    expect(createApiClientMock).toHaveBeenCalledWith({
      baseUrl: "/v1",
      headers: { "x-workspace-id": "ws_demo" },
    });
    await openPanelThroughToggle();
    expect(client.listCalls()).toBe(1);
    expect(screen.getByTestId("comment-body-c1")).toBeInTheDocument();
  });

  it("never attaches over an injected bridge and never disposes it", async () => {
    const bridge = createFakeBridge({ playhead: 5 });
    const disposeSpy = vi.spyOn(bridge, "dispose");
    const client = createFakeRegionClient({ items: [] });
    const { unmount } = render(
      <CommentsRegion workspaceId="ws_demo" projectId="prj_demo" client={client} bridge={bridge} />,
    );
    await openPanelThroughToggle();
    expect(attachMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId("comments-composer-anchor-comp")).toBeInTheDocument();
    unmount();
    expect(disposeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer hygiene for the Playwright wave
// ---------------------------------------------------------------------------

describe("CommentsRegion — layer chrome", () => {
  it("renders the toggle inside a non-blocking layer with the pinned testids", async () => {
    const client = createFakeRegionClient({});
    renderRegion({ client, bridge: createFakeBridge() });
    const layer = screen.getByTestId("comments-layer");
    expect(layer).toBeInTheDocument();
    expect(screen.getByTestId("comments-toggle")).toHaveAccessibleName("Comments");
    await openPanelThroughToggle();
    expect(
      within(screen.getByTestId("comments-panel")).getByTestId("comments-title"),
    ).toHaveTextContent("Comments");
  });
});
