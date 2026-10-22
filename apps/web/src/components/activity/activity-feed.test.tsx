/**
 * ActivityFeed tests (M7-H) — copy tables (actor + action + target read as
 * one sentence; unknown actions stay DATA), §14 time-ago math (deterministic
 * against a pinned `nowIso`), §8.6 day grouping, cursor pagination
 * (replay-safe, race-guarded), empty/error states, and hostile-string
 * bounds. Deterministic RTL; no network.
 */

import { ApiError } from "@studio/api-client";
import type { ActivityEntry, Page } from "@studio/contracts";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ActivityFeed,
  activityRowCopy,
  activityTargetSummary,
  actorDisplayName,
  formatDayLabel,
  formatTimeAgo,
  useActivityPages,
} from "./activity-feed";
import type { ActivityPageFetcher } from "./activity-feed";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "aud_0001",
    projectId: "prj_demo",
    actorId: "usr_alex",
    actorName: "Alex",
    action: "version.uploaded",
    targetType: "version",
    targetId: "ver_0001",
    createdAt: "2026-10-21T14:32:05.000Z",
    ...overrides,
  };
}

function pageOf(
  items: readonly ActivityEntry[],
  nextCursor: string | null = null,
): Page<ActivityEntry> {
  return { items, nextCursor };
}

const NOW = "2026-10-21T16:00:00.000Z";
const USER = userEvent.setup();

// ---------------------------------------------------------------------------
// Copy tables
// ---------------------------------------------------------------------------

