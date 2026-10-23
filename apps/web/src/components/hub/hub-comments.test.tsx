/**
 * HubComments tests (W2-05, §8.6) — the Comments tab wraps the M7-F
 * CommentsPanel in its DEGRADED mode (bridge null): the panel reads through
 * the injected CommentsClient, the composer explains it can't anchor a new
 * comment without the editor (creation disabled — review still works),
 * viewerId drives "You" labels, and the lease snapshot renders the D-23 note.
 * jsdom, no network.
 */

import type { Comment } from "@studio/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CommentsClient, LeaseSnapshot } from "@/components/comments/types";
import { HubComments } from "./hub-comments";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-10-26T12:00:00.000Z";

function row(id: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    projectId: "prj_demo",
    compId: "1",
    layerId: null,
    timeTicks: null,
    parentCommentId: null,
    body: `body ${id}`,
    authorId: "usr_someone",
    guestName: null,
    guestEmail: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeClient(overrides: Partial<CommentsClient> = {}): CommentsClient {
  return {
    comments: {
      listThreadedComments: vi.fn(async () => ({
        items: [row("cmt_1"), row("cmt_2", { authorId: "usr_me", body: "my note" })],
        nextCursor: null,
      })),
      create: vi.fn(async () => row("cmt_new")),
      replyComment: vi.fn(async () => row("cmt_reply")),
      resolveComment: vi.fn(async () => row("cmt_1", { resolvedAt: NOW })),
    },
    leases: {
      leaseState: vi.fn(async () => ({
        holder: {
          userId: "usr_sam",
          displayName: "Sam",
          acquiredAt: "2026-10-26T11:00:00.000Z",
          expiresAt: "2026-10-26T11:05:00.000Z",
        },
        queue: [],
        youAre: "viewer" as const,
        canAcquire: false,
      })),
    },
    ...overrides,
  };
}

function renderComments(overrides: { readonly client?: CommentsClient } = {}): CommentsClient {
  const client = overrides.client ?? makeClient();
  render(
    <HubComments
      workspaceId="ws_demo"
      projectId="prj_demo"
      projectName="Launch film"
      viewerId="usr_me"
      client={client}
    />,
  );
  return client;
}

// ---------------------------------------------------------------------------
// The degraded port
// ---------------------------------------------------------------------------

describe("HubComments (degraded CommentsPanel)", () => {
  it("mounts the panel in degraded mode and loads the first page through the client", async () => {
    const client = renderComments();

    expect(screen.getByTestId("hub-comments")).toHaveAttribute("data-degraded", "true");
    expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
    await waitFor(() => {
      expect(client.comments.listThreadedComments).toHaveBeenCalledWith("prj_demo", {
        limit: 20,
        resolved: false,
      });
    });
    expect(screen.getByTestId("comments-project")).toHaveTextContent("Launch film");
  });

  it("composer degrades honestly: no editor context → no anchor, creation disabled", async () => {
    renderComments();

    await waitFor(() => {
      expect(screen.getByTestId("comments-composer-hint")).toHaveTextContent(
        "Open a composition in the editor to anchor a new comment.",
      );
    });
    const composer = screen.getByLabelText("Write a comment");
    expect(composer).toBeDisabled();
  });

  it("viewerId drives the 'You' author label", async () => {
    renderComments();

    await waitFor(() => {
      expect(screen.getByTestId("comment-author-cmt_2")).toHaveTextContent("You");
    });
    expect(screen.getByTestId("comment-author-cmt_1")).toHaveTextContent("Member");
  });

  it("renders the D-23 lease note when another member holds the edit lease", async () => {
    const client = renderComments();

    await waitFor(() => {
      expect(client.leases?.leaseState).toHaveBeenCalledWith("prj_demo");
    });
    await waitFor(() => {
      expect(screen.getByTestId("comments-lease-note")).toHaveTextContent(
        "Sam is editing — you can still read and comment.",
      );
    });
  });

  it("no lease port → no note, reading still works", async () => {
    const client = makeClient();
    const bare: CommentsClient = { comments: client.comments };
    renderComments({ client: bare });

    await waitFor(() => {
      expect(screen.getAllByText("Member").length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("comments-lease-note")).toBeNull();
  });
});
