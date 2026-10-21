/**
 * Run timeline tests (W8-T) — step list rendering from a scripted §13.2 event
 * sequence, asserted at BOTH layers that build the page:
 *
 *   - the pure fold (parseRunEvent → mergeRunEvent → deriveTimeline), driven
 *     table-style through all 13 §13.2 event types (api.ts RUN_EVENT_TYPES
 *     mirror), plus the defensive skips and the §13.2 high-water dedupe;
 *   - the hook (use-run-events) against a fake RunEventStream — the REAL
 *     gateway client streaming over a queued fake fetch (reconnectDelayMs: 0),
 *     so the wire semantics exercised are production code, not a hand mock.
 *
 * Hook-level scenarios: the full 13-event run (rendered order, counts,
 * verdict cards, terminal handling, single onTerminal), the run.resync
 * resync sentinel (skipped as an event, resumed from, gap healed, replay
 * deduped), and a typed 4xx envelope surfacing as a friendly error state.
 * Deterministic: fixed timestamps, no network, no timers awaited > 2 s.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CritiqueVerdictCard, ValidateVerdictCard } from "../src/components/runs/verdict-card";
import { Timeline } from "../src/components/runs/timeline";
import { useRunEvents } from "../src/components/runs/use-run-events";
import {
  deriveTimeline,
  mergeRunEvent,
  orderedRunEvents,
  parseRunEvent,
  type ParsedRunEvent,
  type RunEventStore,
  type RunTimeline,
  type WireEventInput,
} from "../src/components/runs/timeline-state";
import {
  TERMINAL_RUN_EVENT_TYPES,
  createGatewayClient,
  type FetchLike,
  type GatewayClient,
} from "../src/lib/api";

// ---------------------------------------------------------------------------
// Fixtures — deterministic wire events (§13.2 `{ seq, run_id, at, type, payload }`)
// ---------------------------------------------------------------------------

const RUN_ID = "run_018f";
const BASE_URL = "http://gateway.test/v1";
const AT_MS = Date.parse("2026-07-04T12:00:00.000Z");

function wireEvent(seq: number, type: string, payload: unknown): WireEventInput {
  return { seq, type, payload, at: new Date(AT_MS + seq * 1000).toISOString() };
}

const PLAN_WIRE = {
  intent: "create_post",
  template: null,
  assets: [{ ref: "asset_1", slot: "hero" }],
  slots: { headline: "Espresso Week" },
  palette: ["#1f2937", "#f59e0b"],
  typography: { headline: { family: "brand", weight: 700 } },
  steps: [{ tool: "select_layers" }, { tool: "add_text_layer" }],
  checks: ["contrast", "text-overlap"],
  model_tier: "standard",
  notes_for_user: "Two-step plan.",
};

const CRITIQUE_WIRE = {
  verdict: "revise",
  scores: { hierarchy: 4, balance: 4, contrast: 3, brief_adherence: 5, brand_fit: 4, editability: 5 },
  issues: [
    {
      severity: "major",
      code: "cr.contrast.low",
      layer: "headline",
      observation: "Contrast between headline and photo is low.",
      fix: "Darken the headline text.",
    },
  ],
};

/** All 13 §13.2 types in one plausible run order — the scripted sequence. */
const FULL_SCRIPT: readonly WireEventInput[] = [
  wireEvent(1, "run.queued", { tier: "standard" }),
  wireEvent(2, "run.started", { revisionBefore: 0 }),
  wireEvent(3, "run.plan", { plan: PLAN_WIRE }),
  wireEvent(4, "credits.reserved", { reserved: 2 }),
  wireEvent(5, "step.started", { stepSeq: 1, phase: "planning", tool: "select_layers" }),
  wireEvent(6, "step.finished", {
    stepSeq: 1,
    phase: "planning",
    tool: "select_layers",
    ok: true,
    durationMs: 800,
    deviationFromPlan: false,
  }),
  wireEvent(7, "step.started", { stepSeq: 2, phase: "executing", tool: "add_text_layer" }),
  wireEvent(8, "preview.updated", { url: "https://cdn.test/preview-r1.png", revision: 1 }),
  wireEvent(9, "step.finished", {
    stepSeq: 2,
    phase: "executing",
    tool: "add_text_layer",
    ok: true,
    durationMs: 4200,
    deviationFromPlan: false,
  }),
  wireEvent(10, "validate.report", { ok: true, blockers: [], majors: [], minors: [] }),
  wireEvent(11, "critique.report", CRITIQUE_WIRE),
  wireEvent(12, "credits.charged", { charged: 2, partial: false }),
  wireEvent(13, "run.succeeded", {
    revisionAfter: 1,
    warnings: ["One brand hint shipped as a warning."],
  }),
];

