/**
 * VersionTimeline tests (M7-H) — the §8.6/§M7-task-4 render matrix
 * (agent/human/current/labels/linkage), inline label editing (D-24: 1–120
 * chars, trimmed, typed errors), the §9.3 restore confirmation dialog
 * (exact-label gate, wrong label rejected client-side BEFORE the POST, §7.5
 * copy, typed LEASE_HELD errors), diff summaries, cursor pagination, empty
 * and error states, and hostile-string bounds. Deterministic RTL; no network.
 */

import { ApiError } from "@studio/api-client";
import type { Page, VersionDiffSummary, VersionTimelineEntry } from "@studio/contracts";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  VersionTimeline,
  formatCreatedGap,
  formatSizeDeltaBytes,
  formatTimelineTimestamp,
  formatVersionBytes,
  restoreConfirmPhrase,
  truncateTimelineString,
  useVersionPages,
} from "./version-timeline";
import type { VersionPageFetcher } from "./version-timeline";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function version(overrides: Partial<VersionTimelineEntry> = {}): VersionTimelineEntry {
  return {
    id: "ver_0001",
    projectId: "prj_demo",
    version: 1,
    parentVersionId: null,
    sha256: "a".repeat(64),
    sizeBytes: 2048,
    label: null,
    agentRunId: null,
    createdBy: "usr_alex",
    createdAt: "2026-10-21T14:32:05.000Z",
    createdByName: "Alex",
    isAgent: false,
    sha256Prefix: "aaaaaaaaaaaa",
    ...overrides,
  };
}

function pageOf(
  items: readonly VersionTimelineEntry[],
  nextCursor: string | null = null,
): Page<VersionTimelineEntry> {
  return { items, nextCursor };
}

const USER = userEvent.setup();

const leasedError = new ApiError({
  code: "LEASE_HELD",
  message: "Sam is editing this project right now.",
  hint: "Open the project read-only, or request edit access.",
  status: 409,
  requestId: "req_lease_01",
});

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

