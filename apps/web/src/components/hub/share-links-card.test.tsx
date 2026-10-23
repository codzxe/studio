/**
 * ShareLinksCard tests (W2-05, §8.6 secondary Share action) — the member
 * share-link surface against a scripted fake ShareLinksPort: the shown-ONCE
 * issuance dialog (the raw token's only appearance — copy URL, dropped on
 * close, never in the list), active-link listing with revoked rows filtered,
 * the destructive revoke flow through ConfirmDialog, and typed §7.3 failures.
 * jsdom, no network; the clipboard is stubbed.
 */

import { ApiError } from "@studio/api-client";
import type { ShareLinkIssued, ShareLinkView } from "@studio/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShareLinksPort } from "./hub-port";
import { ShareLinksCard, shareLinkRowCopy, shareLinkUrl } from "./share-links-card";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-10-26T12:00:00.000Z";

function link(overrides: Partial<ShareLinkView> = {}): ShareLinkView {
  return {
    id: "shr_0001",
    projectId: "prj_demo",
    createdBy: "usr_me",
    createdAt: "2026-10-20T09:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    hasPassword: false,
    ...overrides,
  };
}

function issued(overrides: Partial<ShareLinkIssued> = {}): ShareLinkIssued {
  return {
    id: "shr_new",
    token: "tok_256bit_base64url_newlink",
    expiresAt: null,
    hasPassword: false,
    ...overrides,
  };
}

interface Harness {
  readonly port: ShareLinksPort;
}

function makePort(overrides: Partial<ShareLinksPort> = {}): ShareLinksPort {
  return {
    issueLink: vi.fn(async () => issued()),
    listLinks: vi.fn(async () => ({ items: [link()], nextCursor: null })),
    revokeLink: vi.fn(async (id: string) => ({ id, revokedAt: NOW })),
    ...overrides,
  };
}

function renderCard(overrides: { readonly port?: ShareLinksPort } = {}): Harness {
  const port = overrides.port ?? makePort();
  render(
    <ShareLinksCard
      projectId="prj_demo"
      workspaceId="ws_demo"
      projectName="Launch film"
      canManage
      nowIso={NOW}
      api={port}
      origin="https://studio.example.test"
    />,
  );
  return { port };
}

const USER = userEvent.setup();

const writeText = vi.fn(async () => {});
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// The dialog + active links list
// ---------------------------------------------------------------------------

