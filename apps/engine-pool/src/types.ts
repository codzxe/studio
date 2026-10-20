// @studio/engine-pool — seam types for the supervisor (§3.2 engine session model).
// ALL process interaction lives behind these injectable interfaces so the pool logic
// stays pure and unit-testable without spawning real engines. The real `Spawner`
// (photocraft-cli serve, §2.2) arrives in Wave 2 and implements the same seams.

import type { ErrorEnvelope } from "./errors.js";

/** Session lifecycle states (§3.2). */
export type EngineSessionState =
  /** Process started, not yet bound to a document. */
  | "allocated"
  /** Bound to a document, running commands. */
  | "attached"
  /** No active run; first candidate for idle eviction. */
  | "idle"
  /** Graceful shutdown in progress (release / eviction / drain). */
  | "draining"
  /** Unexpected exit; the worker must replay from the last checkpoint (§3.4). */
  | "crashed";

/** One supervised engine process, keyed by session id. */
export interface EngineSession {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId?: string;
  /**
   * Per-process 256-bit auth token (64 hex chars). Generated fresh for EVERY process,
   * never logged, never sent to the browser (§3.2, §15.1). Only gateway/worker see it.
   */
  readonly token: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds; idle age is measured from this (§3.4 per-session idle). */
  readonly lastActivityAt: number;
  readonly state: EngineSessionState;
}

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

/** Everything a fresh engine process needs to boot (§2.2: photocraft-cli serve). */
export interface SpawnRequest {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly documentId?: string;
  /** 256-bit token, hex — the process authenticates every connection with it. */
  readonly token: string;
  /** Capability read root, scoped to this workspace's directory (§3.2, §15.1). */
  readonly readRoot: string;
  /** Capability write root, scoped to this workspace's directory (§3.2, §15.1). */
  readonly writeRoot: string;
  /**
   * Loopback TCP port. When absent, the real spawner uses the stdio transport
   * (`serve` without `--port`), which inherits access from the process pipe.
   */
  readonly port?: number;
  readonly env?: Readonly<Record<string, string>>;
}

/** Process lifecycle events, delivered via `EngineProcess.onEvent`. */
export interface EngineEventMap {
  ready: { readonly kind: "ready"; readonly port?: number };
  log: { readonly kind: "log"; readonly line: string };
  exit: {
    readonly kind: "exit";
    readonly code: number | null;
    readonly signal: StopSignal | null;
  };
  crash: { readonly kind: "crash"; readonly reason: string };
}

export type EngineEventKind = keyof EngineEventMap;
export type EngineEventHandler<K extends EngineEventKind = EngineEventKind> = (
  event: EngineEventMap[K],
) => void;

/** A single supervised engine process; every method is behind this seam. */
export interface EngineProcess {
  /** Launch and resolve once the process accepts work. */
  start(request: SpawnRequest): Promise<void>;
  /** Ask the process to stop; implementations escalate signals if needed. */
  stop(signal?: StopSignal): Promise<void>;
  /** Subscribe to lifecycle events (ready / log / exit / crash). */
  onEvent<K extends EngineEventKind>(kind: K, handler: EngineEventHandler<K>): void;
  readonly pid?: number;
}

/** Factory for engine processes; `spawn` must never block or touch the network. */
export interface Spawner {
  spawn(request: SpawnRequest): EngineProcess;
}

/** What the caller wants brought up: one session, one tenant (§25 rule 4). */
export interface SessionSpec {
  readonly organizationId: string;
  readonly documentId?: string;
  readonly readRoot: string;
  readonly writeRoot: string;
}

export interface PlanLimits {
  readonly maxConcurrentEngineSessions: number;
}

/** Injected provider — the billing package owns the real plan data (§14). */
export interface PlanLimitsProvider {
  getLimits(organizationId: string): PlanLimits;
}

/** Observability hook (§22); observer errors never affect pool state. */
export type PoolEvent =
  | { readonly type: "session_allocated"; readonly sessionId: string; readonly organizationId: string }
  | { readonly type: "session_attached"; readonly sessionId: string; readonly organizationId: string; readonly documentId: string }
  | { readonly type: "session_idle"; readonly sessionId: string }
  | { readonly type: "session_evicted"; readonly sessionId: string }
  | { readonly type: "session_crashed"; readonly sessionId: string }
  | { readonly type: "session_released"; readonly sessionId: string }
  | { readonly type: "pool_drained" };

/** A session that could not be stopped within the grace window. */
export interface WatchdogStopFailure {
  readonly sessionId: string;
  readonly envelope: ErrorEnvelope;
}

/** Result of one `watchdogTick()` sweep. */
export interface WatchdogReport {
  readonly inspected: number;
  /** Idle-timeout sessions that were stopped and recycled (§3.2 lifecycle). */
  readonly evicted: readonly string[];
  /** Sessions currently marked crashed; the worker replays from checkpoint (§3.4). */
  readonly crashed: readonly string[];
  /** Sessions that ignored SIGTERM past the grace window (escalate in Wave 2). */
  readonly stopFailures: readonly WatchdogStopFailure[];
}

/** Point-in-time counts for dashboards and tests. */
export interface PoolSnapshot {
  readonly total: number;
  readonly byState: Readonly<Record<EngineSessionState, number>>;
  readonly byOrganization: Readonly<Record<string, number>>;
}
