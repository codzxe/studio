/**
 * lease-banner.test — the §M7 task 3 "Alex is editing" state matrix
 * (BUILD_PLAN §M7 task 3; D-18: additive chrome; D-23: chat stays allowed).
 *
 * ONE scripted api-client drives everything: a queue of `lease-state`
 * responses consumed one poll at a time (mount poll → action re-polls →
 * interval polls), plus recorded request/cancel/acquire calls. Fake timers
 * own the 15 s state poll + the 1 s countdown; a fixed `now` pins the
 * countdown rendering.
 *
 * Pinned matrix:
 *   viewer  → "Viewing — {holder} is editing" + countdown + [Request edit]
 *   queued  → + "You're #N in line" + [Cancel request]
 *   holder  → "You have the edit lease · N requests waiting"
 *   elected → "The edit lease is now yours to take" + [Acquire] (the
 *             electNextHolder flip; NOT armed after the member's own cancel)
 *   free    → hidden
 * plus the read-only gate feed, hostile names as data, error surfacing and
 * the expiry re-poll.
 */

import { type ReadOnlyGateHandle, createReadOnlyGate } from "@/lib/editor-session";
import type { LeaseAcquireResponse } from "@studio/api-client";
import { ApiError } from "@studio/api-client";
import type { LeaseQueueEntry, LeaseStateResponse, MeResponse } from "@studio/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseBannerClient } from "./lease-banner";
import { LeaseBanner, formatLeaseCountdown } from "./lease-banner";

const NOW = 1_700_000_000_000;
const now = (): number => NOW;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function queueEntry(userId: string, displayName: string, atMs = NOW): LeaseQueueEntry {
  return { userId, displayName, queuedAt: iso(atMs) };
}

function holderState(options: {
  readonly name: string;
  readonly msLeft: number;
  readonly youAre: LeaseStateResponse["youAre"];
  readonly queue?: readonly LeaseQueueEntry[];
}): LeaseStateResponse {
  return {
    holder: {
      userId: "u_holder",
      displayName: options.name,
      acquiredAt: iso(NOW - 23_000),
      expiresAt: iso(NOW + options.msLeft),
    },
    queue: options.queue ?? [],
    youAre: options.youAre,
    canAcquire: false,
  };
}

function freeState(options: { readonly canAcquire?: boolean } = {}): LeaseStateResponse {
  return { holder: null, queue: [], youAre: "viewer", canAcquire: options.canAcquire ?? true };
}

const ME: MeResponse = {
  user: { id: "u_me", name: "Me", email: "me@studio.test", role: "user" },
  memberships: [],
  plan: { plan: "trial", creditsBalance: 1, includedCredits: 1, renewsAt: null },
};

interface ScriptedCalls {
  leaseState: number;
  requests: number;
  cancels: number;
  acquires: ReadonlyArray<{ readonly projectId: string; readonly sessionId: string }>;
}

