// W6-J — run lifecycle machine tests: §5.1 legal/illegal spot-check table,
// §5.2 wall-clock clean-stop funnel, §5.1 terminal lock, §13.2 emission
// contract, §3.4 idempotent replays, typed rejections, history + snapshots.
import { describe, expect, it } from "vitest";
import type { Plan } from "../src/plan.js";
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  canTransition,
  transition as tableTransition,
  type RunStatus,
} from "../src/state.js";
import {
  DEFAULT_CANCEL_REASON,
  DEFAULT_HISTORY_CAP,
  type EmitLike,
  RunStateMachine,
  timeoutErrorEnvelope,
  type RunEventType,
  type TransitionContext,
  type TransitionSuccess,
} from "../src/run-state/machine.js";
import type { Clock } from "../src/budgets.js";

// --- Deterministic helpers ------------------------------------------------------

/** Injectable clock (epoch ms), advanced manually — no timers anywhere. */
function fakeClock(startAtMs = 0): { clock: Clock; set: (ms: number) => void } {
  let now = startAtMs;
  return {
    clock: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
}

interface CapturedEvent {
  readonly runId: string;
  readonly type: RunEventType;
  readonly payload: unknown;
}

/** Capturing EmitLike — records every publish in order. */
function capturingEmit(): { emit: EmitLike; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    emit: {
      publish: (runId, type, payload) => {
        events.push({ runId, type, payload });
      },
    },
  };
}

/**
 * The §5.5 plan is validated UPSTREAM by the planner (§5.1 plan-first); the
 * machine only carries it onto `run.plan`, so its content is opaque here.
 */
const PLAN: Plan = {
  intent: "edit_layers",
  template: null,
  assets: [],
  slots: { headline: "Fresh roasted, every morning" },
  palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  typography: { body: { font: "sans" } },
  steps: [{ tool: "text.set", args: { layer: "headline", value: "Fresh roasted" } }],
  checks: ["in_bounds", "safe_area"],
  model_tier: "standard",
  notes_for_user: "Shortened the headline to fit.",
} as unknown as Plan;

/** Payloads per target status — exactly what the mapped §13.2 events need. */
function ctxFor(to: RunStatus): TransitionContext {
  switch (to) {
    case "planning":
      return { revisionBefore: 7 };
    case "executing":
      return { plan: PLAN };
    case "succeeded":
    case "succeeded_with_warnings":
      return { revisionAfter: 12, warnings: ["minor contrast issue"] };
    case "failed":
      return { error: { code: "engine_timeout", message: "The engine did not answer." } };
    case "cancelled":
      return { reason: "user hit stop" };
    default:
      return {};
  }
}

const BASE_CHAIN: readonly RunStatus[] = [
  "planning",
  "executing",
  "observing",
  "rendering",
  "validating",
];

/** Canonical legal §5.1 walk to a status (unique path per the W1-P table). */
function walkTo(target: RunStatus): readonly RunStatus[] {
  switch (target) {
    case "queued":
      return [];
    case "planning":
      return ["planning"];
    case "executing":
      return ["planning", "executing"];
    case "observing":
      return ["planning", "executing", "observing"];
    case "rendering":
      return ["planning", "executing", "observing", "rendering"];
    case "validating":
      return BASE_CHAIN;
    case "critiquing":
    case "repairing":
    case "finalizing":
      return [...BASE_CHAIN, target];
    default:
      // Terminals are reached through the funnel (§5.1).
      return [...BASE_CHAIN, "finalizing", target];
  }
}

/** Drives a fresh run to `target` through legal transitions only. */
function driveTo(machine: RunStateMachine, runId: string, target: RunStatus): void {
  for (const status of walkTo(target)) {
    const result = machine.transition(runId, status, ctxFor(status));
    if (!result.ok) {
      throw new Error(`driveTo('${target}') failed at '${status}': ${result.message}`);
    }
  }
}

