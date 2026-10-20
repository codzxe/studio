// @studio/engine-pool — EnginePool: the supervisor orchestrator (§3.2).
// One serve process per active session, per-tenant isolation, fresh 256-bit token per
// process, plan caps, idle watchdog, graceful drain. All process interaction goes
// through the injected `Spawner`; the real one (photocraft-cli serve, §2.2) lands in
// Wave 2. No I/O happens in this file, which keeps every path unit-testable.

import { randomBytes, randomUUID } from "node:crypto";

import { DEFAULT_DRAIN_GRACE_MS, DEFAULT_IDLE_TIMEOUT_MS, TOKEN_BYTES } from "./constants.js";
import {
  engineUnavailable,
  isEnginePoolError,
  sessionLimitReached,
  sessionNotFound,
  spawnFailed,
  toEnvelope,
  watchdogTimeout,
} from "./errors.js";
import { SessionRegistry } from "./registry.js";
import type {
  EnginePoolOptions,
  EngineProcess,
  EngineSession,
  EngineSessionState,
  PoolEvent,
  PoolSnapshot,
  SessionSpec,
  StopSignal,
  WatchdogReport,
  WatchdogStopFailure,
} from "./types.js";

export class EnginePool {
  readonly #options: EnginePoolOptions;
  readonly #registry: SessionRegistry;
  readonly #processes = new Map<string, EngineProcess>();
  /** In-flight allocations per org — closes the cap's check-then-spawn race. */
  readonly #pendingByOrg = new Map<string, number>();
  readonly #idleTimeoutMs: number;
  readonly #drainGraceMs: number;
  readonly #logger: { warn(message: string, data?: Record<string, unknown>): void };
  #drained = false;

  constructor(options: EnginePoolOptions) {
    this.#options = options;
    this.#registry = new SessionRegistry({ clock: options.clock });
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    this.#logger = options.logger ?? { warn: (): void => undefined };
  }

