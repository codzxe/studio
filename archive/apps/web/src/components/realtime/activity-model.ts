// apps/web/src/components/realtime — activity feed data model (W8-R).
//
// Spec anchors: §19 Phase 3 ("workspace activity feed"), §16.2 ("SSE first"),
// §13.2 (run events wire `{ seq, run_id, at, type, payload }`), §25 rule 3
// (feed is NOTIFICATIONS ONLY — it never carries document state).
//
// Two documented sources feed the workspace feed (see activity-feed.tsx and
// the folder README):
//
//   1. Run events (§13.1 `GET /v1/runs/:id/events`, §13.2): terminal events
//      `run.succeeded` / `run.failed` / `run.cancelled` map to feed rows via
//      `runEventToActivity`. The SSE stream already exists (src/lib/api.ts
//      `RunEventStream`, W1-K) — wiring it into the feed is the SSE TODO in
//      activity-feed.tsx.
//
//   2. Audit tail — TODO(gateway): §13.1 has no audit-read route today (the
//      gateway WRITES audit entries, apps/gateway/src/services/audit.ts, but
//      exposes no read). Expected contract, mirrored in zod below (the
//      gateway route must mirror these schemas + add §13.1/OpenAPI rows):
//
//        GET /v1/workspaces/:id/audit?limit=50
//          → { ok: true, entries: AuditEntryDto[] }
//
//        AuditEntryDto = { id, at, action, actor_name?, target_type?,
//                          target_id?, summary? }
//
//      v1 action vocabulary (auditEntryToActivity maps exactly these and
//      ignores the rest — graceful against a drifting action list):
//        `member.joined`  → "X joined the workspace"
//        `export.ready`   → "An export is ready"
//
// Pure, framework-free, and test-friendly: no React, no network, no clocks
// beyond the injected `now` anchor. `import type` keeps the §13.2 mirror in
// src/lib/api.ts the single source for RunEvent.

import { z } from "zod";
import type { RunEvent } from "@/lib/api";

// ---------------------------------------------------------------------------
// Feed item
// ---------------------------------------------------------------------------

export type ActivityKind =
  | "run_finished"
  | "run_failed"
  | "run_cancelled"
  | "export_ready"
  | "member_joined";

export interface ActivityItem {
  /** Stable dedupe key (`run:<id>:<seq>` / `audit:<id>`). */
  readonly id: string;
  readonly at: Date;
  readonly kind: ActivityKind;
  /** Human sentence (already user-safe — no ids leaked into copy). */
  readonly title: string;
  readonly detail: string | null;
  /** App-relative link when the row can navigate somewhere (e.g. /runs/:id). */
  readonly href: string | null;
}

// ---------------------------------------------------------------------------
// Run events (§13.2) → feed rows
// ---------------------------------------------------------------------------

/**
 * Map one §13.2 run event to a feed row. Terminal events only —
 * `run.queued`/`step.*`/`preview.updated` are progress, not activity
 * (§19: the feed lists "runs finished, exports ready, members joined").
 */
export function runEventToActivity(event: RunEvent): ActivityItem | null {
  switch (event.type) {
    case "run.succeeded":
      return runRow(event, "run_finished", "Run finished");
    case "run.failed":
      return runRow(event, "run_failed", "Run failed");
    case "run.cancelled":
      return runRow(event, "run_cancelled", "Run cancelled");
    default:
      return null;
  }
}

function runRow(event: RunEvent, kind: ActivityKind, title: string): ActivityItem {
  return {
    id: `run:${event.run_id}:${event.seq}`,
    at: event.at,
    kind,
    title,
    // The §13.2 payload shape per terminal type is not pinned client-side;
    // rows link to the run instead of quoting internals.
    detail: null,
    href: `/runs/${event.run_id}`,
  };
}

// ---------------------------------------------------------------------------
// Audit tail (TODO(gateway) — schemas are the pin for the future route)
// ---------------------------------------------------------------------------

const isoDateTime = z.string().datetime({ offset: true });

/** One audit-log row on the wire (expected contract, file header). */
export const auditEntrySchema = z.object({
  id: z.string().min(1),
  at: isoDateTime,
  action: z.string().min(1),
  actor_name: z.string().min(1).max(120).optional(),
  target_type: z.string().min(1).optional(),
  target_id: z.string().min(1).optional(),
  summary: z.string().min(1).max(500).optional(),
});

export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

/** `GET /v1/workspaces/:id/audit` success body. */
export const auditTailResponseSchema = z.object({
  ok: z.literal(true),
  entries: z.array(auditEntrySchema),
});

/**
 * Map one audit entry to a feed row. Unmapped actions → null (skipped, not
 * fatal — the gateway may log many actions the feed never shows). A
 * server-authored `summary` wins over derived copy.
 */
export function auditEntryToActivity(entry: AuditEntryDto): ActivityItem | null {
  switch (entry.action) {
    case "member.joined":
      return {
        id: `audit:${entry.id}`,
        at: new Date(entry.at),
        kind: "member_joined",
        title: entry.summary ?? `${entry.actor_name ?? "A member"} joined the workspace`,
        detail: null,
        href: null,
      };
    case "export.ready":
      return {
        id: `audit:${entry.id}`,
        at: new Date(entry.at),
        kind: "export_ready",
        title: entry.summary ?? "An export is ready",
        detail: null,
        href: null,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Merge + format (pure)
// ---------------------------------------------------------------------------

/**
 * Merge feed sources (run rows + audit rows): dedupe by id (first wins),
 * newest first (tie-break by id so the order is deterministic), capped.
 */
export function mergeActivity(
  sources: readonly (readonly ActivityItem[])[],
  cap = 50,
): readonly ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  for (const source of sources) {
    for (const item of source) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
  }
  return [...byId.values()].sort(byNewestThenId).slice(0, Math.max(cap, 0));
}

function byNewestThenId(a: ActivityItem, b: ActivityItem): number {
  const byTime = b.at.getTime() - a.at.getTime();
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : 1;
}

/**
 * Coarse relative time for feed rows ("just now" / "5m ago" / "3h ago" /
 * "2d ago"). Clock-skew-safe: future timestamps read "just now". Fixed bands
 * (not "1h 5m ago") keep rows narrow and the table tests honest.
 */
export function formatRelativeActivityTime(at: Date, now: Date): string {
  const elapsedMs = now.getTime() - at.getTime();
  if (elapsedMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