function freshMachine(startAtMs = 0): {
  machine: RunStateMachine;
  clock: { clock: Clock; set: (ms: number) => void };
  emit: { emit: EmitLike; events: CapturedEvent[] };
  runId: string;
} {
  const clock = fakeClock(startAtMs);
  const emit = capturingEmit();
  const machine = new RunStateMachine({ clock: clock.clock, emit: emit.emit });
  const runId = "run_spot";
  const created = machine.createRun(runId, { tier: "standard" });
  if (!created.ok) {
    throw new Error(`createRun failed: ${created.message}`);
  }
  return { machine, clock, emit, runId };
}

function assertOk(value: { ok: boolean }): asserts value is TransitionSuccess {
  expect(value.ok).toBe(true);
}

// --- §5.1 legal/illegal spot-check table ----------------------------------------

const SPOT_ROWS: readonly { from: RunStatus; to: RunStatus; legal: boolean }[] = [
  // 20 legal paths through the §5.1 loop.
  { from: "queued", to: "planning", legal: true },
  { from: "planning", to: "executing", legal: true },
  { from: "executing", to: "observing", legal: true },
  { from: "observing", to: "executing", legal: true },
  { from: "observing", to: "rendering", legal: true },
  { from: "rendering", to: "validating", legal: true },
  { from: "validating", to: "critiquing", legal: true },
  { from: "validating", to: "repairing", legal: true },
  { from: "validating", to: "finalizing", legal: true },
  { from: "critiquing", to: "repairing", legal: true },
  { from: "critiquing", to: "finalizing", legal: true },
  { from: "repairing", to: "observing", legal: true },
  { from: "finalizing", to: "succeeded", legal: true },
  { from: "finalizing", to: "succeeded_with_warnings", legal: true },
  { from: "finalizing", to: "failed", legal: true },
  { from: "finalizing", to: "cancelled", legal: true },
  { from: "queued", to: "failed", legal: true },
  { from: "queued", to: "cancelled", legal: true },
  { from: "executing", to: "cancelled", legal: true },
  { from: "repairing", to: "cancelled", legal: true },
  // 15 illegal paths — the §5.1 rules each one violates.
  { from: "queued", to: "executing", legal: false }, // plan first (§5.1)
  { from: "queued", to: "observing", legal: false },
  { from: "planning", to: "observing", legal: false },
  { from: "executing", to: "rendering", legal: false }, // observe after act (§5.1)
  { from: "executing", to: "validating", legal: false },
  { from: "observing", to: "validating", legal: false },
  { from: "rendering", to: "critiquing", legal: false }, // validate before critique (§5.1)
  { from: "validating", to: "executing", legal: false },
  { from: "critiquing", to: "executing", legal: false },
  { from: "repairing", to: "executing", legal: false },
  { from: "repairing", to: "finalizing", legal: false }, // repair re-enters observing (§5.1)
  { from: "succeeded", to: "planning", legal: false }, // terminal lock (§5.1)
  { from: "succeeded_with_warnings", to: "finalizing", legal: false },
  { from: "failed", to: "queued", legal: false },
  { from: "cancelled", to: "observing", legal: false },
];

describe("RunStateMachine §5.1 spot-check table (35 paths, W1-P parity)", () => {
  for (const row of SPOT_ROWS) {
    it(`${row.from} → ${row.to} is ${row.legal ? "legal" : "rejected"}`, () => {
      // The wrapper must agree with the W1-P table in BOTH directions.
      expect(row.legal).toBe(canTransition(row.from, row.to));
      expect(tableTransition(row.from, row.to).ok).toBe(row.legal);

      const { machine, clock, emit, runId } = freshMachine(0);
      driveTo(machine, runId, row.from);
      const before = machine.snapshot(runId);
      const historyBefore = machine.history(runId)?.length ?? 0;
      const eventsBefore = emit.events.length;
      const result = machine.transition(runId, row.to, ctxFor(row.to));

      expect(result.ok).toBe(row.legal);
      if (!result.ok) {
        // Typed invalid_transition carrying the exact ALLOWED set.
        expect(result.code).toBe("invalid_transition");
        const expectedAllowed = isTerminalStatus(row.from)
          ? []
          : [...ALLOWED_TRANSITIONS[row.from]];
        expect(result.allowed).toEqual(expectedAllowed);
        expect(result.retryable).toBe(false);
        expect(result.message).toContain(row.from);
        expect(result.message).toContain(row.to);
        // Nothing changed: status, history, emission.
        const after = machine.snapshot(runId);
        expect(after?.status).toBe(before?.status);
        expect(machine.history(runId)?.length).toBe(historyBefore);
        expect(emit.events.length).toBe(eventsBefore);
        return;
      }
      assertOk(result);
      expect(result.to).toBe(row.to);
      expect(result.forced).toBe(false);
      expect(result.replay).toBe(false);
      expect(machine.snapshot(runId)?.status).toBe(row.to);
      expect(machine.history(runId)?.length).toBe(historyBefore + 1);
    });
  }
});

function isTerminalStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

// --- §5.1 terminal lock ------------------------------------------------------------

describe("RunStateMachine terminal lock (§5.1: terminals never transition)", () => {
  for (const terminal of TERMINAL_RUN_STATUSES) {
    it(`${terminal} rejects every further transition and stays frozen`, () => {
      const { machine, emit, runId } = freshMachine(0);
      driveTo(machine, runId, terminal);
      const historyBefore = machine.history(runId)?.length ?? 0;
      const eventsBefore = emit.events.length;
      const targets: readonly RunStatus[] = [
        "queued",
        "planning",
        "executing",
        "observing",
        "rendering",
        "validating",
        "critiquing",
        "repairing",
        "finalizing",
        "succeeded",
        "succeeded_with_warnings",
        "failed",
        "cancelled",
      ];
      for (const to of targets) {
        const result = machine.transition(runId, to, ctxFor(to));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("invalid_transition");
          expect(result.allowed).toEqual([]); // the terminal ALLOWED set is empty
        }
      }
      // Even a same-status "replay" is rejected: the lock beats §3.4 idempotency.
      const selfReplay = machine.transition(runId, terminal, ctxFor(terminal));
      expect(selfReplay.ok).toBe(false);
      expect(machine.snapshot(runId)?.status).toBe(terminal);
      expect(machine.history(runId)?.length).toBe(historyBefore);
      expect(emit.events.length).toBe(eventsBefore); // no terminal event ever repeats
    });
  }
});

// --- §5.2 wall-clock clean-stop funnel ---------------------------------------------