describe("display helpers", () => {
  it("formats §14 file sizes and degrades hostile numbers", () => {
    expect(formatVersionBytes(0)).toBe("0 B");
    expect(formatVersionBytes(512)).toBe("512 B");
    expect(formatVersionBytes(2048)).toBe("2 KB");
    expect(formatVersionBytes(12_884_901)).toBe("12.3 MB");
    expect(formatVersionBytes(20 * 1024 ** 3)).toBe("20 GB");
    expect(formatVersionBytes(1024 ** 4)).toBe("1 TB");
    expect(formatVersionBytes(-5)).toBe("—");
    expect(formatVersionBytes(Number.NaN)).toBe("—");
    expect(formatVersionBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats signed size deltas", () => {
    expect(formatSizeDeltaBytes(0)).toBe("no change");
    expect(formatSizeDeltaBytes(1234)).toBe("+1.2 KB");
    expect(formatSizeDeltaBytes(-240)).toBe("-240 B");
    expect(formatSizeDeltaBytes(Number.NaN)).toBe("—");
  });

  it("formats UTC timestamps deterministically; hostile ISO degrades", () => {
    expect(formatTimelineTimestamp("2026-10-21T14:32:05.000Z")).toBe("Oct 21, 2026, 14:32");
    expect(formatTimelineTimestamp("not-a-date")).toBe("—");
    expect(formatTimelineTimestamp("")).toBe("—");
  });

  it("formats parent-creation gaps", () => {
    expect(formatCreatedGap(30_000)).toBe("moments later");
    expect(formatCreatedGap(5 * 60_000)).toBe("5m later");
    expect(formatCreatedGap(3 * 3_600_000)).toBe("3h later");
    expect(formatCreatedGap(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m later");
    expect(formatCreatedGap(2 * 86_400_000)).toBe("2d later");
    expect(formatCreatedGap(10 * 86_400_000)).toBe("more than a week later");
    expect(formatCreatedGap(-1)).toBe("—");
  });

  it("derives the restore confirmation phrase from the version", () => {
    expect(restoreConfirmPhrase(version({ label: "Launch cut" }))).toBe("Launch cut");
    expect(restoreConfirmPhrase(version({ label: "  padded  " }))).toBe("padded");
    expect(restoreConfirmPhrase(version({ version: 7, label: null }))).toBe("v7");
    expect(restoreConfirmPhrase(version({ version: 7, label: "   " }))).toBe("v7");
  });

  it("bounds any display string hard", () => {
    const truncated = truncateTimelineString("a".repeat(5000), 140);
    expect(truncated.length).toBe(140);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Render matrix
// ---------------------------------------------------------------------------

describe("VersionTimeline render matrix", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renders version number, label, author, time, size and sha prefix per row", async () => {
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ version: 2, label: "Launch cut", parentVersionId: "ver_0001" })]),
    );
    render(
      <VersionTimeline currentVersionId="ver_0001" fetchPage={fetchPage} fetchDiff={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toHaveAttribute("data-version", "2");
    });
    expect(screen.getByTestId("version-number")).toHaveTextContent("v2");
    expect(screen.getByTestId("version-label")).toHaveTextContent("Launch cut");
    expect(screen.getByTestId("version-author")).toHaveTextContent("Alex");
    expect(screen.getByTestId("version-created")).toHaveTextContent("Oct 21, 2026, 14:32");
    expect(screen.getByTestId("version-size")).toHaveTextContent("2 KB");
    expect(screen.getByTestId("version-sha")).toHaveTextContent("aaaaaaaaaaaa");
  });

  it("marks agent versions with the agent badge and the agent node tone", async () => {
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([
        version({ id: "ver_agent", isAgent: true, agentRunId: "run_1" }),
        version({ id: "ver_human" }),
      ]),
    );
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getAllByTestId("version-row")).toHaveLength(2);
    });
    const [agentRow, humanRow] = screen.getAllByTestId("version-row") as [HTMLElement, HTMLElement];
    expect(agentRow).toHaveAttribute("data-agent", "true");
    expect(agentRow.querySelector('[data-testid="version-agent-badge"]')).not.toBeNull();
    expect(humanRow).toHaveAttribute("data-agent", "false");
    expect(humanRow.querySelector('[data-testid="version-agent-badge"]')).toBeNull();
  });

  it("marks exactly the current version row and badge", async () => {
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ id: "ver_cur", version: 3 }), version({ id: "ver_old", version: 2 })]),
    );
    render(
      <VersionTimeline currentVersionId="ver_cur" fetchPage={fetchPage} fetchDiff={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("version-row")).toHaveLength(2);
    });
    const [currentRow, oldRow] = screen.getAllByTestId("version-row") as [HTMLElement, HTMLElement];
    expect(currentRow).toHaveAttribute("data-current", "true");
    expect(currentRow.querySelector('[data-testid="version-current-badge"]')).not.toBeNull();
    expect(oldRow).toHaveAttribute("data-current", "false");
    expect(oldRow.querySelector('[data-testid="version-current-badge"]')).toBeNull();
  });

  it("renders unlabeled rows as “Untitled version” and nameless authors as “A member”", async () => {
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ label: null, createdByName: null })]),
    );
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toBeInTheDocument();
    });
    expect(screen.getByTestId("version-label")).toHaveTextContent("Untitled version");
    expect(screen.getByTestId("version-author")).toHaveTextContent("A member");
  });

  it("renders the parent linkage line for roots and loaded parents", async () => {
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([
        version({ id: "ver_0003", version: 3, parentVersionId: "ver_0002" }),
        version({ id: "ver_0002", version: 2, parentVersionId: "ver_0001" }),
        version({ id: "ver_0001", version: 1, parentVersionId: null }),
      ]),
    );
    render(
      <VersionTimeline currentVersionId="ver_0003" fetchPage={fetchPage} fetchDiff={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("version-row")).toHaveLength(3);
    });
    const linkages = screen.getAllByTestId("version-linkage");
    // Newest-first wire order: v3 (parent v2 loaded), v2 (parent v1 loaded),
    // v1 (root).
    expect(linkages).toHaveLength(3);
    expect(linkages[0]).toHaveTextContent("Follows v2");
    expect(linkages[1]).toHaveTextContent("Follows v1");
    expect(linkages[2]).toHaveTextContent("First version");
  });

  it("keeps the linkage line honest when the parent is beyond the loaded pages", async () => {
    const fetchUnloaded: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ id: "ver_0009", version: 9, parentVersionId: "ver_missing" })]),
    );
    render(
      <VersionTimeline currentVersionId={null} fetchPage={fetchUnloaded} fetchDiff={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toBeInTheDocument();
    });
    expect(screen.getByTestId("version-linkage")).toHaveTextContent("Follows an earlier version");
  });

  it("hides Restore and Edit label when the caller is not authorized (read-only surface)", async () => {
    const fetchPage: VersionPageFetcher = vi.fn(async () => pageOf([version()]));
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("version-restore")).toBeNull();
    expect(screen.queryByTestId("version-label-edit-button")).toBeNull();
    // View diff stays available to viewers.
    expect(screen.getByTestId("version-diff-toggle")).toBeInTheDocument();
  });

  it("bounds hostile labels, authors and sha prefixes instead of dumping them", async () => {
    const hostile = "x".repeat(10_000);
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([
        version({
          label: hostile,
          createdByName: hostile,
          sha256Prefix: hostile.slice(0, 40),
          sizeBytes: Number.NaN,
        }),
      ]),
    );
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("version-label")).toBeInTheDocument();
    });
    expect(screen.getByTestId("version-label").textContent?.length).toBeLessThanOrEqual(140);
    expect(screen.getByTestId("version-author").textContent?.length).toBeLessThanOrEqual(80);
    expect(screen.getByTestId("version-size")).toHaveTextContent("—");
  });
});

