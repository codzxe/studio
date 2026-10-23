/**
 * ShareReview — the /s/:token client surface tests (BUILD_PLAN §M7 task 5):
 *
 * - password gate flow: empty submit, wrong password (401), the 429 window,
 *   and the unlock round-trip (manifest + password on every later call);
 * - open links: manifest + comments auto-load, meta render (project name,
 *   version label, expiry), the player video, branding;
 * - comments: threaded chronological list, member vs guest attribution,
 *   resolved indicator, anchor chips, guest composer validation + submit +
 *   rate-limit states, D-10 identity persistence (sessionStorage ONLY);
 * - request access: collapsed-in-gate + full form, typed ok/error feedback;
 * - hostile strings (project name, comment bodies) render as DATA, never
 *   as markup; the share password is never persisted.
 *
 * The SharePort is faked (the api-client's own tests pin the wire client);
 * jsdom provides sessionStorage and the <video> element stub.
 */

import { ApiError } from "@studio/api-client";
import type {
  CreateShareCommentRequest,
  Page,
  ShareComment,
  ShareInfo,
  ShareManifest,
  ShareManifestAsset,
} from "@studio/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

import { TICKS_PER_SECOND } from "./share-format";
import type { SharePort } from "./share-port";
import { ShareReview } from "./share-review";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const TOKEN = "tKv3bZGq1rWj5yN8mXc2pQ7sD4hL6aF9eR3uY2iO0jPw";
const PASSWORD = "correct-horse-battery";

const OPEN_INFO: ShareInfo = {
  projectId: "prj_night_titles",
  projectName: "Night Titles",
  compId: null,
  expiresAt: null,
  hasPassword: false,
  requestAccessEmail: null,
};

const LOCKED_INFO: ShareInfo = {
  ...OPEN_INFO,
  hasPassword: true,
  expiresAt: "2026-11-01T00:00:00Z",
};

const VIDEO_ASSET: ShareManifestAsset = {
  name: "reveal.mp4",
  mime: "video/mp4",
  width: 1920,
  height: 1080,
  durationTicks: TICKS_PER_SECOND * 10,
  url: "https://cdn.example/signed/reveal.mp4",
};

const MANIFEST: ShareManifest = {
  currentVersion: {
    version: 14,
    label: "Client cut",
    sizeBytes: 123_456,
    createdAt: "2026-10-01T10:00:00Z",
    url: "https://cdn.example/signed/version-object",
  },
  assets: [VIDEO_ASSET],
  updatedAt: "2026-10-20T09:00:00Z",
};

function makeComment(overrides: Partial<ShareComment>): ShareComment {
  return {
    id: "cmt_x",
    compId: "comp_main",
    layerId: null,
    timeTicks: null,
    parentCommentId: null,
    body: "A comment",
    guestName: null,
    resolvedAt: null,
    createdAt: "2026-10-01T12:00:00Z",
    ...overrides,
  };
}

const HOSTILE_BODY = `<script>alert("x")</script> <img src=x onerror=alert(1)>`;

/** Wire order = newest first (gateway listThreaded: createdAt desc). */
const COMMENTS: readonly ShareComment[] = [
  makeComment({
    id: "cmt_new_member",
    body: "Newest note from the team",
    createdAt: "2026-10-03T12:00:00Z",
  }),
  makeComment({
    id: "cmt_resolved",
    compId: "comp_titles",
    timeTicks: Math.round(12.5 * TICKS_PER_SECOND),
    body: "Hold the reveal two frames longer.",
    guestName: "Mia Reyes",
    resolvedAt: "2026-10-02T09:00:00Z",
    createdAt: "2026-10-02T08:00:00Z",
  }),
  makeComment({
    id: "cmt_old_guest",
    compId: "comp_main",
    body: HOSTILE_BODY,
    guestName: "Tom Silva",
    createdAt: "2026-10-01T12:00:00Z",
  }),
];

const COMMENTS_PAGE: Page<ShareComment> = { items: COMMENTS, nextCursor: null };
const EMPTY_PAGE: Page<ShareComment> = { items: [], nextCursor: null };

