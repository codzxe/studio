/**
 * presence.test — the §M7 task 2 surface: the shared heartbeat poller
 * (`use-presence.ts`, M7-B's pinned cadence recipe) + the strip view.
 *
 * Cadence pins (fake timers; the recipe, from the gateway's presence route):
 *   * beat IMMEDIATELY on mount while visible, then every
 *     LEASE_HEARTBEAT_MS (120 s) — the beat response IS the poll;
 *   * `visibilitychange` → hidden PAUSES the timer (zero beats while
 *     hidden, even across several missed intervals);
 *   * → visible beats IMMEDIATELY, then resumes the interval;
 *   * a fresh clientNonce per beat (never reused — this poller waits for
 *     the next tick instead of retrying a beat in place);
 *   * a context failure degrades to a bare `{}` beat; a beat failure keeps
 *     the last viewers rendered + flags `error` (silent, non-blocking);
 *   * unmount/disabled/absent client ⇒ zero beats, zero timers.
 *
 * Strip pins (real timers): data-driven rendering — hostile display names
 * stay inert TEXT (no HTML), the self flag marks your own dot, comp chips
 * + "last seen" ride the tooltip, the +N overflow badge appears past
 * `maxDots`, and an empty viewers list renders nothing.
 */

import { PresenceStrip } from "@/components/presence/presence-strip";
import {
  PRESENCE_BEAT_INTERVAL_MS,
  type PresenceBeatContext,
  type PresenceClient,
  usePresence,
} from "@/components/presence/use-presence";
import type { CallOptions } from "@studio/api-client";
import type {
  PresenceBeatRequest,
  PresenceViewer,
  PresenceViewersResponse,
} from "@studio/contracts";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function viewer(partial: Partial<PresenceViewer> & { userId: string }): PresenceViewer {
  return {
    displayName: "Maya",
    compId: null,
    playheadTicks: null,
    lastSeenAgoMs: 0,
    self: false,
    ...partial,
  };
}

interface BeatRecord {
  readonly projectId: string;
  readonly body: PresenceBeatRequest;
}

/** Assertable accessor for one presence dot (index-safe under strict null checks). */
function dot(index: number): HTMLElement {
  const el = screen.getAllByTestId("presence-viewer")[index];
  if (el === undefined) throw new Error(`presence-viewer ${index} missing`);
  return el;
}

