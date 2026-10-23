/**
 * DashboardView tests (W2-03, §8.4) — the /w client surface: the
 * time-aware greeting (deterministic from the RSC-stamped nowIso), the
 * actions row (ONE "New project" primary in every state), the Recent grid
 * (≤8 ProjectCards, 40ms stagger, honest "— · 0 comps" stand-ins), the
 * EmptyState arms (incl. the no-workspace /onboarding link), the loading
 * skeletons (6, only while a read is actually in flight) and the §8.4 error
 * law (inline banner + retry, the page stays usable). The api port is
 * faked; next/navigation is mocked.
 */

import type { Page, Project } from "@studio/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DashboardPort,
  DashboardView,
  type DashboardViewProps,
  greetingForHour,
  greetingLine,
  toDashboardProjects,
} from "./dashboard-view";

const routerPush = vi.fn();
const routerRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh, replace: vi.fn() }),
  usePathname: () => "/w",
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// Fixtures (the real §7.2 wire shapes)
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-10-21T12:00:00Z"; // UTC hour 12 → "Good afternoon"
const EVENING_ISO = "2026-10-21T20:30:00Z"; // UTC hour 20 → "Good evening"

function wireProject(index: number): Project {
  return {
    id: `prj_${index}`,
    workspaceId: "ws_first",
    name: `Film ${index}`,
    slug: `film-${index}`,
    thumbnailUrl: null,
    archived: false,
    currentVersionId: index % 2 === 0 ? `ver_${index}` : null,
    createdBy: "user_1",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
    deletedAt: null,
  };
}

function projectsPage(count: number): Page<Project> {
  return {
    items: Array.from({ length: count }, (_, index) => wireProject(index)),
    nextCursor: null,
  };
}

function makePort(list?: (query?: { limit?: number }) => Promise<Page<Project>>): DashboardPort {
  return {
    projects: {
      list: list ?? vi.fn().mockResolvedValue(projectsPage(3)),
      create: vi.fn(),
    },
    versions: { upload: vi.fn() },
  };
}

function baseProps(overrides: Partial<DashboardViewProps> = {}): DashboardViewProps {
  return {
    workspaceId: "ws_first",
    userName: "Alex",
    nowIso: NOW_ISO,
    initialProjects: toDashboardProjects(projectsPage(3)),
    initialError: null,
    ...overrides,
  };
}

beforeEach(() => {
  routerPush.mockClear();
  routerRefresh.mockClear();
});

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

describe("greeting (§8.4 time-aware, not cute)", () => {
  it("buckets the hour into morning/afternoon/evening", () => {
    expect(greetingForHour(0)).toBe("Good morning");
    expect(greetingForHour(9)).toBe("Good morning");
    expect(greetingForHour(12)).toBe("Good afternoon");
    expect(greetingForHour(17)).toBe("Good afternoon");
    expect(greetingForHour(18)).toBe("Good evening");
    expect(greetingForHour(23)).toBe("Good evening");
  });

  it("greets by name when there is one, and stands alone when there is not", () => {
    expect(greetingLine("Alex", EVENING_ISO)).toBe("Good evening, Alex");
    expect(greetingLine(null, EVENING_ISO)).toBe("Good evening.");
    expect(greetingLine("   ", EVENING_ISO)).toBe("Good evening.");
  });

  it("degrades a hostile nowIso to the neutral greeting (never a crash)", () => {
    expect(greetingLine("Alex", "not-a-date")).toBe("Welcome, Alex");
    expect(greetingLine(null, "")).toBe("Welcome.");
  });
});

