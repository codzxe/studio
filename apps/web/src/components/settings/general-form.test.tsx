/**
 * GeneralForm tests (W2-06) — the §8.9 General card: name/slug edit through
 * `workspaces.patch` (dirty-only PATCH bodies), client-side validation, the
 * typed 409 CONFLICT landing inline on the slug field, the bounded §7.3
 * fallback strip, the v2 honesty note (no fake visibility/logo fields) and
 * the read-only arm for non-admins. Deterministic RTL + injected port.
 */

import { ApiError } from "@studio/api-client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeneralForm, type GeneralPort } from "./general-form";

const USER = userEvent.setup();

const patchWorkspace = vi.fn<GeneralPort["patchWorkspace"]>();
let port: GeneralPort;

beforeEach(() => {
  patchWorkspace.mockReset();
  port = { patchWorkspace };
});

function renderForm(canManage = true): void {
  render(
    <GeneralForm
      workspaceId="ws_1"
      workspaceName="First Films"
      workspaceSlug="first-films"
      canManage={canManage}
      api={port}
    />,
  );
}

describe("GeneralForm — display", () => {
  it("shows the workspace name and slug prefilled", () => {
    renderForm();
    expect(screen.getByLabelText(/Name/)).toHaveValue("First Films");
    expect(screen.getByLabelText(/Slug/)).toHaveValue("first-films");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("states honestly that logo and default visibility are v2 — no fake fields", () => {
    renderForm();
    expect(screen.getByText("Not configurable yet")).toBeInTheDocument();
    expect(
      screen.getByText(/workspace logo and a default project visibility setting arrive in v2/i),
    ).toBeInTheDocument();
    // No logo/visibility inputs exist.
    expect(screen.queryByLabelText(/Logo/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Visibility/i)).not.toBeInTheDocument();
  });

  it("read-only for non-admins: disabled fields, no save button, honest note", () => {
    renderForm(false);
    expect(screen.getByLabelText(/Name/)).toBeDisabled();
    expect(screen.getByLabelText(/Slug/)).toBeDisabled();
    expect(screen.queryByTestId("general-save")).not.toBeInTheDocument();
    expect(screen.getByText(/Only workspace admins can change these/i)).toBeInTheDocument();
  });
});

describe("GeneralForm — save", () => {
  it("keeps Save disabled until something changed, then sends only the changed fields", async () => {
    patchWorkspace.mockResolvedValue({
      id: "ws_1",
      name: "First Films",
      slug: "first-films-new",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
    });
    renderForm();
    const save = screen.getByTestId("general-save");
    expect(save).toBeDisabled();

    await USER.clear(screen.getByLabelText(/Slug/));
    await USER.type(screen.getByLabelText(/Slug/), "first-films-new");
    expect(save).toBeEnabled();

    await USER.click(save);
    expect(patchWorkspace).toHaveBeenCalledWith({ slug: "first-films-new" });
    expect(await screen.findByTestId("general-saved")).toHaveTextContent("Saved.");
  });

  it("sends name and slug together when both changed", async () => {
    patchWorkspace.mockResolvedValue({
      id: "ws_1",
      name: "Renamed",
      slug: "renamed",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
    });
    renderForm();
    await USER.clear(screen.getByLabelText(/Name/));
    await USER.type(screen.getByLabelText(/Name/), "Renamed");
    await USER.clear(screen.getByLabelText(/Slug/));
    await USER.type(screen.getByLabelText(/Slug/), "renamed");
    await USER.click(screen.getByTestId("general-save"));
    expect(patchWorkspace).toHaveBeenCalledWith({ name: "Renamed", slug: "renamed" });
  });

  it("validates name and slug client-side before any call", async () => {
    renderForm();
    await USER.clear(screen.getByLabelText(/Name/));
    await USER.clear(screen.getByLabelText(/Slug/));
    await USER.type(screen.getByLabelText(/Slug/), "Not A Slug!");
    await USER.click(screen.getByTestId("general-save"));
    expect(patchWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText(/Name your workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/Lowercase letters, numbers and hyphens/i)).toBeInTheDocument();
  });

  it("lands the typed 409 CONFLICT inline on the slug field", async () => {
    patchWorkspace.mockRejectedValue(
      new ApiError({
        code: "CONFLICT",
        status: 409,
        message: "That workspace slug is taken.",
        hint: "Pick a different slug.",
        requestId: "req_slug_409",
      }),
    );
    renderForm();
    await USER.clear(screen.getByLabelText(/Slug/));
    await USER.type(screen.getByLabelText(/Slug/), "taken-slug");
    await USER.click(screen.getByTestId("general-save"));
    expect(
      await screen.findByText("That slug is taken. Pick a different one."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("general-error")).not.toBeInTheDocument();
  });

  it("surfaces other typed failures as the bounded message/hint/request-id strip", async () => {
    patchWorkspace.mockRejectedValue(
      new ApiError({
        code: "FORBIDDEN",
        status: 403,
        message: "You don't have permission to do that.",
        hint: "Ask a workspace admin for access.",
        requestId: "req_forbidden",
      }),
    );
    renderForm();
    await USER.clear(screen.getByLabelText(/Name/));
    await USER.type(screen.getByLabelText(/Name/), "Attempted Rename");
    await USER.click(screen.getByTestId("general-save"));
    const error = await screen.findByTestId("general-error");
    expect(error).toHaveTextContent("You don't have permission to do that.");
    expect(error).toHaveTextContent("Ask a workspace admin for access.");
    expect(error).toHaveTextContent("Request req_forbidden");
  });

  it("degrades non-Api failures to the sanitized generic (never a stack)", async () => {
    patchWorkspace.mockRejectedValue(new Error("raw internal catastrophe /var/secrets"));
    renderForm();
    await USER.clear(screen.getByLabelText(/Name/));
    await USER.type(screen.getByLabelText(/Name/), "Attempted Rename");
    await USER.click(screen.getByTestId("general-save"));
    const error = await screen.findByTestId("general-error");
    expect(error).toHaveTextContent("Something went wrong on our side.");
    expect(error).not.toHaveTextContent("catastrophe");
  });
});
