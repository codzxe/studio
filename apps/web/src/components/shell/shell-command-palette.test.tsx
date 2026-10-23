/**
 * ShellCommandPalette tests (W2-01, §7.10 + D-5) — the shell's ⌘K surface:
 * the four groups in the fixed order, the Projects group loaded from
 * `projects.list` on OPEN (and degraded to empty on failure), Enter running
 * the active item (navigation) and Esc closing — mirroring the ui package's
 * own palette tests. next/navigation is mocked; the port is faked.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShellCommandPalette } from "./shell-command-palette";
import type { ShellPort } from "./top-bar";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/w",
  useSearchParams: () => new URLSearchParams(),
}));

const PROJECTS_PAGE = {
  items: [
    {
      id: "proj_1",
      workspaceId: "ws_first",
      name: "Launch film",
      slug: "launch-film",
      thumbnailUrl: null,
      archived: false,
      currentVersionId: null,
      createdBy: "user_1",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      deletedAt: null,
    },
    {
      id: "proj_2",
      workspaceId: "ws_first",
      name: "Title sequence",
      slug: "title-sequence",
      thumbnailUrl: null,
      archived: false,
      currentVersionId: null,
      createdBy: "user_1",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      deletedAt: null,
    },
  ],
  nextCursor: null,
};

function fakePort(listMock?: ReturnType<typeof vi.fn>): ShellPort {
  return {
    members: { switchWorkspace: vi.fn() },
    billing: { state: vi.fn() },
    projects: { list: listMock ?? vi.fn().mockResolvedValue(PROJECTS_PAGE) },
  };
}

function renderPalette(open = true, port?: ShellPort) {
  const onOpenChange = vi.fn();
  render(<ShellCommandPalette open={open} onOpenChange={onOpenChange} port={port ?? fakePort()} />);
  return { onOpenChange };
}

beforeEach(() => {
  routerPush.mockClear();
});

describe("ShellCommandPalette (§7.10)", () => {
  it("loads projects on open and renders all four groups in the fixed order", async () => {
    const listMock = vi.fn().mockResolvedValue(PROJECTS_PAGE);
    renderPalette(true, fakePort(listMock));

    expect(await screen.findByText("Launch film")).toBeInTheDocument();
    expect(screen.getByText("Title sequence")).toBeInTheDocument();
    // §7.10 fixed group order: Projects, Actions, Navigation, Help.
    const labels = ["Projects", "Actions", "Navigation", "Help"].map(
      (label) => screen.getByText(label).textContent,
    );
    expect(labels).toEqual(["Projects", "Actions", "Navigation", "Help"]);
    expect(listMock).toHaveBeenCalledWith({ limit: 10 });
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("carries the shell actions and navigation destinations", async () => {
    renderPalette();
    expect(await screen.findByText("New project")).toBeInTheDocument();
    expect(screen.getByText("Buy credits")).toBeInTheDocument();
    expect(screen.getByText("Go to dashboard")).toBeInTheDocument();
    expect(screen.getByText("Go to projects")).toBeInTheDocument();
    expect(screen.getByText("Go to billing")).toBeInTheDocument();
    expect(screen.getByText("Go to settings")).toBeInTheDocument();
    expect(screen.getByText("Service status")).toBeInTheDocument();
  });

  it("Enter runs the active project → its hub route, and closes", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPalette();
    const input = await screen.findByTestId("command-input");
    await user.click(input);
    await user.keyboard("{Enter}");
    expect(routerPush).toHaveBeenCalledWith("/w/launch-film/history");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Escape closes without running anything", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPalette();
    const input = await screen.findByTestId("command-input");
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("degrades the Projects group to empty when the read fails (search still works)", async () => {
    const listMock = vi.fn().mockRejectedValue(new Error("gateway down"));
    renderPalette(true, fakePort(listMock));

    // Groups render without projects; typing filters down to nothing honest.
    expect(await screen.findByText("New project")).toBeInTheDocument();
    expect(screen.queryByText("Launch film")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("command-input"), "zzz");
    expect(screen.getByText("No results.")).toBeInTheDocument();
  });

  it("is hidden when closed", () => {
    renderPalette(false);
    expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();
  });
});
