// @studio/agent — cooperative external cancellation. Owner: W6-J (docs/AGENTS.md).
//
// Spec anchors:
//   §5.1  `cancelled` is reachable from every non-terminal state; terminal
//         states never transition again.
//   §3.4  cancel semantics: an external cancel (user/API) drives a
//         COOPERATIVE AbortSignal chain — cancel(runId) fires the per-run
//         abort signal → the executor/validator observe it and unwind → the
//         RUN MANAGER triggers the rollback path (agent.rollback, §5.1 one
//         transaction) and lands the machine in `cancelled` via
//         machine.transition(runId, "cancelled", { reason }). The coordinator
//         never mutates run state itself: a loop that never observes the
//         signal is still bounded by the §5.2 wall-clock funnel (machine.ts).
//   §3.4  idempotency: a second cancel is a no-op SUCCESS while the first is
//         still unwinding and after the run already reached `cancelled`;
//         cancelling a run that ended in a DIFFERENT terminal state is a
//         typed `run_already_terminal` failure. The first request stands —
//         the reason never changes under replays (retries never double-apply).
//   §15.1 the run id is the only identifier crossing this seam.
//
// Signal seam: AbortSignalLike/AbortControllerLike are structural stand-ins
// (planner.ts / engine-client precedent) so this package needs no `@types/node`
// peer; Node's global AbortController satisfies them at runtime.
import type { Clock } from "../budgets.js";
import { isTerminal } from "../state.js";
import {
  DEFAULT_CANCEL_REASON,
  type RunSnapshot,
  type RunStateFailure,
  runStateFailure,
} from "./machine.js";

/** Structural stand-in for the DOM/Node AbortSignal (planner.ts precedent). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

/** Structural stand-in for the DOM/Node AbortController. */
export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

/** Factory for per-run controllers (injectable for deterministic tests). */
export type AbortControllerFactory = () => AbortControllerLike;

/** Read-only machine seam — the real RunStateMachine satisfies it structurally. */
export interface CancellationMachineLike {
  snapshot(runId: string): RunSnapshot | null;
}

/** Convenience re-export: seam users need not import machine.js as well. */
export type { RunSnapshot } from "./machine.js";

export interface CancelRequestOptions {
  /** Surfaced on `run.cancelled` + the run timeline. Empty → DEFAULT_CANCEL_REASON. */
  readonly reason?: string;
  /** Who asked (timeline annotation): "user" (default) | "api" | "system". */
  readonly requestedBy?: string;
}

/** The recorded external request — the run manager's source for the rollback reason. */
export interface CancelRequest {
  readonly runId: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAtMs: number;
}

export interface CancelSuccess {
  readonly ok: true;
  readonly runId: string;
  /** False when this call was a §3.4 idempotent no-op (double cancel). */
  readonly firstCancel: boolean;
  /** The run's abort signal (fired on the first cancel; stable identity). */
  readonly signal: AbortSignalLike;
  /** The recorded request (the ORIGINAL one on idempotent replays); null before any. */
  readonly request: CancelRequest | null;
}

export type CancelResult = CancelSuccess | RunStateFailure;

export interface CancellationCoordinatorOptions {
  /** Read-only status seam — the coordinator never mutates run state (§3.4). */
  readonly machine: CancellationMachineLike;
  /** Injectable wall clock (epoch ms) — tests/replay determinism. */
  readonly clock?: Clock;
  /** Per-run controller factory; defaults to the global AbortController. */
  readonly controllerFactory?: AbortControllerFactory;
}

const defaultClock: Clock = () => Date.now();

/** Node/DOM AbortController probed without a @types/node peer (planner precedent). */
function globalAbortController(): AbortControllerLike | null {
  const candidate = (globalThis as unknown as { AbortController?: unknown }).AbortController;
  return typeof candidate === "function"
    ? new (candidate as new () => AbortControllerLike)()
    : null;
}

/** Deterministic fallback for runtimes without a global AbortController. */
class BasicAbortSignal implements AbortSignalLike {
  #aborted = false;
  #reason: unknown = undefined;
  readonly #listeners = new Set<() => void>();

  get aborted(): boolean {
    return this.#aborted;
  }

  get reason(): unknown {
    return this.#reason;
  }

  addEventListener(_type: "abort", listener: () => void): void {
    // DOM semantics: a listener added after the abort never fires.
    if (!this.#aborted) {
      this.#listeners.add(listener);
    }
  }

  removeEventListener(_type: "abort", listener: () => void): void {
    this.#listeners.delete(listener);
  }

  fire(reason: unknown): void {
    if (this.#aborted) {
      return;
    }
    this.#aborted = true;
    this.#reason = reason;
    for (const listener of [...this.#listeners]) {
      listener();
    }
    this.#listeners.clear();
  }
}

class BasicAbortController implements AbortControllerLike {
  readonly #signal = new BasicAbortSignal();

