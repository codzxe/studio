// SessionRegistry — pure bookkeeping: tenant isolation, cap counting, idle eviction.

import { describe, expect, it } from "vitest";

import { DEFAULT_IDLE_TIMEOUT_MS } from "../src/constants.js";
import { EnginePoolError } from "../src/errors.js";
import { SessionRegistry } from "../src/registry.js";
import type { EngineSession, EngineSessionState } from "../src/types.js";
import { expectEnginePoolError } from "./fakes.js";

const session = (overrides: Partial<EngineSession> = {}): EngineSession => ({
  sessionId: "session-1",
  organizationId: "org-1",
  token: "a".repeat(64),
  startedAt: 1_000,
  lastActivityAt: 1_000,
  state: "allocated",
  ...overrides,
});

describe("SessionRegistry", () => {
  it("registers a session and hands out frozen copies", () => {
    const registry = new SessionRegistry();
    registry.register(session());
    const got = registry.get("session-1");
    if (!got) throw new Error("session should be registered");
    expect(got.sessionId).toBe("session-1");
    expect(Object.isFrozen(got)).toBe(true);
    expect(registry.get("session-1")).not.toBe(got); // fresh copy every call
  });

  it("rejects duplicate session ids (allocation invariant)", () => {
    const registry = new SessionRegistry();
    registry.register(session());
    expect(() => registry.register(session({ token: "b".repeat(64) }))).toThrowError(
      EnginePoolError,
    );
    expect(registry.size()).toBe(1);
  });

  it("never exposes a session to another tenant (§25 rule 4)", () => {
    const registry = new SessionRegistry();
    registry.register(session());
    expect(registry.findForTenant("session-1", "org-1")).toBeDefined();
    // Cross-tenant probes look exactly like unknown ids: no existence leak (§15.1).
    expect(registry.findForTenant("session-1", "org-2")).toBeUndefined();
    expect(registry.findForTenant("missing", "org-1")).toBeUndefined();
  });

  it("finds the active session for a document within one tenant only", () => {
    const registry = new SessionRegistry();
    registry.register(
      session({ sessionId: "s-own", documentId: "doc-a", state: "attached", lastActivityAt: 500 }),
    );
    registry.register(
      session({
        sessionId: "s-newer",
        organizationId: "org-1",
        documentId: "doc-a",
        state: "idle",
        lastActivityAt: 900,
      }),
    );
    registry.register(
      session({
        sessionId: "s-foreign",
        organizationId: "org-2",
        documentId: "doc-a",
        state: "attached",
      }),
    );
    registry.register(
      session({ sessionId: "s-draining", documentId: "doc-a", state: "draining" }),
    );
    const found = registry.findByDocument("org-1", "doc-a");
    expect(found?.sessionId).toBe("s-newer"); // most recently active wins
    expect(registry.findByDocument("org-1", "doc-b")).toBeUndefined();
    expect(registry.findByDocument("org-2", "doc-a")?.sessionId).toBe("s-foreign");
  });

  it("counts only active sessions toward the per-organization cap", () => {
    const registry = new SessionRegistry();
    const states: EngineSessionState[] = [
      "allocated",
      "attached",
      "idle", // active: 3
      "draining",
      "crashed", // ignored: 2
    ];
    states.forEach((state, index) => {
      registry.register(session({ sessionId: `s-${index}`, state }));
    });
    expect(registry.countActive("org-1")).toBe(3);
    expect(registry.countActive("org-2")).toBe(0);
  });

  it("updates mutable fields and refuses unknown ids", () => {
    const registry = new SessionRegistry();
    registry.register(session());
    const updated = registry.update("session-1", {
      documentId: "doc-1",
      state: "attached",
      lastActivityAt: 2_000,
    });
    expect(updated.state).toBe("attached");
    expect(updated.documentId).toBe("doc-1");
    expect(registry.get("session-1")?.lastActivityAt).toBe(2_000);
    expectEnginePoolError(() => registry.update("missing", { state: "idle" }), "session_not_found");
  });

  it("removes sessions", () => {
    const registry = new SessionRegistry();
    registry.register(session());
    const removed = registry.remove("session-1");
    expect(removed?.sessionId).toBe("session-1");
    expect(registry.get("session-1")).toBeUndefined();
    expect(registry.remove("session-1")).toBeUndefined();
  });

  it("lists sessions filtered by organization and state", () => {
    const registry = new SessionRegistry();
    registry.register(session({ sessionId: "a" }));
    registry.register(session({ sessionId: "b", organizationId: "org-2", state: "idle" }));
    expect(registry.list()).toHaveLength(2);
    expect(registry.list({ organizationId: "org-1" }).map((s) => s.sessionId)).toEqual(["a"]);
    expect(registry.list({ states: ["idle"] }).map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("picks idle-eviction candidates, most idle first (§3.2 idle timeout)", () => {
    const registry = new SessionRegistry();
    const now = 1_000 + DEFAULT_IDLE_TIMEOUT_MS;
    const rows: readonly EngineSession[] = [
      session({ sessionId: "idle-oldest", lastActivityAt: 100 }),
      session({ sessionId: "idle-old", lastActivityAt: 300 }),
      session({ sessionId: "fresh", lastActivityAt: now - 1_000 }),
      session({ sessionId: "draining-old", lastActivityAt: 100, state: "draining" }),
      session({ sessionId: "crashed-old", lastActivityAt: 100, state: "crashed" }),
    ];
    for (const row of rows) {
      registry.register(row);
    }
    // 15-minute default threshold (§3.4), explicit now, deterministic order.
    const candidates = registry.evictionCandidates({ now });
    expect(candidates.map((s) => s.sessionId)).toEqual(["idle-oldest", "idle-old"]);
    // A tighter threshold flips `fresh` in and keeps the same ordering rule.
    const tight = registry.evictionCandidates({ now, maxIdleMs: 500 });
    expect(tight.map((s) => s.sessionId)).toEqual(["idle-oldest", "idle-old", "fresh"]);
  });

  it("uses its own clock when no explicit now is given", () => {
    let fakeNow = 9_998;
    const registry = new SessionRegistry({ clock: () => fakeNow });
    registry.register(session({ lastActivityAt: 0 }));
    // Idle age 9_998 < 9_999: not evictable yet.
    expect(registry.evictionCandidates({ maxIdleMs: 9_999 })).toHaveLength(0);
    fakeNow += 2; // Idle age 10_000 ≥ 9_999: evictable.
    expect(registry.evictionCandidates({ maxIdleMs: 9_999 })).toHaveLength(1);
  });
});