describe("feed copy", () => {
  it("renders actor + action + target as one sentence for every known action", () => {
    const pinned: ReadonlyArray<[string, string, string]> = [
      ["version.uploaded", "saved", "a version"],
      ["version.restored", "restored", "an earlier version"],
      ["version.labeled", "renamed", "a version"],
      ["project.created", "created", "the project"],
      ["project.deleted", "deleted", "the project"],
      ["run.started", "started", "an agent run"],
      ["run.applied", "applied", "an agent edit"],
      ["comment.created", "left", "a comment"],
      ["comment.resolved", "resolved", "a comment"],
      ["lease.acquired", "started editing", "the project"],
      ["member.joined", "joined", "the workspace"],
    ];
    for (const [action, verb, target] of pinned) {
      expect(activityRowCopy(action, "version")).toEqual({ verb, target });
    }
  });

  it("keeps unknown wire actions as bounded data — never a broken row", () => {
    const copy = activityRowCopy("weird.future.action", "version");
    expect(copy.verb).toBe("did");
    expect(copy.target).toBe("“weird.future.action”");
    const hostile = activityRowCopy("x".repeat(10_000), null);
    expect(hostile.target.length).toBeLessThanOrEqual(26);
  });

  it("derives neutral target summaries per targetType", () => {
    expect(activityTargetSummary("version")).toBe("a version");
    expect(activityTargetSummary("comment")).toBe("a comment");
    expect(activityTargetSummary("run")).toBe("an agent run");
    expect(activityTargetSummary("project")).toBe("the project");
    expect(activityTargetSummary(null)).toBe("this project");
    expect(activityTargetSummary("?????")).toBe("this project");
  });

  it("names nameless actors safely", () => {
    expect(actorDisplayName("Alex")).toBe("Alex");
    expect(actorDisplayName(null)).toBe("A member");
    expect(actorDisplayName("   ")).toBe("A member");
    expect(actorDisplayName("x".repeat(10_000)).length).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------
// Time formatting (§14, deterministic)
// ---------------------------------------------------------------------------

describe("time formatting", () => {
  it("formats relative times against the pinned now", () => {
    expect(formatTimeAgo("2026-10-21T15:59:40.000Z", NOW)).toBe("just now");
    expect(formatTimeAgo("2026-10-21T15:57:00.000Z", NOW)).toBe("3m ago");
    expect(formatTimeAgo("2026-10-21T14:00:00.000Z", NOW)).toBe("2h ago");
    expect(formatTimeAgo("2026-10-18T16:00:00.000Z", NOW)).toBe("3d ago");
    expect(formatTimeAgo("2026-10-04T16:00:00.000Z", NOW)).toBe("Oct 4, 2026");
    // Clock-skewed futures read "just now", never a negative ago.
    expect(formatTimeAgo("2026-10-21T17:00:00.000Z", NOW)).toBe("just now");
  });

  it("degrades hostile timestamps", () => {
    expect(formatTimeAgo("not-a-date", NOW)).toBe("—");
    expect(formatTimeAgo("", NOW)).toBe("—");
    expect(formatTimeAgo("2026-10-21T14:32:05.000Z", "garbage")).toBe("—");
    expect(formatDayLabel("nope")).toBe("—");
  });

  it("formats day labels per §14 (UTC)", () => {
    expect(formatDayLabel("2026-10-21T14:32:05.000Z")).toBe("Oct 21, 2026");
    expect(formatDayLabel("2026-01-01T00:00:01.000Z")).toBe("Jan 1, 2026");
  });
});

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

describe("ActivityFeed", () => {
  it("renders rows grouped by day, newest first, with actor, action, target and time-ago", async () => {
    const fetchPage: ActivityPageFetcher = vi.fn(async () =>
      pageOf([
        entry({ id: "aud_2", action: "version.restored", createdAt: "2026-10-21T15:00:00.000Z" }),
        entry({ id: "aud_1", action: "version.uploaded", createdAt: "2026-10-21T14:32:05.000Z" }),
        entry({ id: "aud_0", action: "comment.created", createdAt: "2026-10-19T09:00:00.000Z" }),
      ]),
    );
    render(<ActivityFeed fetchPage={fetchPage} nowIso={NOW} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row")).toHaveLength(3);
    });
    const days = screen.getAllByTestId("activity-day");
    expect(days).toHaveLength(2);
    expect(days[0]).toHaveTextContent("Oct 21, 2026");
    expect(days[1]).toHaveTextContent("Oct 19, 2026");

    const [latestRow, savedRow, oldRow] = screen.getAllByTestId("activity-row") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(latestRow).toHaveAttribute("data-action", "version.restored");
    expect(latestRow.querySelector('[data-testid="activity-actor"]')).toHaveTextContent("Alex");
    expect(latestRow.querySelector('[data-testid="activity-verb"]')).toHaveTextContent("restored");
    expect(latestRow.querySelector('[data-testid="activity-target"]')).toHaveTextContent(
      "an earlier version",
    );
    expect(latestRow.querySelector('[data-testid="activity-time"]')).toHaveTextContent("1h ago");
    // Tooltip + datetime expose the absolute time (§12: never relative-only).
    expect(latestRow.querySelector('[data-testid="activity-time"]')).toHaveAttribute(
      "title",
      "Oct 21, 2026",
    );
    expect(savedRow).toHaveAttribute("data-action", "version.uploaded");
    expect(oldRow).toHaveAttribute("data-action", "comment.created");
  });

  it("bounds hostile actor names, actions and timestamps instead of dumping them", async () => {
    const hostile = "x".repeat(10_000);
    const fetchPage: ActivityPageFetcher = vi.fn(async () =>
      pageOf([
        entry({
          actorName: hostile,
          action: hostile,
          targetType: null,
          createdAt: "not-a-date",
        }),
      ]),
    );
    render(<ActivityFeed fetchPage={fetchPage} nowIso={NOW} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row")).toHaveLength(1);
    });
    const [row] = screen.getAllByTestId("activity-row") as [HTMLElement];
    expect(
      row.querySelector('[data-testid="activity-actor"]')?.textContent?.length,
    ).toBeLessThanOrEqual(60);
    expect(
      row.querySelector('[data-testid="activity-target"]')?.textContent?.length,
    ).toBeLessThanOrEqual(26);
    expect(row.querySelector('[data-testid="activity-time"]')).toHaveTextContent("—");
    // Hostile timestamps never leak into the dateTime attribute.
    expect(row.querySelector('[data-testid="activity-time"]')).not.toHaveAttribute("datetime");
  });

  it("paginates with the cursor: appends the next page, then the end note", async () => {
    let calls = 0;
    const fetchPage: ActivityPageFetcher = vi.fn(async (query) => {
      calls += 1;
      if (calls === 1) return pageOf([entry({ id: "aud_1" })], "cursor-2");
      expect(query.cursor).toBe("cursor-2");
      return pageOf([entry({ id: "aud_2", action: "comment.replied" })]);
    });
    render(<ActivityFeed fetchPage={fetchPage} nowIso={NOW} />);
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledWith({ limit: 25 });
    });
    await USER.click(screen.getByTestId("activity-load-more"));
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
    });
    expect(screen.queryByTestId("activity-load-more")).toBeNull();
    expect(screen.getByTestId("activity-end")).toHaveTextContent("That’s the whole feed.");
  });

  it("renders the empty state for a project with no audit rows", async () => {
    const fetchPage: ActivityPageFetcher = vi.fn(async () => pageOf([]));
    render(<ActivityFeed fetchPage={fetchPage} nowIso={NOW} />);
    await waitFor(() => {
      expect(screen.getByTestId("activity-empty")).toHaveTextContent("No activity yet.");
    });
  });

  it("surfaces typed fetch failures with a retry that refires", async () => {
    let calls = 0;
    const fetchPage: ActivityPageFetcher = vi.fn(async (): Promise<Page<ActivityEntry>> => {
      calls += 1;
      if (calls === 1) {
        throw new ApiError({
          code: "INTERNAL_ERROR",
          message: "The feed exploded.",
          status: 500,
          requestId: "req_feed_01",
        });
      }
      return pageOf([entry()]);
    });
    render(<ActivityFeed fetchPage={fetchPage} nowIso={NOW} />);
    await waitFor(() => {
      expect(screen.getByTestId("activity-error")).toHaveTextContent("The feed exploded.");
    });
    await USER.click(screen.getByTestId("activity-error-retry"));
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row")).toHaveLength(1);
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// useActivityPages hook — race guard + replay safety
// ---------------------------------------------------------------------------

describe("useActivityPages hook", () => {
  it("drops stale responses (reload wins over an in-flight load-more)", async () => {
    let resolveSecond: ((page: Page<ActivityEntry>) => void) | null = null;
    let calls = 0;
    const fetchPage: ActivityPageFetcher = vi.fn(async (): Promise<Page<ActivityEntry>> => {
      calls += 1;
      if (calls === 1) return pageOf([entry()], "cursor-2");
      if (calls === 2) {
        return new Promise((resolve) => {
          resolveSecond = resolve;
        });
      }
      return pageOf([entry({ id: "aud_fresh" })]);
    });
    const { result } = renderHook(() => useActivityPages(fetchPage));
    await waitFor(() => {
      expect(result.current.nextCursor).toBe("cursor-2");
    });

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(result.current.entries.some((e) => e.id === "aud_fresh")).toBe(true);
    });

    await act(async () => {
      resolveSecond?.(pageOf([entry({ id: "aud_stale" })]));
    });
    expect(result.current.entries.some((e) => e.id === "aud_stale")).toBe(false);
  });

  it("no-ops a load-more while one is already in flight (same tick)", async () => {
    let calls = 0;
    const fetchPage: ActivityPageFetcher = vi.fn(async (): Promise<Page<ActivityEntry>> => {
      calls += 1;
      if (calls === 1) return pageOf([entry()], "cursor-2");
      return pageOf([entry({ id: "aud_2" })]);
    });
    const { result } = renderHook(() => useActivityPages(fetchPage));
    await waitFor(() => {
      expect(result.current.nextCursor).toBe("cursor-2");
    });
    result.current.loadMore();
    result.current.loadMore();
    await waitFor(() => {
      expect(result.current.nextCursor).toBeNull();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
