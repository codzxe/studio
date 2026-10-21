// apps/worker/src/run-manager/emit.ts — §13.2/§22 durable emission helpers (W6-N).
//
// The executor's step-event seam REJECTS on a failed publish ("the timeline
// must never silently drop steps", W6-B contract), and the run manager's stage
// emissions follow the same rule: §22 durability over latency. Only the
// TERMINAL event (run.failed / run.cancelled) is best-effort — a broken store
// must not recurse the failure path.

import type { PublishResult, RunEventType, RunEventPayloadMap } from "@studio/agent";
import type { EmitRunEvent } from "./deps.js";

/** A durable append failed — the run must fail (§22), not lose timeline rows. */
export class EmissionError extends Error {
  constructor(code: string, message: string) {
    super(`run-event publish failed (${code}): ${message}`);
    this.name = "EmissionError";
  }
}

/**
 * Publishes one typed run event and ENFORCES the durable ack: a failure throws
 * `EmissionError` (mapped by the processor to an internal failure — our
 * infrastructure, §14.2 rule 5 full-refund posture).
 */
export async function emitRunEventOk<T extends RunEventType>(
  emit: EmitRunEvent,
  input: {
    readonly runId: string;
    readonly organizationId: string;
    readonly type: T;
    readonly payload: RunEventPayloadMap[T];
  },
): Promise<PublishResult<T>> {
  const result = await emit(input.runId, input.type, input.payload, {
    organizationId: input.organizationId,
  });
  if (!result.ok) {
    throw new EmissionError(result.code, result.message);
  }
  return result;
}

/** Terminal-event publish that can never take the caller down with it. */
export async function emitTerminalBestEffort<T extends RunEventType>(
  emit: EmitRunEvent,
  input: {
    readonly runId: string;
    readonly organizationId: string;
    readonly type: T;
    readonly payload: RunEventPayloadMap[T];
    readonly onError: (message: string) => void;
  },
): Promise<void> {
  try {
    const result = await emit(input.runId, input.type, input.payload, {
      organizationId: input.organizationId,
    });
    if (!result.ok) {
      input.onError(`terminal event publish failed (${result.code}): ${result.message}`);
    }
  } catch (error) {
    input.onError(`terminal event publish threw: ${error instanceof Error ? error.message : "unknown"}`);
  }
}
