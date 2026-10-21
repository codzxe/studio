// W6-J — cooperative cancellation tests: §3.4 cancel semantics, abort
// propagation, idempotency, terminal rejections, and the run-manager path.
import { describe, expect, it } from "vitest";
import type { Clock } from "../src/budgets.js";
import type { Plan } from "../src/plan.js";
import type { RunStatus } from "../src/state.js";
import { RunStateMachine, type EmitLike, type RunEventType } from "../src/run-state/machine.js";
import {
  CancellationCoordinator,
  type AbortControllerFactory,
  type AbortControllerLike,
  type AbortSignalLike,
  type CancellationMachineLike,
  type CancelRequest,
  type RunSnapshot,
} from "../src/run-state/cancellation.js";

interface CapturedEvent {
  readonly runId: string;
  readonly type: RunEventType;
  readonly payload: unknown;
}

// --- Deterministic helpers --------------------------------------------------------

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

/**
 * The §5.5 plan is validated upstream (§5.1 plan-first); its content is
 * opaque to the machine, which only carries it onto `run.plan`.
 */
const PLAN: Plan = {} as unknown as Plan;

class FakeSignal implements AbortSignalLike {
  aborted = false;
  reason: unknown = undefined;
  readonly listeners = new Set<() => void>();
  readonly fired: (() => void)[] = [];

  addEventListener(_type: "abort", listener: () => void): void {
    if (!this.aborted) {
      this.listeners.add(listener);
    }
  }

  removeEventListener(_type: "abort", listener: () => void): void {
    this.listeners.delete(listener);
  }

  fire(reason: unknown): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) {
      this.fired.push(listener);
      listener();
    }
    this.listeners.clear();
  }
}

class FakeController implements AbortControllerLike {
  abortCount = 0;
  readonly #signal = new FakeSignal();

  get signal(): FakeSignal {
    return this.#signal;
  }

  abort(reason?: unknown): void {
    this.abortCount += 1;
    this.#signal.fire(reason);
  }
}

/** Controller factory that hands back tracked fakes (deterministic §3.4 tests). */
function fakeControllerFactory(): {
  factory: AbortControllerFactory;
  controllers: FakeController[];
} {
  const controllers: FakeController[] = [];
  return {
    controllers,
    factory: () => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    },
  };
}

/** Machine + coordinator wired together, run driven to an active status. */
function setupActive(startAtMs = 0, status: RunStatus = "executing"): {
  clock: { clock: Clock; set: (ms: number) => void };
  machine: RunStateMachine;
  coordinator: CancellationCoordinator;
  controllers: FakeController[];
  events: CapturedEvent[];
  runId: string;
} {
  const clock = fakeClock(startAtMs);
  const events: CapturedEvent[] = [];
  const emit: EmitLike = {
    publish: (runId, type, payload) => {
      events.push({ runId, type, payload });
    },
  };
  const machine = new RunStateMachine({ clock: clock.clock, emit });
  const controllers = fakeControllerFactory();
  const coordinator = new CancellationCoordinator({
    machine,
    clock: clock.clock,
    controllerFactory: controllers.factory,
  });
  const runId = "run_cancel";
  const created = machine.createRun(runId, { tier: "standard" });
  if (!created.ok) {
    throw new Error(`createRun failed: ${created.message}`);
  }
  clock.set(startAtMs + 1000);
  machine.transition(runId, "planning", { revisionBefore: 3 });
  if (status === "executing") {
    machine.transition(runId, "executing", { plan: PLAN });
  } else if (status === "repairing") {
    machine.transition(runId, "executing", { plan: PLAN });
    machine.transition(runId, "observing", {});
    machine.transition(runId, "rendering", {});
    machine.transition(runId, "validating", {});
    machine.transition(runId, "repairing", {});
  } else if (status === "finalizing") {
    machine.transition(runId, "executing", { plan: PLAN });
    machine.transition(runId, "observing", {});
    machine.transition(runId, "rendering", {});
    machine.transition(runId, "validating", {});
    machine.transition(runId, "finalizing", {});
  } else if (status === "queued") {
    // stay queued: the run was never picked up
  } else {
    throw new Error(`setupActive: unsupported status '${status}'`);
  }
  return { clock, machine, coordinator, controllers, events, runId };
}

function snapshotOf(runId: string, status: RunStatus): RunSnapshot {
  return {
    runId,
    status,
    tier: "standard",
    wallClockMs: 300_000,
    createdAtMs: 0,
    startedAtMs: 0,
    deadlineAtMs: 300_000,
    deadlineRemainingMs: 300_000,
    timedOut: false,
    transitions: 1,
  };
}

// --- Signal seam -------------------------------------------------------------------