function makeClient(script: {
  /** Consumed one leaseState call at a time; the LAST entry repeats. */
  readonly states: readonly LeaseStateResponse[];
  /** `null` ⇒ me.get rejects (the queuedAt fallback path). */
  readonly me?: MeResponse | null;
  readonly requestError?: unknown;
  readonly cancelError?: unknown;
  readonly acquireResult?: LeaseAcquireResponse;
}): { readonly client: LeaseBannerClient; readonly calls: ScriptedCalls } {
  const calls: {
    leaseState: number;
    requests: number;
    cancels: number;
    acquires: Array<{ projectId: string; sessionId: string }>;
  } = { leaseState: 0, requests: 0, cancels: 0, acquires: [] };
  const client: LeaseBannerClient = {
    leases: {
      acquire: async (
        projectId: string,
        body: { readonly sessionId: string },
      ): Promise<LeaseAcquireResponse> => {
        calls.acquires.push({ projectId, sessionId: body.sessionId });
        return (
          script.acquireResult ?? {
            acquired: true,
            holderName: "Me",
            expiresAt: iso(NOW + 300_000),
            readOnly: false,
          }
        );
      },
      release: async () => ({ released: true, nextHolder: null }),
      leaseState: async (): Promise<LeaseStateResponse> => {
        const last = script.states[script.states.length - 1];
        if (last === undefined) throw new Error("scripted client needs at least one state");
        const index = Math.min(calls.leaseState, script.states.length - 1);
        calls.leaseState += 1;
        return script.states[index] ?? last;
      },
      requestLease: async () => {
        calls.requests += 1;
        if (script.requestError !== undefined) throw script.requestError;
        return {
          queued: true,
          position: 1,
          queueLength: 1,
          queuedAt: iso(NOW),
          duplicate: false,
        };
      },
      cancelLeaseRequest: async () => {
        calls.cancels += 1;
        if (script.cancelError !== undefined) throw script.cancelError;
        return { cancelled: true };
      },
    },
    me: {
      get: async () => {
        if (script.me === null) throw new Error("offline");
        return script.me ?? ME;
      },
    },
  };
  return { client, calls };
}

function renderBanner(
  client: LeaseBannerClient,
  options: {
    readonly gate?: ReadOnlyGateHandle;
    readonly onActiveChange?: (active: boolean) => void;
    readonly onAcquired?: () => void;
    readonly pollIntervalMs?: number;
    /** Default: the FIXED clock; countdown tests pass the advancing fake clock. */
    readonly nowFn?: () => number;
  } = {},
) {
  const gate = options.gate ?? createReadOnlyGate();
  return render(
    <LeaseBanner
      client={client}
      projectId="prj_1"
      gate={gate}
      now={options.nowFn ?? now}
      pollIntervalMs={options.pollIntervalMs ?? 15_000}
      onActiveChange={options.onActiveChange}
      onAcquired={options.onAcquired}
    />,
  );
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW); // the fake clock base for the countdown tests
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Countdown helper
// ---------------------------------------------------------------------------

describe("formatLeaseCountdown", () => {
  it("renders m:ss, clamps at zero and never goes negative", () => {
    expect(formatLeaseCountdown(277_000)).toBe("4:37");
    expect(formatLeaseCountdown(60_000)).toBe("1:00");
    expect(formatLeaseCountdown(1_000)).toBe("0:01");
    expect(formatLeaseCountdown(1)).toBe("0:01"); // ceil to the next second
    expect(formatLeaseCountdown(0)).toBe("0:00");
    expect(formatLeaseCountdown(-5_000)).toBe("0:00");
  });
});

// ---------------------------------------------------------------------------
// The state matrix
// ---------------------------------------------------------------------------

