// ProtocolConnection tests — auth ordering, id correlation, foreign-id skipping, drop and
// timeout semantics, reconnect re-auth, connection budget. In-memory FakeSocket + FakeClock:
// no real sockets, no real timers, fully deterministic (AGENTS.md).

import { describe, expect, it } from "vitest";

import type { FramedMessage, RequestId } from "./frame.js";
import {
  AUTH_DEADLINE_MS,
  AUTH_FRAME_ID,
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_CONNECTIONS_PER_LISTENER,
} from "./frame.js";
import { connectionDroppedMidCall, connectionRefused, isTransportError, TransportError } from "./errors.js";
import {
  ConnectionBudget,
  ProtocolConnection,
  type ProtocolConnectionOptions,
  type SocketFactory,
  type WireReply,
} from "./connection.js";
import { FakeClock, FakeSocket, TEST_TOKEN } from "./testing.js";

const AUTH_OK_REPLY: FramedMessage = {
  kind: "reply",
  id: AUTH_FRAME_ID,
  result: { authenticated: true },
};

/** Lets sync-resolved async chains (FakeSocket/FakeClock) reach their await points. */
async function drain(hops: number): Promise<void> {
  for (let i = 0; i < hops; i += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  readonly clock: FakeClock;
  readonly connection: ProtocolConnection;
  readonly sockets: FakeSocket[];
  current(): FakeSocket;
}

function makeConnection(
  options: Partial<ProtocolConnectionOptions> = {},
): Harness {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const connection = new ProtocolConnection(factory, {
    token: options.token ?? TEST_TOKEN,
    clock,
    ...options,
  });
  return {
    clock,
    connection,
    sockets,
    current: () => {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) {
        throw new Error("no socket created yet");
      }
      return socket;
    },
  };
}

/** connect() + successful auth reply → a ready connection. */
async function ready(options: Partial<ProtocolConnectionOptions> = {}): Promise<Harness> {
  const harness = makeConnection(options);
  const connecting = harness.connection.connect();
  expect(harness.connection.connectionState).toBe("authenticating");
  await drain(10); // reaches the auth wait: the auth frame is already on the fake socket
  harness.current().deliver(AUTH_OK_REPLY);
  await connecting;
  expect(harness.connection.connectionState).toBe("ready");
  return harness;
}

async function expectTransportError(
  promise: Promise<unknown>,
  code: string,
): Promise<TransportError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isTransportError(error)).toBe(true);
  const transportError = error as TransportError;
  expect(transportError.code).toBe(code);
  return transportError;
}

