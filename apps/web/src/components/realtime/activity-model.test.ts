/**
 * Pure-logic tests for the activity-feed model (W8-R): §13.2 run-event
 * mapping, the expected audit-tail wire schema (TODO(gateway) pin),
 * merge/dedupe/order/cap, and the coarse relative-time bands. Deterministic,
 * node env, no network, no clocks (the `now` anchor is injected).
 */
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../lib/api";
import {
  auditEntrySchema,
  auditEntryToActivity,
  auditTailResponseSchema,
  formatRelativeActivityTime,
  mergeActivity,
  runEventToActivity,
  type ActivityItem,
} from "./activity-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN = (type: RunEvent["type"], seq = 1, runId = "r-1", at = "2026-07-01T12:00:00Z"): RunEvent => ({
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
  it.each([
    ["run.succeeded", "run_finished", "Run finished"],
    ["run.failed", "run_failed", "Run failed"],
    ["run.cancelled", "run_cancelled", "Run cancelled"],
  ])("maps %s → %s", (type, kind, title) => {
    const item = runEventToActivity(RUN(type, 7, "r-9"));
    expect(item).not.toBeNull();
    expect(item).toMatchObject({ id: "run:r-9:7", kind, title, href: "/runs/r-9", detail: null });
  });

  it.each([
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
  ])("ignores non-terminal progress events (%s) — the feed is activity, not progress", (type) => {
    expect(runEventToActivity(RUN(type))).toBeNull();
  });

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

  it.each([
    ["missing id", { at: "2026-07-01T12:00:00Z", action: "member.joined" }],
    ["missing action", { id: "au", at: "2026-07-01T12:00:00Z" }],
    ["bad datetime", { id: "au", at: "yesterday", action: "member.joined" }],
  ])("rejects %s", (_label, body) => {
    expect(auditEntrySchema.safeParse(body).success).toBe(false);
  });

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
  it("maps member.joined with derived copy, summary override", () => {
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

  it("maps export.ready and falls back to a member-neutral copy", () => {
    expect(
      auditEntryToActivity({ id: "au-3", at: "2026-07-01T12:00:00Z", action: "export.ready" }),
    ).toMatchObject({ kind: "export_ready", title: "An export is ready" });
  });

  it("skips unmapped actions (graceful against a drifting vocabulary)", () => {
    expect(
      auditEntryToActivity({ id: "au-4", at: "2026-07-01T12:00:00Z", action: "document.updated" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeActivity
// ---------------------------------------------------------------------------

describe("mergeActivity", () => {
  it("merges newest-first across sources", () => {
    const merged = mergeActivity([
      [A("a", 0)], // 12:59 → newest
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
    expect(mergeActivity([[A("a", 0)], [A("b", 1)], [A("c", 2)]], 2).length).toBe(2);
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

  it.each([
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
  ])("%sms ago → %s", (elapsedMs, expected) => {
    expect(formatRelativeActivityTime(new Date(NOW.getTime() - elapsedMs), NOW)).toBe(expected);
  });

  it("clock-skew-safe: future timestamps read 'just now'", () => {
    expect(formatRelativeActivityTime(new Date(NOW.getTime() + 120_000), NOW)).toBe("just now");
  });
});
