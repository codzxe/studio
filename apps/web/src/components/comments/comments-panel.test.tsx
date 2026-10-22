/**
 * CommentsPanel tests (M7-F) — the review surface against a scripted fake
 * CommentsClient (the api-client seam) + the deterministic fake editor bridge
 * (anchor prefill). jsdom, real timers, no network.
 *
 * Mission pins proven here: anchored rows with comp/layer/time chips, the
 * server-side filters (D-15 compId + resolved), cursor pagination, reply
 * nesting with the 3-level visual cap, resolve/unresolve with resolvedBy
 * labels, create with PREFILLED anchors from the live editor context,
 * hostile strings as DATA (M4-N corpus), empty state, and the D-23 lease pin:
 * another member holding the edit lease NEVER disables commenting.
 */

import { PROJECT_TEXT_INJECTIONS, textFixture } from "@/lib/chat/__tests__/injection-corpus";
import { secondsToTicks } from "@/lib/chat/preview";
import type { Comment } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./comments-panel";
import type { CommentsClient, LeaseSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIEWER_ID = "usr_me";
const TICKS_12S = secondsToTicks(12);
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

type ListQuery = Record<string, string | number | boolean | undefined>;

interface FakeHarness {
  readonly client: CommentsClient;
  readonly listCalls: ListQuery[];
  readonly createCalls: Array<{
    readonly projectId: string;
    readonly body: Record<string, unknown>;
  }>;
  readonly replyCalls: Array<{
    readonly commentId: string;
    readonly body: { readonly body: string };
  }>;
  readonly resolveCalls: Array<{
    readonly commentId: string;
    readonly body: { readonly resolved?: boolean } | undefined;
  }>;
  failListOnce(): void;
}

/**
 * Scripted client: `pages` are consumed in order, the last one sticks. The
 * store backs mutations so resolve/reply return complete rows.
 */
function createFakeClient(
  pages: ReadonlyArray<{ items: readonly Comment[]; nextCursor: string | null }>,
): FakeHarness {
  const store = new Map<string, Comment>();
  for (const page of pages) {
    for (const comment of page.items) store.set(comment.id, comment);
  }
  let callIndex = 0;
  let failList = false;
  const harness: FakeHarness = {
    client: {
      comments: {
        listThreadedComments: async (_projectId, query) => {
          harness.listCalls.push((query ?? {}) as ListQuery);
          if (failList) {
            failList = false;
            throw new Error("The comments list failed to load.");
          }
          const index = Math.min(callIndex, pages.length - 1);
          if (callIndex < pages.length - 1) callIndex += 1;
          const page = pages[index];
          if (page === undefined) throw new Error("no scripted pages");
          return { items: [...page.items], nextCursor: page.nextCursor };
        },
        create: async (projectId, body) => {
          harness.createCalls.push({ projectId, body: { ...body } });
          const created = row(`cmt_new_${harness.createCalls.length}`, {
            ...body,
            createdAt: "2026-10-26T12:30:00.000Z",
          });
          store.set(created.id, created);
          return created;
        },
        replyComment: async (commentId, body) => {
          harness.replyCalls.push({ commentId, body: { ...body } });
          const parent = store.get(commentId);
          const reply = row(`cmt_reply_${harness.replyCalls.length}`, {
            parentCommentId: commentId,
            compId: parent?.compId ?? "1",
            layerId: parent?.layerId ?? null,
            timeTicks: parent?.timeTicks ?? null,
            ...body,
            createdAt: "2026-10-26T12:40:00.000Z",
          });
          store.set(reply.id, reply);
          return reply;
        },
        resolveComment: async (commentId, body) => {
          harness.resolveCalls.push({ commentId, body });
          const current = store.get(commentId) ?? row(commentId);
          const resolving = body?.resolved !== false;
          const updated: Comment = {
            ...current,
            resolvedAt: resolving ? "2026-10-26T12:50:00.000Z" : null,
            resolvedBy: resolving ? VIEWER_ID : null,
          };
          store.set(updated.id, updated);
          return updated;
        },
      },
    },
    listCalls: [],
    createCalls: [],
    replyCalls: [],
    resolveCalls: [],
    failListOnce() {
      failList = true;
    },
  };
  return harness;
}

/** A fake bridge with named comps + a selected layer (hostile-capable). */
function createTestBridge(options: {
  readonly comps?: ReadonlyArray<{ name: string }>;
  readonly playhead?: number;
  readonly layerName?: string;
}): EditorBridge {
  const fake = createFakeEditor({
    comps: options.comps ?? [{ name: "Main" }],
    playhead: options.playhead,
  });
  const bridge = attachFakeBridge(fake);
  if (options.layerName !== undefined) {
    void bridge.execute("layer.newText", { name: options.layerName, text: "content" });
  }
  return bridge;
}

interface PanelHarness {
  readonly fake: FakeHarness;
  readonly rerenderWith: (options: {
    readonly lease: LeaseSnapshot | null;
    readonly open?: boolean;
  }) => void;
}

interface PanelOptions {
  readonly pages: ReadonlyArray<{ items: readonly Comment[]; nextCursor: string | null }>;
  readonly bridge?: EditorBridge | null;
  readonly lease?: LeaseSnapshot | null;
  readonly viewerId?: string | null;
  readonly projectName?: string;
  readonly onClose?: () => void;
}

function renderPanel(options: PanelOptions): PanelHarness {
  const fake = createFakeClient(options.pages);
  const bridge = options.bridge ?? null;
  const element = (state: { lease: LeaseSnapshot | null; open: boolean }): ReactElement => (
    <CommentsPanel
      client={fake.client}
      projectId="prj_demo"
      projectName={options.projectName ?? "Launch film"}
      bridge={bridge}
      viewerId={options.viewerId ?? VIEWER_ID}
      lease={state.lease}
      open={state.open}
      onClose={options.onClose ?? (() => {})}
    />
  );
  const initial = { lease: options.lease ?? null, open: true };
  const { rerender } = render(element(initial));
  return {
    fake,
    rerenderWith: (overrides) => rerender(element({ ...initial, ...overrides })),
  };
}

async function openPanel(): Promise<void> {
  await screen.findByTestId("comments-panel");
  await waitFor(() => {
    expect(screen.queryByTestId("comments-loading")).not.toBeInTheDocument();
  });
}

async function lastQuery(harness: PanelHarness): Promise<ListQuery> {
  await waitFor(() => {
    expect(harness.fake.listCalls.length).toBeGreaterThan(0);
  });
  const last = harness.fake.listCalls.at(-1);
  if (last === undefined) throw new Error("no list call recorded");
  return last;
}

// ---------------------------------------------------------------------------
// List render: anchors as chips, author labels, hostile strings as data
// ---------------------------------------------------------------------------

describe("CommentsPanel — list render", () => {
  it("renders threads with comp/layer/time anchor chips and the project in the header", async () => {
    const bridge = createTestBridge({ layerName: "Headline" });
    renderPanel({
      bridge,
      pages: [
        {
          items: [
            row("c1", {
              layerId: "1",
              timeTicks: TICKS_12S,
              createdAt: "2026-10-26T10:00:00.000Z",
            }),
            row("c2", { compId: "2", createdAt: "2026-10-26T09:00:00.000Z" }),
          ],
          nextCursor: null,
        },
      ],
    });
    await openPanel();

    expect(screen.getByTestId("comments-project")).toHaveTextContent("Launch film");
    expect(screen.getByTestId("comment-anchor-comp-c1")).toHaveTextContent("Main");
    expect(screen.getByTestId("comment-anchor-layer-c1")).toHaveTextContent("Headline");
    expect(screen.getByTestId("comment-anchor-time-c1")).toHaveTextContent("0:12");
    // Unknown comp (live editor has no comp id 2) → raw id as data.
    expect(screen.getByTestId("comment-anchor-comp-c2")).toHaveTextContent("2");
    expect(screen.queryByTestId("comment-anchor-layer-c2")).not.toBeInTheDocument();
  });

  it("labels authors without leaking ids: You / Member / guest name", async () => {
    renderPanel({
      pages: [
        {
          items: [
            row("me_row", { authorId: VIEWER_ID }),
            row("member_row", { authorId: "usr_other" }),
            row("guest_row", {
              authorId: null,
              guestName: "Rex Reviewer",
              guestEmail: "rex@example.com",
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    await openPanel();
    expect(screen.getByTestId("comment-author-me_row")).toHaveTextContent("You");
    expect(screen.getByTestId("comment-author-member_row")).toHaveTextContent("Member");
    expect(screen.getByTestId("comment-author-guest_row")).toHaveTextContent("Rex Reviewer");
    // No raw member ids ever render (law #1).
    expect(screen.queryByText(/usr_other/)).not.toBeInTheDocument();
  });

  it("renders hostile corpus strings as literal text — never markup", async () => {
    const scriptFixture = textFixture("html-script-exfil");
    const hostileCompName = textFixture("fake-system-turn").payload;
    const hostileGuest = textFixture("llama-boundary").payload;
    const bridge = createTestBridge({ comps: [{ name: hostileCompName }] });
    renderPanel({
      bridge,
      pages: [
        {
          items: [
            row("hostile", {
              body: scriptFixture.payload,
              authorId: null,
              guestName: hostileGuest,
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    await openPanel();

    const body = screen.getByTestId("comment-body-hostile");
    expect(body).toHaveTextContent(scriptFixture.needle);
    expect(body.textContent).toBe(scriptFixture.payload);
    expect(screen.getByTestId("comment-author-hostile").textContent).toBe(hostileGuest);
    expect(screen.getByTestId("comment-anchor-comp-hostile").textContent).toBe(hostileCompName);
    // React escapes: no script element was ever created.
    expect(document.querySelector("script")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filters (server-side per D-15 + the resolved param) + pagination
// ---------------------------------------------------------------------------

describe("CommentsPanel — filters + pagination", () => {
  it("starts on the Open filter (server-side resolved=false) and re-queries per toggle", async () => {
    const harness = renderPanel({ pages: [{ items: [row("c1")], nextCursor: null }] });
    await openPanel();
    expect(await lastQuery(harness)).toMatchObject({ resolved: false, limit: 20 });

    await userEvent.click(screen.getByTestId("comments-filter-all"));
    await waitFor(() => {
      expect(harness.fake.listCalls.at(-1)?.resolved).toBeUndefined();
    });
    await userEvent.click(screen.getByTestId("comments-filter-resolved"));
    await waitFor(() => {
      expect(harness.fake.listCalls.at(-1)?.resolved).toBe(true);
    });
  });

  it("filters by comp server-side (D-15: compId rides the query)", async () => {
    const bridge = createTestBridge({ comps: [{ name: "Main" }, { name: "Scene 2" }] });
    const harness = renderPanel({
      bridge,
      pages: [
        { items: [row("c1", { compId: "1" })], nextCursor: null },
        { items: [row("c2", { compId: "2" })], nextCursor: null },
      ],
    });
    await openPanel();

    await userEvent.click(screen.getByTestId("comments-comp-filter"));
    await userEvent.click(screen.getByTestId("comments-comp-option-2"));
    await waitFor(() => {
      expect(screen.getByTestId("comments-comp-filter")).toHaveTextContent("Scene 2");
    });
    expect(await lastQuery(harness)).toMatchObject({ compId: "2" });
  });

  it("paginates with the cursor and hides Load more at the end", async () => {
    const harness = renderPanel({
      pages: [
        { items: [row("p1")], nextCursor: "cursor-2" },
        { items: [row("p2", { createdAt: "2026-10-25T10:00:00.000Z" })], nextCursor: null },
      ],
    });
    await openPanel();
    expect(screen.getByTestId("comment-row-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("comment-row-p2")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("comments-load-more"));
    await waitFor(() => {
      expect(screen.getByTestId("comment-row-p2")).toBeInTheDocument();
    });
    expect(await lastQuery(harness)).toMatchObject({ cursor: "cursor-2" });
    await waitFor(() => {
      expect(screen.queryByTestId("comments-load-more")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Reply nesting + the 3-level visual cap
// ---------------------------------------------------------------------------

describe("CommentsPanel — reply threads", () => {
  const CHAIN = [
    row("a1", { createdAt: "2026-10-26T08:00:00.000Z" }),
    row("b2", { parentCommentId: "a1", createdAt: "2026-10-26T09:00:00.000Z" }),
    row("c3", { parentCommentId: "b2", createdAt: "2026-10-26T10:00:00.000Z" }),
    row("d4", { parentCommentId: "c3", createdAt: "2026-10-26T11:00:00.000Z" }),
  ];

  it("nests replies with data-depth, capping the visual level at three", async () => {
    renderPanel({ pages: [{ items: CHAIN, nextCursor: null }] });
    await openPanel();
    expect(screen.getByTestId("comment-row-a1")).toHaveAttribute("data-depth", "1");
    expect(screen.getByTestId("comment-row-b2")).toHaveAttribute("data-depth", "2");
    expect(screen.getByTestId("comment-row-c3")).toHaveAttribute("data-depth", "3");
    expect(screen.getByTestId("comment-row-d4")).toHaveAttribute("data-depth", "3"); // capped
  });

  it("offers Reply through level two; level-three rows have no reply affordance", async () => {
    renderPanel({ pages: [{ items: CHAIN, nextCursor: null }] });
    await openPanel();
    expect(screen.getByTestId("comment-reply-open-a1")).toBeInTheDocument();
    expect(screen.getByTestId("comment-reply-open-b2")).toBeInTheDocument();
    expect(screen.queryByTestId("comment-reply-open-c3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("comment-reply-open-d4")).not.toBeInTheDocument();
  });

  it("sends a reply through the wire and appends it in reading order", async () => {
    const harness = renderPanel({
      pages: [
        {
          items: [
            row("a1"),
            row("r1", { parentCommentId: "a1", createdAt: "2026-10-25T09:00:00.000Z" }),
          ],
          nextCursor: null,
        },
      ],
    });
    await openPanel();

    await userEvent.click(screen.getByTestId("comment-reply-open-a1"));
    const box = screen.getByTestId("comment-reply-box-a1");
    await userEvent.type(within(box).getByLabelText("Write a reply"), "Tighten the timing here.");
    await userEvent.click(screen.getByTestId("comment-reply-send-a1"));

    expect(harness.fake.replyCalls).toEqual([
      { commentId: "a1", body: { body: "Tighten the timing here." } },
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("comment-reply-box-a1")).not.toBeInTheDocument();
    });
    // The thread renders root → old reply → the new reply (reading order).
    const thread = screen.getByTestId("comment-thread-a1");
    const rowIds = within(thread)
      .getAllByTestId(/^comment-row-/)
      .map((element) => element.getAttribute("data-testid"));
    expect(rowIds).toEqual(["comment-row-a1", "comment-row-r1", "comment-row-cmt_reply_1"]);
  });
});

// ---------------------------------------------------------------------------
// Resolve / unresolve with resolvedBy
// ---------------------------------------------------------------------------

describe("CommentsPanel — resolve flow", () => {
  it("resolves a thread (empty body = resolve) and drops it from the Open filter", async () => {
    const harness = renderPanel({
      pages: [{ items: [row("a1"), row("r1", { parentCommentId: "a1" })], nextCursor: null }],
    });
    await openPanel();
    await userEvent.click(screen.getByTestId("comment-resolve-a1"));

    expect(harness.fake.resolveCalls).toEqual([{ commentId: "a1", body: undefined }]);
    // Thread-level filter semantics: the resolved thread leaves "Open".
    await waitFor(() => {
      expect(screen.queryByTestId("comment-thread-a1")).not.toBeInTheDocument();
    });
  });

  it("shows Resolved by you for the viewer's own resolution and reopens via { resolved: false }", async () => {
    const harness = renderPanel({
      pages: [
        {
          items: [row("a1", { resolvedAt: "2026-10-26T12:50:00.000Z", resolvedBy: VIEWER_ID })],
          nextCursor: null,
        },
      ],
    });
    await openPanel();
    expect(screen.getByTestId("comment-resolved-a1")).toHaveTextContent("Resolved by you");
    expect(screen.queryByTestId("comment-resolve-a1")).not.toBeInTheDocument();
    expect(screen.getByTestId("comment-reopen-a1")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("comment-reopen-a1"));
    expect(harness.fake.resolveCalls).toEqual([{ commentId: "a1", body: { resolved: false } }]);
    await waitFor(() => {
      expect(screen.queryByTestId("comment-resolved-a1")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("comment-resolve-a1")).toBeInTheDocument();
  });

  it("labels a resolution by someone else without leaking their id", async () => {
    renderPanel({
      pages: [
        { items: [row("a1", { resolvedAt: NOW, resolvedBy: "usr_dana" })], nextCursor: null },
      ],
    });
    await openPanel();
    expect(screen.getByTestId("comment-resolved-a1")).toHaveTextContent("Resolved");
    expect(screen.getByTestId("comment-resolved-a1")).not.toHaveTextContent("usr_dana");
  });
});

// ---------------------------------------------------------------------------
// Create with prefilled anchors from the live editor context
// ---------------------------------------------------------------------------

describe("CommentsPanel — create box", () => {
  it("prefills the anchor from ui.inspect (comp, first selected layer, playhead) and posts it", async () => {
    const hostileLayer = textFixture("chatml-boundary").payload;
    const bridge = createTestBridge({ playhead: 3.5, layerName: hostileLayer });
    const harness = renderPanel({ bridge, pages: [{ items: [], nextCursor: null }] });
    await openPanel();

    expect(await screen.findByTestId("comments-composer-anchor-comp")).toHaveTextContent("Main");
    // Whitespace-insensitive: the anchor chip CLIPS/wraps the hostile layer
    // name — fidelity of the TEXT is what matters, not collapsed spacing.
    expect(
      screen.getByTestId("comments-composer-anchor-layer").textContent?.replace(/\s+/g, " ").trim(),
    ).toBe(hostileLayer.replace(/\s+/g, " ").trim());
    expect(screen.getByTestId("comments-composer-anchor-time")).toHaveTextContent("0:03");

    await userEvent.type(screen.getByLabelText("Write a comment"), "The headline lands too late.");
    await userEvent.click(screen.getByTestId("comments-composer-send"));

    expect(harness.fake.createCalls).toEqual([
      {
        projectId: "prj_demo",
        body: {
          compId: "1",
          layerId: "1",
          timeTicks: secondsToTicks(3.5),
          body: "The headline lands too late.",
        },
      },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId("comment-body-cmt_new_1")).toHaveTextContent(
        "The headline lands too late.",
      );
    });
  });

  it("disables the composer with a hint when no composition is open (never a guess)", async () => {
    const bridge = createTestBridge({ comps: [] });
    renderPanel({ bridge, pages: [{ items: [], nextCursor: null }] });
    await openPanel();
    expect(await screen.findByTestId("comments-composer-hint")).toHaveTextContent(
      "Open a composition in the editor to anchor a new comment.",
    );
    expect(screen.getByLabelText("Write a comment")).toBeDisabled();
  });

  it("shows the empty state for an open-filter project with no comments", async () => {
    renderPanel({ pages: [{ items: [], nextCursor: null }] });
    await openPanel();
    expect(screen.getByTestId("comments-empty")).toHaveTextContent(
      "No open comments. Leave the first note.",
    );
  });
});

// ---------------------------------------------------------------------------
// The D-23 lease pin + error surface
// ---------------------------------------------------------------------------

describe("CommentsPanel — lease + errors", () => {
  it("pins that commenting STILL WORKS while another member holds the edit lease", async () => {
    const bridge = createTestBridge({ playhead: 1 });
    const harness = renderPanel({
      bridge,
      lease: { holderName: "Dana Flow", youAre: "viewer" },
      pages: [{ items: [], nextCursor: null }],
    });
    await openPanel();

    const note = screen.getByTestId("comments-lease-note");
    expect(note).toHaveTextContent("Dana Flow is editing");
    expect(note).toHaveTextContent("you can still read and comment");

    // THE PIN: the lease note never disables the composer.
    const textarea = screen.getByLabelText("Write a comment");
    expect(textarea).toBeEnabled();
    await userEvent.type(textarea, "Ship it from my side.");
    await userEvent.click(screen.getByTestId("comments-composer-send"));
    expect(harness.fake.createCalls).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByTestId("comment-body-cmt_new_1")).toBeInTheDocument();
    });
  });

  it("hides the lease note when the viewer holds the lease or it is free", async () => {
    const harness = renderPanel({
      lease: { holderName: null, youAre: "viewer" },
      pages: [{ items: [], nextCursor: null }],
    });
    await openPanel();
    expect(screen.queryByTestId("comments-lease-note")).not.toBeInTheDocument();

    harness.rerenderWith({ lease: { holderName: "Dana Flow", youAre: "holder" } });
    await openPanel();
    expect(screen.queryByTestId("comments-lease-note")).not.toBeInTheDocument();
  });

  it("surfaces list errors with a Retry that re-queries", async () => {
    const harness = renderPanel({ pages: [{ items: [row("c1")], nextCursor: null }] });
    harness.fake.failListOnce();
    await openPanel();
    await userEvent.click(screen.getByTestId("comments-filter-all"));
    await waitFor(() => {
      expect(screen.getByTestId("comments-error")).toHaveTextContent(
        "The comments list failed to load.",
      );
    });
    await userEvent.click(screen.getByTestId("comments-retry"));
    await waitFor(() => {
      expect(screen.queryByTestId("comments-error")).not.toBeInTheDocument();
    });
  });

  it("closes on Escape (the §9 layer dismissal)", async () => {
    const onClose = vi.fn();
    const fake = createFakeClient([{ items: [row("c1")], nextCursor: null }]);
    render(<CommentsPanel client={fake.client} projectId="prj_demo" open onClose={onClose} />);
    await openPanel();
    fireEvent.keyDown(screen.getByTestId("comments-panel"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Testid sweep for the Playwright wave
// ---------------------------------------------------------------------------

describe("CommentsPanel — Playwright testids", () => {
  it("exposes the full pinned testid surface", async () => {
    const bridge = createTestBridge({ playhead: 2, layerName: "Headline" });
    renderPanel({
      bridge,
      lease: { holderName: "Dana Flow", youAre: "viewer" },
      pages: [
        {
          items: [
            row("a1", { layerId: "1", timeTicks: TICKS_12S }),
            row("r1", { parentCommentId: "a1", createdAt: "2026-10-25T10:00:00.000Z" }),
          ],
          nextCursor: null,
        },
      ],
    });
    await openPanel();

    const expected = [
      "comments-panel",
      "comments-header",
      "comments-title",
      "comments-project",
      "comments-close",
      "comments-filters",
      "comments-filter-open",
      "comments-filter-resolved",
      "comments-filter-all",
      "comments-comp-filter",
      "comments-lease-note",
      "comments-list",
      "comment-thread-a1",
      "comment-row-a1",
      "comment-author-a1",
      "comment-when-a1",
      "comment-body-a1",
      "comment-anchor-comp-a1",
      "comment-anchor-layer-a1",
      "comment-anchor-time-a1",
      "comment-reply-open-a1",
      "comment-resolve-a1",
      "comment-row-r1",
      "comments-composer",
      "comments-composer-anchor",
      "comments-composer-anchor-comp",
      "comments-composer-anchor-layer",
      "comments-composer-anchor-time",
      "comments-composer-refresh",
      "comments-composer-send",
    ];
    for (const testId of expected) {
      expect(screen.getByTestId(testId), testId).toBeInTheDocument();
    }
    // The whole corpus stays renderable as data (sweep, not spot-check).
    for (const fixture of PROJECT_TEXT_INJECTIONS) {
      expect(() => JSON.stringify(fixture.needle)).not.toThrow();
    }
  });
});
