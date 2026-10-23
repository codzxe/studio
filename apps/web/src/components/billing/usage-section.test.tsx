/**
 * UsageSection tests (W2-08/W3-H) — the §8.8 "Usage" card:
 *
 * - the mounted UsageMeters kit: credits used (NET commits − refunds, D-12
 *   integer µc) vs the monthly allowance, the healthy / ≥90% warning /
 *   ≥100% exhausted arms, seats when the page carries a count;
 * - the storage/render-minute gateway gap: those rows degrade to "—" and a
 *   stated gap note — NEVER a fabricated used number (there is no used-bytes
 *   read; per-plan storageBytes is enforced at upload only);
 * - the per-project "Latest renders" table from `renders.list` (grouped by
 *   projectId; status/format/credits/size columns), the honest empty state,
 *   loading skeletons and the error-retry path;
 * - the commit/refund ledger summary over the SHARED ledger page with the
 *   honest "Latest ledger entries" window label (billing.state carries
 *   currentPeriodEnd only — no period start, so no "this cycle" claim).
 *
 * Deterministic RTL; the port fetchers are faked; no network.
 */

import type { BillingState, LedgerEntry, Page, RenderJob } from "@studio/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  type UsageLedgerSlice,
  UsageSection,
  groupRendersByProject,
  summarizeLedgerUsage,
} from "./usage-section";

// ---------------------------------------------------------------------------
// Fixtures (the real §7.2 / §8.8 wire shapes)
// ---------------------------------------------------------------------------

const STATE: BillingState = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: "2026-11-01T00:00:00Z",
  trialEnd: null,
  cancelAtPeriodEnd: false,
  graceEnd: null,
  entitlements: {
    seats: 5,
    models: ["studio-fast", "studio-smart"],
    maxProjects: 50,
    storageBytes: 200 * 1024 ** 3,
    renderMinutesPerMonth: 600,
    monthlyCreditAllowance: 2_000_000_000, // 2,000 credits in µc (D-12)
  },
  credits: { balance: 12_345_678, reserved: 250_000 },
  topUpPacks: [{ packId: "credits500", credits: 500 }],
};

function ledgerEntry(
  kind: LedgerEntry["kind"],
  amountMicrocredits: number,
  id: string,
  createdAt = "2026-10-21T09:00:00Z",
): LedgerEntry {
  return {
    id,
    workspaceId: "ws_first",
    kind,
    amount: amountMicrocredits,
    balanceAfter: 0,
    runId: null,
    idempotencyKey: `${id}-key`,
    metadata: {},
    createdAt,
  };
}

/** The shared ledger slice the page already fetched. */
function ledgerSlice(
  entries: readonly LedgerEntry[],
  overrides: Partial<UsageLedgerSlice> = {},
): UsageLedgerSlice {
  return { entries, loading: false, error: null, ...overrides };
}

function renderJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: "rend_1",
    projectId: "proj_alpha",
    compId: "comp_main",
    versionId: "ver_1",
    format: "mp4",
    settings: {},
    status: "completed",
    cancelRequested: false,
    progress: { framesDone: 240, framesTotal: 240, percent: 100 },
    credits: 14,
    resultUrl: "https://cdn.test/render.mp4",
    errorCode: null,
    error: null,
    sizeBytes: 13_000_000,
    createdBy: "user_1",
    createdAt: "2026-10-20T10:00:00Z",
    startedAt: "2026-10-20T10:00:05Z",
    completedAt: "2026-10-20T10:02:00Z",
    expiresAt: "2026-11-20T10:00:00Z",
    ...overrides,
  };
}

const RENDERS_PAGE: Page<RenderJob> = {
  items: [
    renderJob({ id: "rend_1", projectId: "proj_alpha", createdAt: "2026-10-20T10:00:00Z" }),
    renderJob({
      id: "rend_2",
      projectId: "proj_alpha",
      format: "png-seq",
      status: "failed",
      credits: null,
      sizeBytes: null,
      errorCode: "RENDER_TIMEOUT",
      createdAt: "2026-10-19T09:00:00Z",
    }),
    renderJob({
      id: "rend_3",
      projectId: "proj_beta",
      format: "gif",
      status: "running",
      credits: 0.25,
      sizeBytes: null,
      createdAt: "2026-10-21T08:00:00Z",
    }),
  ],
  nextCursor: "cur_older",
};

function rendersFetcher(
  implementations: Array<Page<RenderJob> | Error> = [RENDERS_PAGE],
): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const impl of implementations) {
    if (impl instanceof Error) mock.mockRejectedValueOnce(impl);
    else mock.mockResolvedValueOnce(impl);
  }
  return mock;
}

function view(
  overrides: {
    readonly ledger?: UsageLedgerSlice;
    readonly renders?: ReturnType<typeof vi.fn>;
    readonly seatsUsed?: number;
    readonly onTopUp?: () => void;
  } = {},
): ReturnType<typeof render> {
  return render(
    <UsageSection
      state={STATE}
      ledger={overrides.ledger ?? ledgerSlice([])}
      renders={overrides.renders ?? rendersFetcher()}
      seatsUsed={overrides.seatsUsed}
      onTopUp={overrides.onTopUp}
    />,
  );
}

