import StatusPage, { metadata } from "@/app/(marketing)/status/page";
import { StatusBoard } from "@/components/marketing/status-board";
import { brandViolations } from "@studio/config";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /status contract (M9-E, AUD-5): the board fetches the REAL public health
 * route (`GET /v1/health`, same-origin — capability flags `{ status, db,
 * version }`, NOT a §7.3 envelope) and only ever renders verified states.
 * While loading or unreachable it stays at “Checking…”; there are no uptime
 * percentages and no incident history. Fetch is stubbed per test, including
 * the unreachable case and the manual re-check.
 */

function healthResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const HEALTHY = { status: "ok", db: true, version: "0.1.0" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("status page", () => {
  it("has status metadata and the honest static sections (§8.11 pattern)", () => {
    expect(metadata.title).toBe("Status");
    expect((metadata.description ?? "").length).toBeGreaterThan(0);
    render(<StatusPage />);
    expect(screen.getByTestId("status-page")).toBeInTheDocument();
    expect(screen.getByTestId("status-board")).toBeInTheDocument();
    // §8.11 maintenance pattern: the state, an ETA only when known, no countdowns.
    expect(screen.getByText("Nothing is scheduled right now.")).toBeInTheDocument();
    expect(screen.getByText(/no countdowns/i)).toBeInTheDocument();
    expect(screen.getByText("No incident archive yet.")).toBeInTheDocument();
    expect(screen.getByText(/do not publish uptime percentages/i)).toBeInTheDocument();
  });

  it("contains no invented metrics anywhere on the page", () => {
    const { container } = render(<StatusPage />);
    const text = container.textContent ?? "";
    expect(brandViolations(text)).toEqual([]);
    expect(text).not.toContain("99.9");
    expect(text.toLowerCase()).not.toContain("all systems operational");
  });

  it("renders a verified healthy board inside its live-check section", async () => {
    const fetchMock = vi.fn(async () => healthResponse(HEALTHY));
    vi.stubGlobal("fetch", fetchMock);
    render(<StatusPage />);
    const board = screen.getByTestId("status-board");
    await waitFor(() => {
      expect(within(board).getByText("Reachable")).toBeInTheDocument();
    });
    expect(within(board).getByText("Connected")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/v1/health", { cache: "no-store" });
  });
});

describe("status board (live /v1/health check)", () => {
  it("shows “Checking…” while the first check is in flight, then the verified state", async () => {
    let resolve!: (value: Response) => void;
    const gate = new Promise<Response>((res) => {
      resolve = res;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => gate),
    );
    render(<StatusBoard />);

    // Unverified: both rows + the live line stay honest at “Checking…”.
    expect(screen.getAllByText("Checking…").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("Reachable")).not.toBeInTheDocument();

    resolve(healthResponse(HEALTHY));
    await waitFor(() => {
      expect(screen.getByText("Reachable")).toBeInTheDocument();
    });
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/Last checked \d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
  });

  it("reports a degraded database when the gateway answers but the database does not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ status: "ok", db: false, version: "0.1.0" })),
    );
    render(<StatusBoard />);
    await waitFor(() => {
      expect(screen.getByText("Reachable")).toBeInTheDocument();
    });
    expect(screen.getByText("Degraded — not answering")).toBeInTheDocument();
    expect(
      screen.getByText(/Sign-in, saving and renders may fail until it recovers/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("stays at “Checking…” when unreachable, explains why, and re-checks on demand", async () => {
    const user = userEvent.setup();
    let failing = true;
    const fetchMock = vi.fn(async () => {
      if (failing) throw new TypeError("network down");
      return healthResponse(HEALTHY);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StatusBoard />);

    await waitFor(() => {
      expect(screen.getByTestId("status-unreachable-note")).toBeInTheDocument();
    });
    expect(screen.queryByText("Reachable")).not.toBeInTheDocument();
    // No unverified "operational" claim; the last answer still shows a stamp.
    expect(screen.queryByText(/Operational/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Checking…").length).toBeGreaterThanOrEqual(2);

    // Manual refresh: the second attempt succeeds and the state updates.
    failing = false;
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(screen.getByText("Reachable")).toBeInTheDocument();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a non-200 health answer as unreachable — never as healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ error: { code: "SERVICE_UNAVAILABLE" } }, 503)),
    );
    render(<StatusBoard />);
    await waitFor(() => {
      expect(screen.getByTestId("status-unreachable-note")).toBeInTheDocument();
    });
    expect(screen.queryByText("Reachable")).not.toBeInTheDocument();
  });

  it("validates the capability-flags body shape: a malformed 2xx body is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ hello: "world" })),
    );
    render(<StatusBoard />);
    await waitFor(() => {
      expect(screen.getByTestId("status-unreachable-note")).toBeInTheDocument();
    });
    expect(screen.queryByText("Reachable")).not.toBeInTheDocument();
  });
});
