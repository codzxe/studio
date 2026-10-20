// @studio/engine-pool — session health probe: the §3.2 watchdog's sensing leg.
// Pings the engine with the cheapest control roundtrip — `methods` (Appendix B,
// verified in vendor crates/automation/src/rpc.rs: the server echoes its method
// list) — under a bounded timeout, classifies the session healthy|slow|dead by
// latency thresholds, and records liveness in the session registry (the pool's
// `touch`, which advances lastActivityAt so a responsive engine mid-work is not
// recycled by the idle sweep).
//
// The pool watchdog (src/pool.ts) consumes `HealthSweepReport`: dead → recycle +
// crash marking, the worker replays the command log from the last checkpoint
// (§3.4); slow → leave alive but logged (§22); healthy → liveness recorded. This
// module only measures and classifies — recycle policy stays with the pool.
//
// Nothing here throws: probe failures are classified `dead` with a generic detail
// (§4: never leak engine internals); the injected liveness recorder can never break
// a probe (raced session removal is swallowed into the logger).

import type { EngineSession } from "./types.js";

export type SessionHealthStatus = "healthy" | "slow" | "dead";

/**
 * Classification thresholds. Latency at or above a threshold drops a band:
 * healthy < slowMs <= slow < deadMs <= dead. A probe that times out (or errors)
 * is dead regardless. Defaults: a `methods` echo is sub-second on a healthy box,
 * so 1 s = slow; 3 s = effectively unusable; the probe window matches §3.4's 5 s
 * typical tool timeout (ENGINE_TOOL_TIMEOUT_MS, config engine-pool env).
 */
export interface HealthThresholds {
  readonly slowMs: number;
  readonly deadMs: number;
  readonly probeTimeoutMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  slowMs: 1_000,
  deadMs: 3_000,
  probeTimeoutMs: 5_000,
};

/** One probe observation, classified later by `classifyHealthProbe`. */
export type HealthProbeOutcome =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly reason: "timeout" | "error" };

/**
 * Engine seam: one `methods` roundtrip (Appendix B). Structural —
 * packages/engine-client (W2) adapts the JSON-RPC call at the composition root.
 */
export interface HealthProbeClient {
  methods(session: EngineSession): Promise<readonly string[]>;
}

/** Liveness sink: on a healthy/slow probe the session is marked alive. */
export interface LivenessRecorder {
  touch(sessionId: string, at: number): void;
}

/** Structural slice of the session registry the recorder writes to (§3.2 touch). */
export interface LivenessRegistry {
  update(sessionId: string, patch: { readonly lastActivityAt: number }): unknown;
}

/**
 * Registry-backed recorder. `SessionRegistry.update` throws for unknown ids —
 * a probe can race a concurrent recycle, so the throw is swallowed into the
 * logger (an observer must never break the probe, §22 discipline).
 */
export const createLivenessRecorder = (
  registry: LivenessRegistry,
  logger?: { warn(message: string, data?: Record<string, unknown>): void },
): LivenessRecorder => ({
  touch: (sessionId: string, at: number): void => {
    try {
      registry.update(sessionId, { lastActivityAt: at });
    } catch (error) {
      logger?.warn("engine-pool: liveness touch skipped (session raced with recycle)", {
        sessionId,
        error: String(error),
      });
    }
  },
});

/** One probe's classification evidence. */
export interface SessionHealthReport {
  readonly sessionId: string;
  readonly status: SessionHealthStatus;
  /** Roundtrip latency, or null when the probe never completed. */
  readonly latencyMs: number | null;
  /** Present only when the probe did not complete. */
  readonly reason?: "timeout" | "error";
  readonly detail: string;
  readonly checkedAt: number;
}

/** Sweep aggregate the pool watchdog acts on (§3.2 idle/crash bookkeeping). */
export interface HealthSweepReport {
  readonly reports: readonly SessionHealthReport[];
  readonly byStatus: Readonly<Record<SessionHealthStatus, number>>;
  readonly healthy: readonly string[];
  readonly slow: readonly string[];
  readonly dead: readonly string[];
}

/**
 * Pure classifier, table-driven by construction:
 *   ok + latency < slowMs           → healthy
 *   ok + slowMs <= latency < deadMs → slow
 *   ok + deadMs <= latency          → dead (alive on the wire, unusable in practice)
 *   timeout / error                 → dead
 */
export function classifyHealthProbe(
  outcome: HealthProbeOutcome,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): SessionHealthStatus {
  if (!outcome.ok) return "dead";
  if (outcome.latencyMs >= thresholds.deadMs) return "dead";
  if (outcome.latencyMs >= thresholds.slowMs) return "slow";
  return "healthy";
}

