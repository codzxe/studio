/**
 * NewProjectDialog tests (W2-03, §8.4) — the dashboard's primary action:
 * accessible modal wiring, the local name bound (empty/over-length inline
 * arms — the port is never called), the create hand-off with ONE fresh
 * idempotency key per attempt (law #4), the success navigation to the
 * project hub, the typed §7.3 failure surface (429 quota arm) and the
 * clean-reopen reset. The create seam is faked; next/navigation is mocked.
 */

import { ApiError, type ApiErrorInit, type CallOptions } from "@studio/api-client";
import type { CreateProjectRequest, Project } from "@studio/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewProjectDialog } from "./new-project-dialog";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w",
  useSearchParams: () => new URLSearchParams(),
}));

const USER = userEvent.setup();

const PROJECT: Project = {
  id: "prj_new",
  workspaceId: "ws_first",
  name: "Launch film",
  slug: "launch-film",
  thumbnailUrl: null,
  archived: false,
  currentVersionId: null,
  createdBy: "user_1",
  createdAt: "2026-10-21T12:00:00Z",
  updatedAt: "2026-10-21T12:00:00Z",
  deletedAt: null,
};

/** A typed §7.3 failure exactly as the api-client materializes it. */
function apiError(init: ApiErrorInit): ApiError {
  return new ApiError(init);
}

type CreateMock = ReturnType<
  typeof vi.fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>
>;

function renderDialog(create: CreateMock) {
  const onOpenChange = vi.fn();
  render(
    <NewProjectDialog
      open
      onOpenChange={onOpenChange}
      createProject={(body, options) => create(body, options)}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  routerPush.mockClear();
});

describe("NewProjectDialog", () => {
  it("renders an accessible modal: role=dialog named by its title", () => {
    renderDialog(vi.fn());
    expect(screen.getByRole("dialog", { name: "New project" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Project name/)).toBeInTheDocument();
  });

  it("blocks an empty submit inline and never calls the create seam", async () => {
    const create = vi.fn();
    renderDialog(create);

    await USER.click(screen.getByTestId("new-project-create"));

    expect(await screen.findByText("Name your project — it needs a name.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("blocks an over-length name inline (the wire bound is 120 chars)", async () => {
    const create = vi.fn();
    renderDialog(create);

    await USER.type(screen.getByLabelText(/^Project name/), "x".repeat(121));
    await USER.click(screen.getByTestId("new-project-create"));

    expect(
      await screen.findByText("Project names are at most 120 characters."),
    ).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates with one idempotency key and navigates to the new project's hub", async () => {
    const create = vi
      .fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>()
      .mockResolvedValue(PROJECT);
    const { onOpenChange } = renderDialog(create);

    await USER.type(screen.getByLabelText(/^Project name/), "Launch film");
    await USER.click(screen.getByTestId("new-project-create"));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/w/launch-film"));
    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0] as [CreateProjectRequest, CallOptions | undefined];
    expect(body).toEqual({ name: "Launch film" });
    expect(options?.idempotencyKey).toMatch(/^.{8,128}$/);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces the typed 429 quota failure inline; a retry uses a FRESH key", async () => {
    const create = vi
      .fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>()
      .mockRejectedValueOnce(
        apiError({
          status: 429,
          code: "QUOTA_EXCEEDED",
          message: "Your plan is at its project limit.",
          hint: "Upgrade, or archive a project first.",
          requestId: "req_quota_1",
        }),
      )
      .mockResolvedValueOnce(PROJECT);
    renderDialog(create);

    await USER.type(screen.getByLabelText(/^Project name/), "Launch film");
    await USER.click(screen.getByTestId("new-project-create"));

    // §7.3 surface: message + hint + request id, inline (never a toast).
    expect(await screen.findByTestId("new-project-error")).toBeInTheDocument();
    expect(screen.getByText("Your plan is at its project limit.")).toBeInTheDocument();
    expect(screen.getByText("Upgrade, or archive a project first.")).toBeInTheDocument();
    expect(screen.getByText("Request req_quota_1")).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
    // The submit control recovers, so the same dialog can be retried.
    expect(screen.getByTestId("new-project-create")).toBeEnabled();

    await USER.click(screen.getByTestId("new-project-create"));
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/w/launch-film"));
    expect(create).toHaveBeenCalledTimes(2);
    const firstKey = (create.mock.calls[0]?.[1] as CallOptions).idempotencyKey;
    const secondKey = (create.mock.calls[1]?.[1] as CallOptions).idempotencyKey;
    // Law #4: a retry after a FAILED attempt is a NEW attempt — fresh key.
    expect(secondKey).not.toBe(firstKey);
  });

  it("surfaces an untyped failure with the bounded generic copy", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network went away"));
    renderDialog(create);

    await USER.type(screen.getByLabelText(/^Project name/), "Launch film");
    await USER.click(screen.getByTestId("new-project-create"));

    expect(await screen.findByText("The project could not be created.")).toBeInTheDocument();
    expect(screen.getByText("Try again in a moment.")).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("resets its transient state when reopened", async () => {
    const create = vi.fn().mockResolvedValue(PROJECT);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <NewProjectDialog open onOpenChange={onOpenChange} createProject={create} />,
    );

    await USER.type(screen.getByLabelText(/^Project name/), "Launch film");
    // Close (a failure-free close, e.g. Cancel/Esc) then reopen.
    rerender(<NewProjectDialog open={false} onOpenChange={onOpenChange} createProject={create} />);
    rerender(<NewProjectDialog open onOpenChange={onOpenChange} createProject={create} />);

    const input = screen.getByLabelText(/^Project name/) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.queryByTestId("new-project-error")).not.toBeInTheDocument();
  });
});