describe("toDashboardProjects (wire → rows)", () => {
  it("keeps well-formed rows and drops malformed ones (law #1)", () => {
    const page = {
      items: [
        wireProject(0),
        { id: "prj_bad", name: 7, slug: "bad", updatedAt: "2026-10-21T10:00:00Z" },
        null,
      ],
      nextCursor: null,
    } as unknown as Page<Project>;
    const rows = toDashboardProjects(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "prj_0", name: "Film 0", slug: "film-0" });
  });
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

describe("DashboardView", () => {
  it("renders the greeting, the actions row and the recent grid", () => {
    render(<DashboardView {...baseProps()} api={makePort()} />);

    expect(screen.getByTestId("dashboard-greeting")).toHaveTextContent("Good afternoon, Alex");
    expect(screen.getByTestId("dashboard-new-project")).toHaveTextContent("New project");
    expect(screen.getByTestId("dashboard-import")).toHaveTextContent("Import .ecproj");

    const cards = screen.getAllByTestId("dashboard-project-card");
    expect(cards).toHaveLength(3);
    // Honest metadata stand-ins (§7.3): the wire's Project row carries
    // neither duration nor composition counts in v1.
    expect(within(cards[0] as HTMLElement).getByText("— · 0 comps")).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText("Updated 2h ago")).toBeInTheDocument();
  });

  it("caps the recent grid at 8 cards with the §6.3 40ms stagger", () => {
    render(
      <DashboardView
        {...baseProps({ initialProjects: toDashboardProjects(projectsPage(10)) })}
        api={makePort()}
      />,
    );

    const cards = screen.getAllByTestId("dashboard-project-card");
    expect(cards).toHaveLength(8);
    const delays = cards.map(
      (card) => card.querySelector<HTMLElement>(".animate-slate-in")?.style.animationDelay ?? "",
    );
    // index 0 → no delay (0ms is the no-stagger default in the kit card).
    expect(delays).toEqual(["", "40ms", "80ms", "120ms", "160ms", "200ms", "240ms", "280ms"]);
  });

  it("hover reveals the card actions; Open navigates to the project hub", async () => {
    const user = userEvent.setup();
    render(<DashboardView {...baseProps()} api={makePort()} />);

    const card = screen.getAllByTestId("dashboard-project-card")[0] as HTMLElement;
    await user.hover(card);
    // §8.4 hover actions: Open (wired below), Duplicate + ⋯ are the
    // projects-list surface (W2-04) — rendered by the kit card, unbound here.
    expect(within(card).getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Duplicate" })).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: "More actions for Film 0" }),
    ).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Open" }));
    expect(routerPush).toHaveBeenCalledWith("/w/film-0/history");
  });

  it("renders the EmptyState with both actions — and exactly ONE 'New project' button", () => {
    render(<DashboardView {...baseProps({ initialProjects: [] })} api={makePort()} />);

    expect(screen.getByTestId("dashboard-empty")).toHaveTextContent("No projects yet.");
    expect(screen.getByTestId("dashboard-empty-new-project")).toHaveTextContent("New project");
    expect(screen.getByTestId("dashboard-empty-import")).toHaveTextContent("Import .ecproj");
    // §7.1 one primary per view: the header actions row hides while the
    // EmptyState owns the actions.
    expect(screen.queryByTestId("dashboard-actions")).not.toBeInTheDocument();
  });

  it("adds the /onboarding link when there is no workspace context (embedded arm)", () => {
    render(
      <DashboardView
        {...baseProps({ initialProjects: [] })}
        hasWorkspace={false}
        api={makePort()}
      />,
    );

    const link = screen.getByRole("link", { name: "Create a workspace" });
    expect(link).toHaveAttribute("href", "/onboarding");
  });

  it("opens the New project dialog from the empty state", async () => {
    const user = userEvent.setup();
    render(<DashboardView {...baseProps({ initialProjects: [] })} api={makePort()} />);

    await user.click(screen.getByTestId("dashboard-empty-new-project"));
    expect(screen.getByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("opens the Import .ecproj dialog from the actions row", async () => {
    const user = userEvent.setup();
    render(<DashboardView {...baseProps()} api={makePort()} />);

    await user.click(screen.getByTestId("dashboard-import"));
    expect(screen.getByRole("dialog", { name: "Import .ecproj" })).toBeInTheDocument();
  });

  it("renders the §8.4 error state: inline banner + retry, the page stays usable", () => {
    render(
      <DashboardView
        {...baseProps({ initialProjects: null })}
        initialError={{
          message: "Something went wrong on our side.",
          hint: "Try again in a moment.",
          requestId: "req_dash_1",
        }}
        api={makePort()}
      />,
    );

    // The banner carries the §7.3 surface: message + hint + request id.
    expect(screen.getByTestId("dashboard-error")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong on our side.")).toBeInTheDocument();
    expect(screen.getByText("Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByText("Request req_dash_1")).toBeInTheDocument();
    // The rest of the page stays usable (§8.4) — no skeletons under a hard
    // error (the rows are unknown, not loading), no empty state either.
    expect(screen.getByTestId("dashboard-retry")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-new-project")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-skeleton-grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-grid")).not.toBeInTheDocument();
  });

  it("retries through the port: 6 skeletons while in flight, then the grid", async () => {
    const user = userEvent.setup();
    let resolveList: ((page: Page<Project>) => void) | undefined;
    const list = vi.fn<(query?: { limit?: number }) => Promise<Page<Project>>>().mockImplementation(
      () =>
        new Promise<Page<Project>>((resolve) => {
          resolveList = resolve;
        }),
    );
    render(
      <DashboardView
        {...baseProps({ initialProjects: null })}
        initialError={{ message: "Something went wrong on our side." }}
        api={makePort(list)}
      />,
    );

    await user.click(screen.getByTestId("dashboard-retry"));
    expect(list).toHaveBeenCalledWith({ limit: 12 });
    // §8.4 loading: 6 skeleton cards, not a spinner.
    expect(screen.getAllByTestId("dashboard-skeleton-card")).toHaveLength(6);

    resolveList?.(projectsPage(2));
    expect(await screen.findByTestId("dashboard-grid")).toBeInTheDocument();
    expect(screen.getAllByTestId("dashboard-project-card")).toHaveLength(2);
    expect(screen.queryByTestId("dashboard-error")).not.toBeInTheDocument();
  });

  it("keeps a previously loaded grid visible under a failed retry, and the banner returns", async () => {
    const user = userEvent.setup();
    const list = vi
      .fn<(query?: { limit?: number }) => Promise<Page<Project>>>()
      .mockResolvedValue(projectsPage(1));
    render(
      <DashboardView
        {...baseProps()}
        initialError={{ message: "First read failed." }}
        api={makePort(list)}
      />,
    );
    // initialProjects loaded (stale) + initialError banner both visible.
    expect(screen.getAllByTestId("dashboard-project-card")).toHaveLength(3);
    expect(screen.getByTestId("dashboard-error")).toBeInTheDocument();

    list.mockRejectedValueOnce(
      Object.assign(new Error("Still down."), {
        code: "INTERNAL_ERROR",
        requestId: "req_dash_2",
      }),
    );
    await user.click(screen.getByTestId("dashboard-retry"));
    await waitFor(() => expect(screen.getByTestId("dashboard-error")).toBeInTheDocument());
    expect(screen.getByText("Still down.")).toBeInTheDocument();
    // The stale rows stay usable under the banner (§8.4).
    expect(screen.getAllByTestId("dashboard-project-card")).toHaveLength(3);
  });

  it("shows the 6-skeleton loading state for a null payload without an error (defensive arm)", () => {
    render(
      <DashboardView
        {...baseProps({ initialProjects: null })}
        initialError={null}
        api={makePort()}
      />,
    );

    expect(screen.getAllByTestId("dashboard-skeleton-card")).toHaveLength(6);
    expect(screen.queryByTestId("dashboard-grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-empty")).not.toBeInTheDocument();
  });

  it("renders tokens-only style (no raw hex, law #8)", () => {
    const { container } = render(<DashboardView {...baseProps()} api={makePort()} />);
    const hex = /#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/i;
    for (const element of container.querySelectorAll<HTMLElement>("*")) {
      const style = element.getAttribute("style");
      expect(style === null || !hex.test(style)).toBe(true);
      const className = element.getAttribute("class");
      expect(className === null || !hex.test(className)).toBe(true);
    }
  });
});
