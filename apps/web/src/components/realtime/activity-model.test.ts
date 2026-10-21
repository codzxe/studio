/**
 * Pure-logic tests for the activity-feed model (W8-R): §13.2 run-event
 * mapping, the expected audit-tail wire schema (TODO(gateway) pin),
 * merge/dedupe/order/cap, and the coarse relative-time bands. Deterministic,
 * node env, no network, no clocks (the `now` anchor is injected). Tables are
 * typed tuple arrays + loops (strict-TS bulletproof).
 */
import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventType } from "../../lib/api";
import {
  auditEntrySchema,
  auditEntryToActivity,
  auditTailResponseSchema,
  formatRelativeActivityTime,
  mergeActivity,
  runEventToActivity,
  type ActivityItem,
  type AuditEntryDto,
} from "./activity-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN = (
  type: RunEventType,
  seq = 1,
  runId = "r-1",
  at = "2026-07-01T12:00:00Z",
): RunEvent => ({
  seq,
  run_id: runId,
  at: new Date(at),
  type,
  payload: {},
});

const A = (id: string, minutesAgo: number): ActivityItem => ({
  id,
  at: new Date(`2026-07-01T12:${String(59 - minutesAgo).padStart(2, "0")}:00Z`),
  kind: "run_finished",
  title: `Row ${id}`,
  detail: null,
  href: null,
});

// ---------------------------------------------------------------------------
// runEventToActivity (§13.2 terminal events)
// ---------------------------------------------------------------------------