// ---------------------------------------------------------------------------
// Port double
// ---------------------------------------------------------------------------

interface PortDouble {
  readonly port: SharePort;
  readonly getManifest: Mock;
  readonly listComments: Mock;
  readonly createComment: Mock;
  readonly requestAccess: Mock;
}

function makePort(overrides: Partial<Record<keyof SharePort, Mock>> = {}): PortDouble {
  const getManifest = overrides.getManifest ?? vi.fn(async () => MANIFEST);
  const listComments = overrides.listComments ?? vi.fn(async () => COMMENTS_PAGE);
  const createComment =
    overrides.createComment ??
    vi.fn(async (_token: string, body: CreateShareCommentRequest) =>
      makeComment({
        id: "cmt_created",
        compId: body.compId,
        timeTicks: body.timeTicks ?? null,
        body: body.body,
        guestName: body.guestName,
        createdAt: "2026-10-21T12:00:00Z",
      }),
    );
  const requestAccess = overrides.requestAccess ?? vi.fn(async () => ({ ok: true }));
  return {
    port: { getManifest, listComments, createComment, requestAccess },
    getManifest,
    listComments,
    createComment,
    requestAccess,
  };
}

function apiError(status: number, code: string): ApiError {
  return new ApiError({ status, code, message: "wire message" });
}

