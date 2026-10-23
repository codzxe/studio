/**
 * project-bar.test — the M3.5 floating bar + the REAL Share flow (W4-KILL,
 * audit REPLACE-2). The old "coming soon" inert button is gone: with a share
 * seam the button opens ShareDialog against a scripted fake client
 * (issue/list/revoke — the same structural `Pick<ApiClient, "share">` seam
 * the lease banner uses), and without a seam the button is simply absent
 * (never disabled, never "coming soon").
 *
 * Pinned flows:
 *   bar basics       → name, back link, read-only badge, no share without seam
 *   open + list      → loading → active links with created/expiry/password
 *   issue (once)     → Create link → /s/:token shown ONCE + copy → Copied
 *   revoke           → ConfirmDialog → revokeLink(id) → list refresh
 *   errors           → issue/list rejections surface typed messages
 *   close            → the issued token dies with the dialog (shown once)
 */

import { ApiError } from "@studio/api-client";
import type {
  Page,
  ShareLinkIssued,
  ShareLinkRevoked,
  ShareLinkView,
} from "@studio/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectBar } from "./project-bar";
import type { ShareClient } from "./project-bar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LINK_A: ShareLinkView = {
  id: "shr_a",
  projectId: "prj_1",
  createdBy: "u_me",
  createdAt: "2026-10-20T12:00:00.000Z",
  expiresAt: "2026-10-27T12:00:00.000Z",
  revokedAt: null,
  hasPassword: false,
};

const LINK_B: ShareLinkView = {
  id: "shr_b",
  projectId: "prj_1",
  createdBy: "u_me",
  createdAt: "2026-10-21T09:30:00.000Z",
  expiresAt: null,
  revokedAt: null,
  hasPassword: true,
};

/**
 * The public share surface (getInfo/getManifest/comments/request-access) this
 * suite never exercises — stubbed so every fake below is a WHOLE ShareClient,
 * not a partial cast (house style: lease-banner.test.tsx's typed fake).
 */
function unusedShareMethod(): never {
  throw new Error("share method not used in this suite");
}

function makeClient(script: {
  readonly links?: readonly ShareLinkView[];
  readonly issued?: ShareLinkIssued;
  readonly listError?: unknown;
  readonly issueError?: unknown;
  readonly revokeError?: unknown;
}): {
  readonly calls: {
    list: number;
    issues: number;
    revokes: string[];
  };
  readonly client: ShareClient;
} {
  const calls = { list: 0, issues: 0, revokes: [] as string[] };
  const client: ShareClient = {
    share: {
      getInfo: unusedShareMethod,
      getManifest: unusedShareMethod,
      listComments: unusedShareMethod,
      createComment: unusedShareMethod,
      requestAccess: unusedShareMethod,
      listLinks: async (): Promise<Page<ShareLinkView>> => {
        calls.list += 1;
        if (script.listError !== undefined) throw script.listError;
        return { items: script.links ?? [], nextCursor: null };
      },
      issueLink: async (): Promise<ShareLinkIssued> => {
        calls.issues += 1;
        if (script.issueError !== undefined) throw script.issueError;
        return (
          script.issued ?? {
            id: "shr_new",
            token: "tok_abc123def456",
            expiresAt: null,
            hasPassword: false,
          }
        );
      },
      revokeLink: async (id: string): Promise<ShareLinkRevoked> => {
        calls.revokes.push(id);
        if (script.revokeError !== undefined) throw script.revokeError;
        return { id, revokedAt: "2026-10-22T00:00:00.000Z" };
      },
    },
  };
  return { calls, client };
}

function apiError(message: string): ApiError {
  return new ApiError({
    code: "FORBIDDEN",
    message,
    status: 403,
    cause: undefined,
  });
}

function installClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function openShareDialog(): void {
  fireEvent.click(screen.getByTestId("editor-share-button"));
}