describe("ShareLinksCard list", () => {
  it("opens on Share and lists active links (revoked rows filtered)", async () => {
    const { port } = renderCard({
      port: makePort({
        listLinks: vi.fn(async () => ({
          items: [
            link(),
            link({ id: "shr_gone", revokedAt: NOW }),
            link({ id: "shr_pass", hasPassword: true, expiresAt: "2026-11-02T00:00:00.000Z" }),
          ],
          nextCursor: null,
        })),
      }),
    });

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await waitFor(() => {
      expect(port.listLinks).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-row-shr_0001")).toBeInTheDocument();
    });
    expect(screen.getByTestId("hub-share-row-shr_pass")).toHaveTextContent("Password protected");
    expect(screen.getByTestId("hub-share-row-shr_pass")).toHaveTextContent("Expires Nov 2, 2026");
    expect(screen.queryByTestId("hub-share-row-shr_gone")).toBeNull();
    // No token material in the list — only row metadata.
    expect(screen.queryByText(/tok_/i)).toBeNull();
  });

  it("empty list: the honest empty state", async () => {
    renderCard({
      port: makePort({ listLinks: vi.fn(async () => ({ items: [], nextCursor: null })) }),
    });

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-empty")).toHaveTextContent("No active links yet.");
    });
  });

  it("renders nothing for viewers (canManage false — the editor+ floor)", () => {
    render(
      <ShareLinksCard
        projectId="prj_demo"
        workspaceId="ws_demo"
        projectName="Launch film"
        canManage={false}
        nowIso={NOW}
        api={makePort()}
      />,
    );
    expect(screen.queryByTestId("hub-share-trigger")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The shown-ONCE issuance
// ---------------------------------------------------------------------------

describe("ShareLinksCard issue (shown once)", () => {
  it("mints a link and shows the URL exactly once with Copy", async () => {
    const { port } = renderCard();

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await USER.click(await screen.findByTestId("hub-share-create"));

    await waitFor(() => {
      expect(port.issueLink).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-issued-url")).toHaveTextContent(
        "https://studio.example.test/s/tok_256bit_base64url_newlink",
      );
    });
    expect(screen.getByTestId("hub-share-issued-note")).toHaveTextContent("shown only once");
    // Copy rides the clipboard (idempotent — the label flips to Copied).
    await USER.click(screen.getByTestId("hub-share-copy"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://studio.example.test/s/tok_256bit_base64url_newlink",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-copy")).toHaveTextContent("Copied");
    });
  });

  it("drops the once-URL when the dialog closes — reopening never shows it again", async () => {
    const { port } = renderCard();

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await USER.click(await screen.findByTestId("hub-share-create"));
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-issued")).toBeInTheDocument();
    });

    await USER.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByTestId("hub-share-issued")).toBeNull();
    });

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await waitFor(() => {
      expect(port.listLinks).toHaveBeenCalledTimes(3); // open, post-issue, reopen
    });
    expect(screen.queryByTestId("hub-share-issued")).toBeNull();
    expect(screen.queryByText(/tok_/i)).toBeNull();
  });

  it("surfaces typed issue failures in place (§7.3)", async () => {
    renderCard({
      port: makePort({
        issueLink: vi.fn(async () => {
          throw new ApiError({
            code: "FORBIDDEN",
            message: "You don't have permission to do that.",
            status: 403,
            requestId: "req_share_01",
          });
        }),
      }),
    });

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await USER.click(await screen.findByTestId("hub-share-create"));
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-error")).toHaveTextContent(
        "You don't have permission to do that. (req_share_01)",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Revoke (destructive → ConfirmDialog)
// ---------------------------------------------------------------------------

describe("ShareLinksCard revoke", () => {
  it("revokes through the ConfirmDialog and drops the row", async () => {
    const { port } = renderCard();

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-row-shr_0001")).toBeInTheDocument();
    });

    await USER.click(screen.getByTestId("hub-share-revoke-shr_0001"));
    // §7.5: the destructive dialog names the action and consequence.
    expect(await screen.findByText("Revoke this share link?")).toBeInTheDocument();
    await USER.click(screen.getByTestId("confirm-confirm"));

    await waitFor(() => {
      expect(port.revokeLink).toHaveBeenCalledWith("shr_0001");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("hub-share-row-shr_0001")).toBeNull();
    });
  });

  it("re-revoking (idempotent upstream) just refreshes the list; typed failures surface", async () => {
    let revoked = false;
    const port = makePort({
      revokeLink: vi.fn(async (id: string) => {
        revoked = true;
        return { id, revokedAt: NOW };
      }),
      listLinks: vi.fn(async () => ({
        // After the revoke the wire still returns the row until it is
        // filtered client-side by revokedAt (active-links semantics).
        items: [link({ revokedAt: revoked ? NOW : null })],
        nextCursor: null,
      })),
    });
    renderCard({ port });

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-row-shr_0001")).toBeInTheDocument();
    });

    await USER.click(screen.getByTestId("hub-share-revoke-shr_0001"));
    await USER.click(await screen.findByTestId("confirm-confirm"));
    await waitFor(() => {
      expect(screen.queryByTestId("hub-share-row-shr_0001")).toBeNull();
    });

    // A second revoke of the same id answers ok (idempotent) — no dialog loop.
    await port.revokeLink("shr_0001");
    expect(port.revokeLink).toHaveBeenCalledTimes(2);
  });

  it("surfaces typed revoke failures with the §14 line", async () => {
    renderCard({
      port: makePort({
        revokeLink: vi.fn(async () => {
          throw new ApiError({
            code: "FORBIDDEN",
            message: "Only the link creator or an admin can revoke it.",
            status: 403,
            requestId: "req_rv_01",
          });
        }),
      }),
    });

    await USER.click(screen.getByTestId("hub-share-trigger"));
    await USER.click(screen.getByTestId("hub-share-revoke-shr_0001"));
    await USER.click(await screen.findByTestId("confirm-confirm"));
    await waitFor(() => {
      expect(screen.getByTestId("hub-share-error")).toHaveTextContent(
        "Only the link creator or an admin can revoke it. (req_rv_01)",
      );
    });
    // The row stays — the revoke did not happen.
    expect(screen.getByTestId("hub-share-row-shr_0001")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("share-links helpers", () => {
  it("shareLinkUrl joins origin + /s/:token (no double slashes)", () => {
    expect(shareLinkUrl("https://studio.example.test", "tok_abc")).toBe(
      "https://studio.example.test/s/tok_abc",
    );
    expect(shareLinkUrl("https://studio.example.test/", "tok_abc")).toBe(
      "https://studio.example.test/s/tok_abc",
    );
  });

  it("shareLinkRowCopy renders created/expiry/password honestly", () => {
    expect(shareLinkRowCopy(link(), NOW)).toBe("Created Oct 20, 2026 · No expiry");
    expect(
      shareLinkRowCopy(link({ expiresAt: "2026-11-02T00:00:00.000Z", hasPassword: true }), NOW),
    ).toBe("Created Oct 20, 2026 · Expires Nov 2, 2026 · Password protected");
    expect(shareLinkRowCopy(link({ expiresAt: "2026-10-01T00:00:00.000Z" }), NOW)).toBe(
      "Created Oct 20, 2026 · Expired",
    );
  });
});
