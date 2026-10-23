/**
 * ProjectsListView tests (W2-04, §8.5) — the /w/projects browser wiring:
 * grid/table toggle with `?view=` URL state, the four filters (Archived via
 * the port's `archived:true` page; Mine/Shared client-side by createdBy),
 * the three client-side sorts, the debounced search over the LOADED window
 * (`?q=`, "Search loaded projects"), the bulk arms (archive/restore via
 * patch, duplicate incl. the typed 429 QUOTA_EXCEEDED surface, delete via
 * the danger ConfirmDialog with type-to-confirm), "Load more" cursors, the
 * empty-search state + clear filters, and the per-row → /w/[slug]/history
 * link. next/navigation is mocked (hoisted, the app-shell test pattern);
 * the port is faked (the fakePort house pattern — no network).
 */

import { ApiError } from "@studio/api-client";
import type { PatchProjectRequest } from "@studio/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ProjectsListPort,
  ProjectsListView,
  type ProjectsListViewProps,
} from "./projects-list-view";
import type { ProjectsListRow } from "./projects-wire";

// ---------------------------------------------------------------------------
// next/navigation mock (URL state round-trips through replace)
// ---------------------------------------------------------------------------

const { replaceMock, pushMock, searchParams, pathname } = vi.hoisted(() => {
  const state = {
    replaceMock: vi.fn((url: string) => {
      // Mirror the router: the next render's useSearchParams sees the new URL.
      const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      state.searchParams.current = new URLSearchParams(qs);
    }),
    pushMock: vi.fn(),
    searchParams: { current: new URLSearchParams() },
    pathname: { current: "/w/projects" },
  };
  return state;
});

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: vi.fn() }),
  useSearchParams: () => searchParams.current,
}));

// ---------------------------------------------------------------------------
// Fixtures (the real §7.2 wire shapes)
// ---------------------------------------------------------------------------

const NOW = "2026-10-21T12:00:00Z";
const ME = "user_me";
const OTHER = "user_other";

function row(overrides: Partial<ProjectsListRow> = {}): ProjectsListRow {
  return {
    id: "prj_alpha",
    workspaceId: "ws_first",
    name: "Launch film",
    slug: "launch-film",
    thumbnailUrl: null,
    archived: false,
    currentVersionId: null,
    createdBy: ME,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-20T09:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}

const ALPHA = row();
const BETA = row({
  id: "prj_beta",
  name: "Teaser cut",
  slug: "teaser-cut",
  createdBy: OTHER,
  createdAt: "2026-10-21T08:00:00Z",
  updatedAt: "2026-10-21T09:00:00Z",
});
const GAMMA = row({
  id: "prj_gamma",
  name: "Website loop",
  slug: "website-loop",
  createdAt: "2026-10-19T09:00:00Z",
  updatedAt: "2026-10-18T09:00:00Z",
});
const DELTA = row({
  id: "prj_delta",
  name: "Sizzle reel",
  slug: "sizzle-reel",
  createdBy: OTHER,
  createdAt: "2026-10-02T09:00:00Z",
  updatedAt: "2026-10-01T09:00:00Z",
});
const EPSILON = row({
  id: "prj_eps",
  name: "Aardvark intro",
  slug: "aardvark-intro",
  createdAt: "2026-10-10T09:00:00Z",
  updatedAt: "2026-10-10T10:00:00Z",
});

const ACTIVE_PAGE_ONE = [ALPHA, BETA, GAMMA, DELTA, EPSILON];

const ARCHIVED_ONE = row({
  id: "prj_old",
  name: "Old campaign",
  slug: "old-campaign",
  archived: true,
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-30T09:00:00Z",
});

// ---------------------------------------------------------------------------
// The faked port
// ---------------------------------------------------------------------------

function makePort(
  overrides: {
    list?: ReturnType<typeof vi.fn>;
    patch?: ReturnType<typeof vi.fn>;
    delete?: ReturnType<typeof vi.fn>;
    duplicate?: ReturnType<typeof vi.fn>;
  } = {},
): ProjectsListPort & {
  list: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  duplicate: ReturnType<typeof vi.fn>;
} {
  const byId = new Map<string, ProjectsListRow>(
    [...ACTIVE_PAGE_ONE, ARCHIVED_ONE].map((item) => [item.id, item]),
  );
  return {
    list:
      overrides.list ??
      vi.fn(async (query: { archived?: boolean } = {}) => ({
        ok: true,
        items: query.archived === true ? [ARCHIVED_ONE] : ACTIVE_PAGE_ONE,
        nextCursor: null,
      })),
    patch:
      overrides.patch ??
      vi.fn(async (id: string, body: PatchProjectRequest) => ({
        ...(byId.get(id) ?? row({ id })),
        archived: body.archived ?? false,
      })),
    delete: overrides.delete ?? vi.fn(async () => null),
    duplicate:
      overrides.duplicate ??
      vi.fn(async (id: string) => ({
        ...(byId.get(id) ?? row({ id })),
        id: `${id}_copy`,
        name: `${byId.get(id)?.name ?? "Project"} (copy)`,
        slug: `${byId.get(id)?.slug ?? "project"}-copy`,
        archived: false,
        updatedAt: NOW,
        createdAt: NOW,
      })),
  };
}

type ViewOverrides = Partial<Omit<ProjectsListViewProps, "api" | "initialItems">>;

function view(
  port: ProjectsListPort,
  overrides: ViewOverrides & { initialItems?: readonly ProjectsListRow[] } = {},
): ReturnType<typeof render> {
  return render(
    <ProjectsListView
      workspaceId="ws_first"
      workspaceName="First Films"
      userId={ME}
      canEdit={true}
      initialItems={overrides.initialItems ?? ACTIVE_PAGE_ONE}
      initialNextCursor={overrides.initialNextCursor ?? null}
      nowIso={NOW}
      api={port}
      debounceMs={overrides.debounceMs}
      {...overrides}
    />,
  );
}

/** Grid card ids in DOM order. */
function cardIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="projects-card-"]')).map(
    (element) => element.dataset.testid?.replace("projects-card-", "") ?? "",
  );
}

