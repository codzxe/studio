/**
 * Internal helpers shared by the load sequence and the autosave controller.
 */

import {
  type EditorBridge,
  type ProjectSummary,
  ProjectSummarySchema,
  messageOf,
} from "@studio/editor-bridge";

import { EditorSessionError } from "./types";

export { messageOf };

/** `project.summary` is the one raw editor result both flows consume — parse it with the bridge package's schema. */
export async function readProjectSummary(bridge: EditorBridge): Promise<ProjectSummary> {
  const raw = await bridge.query("project.summary");
  try {
    return ProjectSummarySchema.parse(raw);
  } catch (err) {
    throw new EditorSessionError(
      "summary-invalid",
      `project.summary returned an unexpected shape (${messageOf(err)})`,
      { cause: err },
    );
  }
}

/**
 * Reject if `promise` does not settle within `ms`. Uses the global timer
 * functions, so `vi.useFakeTimers()` makes the seam deterministic in tests.
 */
export function withTimeout<T>(label: string, ms: number, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EditorSessionError("timeout", `${label}: timed out after ${ms} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run `fn` over `items` with at most `limit` in flight. `fn` never rejects
 * (callers collect failures); completion order is free.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < width; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          const item = items[index];
          if (item === undefined) return;
          await fn(item, index);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

/** Filesystem-safe stem for the project snapshot (slug-like input, `.ecproj` appended by the caller). */
export function safeFileStem(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "project";
}

/** Human labels for the version history (D-6 save reasons); ≤ 280 chars per VERSION_LABEL_SCHEMA. */
export const SAVE_REASON_LABELS: Readonly<Record<string, string>> = {
  manual: "Manual save",
  autosave: "Autosave",
  "agent-apply": "Agent apply",
  "before-close": "Save before close",
  "device-lost": "Save after graphics device loss",
};

export function labelForSaveReason(reason: string): string | undefined {
  const known = SAVE_REASON_LABELS[reason];
  if (known !== undefined) return known;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 280) : undefined;
}

/** Page hooks must not break the version chain — hook throws are swallowed. */
export function safeNotify<A0>(hook: ((arg0: A0) => void) | undefined, arg0: A0): void {
  if (hook === undefined) return;
  try {
    hook(arg0);
  } catch {
    // a buggy page hook never corrupts engine state
  }
}

/** Upstream rejects unregistered commands with "unknown command `x`" (api.rs). */
export function isUnknownCommandError(err: unknown): boolean {
  return /unknown command/.test(messageOf(err));
}