// ---------------------------------------------------------------------------
// Inline label editing (D-24 candidate)
// ---------------------------------------------------------------------------

describe("inline label editing", () => {
  it("edits a label inline and saves the trimmed value; the row adopts it", async () => {
    const setLabel = vi.fn(async () => version({ label: "Launch cut" }));
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ version: 2, label: "Old label" })]),
    );
    render(
      <VersionTimeline
        currentVersionId={null}
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        setLabel={setLabel}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-label")).toHaveTextContent("Old label");
    });

    await USER.click(screen.getByTestId("version-label-edit-button"));
    const input = screen.getByTestId("version-label-input");
    await USER.clear(input);
    await USER.type(input, "  Launch cut  ");
    await USER.click(screen.getByTestId("version-label-save"));

    await waitFor(() => {
      expect(setLabel).toHaveBeenCalledWith("ver_0001", { label: "Launch cut" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("version-label")).toHaveTextContent("Launch cut");
    });
  });

  it("rejects empty and over-length labels client-side before any POST", async () => {
    const setLabel = vi.fn(async () => version());
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ version: 2, label: "Keep" })]),
    );
    render(
      <VersionTimeline
        currentVersionId={null}
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        setLabel={setLabel}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-label")).toBeInTheDocument();
    });

    await USER.click(screen.getByTestId("version-label-edit-button"));
    const input = screen.getByTestId("version-label-input");
    await USER.clear(input);
    expect(screen.getByTestId("version-label-save")).toBeDisabled();
    expect(setLabel).not.toHaveBeenCalled();

    await USER.type(input, "x".repeat(121));
    expect(screen.getByTestId("version-label-save")).toBeDisabled();
    expect(screen.getByTestId("version-label-hint")).toHaveTextContent("1–120");
    expect(setLabel).not.toHaveBeenCalled();

    // Trim to the bound → save enables.
    await USER.type(input, "{backspace}");
    expect(screen.getByTestId("version-label-save")).not.toBeDisabled();
  });

  it("cancels without saving and restores the previous label", async () => {
    const setLabel = vi.fn(async () => version());
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ version: 2, label: "Keep" })]),
    );
    render(
      <VersionTimeline
        currentVersionId={null}
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        setLabel={setLabel}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-label")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-label-edit-button"));
    await USER.clear(screen.getByTestId("version-label-input"));
    await USER.click(screen.getByTestId("version-label-cancel"));
    expect(screen.getByTestId("version-label")).toHaveTextContent("Keep");
    expect(setLabel).not.toHaveBeenCalled();
  });

  it("surfaces typed save failures in place (lease held) and keeps the draft", async () => {
    const setLabel = vi.fn(async () => {
      throw leasedError;
    });
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ version: 2, label: "Keep" })]),
    );
    render(
      <VersionTimeline
        currentVersionId={null}
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        setLabel={setLabel}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-label")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-label-edit-button"));
    await USER.clear(screen.getByTestId("version-label-input"));
    await USER.type(screen.getByTestId("version-label-input"), "Blocked");
    await USER.click(screen.getByTestId("version-label-save"));

    await waitFor(() => {
      expect(screen.getByTestId("version-label-input")).toHaveAttribute("aria-invalid", "true");
    });
    // The Field error copy carries the §7.3 message verbatim; the draft and
    // the open editor stay in place for a retry.
    expect(document.body.textContent).toContain("Sam is editing this project right now.");
    expect(screen.getByTestId("version-label-input")).toHaveValue("Blocked");
  });
});