describe("LeaseBanner — viewer / queued / holder states", () => {
  it("viewer: read-only strip with the holder NAME, the countdown and [Request edit]", async () => {
    const gate = createReadOnlyGate();
    const { client, calls } = makeClient({
      states: [holderState({ name: "Alex", msLeft: 277_000, youAre: "viewer" })],
    });
    renderBanner(client, { gate });
    await flush();

    const banner = screen.getByTestId("lease-banner");
    expect(banner).toHaveAttribute("data-youare", "viewer");
    expect(screen.getByTestId("lease-readonly-strip")).toHaveTextContent(
      "Viewing — Alex is editing",
    );
    expect(screen.getByTestId("lease-countdown")).toHaveTextContent("4:37 left");
    expect(screen.getByTestId("lease-request-button")).toBeEnabled();

    // The read-only gate follows the poll (the client enforcement feed).
    expect(gate.gate.isBlocked()).toBe(true);
    expect(gate.gate.holderName()).toBe("Alex");
    expect(calls.leaseState).toBe(1); // one mount poll, nothing else
  });

  it("the countdown ticks down at 1 Hz while another member holds", async () => {
    const { client } = makeClient({
      states: [holderState({ name: "Alex", msLeft: 120_000, youAre: "viewer" })],
    });
    renderBanner(client, { nowFn: () => Date.now() });
    await flush();
    expect(screen.getByTestId("lease-countdown")).toHaveTextContent("2:00 left");
    await flush(61_000);
    expect(screen.getByTestId("lease-countdown")).toHaveTextContent("0:59 left");
  });

  it("holder: 'You have the edit lease · N requests waiting' (and no queue line when empty)", async () => {
    const { client } = makeClient({
      states: [
        holderState({
          name: "Me",
          msLeft: 240_000,
          youAre: "holder",
          queue: [queueEntry("u_alex", "Alex"), queueEntry("u_dana", "Dana Flow")],
        }),
      ],
    });
    const gate = createReadOnlyGate();
    renderBanner(client, { gate });
    await flush();

    expect(screen.getByTestId("lease-holder-status")).toHaveTextContent(
      "You have the edit lease · 2 requests waiting",
    );
    // The holder is never blocked by their own lease.
    expect(gate.gate.isBlocked()).toBe(false);
    expect(screen.queryByTestId("lease-request-button")).not.toBeInTheDocument();
  });

  it("holder with an empty queue: the plain line, no requests fragment", async () => {
    const { client } = makeClient({
      states: [holderState({ name: "Me", msLeft: 240_000, youAre: "holder", queue: [] })],
    });
    renderBanner(client);
    await flush();
    const line = screen.getByTestId("lease-holder-status");
    expect(line).toHaveTextContent("You have the edit lease");
    expect(line.textContent ?? "").not.toContain("requests waiting");
  });

  it("free + never queued: the banner stays hidden and the gate opens", async () => {
    const onActiveChange = vi.fn();
    const gate = createReadOnlyGate();
    const { client } = makeClient({ states: [freeState()] });
    renderBanner(client, { gate, onActiveChange });
    await flush();

    expect(screen.queryByTestId("lease-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lease-takeover-toast")).not.toBeInTheDocument();
    expect(gate.gate.isBlocked()).toBe(false);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("hostile holder names render as inert text (data, never markup)", async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">Alex';
    const { client } = makeClient({
      states: [holderState({ name: hostile, msLeft: 60_000, youAre: "viewer" })],
    });
    renderBanner(client);
    await flush();

    const strip = screen.getByTestId("lease-readonly-strip");
    expect(strip.querySelector("img")).toBeNull();
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(strip).toHaveTextContent(hostile); // the raw name as text
  });
});

// ---------------------------------------------------------------------------
// Request / cancel flows (the edit-request queue)
// ---------------------------------------------------------------------------

describe("LeaseBanner — request edit / cancel request", () => {
  it("Request edit joins the queue: position from MY queue entry, cancel appears", async () => {
    const { client, calls } = makeClient({
      states: [
        holderState({ name: "Alex", msLeft: 240_000, youAre: "viewer" }),
        holderState({
          name: "Alex",
          msLeft: 240_000,
          youAre: "queued",
          queue: [queueEntry("u_me", "Me")],
        }),
      ],
    });
    renderBanner(client);
    await flush();

    fireEvent.click(screen.getByTestId("lease-request-button"));
    await flush();

    expect(calls.requests).toBe(1);
    expect(calls.cancels).toBe(0);
    const line = screen.getByTestId("lease-queue-line");
    expect(line).toHaveTextContent("You're #1 in line");
    expect(screen.getByTestId("lease-cancel-request-button")).toBeEnabled();
    expect(screen.queryByTestId("lease-request-button")).not.toBeInTheDocument();
  });

  it("the queued position counts the people ahead (me.get resolves my entry)", async () => {
    const { client } = makeClient({
      states: [
        holderState({
          name: "Alex",
          msLeft: 240_000,
          youAre: "queued",
          queue: [
            queueEntry("u_alex", "Alex"),
            queueEntry("u_dana", "Dana Flow"),
            queueEntry("u_me", "Me"),
          ],
        }),
      ],
    });
    renderBanner(client);
    await flush();
    expect(screen.getByTestId("lease-queue-line")).toHaveTextContent("You're #3 in line");
  });

  it("without me.get, my own requestLease queuedAt still finds the position (the fallback)", async () => {
    const { client } = makeClient({
      me: null,
      states: [
        holderState({ name: "Alex", msLeft: 240_000, youAre: "viewer" }),
        holderState({
          name: "Alex",
          msLeft: 240_000,
          youAre: "queued",
          // queuedAt matches the scripted requestLease response (iso(NOW));
          // the OTHER waiter queued earlier, so the fallback picks #2.
          queue: [queueEntry("u_other", "Other", NOW - 60_000), queueEntry("u_me", "Me", NOW)],
        }),
      ],
    });
    renderBanner(client);
    await flush();
    fireEvent.click(screen.getByTestId("lease-request-button"));
    await flush();
    expect(screen.getByTestId("lease-queue-line")).toHaveTextContent("You're #2 in line");
  });

  it("Cancel request leaves the queue and returns the Request edit button", async () => {
    const { client, calls } = makeClient({
      states: [
        holderState({
          name: "Alex",
          msLeft: 240_000,
          youAre: "queued",
          queue: [queueEntry("u_me", "Me")],
        }),
        holderState({ name: "Alex", msLeft: 240_000, youAre: "viewer" }),
        freeState(),
      ],
    });
    renderBanner(client);
    await flush();

    fireEvent.click(screen.getByTestId("lease-cancel-request-button"));
    await flush();

    expect(calls.cancels).toBe(1);
    expect(screen.getByTestId("lease-request-button")).toBeEnabled();

    // The cancel distinction: the NEXT free flip is NOT an election — no toast.
    await flush(15_000); // the interval poll serves the free state
    expect(screen.queryByTestId("lease-takeover-toast")).not.toBeInTheDocument();
  });

  it("a failed request surfaces the typed server copy inline (QUOTA_EXCEEDED et al.)", async () => {
    const quotaError = new ApiError({
      code: "QUOTA_EXCEEDED",
      message: "The edit queue is full right now.",
      status: 429,
    });
    const { client } = makeClient({
      states: [holderState({ name: "Alex", msLeft: 240_000, youAre: "viewer" })],
      requestError: quotaError,
    });
    renderBanner(client);
    await flush();

    fireEvent.click(screen.getByTestId("lease-request-button"));
    await flush();

    expect(screen.getByTestId("lease-banner-error")).toHaveTextContent(
      "The edit queue is full right now.",
    );
  });
});

// ---------------------------------------------------------------------------
// The expiry takeover (the electNextHolder state flip)
// ---------------------------------------------------------------------------

describe("LeaseBanner — expiry takeover toast + Acquire", () => {
  it("queued → free flips into 'The edit lease is now yours to take' with an Acquire action", async () => {
    const onAcquired = vi.fn();
    const gate = createReadOnlyGate();
    const { client, calls } = makeClient({
      states: [
        holderState({
          name: "Alex",
          msLeft: 240_000,
          youAre: "queued",
          queue: [queueEntry("u_me", "Me")],
        }),
        freeState({ canAcquire: true }),
        holderState({ name: "Me", msLeft: 240_000, youAre: "holder" }),
      ],
    });
    renderBanner(client, { gate, onAcquired });
    await flush();
    expect(screen.getByTestId("lease-queue-line")).toHaveTextContent("You're #1 in line");

    await flush(15_000); // the interval poll observes the election
    const toast = screen.getByTestId("lease-takeover-toast");
    expect(toast).toBeInTheDocument();
    expect(screen.getByTestId("lease-takeover-line")).toHaveTextContent(
      "The edit lease is now yours to take",
    );
    expect(gate.gate.isBlocked()).toBe(false); // free lease: nothing blocks

    fireEvent.click(screen.getByTestId("lease-acquire-button"));
    await flush();

    expect(calls.acquires).toHaveLength(1);
    expect(calls.acquires[0]?.projectId).toBe("prj_1");
    expect((calls.acquires[0]?.sessionId ?? "").length).toBeGreaterThanOrEqual(8); // §7.2 session id
    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("lease-holder-status")).toHaveTextContent("You have the edit lease");
    expect(screen.queryByTestId("lease-takeover-toast")).not.toBeInTheDocument();
  });

  it("the takeover toast is dismissible and does not come back for the same election", async () => {
    const { client } = makeClient({
      states: [
        holderState({
          name: "Alex",
          msLeft: 240_000,
          youAre: "queued",
          queue: [queueEntry("u_me", "Me")],
        }),
        freeState({ canAcquire: true }),
      ],
    });
    renderBanner(client);
    await flush();
    await flush(15_000);
    expect(screen.getByTestId("lease-takeover-toast")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("lease-takeover-dismiss"));
    await flush(15_000); // later polls keep the lease free — still dismissed
    expect(screen.queryByTestId("lease-takeover-toast")).not.toBeInTheDocument();
  });

  it("a member who never queued never sees the takeover toast", async () => {
    const { client } = makeClient({
      states: [
        holderState({ name: "Alex", msLeft: 240_000, youAre: "viewer" }),
        freeState({ canAcquire: true }),
      ],
    });
    renderBanner(client);
    await flush();
    await flush(15_000);
    expect(screen.queryByTestId("lease-takeover-toast")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Expiry + polling behavior
// ---------------------------------------------------------------------------

describe("LeaseBanner — expiry, focus and poll hygiene", () => {
  it("a countdown past zero re-polls immediately (the gateway's lazy expiry election)", async () => {
    const { client, calls } = makeClient({
      states: [holderState({ name: "Alex", msLeft: 5_000, youAre: "viewer" }), freeState()],
    });
    renderBanner(client, { nowFn: () => Date.now() });
    await flush();
    expect(calls.leaseState).toBe(1);
    expect(screen.getByTestId("lease-countdown")).toHaveTextContent("0:05 left");

    await flush(6_000); // the 1 Hz ticker crosses the expiry
    await flush(0); // let the expiry re-poll settle (no interval fires at 15 s)
    expect(calls.leaseState).toBe(2); // exactly the mount poll + the expiry re-poll
    // The free state hides the chrome and opens the gate.
    expect(screen.queryByTestId("lease-banner")).not.toBeInTheDocument();
  });

  it("an expired holder stops blocking the gate even mid-poll", async () => {
    const gate = createReadOnlyGate();
    const { client } = makeClient({
      states: [holderState({ name: "Alex", msLeft: -1_000, youAre: "viewer" })],
    });
    renderBanner(client, { gate });
    await flush();
    expect(gate.gate.isBlocked()).toBe(false); // expiresAt already past
    expect(screen.getByTestId("lease-countdown")).toHaveTextContent("expiring…");
  });

  it("window focus re-polls (a focused tab races less)", async () => {
    const { client, calls } = makeClient({
      states: [holderState({ name: "Alex", msLeft: 240_000, youAre: "viewer" })],
    });
    renderBanner(client);
    await flush();
    expect(calls.leaseState).toBe(1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(calls.leaseState).toBe(2);
  });

  it("onActiveChange tracks chrome visibility", async () => {
    const onActiveChange = vi.fn();
    const { client } = makeClient({
      states: [holderState({ name: "Alex", msLeft: 240_000, youAre: "viewer" })],
    });
    renderBanner(client, { onActiveChange });
    await flush();
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("a client-less banner stays dormant (no polls, no chrome, no gate writes)", async () => {
    const gate = createReadOnlyGate();
    render(
      <LeaseBanner client={null} projectId="prj_1" gate={gate} now={now} pollIntervalMs={15_000} />,
    );
    await flush(60_000);
    expect(screen.queryByTestId("lease-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lease-takeover-toast")).not.toBeInTheDocument();
    expect(gate.gate.isBlocked()).toBe(false);
  });
});
