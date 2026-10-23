/**
 * RendersHubPanel tests (M8-J) — the project-hub renders surface: list +
 * cursor pagination, D-11 status vocabulary, progress on active rows,
 * credits (D-12 display), expiry/expired copy, error + errorCode copy on
 * failed rows, download visibility (completed + live window only), the
 * cancel flow, version pin labels, the active-row poller (presence cadence
 * recipe: visibility pause, silent failures, merge semantics), the
 * useRendersPages race guards and the history-view wiring (the ONE additive
 * mount).
 */

import { ApiError } from "@studio/api-client";
import type {
  EstimateResult,
  Page,
  QueueRenderRequest,
  RenderEstimateRequest,
  RenderJob,
  VersionTimelineEntry,
} from "@studio/contracts";
import { RENDER_STATUSES } from "@studio/contracts";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryPageView, type HistoryPort } from "@/components/versions/history-view";
import {
  type HubCompOption,
  RENDER_STATUS_CHIPS,
  RendersHubPanel,
  type RendersHubPort,
  canDownloadRender,
  isActiveRender,
  renderErrorCodeCopy,
  renderExpiryLabel,
  useRendersPages,
} from "./renders-panel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-10-21T16:00:00.000Z";

function renderJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: "rnd_1",
    projectId: "prj_demo",
    compId: "cmp_demo_launch_main",
    versionId: "ver_demo_4",
    format: "mp4",
    settings: {},
    status: "completed",
    cancelRequested: false,
    progress: { framesDone: 720, framesTotal: 720, percent: 100 },
    credits: 14,
    resultUrl: "https://storage.test/signed/rnd_1.mp4",
    errorCode: null,
    error: null,
    sizeBytes: 48_231_808,
    createdBy: "usr_demo",
    createdAt: "2026-10-10T09:12:00Z",
    startedAt: "2026-10-10T09:12:20Z",
    completedAt: "2026-10-10T09:17:41Z",
    expiresAt: "2026-11-09T09:17:41Z",
    ...overrides,
  };
}

function queuedJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return renderJob({
    id: "rnd_new",
    status: "queued",
    credits: null,
    resultUrl: null,
    sizeBytes: null,
    expiresAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
    progress: { framesDone: 0, framesTotal: 0, percent: 0 },
    ...overrides,
  });
}

function runningJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return renderJob({
    id: "rnd_r",
    status: "running",
    credits: null,
    resultUrl: null,
    expiresAt: null,
    progress: { framesDone: 45, framesTotal: 100, percent: 45 },
    ...overrides,
  });
}

function versionEntry(overrides: Partial<VersionTimelineEntry> = {}): VersionTimelineEntry {
  return {
    id: "ver_demo_4",
    projectId: "prj_demo",
    version: 4,
    parentVersionId: null,
    sha256: "a".repeat(64),
    sizeBytes: 2048,
    label: null,
    agentRunId: null,
    createdBy: "usr_demo",
    createdAt: "2026-10-10T09:12:00Z",
    createdByName: "Maya",
    isAgent: false,
    sha256Prefix: "aaaaaaaaaaaa",
    ...overrides,
  };
}

const ESTIMATE: EstimateResult = {
  credits: 14,
  outputSeconds: 30,
  longEdgePx: 1920,
  format: "mp4",
  quality: "good",
  minApplied: false,
};

function pageOf<T>(items: readonly T[], nextCursor: string | null = null): Page<T> {
  return { items, nextCursor };
}

function makePort(overrides: Partial<RendersHubPort> = {}): RendersHubPort {
  return {
    listRenders: vi.fn(async () => pageOf([renderJob()])),
    queueRender: vi.fn(async (body: QueueRenderRequest) =>
      queuedJob({ compId: body.compId, format: body.format }),
    ),
    cancelRender: vi.fn(async (id: string) => renderJob({ id, cancelRequested: true })),
    estimateRender: vi.fn(async (_body: RenderEstimateRequest) => ESTIMATE),
    listVersions: vi.fn(async () => pageOf([versionEntry()])),
    ...overrides,
  };
}

