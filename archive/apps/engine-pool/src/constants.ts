// @studio/engine-pool — tuning constants. Defaults come from the spec, not instincts.

import type { EngineSessionState } from "./types.js";

/** Session token size in bytes: 256-bit, hex-encoded to 64 chars (§3.2, §15.1). */
export const TOKEN_BYTES = 32;

/** Per-session idle timeout: 15 minutes (§3.4 "Timeouts": per-session idle 15 min). */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Watchdog sweep cadence; every tick re-checks idle age and crash bookkeeping (§3.2). */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30 * 1000;

/** Grace window for a graceful stop before escalation (Wave 2: SIGKILL + restart). */
export const DEFAULT_DRAIN_GRACE_MS = 5 * 1000;

/**
 * States that hold a real, usable engine process. `draining` and `crashed` sessions
 * never count towards per-organization concurrency caps: draining ones are on their
 * way out, and a crashed session must not block the tenant's recovery allocation (§3.4).
 */
export const ACTIVE_SESSION_STATES: readonly EngineSessionState[] = [
  "allocated",
  "attached",
  "idle",
];