describe("RunStateMachine §5.2 tier wall clock (TIER_WALL_CLOCK)", () => {
  it("forces → finalizing with a timeout budget report during ANY active state", () => {
    const clock = fakeClock(1000);
    const emit = capturingEmit();
    const quick = new RunStateMachine({ clock: clock.clock, emit: emit.emit });
    const created = quick.createRun("run_quick", { tier: "quick" }); // 120s (§5.2)
    expect(created.ok).toBe(true);
    quick.transition("run_quick", "planning", { revisionBefore: 3 });
    quick.transition("run_quick", "executing", { plan: PLAN });
    quick.transition("run_quick", "observing", {});
    clock.set(1000 + 120_000); // exactly at the deadline

    const forced = quick.transition("run_quick", "rendering", {});
    assertOk(forced);
    expect(forced.forced).toBe(true);
    expect(forced.to).toBe("finalizing");
    expect(forced.from).toBe("observing");
    expect(forced.emitted).toBe(null); // no §13.2 type for a funnel entry
    expect(forced.timeout).not.toBeNull();
    const report = forced.timeout;
    if (report === null) {
      throw new Error("unreachable: report checked above");
    }
    expect(report.kind).toBe("wall_clock");
    expect(report.limitMs).toBe(120_000);
    expect(report.usedMs).toBe(120_000);
    expect(report.remainingMs).toBe(0);
    expect(report.startedAtMs).toBe(1000);
    expect(report.deadlineAtMs).toBe(121_000);
    expect(report.detectedAtMs).toBe(121_000);
    expect(report.message).toContain("wall-clock");
    expect(report.message).toContain("tell the user what was cut");
    expect(quick.snapshot("run_quick")?.status).toBe("finalizing");
    const history = quick.history("run_quick") ?? [];
    const last = history[history.length - 1];
    expect(last?.forced).toBe(true);
    expect(last?.replay).toBe(false);
    expect(last?.reason).toBe("run_timeout");
    expect(last?.to).toBe("finalizing");

    // The run manager lands failed with the §5.2 timeout envelope (run_timeout).
    const landed = quick.transition("run_quick", "failed", { error: timeoutErrorEnvelope(report) });
    assertOk(landed);
    expect(landed.emitted).toBe("run.failed");
    const failedEvent = emit.events.find((event) => event.type === "run.failed");
    expect((failedEvent?.payload as { error: { code: string } }).error.code).toBe("run_timeout");
  });

  it("one tick under the deadline is still legal; the boundary itself forces", () => {
    const under = freshMachine(1000);
    under.machine.transition(under.runId, "planning", { revisionBefore: 1 });
    under.clock.set(1000 + 300_000 - 1); // standard tier: 5 min (§5.2)
    const legal = under.machine.transition(under.runId, "executing", { plan: PLAN });
    assertOk(legal);
    expect(legal.forced).toBe(false);

    const atBoundary = freshMachine(1000);
    atBoundary.machine.transition(atBoundary.runId, "planning", { revisionBefore: 1 });
    atBoundary.machine.transition(atBoundary.runId, "executing", { plan: PLAN });
    atBoundary.clock.set(1000 + 300_000); // now === deadlineAt → exceeded
    const forced = atBoundary.machine.transition(atBoundary.runId, "observing", {});
    assertOk(forced);
    expect(forced.forced).toBe(true);
    expect(forced.to).toBe("finalizing");
  });

  it("attaches the report when the caller is already landing a terminal outcome", () => {
    const { machine, clock, runId } = freshMachine(0);
    machine.transition(runId, "planning", { revisionBefore: 5 });
    machine.transition(runId, "executing", { plan: PLAN });
    clock.set(300_000); // standard tier deadline
    const failed = machine.transition(runId, "failed", {
      error: { code: "engine_timeout", message: "engine died" },
    });
    assertOk(failed);
    expect(failed.forced).toBe(false);
    expect(failed.to).toBe("failed");
    expect(failed.timeout?.kind).toBe("wall_clock"); // report attached, caller in control
  });

  it("falls through with the report when the run is already in finalizing", () => {
    const { machine, clock, runId } = freshMachine(0);
    driveTo(machine, runId, "finalizing");
    clock.set(300_000);
    const done = machine.transition(runId, "succeeded", { revisionAfter: 9, warnings: [] });
    assertOk(done);
    expect(done.forced).toBe(false);
    expect(done.to).toBe("succeeded");
    expect(done.emitted).toBe("run.succeeded");
    expect(done.timeout?.kind).toBe("wall_clock");
  });

  it("the funnel preempts a same-status replay at the deadline", () => {
    const { machine, clock, runId } = freshMachine(0);
    driveTo(machine, runId, "observing");
    clock.set(300_000);
    const result = machine.transition(runId, "observing", {});
    assertOk(result);
    expect(result.forced).toBe(true);
    expect(result.replay).toBe(false);
    expect(result.to).toBe("finalizing");
  });

  it("a requested → finalizing at the deadline is granted through the forced path", () => {
    const { machine, clock, runId } = freshMachine(0);
    driveTo(machine, runId, "validating");
    clock.set(300_000);
    const result = machine.transition(runId, "finalizing", {});
    assertOk(result);
    expect(result.forced).toBe(true);
    expect(result.to).toBe("finalizing");
    expect(result.timeout?.limitMs).toBe(300_000);
  });

  it("queued runs burn no wall clock: the deadline latches at worker pickup", () => {
    const { machine, clock, runId } = freshMachine(0);
    clock.set(10_000_000); // a long queue wait must NOT consume the budget
    const pickup = machine.transition(runId, "planning", { revisionBefore: 2 });
    assertOk(pickup);
    expect(machine.snapshot(runId)?.startedAtMs).toBe(10_000_000);
    expect(machine.snapshot(runId)?.deadlineAtMs).toBe(10_000_000 + 300_000);
  });

  it("checkDeadline forces the funnel between phases and never re-forces", () => {
    const { machine, clock, runId } = freshMachine(0);
    machine.transition(runId, "planning", { revisionBefore: 2 });
    machine.transition(runId, "executing", { plan: PLAN });
    const before = machine.checkDeadline(runId);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.exceeded).toBe(false);
      expect(before.report).toBeNull();
      expect(before.status).toBe("executing");
    }
    clock.set(300_000);
    const fired = machine.checkDeadline(runId);
    expect(fired.ok).toBe(true);
    if (fired.ok) {
      expect(fired.exceeded).toBe(true);
      expect(fired.forced).toBe(true);
      expect(fired.status).toBe("finalizing");
      expect(fired.report?.kind).toBe("wall_clock");
    }
    const again = machine.checkDeadline(runId);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.forced).toBe(false); // already in the funnel
      expect(again.status).toBe("finalizing");
    }
    const last = (machine.history(runId) ?? []).at(-1);
    expect(last?.forced).toBe(true);
    expect(last?.reason).toBe("run_timeout");
  });

  it("a repairing run at the deadline is forced into the funnel too", () => {
    const { machine, clock, runId } = freshMachine(0);
    driveTo(machine, runId, "repairing");
    clock.set(300_000);
    const result = machine.transition(runId, "observing", {}); // §5.1 repair re-entry
    assertOk(result);
    expect(result.forced).toBe(true);
    expect(result.from).toBe("repairing");
    expect(result.to).toBe("finalizing");
  });

  it("checkDeadline of an unknown run is a typed run_not_found", () => {
    const { machine } = freshMachine(0);
    const result = machine.checkDeadline("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("run_not_found");
    }
  });
});