interface PanelOverrides {
  readonly port: RendersHubPort;
  readonly canQueue: boolean;
  readonly comps: readonly HubCompOption[];
  readonly openUrl: (url: string) => void;
  readonly pollIntervalMs: number | undefined;
}

function renderPanel(overrides: Partial<PanelOverrides> = {}): RendersHubPort {
  const port = overrides.port ?? makePort();
  render(
    <RendersHubPanel
      projectId="prj_demo"
      workspaceId="ws_demo"
      canQueue={overrides.canQueue ?? true}
      nowIso={NOW}
      editorHref="/w/launch-film/editor"
      comps={overrides.comps ?? []}
      api={port}
      openUrl={overrides.openUrl}
      pollIntervalMs={overrides.pollIntervalMs}
    />,
  );
  return port;
}

const USER = userEvent.setup();

/** All history ROWS (the `li[data-status]` elements — never the sub-testids). */
function rows(): HTMLElement[] {
  return Array.from(
    screen.getByTestId("renders-hub-list").querySelectorAll("li[data-status]"),
  ) as HTMLElement[];
}

/** jsdom visibility override (the presence-test helper). */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

// ---------------------------------------------------------------------------
// Pure copy/format helpers
// ---------------------------------------------------------------------------

describe("render copy helpers", () => {
  it("pins the D-11 status vocabulary: exactly the five DB statuses, never 'succeeded'", () => {
    expect(Object.keys(RENDER_STATUS_CHIPS).sort()).toEqual([...RENDER_STATUSES].sort());
    expect(RENDER_STATUS_CHIPS.queued?.label).toBe("Queued");
    expect(RENDER_STATUS_CHIPS.running?.label).toBe("Rendering");
    expect(RENDER_STATUS_CHIPS.completed?.label).toBe("Completed");
    expect(RENDER_STATUS_CHIPS.failed?.label).toBe("Failed");
    expect(RENDER_STATUS_CHIPS.cancelled?.label).toBe("Cancelled");
    expect("succeeded" in RENDER_STATUS_CHIPS).toBe(false);
  });

  it("isActiveRender is true only for queued/running", () => {
    expect(isActiveRender(queuedJob())).toBe(true);
    expect(isActiveRender(runningJob())).toBe(true);
    expect(isActiveRender(renderJob())).toBe(false);
    expect(isActiveRender(renderJob({ status: "failed" }))).toBe(false);
    expect(isActiveRender(renderJob({ status: "cancelled" }))).toBe(false);
  });

  it("expiry copy: available-until, expired and the honest degrades", () => {
    const until = renderExpiryLabel("2026-11-09T09:17:41Z", NOW);
    expect(until.state).toBe("until");
    expect(until.text).toBe("Available until Nov 9, 2026");

    const expired = renderExpiryLabel("2026-10-01T00:00:00Z", NOW);
    expect(expired.state).toBe("expired");
    expect(expired.text).toBe("Expired — the download window has closed.");

    expect(renderExpiryLabel(null, NOW).state).toBe("none");
    expect(renderExpiryLabel("not-a-date", NOW).state).toBe("unknown");
  });

  it("download gates on completed + signed URL + a live window", () => {
    expect(canDownloadRender(renderJob(), NOW)).toBe(true);
    expect(canDownloadRender(renderJob({ resultUrl: null }), NOW)).toBe(false);
    expect(canDownloadRender(runningJob(), NOW)).toBe(false);
    expect(canDownloadRender(renderJob({ expiresAt: "2026-10-01T00:00:00Z" }), NOW)).toBe(false);
  });

  it("errorCode copy maps the stable machine codes; unknown stays null", () => {
    expect(renderErrorCodeCopy("RENDER_TIMEOUT")).toContain("time budget");
    expect(renderErrorCodeCopy("RENDER_ASSET_MISSING")).toContain("asset");
    expect(renderErrorCodeCopy("SOMETHING_NEW")).toBeNull();
    expect(renderErrorCodeCopy(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// List: first load, pagination, empty/loading/error states
// ---------------------------------------------------------------------------

describe("list + states", () => {
  it("loads the first page through the port ({ limit: 25 }) and renders rows", async () => {
    const port = makePort({
      listRenders: vi.fn(async () => pageOf([renderJob(), renderJob({ id: "rnd_2" })])),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    expect(port.listRenders).toHaveBeenCalledWith({ limit: 25 });
  });

  it("appends via the cursor and reports the end honestly", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async (query: { cursor?: string }) => {
        calls += 1;
        if (calls === 1) return pageOf([renderJob({ id: "rnd_1" })], "cursor-2");
        expect(query.cursor).toBe("cursor-2");
        return pageOf([renderJob({ id: "rnd_2", createdAt: "2026-10-09T09:12:00Z" })]);
      }),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-load-more")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("renders-hub-load-more"));
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    expect(screen.queryByTestId("renders-hub-load-more")).toBeNull();
    expect(screen.getByTestId("renders-hub-end")).toHaveTextContent("That’s every render so far.");
  });

  it("renders the empty state with the editor deep link", async () => {
    const port = makePort({ listRenders: vi.fn(async () => pageOf([])) });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-empty")).toHaveTextContent("No renders yet.");
    });
    expect(screen.getByTestId("renders-hub-empty").querySelector("a")?.getAttribute("href")).toBe(
      "/w/launch-film/editor",
    );
  });

  it("surfaces typed fetch failures with a retry that refires the first page", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new ApiError({
            code: "INTERNAL_ERROR",
            message: "The render history exploded.",
            status: 500,
            requestId: "req_rh_01",
          });
        }
        return pageOf([renderJob()]);
      }),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-error")).toHaveTextContent(
        "The render history exploded.",
      );
    });
    await USER.click(screen.getByTestId("renders-hub-error-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_1")).toBeInTheDocument();
    });
    expect(port.listRenders).toHaveBeenCalledTimes(2);
  });

  it("shows the loading skeleton before the first page lands", () => {
    renderPanel({
      port: makePort({
        listRenders: () => new Promise(() => {}) as Promise<Page<RenderJob>>,
      }),
    });
    expect(screen.getByTestId("renders-hub-loading")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Rows: vocabulary, progress, credits, expiry, errors, version pins
// ---------------------------------------------------------------------------

describe("rows", () => {
  const FIVE = [
    queuedJob({ id: "rnd_q", progress: { framesDone: 0, framesTotal: 0, percent: 0 } }),
    runningJob({ id: "rnd_r" }),
    renderJob({ id: "rnd_c" }),
    renderJob({
      id: "rnd_f",
      status: "failed",
      credits: null,
      errorCode: "RENDER_TIMEOUT",
      error: "The render exceeded the 30 minute budget.",
      resultUrl: null,
      expiresAt: null,
    }),
    renderJob({
      id: "rnd_x",
      status: "cancelled",
      credits: null,
      resultUrl: null,
      expiresAt: null,
    }),
  ];

  it("renders the D-11 vocabulary — one chip per status, never 'succeeded'", async () => {
    const port = makePort({ listRenders: vi.fn(async () => pageOf(FIVE)) });
    renderPanel({ port });
    await waitFor(() => {
      expect(rows()).toHaveLength(5);
    });
    expect(screen.getByTestId("renders-hub-row-rnd_q-status")).toHaveTextContent("Queued");
    expect(screen.getByTestId("renders-hub-row-rnd_r-status")).toHaveTextContent("Rendering");
    expect(screen.getByTestId("renders-hub-row-rnd_c-status")).toHaveTextContent("Completed");
    expect(screen.getByTestId("renders-hub-row-rnd_f-status")).toHaveTextContent("Failed");
    expect(screen.getByTestId("renders-hub-row-rnd_x-status")).toHaveTextContent("Cancelled");
    for (const job of FIVE) {
      expect(screen.getByTestId(`renders-hub-row-${job.id}`)).toHaveAttribute(
        "data-status",
        job.status,
      );
    }
    expect(screen.queryByText(/succeeded/i)).toBeNull();
  });

  it("shows the progress bar only on active rows: frames done/total → percent", async () => {
    const port = makePort({
      listRenders: vi.fn(async () => pageOf([runningJob({ id: "rnd_r" })])),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_r-progress")).toBeInTheDocument();
    });
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "45");
    expect(bar).toHaveAttribute("data-percent", "45");
    expect(screen.getByTestId("renders-hub-row-rnd_r-progress")).toHaveTextContent(
      "45 of 100 frames · 45%",
    );

    const done = makePort({
      listRenders: vi.fn(async () => pageOf([renderJob({ id: "rnd_c" })])),
    });
    renderPanel({ port: done });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_c")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("renders-hub-row-rnd_c-progress")).toBeNull();
  });

  it("credits render the D-12 display number; null degrades to —", async () => {
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([
          renderJob({ id: "rnd_c", credits: 14 }),
          queuedJob({ id: "rnd_q", credits: null }),
        ]),
      ),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_c-credits")).toHaveTextContent("14 credits");
    });
    expect(screen.getByTestId("renders-hub-row-rnd_q-credits")).toHaveTextContent("— credits");
  });

  it("expiry: 'available until' for live outputs, 'expired' past the window", async () => {
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([
          renderJob({ id: "rnd_live" }),
          renderJob({ id: "rnd_old", expiresAt: "2026-10-01T00:00:00Z" }),
          renderJob({ id: "rnd_none", expiresAt: null }),
        ]),
      ),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_live-expires")).toHaveTextContent(
        "Available until Nov 9, 2026",
      );
    });
    const expired = screen.getByTestId("renders-hub-row-rnd_old-expires");
    expect(expired).toHaveTextContent("Expired — the download window has closed.");
    expect(expired).toHaveAttribute("data-state", "expired");
    expect(screen.queryByTestId("renders-hub-row-rnd_none-expires")).toBeNull();
  });

  it("failed rows carry the server error message + the friendly errorCode copy", async () => {
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([
          renderJob({
            id: "rnd_f",
            status: "failed",
            errorCode: "RENDER_TIMEOUT",
            error: "The render exceeded the 30 minute budget.",
            resultUrl: null,
            expiresAt: null,
          }),
        ]),
      ),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_f-error")).toHaveTextContent(
        "The render exceeded the 30 minute budget.",
      );
    });
    expect(screen.getByTestId("renders-hub-row-rnd_f-error")).toHaveTextContent(
      "The render ran past its time budget and was stopped.",
    );
  });

  it("version pin labels resolve to 'Snapshot v{N}' and degrade to 'Pinned snapshot'", async () => {
    const known = makePort({
      listRenders: vi.fn(async () =>
        pageOf([
          renderJob({ id: "rnd_a", versionId: "ver_demo_4" }),
          renderJob({ id: "rnd_b", versionId: "ver_unknown" }),
        ]),
      ),
    });
    renderPanel({ port: known });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_a-version")).toHaveTextContent("Snapshot v4");
    });
    expect(screen.getByTestId("renders-hub-row-rnd_b-version")).toHaveTextContent(
      "Pinned snapshot",
    );

    const failing = makePort({
      listRenders: vi.fn(async () => pageOf([renderJob({ id: "rnd_c" })])),
      listVersions: vi.fn(async () => {
        throw new ApiError({ code: "INTERNAL_ERROR", message: "offline", status: 500 });
      }),
    });
    renderPanel({ port: failing });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_c-version")).toHaveTextContent(
        "Pinned snapshot",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Download + cancel flows
