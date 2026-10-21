/**
 * Pure-logic tests for the realtime presence core (W8-R): env mode parsing,
 * channel naming, roster diffing, wire-schema pins, the SSE poll client
 * (fake fetch + fake timers — no network), the Centrifugo client via an
 * injected loader/fakes (the CDN import itself is never exercised here —
 * that belongs to infra's live smoke test), and the mode-selection factory.
 * Deterministic, node env, <5 s. Tables are typed tuple arrays + loops
 * (no `it.each` generics — strict-TS bulletproof).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CENTRIFUGE_CDN_URL,
  CentrifugoPresence,
  NoopPresenceClient,
  RealtimeEnvError,
  SseFallbackPresence,
  createPresenceClient,
  diffMembers,
  documentIdFromPresenceChannel,
  documentPresenceChannel,
  initialsOf,
  parseCentrifugoUrl,
  parseJoinLeaveContext,
  parsePresenceInfo,
  parseRealtimeMode,
  presenceHeartbeatResponseSchema,
  unwrapPresenceResult,
  type CentrifugeCtor,
  type CentrifugeLike,
  type CentrifugeSubscriptionLike,
  type EnvSource,
  type PresenceListener,
  type PresenceMember,
  type PresenceState,
  type PresenceStatus,
  type PresenceUpdate,
  type RealtimeMode,
} from "./presence";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://gateway.test/v1";

const M = (id: string, name: string | null = null, self = false): PresenceMember => ({
  id,
  name,
  self,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  readonly input: string;
  readonly init?: RequestInit;
}

/** Queue one Response per expected fetch call; records every call made. */
class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Response[] = [];

  push(response: Response): void {
    this.queue.push(response);
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({ input, init });
    const next = this.queue.shift();
    return next === undefined ? jsonResponse({ ok: true, viewers: [] }) : next;
  };
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined || typeof headers !== "object") {
    return null;
  }
  const record = headers as Record<string, string>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }
  return null;
}