// ---------------------------------------------------------------------------
// Restore confirmation dialog (§9.3 + §7.5)
// ---------------------------------------------------------------------------

describe("restore confirmation dialog", () => {
  it("opens with the exact version, the never-rewrite explanation, and gates on the exact label", async () => {
    let fetchCalls = 0;
    const restore = vi.fn(async () => version({ id: "ver_new", version: 4 }));
    const onCurrentVersionChange = vi.fn();
    const fetchPage: VersionPageFetcher = vi.fn(async () => {
      fetchCalls += 1;
      return pageOf([version({ id: "ver_0002", version: 2, label: "Launch cut" })]);
    });
    render(
      <VersionTimeline
        currentVersionId="ver_0002"
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        restore={restore}
        onCurrentVersionChange={onCurrentVersionChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-restore")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-restore"));

    expect(screen.getByTestId("restore-dialog-title")).toHaveTextContent("Restore v2?");
    expect(screen.getByTestId("restore-dialog-description").textContent).toContain(
      "never rewritten",
    );
    expect(screen.getByTestId("restore-dialog-description").textContent).toContain("Launch cut");

    // Wrong label: the confirm stays disabled — the POST can never fire.
    await USER.type(screen.getByTestId("restore-input"), "wrong label");
    expect(screen.getByTestId("restore-confirm")).toBeDisabled();
    expect(restore).not.toHaveBeenCalled();

    // Case-sensitive exact match required.
    await USER.clear(screen.getByTestId("restore-input"));
    await USER.type(screen.getByTestId("restore-input"), "launch cut");
    expect(screen.getByTestId("restore-confirm")).toBeDisabled();

    // Exact label → confirm enabled → POST with the typed confirmation.
    await USER.clear(screen.getByTestId("restore-input"));
    await USER.type(screen.getByTestId("restore-input"), "Launch cut");
    expect(screen.getByTestId("restore-confirm")).not.toBeDisabled();
    await USER.click(screen.getByTestId("restore-confirm"));

    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith("ver_0002", { confirmLabel: "Launch cut" });
    });
    // §9.3: the created version becomes current, and the timeline reloads.
    await waitFor(() => {
      expect(onCurrentVersionChange).toHaveBeenCalledWith("ver_new");
    });
    await waitFor(() => {
      expect(fetchCalls).toBeGreaterThanOrEqual(2);
    });
  });

  it("falls back to the v{N} designation for unlabeled versions", async () => {
    const restore = vi.fn(async () => version());
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ id: "ver_0007", version: 7, label: null })]),
    );
    render(
      <VersionTimeline
        currentVersionId="ver_0007"
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        restore={restore}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-restore")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-restore"));
    expect(screen.getByTestId("restore-dialog-description").textContent).toContain("no label");
    await USER.type(screen.getByTestId("restore-input"), "v7");
    await USER.click(screen.getByTestId("restore-confirm"));
    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith("ver_0007", { confirmLabel: "v7" });
    });
  });

  it("keeps the dialog open with the typed error when the gateway refuses (lease held)", async () => {
    const restore = vi.fn(async () => {
      throw leasedError;
    });
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ id: "ver_0002", version: 2, label: "Launch cut" })]),
    );
    render(
      <VersionTimeline
        currentVersionId={null}
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        restore={restore}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("version-restore")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-restore"));
    await USER.type(screen.getByTestId("restore-input"), "Launch cut");
    await USER.click(screen.getByTestId("restore-confirm"));
    await waitFor(() => {
      expect(screen.getByTestId("restore-error")).toHaveTextContent(
        "Sam is editing this project right now.",
      );
    });
    expect(screen.getByTestId("restore-error")).toHaveTextContent("req_lease_01");
    expect(screen.getByTestId("restore-dialog-title")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Diff summaries
// ---------------------------------------------------------------------------

describe("diff summaries", () => {
  it("fetches on first expand and renders the structural summary", async () => {
    const diff: VersionDiffSummary = {
      fromParent: {
        parentVersionId: "ver_0001",
        parentVersion: 1,
        sizeDeltaBytes: 1234,
        labelChanged: true,
        authorChanged: true,
        createdGapMs: 3 * 3_600_000 + 12 * 60_000,
      },
      summary: "1.2 KB larger than v1. Saved by a different author.",
    };
    const fetchDiff = vi.fn(async () => diff);
    const fetchPage: VersionPageFetcher = vi.fn(async () =>
      pageOf([version({ id: "ver_0002", version: 2, parentVersionId: "ver_0001" })]),
    );
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={fetchDiff} />);
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-toggle")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-diff-toggle"));

    await waitFor(() => {
      expect(fetchDiff).toHaveBeenCalledWith("ver_0002");
    });
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-summary")).toHaveTextContent(
        "1.2 KB larger than v1. Saved by a different author.",
      );
    });
    expect(screen.getByTestId("version-diff-parent")).toHaveTextContent("v1");
    expect(screen.getByTestId("version-diff-size")).toHaveTextContent("+1.2 KB");
    expect(screen.getByTestId("version-diff-gap")).toHaveTextContent("3h 12m later");
    expect(screen.getByTestId("version-diff-author")).toHaveTextContent("Changed since the parent");
  });

  it("renders the root-version copy when there is no parent to compare against", async () => {
    const fetchDiff = vi.fn(async () => ({
      fromParent: null,
      summary: "First version — nothing to compare against.",
    }));
    const fetchPage: VersionPageFetcher = vi.fn(async () => pageOf([version()]));
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={fetchDiff} />);
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-toggle")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-diff-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-summary")).toHaveTextContent(
        "First version — nothing to compare against.",
      );
    });
    expect(screen.queryByTestId("version-diff-parent")).toBeNull();
  });

  it("bounds a hostile summary string and offers a retry after a typed failure", async () => {
    const hostile = "x".repeat(10_000);
    let calls = 0;
    const fetchDiff = vi.fn(async (): Promise<VersionDiffSummary> => {
      calls += 1;
      if (calls === 1) {
        throw new ApiError({
          code: "INTERNAL_ERROR",
          message: "Something went wrong on our side.",
          status: 500,
          requestId: "req_diff_01",
        });
      }
      return { fromParent: null, summary: hostile };
    });
    const fetchPage: VersionPageFetcher = vi.fn(async () => pageOf([version()]));
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={fetchDiff} />);
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-toggle")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-diff-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-error")).toHaveTextContent(
        "Something went wrong on our side.",
      );
    });
    await USER.click(screen.getByTestId("version-diff-retry"));
    await waitFor(() => {
      expect(fetchDiff).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-summary").textContent?.length).toBeLessThanOrEqual(
        200,
      );
    });
  });

  it("toggles the diff panel closed without refetching", async () => {
    const fetchDiff = vi.fn(async () => ({ fromParent: null, summary: "First version." }));
    const fetchPage: VersionPageFetcher = vi.fn(async () => pageOf([version()]));
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={fetchDiff} />);
    await waitFor(() => {
      expect(screen.getByTestId("version-diff-toggle")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-diff-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("version-diff")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-diff-toggle"));
    expect(screen.queryByTestId("version-diff")).toBeNull();
    expect(fetchDiff).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Pagination, empty and error states
// ---------------------------------------------------------------------------

describe("pagination and states", () => {
  it("loads the first page, then appends via the cursor (replay-safe click)", async () => {
    let calls = 0;
    const fetchPage: VersionPageFetcher = vi.fn(async (query) => {
      calls += 1;
      if (calls === 1) return pageOf([version({ id: "ver_1", version: 1 })], "cursor-2");
      expect(query.cursor).toBe("cursor-2");
      return pageOf([version({ id: "ver_2", version: 2, parentVersionId: "ver_1" })]);
    });
    render(<VersionTimeline currentVersionId="ver_1" fetchPage={fetchPage} fetchDiff={vi.fn()} />);
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledWith({ limit: 25 });
    });
    await USER.click(screen.getByTestId("timeline-load-more"));
    await waitFor(() => {
      expect(screen.getAllByTestId("version-row")).toHaveLength(2);
    });
    expect(screen.queryByTestId("timeline-load-more")).toBeNull();
    expect(screen.getByTestId("timeline-end")).toHaveTextContent("That’s the whole history.");
  });

  it("renders the empty state with the editor deep link", async () => {
    const fetchPage: VersionPageFetcher = vi.fn(async () => pageOf([]));
    render(
      <VersionTimeline
        currentVersionId={null}
        fetchPage={fetchPage}
        fetchDiff={vi.fn()}
        editorHref="/w/demo/editor"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("timeline-empty")).toHaveTextContent("No versions yet.");
    });
    expect(screen.getByTestId("timeline-empty").querySelector("a")?.getAttribute("href")).toBe(
      "/w/demo/editor",
    );
  });

  it("surfaces typed fetch failures with a retry that refires the first page", async () => {
    let calls = 0;
    const fetchPage: VersionPageFetcher = vi.fn(async (): Promise<Page<VersionTimelineEntry>> => {
      calls += 1;
      if (calls === 1) {
        throw new ApiError({
          code: "INTERNAL_ERROR",
          message: "The timeline exploded.",
          status: 500,
          requestId: "req_tl_01",
        });
      }
      return pageOf([version()]);
    });
    render(<VersionTimeline currentVersionId={null} fetchPage={fetchPage} fetchDiff={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("timeline-error")).toHaveTextContent("The timeline exploded.");
    });
    await USER.click(screen.getByTestId("timeline-error-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toBeInTheDocument();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// useVersionPages hook — race guard + replay safety
// ---------------------------------------------------------------------------

describe("useVersionPages hook", () => {
  it("drops stale responses (reload wins over an in-flight load-more)", async () => {
    let resolveSecond: ((page: Page<VersionTimelineEntry>) => void) | null = null;
    let calls = 0;
    const fetchPage: VersionPageFetcher = vi.fn(async (): Promise<Page<VersionTimelineEntry>> => {
      calls += 1;
      if (calls === 1) return pageOf([version({ id: "ver_1" })], "cursor-2");
      if (calls === 2) {
        return new Promise((resolve) => {
          resolveSecond = resolve;
        });
      }
      return pageOf([version({ id: "ver_fresh" })]);
    });
    const { result } = renderHook(() => useVersionPages(fetchPage));
    await waitFor(() => {
      expect(result.current.nextCursor).toBe("cursor-2");
    });

    // Fire a load-more, then a reload before it settles: the reload wins.
    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(result.current.entries.some((entry) => entry.id === "ver_fresh")).toBe(true);
    });

    // The stale load-more answer arrives late — it must be dropped.
    await act(async () => {
      resolveSecond?.(pageOf([version({ id: "ver_stale" })]));
    });
    expect(result.current.entries.some((entry) => entry.id === "ver_stale")).toBe(false);
  });

  it("no-ops a load-more while any fetch is in flight", async () => {
    let calls = 0;
    const fetchPage: VersionPageFetcher = vi.fn(async (): Promise<Page<VersionTimelineEntry>> => {
      calls += 1;
      if (calls === 1) return pageOf([version()], "cursor-2");
      return pageOf([version({ id: "ver_2", version: 2 })]);
    });
    const { result } = renderHook(() => useVersionPages(fetchPage));
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