// ---------------------------------------------------------------------------

describe("download + cancel", () => {
  it("offers Download on completed rows only, and opens the signed URL", async () => {
    const openUrl = vi.fn();
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([
          renderJob({ id: "rnd_c" }),
          queuedJob({ id: "rnd_q" }),
          renderJob({ id: "rnd_f", status: "failed", resultUrl: null, expiresAt: null }),
        ]),
      ),
    });
    renderPanel({ port, openUrl });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_c-download")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("renders-hub-row-rnd_q-download")).toBeNull();
    expect(screen.queryByTestId("renders-hub-row-rnd_f-download")).toBeNull();

    await USER.click(screen.getByTestId("renders-hub-row-rnd_c-download"));
    expect(openUrl).toHaveBeenCalledWith("https://storage.test/signed/rnd_1.mp4");
  });

  it("expired completed rows lose the Download action", async () => {
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([renderJob({ id: "rnd_old", expiresAt: "2026-10-01T00:00:00Z" })]),
      ),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_old-expires")).toHaveAttribute(
        "data-state",
        "expired",
      );
    });
    expect(screen.queryByTestId("renders-hub-row-rnd_old-download")).toBeNull();
  });

  it("refuses non-http(s) result URLs and explains instead of navigating", async () => {
    const openUrl = vi.fn();
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([renderJob({ id: "rnd_c", resultUrl: "javascript:alert(1)" })]),
      ),
    });
    renderPanel({ port, openUrl });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_c-download")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("renders-hub-row-rnd_c-download"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-download-error")).toHaveTextContent(
        "The download link could not be opened.",
      );
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("cancel patches the row in place (cancelRequested → 'Cancelling…')", async () => {
    const queued = queuedJob({ id: "rnd_q" });
    const port = makePort({
      listRenders: vi.fn(async () => pageOf([queued])),
      cancelRender: vi.fn(async (id: string) => ({ ...queued, id, cancelRequested: true })),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_q-cancel")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("renders-hub-row-rnd_q-cancel"));
    await waitFor(() => {
      expect(port.cancelRender).toHaveBeenCalledWith("rnd_q");
    });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_q-cancelling")).toHaveTextContent(
        "Cancelling…",
      );
    });
    expect(screen.getByTestId("renders-hub-row-rnd_q-cancel")).toBeDisabled();
  });

  it("cancel failures surface the §7.3 message + hint + request id in place", async () => {
    const port = makePort({
      listRenders: vi.fn(async () => pageOf([runningJob({ id: "rnd_q" })])),
      cancelRender: vi.fn(async () => {
        throw new ApiError({
          code: "FORBIDDEN",
          message: "You can't cancel another member's render.",
          hint: "Ask Maya or an admin for help.",
          status: 403,
          requestId: "req_cx_01",
        });
      }),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_q-cancel")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("renders-hub-row-rnd_q-cancel"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-action-error")).toHaveTextContent(
        "You can't cancel another member's render. (req_cx_01)",
      );
    });
    expect(screen.getByTestId("renders-hub-action-error")).toHaveTextContent(
      "Ask Maya or an admin for help.",
    );
  });

  it("read-only members see the history but no queue entry and no cancel actions", async () => {
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([renderJob({ id: "rnd_c" }), queuedJob({ id: "rnd_q" })]),
      ),
    });
    renderPanel({ port, canQueue: false });
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    expect(screen.getByTestId("renders-hub-queue-readonly")).toHaveTextContent(
      "You need edit access to queue renders.",
    );
    expect(screen.queryByTestId("renders-hub-queue")).toBeNull();
    expect(screen.queryByTestId("renders-hub-row-rnd_q-cancel")).toBeNull();
    // Viewer+ reads keep the download surface.
    expect(screen.getByTestId("renders-hub-row-rnd_c-download")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Queue integration (through the panel: comps seeded from history, refresh)
// ---------------------------------------------------------------------------

describe("queue integration through the panel", () => {
  it("queues with a fresh idempotencyKey and refreshes the list", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async () => {
        calls += 1;
        // Before the queue: one finished render. After (the refresh): the
        // new queued job lands at the top, newest-first.
        if (calls === 1) return pageOf([renderJob({ id: "rnd_c", compId: "cmp_main" })]);
        return pageOf([
          queuedJob({ id: "rnd_new", compId: "cmp_main" }),
          renderJob({ id: "rnd_c", compId: "cmp_main" }),
        ]);
      }),
    });
    renderPanel({ port });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_c")).toBeInTheDocument();
    });
    // The history row seeds the comp picker (the `Comp <id>` house fallback).
    await USER.click(screen.getByTestId("renders-hub-queue-button"));
    const compSelect = await screen.findByTestId("renders-hub-comp");
    expect(compSelect).toHaveTextContent(/Comp cmp_main/);
    await USER.click(await screen.findByTestId("renders-hub-queue-submit"));

    await waitFor(() => {
      expect(port.queueRender).toHaveBeenCalledTimes(1);
    });
    const body = vi.mocked(port.queueRender).mock.calls[0]?.[0];
    expect(body?.projectId).toBe("prj_demo");
    expect(body?.compId).toBe("cmp_main");
    expect(body?.format).toBe("mp4");
    expect(body?.idempotencyKey).toMatch(/^[\da-f-]{36}$/);
    expect(typeof body?.settings.width).toBe("number");
    expect(typeof body?.settings.frameRate).toBe("number");

    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-queue-note")).toHaveTextContent(
        "Render queued — watch its progress below.",
      );
    });
    // The list refreshed (the reload after a successful queue).
    await waitFor(() => {
      expect(vi.mocked(port.listRenders).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_new")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Polling — the active-row refresh (presence cadence recipe, fake timers)
// ---------------------------------------------------------------------------

describe("polling (fake timers, the M7-B cadence recipe)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  /** Double-drain: fire timers due at +ms, then flush the microtask tail. */
  async function settle(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("merges a completed row in place while the job was running", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async () => {
        calls += 1;
        // 1 = initial load, 2 = the poller's immediate tick (still running),
        // 3 = the interval tick, now finished; polling then disables.
        if (calls <= 2) return pageOf([runningJob({ id: "rnd_r" })]);
        return pageOf([renderJob({ id: "rnd_r" })]);
      }),
    });
    renderPanel({ port, pollIntervalMs: 1_000 });
    await settle();
    expect(screen.getByTestId("renders-hub-row-rnd_r-status")).toHaveTextContent("Rendering");

    await settle(1_000);
    expect(screen.getByTestId("renders-hub-row-rnd_r-status")).toHaveTextContent("Completed");
    expect(screen.getByTestId("renders-hub-row-rnd_r-download")).toBeInTheDocument();

    await settle(2_000); // polling disabled: no more fetches
    expect(calls).toBe(3);
  });

  it("prepends unseen rows without dropping loaded pages (merge, not reload)", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async (query: { cursor?: string }) => {
        calls += 1;
        if (query.cursor === "cursor-2")
          return pageOf([renderJob({ id: "rnd_old", createdAt: "2026-10-01T09:12:00Z" })]);
        if (calls <= 2) return pageOf([runningJob({ id: "rnd_r1" })], "cursor-2");
        return pageOf([queuedJob({ id: "rnd_new", createdAt: NOW }), renderJob({ id: "rnd_r1" })]);
      }),
    });
    renderPanel({ port, pollIntervalMs: 1_000 });
    await settle();
    expect(screen.getByTestId("renders-hub-row-rnd_r1-status")).toHaveTextContent("Rendering");

    await act(async () => {
      screen.getByTestId("renders-hub-load-more").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(rows().map((row) => row.dataset.status)).toEqual(["running", "completed"]);

    await settle(1_000); // the merge tick: finished + a brand-new queued job
    const ids = rows().map((row) => row.getAttribute("data-testid"));
    expect(ids).toEqual([
      "renders-hub-row-rnd_new",
      "renders-hub-row-rnd_r1",
      "renders-hub-row-rnd_old",
    ]);
    expect(screen.getByTestId("renders-hub-row-rnd_r1-status")).toHaveTextContent("Completed");
  });

  it("poll failures are silent — the last list stays rendered", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return pageOf([runningJob({ id: "rnd_r" })]);
        throw new ApiError({ code: "NETWORK_ERROR", message: "offline", status: 0 });
      }),
    });
    renderPanel({ port, pollIntervalMs: 1_000 });
    await settle();
    await settle(); // the immediate merge tick fails
    expect(screen.getByTestId("renders-hub-row-rnd_r")).toBeInTheDocument();
    expect(screen.queryByTestId("renders-hub-error")).toBeNull();

    await settle(2_000); // keeps retrying quietly at the cadence
    expect(calls).toBeGreaterThan(2);
    expect(screen.getByTestId("renders-hub-row-rnd_r")).toBeInTheDocument();
    expect(screen.queryByTestId("renders-hub-error")).toBeNull();
  });

  it("PAUSES while the tab is hidden; resumes (immediate tick) on visible", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async () => {
        calls += 1;
        return pageOf([runningJob({ id: "rnd_r" })]);
      }),
    });
    renderPanel({ port, pollIntervalMs: 1_000 });
    await settle(); // initial load + the poller's immediate tick
    await settle(1_000); // one interval tick
    expect(calls).toBe(3);

    setVisibility("hidden");
    await settle(3_000);
    expect(calls).toBe(3); // paused: no polls while hidden

    setVisibility("visible");
    await settle();
    expect(calls).toBe(4); // immediate tick on visible…
    await settle(1_000);
    expect(calls).toBe(5); // …then the interval resumes
  });

  it("never polls when no row is active (terminal-only history)", async () => {
    const port = makePort({
      listRenders: vi.fn(async () =>
        pageOf([
          renderJob({ id: "rnd_c" }),
          renderJob({ id: "rnd_f", status: "failed", resultUrl: null, expiresAt: null }),
        ]),
      ),
    });
    renderPanel({ port, pollIntervalMs: 1_000 });
    await settle();
    await settle(3_000);
    expect(port.listRenders).toHaveBeenCalledTimes(1); // the initial load only
  });

  it("the queue flow surfaces the created job through the refreshed first page", async () => {
    let calls = 0;
    const port = makePort({
      listRenders: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return pageOf([renderJob({ id: "rnd_c", compId: "cmp_main" })]);
        return pageOf([
          queuedJob({ id: "rnd_new", compId: "cmp_main" }),
          renderJob({ id: "rnd_c", compId: "cmp_main" }),
        ]);
      }),
    });
    renderPanel({ port, pollIntervalMs: 1_000 });
    await settle();
    await act(async () => {
      screen.getByTestId("renders-hub-queue-button").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Default estimate debounce (350ms) elapses under fake timers.
    await settle(500);
    expect(port.estimateRender).toHaveBeenCalledTimes(1);
    await act(async () => {
      screen.getByTestId("renders-hub-queue-submit").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();
    expect(screen.getByTestId("renders-hub-row-rnd_new")).toBeInTheDocument();
    expect(screen.getByTestId("renders-hub-row-rnd_new-status")).toHaveTextContent("Queued");
  });
});

