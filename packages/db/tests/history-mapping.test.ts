import { describe, expect, it } from "vitest";

import { historyCostOf, toHistoryEntry } from "../src/repos/threads.js";

/**
 * Pure unit tests for the round-12 history mapping (loadThreadHistory's
 * per-row projection — toPlanState precedent). The DB-backed behaviour
 * (insertion, caps, ordering) lives in tests/sqlite/agent-loop.test.ts.
 */

describe("toHistoryEntry (pure)", () => {
  it("user rows: text comes from content.message (legacy chat.ts shape)", () => {
    const entry = toHistoryEntry({
      role: "user",
      contentJson: { message: "make it blue", context: { activeComp: "comp_main" } },
      runId: null,
    });
    expect(entry).toEqual({
      role: "user",
      text: "make it blue",
      contentJson: { message: "make it blue", context: { activeComp: "comp_main" } },
      runId: null,
    });
  });

  it("assistant rows: legacy {text} and round-12 {message, status} both map", () => {
    const legacy = toHistoryEntry({
      role: "assistant",
      contentJson: { text: "done" },
      runId: "run_1",
    });
    expect(legacy).toEqual({
      role: "assistant",
      text: "done",
      contentJson: { text: "done" },
      runId: "run_1",
    });
    const round12 = toHistoryEntry({
      role: "assistant",
      contentJson: { message: "halfway", status: "partial" },
      runId: "run_1",
    });
    expect(round12?.text).toBe("halfway");
    expect(round12?.contentJson).toEqual({ message: "halfway", status: "partial" });
  });

  it("tool rows ride verbatim in content_json with no extracted text", () => {
    const payload = {
      kind: "tool",
      toolCallId: "call_9",
      tool: "studio.get_context",
      payload: { ok: true },
    };
    const entry = toHistoryEntry({ role: "tool", contentJson: payload, runId: "run_1" });
    expect(entry).toEqual({ role: "tool", contentJson: payload, runId: "run_1" });
  });

  it("system rows are dropped (null) — never a fake role in the model history", () => {
    expect(
      toHistoryEntry({ role: "system", contentJson: { text: "prompt" }, runId: null }),
    ).toBeNull();
  });

  it("defensive: string content_json reads as the text; junk stays undefined", () => {
    expect(toHistoryEntry({ role: "user", contentJson: "raw string row", runId: null })?.text).toBe(
      "raw string row",
    );
    expect(toHistoryEntry({ role: "user", contentJson: 42, runId: null })?.text).toBeUndefined();
    expect(
      toHistoryEntry({ role: "assistant", contentJson: { noTextHere: true }, runId: null })?.text,
    ).toBeUndefined();
  });
});

describe("historyCostOf (pure — the loadThreadHistory budget)", () => {
  it("cost is JSON.stringify(content_json).length", () => {
    const entry = toHistoryEntry({
      role: "user",
      contentJson: { message: "x".repeat(10) },
      runId: null,
    });
    if (entry === null) throw new Error("a user row must always map");
    // {"message":"xxxxxxxxxx"} → 12 + 10 = 22
    expect(historyCostOf(entry)).toBe(JSON.stringify({ message: "x".repeat(10) }).length);
  });

  it("the extracted text is a subset of the payload — never counted twice", () => {
    const entry = toHistoryEntry({ role: "user", contentJson: { message: "abc" }, runId: null });
    if (entry === null) throw new Error("a user row must always map");
    expect(historyCostOf(entry)).toBe(JSON.stringify({ message: "abc" }).length);
  });

  it("fallback: an entry without content_json counts its text length", () => {
    expect(historyCostOf({ role: "assistant", text: "hello" })).toBe(5);
    expect(historyCostOf({ role: "tool" })).toBe(0);
  });
});