describe("CancellationCoordinator signal seam", () => {
  it("signalFor is lazily created, stable per run, and starts unaborted", () => {
    const { coordinator, runId } = setupActive();
    const signal = coordinator.signalFor(runId);
    expect(signal.aborted).toBe(false);
    expect(coordinator.signalFor(runId)).toBe(signal); // stable identity
    expect(coordinator.signalFor("run_other")).not.toBe(signal); // per-run isolation
    expect(coordinator.isCancelled(runId)).toBe(false);
    expect(coordinator.request(runId)).toBeNull();
  });

  it("works against a structural machine seam (no RunStateMachine required)", () => {
    const machine: CancellationMachineLike = {
      snapshot: (runId: string) => (runId === "r1" ? snapshotOf("r1", "executing") : null),
    };
    const controllers = fakeControllerFactory();
    const coordinator = new CancellationCoordinator({
      machine,
      controllerFactory: controllers.factory,
    });
    const ok = coordinator.cancel("r1", { reason: "stop please" });
    expect(ok.ok).toBe(true);
    expect(coordinator.isCancelled("r1")).toBe(true);
    const missing = coordinator.cancel("r2");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("run_not_found");
    }
  });

  it("the constructor fails fast without a machine seam", () => {
    expect(() => new CancellationCoordinator({} as unknown as CancellationMachineLike)).toThrow();
  });
});

// --- §3.4 cancel semantics ------------------------------------------------------------

describe("CancellationCoordinator §3.4 cancel semantics", () => {
  it("cancel during an active run fires the signal and leaves run state untouched (cooperative)", () => {
    const { clock, machine, coordinator, controllers, runId } = setupActive(0);
    const historyBefore = machine.history(runId)?.length ?? 0;

    // The executor observes the shared signal (§3.4 cooperative chain).
    const signal = coordinator.signalFor(runId);
    let unwound = false;
    signal.addEventListener?.("abort", () => {
      unwound = true;
    });

    clock.set(9_000);
    const result = coordinator.cancel(runId, { reason: "user hit stop", requestedBy: "api" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.firstCancel).toBe(true);
    expect(result.signal.aborted).toBe(true);
    expect(unwound).toBe(true); // the abort propagated to the observer
    expect(result.request?.reason).toBe("user hit stop");
    expect(result.request?.requestedBy).toBe("api");
    expect(result.request?.requestedAtMs).toBe(9_000); // injected clock
    expect(coordinator.request(runId)).toEqual(result.request);
    expect(coordinator.isCancelled(runId)).toBe(true);
    expect(controllers[0]?.abortCount).toBe(1);

    // Cooperative: the machine is untouched until the run manager rolls back.
    expect(machine.snapshot(runId)?.status).toBe("executing");
    expect(machine.history(runId)?.length).toBe(historyBefore);
  });

  it("the run manager lands `cancelled` through the machine (run.cancelled + idempotent re-cancel)", () => {
    const { machine, coordinator, controllers, events, runId } = setupActive(0);
    const first = coordinator.cancel(runId, { reason: "user hit stop" });
    expect(first.ok).toBe(true);

    const landed = machine.transition(runId, "cancelled", {
      reason: first.ok && first.request ? first.request.reason : undefined,
    });
    expect(landed.ok).toBe(true);
    if (landed.ok) {
      expect(landed.emitted).toBe("run.cancelled");
    }
    const cancelledEvent = events.find((event) => event.type === "run.cancelled");
    expect(cancelledEvent?.payload).toEqual({ reason: "user hit stop" });

    // Double cancel AFTER the terminal state: no-op success (§3.4).
    const second = coordinator.cancel(runId, { reason: "changed my mind" });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.message);
    }
    expect(second.firstCancel).toBe(false);
    expect(controllers[0]?.abortCount).toBe(1); // no second abort fired
    expect(second.request?.reason).toBe("user hit stop"); // the FIRST request stands
  });

  it("double cancel while the unwind is still in flight is an idempotent no-op", () => {
    const { coordinator, controllers, runId } = setupActive(0);
    const first = coordinator.cancel(runId, { reason: "user hit stop" });
    const second = coordinator.cancel(runId, { reason: "again" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("cancel failed");
    }
    expect(first.firstCancel).toBe(true);
    expect(second.firstCancel).toBe(false);
    expect(controllers[0]?.abortCount).toBe(1);
    expect(second.request).toEqual(first.request); // stable reason under replays (§3.4)
  });

  it("cancel after a non-cancelled terminal run is a typed run_already_terminal", () => {
    const succeeded = setupActive(0);
    succeeded.machine.transition(succeeded.runId, "observing", {});
    succeeded.machine.transition(succeeded.runId, "rendering", {});
    succeeded.machine.transition(succeeded.runId, "validating", {});
    succeeded.machine.transition(succeeded.runId, "finalizing", {});
    succeeded.machine.transition(succeeded.runId, "succeeded", { revisionAfter: 10 });
    const result = succeeded.coordinator.cancel(succeeded.runId, { reason: "too late" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("run_already_terminal");
      expect(result.message).toContain("succeeded");
      expect(result.retryable).toBe(false);
    }
    expect(succeeded.coordinator.isCancelled(succeeded.runId)).toBe(false);
    expect(succeeded.controllers[0]?.abortCount).toBe(0);
    expect(succeeded.coordinator.request(succeeded.runId)).toBeNull();

    const failed = setupActive(0);
    failed.machine.transition(failed.runId, "failed", {
      error: { code: "engine_timeout", message: "dead" },
    });
    const failedCancel = failed.coordinator.cancel(failed.runId);
    expect(failedCancel.ok).toBe(false);
    if (!failedCancel.ok) {
      expect(failedCancel.code).toBe("run_already_terminal");
      expect(failedCancel.message).toContain("failed");
    }
  });

  it("cancel during repair follows the same cooperative path (§5.1 repair loop)", () => {
    const { machine, coordinator, events, runId } = setupActive(0, "repairing");
    const signal = coordinator.signalFor(runId);
    let observed = false;
    signal.addEventListener?.("abort", () => {
      observed = true;
    });

    const result = coordinator.cancel(runId, { reason: "user hit stop" });
    expect(result.ok).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(observed).toBe(true);
    expect(machine.snapshot(runId)?.status).toBe("repairing"); // cooperative

    // Same path: the run manager lands cancelled (repairing → cancelled is §5.1-legal).
    const landed = machine.transition(runId, "cancelled", { reason: "user hit stop" });
    expect(landed.ok).toBe(true);
    if (landed.ok) {
      expect(landed.emitted).toBe("run.cancelled");
    }
    expect(events.some((event) => event.type === "run.cancelled")).toBe(true);
  });

  it("cancel during queued fires the signal; the queue runner lands cancelled", () => {
    const { machine, coordinator, runId } = setupActive(0, "queued");
    const result = coordinator.cancel(runId, { reason: "never mind" });
    expect(result.ok).toBe(true);
    expect(coordinator.isCancelled(runId)).toBe(true);
    expect(machine.snapshot(runId)?.status).toBe("queued");
    const landed = machine.transition(runId, "cancelled", { reason: "never mind" });
    expect(landed.ok).toBe(true);
  });

  it("cancel during finalizing lands cancelled (finalizing → cancelled is §5.1-legal)", () => {
    const { machine, coordinator, runId } = setupActive(0, "finalizing");
    const result = coordinator.cancel(runId, { reason: "stop before commit" });
    expect(result.ok).toBe(true);
    const landed = machine.transition(runId, "cancelled", { reason: "stop before commit" });
    expect(landed.ok).toBe(true);
  });

  it("cancel of an unknown run is a typed run_not_found", () => {
    const { coordinator } = setupActive(0);
    const result = coordinator.cancel("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("run_not_found");
      expect(result.retryable).toBe(false);
    }
  });

  it("a blank reason falls back to the neutral default", () => {
    const { coordinator, runId } = setupActive(0);
    const result = coordinator.cancel(runId, { reason: "   " });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.request?.reason).toBe("Cancelled by request");
    const other = setupActive(0, "repairing");
    const omitted = other.coordinator.cancel(other.runId);
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) {
      throw new Error(omitted.message);
    }
    const request: CancelRequest | null = omitted.request;
    expect(request?.reason).toBe("Cancelled by request");
    expect(request?.requestedBy).toBe("user"); // default caller
  });
});

