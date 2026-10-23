/**
 * WorkspaceStep tests (W2-02) — the orphaned `slug.ts` slugify finally wired:
 * live slug derivation from the name, the manual-edit-sticks rule, the slug
 * grammar gate, the typed 409 CONFLICT inline arm, and the success hand-up.
 * Deterministic RTL + a fake port; no network.
 */

import { ApiError, type ApiErrorInit } from "@studio/api-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStep } from "./workspace-step";

const USER = userEvent.setup();

const WORKSPACE = {
  id: "ws_new",
  name: "Acme Films",
  slug: "acme-films",
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
};

/** A typed §7.3 failure exactly as the api-client materializes it. */
function apiError(init: ApiErrorInit): ApiError {
  return new ApiError(init);
}

describe("WorkspaceStep — live slug derivation (slug.ts wired)", () => {
  it("derives the slug live from the name, folding accents and collapsing runs", async () => {
    const createWorkspace = vi.fn();
    render(<WorkspaceStep createWorkspace={createWorkspace} onCreated={vi.fn()} />);

    await USER.type(screen.getByLabelText(/^Workspace name/), "Café Soleil — Films!");
    const slug = screen.getByLabelText(/^Slug/) as HTMLInputElement;
    expect(slug.value).toBe("cafe-soleil-films");
    expect(screen.getByTestId("onboarding-slug-preview")).toHaveTextContent(
      "Your work will live at /w/cafe-soleil-films",
    );
  });

  it("keeps a manually edited slug when the name keeps changing (edit sticks)", async () => {
    const createWorkspace = vi.fn();
    render(<WorkspaceStep createWorkspace={createWorkspace} onCreated={vi.fn()} />);

    const name = screen.getByLabelText(/^Workspace name/);
    const slug = screen.getByLabelText(/^Slug/);
    await USER.type(name, "Acme Films");
    expect(slug).toHaveValue("acme-films");

    // First touch on the slug field: the manual value wins from here on.
    await USER.clear(slug);
    await USER.type(slug, "acme-custom");
    await USER.type(name, " Two");
    expect(slug).toHaveValue("acme-custom");
    expect(screen.getByTestId("onboarding-slug-preview")).toHaveTextContent(
      "Your work will live at /w/acme-custom",
    );
  });
});

describe("WorkspaceStep — submit arms", () => {
  it("blocks an invalid submit inline and never calls the port", async () => {
    const createWorkspace = vi.fn();
    render(<WorkspaceStep createWorkspace={createWorkspace} onCreated={vi.fn()} />);

    await USER.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("Name your workspace — it needs a name."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Lowercase letters, numbers and hyphens — starting and ending with a letter or number.",
      ),
    ).toBeInTheDocument();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("creates the workspace and hands the created row up on success", async () => {
    const createWorkspace = vi.fn().mockResolvedValue(WORKSPACE);
    const onCreated = vi.fn();
    render(<WorkspaceStep createWorkspace={createWorkspace} onCreated={onCreated} />);

    await USER.type(screen.getByLabelText(/^Workspace name/), "Acme Films!");
    await USER.click(screen.getByRole("button", { name: "Continue" }));

    expect(createWorkspace).toHaveBeenCalledWith(
      { name: "Acme Films!", slug: "acme-films" },
      undefined,
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(WORKSPACE));
  });

  it("surfaces the typed 409 CONFLICT inline on the slug field", async () => {
    const createWorkspace = vi
      .fn()
      .mockRejectedValue(
        apiError({
          status: 409,
          code: "CONFLICT",
          message: "That workspace slug is taken.",
          hint: "Pick a different slug.",
          requestId: "req_conflict",
        }),
      );
    const onCreated = vi.fn();
    render(<WorkspaceStep createWorkspace={createWorkspace} onCreated={onCreated} />);

    await USER.type(screen.getByLabelText(/^Workspace name/), "Acme Films!");
    await USER.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("That slug is taken. Pick a different one.")).toHaveAttribute(
      "id",
      "onboarding-slug-error",
    );
    // The typed arm is inline only — no form-level error strip, no advance.
    expect(screen.queryByTestId("onboarding-workspace-error")).not.toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    // The submit button recovers, so a different slug can be retried.
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("renders other typed failures as the bounded §7.3 strip (message + hint + request id)", async () => {
    const createWorkspace = vi
      .fn()
      .mockRejectedValue(
        apiError({
          status: 503,
          code: "SERVICE_UNAVAILABLE",
          message: "The database is not reachable right now.",
          hint: "Try again once the database is up.",
          requestId: "req_down",
        }),
      );
    render(<WorkspaceStep createWorkspace={createWorkspace} onCreated={vi.fn()} />);

    await USER.type(screen.getByLabelText(/^Workspace name/), "Acme Films!");
    await USER.click(screen.getByRole("button", { name: "Continue" }));

    const strip = await screen.findByTestId("onboarding-workspace-error");
    expect(strip).toHaveAttribute("role", "alert");
    expect(strip).toHaveTextContent("The database is not reachable right now.");
    expect(strip).toHaveTextContent("Try again once the database is up.");
    expect(strip).toHaveTextContent("Request req_down");
  });
});
