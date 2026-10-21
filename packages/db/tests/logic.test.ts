import { describe, expect, it } from "vitest";

import { clampLimit, decodeCursor, encodeCursor } from "../src/cursor.js";
import { DbError } from "../src/errors-lite.js";
import { DEFAULT_LEASE_TTL_MS, isLeaseHeld, leaseDecision } from "../src/lease-logic.js";
import { ensureUniqueSlug, slugify } from "../src/slug.js";
import {
  assertRenderTransition,
  assertRunTransition,
  isTerminalRenderStatus,
  isTerminalRunStatus,
} from "../src/statuses.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");

/** Single-writer lease (§9.3, §11): 5-minute expiry, holder wins until then. */
describe("leaseDecision", () => {
  it("acquires when free", () => {
    expect(leaseDecision(null, "user_a", NOW)).toEqual({ action: "acquire" });
  });

  it("refuses while another holder's lease is live", () => {
    const decision = leaseDecision(
      { userId: "user_a", expiresAt: new Date("2026-01-15T12:04:00.000Z") },
      "user_b",
      NOW,
    );
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.reason).toBe("held-by-other");
      expect(decision.state.userId).toBe("user_a");
    }
  });

  it("re-acquires when the lease is expired", () => {
    const decision = leaseDecision(
      { userId: "user_a", expiresAt: new Date("2026-01-15T11:59:59.999Z") },
      "user_b",
      NOW,
    );
    expect(decision.action).toBe("acquire");
  });

  it("lets the current holder refresh their own lease", () => {
    const decision = leaseDecision(
      { userId: "user_a", expiresAt: new Date("2026-01-15T12:04:00.000Z") },
      "user_a",
      NOW,
    );
    expect(decision.action).toBe("acquire");
  });

  it("expiry is 5 minutes (§11)", () => {
    expect(DEFAULT_LEASE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("isLeaseHeld is a pure time comparison", () => {
    expect(isLeaseHeld({ userId: "u", expiresAt: new Date("2026-01-15T12:05:00.000Z") }, NOW)).toBe(
      true,
    );
    expect(isLeaseHeld({ userId: "u", expiresAt: new Date("2026-01-15T11:59:00.000Z") }, NOW)).toBe(
      false,
    );
    expect(isLeaseHeld(null, NOW)).toBe(false);
  });
});

describe("run status machine (§7.4, §8.9)", () => {
  it("queued → running → completed", () => {
    expect(() => {
      assertRunTransition("queued", "running");
      assertRunTransition("running", "completed");
    }).not.toThrow();
  });

  it("cancelled from queued or running; terminal states are frozen", () => {
    expect(() => assertRunTransition("queued", "cancelled")).not.toThrow();
    expect(() => assertRunTransition("running", "cancelled")).not.toThrow();
    expect(() => assertRunTransition("awaiting_approval", "cancelled")).not.toThrow();
    for (const from of ["completed", "failed", "cancelled"] as const) {
      expect(() => assertRunTransition(from, "running")).toThrowError(DbError);
      expect(isTerminalRunStatus(from)).toBe(true);
    }
  });

  it("approval flow: running ↔ awaiting_approval", () => {
    expect(() => assertRunTransition("running", "awaiting_approval")).not.toThrow();
    expect(() => assertRunTransition("awaiting_approval", "running")).not.toThrow();
  });

  it("illegal jumps are typed CONFLICTs", () => {
    try {
      assertRunTransition("queued", "completed");
      expect.unreachable();
    } catch (error) {
      expect((error as DbError).code).toBe("CONFLICT");
    }
  });
});

describe("render status machine (§7.4)", () => {
  it("queued → running → completed | failed | cancelled", () => {
    expect(() => assertRenderTransition("queued", "running")).not.toThrow();
    expect(() => assertRenderTransition("running", "completed")).not.toThrow();
    expect(() => assertRenderTransition("running", "failed")).not.toThrow();
    expect(() => assertRenderTransition("running", "cancelled")).not.toThrow();
    expect(() => assertRenderTransition("queued", "cancelled")).not.toThrow();
  });

  it("terminal renders are frozen", () => {
    for (const from of ["completed", "failed", "cancelled"] as const) {
      expect(() => assertRenderTransition(from, "running")).toThrowError(DbError);
      expect(isTerminalRenderStatus(from)).toBe(true);
    }
    expect(() => assertRenderTransition("queued", "completed")).toThrowError(DbError);
  });
});

describe("cursors", () => {
  it("encode/decode roundtrips", () => {
    const cursor = encodeCursor({ t: "2026-01-15T12:00:00.000Z", id: "prj_1" });
    expect(decodeCursor(cursor)).toEqual({ t: "2026-01-15T12:00:00.000Z", id: "prj_1" });
  });

  it("empty cursor means first page", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("garbage cursors are typed VALIDATION_FAILED, not crashes", () => {
    expect(() => decodeCursor("!!!not-base64url")).toThrowError(DbError);
    try {
      decodeCursor(Buffer.from('{"t":1}').toString("base64url"));
      expect.unreachable();
    } catch (error) {
      expect((error as DbError).code).toBe("VALIDATION_FAILED");
    }
  });

  it("clampLimit bounds page size", () => {
    expect(clampLimit()).toBe(20);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(1000)).toBe(100);
    expect(() => clampLimit(0)).toThrowError(DbError);
    expect(() => clampLimit(2.5)).toThrowError(DbError);
  });
});

describe("slugs", () => {
  it("slugify normalizes names", () => {
    expect(slugify("My Cool Project!")).toBe("my-cool-project");
    expect(slugify("  Über   Movie — v2 ")).toBe("uber-movie-v2");
    expect(slugify("---")).toBe("project");
  });

  it("ensureUniqueSlug appends -2, -3, … deterministically", () => {
    expect(ensureUniqueSlug("demo", new Set())).toBe("demo");
    expect(ensureUniqueSlug("demo", new Set(["demo"]))).toBe("demo-2");
    expect(ensureUniqueSlug("demo", new Set(["demo", "demo-2", "demo-3"]))).toBe("demo-4");
    expect(ensureUniqueSlug("demo-2", new Set(["demo-2"]))).toBe("demo-3");
  });
});