  get signal(): AbortSignalLike {
    return this.#signal;
  }

  abort(reason?: unknown): void {
    this.#signal.fire(reason);
  }
}

const defaultAbortControllerFactory: AbortControllerFactory = () =>
  globalAbortController() ?? new BasicAbortController();

/**
 * Coordinates external cancellations for every run in the process. One
 * instance per process alongside the RunStateMachine; all per-run state is
 * keyed by runId (§15.1: the run id is the only identifier here).
 */
export class CancellationCoordinator {
  readonly #machine: CancellationMachineLike;
  readonly #clock: Clock;
  readonly #factory: AbortControllerFactory;
  readonly #controllers = new Map<string, AbortControllerLike>();
  readonly #requests = new Map<string, CancelRequest>();

  constructor(options: CancellationCoordinatorOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.machine !== "object" ||
      options.machine === null ||
      typeof options.machine.snapshot !== "function"
    ) {
      // Fail fast on a wiring bug (BudgetTracker precedent): the constructor
      // takes code, not runtime data.
      throw new Error(
        "[run-state] CancellationCoordinator requires a machine seam with snapshot(runId)",
      );
    }
    this.#machine = options.machine;
    this.#clock = options.clock ?? defaultClock;
    this.#factory = options.controllerFactory ?? defaultAbortControllerFactory;
  }

  /**
   * The run's abort signal (lazily created, stable identity per run). Hand
   * this to the executor/validator seams — they observe `aborted` (and may
   * subscribe to "abort") and unwind cooperatively (§3.4).
   */
  signalFor(runId: string): AbortSignalLike {
    return this.#controllerFor(runId).signal;
  }

  /**
   * External cancel (user/API). Never mutates run state: it fires the signal
   * and records the request; the RUN MANAGER observes, rolls back, and lands
   * `cancelled` through machine.transition (see the header diagram).
   *
   * Outcomes:
   *   - active run, first cancel  → ok, firstCancel: true (signal fired);
   *   - double cancel (unwinding) → ok, firstCancel: false (§3.4 idempotent);
   *   - run already `cancelled`   → ok, firstCancel: false (no-op success);
   *   - other terminal run        → typed `run_already_terminal` failure;
   *   - unknown run               → typed `run_not_found` failure.
   */
  cancel(runId: string, options: CancelRequestOptions = {}): CancelResult {
    const snapshot = this.#machine.snapshot(runId);
    if (snapshot === null) {
      return runStateFailure(
        "run_not_found",
        `Run '${runId}' is not registered in the run state machine.`,
        {
          hint: "The run manager registers runs (machine.createRun) before executors observe signals.",
          retryable: false,
        },
      );
    }
    const controller = this.#controllerFor(runId);
    if (snapshot.status === "cancelled") {
      // Idempotent double-cancel: the run already reached `cancelled` (§3.4).
      return {
        ok: true,
        runId,
        firstCancel: false,
        signal: controller.signal,
        request: this.#requests.get(runId) ?? null,
      };
    }
    if (isTerminal(snapshot.status)) {
      return runStateFailure(
        "run_already_terminal",
        `Run '${runId}' already finished with status '${snapshot.status}' — it can no longer be cancelled.`,
        { hint: "Start a new run instead (§5.1: terminals never transition).", retryable: false },
      );
    }
    if (controller.signal.aborted) {
      // Idempotent while the cooperative unwind is still in flight: the first
      // request stands (stable reason) and no second abort fires (§3.4).
      return {
        ok: true,
        runId,
        firstCancel: false,
        signal: controller.signal,
        request: this.#requests.get(runId) ?? null,
      };
    }
    const reason =
      options.reason === undefined || options.reason.trim() === ""
        ? DEFAULT_CANCEL_REASON
        : options.reason;
    const request: CancelRequest = {
      runId,
      reason,
      requestedBy: options.requestedBy ?? "user",
      requestedAtMs: this.#clock(),
    };
    this.#requests.set(runId, request);
    controller.abort(reason);
    return { ok: true, runId, firstCancel: true, signal: controller.signal, request };
  }

  /** The recorded external request, if any (the rollback reason lives here). */
  request(runId: string): CancelRequest | null {
    return this.#requests.get(runId) ?? null;
  }

  /** True once cancel(runId) fired the signal (stays true — AbortSignal semantics). */
  isCancelled(runId: string): boolean {
    return this.#controllerFor(runId).signal.aborted;
  }

  #controllerFor(runId: string): AbortControllerLike {
    let controller = this.#controllers.get(runId);
    if (controller === undefined) {
      controller = this.#factory();
      this.#controllers.set(runId, controller);
    }
    return controller;
  }
}
