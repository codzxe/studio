// Request-level caps middleware (§1.5 rule 5 "no abuse surface": upload caps,
// run caps). Two guards, both enforced BEFORE any expensive work:
//
//   uploadCap()      — Content-Length vs the 25 MB upload cap (§13/§20.2),
//                      rejected with 413 `upload_too_large` BEFORE the body is
//                      parsed or buffered. Header-only check: the deep MIME
//                      sniff and the 60 MP bomb check (§20.2) stay in the
//                      asset service where the bytes are already in hand.
//
//   enforceRunCaps() — per-workspace concurrent-run gate (§14.1 ladder 1/3/6
//                      from @studio/config PLAN_LIMITS) → 429
//                      `run_cap_reached` with an upgrade hint. The in-flight
//                      counter is INJECTED: the runs route supplies a DB count
//                      (or cache view); this module never touches storage.

import { createMiddleware, type MiddlewareHandler } from "hono";
import { MAX_UPLOAD_BYTES, planLimits, type PlanId } from "@studio/config";
import type { AppEnv } from "../types.js";
import { AppError } from "./error-mapper.js";

// --- Upload size cap (§20.2: 25 MB/image, checked pre-parse) ---

/** Verdict of the header-level size check. */
export interface UploadSizeVerdict {
  /** True when Content-Length exceeds the cap and the request must be rejected. */
  readonly tooLarge: boolean;
  /** Parsed Content-Length in bytes, or null when absent/malformed. */
  readonly contentLengthBytes: number | null;
}

/**
 * Pure decision: Content-Length header value vs cap.
 *
 * Missing or malformed headers pass through (`tooLarge: false`) — chunked
 * bodies cannot be pre-checked and malformed Content-Length is the HTTP
 * server's error, not ours; the downstream body parser enforces both. The
 * comparison is inclusive: a body exactly at the cap is allowed.
 */
export function checkUploadSize(
  headerValue: string | undefined,
  maxBytes: number,
): UploadSizeVerdict {
  if (headerValue === undefined || !/^\d+$/.test(headerValue)) {
    return { tooLarge: false, contentLengthBytes: null };
  }
  const contentLengthBytes = Number.parseInt(headerValue, 10);
  return { tooLarge: contentLengthBytes > maxBytes, contentLengthBytes };
}

/** Human-readable cap for error hints — "25 MB" when it divides evenly. */
function describeCap(maxBytes: number): string {
  const MB = 1024 * 1024;
  return maxBytes % MB === 0 ? `${maxBytes / MB} MB` : `${maxBytes} bytes`;
}

/** Options for `uploadCap()`. */
export interface UploadCapOptions {
  /**
   * Cap in bytes. Defaults to MAX_UPLOAD_BYTES (25 MB, §20.2) from
   * @studio/config; overridden only by plan-gated wiring if that ever lands.
   */
  readonly maxBytes?: number;
}

/**
 * Reject oversized request bodies before they are read (413 `upload_too_large`,
 * §13.3 envelope via the error-mapper). Mount on upload routes only — e.g.
 * POST /v1/uploads — after `errorMapper`; it needs no auth context, so it may
 * run before the auth middleware (cheapest rejection path, §1.5).
 */
export function uploadCap(options: UploadCapOptions = {}): MiddlewareHandler<AppEnv> {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`[uploadCap] maxBytes must be an integer >= 1 (got ${String(maxBytes)})`);
  }
  return createMiddleware<AppEnv>(async (c, next) => {
    const verdict = checkUploadSize(c.req.header("content-length"), maxBytes);
    if (verdict.tooLarge) {
      throw new AppError(413, "upload_too_large", "Upload exceeds the maximum allowed size.", {
        hint: `Images must be ${describeCap(maxBytes)} or smaller. Compress the file and retry.`,
        retryable: false,
      });
    }
    await next();
  });
}

// --- Concurrent-run cap (§14.1: 1/3/6 concurrent runs by plan) ---

/** What `enforceRunCaps` needs to know about the workspace's plan. */
export interface RunCapsContext {
  /** Current plan — selects the cap from @studio/config PLAN_LIMITS (§14.1). */
  readonly plan: PlanId;
}

/** Where the in-flight run count comes from. */
export interface RunCapsOptions {
  /**
   * In-flight (queued|running) runs for the workspace, from an injected
   * counter: either an already-fetched number or a resolver the runs route
   * wires to its DB count/cache view. The resolver may reject (e.g. DB down)
   * — that propagates as a 500, deliberately fail-closed: run admission is a
   * money surface (§14.2 reserve happens right after), unlike rate limiting.
   */
  readonly activeRuns: number | (() => number | Promise<number>);
}

/**
 * Enforce the workspace's concurrent-run cap (§1.5 rule 5, §14.1: starter 1,
 * pro 3, business 6). Throws a 429 `run_cap_reached` AppError at/over the cap
 * — the error-mapper renders it, so call it from the runs route BEFORE the
 * §14.2 credit reservation:
 *
 * ```ts
 * await enforceRunCaps(
 *   { plan: subscription.plan },
 *   { activeRuns: () => countActiveRuns(organizationId) },
 * );
 * ```
 *
 * Race note: check-then-act admits a small race between two simultaneous
 * creates. The authoritative guard belongs in the reservation transaction
 * (§14.2 rule 1: reserve → reject duplicates) — this is the fast, friendly
 * 429 that keeps users from burning requests, not the money-safety net.
 */
export async function enforceRunCaps(
  ctx: RunCapsContext,
  options: RunCapsOptions,
): Promise<void> {
  const cap = planLimits(ctx.plan).concurrentRuns; // 1/3/6 (§14.1)
  const raw =
    typeof options.activeRuns === "function"
      ? await options.activeRuns()
      : options.activeRuns;
  // A broken counter (negative/NaN) is an internal bug: clamp to 0 and let the
  // reservation transaction catch real over-admission (fail soft, log-free).
  const active = Number.isInteger(raw) && raw >= 0 ? raw : 0;

  if (active >= cap) {
    throw new AppError(
      429,
      "run_cap_reached",
      "Workspace is already running the maximum number of concurrent runs for its plan.",
      {
        hint: `Your plan allows ${cap} concurrent run${cap === 1 ? "" : "s"}. Wait for a run to finish or upgrade for more.`,
        retryable: true,
      },
    );
  }
}