/** Flush a promise chain (fake timers fake time, not microtasks). */
async function flush(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function lastState(statuses: readonly PresenceStatus[]): PresenceState | undefined {
  return statuses.at(-1)?.state;
}

class FakeSubscription implements CentrifugeSubscriptionLike {
  readonly handlers = new Map<string, (ctx: unknown) => void>();
  subscribedCount = 0;
  unsubscribedCount = 0;
  presenceResult: unknown = {
    presence: {
      c1: { client: "c1", user: "u1", channel_info: { name: "Ada Lovelace" } },
    },
  };

  on(event: string, handler: (ctx: unknown) => void): FakeSubscription {
    this.handlers.set(event, handler);
    return this;
  }

  subscribe(): void {
    this.subscribedCount += 1;
  }

  unsubscribe(): void {
    this.unsubscribedCount += 1;
  }

  async presence(): Promise<unknown> {
    return this.presenceResult;
  }

  fire(event: string, ctx: unknown): void {
    this.handlers.get(event)?.(ctx);
  }
}

class FakeCentrifuge implements CentrifugeLike {
  readonly handlers = new Map<string, (ctx: unknown) => void>();
  readonly subs = new Map<string, FakeSubscription>();
  connectCount = 0;
  disconnectCount = 0;

  on(event: string, handler: (ctx: unknown) => void): FakeCentrifuge {
    this.handlers.set(event, handler);
    return this;
  }

  connect(): void {
    this.connectCount += 1;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  newSubscription(channel: string): FakeSubscription {
    const sub = new FakeSubscription();
    this.subs.set(channel, sub);
    return sub;
  }

  fire(event: string): void {
    this.handlers.get(event)?.({});
  }
}

function fakeCtor(hub: FakeCentrifuge, captured: { url?: string }): CentrifugeCtor {
  const ctor = function (url: string): CentrifugeLike {
    captured.url = url;
    return hub;
  };
  return ctor as unknown as CentrifugeCtor;
}

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

describe("parseRealtimeMode", () => {
  const rows: readonly (readonly [string, EnvSource, RealtimeMode])[] = [
    ["unset", {}, "sse"],
    ["empty string", { NEXT_PUBLIC_REALTIME: "" }, "sse"],
    ["whitespace-padded", { NEXT_PUBLIC_REALTIME: " off " }, "off"],
    ["centrifugo", { NEXT_PUBLIC_REALTIME: "centrifugo" }, "centrifugo"],
    ["sse", { NEXT_PUBLIC_REALTIME: "sse" }, "sse"],
    ["off", { NEXT_PUBLIC_REALTIME: "off" }, "off"],
  ];
  for (const [label, source, expected] of rows) {
    it(`mode for ${label}`, () => {
      expect(parseRealtimeMode(source)).toBe(expected);
    });
  }

  it("fails fast on a typo (§4 refuse-on-bad-env)", () => {
    expect(() => parseRealtimeMode({ NEXT_PUBLIC_REALTIME: "websocket" })).toThrow(RealtimeEnvError);
  });
});

describe("parseCentrifugoUrl", () => {
  it("returns null when unset (§3.1 optional at start)", () => {
    expect(parseCentrifugoUrl({})).toBeNull();
  });

  const urls = [
    "ws://localhost:8008/connection/websocket",
    "wss://rt.example.com/connection/websocket",
    "https://rt.example.com",
  ];
  for (const url of urls) {
    it(`accepts ${url}`, () => {
      expect(parseCentrifugoUrl({ NEXT_PUBLIC_CENTRIFUGO_URL: url })).toBe(url);
    });
  }

  it("trims a trailing slash and rejects non-URLs", () => {
    expect(parseCentrifugoUrl({ NEXT_PUBLIC_CENTRIFUGO_URL: "wss://rt.example.com/" })).toBe(
      "wss://rt.example.com",
    );
    expect(() => parseCentrifugoUrl({ NEXT_PUBLIC_CENTRIFUGO_URL: "not-a-url" })).toThrow(
      RealtimeEnvError,
    );
  });
});

// ---------------------------------------------------------------------------
// Channel naming + pure helpers
// ---------------------------------------------------------------------------

describe("channel naming", () => {
  it("round-trips document ids", () => {
    expect(documentPresenceChannel("d-123")).toBe("doc:d-123");
    expect(documentIdFromPresenceChannel("doc:d-123")).toBe("d-123");
  });

  it("accepts bare ids leniently", () => {
    expect(documentIdFromPresenceChannel("d-123")).toBe("d-123");
  });
});

describe("initialsOf", () => {
  const rows: readonly (readonly [string | null | undefined, string])[] = [
    ["Ada Lovelace", "AL"],
    ["jean-paul sartre", "JS"],
    ["ada", "A"],
    ["李小龙", "李"],
    ["  ", "?"],
    ["", "?"],
    [null, "?"],
    [undefined, "?"],
  ];
  for (const [name, expected] of rows) {
    it(`initialsOf(${String(name)}) → ${expected}`, () => {
      expect(initialsOf(name)).toBe(expected);
    });
  }
});

describe("diffMembers", () => {
  it("detects joins and leaves by id", () => {
    const diff = diffMembers([M("u1"), M("u2")], [M("u2"), M("u3")]);
    expect(diff.joins.map((m) => m.id)).toEqual(["u3"]);
    expect(diff.leaves.map((m) => m.id)).toEqual(["u1"]);
  });

  it("keeps a user who still holds one of two connections (no leave while one remains)", () => {
    const diff = diffMembers([M("u1", "Ada"), M("u1", "second-tab")], [M("u1", "Ada")]);
    expect(diff.joins).toEqual([]);
    expect(diff.leaves).toEqual([]);
  });

  it("dedupes by id (first occurrence wins)", () => {
    const diff = diffMembers([], [M("u1", "First"), M("u1", "Second")]);
    expect(diff.joins).toEqual([M("u1", "First")]);
  });
});

// ---------------------------------------------------------------------------
// Wire schemas + Centrifugo payload parsing
// ---------------------------------------------------------------------------

describe("presenceHeartbeatResponseSchema (gateway pin)", () => {
  it("accepts the documented body", () => {
    const parsed = presenceHeartbeatResponseSchema.safeParse({
      ok: true,
      viewers: [{ id: "u1", name: "Ada" }, { id: "u2", self: true }],
      ttl_ms: 30_000,
    });
    expect(parsed.success).toBe(true);
  });

  const rejects: readonly (readonly [string, unknown])[] = [
    ["missing ok", { viewers: [] }],
    ["ok false", { ok: false, viewers: [] }],
    ["viewers not an array", { ok: true, viewers: "nope" }],
    ["empty viewer id", { ok: true, viewers: [{ id: "" }] }],
  ];
  for (const [label, body] of rejects) {
    it(`rejects ${label}`, () => {
      expect(presenceHeartbeatResponseSchema.safeParse(body).success).toBe(false);
    });
  }
});

describe("parsePresenceInfo / parseJoinLeaveContext / unwrapPresenceResult", () => {
  it("maps user > client ids and channel_info names", () => {
    expect(
      parsePresenceInfo({ client: "c1", user: "u1", channel_info: { name: "Ada" } }, "u1"),
    ).toEqual({ id: "u1", name: "Ada", self: true });
    expect(parsePresenceInfo({ client: "c1" })).toEqual({ id: "c1", name: null, self: false });
    expect(parsePresenceInfo({ user: "u2" })).toBeNull(); // client required
    expect(parsePresenceInfo("garbage")).toBeNull();
  });

  it("extracts the roster key from v4 join/leave contexts", () => {
    const entry = parseJoinLeaveContext({ info: { client: "c2", user: "u2" } });
    expect(entry?.key).toBe("c2");
    expect(entry?.member.id).toBe("u2");
    expect(parseJoinLeaveContext({ client: "c3" })?.key).toBe("c3"); // bare info
    expect(parseJoinLeaveContext(null)).toBeNull();
  });

  it("walks wrapped and bare presence maps, skipping malformed entries", () => {
    const wrapped = unwrapPresenceResult({
      presence: { c1: { client: "c1" }, bad: "junk" },
    });
    expect(wrapped).toEqual([{ key: "c1", member: { id: "c1", name: null, self: false } }]);
    const bare = unwrapPresenceResult({ c2: { client: "c2", user: "u2" } });
    expect(bare[0]?.member.id).toBe("u2");
    expect(unwrapPresenceResult(null)).toEqual([]);
    expect(unwrapPresenceResult("nope")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NoopPresenceClient (mode "off")
// ---------------------------------------------------------------------------

describe("NoopPresenceClient", () => {
  it("reports disabled and never emits", () => {
    const statuses: PresenceStatus[] = [];
    const client = new NoopPresenceClient({ onStatus: (s) => statuses.push(s) });
    const updates: PresenceUpdate[] = [];
    const dispose = client.subscribe("doc:d1", (u) => updates.push(u));
    dispose();
    client.unsubscribe("doc:d1");
    client.destroy();
    expect(updates).toEqual([]);
    expect(statuses).toEqual([{ transport: "none", state: "disabled", detail: null }]);
  });
});

// ---------------------------------------------------------------------------
// SseFallbackPresence (fake fetch + fake timers — no network)
// ---------------------------------------------------------------------------

describe("SseFallbackPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("heartbeats immediately, snapshots the roster (no join toasts) and polls on the interval", async () => {
    const fake = new FakeFetch();
    fake.push(
      jsonResponse({ ok: true, viewers: [{ id: "u1", name: "Ada Lovelace" }, { id: "u2" }] }),
    );
    const statuses: PresenceStatus[] = [];
    const client = new SseFallbackPresence({
      baseUrl: BASE,
      fetch: fake.fetch,
      intervalMs: 1_000,
      onStatus: (s) => statuses.push(s),
    });
    const updates: PresenceUpdate[] = [];
    client.subscribe("doc:d1", (u) => updates.push(u));
    await flush();

    // First tick: single `sync` with the full roster (initial viewers were
    // already here — not joins).
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.input).toBe(`${BASE}/documents/d1/presence/heartbeat`);
    expect(fake.calls[0]?.init?.method).toBe("POST");
    const key = header(fake.calls[0]?.init, "Idempotency-Key");
    expect(typeof key).toBe("string");
    expect(updates.map((u) => u.delta.type)).toEqual(["sync"]);
    expect(updates[0]?.roster.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(statuses.map((s) => s.state)).toEqual(["connecting", "connected"]);

    // Second tick: u2 left, u3 joined → leave + join + sync, stable key.
    fake.push(
      jsonResponse({ ok: true, viewers: [{ id: "u1", name: "Ada Lovelace" }, { id: "u3" }] }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(fake.calls.length).toBe(2);
    expect(header(fake.calls[1]?.init, "Idempotency-Key")).toBe(key);
    expect(updates.map((u) => u.delta.type)).toEqual(["sync", "leave", "join", "sync"]);
    expect(updates.at(-1)?.roster.map((m) => m.id)).toEqual(["u1", "u3"]);
    const leave = updates[1]?.delta;
    if (leave?.type === "leave") {
      expect(leave.member.id).toBe("u2");
    }
    const join = updates[2]?.delta;
    if (join?.type === "join") {
      expect(join.member.id).toBe("u3");
    }
    client.destroy();
  });

  it("marks the caller's own entry via selfId and the server's self flag", async () => {
    const fake = new FakeFetch();
    fake.push(jsonResponse({ ok: true, viewers: [{ id: "u1" }, { id: "u2", self: true }] }));
    const client = new SseFallbackPresence({
      baseUrl: BASE,
      fetch: fake.fetch,
      intervalMs: 1_000,
      selfId: "u1",
    });
    const updates: PresenceUpdate[] = [];
    client.subscribe("doc:d1", (u) => updates.push(u));
    await flush();
    const roster = updates[0]?.roster ?? [];
    expect(roster[0]).toMatchObject({ id: "u1", self: true }); // via selfId
    expect(roster[1]).toMatchObject({ id: "u2", self: true }); // via server flag
    client.destroy();
  });

  it("downgrades to disconnected on failure, dedupes statuses, and recovers", async () => {
    const fake = new FakeFetch();
    fake.push(jsonResponse({ ok: false }, 500));
    const statuses: PresenceStatus[] = [];
    const client = new SseFallbackPresence({
      baseUrl: BASE,
      fetch: fake.fetch,
      intervalMs: 1_000,
      onStatus: (s) => statuses.push(s),
    });
    const updates: PresenceUpdate[] = [];
    client.subscribe("doc:d1", (u) => updates.push(u));
    await flush();
    expect(lastState(statuses)).toBe("disconnected");

    fake.push(jsonResponse({ unexpected: "shape" })); // schema failure
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(statuses.length).toBe(2); // no duplicate disconnected status

    fake.push(jsonResponse({ ok: true, viewers: [{ id: "u9" }] }));
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(lastState(statuses)).toBe("connected");
    expect(updates.at(-1)?.roster.map((m) => m.id)).toEqual(["u9"]);
    client.destroy();
  });

  it("reports error (not a retry case) on 401", async () => {
    const fake = new FakeFetch();
    fake.push(jsonResponse({ ok: false }, 401));
    const statuses: PresenceStatus[] = [];
    const client = new SseFallbackPresence({
      baseUrl: BASE,
      fetch: fake.fetch,
      intervalMs: 1_000,
      onStatus: (s) => statuses.push(s),
    });
    client.subscribe("doc:d1", () => {});
    await flush();
    expect(statuses.at(-1)).toMatchObject({ transport: "sse", state: "error" });
    client.destroy();
  });

  it("stops polling and sends a best-effort DELETE leave when the last listener goes", async () => {
    const fake = new FakeFetch();
    fake.push(jsonResponse({ ok: true, viewers: [{ id: "u1" }] }));
    const client = new SseFallbackPresence({ baseUrl: BASE, fetch: fake.fetch, intervalMs: 1_000 });
    const updates: PresenceUpdate[] = [];
    const dispose = client.subscribe("doc:d1", (u) => updates.push(u));
    await flush();
    const callsBefore = fake.calls.length;
    dispose();
    const last = fake.calls.at(-1);
    expect(last?.input).toBe(`${BASE}/documents/d1/presence/heartbeat`);
    expect(last?.init?.method).toBe("DELETE");
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(fake.calls.length).toBe(callsBefore + 1); // only the DELETE — timer gone
    client.destroy();
  });

  it("fans updates out to every listener of one channel", async () => {
    const fake = new FakeFetch();
    fake.push(jsonResponse({ ok: true, viewers: [{ id: "u1" }] }));
    fake.push(jsonResponse({ ok: true, viewers: [{ id: "u1" }, { id: "u2" }] }));
    const client = new SseFallbackPresence({ baseUrl: BASE, fetch: fake.fetch, intervalMs: 1_000 });
    const seenA: string[] = [];
    const seenB: string[] = [];
    const listenerA: PresenceListener = (update) => {
      seenA.push(update.delta.type);
    };
    const listenerB: PresenceListener = (update) => {
      seenB.push(update.delta.type);
    };
    client.subscribe("doc:d1", listenerA);
    client.subscribe("doc:d1", listenerB);
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(seenA).toEqual(["sync", "join", "sync"]);
    expect(seenB).toEqual(["sync", "join", "sync"]);
    client.destroy();
  });

  it("keeps polling channel b after channel a unsubscribes", async () => {
    const fake = new FakeFetch();
    const client = new SseFallbackPresence({ baseUrl: BASE, fetch: fake.fetch, intervalMs: 1_000 });
    const disposeA = client.subscribe("doc:a", () => {});
    client.subscribe("doc:b", () => {});
    await flush();
    const postsAfterFirstTick = fake.calls.filter((c) => c.init?.method === "POST").length;
    disposeA();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const posts = fake.calls.filter((c) => c.init?.method === "POST");
    expect(posts.length).toBe(postsAfterFirstTick + 1); // only doc:b ticked
    expect(posts.at(-1)?.input).toBe(`${BASE}/documents/b/presence/heartbeat`);
    client.destroy();
  });
});

// ---------------------------------------------------------------------------
// CentrifugoPresence (injected loader — the CDN import is never exercised)
// ---------------------------------------------------------------------------

describe("CentrifugoPresence", () => {
  it("attaches, snapshots presence, and fans join/leave deltas", async () => {
    const hub = new FakeCentrifuge();
    const captured: { url?: string } = {};
    const statuses: PresenceStatus[] = [];
    const client = new CentrifugoPresence({
      url: "wss://rt.test/connection/websocket",
      selfId: "u1",
      loader: async () => fakeCtor(hub, captured),
      onStatus: (s) => statuses.push(s),
    });
    const updates: PresenceUpdate[] = [];
    client.subscribe("doc:d1", (u) => updates.push(u));
    await flush();

    expect(captured.url).toBe("wss://rt.test/connection/websocket");
    expect(hub.connectCount).toBe(1);
    expect(updates).toEqual([]); // nothing before the server speaks
    const sub = hub.subs.get("doc:d1");
    expect(sub?.subscribedCount).toBe(1);

    hub.fire("connect");
    expect(statuses.map((s) => s.state)).toEqual(["connecting", "connected"]);

    // subscribed → presence() snapshot (initial viewers are NOT joins)
    sub?.fire("subscribed", {});
    await flush();
    expect(updates.at(-1)?.delta.type).toBe("sync");
    expect(updates.at(-1)?.roster).toEqual([{ id: "u1", name: "Ada Lovelace", self: true }]);

    sub?.fire("join", { info: { client: "c2", user: "u2", channel_info: { name: "Bo" } } });
    expect(updates.at(-1)?.delta).toEqual({
      type: "join",
      member: { id: "u2", name: "Bo", self: false },
    });
    expect(updates.at(-1)?.roster.length).toBe(2);

    sub?.fire("leave", { info: { client: "c1" } });
    expect(updates.at(-1)?.delta.type).toBe("leave");
    expect(updates.at(-1)?.roster.map((m) => m.id)).toEqual(["u2"]);

    client.unsubscribe("doc:d1");
    expect(sub?.unsubscribedCount).toBe(1);
    client.destroy();
    expect(hub.disconnectCount).toBe(1);
  });

  it("degrades to the fallback client when loading fails, then proxies new subscriptions", async () => {
    const forwarded: string[] = [];
    const destroyed: number[] = [];
    const fallback = {
      subscribe: (channel: string) => {
        forwarded.push(channel);
        return () => {};
      },
      unsubscribe: () => {},
      destroy: () => {
        destroyed.push(1);
      },
    };
    const statuses: PresenceStatus[] = [];
    const client = new CentrifugoPresence({
      url: "wss://rt.test",
      loader: async () => {
        throw new Error("cdn down");
      },
      fallback: () => fallback,
      onStatus: (s) => statuses.push(s),
    });
    const updates: PresenceUpdate[] = [];
    client.subscribe("doc:d1", (u) => updates.push(u));
    await flush();

    expect(forwarded).toEqual(["doc:d1"]); // recorded channel moved over
    expect(lastState(statuses)).toBe("error");
    expect(statuses.at(-1)?.transport).toBe("centrifugo");

    client.subscribe("doc:d2", () => {});
    await flush();
    expect(forwarded).toEqual(["doc:d1", "doc:d2"]);
    client.destroy(); // forwarded to the fallback
    expect(destroyed.length).toBe(1);
  });

  it("stays inert with an error status when no fallback factory is provided", async () => {
    const statuses: PresenceStatus[] = [];
    const client = new CentrifugoPresence({
      url: "wss://rt.test",
      loader: async () => {
        throw new Error("offline");
      },
      onStatus: (s) => statuses.push(s),
    });
    const updates: PresenceUpdate[] = [];
    client.subscribe("doc:d1", (u) => updates.push(u));
    await flush();
    expect(updates).toEqual([]);
    expect(statuses.at(-1)).toEqual({
      transport: "centrifugo",
      state: "error",
      detail: "Realtime presence is unavailable right now.",
    });
    client.destroy();
  });

  it("does not attach channels subscribed after destroy()", async () => {
    const hub = new FakeCentrifuge();
    const client = new CentrifugoPresence({
      url: "wss://rt.test",
      loader: async () => fakeCtor(hub, {}),
    });
    client.subscribe("doc:d1", () => {});
    client.destroy();
    await flush();
    client.subscribe("doc:d2", () => {});
    await flush();
    expect(hub.subs.has("doc:d2")).toBe(false);
    expect(hub.connectCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Factory — mode auto-selection
// ---------------------------------------------------------------------------

describe("createPresenceClient", () => {
  it("honors NEXT_PUBLIC_REALTIME=off", () => {
    expect(createPresenceClient({ source: { NEXT_PUBLIC_REALTIME: "off" } })).toBeInstanceOf(
      NoopPresenceClient,
    );
  });

  it("defaults to the SSE poll client when the mode is unset (§3.1 SSE first)", () => {
    expect(createPresenceClient({ source: {} })).toBeInstanceOf(SseFallbackPresence);
  });

  it("centrifugo without an endpoint falls back to the SSE poll client (config-level)", () => {
    const client = createPresenceClient({
      source: { NEXT_PUBLIC_REALTIME: "centrifugo" },
      baseUrl: BASE,
      fetch: async () => jsonResponse({ ok: true, viewers: [] }),
    });
    expect(client).toBeInstanceOf(SseFallbackPresence);
  });

  it("centrifugo with an endpoint builds the websocket client", () => {
    const client = createPresenceClient({
      source: { NEXT_PUBLIC_REALTIME: "centrifugo", NEXT_PUBLIC_CENTRIFUGO_URL: "wss://rt.test" },
    });
    expect(client).toBeInstanceOf(CentrifugoPresence);
  });

  it("mode option overrides the env", () => {
    expect(createPresenceClient({ source: {}, mode: "off" })).toBeInstanceOf(NoopPresenceClient);
  });

  it("bad env throws the typed error", () => {
    expect(() => createPresenceClient({ source: { NEXT_PUBLIC_REALTIME: "nope" } })).toThrow(
      RealtimeEnvError,
    );
  });
});

describe("CENTRIFUGE_CDN_URL", () => {
  it("pins the v4 ESM build (no package.json dependency)", () => {
    expect(CENTRIFUGE_CDN_URL).toBe("https://cdn.jsdelivr.net/npm/centrifuge@4/+esm");
  });
});