/** parse → monotonic merge → ordered → derived timeline (the pure pipeline). */
function fold(events: readonly WireEventInput[]): RunTimeline {
  let store: RunEventStore = new Map<number, ParsedRunEvent>();
  for (const wire of events) {
    const parsed = parseRunEvent(wire);
    if (parsed !== null) {
      store = mergeRunEvent(store, parsed);
    }
  }
  return deriveTimeline(null, orderedRunEvents(store));
}

// ---------------------------------------------------------------------------
// Part A — the 13 §13.2 event types, table-driven through the pure fold
// ---------------------------------------------------------------------------

interface TypeCase {
  readonly type: string;
  readonly payload: unknown;
  readonly check: (timeline: RunTimeline) => void;
}

const TYPE_CASES: readonly TypeCase[] = [
  {
    type: "run.queued",
    payload: { tier: "complex" },
    check: (timeline) => {
      expect(timeline.status).toBe("queued");
      expect(timeline.terminal).toBe(false);
      expect(timeline.tier).toBe("complex");
    },
  },
  {
    type: "run.started",
    payload: { revisionBefore: 3 },
    check: (timeline) => {
      expect(timeline.status).toBe("planning"); // §5.1: picked-up runs plan first
      expect(timeline.revisionBefore).toBe(3);
      expect(timeline.startedAtMs).toBe(AT_MS + 1_000);
    },
  },
  {
    type: "run.plan",
    payload: { plan: PLAN_WIRE },
    check: (timeline) => {
      expect(timeline.plan?.intent).toBe("create_post");
      expect(timeline.plan?.template).toBeNull();
      expect(timeline.plan?.steps.map((step) => step.tool)).toEqual([
        "select_layers",
        "add_text_layer",
      ]);
      expect(timeline.plan?.notesForUser).toBe("Two-step plan.");
    },
  },
  {
    type: "step.started",
    payload: { stepSeq: 2, phase: "rendering", tool: "render_png" },
    check: (timeline) => {
      expect(timeline.steps).toHaveLength(1);
      expect(timeline.steps[0]).toMatchObject({
        stepSeq: 2,
        phase: "rendering",
        tool: "render_png",
        started: true,
        finished: false,
        ok: null,
        durationMs: null,
      });
      expect(timeline.activeStepSeq).toBe(2);
      expect(timeline.status).toBe("rendering"); // §5.1: live run sits in its step's phase
    },
  },
  {
    type: "step.finished",
    payload: {
      stepSeq: 2,
      phase: "rendering",
      tool: "render_png",
      ok: true,
      durationMs: 1500,
      deviationFromPlan: true,
    },
    check: (timeline) => {
      expect(timeline.steps[0]).toMatchObject({
        finished: true,
        ok: true,
        durationMs: 1500,
        deviation: true,
      });
      expect(timeline.activeStepSeq).toBeNull();
      expect(timeline.deviated).toBe(true); // §5.5: deviations surface, never hide
    },
  },
  {
    type: "preview.updated",
    payload: { url: "https://cdn.test/preview-r2.png", revision: 2 },
    check: (timeline) => {
      expect(timeline.preview?.url).toBe("https://cdn.test/preview-r2.png");
      expect(timeline.preview?.revision).toBe(2);
    },
  },
  {
    type: "validate.report",
    payload: { ok: false, blockers: ["vl.text.empty"], majors: [], minors: ["vl.hint.nudge"] },
    check: (timeline) => {
      expect(timeline.validation?.ok).toBe(false);
      expect(timeline.validation?.blockers).toEqual(["vl.text.empty"]);
      expect(timeline.validation?.minors).toEqual(["vl.hint.nudge"]);
    },
  },
  {
    type: "critique.report",
    payload: CRITIQUE_WIRE,
    check: (timeline) => {
      expect(timeline.critique?.verdict).toBe("revise");
      expect(timeline.critique?.issues).toHaveLength(1);
      expect(timeline.critique?.scores.editability).toBe(5);
    },
  },
  {
    type: "credits.reserved",
    payload: { reserved: 2 },
    check: (timeline) => {
      expect(timeline.creditsReserved).toBe(2); // §14.2 rule 1 hold
    },
  },
  {
    type: "credits.charged",
    payload: { charged: 1, partial: true },
    check: (timeline) => {
      expect(timeline.creditsCharged).toEqual({ charged: 1, partial: true }); // §14.2 rule 4
    },
  },
  {
    type: "run.succeeded",
    payload: { revisionAfter: 7, warnings: [] },
    check: (timeline) => {
      expect(timeline.terminal).toBe(true);
      expect(timeline.status).toBe("succeeded");
      expect(timeline.revisionAfter).toBe(7);
    },
  },
  {
    type: "run.failed",
    payload: {
      error: {
        code: "engine_unavailable",
        message: "The render engine stopped.",
        hint: "Retry the run.",
        retryable: true,
      },
    },
    check: (timeline) => {
      expect(timeline.terminal).toBe(true);
      expect(timeline.status).toBe("failed");
      expect(timeline.failure?.code).toBe("engine_unavailable");
      expect(timeline.failure?.hint).toBe("Retry the run.");
    },
  },
  {
    type: "run.cancelled",
    payload: { reason: "User stopped the run." },
    check: (timeline) => {
      expect(timeline.terminal).toBe(true);
      expect(timeline.status).toBe("cancelled");
      expect(timeline.cancelledReason).toBe("User stopped the run.");
    },
  },
];