  /**
   * Bring up one engine process for one tenant (§3.2). Validates the plan cap,
   * mints a fresh 256-bit token, spawns + starts the process, and registers the
   * session as `allocated`. The returned session is a copy; the token inside must
   * never be logged or sent to the browser (§15.1).
   */
  async allocate(spec: SessionSpec): Promise<EngineSession> {
    if (this.#drained) {
      throw engineUnavailable({
        message: "Engine pool is shutting down",
        hint: "This supervisor instance has been drained; use a new pool instance.",
      });
    }
    const { organizationId } = spec;
    const pending = this.#pendingByOrg.get(organizationId) ?? 0;
    const active = this.#registry.countActive(organizationId) + pending;
    const limit = Math.max(
      0,
      this.#options.limits.getLimits(organizationId).maxConcurrentEngineSessions,
    );
    if (active >= limit) {
      // §3.2: a tenant may have at most N concurrent sessions (plan limit).
      throw sessionLimitReached(limit, active);
    }
    this.#pendingByOrg.set(organizationId, pending + 1);
    try {
      return await this.#spawnSession(spec);
    } finally {
      const left = (this.#pendingByOrg.get(organizationId) ?? 1) - 1;
      if (left > 0) this.#pendingByOrg.set(organizationId, left);
      else this.#pendingByOrg.delete(organizationId);
    }
  }

  /**
   * Tenant-scoped fetch. Cross-tenant probes get the same `session_not_found` as
   * unknown ids, so existence is never leaked across tenants (§15.1, §25 rule 4).
   */
  get(sessionId: string, organizationId: string): EngineSession {
    const session = this.#registry.findForTenant(sessionId, organizationId);
    if (!session) throw sessionNotFound();
    return session;
  }

  /** Bind a session to a document: `allocate → attach` (§3.2 lifecycle). */
  attach(sessionId: string, organizationId: string, documentId: string): EngineSession {
    const session = this.get(sessionId, organizationId);
    if (session.state === "draining" || session.state === "crashed") {
      throw engineUnavailable({
        message: "Engine session cannot be attached",
        hint: "The session is draining or crashed; allocate a new session and replay from the last checkpoint (§3.4).",
      });
    }
    if (session.documentId !== undefined && session.documentId !== documentId) {
      throw sessionNotFound({
        hint: "Session is bound to another document; allocate a new session.",
      });
    }
    const updated = this.#registry.update(sessionId, {
      documentId,
      state: "attached",
      lastActivityAt: this.#now(),
    });
    this.#emit({ type: "session_attached", sessionId, organizationId, documentId });
    return updated;
  }

  /** Record worker activity; resets the idle clock (§3.4 per-session idle timeout). */
  touch(sessionId: string, organizationId: string): EngineSession {
    this.get(sessionId, organizationId);
    return this.#registry.update(sessionId, { lastActivityAt: this.#now() });
  }

  /** Move a session to `idle` between runs; makes it the first eviction candidate. */
  markIdle(sessionId: string, organizationId: string): EngineSession {
    this.get(sessionId, organizationId);
    const updated = this.#registry.update(sessionId, {
      state: "idle",
      lastActivityAt: this.#now(),
    });
    this.#emit({ type: "session_idle", sessionId });
    return updated;
  }

  /** Graceful release: drain, stop the process, forget the session. */
  async release(sessionId: string, options?: { signal?: StopSignal }): Promise<void> {
    if (!this.#registry.get(sessionId)) throw sessionNotFound();
    // Draining first, then drop the bookkeeping, so the exit event is expected.
    this.#registry.update(sessionId, { state: "draining" });
    this.#registry.remove(sessionId);
    const process = this.#processes.get(sessionId);
    this.#processes.delete(sessionId);
    this.#emit({ type: "session_released", sessionId });
    if (process) {
      await this.#stopWithGrace(process, options?.signal ?? "SIGTERM");
    }
  }

  /**
   * One watchdog sweep (§3.2 idle timeout + crash restart):
   * 1. stop + recycle sessions idle past the timeout (§3.4 per-session idle 15 min);
   * 2. report sessions marked crashed by their exit hooks (worker replays, §3.4);
   * 3. mark sessions that ignore SIGTERM past the grace window as crashed.
   */
  async watchdogTick(): Promise<WatchdogReport> {
    const all = this.#registry.list();
    const crashed = all
      .filter((session) => session.state === "crashed")
      .map((session) => session.sessionId);
    const evictable = this.#registry.evictionCandidates({
      maxIdleMs: this.#idleTimeoutMs,
      now: this.#now(),
    });
    const evicted: string[] = [];
    const stopFailures: WatchdogStopFailure[] = [];
    await Promise.all(
      evictable.map(async (session) => {
        this.#registry.update(session.sessionId, { state: "draining" });
        const process = this.#processes.get(session.sessionId);
        try {
          if (process) await this.#stopWithGrace(process, "SIGTERM");
          this.#registry.remove(session.sessionId);
          this.#processes.delete(session.sessionId);
          this.#emit({ type: "session_evicted", sessionId: session.sessionId });
          evicted.push(session.sessionId);
        } catch (error) {
          // Still alive past SIGTERM: keep it visible as crashed so the worker can
          // replay from the checkpoint after Wave 2's SIGKILL escalation (§3.4).
          this.#registry.update(session.sessionId, { state: "crashed" });
          this.#emit({ type: "session_crashed", sessionId: session.sessionId });
          stopFailures.push({ sessionId: session.sessionId, envelope: toEnvelope(error) });
        }
      }),
    );
    return { inspected: all.length, evicted, crashed, stopFailures };
  }

  /** Shutdown: stop every session gracefully and disable the pool. */
  async drain(): Promise<void> {
    this.#drained = true;
    const sessions = this.#registry.list();
    await Promise.all(
      sessions.map(async (session) => {
        this.#registry.update(session.sessionId, { state: "draining" });
        this.#registry.remove(session.sessionId);
        const process = this.#processes.get(session.sessionId);
        this.#processes.delete(session.sessionId);
        try {
          if (process) await this.#stopWithGrace(process, "SIGTERM");
        } catch (error) {
          // Shutdown must proceed regardless; Wave 2 adds SIGKILL escalation.
          this.#logger.warn("engine-pool: stop failed during drain", {
            sessionId: session.sessionId,
            error: String(error),
          });
        }
      }),
    );
    this.#emit({ type: "pool_drained" });
  }

  /** Point-in-time counts for dashboards and tests (§22 observability). */
  snapshot(): PoolSnapshot {
    const byState: Record<EngineSessionState, number> = {
      allocated: 0,
      attached: 0,
      idle: 0,
      draining: 0,
      crashed: 0,
    };
    const byOrganization = new Map<string, number>();
    for (const session of this.#registry.list()) {
      byState[session.state] = (byState[session.state] ?? 0) + 1;
      byOrganization.set(
        session.organizationId,
        (byOrganization.get(session.organizationId) ?? 0) + 1,
      );
    }
    return {
      total: this.#registry.size(),
      byState,
      byOrganization: Object.fromEntries(byOrganization),
    };
  }

  async #spawnSession(spec: SessionSpec): Promise<EngineSession> {
    const sessionId = this.#options.newSessionId?.() ?? randomUUID();
    // §3.2: unique random token, regenerated per process — 256-bit, 64 hex chars.
    const token = this.#options.newToken?.() ?? randomBytes(TOKEN_BYTES).toString("hex");
    const request = {
      sessionId,
      organizationId: spec.organizationId,
      documentId: spec.documentId,
      token,
      readRoot: spec.readRoot,
      writeRoot: spec.writeRoot,
      port: this.#options.allocatePort?.(),
      env: this.#options.env,
    };
    let process: EngineProcess;
    try {
      process = this.#options.spawner.spawn(request);
    } catch (error) {
      throw isEnginePoolError(error) ? error : spawnFailed(error);
    }
    try {
      await process.start(request);
    } catch (error) {
      throw isEnginePoolError(error) ? error : spawnFailed(error);
    }
    process.onEvent("exit", () => this.#onUnexpectedExit(sessionId));
    process.onEvent("crash", () => this.#onUnexpectedExit(sessionId));
    const now = this.#now();
    const session: EngineSession = {
      sessionId,
      organizationId: spec.organizationId,
      documentId: spec.documentId,
      token,
      startedAt: now,
      lastActivityAt: now,
      state: "allocated",
    };
    this.#processes.set(sessionId, process);
    try {
      this.#registry.register(session);
    } catch (error) {
      this.#processes.delete(sessionId);
      await this.#bestEffortStop(process);
      throw error;
    }
    this.#emit({ type: "session_allocated", sessionId, organizationId: spec.organizationId });
    return { ...session };
  }

  /**
   * Unexpected process exit while we still track it and it was not draining:
   * mark crashed so the worker can replay the command log from the last
   * checkpoint (§3.2, §3.4). Expected exits are invisible: the bookkeeping is
   * removed before the stop signal is sent.
   */
  #onUnexpectedExit(sessionId: string): void {
    if (!this.#processes.has(sessionId)) return;
    const session = this.#registry.get(sessionId);
    if (!session || session.state === "draining" || session.state === "crashed") return;
    this.#registry.update(sessionId, { state: "crashed" });
    this.#emit({ type: "session_crashed", sessionId });
  }

  /** Graceful stop bounded by a timeout; rejects with watchdog_timeout past the grace. */
  async #stopWithGrace(process: EngineProcess, signal: StopSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#drainGraceMs);
    });
    try {
      const outcome = await Promise.race([
        process.stop(signal).then(() => "stopped" as const),
        grace,
      ]);
      if (outcome === "timeout") throw watchdogTimeout(this.#drainGraceMs);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #bestEffortStop(process: EngineProcess): Promise<void> {
    try {
      await this.#stopWithGrace(process, "SIGTERM");
    } catch (error) {
      // Registration failed; we only tried to avoid leaking a live process.
      this.#logger.warn("engine-pool: best-effort stop failed", { error: String(error) });
    }
  }

  #now(): number {
    return this.#options.clock?.() ?? Date.now();
  }

  #emit(event: PoolEvent): void {
    const observer = this.#options.onSessionEvent;
    if (observer === undefined) return;
    try {
      observer(event);
    } catch (error) {
      // §22: an observer must never be able to break the pool.
      this.#logger.warn("engine-pool: session-event observer failed", {
        type: event.type,
        error: String(error),
      });
    }
  }
}