describe("construction and first-frame auth (doc §Methods)", () => {
  it("refuses a malformed token up front (security.rs validate_token)", () => {
    const clock = new FakeClock();
    let caught: unknown;
    try {
      new ProtocolConnection(() => new FakeSocket(), {
        token: TEST_TOKEN.slice(0, 63),
        clock,
      });
    } catch (error) {
      caught = error;
    }
    expect(isTransportError(caught)).toBe(true);
    expect((caught as TransportError).code).toBe("protocol_violation");
  });

  it("sends EXACTLY one auth frame before anything else, with the doc's id", async () => {
    const harness = await ready();
    const socket = harness.current();
    expect(socket.sentFrames.length).toBe(1);
    expect(socket.sentFrames[0]).toEqual({
      kind: "auth",
      id: AUTH_FRAME_ID,
      token: TEST_TOKEN,
    });
    expect(socket.sentLines[0]).toBe(
      `{"id":"auth","method":"auth","params":{"token":"${TEST_TOKEN}"}}\n`,
    );
  });

  it("state flows new → authenticating → ready", async () => {
    const harness = makeConnection();
    expect(harness.connection.connectionState).toBe("new");
    const connecting = harness.connection.connect();
    expect(harness.connection.connectionState).toBe("authenticating");
    await drain(10);
    harness.current().deliver(AUTH_OK_REPLY);
    await connecting;
    expect(harness.connection.connectionState).toBe("ready");
    expect(harness.clock.timerCount).toBe(0); // the auth timer was cleared
  });

  it("rejects a call while authenticating: nothing was sent", async () => {
    const harness = makeConnection();
    const connecting = harness.connection.connect();
    const error = await expectTransportError(
      harness.connection.call("doc.inspect", null),
      "connection_refused",
    );
    expect(error.mayHaveCompleted).toBe(false);
    await drain(10);
    harness.current().deliver(AUTH_OK_REPLY);
    await connecting;
  });

  it("auth_rejected on an explicit engine refusal; token hint; not retryable", async () => {
    const harness = makeConnection();
    const connecting = harness.connection.connect();
    await drain(10);
    harness.current().deliver({
      kind: "error",
      id: AUTH_FRAME_ID,
      error: "authentication required",
    });
    const error = await expectTransportError(connecting, "auth_rejected");
    expect(error.retryable).toBe(false);
    expect(error.mayHaveCompleted).toBe(false);
    expect(error.hint).toContain("token");
    expect(harness.connection.connectionState).toBe("dropped");
    expect(harness.current().closeCount).toBe(1); // the socket is closed
  });

  it("auth_rejected (retryable) when no auth reply beats the 10 s deadline (#4965)", async () => {
    const harness = makeConnection();
    const connecting = harness.connection.connect();
    await drain(10);
    harness.clock.advance(AUTH_DEADLINE_MS);
    const error = await expectTransportError(connecting, "auth_rejected");
    expect(error.retryable).toBe(true);
    expect(harness.connection.connectionState).toBe("dropped");
    expect(harness.current().closeCount).toBe(1);
  });

  it("protocol_violation when the auth reply does not confirm authentication", async () => {
    const harness = makeConnection();
    const connecting = harness.connection.connect();
    await drain(10);
    harness.current().deliver({
      kind: "reply",
      id: AUTH_FRAME_ID,
      result: { authenticated: false },
    });
    await expectTransportError(connecting, "protocol_violation");
    expect(harness.connection.connectionState).toBe("dropped");
  });

  it("a connect refusal propagates and leaves the connection dropped", async () => {
    const clock = new FakeClock();
    const connection = new ProtocolConnection(
      () => {
        const socket = new FakeSocket();
        socket.failConnectsWith(connectionRefused("connect ECONNREFUSED"));
        return socket;
      },
      { token: TEST_TOKEN, clock },
    );
    const error = await expectTransportError(connection.connect(), "connection_refused");
    expect(error.mayHaveCompleted).toBe(false); // nothing was sent
    expect(connection.connectionState).toBe("dropped");
  });

  it("connect() twice is a protocol violation", async () => {
    const harness = await ready();
    await expectTransportError(harness.connection.connect(), "protocol_violation");
  });
});