async function renderShare(
  info: ShareInfo = OPEN_INFO,
  port: PortDouble = makePort(),
): Promise<PortDouble> {
  render(<ShareReview token={TOKEN} info={info} port={port.port} />);
  return port;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

// ---------------------------------------------------------------------------
// Open links
// ---------------------------------------------------------------------------

describe("share review — open link", () => {
  it("auto-loads the manifest + comments and renders the review surface", async () => {
    const double = await renderShare();

    await screen.findByTestId("share-surface");
    // The manifest loads async; the comments mount rides on it — wait for
    // the first list call before pinning the exact arguments.
    await waitFor(() => {
      expect(double.listComments).toHaveBeenCalled();
    });

    expect(screen.getByTestId("share-project-name")).toHaveTextContent("Night Titles");
    expect(double.getManifest).toHaveBeenCalledTimes(1);
    // The open-link load sends NO password (no header, no query — ever).
    expect(double.getManifest).toHaveBeenCalledWith(TOKEN);
    expect(double.listComments).toHaveBeenCalledWith(TOKEN, {});
  });

  it("renders the player surface the manifest actually serves (video preview + version label)", async () => {
    await renderShare();
    await screen.findByTestId("share-player");

    const video = screen.getByTestId("share-player-video") as HTMLVideoElement;
    expect(video).toBeInTheDocument();
    expect(video.getAttribute("src")).toBe(VIDEO_ASSET.url);
    expect(screen.queryByTestId("share-poster")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-version-label")).toHaveTextContent("v14 · Client cut");
  });

  it("renders the threaded comment list chronologically with attribution + anchors", async () => {
    await renderShare();
    await screen.findByTestId("share-comment-list");

    const list = screen.getByTestId("share-comment-list");
    const rows = within(list)
      .getAllByRole("listitem")
      .filter((item) => item.dataset.testid?.startsWith("share-comment-"));
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "share-comment-cmt_old_guest",
      "share-comment-cmt_resolved",
      "share-comment-cmt_new_member",
    ]);

    // Member-authored rows render "Studio member"; guest rows carry the name.
    expect(
      within(screen.getByTestId("share-comment-cmt_new_member")).getByTestId(
        "share-comment-author",
      ),
    ).toHaveTextContent("Studio member");
    expect(
      within(screen.getByTestId("share-comment-cmt_resolved")).getByTestId("share-comment-author"),
    ).toHaveTextContent("Mia Reyes");

    // Resolved indicator + anchor chips.
    expect(
      within(screen.getByTestId("share-comment-cmt_resolved")).getByTestId(
        "share-comment-resolved",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("share-comment-cmt_resolved")).getByTestId(
        "share-comment-anchor-comp",
      ),
    ).toHaveTextContent("comp comp_titles");
    expect(
      within(screen.getByTestId("share-comment-cmt_resolved")).getByTestId(
        "share-comment-anchor-time",
      ),
    ).toHaveTextContent("at 12.5s");
  });

  it("renders hostile project names and comment bodies as data, never as markup", async () => {
    const hostileInfo: ShareInfo = {
      ...OPEN_INFO,
      projectName: '<img src=x onerror="alert(1)">',
    };
    await renderShare(hostileInfo);
    await screen.findByTestId("share-comment-list");

    const page = screen.getByTestId("share-page");
    expect(page.querySelectorAll("img").length).toBe(0);
    expect(page.querySelectorAll("script").length).toBe(0);
    expect(screen.getByTestId("share-project-name")).toHaveTextContent(
      '<img src=x onerror="alert(1)">',
    );

    const hostileRow = screen.getByTestId("share-comment-cmt_old_guest");
    expect(hostileRow.textContent).toContain('<script>alert("x")</script>');
  });

  it("shows the expiry line and the Made-with branding", async () => {
    await renderShare(LOCKED_INFO);
    // The gate renders first for a protected link — expiry still shows.
    expect(screen.getByTestId("share-header").textContent).toContain("Expires");
    expect(screen.getByTestId("share-branding")).toHaveTextContent("Made with Studio");
  });

  it("surfaces a mid-review revocation (404 on the comment list) with a retry", async () => {
    const double = makePort({
      listComments: vi.fn(async () => {
        throw apiError(404, "NOT_FOUND");
      }),
    });
    await renderShare(OPEN_INFO, double);
    await screen.findByTestId("share-comments-error");

    expect(screen.getByTestId("share-comments-error")).toHaveTextContent(
      "This share link isn't available anymore.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Password gate
// ---------------------------------------------------------------------------

describe("share review — password gate", () => {
  it("renders the gate (no content fetch) for protected links", async () => {
    const double = await renderShare(LOCKED_INFO);

    expect(screen.getByTestId("share-gate")).toBeInTheDocument();
    expect(screen.queryByTestId("share-surface")).not.toBeInTheDocument();
    expect(double.getManifest).not.toHaveBeenCalled();

    // The locked-out reviewer is exactly who request access is for.
    expect(screen.getByTestId("share-request-access-collapsed")).toBeInTheDocument();
  });

  it("requires a password before calling the gateway", async () => {
    const double = await renderShare(LOCKED_INFO);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("share-gate-submit"));

    expect(screen.getByText("Enter the share password to unlock this link.")).toBeInTheDocument();
    expect(double.getManifest).not.toHaveBeenCalled();
  });

  it("shows one inline error for a wrong password (401 — no oracle)", async () => {
    const double = makePort({
      getManifest: vi.fn(async () => {
        throw apiError(401, "AUTH_REQUIRED");
      }),
    });
    await renderShare(LOCKED_INFO, double);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-gate-input"), "wrong-password");
    await user.click(screen.getByTestId("share-gate-submit"));

    expect(
      await screen.findByText(
        "That password didn't unlock this link. Check with whoever shared it.",
      ),
    ).toBeInTheDocument();
    expect(double.getManifest).toHaveBeenCalledWith(TOKEN, { password: "wrong-password" });
    expect(screen.queryByTestId("share-surface")).not.toBeInTheDocument();
  });

  it("surfaces the 429 window as too many attempts", async () => {
    const double = makePort({
      getManifest: vi.fn(async () => {
        throw apiError(429, "RATE_LIMITED");
      }),
    });
    await renderShare(LOCKED_INFO, double);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-gate-input"), PASSWORD);
    await user.click(screen.getByTestId("share-gate-submit"));

    expect(
      await screen.findByText("Too many attempts — wait a minute and try again."),
    ).toBeInTheDocument();
  });

  it("unlocks with the right password and threads it through every later call", async () => {
    const double = await renderShare(LOCKED_INFO);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-gate-input"), PASSWORD);
    await user.click(screen.getByTestId("share-gate-submit"));

    await screen.findByTestId("share-surface");
    expect(double.getManifest).toHaveBeenCalledWith(TOKEN, { password: PASSWORD });
    expect(double.listComments).toHaveBeenCalledWith(TOKEN, { password: PASSWORD });

    // The password is a credential: it must NOT persist in sessionStorage.
    expect(window.sessionStorage.getItem("studio.share.guest.v1")).toBeNull();
  });

  it("surfaces a 5xx on unlock as an unavailable state, still gated", async () => {
    const double = makePort({
      getManifest: vi.fn(async () => {
        throw apiError(503, "INTERNAL_ERROR");
      }),
    });
    await renderShare(LOCKED_INFO, double);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-gate-input"), PASSWORD);
    await user.click(screen.getByTestId("share-gate-submit"));

    expect(
      await screen.findByText("Something went wrong on our side. Try again in a moment."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("share-surface")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Guest composer
// ---------------------------------------------------------------------------

describe("share review — guest composer", () => {
  async function renderReady(port?: PortDouble): Promise<PortDouble> {
    const double = port ?? makePort();
    await renderShare(OPEN_INFO, double);
    await screen.findByTestId("share-composer");
    return double;
  }

  it("validates before calling the gateway (empty fields, email shape, name cap)", async () => {
    const double = await renderReady();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("share-composer-submit"));

    expect(
      await screen.findByText("Add your name so the team knows who's reviewing."),
    ).toBeInTheDocument();
    expect(screen.getByText("Add your email so replies can reach you.")).toBeInTheDocument();
    expect(screen.getByText("Write a comment first.")).toBeInTheDocument();
    expect(double.createComment).not.toHaveBeenCalled();

    // Bad email shape → typed field error, still no call.
    await user.type(screen.getByTestId("share-composer-name"), "Alex Jordan");
    await user.type(screen.getByTestId("share-composer-email"), "not-an-email");
    await user.type(screen.getByTestId("share-composer-body"), "A note");
    await user.click(screen.getByTestId("share-composer-submit"));
    expect(await screen.findByText("That email doesn't look right.")).toBeInTheDocument();
    expect(double.createComment).not.toHaveBeenCalled();

    // Over-cap name (a crafted request past the input's maxLength) → the
    // submit-side bound answers inline.
    fireEvent.change(screen.getByTestId("share-composer-email"), {
      target: { value: "reviewer@example.com" },
    });
    fireEvent.change(screen.getByTestId("share-composer-name"), {
      target: { value: "x".repeat(81) },
    });
    await user.click(screen.getByTestId("share-composer-submit"));
    expect(await screen.findByText("Keep your name under 80 characters.")).toBeInTheDocument();
    expect(double.createComment).not.toHaveBeenCalled();
  });

  it("posts a guest comment anchored to the comp the discussion already uses", async () => {
    const double = await renderReady();
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-composer-name"), "Alex Jordan");
    await user.type(screen.getByTestId("share-composer-email"), "alex@example.com");
    await user.type(screen.getByTestId("share-composer-body"), "The title feels early.");
    await user.click(screen.getByTestId("share-composer-submit"));

    await screen.findByTestId("share-composer-success");
    expect(double.createComment).toHaveBeenCalledWith(
      TOKEN,
      {
        compId: "comp_main",
        timeTicks: undefined,
        body: "The title feels early.",
        guestName: "Alex Jordan",
        guestEmail: "alex@example.com",
      },
      {},
    );
    expect(await screen.findByTestId("share-comment-cmt_created")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("share-comment-cmt_created")).getByTestId("share-comment-author"),
    ).toHaveTextContent("Alex Jordan");
  });

  it("falls back to the project-level comp anchor when no comment reveals one (v1 gap)", async () => {
    const double = makePort({ listComments: vi.fn(async () => EMPTY_PAGE) });
    await renderReady(double);
    const user = userEvent.setup();

    expect(await screen.findByTestId("share-composer-anchor-comp")).toHaveTextContent(
      "comp Project",
    );

    await user.type(screen.getByTestId("share-composer-name"), "Alex Jordan");
    await user.type(screen.getByTestId("share-composer-email"), "alex@example.com");
    await user.type(screen.getByTestId("share-composer-body"), "First!");
    await user.click(screen.getByTestId("share-composer-submit"));

    await screen.findByTestId("share-composer-success");
    expect(double.createComment).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ compId: "project" }),
      {},
    );
  });

  it("anchors the comment to the live playhead when the time chip is toggled", async () => {
    const double = await renderReady();
    const user = userEvent.setup();

    // jsdom never decodes media, but the element still carries currentTime.
    const video = screen.getByTestId("share-player-video") as HTMLVideoElement;
    video.currentTime = 12.5;
    fireEvent.timeUpdate(video);

    expect(await screen.findByTestId("share-time-readout")).toHaveTextContent("12.5s");
    const timeChip = screen.getByTestId("share-composer-anchor-time");
    expect(timeChip).toHaveTextContent("at 12.5s");
    expect(timeChip).toHaveAttribute("aria-pressed", "false");

    await user.click(timeChip);
    expect(screen.getByTestId("share-composer-anchor-time")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.type(screen.getByTestId("share-composer-name"), "Alex Jordan");
    await user.type(screen.getByTestId("share-composer-email"), "alex@example.com");
    await user.type(screen.getByTestId("share-composer-body"), "Here.");
    await user.click(screen.getByTestId("share-composer-submit"));

    await screen.findByTestId("share-composer-success");
    expect(double.createComment).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ timeTicks: Math.round(12.5 * TICKS_PER_SECOND) }),
      {},
    );
  });

  it("surfaces the per-IP comment rate limit (429)", async () => {
    const double = makePort({
      createComment: vi.fn(async () => {
        throw apiError(429, "RATE_LIMITED");
      }),
    });
    await renderReady(double);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-composer-name"), "Alex Jordan");
    await user.type(screen.getByTestId("share-composer-email"), "alex@example.com");
    await user.type(screen.getByTestId("share-composer-body"), "Rapid fire.");
    await user.click(screen.getByTestId("share-composer-submit"));

    expect(await screen.findByTestId("share-composer-error")).toHaveTextContent(
      "Too many attempts — wait a minute and try again.",
    );
  });

  it("sends hostile comment bodies verbatim as data", async () => {
    const double = await renderReady();
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-composer-name"), "Alex");
    await user.type(screen.getByTestId("share-composer-email"), "alex@example.com");
    await user.type(screen.getByTestId("share-composer-body"), HOSTILE_BODY);
    await user.click(screen.getByTestId("share-composer-submit"));

    await screen.findByTestId("share-composer-success");
    const call = double.createComment.mock.calls[0]?.[1] as CreateShareCommentRequest;
    expect(call.body).toBe(HOSTILE_BODY);
    expect(screen.getByTestId("share-page").querySelectorAll("script").length).toBe(0);
    expect(screen.getByTestId("share-page").querySelectorAll("img").length).toBe(0);
  });

  it("persists the guest identity in sessionStorage ONLY as pre-fill (D-10)", async () => {
    await renderReady();
    const user = userEvent.setup();

    await user.type(screen.getByTestId("share-composer-name"), "Alex Jordan");
    await user.type(screen.getByTestId("share-composer-email"), "alex@example.com");
    await user.type(screen.getByTestId("share-composer-body"), "One note.");
    await user.click(screen.getByTestId("share-composer-submit"));
    await screen.findByTestId("share-composer-success");

    const raw = window.sessionStorage.getItem("studio.share.guest.v1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "{}")).toEqual({ name: "Alex Jordan", email: "alex@example.com" });

    // A fresh page load prefills from the saved identity (both mounted
    // composers carry the values — the fresh one proves the pre-fill). The
    // pre-fill effect lands a tick after the composer mounts, so poll for
    // the VALUES, not just the elements.
    render(<ShareReview token={TOKEN} info={OPEN_INFO} port={makePort().port} />);
    await waitFor(() => {
      const names = screen.getAllByTestId("share-composer-name");
      const emails = screen.getAllByTestId("share-composer-email");
      expect(names.length).toBe(2);
      for (const input of names) {
        expect(input).toHaveValue("Alex Jordan");
      }
      for (const input of emails) {
        expect(input).toHaveValue("alex@example.com");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Request access
// ---------------------------------------------------------------------------

describe("share review — request access", () => {
  it("sends the request from the unlocked surface and confirms via the activity feed", async () => {
    const double = makePort();
    await renderShare(OPEN_INFO, double);
    const form = await screen.findByTestId("share-request-access");
    const user = userEvent.setup();

    await user.type(within(form).getByTestId("share-request-access-email"), "who@example.com");
    await user.type(
      within(form).getByTestId("share-request-access-message"),
      "Need edit rights for the final pass.",
    );
    await user.click(within(form).getByTestId("share-request-access-submit"));

    expect(await within(form).findByTestId("share-request-access-ok")).toHaveTextContent(
      "Request sent. The workspace will see it in its activity feed.",
    );
    expect(double.requestAccess).toHaveBeenCalledWith(TOKEN, {
      email: "who@example.com",
      message: "Need edit rights for the final pass.",
    });
  });

  it("surfaces the request-access rate limit and validation inline", async () => {
    const double = makePort({
      requestAccess: vi.fn(async () => {
        throw apiError(429, "RATE_LIMITED");
      }),
    });
    await renderShare(OPEN_INFO, double);
    const form = await screen.findByTestId("share-request-access");
    const user = userEvent.setup();

    // Invalid email → typed field error, nothing sent.
    await user.type(within(form).getByTestId("share-request-access-email"), "not-an-email");
    await user.click(within(form).getByTestId("share-request-access-submit"));
    expect(await within(form).findByText("That email doesn't look right.")).toBeInTheDocument();
    expect(double.requestAccess).not.toHaveBeenCalled();

    // Valid email but the IP window is spent → 429 copy.
    await user.clear(within(form).getByTestId("share-request-access-email"));
    await user.type(within(form).getByTestId("share-request-access-email"), "who@example.com");
    await user.click(within(form).getByTestId("share-request-access-submit"));
    expect(await within(form).findByTestId("share-request-access-error")).toHaveTextContent(
      "Too many attempts — wait a minute and try again.",
    );
  });

  it("expands the collapsed form inside the password gate and posts", async () => {
    const double = await renderShare(LOCKED_INFO);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("share-request-access-toggle"));
    const form = await screen.findByTestId("share-request-access");
    await user.type(within(form).getByTestId("share-request-access-email"), "locked@example.com");
    await user.click(within(form).getByTestId("share-request-access-submit"));

    expect(await within(form).findByTestId("share-request-access-ok")).toBeInTheDocument();
    expect(double.requestAccess).toHaveBeenCalledWith(TOKEN, { email: "locked@example.com" });
  });
});

// ---------------------------------------------------------------------------
// Offline (§8.11, W5-06) — the share surface's own arm (no app shell here)
// ---------------------------------------------------------------------------

/** jsdom navigator.onLine shim (the auth-offline / offline-banner pattern). */
function setNavigatorOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

describe("share review — offline (§8.11)", () => {
  it("renders no offline chrome while online", async () => {
    setNavigatorOnline(true);
    await renderShare();
    await screen.findByTestId("share-surface");
    expect(screen.queryByTestId("share-offline")).not.toBeInTheDocument();
  });

  it("shows the honest offline notice over the gated surface and clears on reconnect", async () => {
    setNavigatorOnline(true);
    await renderShare(LOCKED_INFO);

    await act(async () => {
      setNavigatorOnline(false);
    });

    const notice = screen.getByTestId("share-offline");
    expect(notice).toHaveTextContent("You're offline.");
    expect(notice).toHaveTextContent(/the link itself is fine/);
    // The gate stays rendered — offline explains, it never hides the form.
    expect(screen.getByTestId("share-gate-form")).toBeInTheDocument();

    await act(async () => {
      setNavigatorOnline(true);
    });
    expect(screen.queryByTestId("share-offline")).not.toBeInTheDocument();
  });
});