// --- §3.4 idempotent replays --------------------------------------------------------

describe("RunStateMachine §3.4 idempotent replays", () => {
  it("replaying the current status is a no-op success with an audit record", () => {
    const { machine, runId } = freshMachine(0);
    const replayQueued = machine.transition(runId, "queued", {});
    assertOk(replayQueued);
    expect(replayQueued.replay).toBe(true);
    expect(replayQueued.forced).toBe(false);
    expect(replayQueued.emitted).toBe(null);
    expect(machine.snapshot(runId)?.status).toBe("queued");
    const record = (machine.history(runId) ?? []).at(-1);
    expect(record?.replay).toBe(true);
    expect(record?.reason).toBe("idempotent_replay");

    driveTo(machine, runId, "observing");
    const replayObserving = machine.transition(runId, "observing", {});
    assertOk(replayObserving);
    expect(replayObserving.replay).toBe(true);
    expect(replayObserving.to).toBe("observing");
  });

  it("terminal replays stay rejected (the lock beats idempotency)", () => {
    const { machine, runId } = freshMachine(0);
    driveTo(machine, runId, "failed");
    const result = machine.transition(runId, "failed", {
      error: { code: "engine_timeout", message: "again" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_transition");
      expect(result.allowed).toEqual([]);
    }
  });
});

// --- §13.2 emission contract ---------------------------------------------------------

describe("RunStateMachine §13.2 emission", () => {
  it("emits run.queued at creation with the tier payload", () => {
    const { emit, runId } = freshMachine(0);
    const queued = emit.events.find((event) => event.type === "run.queued");
    expect(queued?.runId).toBe(runId);
    expect(queued?.payload).toEqual({ tier: "standard" });
  });

  it("emits the full happy-chain in order with exact payloads", () => {
    const { machine, emit, runId } = freshMachine(0);
    machine.transition(runId, "planning", { revisionBefore: 7 });
    machine.transition(runId, "executing", { plan: PLAN });
    machine.transition(runId, "observing", {});
    machine.transition(runId, "rendering", {});
    machine.transition(runId, "validating", {});
    machine.transition(runId, "critiquing", {});
    machine.transition(runId, "finalizing", {});
    machine.transition(runId, "succeeded_with_warnings", {
      revisionAfter: 12,
      warnings: ["minor contrast issue"],
    });
    expect(emit.events.map((event) => event.type)).toEqual([
      "run.queued",
      "run.started",
      "run.plan",
      "run.succeeded",
    ]);
    expect(emit.events[1]?.payload).toEqual({ revisionBefore: 7 });
    expect(emit.events[2]?.payload).toEqual({ plan: PLAN });
    expect(emit.events[3]?.payload).toEqual({
      revisionAfter: 12,
      warnings: ["minor contrast issue"],
    });
  });

  it("loop-internal edges emit nothing (no §13.2 type exists for them)", () => {
    const { machine, emit, runId } = freshMachine(0);
    driveTo(machine, runId, "rendering");
    const before = emit.events.length;
    machine.transition(runId, "validating", {});
    expect(emit.events.length).toBe(before);
    const record = (machine.history(runId) ?? []).at(-1);
    expect(record?.emitted).toBeNull();
  });

  it("run.cancelled carries the reason (default when omitted)", () => {
    const { machine, emit, runId } = freshMachine(0);
    driveTo(machine, runId, "executing");
    machine.transition(runId, "cancelled", {});
    const cancelled = emit.events.find((event) => event.type === "run.cancelled");
    expect(cancelled?.payload).toEqual({ reason: DEFAULT_CANCEL_REASON });

    const second = freshMachine(0);
    driveTo(second.machine, second.runId, "executing");
    second.machine.transition(second.runId, "cancelled", { reason: "user hit stop" });
    const custom = second.emit.events.find((event) => event.type === "run.cancelled");
    expect(custom?.payload).toEqual({ reason: "user hit stop" });
  });

  it("run.failed carries the caller's error envelope verbatim", () => {
    const { machine, emit, runId } = freshMachine(0);
    driveTo(machine, runId, "finalizing");
    const envelope = { code: "engine_timeout", message: "boom", retryable: true };
    machine.transition(runId, "failed", { error: envelope });
    const failed = emit.events.find((event) => event.type === "run.failed");
    expect(failed?.payload).toEqual({ error: envelope });
  });

  it("a registration in an active status (recovery replay) emits no run.queued", () => {
    const clock = fakeClock(0);
    const emit = capturingEmit();
    const machine = new RunStateMachine({ clock: clock.clock, emit: emit.emit });
    const created = machine.createRun("run_rec", { tier: "standard", status: "executing" });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.snapshot.status).toBe("executing");
      expect(created.snapshot.startedAtMs).toBe(0); // wall clock latched immediately
      expect(created.snapshot.deadlineAtMs).toBe(300_000);
      expect(emit.events.length).toBe(0);
    }
  });

  it("without an emitter everything still applies (emitted: null)", () => {
    const clock = fakeClock(0);
    const machine = new RunStateMachine({ clock: clock.clock });
    machine.createRun("run_silent", { tier: "quick" });
    const pickup = machine.transition("run_silent", "planning", { revisionBefore: 1 });
    assertOk(pickup);
    expect(pickup.emitted).toBeNull();
    expect(machine.snapshot("run_silent")?.status).toBe("planning");
  });

  it("a throwing emitter is reported as emitFailed without corrupting the move", () => {
    const clock = fakeClock(0);
    const emit: EmitLike = {
      publish: () => {
        throw new Error("bus seam breach");
      },
    };
    const machine = new RunStateMachine({ clock: clock.clock, emit });
    machine.createRun("run_bad", { tier: "quick" });
    const pickup = machine.transition("run_bad", "planning", { revisionBefore: 1 });
    assertOk(pickup);
    expect(pickup.emitted).toBeNull();
    expect(pickup.emitFailed).toBe(true);
    expect(machine.snapshot("run_bad")?.status).toBe("planning");
  });

  it("a rejected publish promise is swallowed (§22 envelopes own durability)", async () => {
    const clock = fakeClock(0);
    const emit: EmitLike = {
      publish: () => Promise.reject(new Error("store down")),
    };
    const machine = new RunStateMachine({ clock: clock.clock, emit });
    machine.createRun("run_p", { tier: "quick" });
    const pickup = machine.transition("run_p", "planning", { revisionBefore: 1 });
    assertOk(pickup);
    expect(pickup.emitted).toBe("run.started"); // delivered to the seam; async fate is the bus's
    expect(pickup.emitFailed).toBe(false);
    // The suite would fail on an unhandled rejection — let microtasks drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(machine.snapshot("run_p")?.status).toBe("planning");
  });
});