const USER = userEvent.setup();

// ---------------------------------------------------------------------------
// summarizeLedgerUsage (pure) — commits spend, refunds return
// ---------------------------------------------------------------------------

describe("summarizeLedgerUsage", () => {
  it("rolls up commits and refunds and nets the spent side (floor 0)", () => {
    const summary = summarizeLedgerUsage([
      ledgerEntry("grant", 2_000_000_000, "led_1"),
      ledgerEntry("reserve", -600_000_000, "led_2"),
      ledgerEntry("commit", -600_000_000, "led_3"),
      ledgerEntry("refund", 100_000_000, "led_4"),
      ledgerEntry("adjust", -1, "led_5"),
    ]);
    expect(summary.committedMicrocredits).toBe(600_000_000);
    expect(summary.refundedMicrocredits).toBe(100_000_000);
    expect(summary.commitCount).toBe(1);
    expect(summary.refundCount).toBe(1);
    expect(summary.netCommittedMicrocredits).toBe(500_000_000);
  });

  it("never lets a refund whose commit is on an older page go negative", () => {
    const summary = summarizeLedgerUsage([ledgerEntry("refund", 100_000_000, "led_1")]);
    expect(summary.netCommittedMicrocredits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// groupRendersByProject (pure)
// ---------------------------------------------------------------------------

describe("groupRendersByProject", () => {
  it("groups newest-first rows by projectId, preserving first-seen order", () => {
    const groups = groupRendersByProject(RENDERS_PAGE.items);
    expect(groups.map((group) => group.projectId)).toEqual(["proj_alpha", "proj_beta"]);
    expect(groups[0]?.renders.map((job) => job.id)).toEqual(["rend_1", "rend_2"]);
    expect(groups[1]?.renders).toHaveLength(1);
  });

  it("quarantines hostile project ids into one group instead of crashing", () => {
    const groups = groupRendersByProject([
      renderJob({ id: "r1", projectId: "" }),
      renderJob({ id: "r2", projectId: "" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projectId).toBe("unknown");
    expect(groups[0]?.renders).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The meters (UsageMeters mounted — W2-08's reason to exist)
// ---------------------------------------------------------------------------

describe("UsageSection — meters", () => {
  it("drives the credits meter from net commits vs the allowance (healthy arm)", () => {
    view({ ledger: ledgerSlice([ledgerEntry("commit", -500_000_000, "led_1")]) });
    const credits = screen.getByTestId("usage-meter-credits");
    expect(credits).toHaveTextContent("500.00 of 2,000.00 credits");
    expect(credits).toHaveAttribute("data-state", "healthy");
  });

  it("marks the ≥90% warning arm (Nearing limit)", () => {
    view({ ledger: ledgerSlice([ledgerEntry("commit", -1_800_000_000, "led_1")]) });
    const credits = screen.getByTestId("usage-meter-credits");
    expect(credits).toHaveAttribute("data-state", "warning");
    expect(credits).toHaveTextContent("Nearing limit");
    expect(credits).toHaveTextContent("1,800.00 of 2,000.00 credits");
  });

  it("marks the ≥100% exhausted arm (Allowance used) and wires the top-up CTA", async () => {
    const onTopUp = vi.fn();
    view({
      ledger: ledgerSlice([ledgerEntry("commit", -2_100_000_000, "led_1")]),
      onTopUp,
    });
    const credits = screen.getByTestId("usage-meter-credits");
    expect(credits).toHaveAttribute("data-state", "exhausted");
    // Allowance copy, not "out of credits" — top-ups may still exist.
    expect(credits).toHaveTextContent("Allowance used");
    await USER.click(screen.getByTestId("usage-topup"));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  it("shows seats when the page carries a count, and the honest unknown otherwise", () => {
    const first = view({ ledger: ledgerSlice([]), seatsUsed: 3 });
    expect(screen.getByTestId("usage-meter-seats")).toHaveTextContent("3 / 5 seats");
    first.unmount();

    view({ ledger: ledgerSlice([]) });
    expect(screen.getByTestId("usage-meter-seats")).toHaveTextContent("— / 5 seats");
  });

  it("never fakes the storage or render-minute meters — no used-bytes read exists", () => {
    view({ ledger: ledgerSlice([ledgerEntry("commit", -500_000_000, "led_1")]) });
    // The gateway gap: per-plan storageBytes is enforced at upload only, so
    // those rows degrade to the designed unknown instead of a fabricated 0.
    const storage = screen.getByTestId("usage-meter-storage");
    expect(storage).toHaveTextContent("— of 200 GB");
    expect(storage).not.toHaveTextContent("0 B");
    expect(screen.getByTestId("usage-meter-render")).toHaveTextContent("— / 600 min");
    expect(screen.getByTestId("usage-meter-gap-note")).toHaveTextContent(/enforced per upload/);
  });

  it("holds the credits meter at its unknown while the shared ledger page loads", () => {
    view({ ledger: ledgerSlice([], { loading: true }) });
    const credits = screen.getByTestId("usage-meter-credits");
    expect(credits).toHaveTextContent("—");
    expect(credits).toHaveAttribute("data-state", "healthy");
    expect(screen.getByTestId("usage-ledger-loading")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The renders table
// ---------------------------------------------------------------------------

describe("UsageSection — renders table", () => {
  it("groups the newest page by project with status/format/credits/size columns", async () => {
    view({ ledger: ledgerSlice([]) });
    const table = await screen.findByTestId("usage-renders-table");
    const groups = within(table).getAllByTestId("usage-renders-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("Project proj_alpha · 2 renders");
    expect(groups[1]).toHaveTextContent("Project proj_beta · 1 render");

    const rows = within(table).getAllByTestId("usage-render-row");
    expect(rows).toHaveLength(3);
    const first = rows[0];
    if (first === undefined) throw new Error("expected the first render row");
    expect(within(first).getByTestId("usage-render-status")).toHaveTextContent("Completed");
    expect(within(first).getByTestId("usage-render-format")).toHaveTextContent("MP4");
    expect(within(first).getByTestId("usage-render-credits")).toHaveTextContent("14");
    expect(within(first).getByTestId("usage-render-size")).toHaveTextContent("12.4 MB");

    // Unpriced/unrendered cells degrade to the em dash, never a fake value.
    const failed = rows[1];
    if (failed === undefined) throw new Error("expected the failed render row");
    expect(within(failed).getByTestId("usage-render-status")).toHaveTextContent("Failed");
    expect(within(failed).getByTestId("usage-render-credits")).toHaveTextContent("—");
    expect(within(failed).getByTestId("usage-render-size")).toHaveTextContent("—");
  });

  it("shows the honest empty state when the workspace has no renders", async () => {
    view({ ledger: ledgerSlice([]), renders: rendersFetcher([{ items: [], nextCursor: null }]) });
    expect(await screen.findByTestId("usage-renders-empty")).toHaveTextContent("No renders yet.");
    expect(screen.queryByTestId("usage-renders-table")).not.toBeInTheDocument();
  });

  it("skeletons the table while the first renders page is in flight", () => {
    const pending = vi.fn().mockImplementation(() => new Promise<Page<RenderJob>>(() => undefined));
    view({ ledger: ledgerSlice([]), renders: pending });
    expect(pending).toHaveBeenCalledWith({ limit: 50 });
    expect(screen.getByTestId("usage-renders-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-renders-table")).not.toBeInTheDocument();
  });

  it("surfaces a fetch error with a retry that recovers the table", async () => {
    const fetcher = rendersFetcher([new Error("The renders service is down"), RENDERS_PAGE]);
    view({ ledger: ledgerSlice([]), renders: fetcher });
    const error = await screen.findByTestId("usage-renders-error");
    expect(error).toHaveTextContent("The renders service is down");
    expect(screen.queryByTestId("usage-renders-table")).not.toBeInTheDocument();

    await USER.click(screen.getByTestId("usage-renders-retry"));
    expect(await screen.findByTestId("usage-renders-table")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ limit: 50 });
  });
});

// ---------------------------------------------------------------------------
// The ledger summary — the honest window label
// ---------------------------------------------------------------------------

describe("UsageSection — ledger summary", () => {
  it("summarizes commits and refunds across the loaded rows, labeled honestly", () => {
    view({
      ledger: ledgerSlice([
        ledgerEntry("commit", -18_750_000, "led_1"),
        ledgerEntry("refund", 750_000, "led_2"),
        ledgerEntry("grant", 2_000_000_000, "led_3"),
      ]),
    });
    expect(screen.getByTestId("usage-ledger-committed")).toHaveTextContent("18.75 credits");
    expect(screen.getByTestId("usage-ledger-refunded")).toHaveTextContent("0.75 credits");
    // billing.state carries currentPeriodEnd only — no period start — so the
    // window is labeled "Latest ledger entries", never "this cycle".
    expect(screen.getByTestId("usage-ledger-title")).toHaveTextContent("Latest ledger entries");
    expect(screen.getByTestId("usage-ledger-window")).toHaveTextContent(/3 newest ledger rows/);
  });

  it("degrades to honest copy when the shared ledger read failed", () => {
    view({ ledger: ledgerSlice([], { error: "The ledger could not be loaded." }) });
    expect(screen.getByTestId("usage-ledger-error")).toHaveTextContent(
      "The credit ledger could not be loaded",
    );
    expect(screen.getByTestId("usage-meter-credits")).toHaveTextContent("—");
    expect(screen.queryByTestId("usage-ledger-summary")).not.toBeInTheDocument();
  });
});
