import { DbError } from "./errors-lite.js";
import type { RenderStatus, RunStatus } from "./schema.js";

/**
 * Status state machines for agent runs and renders (§7.4, §8.9).
 * Transitions are enforced in the repository layer; every violation is a
 * typed CONFLICT (never a silent overwrite).
 */

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["awaiting_approval", "completed", "failed", "cancelled"],
  awaiting_approval: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const RENDER_TRANSITIONS: Record<RenderStatus, readonly RenderStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (from === to) return;
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw DbError.conflict(`Illegal run transition: ${from} → ${to}`);
  }
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function assertRenderTransition(from: RenderStatus, to: RenderStatus): void {
  if (from === to) return;
  if (!RENDER_TRANSITIONS[from].includes(to)) {
    throw DbError.conflict(`Illegal render transition: ${from} → ${to}`);
  }
}

export function isTerminalRenderStatus(status: RenderStatus): boolean {
  return RENDER_TRANSITIONS[status].length === 0;
}
