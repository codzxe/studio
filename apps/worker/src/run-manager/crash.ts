// apps/worker/src/run-manager/crash.ts — §3.4 crash signalling (W6-N).
//
// The engine session adapters (engine-session.ts) latch crash-class failures
// on the handle; the processor converts them into this typed error at stage
// boundaries so process() can hand the run to the recovery hook (deps.recovery)
// — "restart, replay to checkpoint, resume once" (§3.4). Never carries stack
// traces or raw provider text (§13.3).

import type { EngineCrashEvidence } from "./deps.js";

/** Thrown when the run's engine session is known-dead mid-pipeline. */
export class EngineSessionCrashError extends Error {
  readonly evidence: EngineCrashEvidence;
  readonly sessionId: string;

  constructor(sessionId: string, evidence: EngineCrashEvidence) {
    super(`engine session crashed (${evidence.code})`);
    this.name = "EngineSessionCrashError";
    this.sessionId = sessionId;
    this.evidence = evidence;
  }
}