// --- §13.2 payload-required failures ---------------------------------------------------

describe("RunStateMachine §13.2 payload contract", () => {
  it("queued → planning requires ctx.revisionBefore (§5.6 revision at pickup)", () => {
    const { machine, emit, runId } = freshMachine(0);
    const result = machine.transition(runId, "planning", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("transition_payload_required");
      expect(result.retryable).toBe(true);
      expect(result.message).toContain("revisionBefore");
    }
    expect(machine.snapshot(runId)?.status).toBe("queued"); // nothing changed
    expect(machine.history(runId)?.length).toBe(1);
    expect(emit.events.length).toBe(1); // only run.queued

    // §3.4 spirit: retrying the SAME transition with the payload succeeds.
    const retried = machine.transition(runId, "planning", { revisionBefore: 4 });
    assertOk(retried);
    expect(retried.emitted).toBe("run.started");
  });

  it("planning → executing requires ctx.plan", () => {
    const { machine, runId } = freshMachine(0);
    driveTo(machine, runId, "planning");
    const result = machine.transition(runId, "executing", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("transition_payload_required");
      expect(result.message).toContain("plan");
    }
  });

  it("→ succeeded requires ctx.revisionAfter", () => {
    const { machine, runId } = freshMachine(0);
    driveTo(machine, runId, "finalizing");
    const result = machine.transition(runId, "succeeded", { warnings: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("transition_payload_required");
      expect(result.message).toContain("revisionAfter");
    }
  });

  it("→ failed requires ctx.error (the machine never invents failure semantics)", () => {
    const { machine, runId } = freshMachine(0);
    driveTo(machine, runId, "finalizing");
    const result = machine.transition(runId, "failed", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("transition_payload_required");
      expect(result.message).toContain("error");
    }
  });
});

// --- Typed rejections (zod boundaries + registry) ---------------------------------------

describe("RunStateMachine typed rejections", () => {
  it("transition/checkDeadline/snapshot/history of an unknown run are typed", () => {
    const { machine } = freshMachine(0);
    const result = machine.transition("ghost", "planning", { revisionBefore: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("run_not_found");
      expect(result.retryable).toBe(false);
    }
    expect(machine.snapshot("ghost")).toBeNull();
    expect(machine.history("ghost")).toBeNull();
  });

  it("createRun rejects duplicate registration (run_already_registered)", () => {
    const { machine } = freshMachine(0);
    const duplicate = machine.createRun("run_spot", { tier: "standard" });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.code).toBe("run_already_registered");
    }
  });

  it("createRun init fails closed on zod violations (field paths only, §15.3)", () => {
    const { machine } = freshMachine(0);
    const badBudget = machine.createRun("run_a", {
      tier: "standard",
      wallClockMs: 0,
    });
    expect(badBudget.ok).toBe(false);
    if (!badBudget.ok) {
      expect(badBudget.code).toBe("run_state_input_invalid");
      expect(badBudget.hint).toContain("wallClockMs");
    }
    const badStatus = machine.createRun("run_b", {
      tier: "standard",
      status: "bogus" as unknown as RunStatus, // wiring-bug guard
    });
    expect(badStatus.ok).toBe(false);
  });

  it("transition ctx fails closed on unknown keys and bad envelopes", () => {
    const { machine, runId } = freshMachine(0);
    const extra = machine.transition(runId, "planning", {
      revisionBefore: 1,
      surprise: true,
    } as unknown as TransitionContext);
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.code).toBe("run_state_input_invalid");
    }
    machine.transition(runId, "planning", { revisionBefore: 1 });
    driveTo(machine, runId, "finalizing");
    const badEnvelope = machine.transition(runId, "failed", {
      error: { code: "", message: "x" } as unknown as TransitionContext["error"],
    });
    expect(badEnvelope.ok).toBe(false);
  });

  it("constructor options fail fast on non-function clock/emit", () => {
    expect(() => new RunStateMachine({ clock: 42 as unknown as Clock })).toThrow();
    expect(
      () => new RunStateMachine({ emit: { publish: "nope" } as unknown as EmitLike }),
    ).toThrow();
    expect(() => new RunStateMachine({ historyCap: 0 })).toThrow();
    expect(() => new RunStateMachine({})).not.toThrow(); // all defaults
  });
});