// --- Default factory + DOM semantics ----------------------------------------------------

describe("CancellationCoordinator default controller factory", () => {
  it("uses the Node global AbortController when present (runtime identity check)", () => {
    const machine = new RunStateMachine();
    machine.createRun("run_global", { tier: "quick" });
    machine.transition("run_global", "planning", { revisionBefore: 1 });
    const coordinator = new CancellationCoordinator({ machine });

    const signal = coordinator.signalFor("run_global");
    let fired = false;
    signal.addEventListener?.("abort", () => {
      fired = true;
    });
    const result = coordinator.cancel("run_global", { reason: "user hit stop" });
    expect(result.ok).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(fired).toBe(true);
    // No @types/node peer in this package: identity is checked structurally.
    const ctor = (signal as { constructor?: { name?: string } }).constructor?.name;
    if (ctor !== undefined) {
      expect(ctor).toBe("AbortController");
    }
  });

  it("a listener added after the abort never fires (DOM semantics)", () => {
    const { coordinator, runId } = setupActive(0);
    coordinator.cancel(runId, { reason: "first" });
    const signal = coordinator.signalFor(runId);
    let late = false;
    signal.addEventListener?.("abort", () => {
      late = true;
    });
    expect(late).toBe(false);
    expect(signal.aborted).toBe(true);
  });
});
