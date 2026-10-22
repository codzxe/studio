/**
 * ShareRequestAccess standalone tests (§M7 task 5): collapsed inside the
 * password gate (someone locked out is exactly who requests access), the
 * email+note form, typed ok feedback, validation and the per-IP 429 window.
 * The gateway route is NOT password-gated by design; the workspace reads the
 * request in its activity feed (v1 notification).
 */

import { ApiError } from "@studio/api-client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

import type { SharePort } from "./share-port";
import { ShareRequestAccess } from "./share-request-access";

const TOKEN = "tKv3bZGq1rWj5yN8mXc2pQ7sD4hL6aF9eR3uY2iO0jPw";

/** Other share calls are out of scope here — they must never run. */
async function unreachable(): Promise<never> {
  throw new Error("unexpected call");
}

function makePort(impl?: () => Promise<{ ok: true }>): { port: SharePort; requestAccess: Mock } {
  const requestAccess =
    impl !== undefined
      ? vi.fn(impl)
      : vi.fn(async () => {
          return { ok: true } as const;
        });
  return {
    port: {
      getManifest: unreachable,
      listComments: unreachable,
      createComment: unreachable,
      requestAccess,
    },
    requestAccess,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("ShareRequestAccess", () => {
  it("starts collapsed in the compact (gate) variant and expands on demand", async () => {
    const { port } = makePort();
    const user = userEvent.setup();
    render(<ShareRequestAccess port={port} token={TOKEN} variant="compact" />);

    expect(screen.getByTestId("share-request-access-collapsed")).toBeInTheDocument();
    await user.click(screen.getByTestId("share-request-access-toggle"));
    expect(await screen.findByTestId("share-request-access")).toBeInTheDocument();
  });

  it("sends the email (plus an optional note) and confirms typed ok", async () => {
    const { port, requestAccess } = makePort();
    const user = userEvent.setup();
    render(<ShareRequestAccess port={port} token={TOKEN} />);

    await user.type(screen.getByTestId("share-request-access-email"), "reviewer@example.com");
    await user.type(screen.getByTestId("share-request-access-message"), "Need edit rights.");
    await user.click(screen.getByTestId("share-request-access-submit"));

    expect(await screen.findByTestId("share-request-access-ok")).toHaveTextContent(
      "Request sent. The workspace will see it in its activity feed.",
    );
    expect(requestAccess).toHaveBeenCalledWith(TOKEN, {
      email: "reviewer@example.com",
      message: "Need edit rights.",
    });
  });

  it("omits the message field when the note is empty", async () => {
    const { port, requestAccess } = makePort();
    const user = userEvent.setup();
    render(<ShareRequestAccess port={port} token={TOKEN} />);

    await user.type(screen.getByTestId("share-request-access-email"), "reviewer@example.com");
    await user.click(screen.getByTestId("share-request-access-submit"));

    expect(await screen.findByTestId("share-request-access-ok")).toBeInTheDocument();
    expect(requestAccess).toHaveBeenCalledWith(TOKEN, { email: "reviewer@example.com" });
  });

  it("validates the email inline and never sends a malformed request", async () => {
    const { port, requestAccess } = makePort();
    const user = userEvent.setup();
    render(<ShareRequestAccess port={port} token={TOKEN} />);

    await user.type(screen.getByTestId("share-request-access-email"), "not-an-email");
    await user.click(screen.getByTestId("share-request-access-submit"));

    expect(await screen.findByText("That email doesn't look right.")).toBeInTheDocument();
    expect(requestAccess).not.toHaveBeenCalled();

    await user.clear(screen.getByTestId("share-request-access-email"));
    await user.click(screen.getByTestId("share-request-access-submit"));
    expect(
      await screen.findByText("Add the email the workspace should reach."),
    ).toBeInTheDocument();
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it("surfaces the per-IP 429 window with typed copy", async () => {
    const { port, requestAccess } = makePort(async () => {
      throw new ApiError({ status: 429, code: "RATE_LIMITED", message: "wire message" });
    });
    const user = userEvent.setup();
    render(<ShareRequestAccess port={port} token={TOKEN} />);

    await user.type(screen.getByTestId("share-request-access-email"), "reviewer@example.com");
    await user.click(screen.getByTestId("share-request-access-submit"));

    expect(await screen.findByTestId("share-request-access-error")).toHaveTextContent(
      "Too many attempts — wait a minute and try again.",
    );
    expect(requestAccess).toHaveBeenCalledTimes(1);
  });

  it("prefills the email from the saved guest identity (D-10 convenience)", () => {
    window.sessionStorage.setItem(
      "studio.share.guest.v1",
      JSON.stringify({ name: "Alex", email: "alex@example.com" }),
    );
    const { port } = makePort();
    render(<ShareRequestAccess port={port} token={TOKEN} />);

    expect(screen.getByTestId("share-request-access-email")).toHaveValue("alex@example.com");
  });
});