describe("runEventToActivity", () => {
  const terminal: readonly (readonly [RunEventType, ActivityItem["kind"], string])[] = [
    ["run.succeeded", "run_finished", "Run finished"],
    ["run.failed", "run_failed", "Run failed"],
    ["run.cancelled", "run_cancelled", "Run cancelled"],
  ];
  for (const [type, kind, title] of terminal) {
    it(`maps ${type} → ${kind}`, () => {
      const item = runEventToActivity(RUN(type, 7, "r-9"));
      expect(item).not.toBeNull();
      expect(item).toMatchObject({ id: "run:r-9:7", kind, title, href: "/runs/r-9", detail: null });
    });
  }

  const progress: readonly RunEventType[] = [
    "run.queued",
    "run.started",
    "run.plan",
    "step.started",
    "step.finished",
    "preview.updated",
    "validate.report",
    "critique.report",
    "credits.reserved",
    "credits.charged",
  ];
  for (const type of progress) {
    it(`ignores non-terminal progress events (${type}) — activity, not progress`, () => {
      expect(runEventToActivity(RUN(type))).toBeNull();
    });
  }

  it("keeps the event instant for ordering", () => {
    const item = runEventToActivity(RUN("run.succeeded", 2, "r-2", "2026-07-01T10:30:00Z"));
    expect(item?.at.toISOString()).toBe("2026-07-01T10:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Audit tail (expected contract — the gateway pin)
// ---------------------------------------------------------------------------

describe("auditEntrySchema / auditTailResponseSchema (gateway pin)", () => {
  it("accepts the documented DTO", () => {
    const entry = auditEntrySchema.safeParse({
      id: "au-1",
      at: "2026-07-01T12:00:00Z",
      action: "member.joined",
      actor_name: "Ada",
    });
    expect(entry.success).toBe(true);
  });

  it("accepts offset timestamps (§13 style ISO-8601 with ±hh:mm)", () => {
    const entry = auditEntrySchema.safeParse({
      id: "au-2",
      at: "2026-07-01T12:00:00+02:00",
      action: "export.ready",
    });
    expect(entry.success).toBe(true);
  });

  const rejects: readonly (readonly [string, unknown])[] = [
    ["missing id", { at: "2026-07-01T12:00:00Z", action: "member.joined" }],
    ["missing action", { id: "au", at: "2026-07-01T12:00:00Z" }],
    ["bad datetime", { id: "au", at: "yesterday", action: "member.joined" }],
  ];
  for (const [label, body] of rejects) {
    it(`rejects ${label}`, () => {
      expect(auditEntrySchema.safeParse(body).success).toBe(false);
    });
  }

  it("shapes the list response", () => {
    const ok = auditTailResponseSchema.safeParse({
      ok: true,
      entries: [{ id: "au", at: "2026-07-01T12:00:00Z", action: "export.ready" }],
    });
    expect(ok.success).toBe(true);
    const bad = auditTailResponseSchema.safeParse({ entries: [] });
    expect(bad.success).toBe(false);
  });
});

describe("auditEntryToActivity", () => {
  it("maps member.joined with derived copy and summary override", () => {
    expect(
      auditEntryToActivity({
        id: "au-1",
        at: "2026-07-01T12:00:00Z",
        action: "member.joined",
        actor_name: "Ada",
      }),
    ).toMatchObject({ id: "audit:au-1", kind: "member_joined", title: "Ada joined the workspace" });

    expect(
      auditEntryToActivity({
        id: "au-2",
        at: "2026-07-01T12:00:00Z",
        action: "member.joined",
        summary: "Ada accepted the invite",
      }),
    ).toMatchObject({ title: "Ada accepted the invite" });
  });

  it("maps export.ready with member-neutral copy", () => {
    expect(
      auditEntryToActivity({ id: "au-3", at: "2026-07-01T12:00:00Z", action: "export.ready" }),
    ).toMatchObject({ kind: "export_ready", title: "An export is ready" });
  });

  it("skips unmapped actions (graceful against a drifting vocabulary)", () => {
    const skipped: AuditEntryDto = {
      id: "au-4",
      at: "2026-07-01T12:00:00Z",
      action: "document.updated",
    };
    expect(auditEntryToActivity(skipped)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeActivity
// ---------------------------------------------------------------------------

describe("mergeActivity", () => {
  it("merges newest-first across sources", () => {
    const merged = mergeActivity([
      [A("a", 0)],
      [A("b", 1)],
      [A("c", 2)],
    ]);
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("dedupes by id (first source wins)", () => {
    const first = A("x", 5);
    const dupe = { ...A("x", 0), title: "Later copy" };
    const merged = mergeActivity([[first], [dupe]]);
    expect(merged.length).toBe(1);
    expect(merged[0]?.title).toBe("Row x");
  });

  it("breaks time ties by id ascending (deterministic order)", () => {
    const merged = mergeActivity([
      [A("y", 1)],
      [A("x", 1)],
    ]);
    expect(merged.map((item) => item.id)).toEqual(["x", "y"]);
  });

  it("caps the result and tolerates cap 0", () => {
    expect(
      mergeActivity(
        [
          [A("a", 0)],
          [A("b", 1)],
          [A("c", 2)],
        ],
        2,
      ).length,
    ).toBe(2);
    expect(mergeActivity([[A("a", 0)]], 0)).toEqual([]);
  });

  it("handles empty sources", () => {
    expect(mergeActivity([])).toEqual([]);
    expect(mergeActivity([[], []])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatRelativeActivityTime
// ---------------------------------------------------------------------------

describe("formatRelativeActivityTime", () => {
  const NOW = new Date("2026-07-01T12:00:00Z");

  const bands: readonly (readonly [number, string])[] = [
    [30_000, "just now"],
    [59_999, "just now"],
    [60_000, "1m ago"],
    [5 * 60_000, "5m ago"],
    [59 * 60_000, "59m ago"],
    [60 * 60_000, "1h ago"],
    [3 * 3_600_000, "3h ago"],
    [23 * 3_600_000, "23h ago"],
    [24 * 3_600_000, "1d ago"],
    [2 * 86_400_000, "2d ago"],
  ];
  for (const [elapsedMs, expected] of bands) {
    it(`${elapsedMs}ms ago → ${expected}`, () => {
      expect(formatRelativeActivityTime(new Date(NOW.getTime() - elapsedMs), NOW)).toBe(expected);
    });
  }

  it("clock-skew-safe: future timestamps read 'just now'", () => {
    expect(formatRelativeActivityTime(new Date(NOW.getTime() + 120_000), NOW)).toBe("just now");
  });
});