describe("§13.2 fold — the 13 event types, table-driven", () => {
  it("covers exactly the 13 wire types, including every terminal one", () => {
    expect(TYPE_CASES).toHaveLength(13);
    const tableTypes = TYPE_CASES.map((testCase) => testCase.type);
    for (const terminalType of TERMINAL_RUN_EVENT_TYPES) {
      expect(tableTypes).toContain(terminalType);
    }
  });

  for (const testCase of TYPE_CASES) {
    it(`folds ${testCase.type}`, () => {
      const parsed = parseRunEvent(wireEvent(1, testCase.type, testCase.payload));
      expect(parsed).not.toBeNull();
      testCase.check(fold(parsed === null ? [] : [parsed]));
    });
  }

  it("folds the full 13-event script into the §20 #5 timeline", () => {
    const timeline = fold(FULL_SCRIPT);
    expect(timeline.terminal).toBe(true);
    expect(timeline.status).toBe("succeeded_with_warnings"); // warnings ship honestly (§5.1)
    expect(timeline.steps.map((step) => step.tool)).toEqual(["select_layers", "add_text_layer"]);
    expect(timeline.activeStepSeq).toBeNull();
    expect(timeline.creditsReserved).toBe(2);
    expect(timeline.creditsCharged).toEqual({ charged: 2, partial: false });
    expect(timeline.validation?.ok).toBe(true);
    expect(timeline.critique?.verdict).toBe("revise");
    expect(timeline.lastSeq).toBe(13);
    expect(timeline.revisionAfter).toBe(1);
    expect(timeline.deviated).toBe(false);
  });

  it("skips unknown types and malformed payloads instead of wedging (defensive §13.2)", () => {
    expect(parseRunEvent(wireEvent(1, "run.resync", { seq: 1 }))).toBeNull(); // sentinel ≠ event
    expect(parseRunEvent(wireEvent(1, "bogus.event", {}))).toBeNull();
    expect(parseRunEvent(wireEvent(1, "step.started", { stepSeq: 1, tool: null }))).toBeNull(); // missing phase
    expect(parseRunEvent(wireEvent(1, "run.queued", { tier: "" }))).toBeNull(); // empty tier
  });

  it("falls back to atMs 0 for unparseable timestamps (never throws)", () => {
    const parsed = parseRunEvent({
      seq: 1,
      type: "run.queued",
      payload: { tier: "quick" },
      at: "not-a-date",
    });
    expect(parsed?.atMs).toBe(0);
  });

  it("mergeRunEvent drops replayed and regressed seqs (§13.2 second line of defense)", () => {
    const first = parseRunEvent(wireEvent(1, "run.queued", { tier: "quick" }));
    const second = parseRunEvent(wireEvent(2, "run.started", { revisionBefore: 0 }));
    const third = parseRunEvent(wireEvent(3, "run.plan", { plan: PLAN_WIRE }));
    expect(first === null || second === null || third === null).toBe(false);
    if (first === null || second === null || third === null) {
      return;
    }
    let store: RunEventStore = new Map<number, ParsedRunEvent>();
    store = mergeRunEvent(store, first);
    store = mergeRunEvent(store, second);
    store = mergeRunEvent(store, first); // replay — dropped
    store = mergeRunEvent(store, third); // seq 3 > high-water 2 — kept
    store = mergeRunEvent(store, second); // regressed below high-water 3 — dropped
    expect(orderedRunEvents(store).map((event) => event.seq)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Timeline optimistic states — direct renders (no hook, fully sync)
// ---------------------------------------------------------------------------

describe("Timeline optimistic states", () => {
  it("shows two skeleton rows for an active run with no steps yet", () => {
    render(<Timeline timeline={fold([wireEvent(1, "run.queued", { tier: "standard" })])} nowMs={AT_MS + 30_000} />);
    expect(screen.getByText("0 steps · 0 ok")).toBeDefined();
    expect(document.querySelectorAll("li[aria-hidden='true']")).toHaveLength(2);
    expect(screen.queryByText("No steps were recorded.")).toBeNull();
  });

  it("shows the live step's running state with a ticking duration, no invented result", () => {
    const timeline = fold([
      wireEvent(1, "run.started", { revisionBefore: 0 }),
      wireEvent(2, "step.started", { stepSeq: 1, phase: "rendering", tool: "render_png" }),
    ]);
    render(<Timeline timeline={timeline} nowMs={AT_MS + 30_000} />);
    expect(screen.getByText("1 step · 0 ok")).toBeDefined();
    expect(screen.getByText("render_png")).toBeDefined();
    expect(screen.getByText("running · 28s")).toBeDefined(); // fixed clock − step start
    expect(document.querySelectorAll("li[aria-hidden='true']")).toHaveLength(0); // step in flight
  });

  it("keeps one trailing skeleton between finished steps while the run is active", () => {
    const timeline = fold([
      wireEvent(1, "run.started", { revisionBefore: 0 }),
      wireEvent(2, "step.started", { stepSeq: 1, phase: "planning", tool: "select_layers" }),
      wireEvent(3, "step.finished", {
        stepSeq: 1,
        phase: "planning",
        tool: "select_layers",
        ok: true,
        durationMs: 800,
        deviationFromPlan: false,
      }),
    ]);
    render(<Timeline timeline={timeline} nowMs={AT_MS + 30_000} />);
    expect(screen.getByText("1 step · 1 ok")).toBeDefined();
    expect(document.querySelectorAll("li[aria-hidden='true']")).toHaveLength(1);
  });

  it("says a terminal run recorded no steps (no skeletons either)", () => {
    render(<Timeline timeline={fold([wireEvent(1, "run.cancelled", { reason: "User stopped." })])} nowMs={AT_MS + 30_000} />);
    expect(screen.getByText("No steps were recorded.")).toBeDefined();
    expect(document.querySelectorAll("li")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part B — hook level: fake RunEventStream (real client, queued fake fetch)
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly input: string;
  readonly init?: RequestInit;
}

function queuedFetch(responses: readonly Response[]): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const doFetch: FetchLike = async (input, init) => {
    calls.push({ input, init });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("test: unexpected extra fetch call");
    }
    return next;
  };
  return { fetch: doFetch, calls };
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runEventBlock(
  seq: number,
  type: string,
  payload: unknown,
  options?: { readonly id?: string | false },
): string {
  const data = JSON.stringify({
    seq,
    run_id: RUN_ID,
    at: new Date(AT_MS + seq * 1000).toISOString(),
    type,
    payload,
  });
  const idLine =
    options?.id === undefined
      ? `id: ${seq}\n`
      : options.id === false
        ? ""
        : `id: ${options.id}\n`;
  return `event: ${type}\n${idLine}data: ${data}\n\n`;
}

/** The scripted sequence rendered as one SSE response body. */
function sseScript(events: readonly WireEventInput[]): Response {
  return sseResponse(
    events.map((wire) =>
      runEventBlock(wire.seq, wire.type, wire.payload),
    ),
  );
}

/** Real client, but reconnects instantly so hook tests never wait seconds. */
function fakeGatewayClient(fetch: FetchLike): GatewayClient {
  const client = createGatewayClient({ baseUrl: BASE_URL, fetch });
  return {
    ...client,
    streamRunEvents: (options) =>
      client.streamRunEvents({ ...options, reconnectDelayMs: 0 }),
  };
}

function RunView(props: { readonly client: GatewayClient; readonly onTerminal?: () => void }) {
  const { timeline, streamState, streamMessage } = useRunEvents({
    client: props.client,
    runId: RUN_ID,
    detail: null,
    onTerminal: props.onTerminal,
  });
  const nowMs = AT_MS + 30_000; // fixed clock — durations are deterministic
  return (
    <main>
      <Timeline timeline={timeline} nowMs={nowMs} />
      <ValidateVerdictCard report={timeline.validation} terminal={timeline.terminal} />
      <CritiqueVerdictCard report={timeline.critique} terminal={timeline.terminal} />
      <p data-testid="status">{timeline.status}</p>
      <p data-testid="tier">{timeline.tier ?? ""}</p>
      <p data-testid="last-seq">{timeline.lastSeq}</p>
      <p data-testid="plan-intent">{timeline.plan?.intent ?? ""}</p>
      <p data-testid="stream-state">{streamState}</p>
      <p data-testid="stream-message">{streamMessage ?? ""}</p>
    </main>
  );
}

describe("useRunEvents + Timeline — the scripted run (hook level)", () => {
  it("renders steps in order with counts, verdicts; stops once and terminal-fires once", async () => {
    const { fetch, calls } = queuedFetch([sseScript(FULL_SCRIPT)]);
    const onTerminal = vi.fn();
    render(<RunView client={fakeGatewayClient(fetch)} onTerminal={onTerminal} />);

    await waitFor(
      () => expect(screen.getByTestId("stream-state")).toHaveTextContent("stopped"),
      { timeout: 2_000 },
    );
    expect(screen.getByTestId("status")).toHaveTextContent("succeeded_with_warnings");
    expect(screen.getByTestId("tier")).toHaveTextContent("standard");
    expect(screen.getByTestId("last-seq")).toHaveTextContent("13");
    expect(onTerminal).toHaveBeenCalledTimes(1); // exactly one final GET refresh
    expect(calls).toHaveLength(1); // terminal stops the stream — no reconnect

    // §20 #5: steps are the spine — rendered in scripted order, skeletons gone.
    const region = screen.getByRole("region", { name: "Run steps" });
    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("select_layers")).toBeDefined();
    expect(within(rows[0]).getByText("planning")).toBeDefined();
    expect(within(rows[0]).getByText("1.")).toBeDefined();
    expect(within(rows[0]).getByText("1s")).toBeDefined(); // 800 ms rounds to 1s
    expect(within(rows[1]).getByText("add_text_layer")).toBeDefined();
    expect(within(rows[1]).getByText("executing")).toBeDefined();
    expect(within(rows[1]).getByText("2.")).toBeDefined();
    expect(within(rows[1]).getByText("4s")).toBeDefined(); // 4.2 s rounds to 4s
    expect(screen.getByText("2 steps · 2 ok")).toBeDefined();

    // §5.1: the phases strip lists phases in first-seen order (planning → executing).
    const planning = screen.getAllByText("planning")[0];
    const executing = screen.getAllByText("executing")[0];
    expect(planning.compareDocumentPosition(executing)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // §11 verdict cards from the streamed reports.
    expect(screen.getByText("Passed")).toBeDefined();
    expect(screen.getByText("The document passed every check with no issues.")).toBeDefined();
    expect(screen.getByText("Revise requested")).toBeDefined();
    expect(screen.getByText("cr.contrast.low")).toBeDefined();
    expect(screen.getByText("Fix: Darken the headline text.")).toBeDefined();
    expect(screen.getByText("Average 4.2 of 5 · 1 issue")).toBeDefined();
    expect(screen.getByText("Brief adherence")).toBeDefined();
  });

  it("resync sentinel: skipped as an event, resumed from, gap healed, replay deduped (§13.2)", async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        runEventBlock(1, "run.queued", { tier: "standard" }, { id: "evt-1" }),
        runEventBlock(2, "run.started", { revisionBefore: 0 }, { id: "evt-2" }),
        // The gateway (W4-H) ends the response with a run.resync frame whose id
        // is the last CONTIGUOUSLY delivered seq — the stream cut AT the gap.
        runEventBlock(2, "run.resync", { seq: 2 }, { id: "evt-2" }),
      ]),
      sseResponse([
        runEventBlock(2, "run.started", { revisionBefore: 0 }, { id: "evt-2" }), // replay — deduped
        runEventBlock(3, "run.plan", { plan: PLAN_WIRE }, { id: "evt-3" }), // gap healed
        runEventBlock(4, "step.started", { stepSeq: 1, phase: "rendering", tool: "render_png" }, { id: "evt-4" }),
        runEventBlock(5, "step.finished", {
          stepSeq: 1,
          phase: "rendering",
          tool: "render_png",
          ok: true,
          durationMs: 300,
          deviationFromPlan: false,
        }, { id: "evt-5" }),
        runEventBlock(6, "run.succeeded", { revisionAfter: 1, warnings: [] }, { id: "evt-6" }),
      ]),
    ]);
    render(<RunView client={fakeGatewayClient(fetch)} />);

    await waitFor(
      () => expect(screen.getByTestId("stream-state")).toHaveTextContent("stopped"),
      { timeout: 2_000 },
    );
    // Transparent reconnect, resuming from the sentinel's id (not the local seq).
    expect(calls).toHaveLength(2);
    const firstHeaders = calls[0]?.init?.headers as Record<string, string>;
    expect(firstHeaders["Last-Event-ID"]).toBeUndefined(); // fresh connect: full backfill
    const resumeHeaders = calls[1]?.init?.headers as Record<string, string>;
    expect(resumeHeaders["Last-Event-ID"]).toBe("evt-2");

    // The gap event (seq 3) was delivered on the healed backfill; the replayed
    // overlap produced no duplicate rows (§13.2 high-water dedupe).
    expect(screen.getByTestId("plan-intent")).toHaveTextContent("create_post");
    expect(screen.getByTestId("last-seq")).toHaveTextContent("6");
    expect(screen.getByTestId("status")).toHaveTextContent("succeeded");
    expect(screen.getByText("1 step · 1 ok")).toBeDefined();
    const region = screen.getByRole("region", { name: "Run steps" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
  });

  it("surfaces a typed 4xx envelope as a friendly error state without reconnecting", async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse(403, {
        ok: false,
        code: "forbidden",
        message: "You cannot view this run.",
        hint: "It belongs to another workspace.",
      }),
    ]);
    render(<RunView client={fakeGatewayClient(fetch)} />);

    await waitFor(() => expect(screen.getByTestId("stream-state")).toHaveTextContent("error"));
    expect(screen.getByTestId("stream-message")).toHaveTextContent(
      "You cannot view this run. It belongs to another workspace.",
    );
    expect(calls).toHaveLength(1); // 4xx fails fast — a retry cannot help (§13.2)
  });
});