// --- History + snapshots ------------------------------------------------------------------

describe("RunStateMachine history and snapshots", () => {
  it("records timestamped, monotonic history via the injected clock", () => {
    const { machine, clock, runId } = freshMachine(1_000);
    clock.set(2_000);
    machine.transition(runId, "planning", { revisionBefore: 7 });
    clock.set(3_500);
    machine.transition(runId, "executing", { plan: PLAN });
    const history = machine.history(runId) ?? [];
    expect(history.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(history[0]?.atMs).toBe(1_000); // creation
    expect(history[1]?.atMs).toBe(2_000);
    expect(history[2]?.atMs).toBe(3_500);
    expect(history.every((record) => record.runId === runId)).toBe(true);
    expect(history[0]?.from).toBeNull();
    expect(history[0]?.to).toBe("queued");
    expect(history[1]?.from).toBe("queued");
    expect(history[1]?.to).toBe("planning");
  });

  it("caps history at historyCap (oldest dropped) with the default documented", () => {
    expect(DEFAULT_HISTORY_CAP).toBe(256);
    const clock = fakeClock(0);
    const machine = new RunStateMachine({ clock: clock.clock, historyCap: 3 });
    machine.createRun("run_cap", { tier: "quick" });
    machine.transition("run_cap", "planning", { revisionBefore: 1 });
    machine.transition("run_cap", "executing", { plan: PLAN });
    machine.transition("run_cap", "observing", {});
    machine.transition("run_cap", "rendering", {});
    const history = machine.history("run_cap") ?? [];
    expect(history.length).toBe(3);
    expect(history[0]?.seq).toBe(2); // the two oldest were dropped
  });

  it("snapshot exposes the deadline math on the injected clock", () => {
    const { machine, clock, runId } = freshMachine(1_000);
    const created = machine.snapshot(runId);
    expect(created?.status).toBe("queued");
    expect(created?.startedAtMs).toBeNull();
    expect(created?.deadlineAtMs).toBeNull();
    expect(created?.deadlineRemainingMs).toBeNull();
    expect(created?.timedOut).toBe(false);
    expect(created?.transitions).toBe(1);

    machine.transition(runId, "planning", { revisionBefore: 7 });
    clock.set(1_000 + 60_000);
    const active = machine.snapshot(runId);
    expect(active?.startedAtMs).toBe(1_000);
    expect(active?.deadlineAtMs).toBe(301_000);
    expect(active?.deadlineRemainingMs).toBe(240_000);
    expect(active?.timedOut).toBe(false);

    clock.set(301_000);
    expect(machine.snapshot(runId)?.timedOut).toBe(true);
    expect(machine.snapshot(runId)?.deadlineRemainingMs).toBe(0);
  });

  it("honors an explicit wallClockMs override (tests / §3.4 resume budget)", () => {
    const clock = fakeClock(0);
    const custom = new RunStateMachine({ clock: clock.clock });
    custom.createRun("run_w", { tier: "standard", wallClockMs: 5_000 });
    custom.transition("run_w", "planning", { revisionBefore: 1 });
    clock.set(5_000);
    const forced = custom.transition("run_w", "executing", { plan: PLAN });
    assertOk(forced);
    expect(forced.forced).toBe(true);
    expect(forced.timeout?.limitMs).toBe(5_000);
  });
});