async function selectInTable(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(screen.getByTestId(`projects-select-${id}`));
}

async function switchToTable(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("projects-view-table"));
}

async function chooseSort(
  user: ReturnType<typeof userEvent.setup>,
  presses: number,
): Promise<void> {
  const trigger = screen.getByRole("combobox", { name: "Sort" });
  trigger.focus();
  for (let i = 0; i < presses; i += 1) {
    await user.keyboard("{ArrowDown}");
  }
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  replaceMock.mockClear();
  pushMock.mockClear();
  searchParams.current = new URLSearchParams();
});

// ---------------------------------------------------------------------------
// View toggle + URL state (?view=)
// ---------------------------------------------------------------------------

describe("ProjectsListView — grid/table toggle (?view=)", () => {
  it("defaults to the grid and swaps to the table on toggle", async () => {
    const user = userEvent.setup();
    view(makePort());
    expect(screen.getByTestId("projects-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-table")).not.toBeInTheDocument();

    await switchToTable(user);
    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-grid")).not.toBeInTheDocument();
    expect(replaceMock).toHaveBeenLastCalledWith("/w/projects?view=table");

    await user.click(screen.getByTestId("projects-view-grid"));
    expect(screen.getByTestId("projects-grid")).toBeInTheDocument();
    expect(replaceMock).toHaveBeenLastCalledWith("/w/projects");
  });

  it("seeds the view mode, filter and query from the URL", async () => {
    searchParams.current = new URLSearchParams("view=table&filter=shared&q=cut");
    view(makePort(), { debounceMs: 0 });
    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
    const names = screen.getAllByRole("link").map((link) => link.textContent);
    expect(names).toEqual(["Teaser cut"]);
    expect(screen.getByDisplayValue("cut")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Filters (§8.5)
// ---------------------------------------------------------------------------

describe("ProjectsListView — filters", () => {
  it("All shows every loaded project", async () => {
    const user = userEvent.setup();
    view(makePort());
    await user.click(screen.getByTestId("projects-filter-all"));
    expect(cardIds()).toEqual(["prj_beta", "prj_alpha", "prj_gamma", "prj_eps", "prj_delta"]);
  });

  it("Mine keeps only createdBy === me.user.id (client-side)", async () => {
    const user = userEvent.setup();
    view(makePort());
    await user.click(screen.getByTestId("projects-filter-mine"));
    expect(cardIds()).toEqual(["prj_alpha", "prj_gamma", "prj_eps"]);
    expect(replaceMock).toHaveBeenLastCalledWith("/w/projects?filter=mine");
  });

  it("Shared keeps only other members' projects (client-side)", async () => {
    const user = userEvent.setup();
    view(makePort());
    await user.click(screen.getByTestId("projects-filter-shared"));
    expect(cardIds()).toEqual(["prj_beta", "prj_delta"]);
    expect(replaceMock).toHaveBeenLastCalledWith("/w/projects?filter=shared");
  });

  it("Archived switches to the archived-only window via the API param", async () => {
    const user = userEvent.setup();
    const port = makePort();
    view(port);
    await user.click(screen.getByTestId("projects-filter-archived"));
    await waitFor(() => {
      expect(cardIds()).toEqual(["prj_old"]);
    });
    expect(port.list).toHaveBeenCalledWith({ archived: true, limit: 50 });
    // The archived card carries the lifecycle badge.
    expect(screen.getByTestId("projects-card-prj_old")).toHaveTextContent("Archived");
  });
});

// ---------------------------------------------------------------------------
// Sorts (client-side — no wire sort param)
// ---------------------------------------------------------------------------

describe("ProjectsListView — sorts", () => {
  it("sorts by Name (ascending) through the Select", async () => {
    const user = userEvent.setup();
    view(makePort());
    await chooseSort(user, 3); // open → Updated → Created → Name
    expect(cardIds()).toEqual(["prj_eps", "prj_alpha", "prj_delta", "prj_beta", "prj_gamma"]);
  });

  it("sorts by Created (newest first)", async () => {
    const user = userEvent.setup();
    view(makePort());
    await chooseSort(user, 2); // open → Updated → Created
    expect(cardIds()).toEqual(["prj_beta", "prj_gamma", "prj_eps", "prj_delta", "prj_alpha"]);
  });

  it("defaults to Updated (newest first — matches the wire's keyset order)", () => {
    view(makePort());
    expect(cardIds()).toEqual(["prj_beta", "prj_alpha", "prj_gamma", "prj_eps", "prj_delta"]);
  });
});

// ---------------------------------------------------------------------------
// Debounced search (loaded window only — the honest label)
// ---------------------------------------------------------------------------

describe("ProjectsListView — debounced search", () => {
  it("commits after the debounce window and writes ?q=", async () => {
    vi.useFakeTimers();
    try {
      view(makePort()); // default 250ms debounce
      const input = screen.getByLabelText("Search loaded projects");
      fireEvent.change(input, { target: { value: "teaser" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(249);
      });
      expect(cardIds()).toHaveLength(5); // not committed yet
      expect(replaceMock).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(cardIds()).toEqual(["prj_beta"]);
      expect(replaceMock).toHaveBeenLastCalledWith("/w/projects?q=teaser");
    } finally {
      vi.useRealTimers();
    }
  });

  it("empty search: 'No projects match' + clear filters", async () => {
    const user = userEvent.setup();
    view(makePort(), { debounceMs: 0 });
    const input = screen.getByLabelText("Search loaded projects");
    await user.clear(input);
    await user.type(input, "zzz");
    await waitFor(() => {
      expect(screen.getByTestId("projects-empty-search")).toHaveTextContent(
        "No projects match 'zzz'.",
      );
    });
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(cardIds()).toHaveLength(5);
    });
    expect(screen.getByLabelText("Search loaded projects")).toHaveValue("");
  });

  it("shows the honest loaded-window label", () => {
    view(makePort());
    expect(screen.getByLabelText("Search loaded projects")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Load more (§8.5 — a button, no janky auto-load)
// ---------------------------------------------------------------------------

describe("ProjectsListView — load more", () => {
  it("appends the cursor page and retires the button at the end", async () => {
    const user = userEvent.setup();
    const port = makePort({
      list: vi.fn(async (query: { cursor?: string } = {}) => {
        if (query.cursor === "cur_2") {
          return {
            ok: true,
            items: [row({ id: "prj_page2", name: "Page two film", slug: "page-two-film" })],
            nextCursor: null,
          };
        }
        return { ok: true, items: ACTIVE_PAGE_ONE, nextCursor: "cur_2" };
      }),
    });
    view(port, { initialItems: ACTIVE_PAGE_ONE, initialNextCursor: "cur_2" });

    const more = screen.getByTestId("projects-load-more");
    await user.click(more);
    await waitFor(() => {
      expect(cardIds()).toContain("prj_page2");
    });
    expect(port.list).toHaveBeenCalledWith({ cursor: "cur_2", limit: 50 });
    await waitFor(() => {
      expect(screen.queryByTestId("projects-load-more")).not.toBeInTheDocument();
    });
  });

  it("surfaces a typed load-more failure without losing the loaded rows", async () => {
    const user = userEvent.setup();
    const port = makePort({
      list: vi.fn(async (query: { cursor?: string } = {}) => {
        if (query.cursor === undefined) {
          return { ok: true, items: ACTIVE_PAGE_ONE, nextCursor: "cur_2" };
        }
        return {
          ok: false,
          error: {
            message: "The projects list could not be loaded.",
            hint: "Try again in a moment.",
            requestId: "req_list_1",
          },
        };
      }),
    });
    view(port, { initialItems: ACTIVE_PAGE_ONE, initialNextCursor: "cur_2" });
    await user.click(screen.getByTestId("projects-load-more"));
    await waitFor(() => {
      expect(screen.getByTestId("projects-load-error")).toHaveTextContent(
        "The projects list could not be loaded. (req_list_1)",
      );
    });
    expect(cardIds()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Bulk actions (§8.5)
// ---------------------------------------------------------------------------

describe("ProjectsListView — bulk actions", () => {
  it("archives the selection via projects.patch and drops the rows", async () => {
    const user = userEvent.setup();
    const port = makePort();
    view(port);
    await switchToTable(user);
    await selectInTable(user, "prj_alpha");
    await selectInTable(user, "prj_beta");
    expect(screen.getByTestId("projects-bulk-count")).toHaveTextContent("2 projects selected");

    await user.click(screen.getByTestId("projects-bulk-archive"));
    await waitFor(() => {
      expect(screen.queryByTestId("projects-row-prj_alpha")).not.toBeInTheDocument();
      expect(screen.queryByTestId("projects-row-prj_beta")).not.toBeInTheDocument();
    });
    expect(port.patch).toHaveBeenCalledWith("prj_alpha", { archived: true });
    expect(port.patch).toHaveBeenCalledWith("prj_beta", { archived: true });
    expect(screen.getByTestId("projects-bulk-note")).toHaveTextContent("Archived 2 projects.");
  });

  it("restores from the archived window (patch archived:false)", async () => {
    const user = userEvent.setup();
    const port = makePort();
    view(port);
    await user.click(screen.getByTestId("projects-filter-archived"));
    await waitFor(() => {
      expect(screen.getByTestId("projects-select-prj_old")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("projects-select-prj_old"));
    expect(screen.getByTestId("projects-bulk-archive")).toHaveTextContent("Restore");
    await user.click(screen.getByTestId("projects-bulk-archive"));
    await waitFor(() => {
      expect(screen.queryByTestId("projects-card-prj_old")).not.toBeInTheDocument();
    });
    expect(port.patch).toHaveBeenCalledWith("prj_old", { archived: false });
    expect(screen.getByTestId("projects-bulk-note")).toHaveTextContent("Restored 1 project.");
  });

  it("duplicates the selection and surfaces the new rows", async () => {
    const user = userEvent.setup();
    const port = makePort();
    view(port);
    await switchToTable(user);
    await selectInTable(user, "prj_alpha");
    await user.click(screen.getByTestId("projects-bulk-duplicate"));
    await waitFor(() => {
      expect(screen.getByText("Launch film (copy)")).toBeInTheDocument();
    });
    expect(port.duplicate).toHaveBeenCalledWith("prj_alpha");
    expect(screen.getByTestId("projects-bulk-note")).toHaveTextContent("Duplicated 1 project.");
  });

  it("surfaces a typed 429 QUOTA_EXCEEDED from duplicate (§7.3 banner)", async () => {
    const user = userEvent.setup();
    const port = makePort({
      duplicate: vi.fn(async () => {
        throw new ApiError({
          code: "QUOTA_EXCEEDED",
          message: "This workspace is at its project limit.",
          hint: "Delete or archive a project first, or upgrade the plan.",
          status: 429,
          requestId: "req_quota_1",
        });
      }),
    });
    view(port);
    await switchToTable(user);
    await selectInTable(user, "prj_alpha");
    await user.click(screen.getByTestId("projects-bulk-duplicate"));
    await waitFor(() => {
      expect(screen.getByTestId("projects-bulk-error")).toHaveTextContent(
        "This workspace is at its project limit.",
      );
    });
    const banner = screen.getByTestId("projects-bulk-error");
    expect(banner).toHaveTextContent("Delete or archive a project first, or upgrade the plan.");
    expect(banner).toHaveTextContent("Request id req_quota_1");
    // Nothing was silently removed — the row stays.
    expect(screen.getByTestId("projects-row-prj_alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-bulk-note")).not.toBeInTheDocument();
  });

  it("deletes via the danger ConfirmDialog with type-to-confirm", async () => {
    const user = userEvent.setup();
    const port = makePort();
    view(port);
    await switchToTable(user);
    await selectInTable(user, "prj_gamma");
    await user.click(screen.getByTestId("projects-bulk-delete"));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete 1 project?")).toBeInTheDocument();
    const confirm = within(dialog).getByTestId("confirm-confirm");
    expect(confirm).toBeDisabled(); // §7.5 — typing the action name gates it

    await user.type(within(dialog).getByTestId("confirm-input"), "delete");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      expect(screen.queryByTestId("projects-row-prj_gamma")).not.toBeInTheDocument();
    });
    expect(port.delete).toHaveBeenCalledWith("prj_gamma");
    expect(screen.getByTestId("projects-bulk-note")).toHaveTextContent("Deleted 1 project.");
  });

  it("viewers can select but get no bulk mutation actions", async () => {
    const user = userEvent.setup();
    const port = makePort();
    view(port, { canEdit: false });
    await switchToTable(user);
    await selectInTable(user, "prj_alpha");
    expect(screen.getByTestId("projects-bulk-count")).toHaveTextContent("1 project selected");
    expect(screen.queryByTestId("projects-bulk-archive")).not.toBeInTheDocument();
    expect(screen.queryByTestId("projects-bulk-duplicate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("projects-bulk-delete")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Links + empty workspace
// ---------------------------------------------------------------------------

describe("ProjectsListView — links and empty states", () => {
  it("links every row to /w/[slug]/history (table)", async () => {
    const user = userEvent.setup();
    view(makePort());
    await switchToTable(user);
    expect(screen.getByRole("link", { name: "Launch film" })).toHaveAttribute(
      "href",
      "/w/launch-film/history",
    );
  });

  it("the card's Open action routes to the hub", async () => {
    const user = userEvent.setup();
    view(makePort());
    await user.click(screen.getAllByRole("button", { name: "Open" })[0] as HTMLElement);
    expect(pushMock).toHaveBeenCalledWith("/w/teaser-cut/history");
  });

  it("renders the honest empty state for a workspace with no projects", () => {
    view(makePort(), { initialItems: [], initialNextCursor: null });
    expect(screen.getByTestId("projects-empty-all")).toHaveTextContent("No projects yet.");
    expect(screen.getByRole("link", { name: "Back to workspace" })).toHaveAttribute("href", "/w");
  });
});

afterEach(() => {
  // The debounce test installs fake timers; a timeout inside its try block
  // would otherwise leak them into every later test.
  vi.useRealTimers();
  vi.clearAllMocks();
});