describe("request/reply correlation by id", () => {
  it("assigns sequential numeric ids and resolves the correlated reply", async () => {
    const harness = await ready();
    const socket = harness.current();

    const first = harness.connection.call("doc.inspect", null);
    expect(socket.sentFrames[1]).toEqual({
      kind: "request",
      id: 1,
      method: "doc.inspect",
      params: null,
    });
    socket.deliver({ kind: "reply", id: 1, result: { documents: [] } });
    expect(await first).toEqual({ ok: true, result: { documents: [] } });

    const second = harness.connection.call("session.list", null);
    expect(socket.sentFrames[2]).toEqual({
      kind: "request",
      id: 2,
      method: "session.list",
      params: null,
    });
    socket.deliver({ kind: "reply", id: 2, result: [] });
    expect(await second).toEqual({ ok: true, result: [] });
    expect(harness.clock.timerCount).toBe(0); // call timers were cleaned up
  });

  it("SKIPS reply lines whose id does not match the outstanding request (§MCP bridge)", async () => {
    const seen: FramedMessage[] = [];
    const pendingIds: Array<RequestId | null> = [];
    const harness = makeConnection({
      onSkippedFrame: (frame, pendingId) => {
        seen.push(frame);
        pendingIds.push(pendingId);
      },
    });
    const connecting = harness.connection.connect();
    await drain(10);
    harness.current().deliver(AUTH_OK_REPLY);
    await connecting;

    const call = harness.connection.call("doc.render", { maxSide: 64 });
    const socket = harness.current();
    socket.deliver({ kind: "reply", id: 99, result: null }); // foreign numeric id → skipped
    socket.deliver({ kind: "reply", id: "1", result: null }); // STRING "1" is a different id
    socket.deliver({ kind: "notification", method: "server.hi", params: null }); // no id at all
    socket.deliver({ kind: "reply", id: 1, result: { mime: "image/png" } }); // the match
    const reply: WireReply = await call;
    expect(reply).toEqual({ ok: true, result: { mime: "image/png" } });
    expect(harness.connection.skippedFrames).toBe(3);
    expect(seen.map((frame) => frame.kind)).toEqual(["reply", "reply", "notification"]);
    expect(pendingIds.every((id) => id === 1)).toBe(true);
  });

  it("maps an engine error reply to { ok:false, wireError } — the exchange itself succeeded", async () => {
    const harness = await ready();
    const call = harness.connection.call("engine.execute", { command: "nope" });
    harness.current().deliver({ kind: "error", id: 1, error: "unknown tool `foo`" });
    await expect(call).resolves.toEqual({ ok: false, wireError: "unknown tool `foo`" });
  });

  it("stays ready after a wire error; the next call reuses the connection", async () => {
    const harness = await ready();
    const failed = harness.connection.call("engine.execute", { command: "nope" });
    harness.current().deliver({ kind: "error", id: 1, error: "missing document" });
    await failed;
    expect(harness.connection.connectionState).toBe("ready");
    const next = harness.connection.call("doc.inspect", null);
    harness.current().deliver({ kind: "reply", id: 2, result: { width: 8 } });
    await expect(next).resolves.toEqual({ ok: true, result: { width: 8 } });
  });

  it("rejects a second concurrent call (one exchange per connection)", async () => {
    const harness = await ready();
    const first = harness.connection.call("doc.inspect", null);
    await expectTransportError(harness.connection.call("doc.inspect", null), "protocol_violation");
    harness.current().deliver({ kind: "reply", id: 1, result: null });
    await first;
  });

  it("skips an id:null pre-dispatch error while idle; fails one mid-call", async () => {
    const harness = await ready();
    harness.current().deliver({
      kind: "error",
      id: null,
      error: `request exceeds ${1 << 20} bytes`,
    });
    expect(harness.connection.skippedFrames).toBe(1);
    expect(harness.connection.connectionState).toBe("ready");

    const call = harness.connection.call("doc.render", null);
    harness.current().deliver({
      kind: "error",
      id: null,
      error: `request exceeds ${1 << 20} bytes`,
    });
    await expectTransportError(call, "protocol_violation");
    expect(harness.connection.connectionState).toBe("dropped");
  });
});

describe("calls against a non-ready connection", () => {
  it("rejects with connection_refused from state new: mayHaveCompleted false", async () => {
    const harness = makeConnection();
    const error = await expectTransportError(
      harness.connection.call("doc.inspect", null),
      "connection_refused",
    );
    expect(error.mayHaveCompleted).toBe(false);
    expect(error.message).toContain("was not sent");
    expect(error.message).toContain("new");
  });
});