function makeClient(options: { readonly failAfter?: number } = {}): {
  readonly client: PresenceClient;
  readonly beats: BeatRecord[];
} {
  const beats: BeatRecord[] = [];
  let calls = 0;
  const client: PresenceClient = {
    presence: {
      beatPresence: async (
        projectId: string,
        body?: PresenceBeatRequest,
        _options?: CallOptions,
      ): Promise<PresenceViewersResponse> => {
        calls += 1;
        beats.push({ projectId, body: { ...(body ?? {}) } });
        if (options.failAfter !== undefined && calls > options.failAfter) {
          throw new Error("offline");
        }
        return { viewers: [viewer({ userId: `u_${calls}`, displayName: `Viewer ${calls}` })] };
      },
      listPresence: async (
        _projectId: string,
        _options?: CallOptions,
      ): Promise<PresenceViewersResponse> => ({ viewers: [] }),
    },
  };
  return { client, beats };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Let the immediate/microtask beat land under fake timers. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ---------------------------------------------------------------------------
// The shared poller — M7-B's cadence recipe
// ---------------------------------------------------------------------------

describe("usePresence — heartbeat cadence (M7-B recipe)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    // jsdom restore: keep visibilityState readable for later suites.
    setVisibility("visible");
  });

  it("beats immediately on mount, then every LEASE_HEARTBEAT_MS — the response IS the poll", async () => {
    const { client, beats } = makeClient();
    const { result } = renderHook(() => usePresence({ client, projectId: "prj_1" }));

    await flush();
    expect(beats).toHaveLength(1);
    expect(beats[0]?.projectId).toBe("prj_1");
    expect(result.current.viewers).toHaveLength(1);
    expect(result.current.lastBeatAt).not.toBeNull();
    expect(result.current.error).toBe(false);

    await advance(PRESENCE_BEAT_INTERVAL_MS - 1);
    expect(beats).toHaveLength(1); // not yet

    await advance(1);
    expect(beats).toHaveLength(2);
    expect(result.current.viewers[0]?.displayName).toBe("Viewer 2");
  });

  it("PAUSES while the tab is hidden — zero beats across missed intervals", async () => {
    const { client, beats } = makeClient();
    renderHook(() => usePresence({ client, projectId: "prj_1" }));
    await flush();
    await advance(PRESENCE_BEAT_INTERVAL_MS);
    expect(beats).toHaveLength(2);

    setVisibility("hidden");
    await advance(PRESENCE_BEAT_INTERVAL_MS * 3);
    expect(beats).toHaveLength(2); // paused: no fake "I'm here"

    setVisibility("visible");
    await flush();
    expect(beats).toHaveLength(3); // beat IMMEDIATELY on visible…
    await advance(PRESENCE_BEAT_INTERVAL_MS);
    expect(beats).toHaveLength(4); // …then the interval resumes
  });

  it("a tab that mounts hidden beats nothing until it becomes visible", async () => {
    setVisibility("hidden");
    const { client, beats } = makeClient();
    renderHook(() => usePresence({ client, projectId: "prj_1" }));
    await advance(PRESENCE_BEAT_INTERVAL_MS * 2);
    expect(beats).toHaveLength(0);

    setVisibility("visible");
    await flush();
    expect(beats).toHaveLength(1);
  });

  it("sends a FRESH clientNonce per beat (≤ 64 chars, never reused)", async () => {
    const { client, beats } = makeClient();
    renderHook(() => usePresence({ client, projectId: "prj_1" }));
    await flush();
    await advance(PRESENCE_BEAT_INTERVAL_MS);
    await advance(PRESENCE_BEAT_INTERVAL_MS);
    expect(beats).toHaveLength(3);
    const nonces = beats.map((beat) => beat.body.clientNonce);
    for (const nonce of nonces) {
      expect(typeof nonce).toBe("string");
      expect((nonce ?? "").length).toBeLessThanOrEqual(64);
    }
    expect(new Set(nonces).size).toBe(3); // every nonce distinct
  });

  it("the beat body carries the injected context; a context failure degrades to a bare beat", async () => {
    const { client, beats } = makeClient();
    let failContext = true;
    const getContext = async (): Promise<PresenceBeatContext | undefined> => {
      if (failContext) throw new Error("no summary");
      return { compId: "Main" };
    };
    renderHook(() => usePresence({ client, projectId: "prj_1", getContext }));
    await flush();
    expect(beats[0]?.body.compId).toBeUndefined(); // bare beat — still beats

    failContext = false;
    await advance(PRESENCE_BEAT_INTERVAL_MS);
    expect(beats[1]?.body.compId).toBe("Main");
  });

  it("a failed beat keeps the last viewers rendered and flags error (silent, non-blocking)", async () => {
    const { client, beats } = makeClient({ failAfter: 1 });
    const { result } = renderHook(() => usePresence({ client, projectId: "prj_1" }));
    await flush();
    expect(result.current.viewers[0]?.displayName).toBe("Viewer 1");
    expect(result.current.error).toBe(false);

    await advance(PRESENCE_BEAT_INTERVAL_MS);
    expect(beats).toHaveLength(2); // the beat was ATTEMPTED…
    expect(result.current.error).toBe(true); // …and failed…
    expect(result.current.viewers[0]?.displayName).toBe("Viewer 1"); // …stale list stays
  });

  it("disabled or client-less mounts stay dormant; unmount stops the timer", async () => {
    const dormant = makeClient();
    renderHook(() => usePresence({ client: dormant.client, projectId: "prj_1", enabled: false }));
    await advance(PRESENCE_BEAT_INTERVAL_MS * 2);
    expect(dormant.beats).toHaveLength(0);

    const nullClient = makeClient();
    renderHook(() => usePresence({ client: null, projectId: "prj_1" }));
    await advance(PRESENCE_BEAT_INTERVAL_MS * 2);
    expect(nullClient.beats).toHaveLength(0);

    const live = makeClient();
    const mounted = renderHook(() => usePresence({ client: live.client, projectId: "prj_1" }));
    await flush();
    expect(live.beats).toHaveLength(1);
    mounted.unmount();
    await advance(PRESENCE_BEAT_INTERVAL_MS * 3);
    expect(live.beats).toHaveLength(1); // the timer died with the mount
  });
});