/** Merge a partial override over the defaults, enforcing the band ordering. */
export function resolveHealthThresholds(partial?: Partial<HealthThresholds>): HealthThresholds {
  const merged: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, ...partial };
  const valid =
    merged.slowMs > 0 &&
    Number.isFinite(merged.slowMs) &&
    merged.deadMs >= merged.slowMs &&
    merged.probeTimeoutMs >= merged.deadMs;
  if (!valid) {
    throw new Error("health thresholds must satisfy 0 < slowMs <= deadMs <= probeTimeoutMs");
  }
  return merged;
}

export interface HealthMonitorOptions {
  readonly client: HealthProbeClient;
  /** Liveness sink used after a healthy/slow probe; absent → probe is read-only. */
  readonly liveness?: LivenessRecorder;
  readonly thresholds?: Partial<HealthThresholds>;
  /** Injectable clock (epoch ms) so latency is deterministic in tests. */
  readonly clock?: () => number;
  /** Injectable probe deadline; defaults to an unref'd timer (never holds drain). */
  readonly deadline?: (ms: number) => Promise<"timeout">;
  /** Optional structured logger (§22); defaults to a silent sink, like the pool. */
  readonly logger?: { warn(message: string, data?: Record<string, unknown>): void };
};

const defaultDeadline = (ms: number): Promise<"timeout"> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    // Never hold the event loop open during a drain for a probe that lost its race.
    timer.unref();
  });

export class HealthMonitor {
  readonly #client: HealthProbeClient;
  readonly #liveness: LivenessRecorder | undefined;
  readonly #thresholds: HealthThresholds;
  readonly #clock: () => number;
  readonly #deadline: (ms: number) => Promise<"timeout">;
  readonly #logger: { warn(message: string, data?: Record<string, unknown>): void };

  constructor(options: HealthMonitorOptions) {
    this.#client = options.client;
    this.#liveness = options.liveness;
    this.#thresholds = resolveHealthThresholds(options.thresholds);
    this.#clock = options.clock ?? Date.now;
    this.#deadline = options.deadline ?? defaultDeadline;
    this.#logger = options.logger ?? { warn: (): void => undefined };
  }

  /**
   * Ping one session: `methods` roundtrip raced against the probe window. A
   * healthy or slow reply records liveness (registry `touch`); a dead reply
   * records nothing — the watchdog decides the recycle (§3.4).
   */
  async probe(session: EngineSession): Promise<SessionHealthReport> {
    const startedAt = this.#clock();
    let outcome: HealthProbeOutcome;
    try {
      outcome = await Promise.race([
        this.#client
          .methods(session)
          .then(
            (): HealthProbeOutcome => ({ ok: true, latencyMs: this.#clock() - startedAt }),
          ),
        this.#deadline(this.#thresholds.probeTimeoutMs).then(
          (): HealthProbeOutcome => ({ ok: false, reason: "timeout" }),
        ),
      ]);
    } catch (error) {
      // §4: internals go to the logger only; the report stays generic.
      this.#logger.warn("engine-pool: health probe failed", {
        sessionId: session.sessionId,
        error: String(error),
      });
      outcome = { ok: false, reason: "error" };
    }

    const status = classifyHealthProbe(outcome, this.#thresholds);
    const checkedAt = this.#clock();
    if (status !== "dead") {
      try {
        this.#liveness?.touch(session.sessionId, checkedAt);
      } catch (error) {
        this.#logger.warn("engine-pool: liveness recorder failed", {
          sessionId: session.sessionId,
          error: String(error),
        });
      }
    }

    const detail = this.#describe(outcome, status);
    return {
      sessionId: session.sessionId,
      status,
      latencyMs: outcome.ok ? outcome.latencyMs : null,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
      detail,
      checkedAt,
    };
  }

  /**
   * Probe many sessions concurrently and aggregate for the pool watchdog:
   * `dead` ids are recycle/crash candidates, `slow` ids stay alive but flagged.
   */
  async sweep(sessions: readonly EngineSession[]): Promise<HealthSweepReport> {
    const reports = await Promise.all(sessions.map((session) => this.probe(session)));
    const byStatus: Record<SessionHealthStatus, number> = { healthy: 0, slow: 0, dead: 0 };
    const healthy: string[] = [];
    const slow: string[] = [];
    const dead: string[] = [];
    for (const report of reports) {
      byStatus[report.status] += 1;
      if (report.status === "healthy") healthy.push(report.sessionId);
      else if (report.status === "slow") slow.push(report.sessionId);
      else dead.push(report.sessionId);
    }
    return { reports, byStatus, healthy, slow, dead };
  }

  #describe(outcome: HealthProbeOutcome, status: SessionHealthStatus): string {
    if (status === "healthy") return "engine replied to the methods roundtrip within budget";
    if (status === "slow") return "engine replied slower than the healthy budget";
    if (outcome.ok) return "engine replied beyond the dead threshold";
    return outcome.reason === "timeout"
      ? "engine did not reply to the probe within the window"
      : "engine probe failed";
  }
}
