/**
 * tree.ts tests (M7-F) — the flat M7-A wire → visual threads: wire order for
 * roots, reading order for replies, the 3-level visual cap, orphan/cycle
 * promotion and duplicate-id dedupe. Pure functions, no DOM, no network.
 */

import type { Comment } from "@studio/contracts";
import { describe, expect, it } from "vitest";
import { buildCommentThreads } from "./tree";

function row(id: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    projectId: "prj_demo",
    compId: "1",
    layerId: null,
    timeTicks: null,
    parentCommentId: null,
    body: `body ${id}`,
    authorId: "usr_demo",
    guestName: null,
    guestEmail: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildCommentThreads", () => {
  it("keeps ROOTS in wire order (newest first) and replies in reading order", () => {
    // Wire is createdAt DESC: a root newest, then another thread's newest
    // reply, its oldest reply, then that thread's older root.
    const rows = [
      row("c3", { createdAt: "2026-10-22T00:00:00.000Z" }),
      row("c1r2", {
        parentCommentId: "c1",
        createdAt: "2026-10-21T00:00:00.000Z",
      }),
      row("c1r1", {
        parentCommentId: "c1",
        createdAt: "2026-10-20T12:00:00.000Z",
      }),
      row("c1", { createdAt: "2026-10-20T00:00:00.000Z" }),
    ];
    const threads = buildCommentThreads(rows);
    expect(threads.map((thread) => thread.root.comment.id)).toEqual(["c3", "c1"]);
    expect(threads[1]?.rows.map((entry) => entry.comment.id)).toEqual(["c1", "c1r1", "c1r2"]);
    expect(threads[1]?.rows.map((entry) => entry.depth)).toEqual([1, 2, 2]);
  });

  it("caps visual nesting at three levels (deeper hostile/legacy rows clamp)", () => {
    const rows = [
      row("d4", { parentCommentId: "c3", createdAt: "2026-10-24T00:00:00.000Z" }),
      row("c3", { parentCommentId: "b2", createdAt: "2026-10-23T00:00:00.000Z" }),
      row("b2", { parentCommentId: "a1", createdAt: "2026-10-22T00:00:00.000Z" }),
      row("a1", { createdAt: "2026-10-21T00:00:00.000Z" }),
    ];
    const threads = buildCommentThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.rows.map((entry) => entry.comment.id)).toEqual(["a1", "b2", "c3", "d4"]);
    expect(threads[0]?.rows.map((entry) => entry.depth)).toEqual([1, 2, 3, 3]);
  });

  it("promotes orphan replies (parent outside the filter window) with their descendants", () => {
    // Root `gone` is resolved and filtered out server-side; its replies must
    // not vanish — the older one becomes a promoted top-level row.
    const rows = [
      row("r2", { parentCommentId: "r1", createdAt: "2026-10-22T00:00:00.000Z" }),
      row("r1", { parentCommentId: "gone", createdAt: "2026-10-21T00:00:00.000Z" }),
    ];
    const threads = buildCommentThreads(rows);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.comment.id).toBe("r1");
    expect(threads[0]?.root.promoted).toBe(true);
    expect(threads[0]?.rows.map((entry) => entry.comment.id)).toEqual(["r1", "r2"]);
    expect(threads[0]?.rows[1]?.depth).toBe(2);
  });

  it("cuts parent cycles into promoted top-level rows (never loops)", () => {
    const rows = [
      row("x", { parentCommentId: "y", createdAt: "2026-10-22T00:00:00.000Z" }),
      row("y", { parentCommentId: "x", createdAt: "2026-10-21T00:00:00.000Z" }),
    ];
    const threads = buildCommentThreads(rows);
    expect(threads.map((thread) => thread.root.comment.id).sort()).toEqual(["x", "y"]);
    expect(threads).toHaveLength(2);
    expect(threads.every((thread) => thread.rows.length > 0)).toBe(true);
    for (const thread of threads) {
      expect(thread.root.depth).toBe(1);
      expect(thread.root.promoted).toBe(true);
    }
  });

  it("dedupes repeated ids (first occurrence wins)", () => {
    const rows = [
      row("dup", { body: "first" }),
      row("dup", { body: "second" }),
      row("other", { createdAt: "2026-10-19T00:00:00.000Z" }),
    ];
    const threads = buildCommentThreads(rows);
    const bodies = threads.flatMap((thread) => thread.rows.map((entry) => entry.comment.body));
    expect(bodies).toEqual(["first", "body other"]);
  });

  it("accumulates across pagination windows: a root may arrive before its replies", () => {
    const pageOne = buildCommentThreads([row("root", { createdAt: "2026-10-20T00:00:00.000Z" })]);
    expect(pageOne).toHaveLength(1);
    const pageTwo = buildCommentThreads([
      row("root", { createdAt: "2026-10-20T00:00:00.000Z" }),
      row("late-reply", {
        parentCommentId: "root",
        createdAt: "2026-10-19T00:00:00.000Z",
      }),
    ]);
    expect(pageTwo).toHaveLength(1);
    expect(pageTwo[0]?.rows.map((entry) => entry.comment.id)).toEqual(["root", "late-reply"]);
  });

  it("treats an empty window as no threads", () => {
    expect(buildCommentThreads([])).toEqual([]);
  });
});