// ---------------------------------------------------------------------------
// The strip view
// ---------------------------------------------------------------------------

describe("PresenceStrip — who-is-here chrome", () => {
  it("renders nothing when nobody is viewing", () => {
    const { container } = render(<PresenceStrip viewers={[]} />);
    expect(screen.queryByTestId("presence-strip")).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it("renders one dot per viewer with the self flag and the group label", () => {
    render(
      <PresenceStrip
        viewers={[
          viewer({ userId: "u_maya", displayName: "Maya" }),
          viewer({ userId: "u_me", displayName: "Me", self: true }),
        ]}
      />,
    );
    const strip = screen.getByTestId("presence-strip");
    expect(strip).toHaveAttribute("data-viewer-count", "2");
    expect(strip).toHaveAttribute("aria-label", "2 people are viewing");
    const dots = screen.getAllByTestId("presence-viewer");
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute("data-self", "false");
    expect(dots[1]).toHaveAttribute("data-self", "true");
  });

  it("caps the dots and shows the +N overflow badge", () => {
    render(
      <PresenceStrip
        maxDots={2}
        viewers={[
          viewer({ userId: "u_1" }),
          viewer({ userId: "u_2" }),
          viewer({ userId: "u_3" }),
          viewer({ userId: "u_4" }),
        ]}
      />,
    );
    expect(screen.getAllByTestId("presence-viewer")).toHaveLength(2);
    expect(screen.getByTestId("presence-overflow")).toHaveTextContent("+2");
  });

  it("tooltip carries the display name, the comp chip and 'last seen' (not for self)", async () => {
    render(
      <PresenceStrip
        viewers={[
          viewer({
            userId: "u_maya",
            displayName: "Maya Flow",
            compId: "Main",
            lastSeenAgoMs: 42_000,
          }),
          viewer({ userId: "u_me", displayName: "Me", self: true, compId: "Titles" }),
        ]}
      />,
    );
    const other = dot(0);
    fireEvent.pointerMove(other);
    await waitFor(
      () => {
        expect(screen.getByTestId("presence-viewer-name")).toHaveTextContent("Maya Flow");
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId("presence-viewer-comp")).toHaveTextContent("Main");
    expect(screen.getByText("seen 42s ago")).toBeInTheDocument();

    // Self flips to "You" (self never shows a recency line).
    fireEvent.pointerMove(dot(1));
    await waitFor(
      () => {
        expect(screen.getByText("You")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });

  it("hostile display names ride as inert DATA — never as markup or attributes that execute", () => {
    const hostile = '<img src=x onerror="window.__pwned=1">Alex';
    render(
      <PresenceStrip
        viewers={[viewer({ userId: "u_evil", displayName: hostile, compId: "<b>Main</b>" })]}
      />,
    );
    const strip = screen.getByTestId("presence-strip");
    // The name is TEXT (the avatar's accessible label), not parsed HTML.
    expect(strip.querySelector("img")).toBeNull();
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
    const dot = screen.getByTestId("presence-viewer");
    expect(dot.textContent ?? "").not.toContain("<img");
    const avatar = dot.querySelector('[role="img"]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("aria-label")).toBe(hostile); // data, verbatim
  });

  it("truncates very long comp ids in the chip (data, bounded)", async () => {
    render(
      <PresenceStrip
        viewers={[viewer({ userId: "u_1", compId: "c".repeat(60), lastSeenAgoMs: 5000 })]}
      />,
    );
    fireEvent.pointerMove(dot(0));
    await waitFor(
      () => {
        expect(screen.getByTestId("presence-viewer-comp")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    const chip = screen.getByTestId("presence-viewer-comp");
    expect(chip.textContent ?? "").toHaveLength(18); // 17 chars + the ellipsis
    expect(chip.textContent).not.toBe("c".repeat(60));
  });
});