describe("ProjectBar — bar chrome", () => {
  it("renders the name, back link and read-only badge; no Share without a seam", () => {
    render(<ProjectBar projectName="Test Project" readOnly />);
    expect(screen.getByTestId("editor-project-bar")).toHaveTextContent("Test Project");
    expect(screen.getByRole("link", { name: "Back to workspace" })).toHaveAttribute("href", "/w");
    expect(screen.getByTestId("editor-readonly-badge")).toBeInTheDocument();
    // No share seam (a test session without an api client) → no button at all,
    // never an inert "coming soon" placeholder.
    expect(screen.queryByTestId("editor-share-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-share-placeholder")).not.toBeInTheDocument();
  });

  it("hides the read-only badge when writable; honours a custom back href", () => {
    render(<ProjectBar projectName="P" readOnly={false} backHref="/w/demo/history" />);
    expect(screen.queryByTestId("editor-readonly-badge")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to workspace" })).toHaveAttribute(
      "href",
      "/w/demo/history",
    );
  });
});

describe("ProjectBar — the real Share dialog", () => {
  it("opens the dialog, loads the active links and never says 'coming soon'", async () => {
    const { calls, client } = makeClient({ links: [LINK_A, LINK_B] });
    render(
      <ProjectBar
        projectName="Test Project"
        readOnly={false}
        share={{ projectId: "prj_1", client }}
      />,
    );
    openShareDialog();

    expect(screen.getByTestId("editor-share-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("editor-share-title")).toHaveTextContent("Test Project");

    // Loading → the two links with their honest metadata.
    await waitFor(() => {
      expect(screen.getAllByTestId("editor-share-link")).toHaveLength(2);
    });
    expect(calls.list).toBe(1);
    expect(screen.getByText("Created Oct 20, 2026")).toBeInTheDocument();
    expect(screen.getByText("Expires Oct 27, 2026")).toBeInTheDocument();
    expect(screen.getByText("Created Oct 21, 2026")).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    expect(screen.getByText("Password")).toBeInTheDocument();

    // The audit's pin: no "coming soon" copy anywhere in the share surface.
    expect(screen.getByTestId("editor-share-dialog").textContent?.toLowerCase()).not.toContain(
      "coming soon",
    );
  });

  it("shows the empty state when the project has no links", async () => {
    const { client } = makeClient({ links: [] });
    render(<ProjectBar projectName="P" readOnly={false} share={{ projectId: "prj_1", client }} />);
    openShareDialog();
    expect(await screen.findByTestId("editor-share-links-empty")).toBeInTheDocument();
  });

  it("issues a link: the /s/:token URL is shown ONCE with a copy that flips to Copied", async () => {
    const writeText = installClipboard();
    const { calls, client } = makeClient({ links: [] });
    render(<ProjectBar projectName="P" readOnly={false} share={{ projectId: "prj_1", client }} />);
    openShareDialog();
    await screen.findByTestId("editor-share-links-empty");

    fireEvent.click(screen.getByTestId("editor-share-create"));
    expect(await screen.findByTestId("editor-share-issued")).toBeInTheDocument();

    const expectedUrl = `${window.location.origin}/s/tok_abc123def456`;
    const urlField = screen.getByTestId("editor-share-url") as HTMLInputElement;
    expect(urlField.value).toBe(expectedUrl);
    expect(calls.issues).toBe(1);
    // The list is refreshed so the new link appears immediately.
    await waitFor(() => {
      expect(calls.list).toBe(2);
    });

    fireEvent.click(screen.getByTestId("editor-share-copy"));
    await waitFor(() => {
      expect(screen.getByTestId("editor-share-copy")).toHaveTextContent("Copied");
    });
    expect(writeText).toHaveBeenCalledWith(expectedUrl);
  });

  it("kills the issued token when the dialog closes — it is shown only once", async () => {
    installClipboard();
    const { client } = makeClient({ links: [] });
    render(<ProjectBar projectName="P" readOnly={false} share={{ projectId: "prj_1", client }} />);
    openShareDialog();
    await screen.findByTestId("editor-share-links-empty");

    fireEvent.click(screen.getByTestId("editor-share-create"));
    expect(await screen.findByTestId("editor-share-issued")).toBeInTheDocument();

    // Close (Esc on the dialog) then reopen: the raw token never comes back.
    fireEvent.keyDown(screen.getByTestId("editor-share-dialog"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("editor-share-dialog")).not.toBeInTheDocument();
    });
    openShareDialog();
    await waitFor(() => {
      expect(screen.getByTestId("editor-share-dialog")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("editor-share-issued")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("editor-share-url")).not.toBeInTheDocument();
  });

  it("revokes through the ConfirmDialog, then refreshes the list", async () => {
    let links: readonly ShareLinkView[] = [LINK_A, LINK_B];
    const calls = { list: 0, revokes: [] as string[] };
    const client: ShareClient = {
      share: {
        getInfo: unusedShareMethod,
        getManifest: unusedShareMethod,
        listComments: unusedShareMethod,
        createComment: unusedShareMethod,
        requestAccess: unusedShareMethod,
        listLinks: async (): Promise<Page<ShareLinkView>> => {
          calls.list += 1;
          return { items: links, nextCursor: null };
        },
        issueLink: async (): Promise<never> => {
          throw new Error("not used");
        },
        revokeLink: async (id: string): Promise<ShareLinkRevoked> => {
          calls.revokes.push(id);
          links = links.filter((link) => link.id !== id);
          return { id, revokedAt: null };
        },
      },
    };
    render(
      <ProjectBar
        projectName="P"
        readOnly={false}
        share={{ projectId: "prj_1", client }}
      />,
    );
    openShareDialog();
    await waitFor(() => {
      expect(screen.getAllByTestId("editor-share-link")).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByTestId("editor-share-revoke")[0] as HTMLElement);
    expect(await screen.findByText("Revoke this link?")).toBeInTheDocument();

    // Confirm is the ONLY revoke path (Cancel just closes).
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.queryByText("Revoke this link?")).not.toBeInTheDocument();
    });
    expect(calls.revokes).toEqual([]);

    fireEvent.click(screen.getAllByTestId("editor-share-revoke")[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("confirm-confirm"));
    await waitFor(() => {
      expect(calls.revokes).toEqual(["shr_a"]);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("editor-share-link")).toHaveLength(1);
    });
    expect(screen.queryByText("Revoke this link?")).not.toBeInTheDocument();
  });

  it("surfaces a typed issue error and a typed list error with a retry", async () => {
    let failList = true;
    const client: ShareClient = {
      share: {
        getInfo: unusedShareMethod,
        getManifest: unusedShareMethod,
        listComments: unusedShareMethod,
        createComment: unusedShareMethod,
        requestAccess: unusedShareMethod,
        listLinks: async (): Promise<Page<ShareLinkView>> => {
          if (failList) {
            failList = false;
            throw apiError("You need edit access to share.");
          }
          return { items: [LINK_A], nextCursor: null };
        },
        issueLink: async (): Promise<never> => {
          throw apiError("You need edit access to share.");
        },
        revokeLink: async (): Promise<never> => {
          throw new Error("not used");
        },
      },
    };
    render(
      <ProjectBar
        projectName="P"
        readOnly={false}
        share={{ projectId: "prj_1", client }}
      />,
    );
    openShareDialog();

    // List error → typed message + Try again recovers.
    expect(await screen.findByTestId("editor-share-links-error")).toHaveTextContent(
      "You need edit access to share.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(screen.getAllByTestId("editor-share-link")).toHaveLength(1);
    });

    // Issue error → typed message, no issued panel.
    fireEvent.click(screen.getByTestId("editor-share-create"));
    expect(await screen.findByTestId("editor-share-error")).toHaveTextContent(
      "You need edit access to share.",
    );
    expect(screen.queryByTestId("editor-share-issued")).not.toBeInTheDocument();
  });
});
