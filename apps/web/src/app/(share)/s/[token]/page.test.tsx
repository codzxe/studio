/**
 * The /s/:token RSC route tests (§M7 task 5): the PUBLIC share-meta read
 * through the gateway seam, and the §12.1 boundary — unknown, malformed,
 * expired or revoked tokens are 404s at the page, so a stranger never learns
 * whether a link existed. `@/lib/gateway` is mocked (the seam's own tests
 * cover the unwrap); `ShareReview` is stubbed so this stays an RSC-logic
 * test (the billing route's page.test.tsx pattern).
 */

import type { ShareReviewProps } from "@/components/share/share-review";
import type { ShareInfo } from "@studio/contracts";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
}));

const gatewayMock = vi.fn();
vi.mock("@/lib/gateway", () => ({
  GatewayHttpError: class GatewayHttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(init: { status: number; code: string; message: string }) {
      super(init.message);
      this.status = init.status;
      this.code = init.code;
    }
    get isNotFound(): boolean {
      return (
        this.status === 404 || this.code === "NOT_FOUND" || this.code === "WORKSPACE_NOT_FOUND"
      );
    }
  },
  isGatewayHttpError: (error: unknown): boolean =>
    error instanceof Error && error.constructor.name === "GatewayHttpError",
  isGatewayNotFound: (error: unknown): boolean =>
    error instanceof Error &&
    error.constructor.name === "GatewayHttpError" &&
    (error as GatewayHttpError).isNotFound,
  gatewayCall: (path: string) => gatewayMock(path),
}));

let lastReviewProps: ShareReviewProps | null = null;
vi.mock("@/components/share/share-review", () => ({
  ShareReview: (props: ShareReviewProps) => {
    lastReviewProps = props;
    return <div data-testid="share-review-stub" data-token={props.token} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import SharePage from "./page";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const TOKEN = "tKv3bZGq1rWj5yN8mXc2pQ7sD4hL6aF9eR3uY2iO0jPw";

const SHARE_INFO: ShareInfo = {
  projectId: "prj_night_titles",
  projectName: "Night Titles",
  compId: null,
  expiresAt: "2026-11-01T00:00:00Z",
  hasPassword: false,
  requestAccessEmail: null,
};

async function renderPage(token: string): Promise<React.ReactNode> {
  return SharePage({ params: Promise.resolve({ token }) });
}

beforeEach(() => {
  lastReviewProps = null;
  gatewayMock.mockReset();
});

describe("share RSC route", () => {
  it("reads the public share meta once and hands the surface its token + info", async () => {
    gatewayMock.mockResolvedValue(SHARE_INFO);
    const page = await renderPage(TOKEN);
    render(page);

    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock).toHaveBeenCalledWith(`/v1/share/${TOKEN}`);
    expect(screen.getByTestId("share-review-stub")).toBeInTheDocument();
    const props = lastReviewProps as ShareReviewProps;
    expect(props.token).toBe(TOKEN);
    expect(props.info).toEqual(SHARE_INFO);
  });

  it("404s an unknown/expired/revoked token (§12.1: never 403, never an oracle)", async () => {
    gatewayMock.mockRejectedValue(
      new GatewayHttpError({ status: 404, code: "NOT_FOUND", message: "Not found." }),
    );
    await expect(renderPage(TOKEN)).rejects.toThrow("__NOT_FOUND__");
  });

  it("404s the NOT_FOUND code regardless of the HTTP status", async () => {
    gatewayMock.mockRejectedValue(
      new GatewayHttpError({ status: 410, code: "NOT_FOUND", message: "Not found." }),
    );
    await expect(renderPage(TOKEN)).rejects.toThrow("__NOT_FOUND__");
  });

  it("404s a hostile/malformed token BEFORE any gateway round-trip", async () => {
    for (const hostile of [
      "",
      "short",
      "has spaces in it",
      "../../etc/passwd",
      "token?query=1",
      "<script>alert(1)</script>",
      `${TOKEN}${TOKEN}${TOKEN}${TOKEN}`, // > 128 chars
    ]) {
      await expect(renderPage(hostile)).rejects.toThrow("__NOT_FOUND__");
    }
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("rethrows non-404 failures to the boundary (a 500 is not a missing link)", async () => {
    gatewayMock.mockRejectedValue(
      new GatewayHttpError({
        status: 503,
        code: "INTERNAL_ERROR",
        message: "Something went wrong on our side.",
      }),
    );
    await expect(renderPage(TOKEN)).rejects.toThrow("Something went wrong on our side.");
  });

  it("never renders the review surface for a 404 link", async () => {
    gatewayMock.mockRejectedValue(
      new GatewayHttpError({ status: 404, code: "NOT_FOUND", message: "Not found." }),
    );
    try {
      await renderPage(TOKEN);
      expect.unreachable("page should have thrown");
    } catch {
      expect(lastReviewProps).toBeNull();
    }
  });
});