describe("mid-call transport failures (doc §MCP bridge)", () => {
  it("socket error mid-call → connection_dropped_mid_call, may-have-completed semantics", async () => {
    const harness = await ready();
    const call = harness.connection.call("engine.execute", {
      command: "filter.blur.gaussianBlur",
    });
    harness.current().failWith(connectionDroppedMidCall("stream reset"));
    const error = await expectTransportError(call, "connection_dropped_mid_call");
    expect(error.mayHaveCompleted).toBe(true);
    expect(error.hint).toContain("may have completed");
    expect(error.hint).toContain("inspect the document");
    expect(harness.connection.connectionState).toBe("dropped");
  });

  it("silent close mid-call (the app dropped an idle connection) → same semantics", async () => {
    const harness = await ready();
    const call = harness.connection.call("doc.inspect", null);
    harness.current().drop(); // no error event, just EOF
    const error = await expectTransportError(call, "connection_dropped_mid_call");
    expect(error.mayHaveCompleted).toBe(true);
  });

  it("NEVER auto-resends: no frames are written after a mid-call drop (#1007)", async () => {
    const harness = await ready();
    const call = harness.connection.call("engine.execute", { command: "image.crop" });
    const sentBefore = harness.current().sentFrames.length;
    harness.current().failWith(connectionDroppedMidCall("reset"));
    await expectTransportError(call, "connection_dropped_mid_call");
    expect(harness.current().sentFrames.length).toBe(sentBefore); // no automatic resend
    harness.clock.advance(120_000); // time alone must not invent a resend either
    expect(harness.current().sentFrames.length).toBe(sentBefore);
  });

  it("reply timeout (55 s < the engine's 60 s deadline) drops the connection", async () => {
    const harness = await ready();
    const call = harness.connection.call("doc.render", { maxSide: 1024 });
    harness.clock.advance(DEFAULT_CALL_TIMEOUT_MS - 1);
    expect(harness.connection.connectionState).toBe("ready"); // still waiting
    harness.clock.advance(1);
    const error = await expectTransportError(call, "reply_timeout");
    expect(error.mayHaveCompleted).toBe(true);
    expect(error.hint).toContain("55 s");
    expect(error.hint).toContain("60 s");
    expect(harness.connection.connectionState).toBe("dropped");
    expect(harness.current().closeCount).toBe(1); // the doc mandates dropping, not reusing
  });

  it("a late reply after the timeout is skipped, never delivered to a dead call", async () => {
    const harness = await ready();
    const call = harness.connection.call("doc.render", null);
    harness.clock.advance(DEFAULT_CALL_TIMEOUT_MS);
    await expectTransportError(call, "reply_timeout");
    const skippedBefore = harness.connection.skippedFrames;
    harness.current().deliver({ kind: "reply", id: 1, result: null }); // pathological late reply
    expect(harness.connection.skippedFrames).toBe(skippedBefore + 1);
    expect(harness.connection.connectionState).toBe("dropped");
    await expectTransportError(harness.connection.call("doc.inspect", null), "connection_refused");
  });
});

describe("reconnect() re-authenticates (auth on EVERY TCP connection)", () => {
  it("closes the old socket, opens a new one, sends auth first, and continues ids", async () => {
    const harness = await ready();
    const first = harness.connection.call("doc.inspect", null);
    harness.current().deliver({ kind: "reply", id: 1, result: { width: 8 } });
    await first;
    const oldSocket = harness.current();
    expect(oldSocket.sentFrames.length).toBe(2);

    const reconnecting = harness.connection.reconnect();
    await drain(10);
    expect(harness.sockets.length).toBe(2);
    expect(oldSocket.closeCount).toBe(1);
    const newSocket = harness.current();
    expect(newSocket.sentFrames[0]).toEqual({
      kind: "auth",
      id: AUTH_FRAME_ID,
      token: TEST_TOKEN,
    }); // first frame on the NEW connection is auth again (§Methods)
    newSocket.deliver(AUTH_OK_REPLY);
    await reconnecting;
    expect(harness.connection.connectionState).toBe("ready");

    const second = harness.connection.call("doc.inspect", null);
    expect(newSocket.sentFrames[1]).toEqual({
      kind: "request",
      id: 2,
      method: "doc.inspect",
      params: null,
    });
    newSocket.deliver({ kind: "reply", id: 2, result: { width: 8 } });
    await second;
  });

  it("settles an in-flight call as connection_dropped_mid_call before reconnecting", async () => {
    const harness = await ready();
    const call = harness.connection.call("engine.execute", { command: "layer.new.layer" });
    const reconnecting = harness.connection.reconnect();
    await expectTransportError(call, "connection_dropped_mid_call");
    await drain(10);
    harness.current().deliver(AUTH_OK_REPLY);
    await reconnecting;
    expect(harness.connection.connectionState).toBe("ready");
  });

  it("a dropped connection reconnects and authenticates again", async () => {
    const harness = await ready();
    const call = harness.connection.call("doc.inspect", null);
    harness.current().failWith(connectionDroppedMidCall("ECONNRESET"));
    await expectTransportError(call, "connection_dropped_mid_call");
    expect(harness.connection.connectionState).toBe("dropped");

    const reconnecting = harness.connection.reconnect();
    await drain(10);
    harness.current().deliver(AUTH_OK_REPLY);
    await reconnecting;
    expect(harness.connection.connectionState).toBe("ready");
  });
});

