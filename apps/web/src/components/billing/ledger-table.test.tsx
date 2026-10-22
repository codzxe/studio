/**
 * LedgerTable + useLedgerPages tests (M6-G) — D-12 µc display exactness, kind
 * badges, running balance, hostile-row safety, cursor load-more (replay-safe
 * + race-guarded), empty/loading/error states. Deterministic RTL; no network.
 */

import type { LedgerEntry, Page } from "@studio/contracts";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LedgerTable,
  formatCreditsDisplay,
  formatLedgerTimestamp,
  formatSignedCredits,
  microcreditsToCreditsDisplay,
  truncateForDisplay,
  useLedgerPages,
} from "./ledger-table";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "led_0001",
    workspaceId: "ws_0001",
    kind: "grant",
    amount: 500_000_000,
    balanceAfter: 500_000_000,
    runId: null,
    idempotencyKey: "idem-1",
    metadata: { source: "monthly" },
    createdAt: "2026-10-21T14:32:05.000Z",
    ...overrides,
  };
}

const USER = userEvent.setup();

// ---------------------------------------------------------------------------
// D-12 display helpers
// ---------------------------------------------------------------------------

describe("µc → credits display math (D-12)", () => {
  it("converts integer microcredits to ≤2-decimal credits exactly", () => {
    expect(microcreditsToCreditsDisplay(500_000_000)).toBe(500);
    expect(microcreditsToCreditsDisplay(123_450_000)).toBe(123.45);
    expect(microcreditsToCreditsDisplay(1_234_500_000)).toBe(1234.5);
    expect(microcreditsToCreditsDisplay(1_200_000)).toBe(1.2);
    expect(microcreditsToCreditsDisplay(0)).toBe(0);
    // Hundredth-of-a-credit rounding (mirrors @studio/config, never throws):
    expect(microcreditsToCreditsDisplay(5_000)).toBe(0.01);
    expect(microcreditsToCreditsDisplay(4_999)).toBe(0);
    // Signed spend rows keep the sign.
    expect(microcreditsToCreditsDisplay(-1_200_000)).toBe(-1.2);
    // Fractional µc (hostile — the wire is integer-only) normalizes.
    expect(microcreditsToCreditsDisplay(1_200_000.7)).toBe(1.2);
  });

  it("degrades hostile numbers to null instead of rendering garbage", () => {
    expect(microcreditsToCreditsDisplay(Number.NaN)).toBeNull();
    expect(microcreditsToCreditsDisplay(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("formats credits with commas and exactly 2 decimals; null → em dash", () => {
    expect(formatCreditsDisplay(1234.5)).toBe("1,234.50");
    expect(formatCreditsDisplay(0.01)).toBe("0.01");
    expect(formatCreditsDisplay(500)).toBe("500.00");
    expect(formatCreditsDisplay(-5)).toBe("-5.00");
    expect(formatCreditsDisplay(null)).toBe("—");
  });

  it("prefixes signed deltas with + / -", () => {
    expect(formatSignedCredits(2000)).toBe("+2,000.00");
    expect(formatSignedCredits(-1.2)).toBe("-1.20");
    expect(formatSignedCredits(null)).toBe("—");
  });

  it("formats ledger timestamps deterministically (UTC) and degrades hostile ISO", () => {
    expect(formatLedgerTimestamp("2026-10-21T14:32:05.000Z")).toBe("Oct 21, 2026, 14:32");
    expect(formatLedgerTimestamp("not-a-date")).toBe("—");
    expect(formatLedgerTimestamp("")).toBe("—");
  });

  it("bounds any display string hard (truncateForDisplay)", () => {
    expect(truncateForDisplay("a".repeat(200)).length).toBe(200);
    const truncated = truncateForDisplay("a".repeat(5000), 200);
    expect(truncated.length).toBe(200);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LedgerTable (pure view)
// ---------------------------------------------------------------------------

describe("LedgerTable", () => {
  it("renders one distinct badge per wire kind (§7.8 tone + label, never colour-only)", () => {
    const kinds: ReadonlyArray<[LedgerEntry["kind"], string, string]> = [
      ["grant", "Grant", "bg-success/10"],
      ["reserve", "Reserve", "bg-ice/10"],
      ["commit", "Commit", "bg-input"],
      ["refund", "Refund", "bg-signal"],
      ["adjust", "Adjust", "bg-warning/10"],
    ];
    for (const [kind, label, tone] of kinds) {
      const { unmount } = render(<LedgerTable entries={[entry({ id: `led-${kind}`, kind })]} />);
      const badge = screen.getByTestId("ledger-row-kind");
      expect(badge).toHaveTextContent(label);
      expect(badge.className).toContain(tone);
      expect(screen.getByTestId("ledger-row")).toHaveAttribute("data-kind", kind);
      unmount();
    }
  });

  it("shows the µc amount (signed, 2 decimals) and the running balance column", () => {
    render(
      <LedgerTable
        entries={[
          entry({ id: "a", kind: "grant", amount: 1_234_500_000, balanceAfter: 1_234_500_000 }),
          entry({ id: "b", kind: "commit", amount: -1_200_000, balanceAfter: 123_450_000 }),
        ]}
      />,
    );
    const amounts = screen.getAllByTestId("ledger-row-amount");
    expect(amounts[0]).toHaveTextContent("+1,234.50");
    expect(amounts[1]).toHaveTextContent("-1.20");
    const balances = screen.getAllByTestId("ledger-row-balance");
    expect(balances[0]).toHaveTextContent("1,234.50");
    expect(balances[1]).toHaveTextContent("123.45");
    // Timestamps render per row.
    expect(screen.getAllByTestId("ledger-row")[0]).toHaveTextContent("Oct 21, 2026, 14:32");
  });

  it("renders the empty state inside the table body, and a loading placeholder", () => {
    const first = render(<LedgerTable entries={[]} />);
    expect(first.getByTestId("ledger-empty")).toHaveTextContent("No credit activity yet.");
    first.unmount();

    render(<LedgerTable entries={[]} loading />);
    expect(screen.getByTestId("ledger-empty")).toHaveTextContent("Loading the ledger…");
  });

  it("wires load-more with the next cursor, disables it while loading, ends politely", async () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <LedgerTable
        entries={[entry()]}
        nextCursor="cursor-1"
        loading={false}
        onLoadMore={onLoadMore}
      />,
    );
    await USER.click(screen.getByTestId("ledger-load-more"));
    expect(onLoadMore).toHaveBeenCalledWith("cursor-1");
    expect(screen.queryByTestId("ledger-end")).not.toBeInTheDocument();

    // In flight: disabled + "Working…" (no double fire).
    rerender(
      <LedgerTable entries={[entry()]} nextCursor="cursor-1" loading onLoadMore={onLoadMore} />,
    );
    const busy = screen.getByTestId("ledger-load-more");
    expect(busy).toBeDisabled();
    expect(busy).toHaveTextContent("Working…");
    await USER.click(busy);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    // End of the log: no button, quiet end note.
    rerender(<LedgerTable entries={[entry()]} nextCursor={null} onLoadMore={onLoadMore} />);
    expect(screen.queryByTestId("ledger-load-more")).not.toBeInTheDocument();
    expect(screen.getByTestId("ledger-end")).toHaveTextContent("That’s the whole ledger.");
  });

  it("is hostile-data-safe: bounded run ids, unknown kinds, NaN amounts, no metadata echo", () => {
    const hostileRunId = "r".repeat(10_000);
    render(
      <LedgerTable
        entries={[
          entry({
            id: "hostile-1",
            kind: "wire-tamper-kind-with-a-very-long-name" as LedgerEntry["kind"],
            amount: Number.NaN,
            balanceAfter: Number.NaN,
            runId: hostileRunId,
            metadata: { evil: "<script>alert(1)</script>" },
          }),
        ]}
      />,
    );
    // Run id bounded to 16 chars with an ellipsis.
    const runCell = screen.getByTestId("ledger-row-run");
    expect(runCell.textContent?.length).toBe(16);
    expect(runCell.textContent?.endsWith("…")).toBe(true);
    // Unknown kind falls back to a NEUTRAL badge with a bounded label.
    const badge = screen.getByTestId("ledger-row-kind");
    expect(badge.className).toContain("bg-input");
    expect(badge.textContent?.length ?? 0).toBeLessThanOrEqual(12);
    // Hostile numbers degrade to the em dash, never "NaN".
    expect(screen.getByTestId("ledger-row-amount")).toHaveTextContent("—");
    expect(screen.getByTestId("ledger-row-balance")).toHaveTextContent("—");
    // Metadata is never rendered; no raw HTML path exists.
    expect(document.body.textContent).not.toContain("<script>");
  });

  it("renders errors as a bounded alert with a wired Try again", async () => {
    const onRetry = vi.fn();
    render(
      <LedgerTable
        entries={[]}
        error={`Ledger unavailable. ${"x".repeat(5000)}`}
        onRetry={onRetry}
      />,
    );
    const strip = screen.getByTestId("ledger-error");
    expect(strip).toHaveAttribute("role", "alert");
    const messageText = strip.querySelector("p")?.textContent ?? "";
    expect(messageText.length).toBeLessThanOrEqual(200);
    expect(messageText).toContain("Ledger unavailable.");
    await USER.click(screen.getByTestId("ledger-error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useLedgerPages (cursor pagination state)
// ---------------------------------------------------------------------------

function page(items: LedgerEntry[], nextCursor: string | null): Page<LedgerEntry> {
  return { items, nextCursor };
}

const ROW_1 = entry({ id: "led-1", amount: 100, balanceAfter: 100 });
const ROW_2 = entry({ id: "led-2", amount: 200, balanceAfter: 300, kind: "commit" });

describe("useLedgerPages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the first page on mount and exposes the next cursor", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page([ROW_1], "cursor-1"));
    const { result } = renderHook(() => useLedgerPages(fetchPage, { pageSize: 25 }));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([ROW_1]);
    expect(result.current.nextCursor).toBe("cursor-1");
    expect(result.current.error).toBeNull();
    expect(fetchPage).toHaveBeenCalledWith({ limit: 25 });
  });

  it("appends the next page on loadMore and never double-fires while in flight", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([ROW_1], "cursor-1"))
      .mockResolvedValueOnce(page([ROW_2], null));
    const { result } = renderHook(() => useLedgerPages(fetchPage));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.loadMore();
    });
    // Replay-safe: a second call while the page is in flight is a no-op.
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.entries).toEqual([ROW_1, ROW_2]);
    expect(result.current.nextCursor).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith({ cursor: "cursor-1", limit: 50 });

    // At the end, loadMore is inert.
    act(() => {
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("drops a stale response that resolves after a newer reload (race guard)", async () => {
    let resolveStale: ((value: Page<LedgerEntry>) => void) | undefined;
    const fetchPage = vi.fn().mockImplementation((query: { cursor?: string }) => {
      if (query.cursor === "cursor-stale") {
        return new Promise<Page<LedgerEntry>>((resolve) => {
          resolveStale = resolve;
        });
      }
      return Promise.resolve(page([ROW_2], "cursor-stale"));
    });

    const { result } = renderHook(() => useLedgerPages(fetchPage));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([ROW_2]);

    // A load-more whose response is slow…
    act(() => {
      result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);

    // …overlapping a reload that wins the sequence…
    act(() => {
      void result.current.reload();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([ROW_2]);

    // …must be ignored when it finally resolves.
    act(() => {
      resolveStale?.(page([ROW_1], null));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.entries).toEqual([ROW_2]);
    expect(result.current.loadingMore).toBe(false);
  });

  it("keeps accumulated rows on a loadMore error and retries the same cursor", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([ROW_1], "cursor-1"))
      .mockRejectedValueOnce(new Error("Network hiccup."))
      .mockResolvedValueOnce(page([ROW_2], null));
    const { result } = renderHook(() => useLedgerPages(fetchPage));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.error).toBe("Network hiccup.");
    expect(result.current.entries).toEqual([ROW_1]);

    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.entries).toEqual([ROW_1, ROW_2]);
  });

  it("retries a failed FIRST page and bounds hostile error shapes", async () => {
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce("a hostile non-Error throw")
      .mockResolvedValueOnce(page([ROW_1], null));
    const { result } = renderHook(() => useLedgerPages(fetchPage));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe("The ledger could not be loaded.");
    expect(result.current.entries).toEqual([]);

    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([ROW_1]);
  });
});
