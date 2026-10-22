import { describe, expect, it } from "vitest";

import { toPlanState } from "../src/repos/runs.js";

/**
 * Pure unit tests for the M5 plan-lifecycle projection (§M5.4/§M5.5).
 * The DB-backed behaviour (apply/undo persistence, tenancy, FK integrity)
 * lives in tests/integration/apply-undo.test.ts.
 */

const COLUMNS = {
  appliedAt: null,
  appliedBatchSha256: null,
  appliedVersionId: null,
  baseVersionId: null,
  undoneAt: null,
} as const;

describe("toPlanState (pure)", () => {
  it("a fresh run (never applied) is proposed — all lifecycle fields null", () => {
    const state = toPlanState({ ...COLUMNS, baseVersionId: "ver_base" });
    expect(state).toEqual({
      status: "proposed",
      appliedAt: null,
      appliedBatchSha256: null,
      appliedVersionId: null,
      baseVersionId: "ver_base",
      undoneAt: null,
    });
  });

  it("appliedAt set (undoneAt null) is applied, carrying the version + batch digest", () => {
    const appliedAt = new Date("2026-10-23T12:00:00Z");
    const state = toPlanState({
      appliedAt,
      appliedBatchSha256: "a".repeat(64),
      appliedVersionId: "ver_result",
      baseVersionId: "ver_base",
      undoneAt: null,
    });
    expect(state.status).toBe("applied");
    expect(state.appliedAt).toBe(appliedAt);
    expect(state.appliedVersionId).toBe("ver_result");
    expect(state.undoneAt).toBeNull();
  });

  it("appliedAt + undoneAt set is undone — the version linkage survives (§9.3)", () => {
    const state = toPlanState({
      appliedAt: new Date("2026-10-23T12:00:00Z"),
      appliedBatchSha256: "b".repeat(64),
      appliedVersionId: "ver_result",
      baseVersionId: "ver_base",
      undoneAt: new Date("2026-10-23T12:05:00Z"),
    });
    expect(state.status).toBe("undone");
    expect(state.appliedVersionId).toBe("ver_result");
    expect(state.undoneAt).toEqual(new Date("2026-10-23T12:05:00Z"));
  });

  it("defensive: undoneAt without appliedAt still reads as proposed", () => {
    const state = toPlanState({
      ...COLUMNS,
      undoneAt: new Date("2026-10-23T12:05:00Z"),
    });
    expect(state.status).toBe("proposed");
  });
});