describe("close()", () => {
  it("drops in-flight calls and moves to dropped", async () => {
    const harness = await ready();
    const call = harness.connection.call("doc.render", null);
    const closing = harness.connection.close();
    await expectTransportError(call, "connection_dropped_mid_call");
    await closing;
    expect(harness.connection.connectionState).toBe("dropped");
    expect(harness.current().closeCount).toBe(1);
    await expectTransportError(harness.connection.call("doc.inspect", null), "connection_refused");
  });
});

describe("ConnectionBudget — 16 connections per listener (§Transport limits)", () => {
  it("tracks the documented cap", () => {
    expect(MAX_CONNECTIONS_PER_LISTENER).toBe(16);
    const budget = new ConnectionBudget();
    for (let i = 0; i < 16; i += 1) {
      expect(budget.tryAcquire("engine-1")).toBe(true);
    }
    expect(budget.tryAcquire("engine-1")).toBe(false); // the 17th is refused client-side
    expect(budget.inUse("engine-1")).toBe(16);
    budget.release("engine-1");
    expect(budget.tryAcquire("engine-1")).toBe(true);
  });

  it("keys are independent per listener", () => {
    const budget = new ConnectionBudget(1);
    expect(budget.tryAcquire("127.0.0.1:7878")).toBe(true);
    expect(budget.tryAcquire("127.0.0.1:7879")).toBe(true);
    expect(budget.tryAcquire("127.0.0.1:7878")).toBe(false);
  });

  it("a connection consumes a slot and releases it on drop", async () => {
    const budget = new ConnectionBudget(1);
    const harness = await ready({ budget, budgetKey: "engine-1" });
    expect(budget.inUse("engine-1")).toBe(1);

    const second = makeConnection({ budget, budgetKey: "engine-1" });
    const error = await expectTransportError(second.connection.connect(), "connection_refused");
    expect(error.message).toContain("connection cap");

    harness.current().drop(); // the app closes an idle connection (§MCP bridge)
    expect(budget.inUse("engine-1")).toBe(0);
    await expectTransportError(harness.connection.call("doc.inspect", null), "connection_refused");

    const third = makeConnection({ budget, budgetKey: "engine-1" });
    const thirdConnecting = third.connection.connect();
    await drain(10);
    third.current().deliver(AUTH_OK_REPLY);
    await thirdConnecting;
    expect(budget.inUse("engine-1")).toBe(1);
  });

  it("releases the slot when authentication is rejected", async () => {
    const budget = new ConnectionBudget(1);
    const harness = makeConnection({ budget, budgetKey: "engine-1" });
    const connecting = harness.connection.connect();
    await drain(10);
    harness.current().deliver({
      kind: "error",
      id: AUTH_FRAME_ID,
      error: "authentication required",
    });
    await expectTransportError(connecting, "auth_rejected");
    expect(budget.inUse("engine-1")).toBe(0);
  });
});

describe("idle seam (§MCP bridge: the app closes idle connections after 30 s)", () => {
  it("the connection itself has no idle timer — the client layer owns that policy", async () => {
    const harness = await ready();
    harness.clock.advance(60_000); // nothing fires: no leaked timers after a settle
    expect(harness.clock.timerCount).toBe(0);
    const call = harness.connection.call("doc.inspect", null);
    harness.current().deliver({ kind: "reply", id: 1, result: null });
    await expect(call).resolves.toEqual({ ok: true, result: null });
  });
});