// ---------------------------------------------------------------------------
// useRendersPages hook — race guard + merge semantics
// ---------------------------------------------------------------------------

describe("useRendersPages hook", () => {
  it("drops stale load-more answers when a reload supersedes them", async () => {
    let resolveSecond: ((page: Page<RenderJob>) => void) | null = null;
    let calls = 0;
    const fetchPage = vi.fn(async (): Promise<Page<RenderJob>> => {
      calls += 1;
      if (calls === 1) return pageOf([renderJob({ id: "rnd_1" })], "cursor-2");
      if (calls === 2) {
        return new Promise((resolve) => {
          resolveSecond = resolve;
        });
      }
      return pageOf([renderJob({ id: "rnd_fresh" })]);
    });
    const { result } = renderHook(() => useRendersPages(fetchPage));
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
      expect(result.current.entries.some((row) => row.id === "rnd_fresh")).toBe(true);
    });

    await act(async () => {
      resolveSecond?.(pageOf([renderJob({ id: "rnd_stale" })]));
    });
    expect(result.current.entries.some((row) => row.id === "rnd_stale")).toBe(false);
  });

  it("no-ops a load-more while any fetch is in flight", async () => {
    let calls = 0;
    const fetchPage = vi.fn(async (): Promise<Page<RenderJob>> => {
      calls += 1;
      if (calls === 1) return pageOf([renderJob()], "cursor-2");
      return pageOf([renderJob({ id: "rnd_2" })]);
    });
    const { result } = renderHook(() => useRendersPages(fetchPage));
    await waitFor(() => {
      expect(result.current.nextCursor).toBe("cursor-2");
    });
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.nextCursor).toBeNull();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("patchEntry replaces by id; mergeFirstPage prepends unseen, keeps the rest", async () => {
    let calls = 0;
    const fetchPage = vi.fn(async (): Promise<Page<RenderJob>> => {
      calls += 1;
      // 1 = initial load (one finished row); 2 = the merge refresh, which
      // sees a brand-new queued job at the top.
      if (calls === 1) return pageOf([renderJob({ id: "rnd_1" })]);
      return pageOf([queuedJob({ id: "rnd_new" }), renderJob({ id: "rnd_1" })]);
    });
    const { result } = renderHook(() => useRendersPages(fetchPage));
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.patchEntry(
        renderJob({ id: "rnd_1", status: "cancelled", resultUrl: null, expiresAt: null }),
      );
    });
    expect(result.current.entries[0]?.status).toBe("cancelled");

    await act(async () => {
      await result.current.mergeFirstPage();
    });
    const ids = result.current.entries.map((row) => row.id);
    expect(ids).toEqual(["rnd_new", "rnd_1"]);
    expect(result.current.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The history-view wiring — the ONE additive mount (§M8 task 2)
// ---------------------------------------------------------------------------

describe("history-view wiring", () => {
  it("mounts the renders surface as the third tab and fetches lazily on activation", async () => {
    const historyPort: HistoryPort = {
      listVersions: vi.fn(async () => pageOf([versionEntry()])),
      listActivity: vi.fn(async () => pageOf([])),
      diff: vi.fn(async () => ({ fromParent: null, summary: "First version." })),
      restore: vi.fn(async () => versionEntry()),
      setLabel: vi.fn(async (_id: string, body: { label: string }) =>
        versionEntry({ label: body.label }),
      ),
      auditExport: vi.fn(async () => ({
        projectId: "prj_demo",
        generatedAt: NOW,
        maxRows: 1000,
        rowCount: 0,
        truncated: false,
        rows: [],
      })),
      manifest: vi.fn(async () => ({
        projectId: "prj_demo",
        currentVersion: {
          id: "ver_demo_4",
          version: 4,
          sha256: "a".repeat(64),
          label: null,
          sizeBytes: 2048,
          createdAt: NOW,
          url: "https://storage.test/signed/ver.ecproj",
        },
        assets: [],
        updatedAt: NOW,
      })),
    };
    const rendersPort = makePort({
      listRenders: vi.fn(async () => pageOf([renderJob({ id: "rnd_w" })])),
    });
    render(
      <HistoryPageView
        projectId="prj_demo"
        projectName="Launch film"
        workspaceId="ws_demo"
        slug="launch-film"
        currentVersionId="ver_demo_4"
        canEdit
        canExport={false}
        nowIso={NOW}
        api={historyPort}
        rendersApi={rendersPort}
      />,
    );
    // Default tab: Versions — renders stay dark (lazy Radix content).
    expect(rendersPort.listRenders).not.toHaveBeenCalled();

    await USER.click(screen.getByTestId("history-tab-renders"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-panel")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-row-rnd_w")).toBeInTheDocument();
    });
    expect(rendersPort.listRenders).toHaveBeenCalledWith({ limit: 25 });
    expect(historyPort.listVersions).toHaveBeenCalled();
  });
});
