// NodeNetSocket tests — framing over a fake low-level stream; NO real sockets.
// Covers: line splitting (incl. UTF-8 split across chunks), the 8 MiB reply ceiling,
// loopback enforcement, error/close propagation, backpressure, the stdio stub.

import { describe, expect, it } from "vitest";

import {
  TransportError,
  connectionDroppedMidCall,
  isTransportError,
  protocolViolation,
} from "./errors.js";
import type { FramedMessage } from "./frame.js";
import { MAX_REPLY_BYTES, buildAuthFrame } from "./frame.js";
import { type LowLevelConnectOptions, NodeNetSocket, StdioTransport } from "./socket.js";
import type { LowLevelSocketFactory } from "./socket.js";
import { FakeClock, FakeLowLevelSocket, TEST_TOKEN } from "./testing.js";

const LOOPBACK: ReadonlyArray<readonly [string, boolean]> = [
  ["127.0.0.1", true],
  ["127.255.0.3", true], // loopback is the whole /8, as the vendor bridge checks
  ["localhost", true],
  ["::1", true],
  ["::ffff:127.0.0.1", true],
  ["192.168.1.4", false],
  ["10.0.0.5", false],
  ["0.0.0.0", false],
  ["example.com", false],
];

/** Pure UTF-8 encoder (hermetic: no TextEncoder/Buffer globals in this package's types). */
function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

const bytes = (text: string): Uint8Array => utf8(text);

function makeSocket(fake: FakeLowLevelSocket, host = "127.0.0.1") {
  let seenOptions: LowLevelConnectOptions | null = null;
  const factory: LowLevelSocketFactory = async (_endpoint, options) => {
    seenOptions = options;
    return fake;
  };
  const socket = new NodeNetSocket({
    endpoint: { host, port: 7878 },
    clock: new FakeClock(),
    socketFactory: factory,
  });
  return { socket, fake, factoryOptions: () => seenOptions };
}

function captureErrors(socket: NodeNetSocket): TransportError[] {
  const errors: TransportError[] = [];
  socket.onError((error) => errors.push(error));
  return errors;
}

function captureFrames(socket: NodeNetSocket): FramedMessage[] {
  const frames: FramedMessage[] = [];
  socket.onFrame((frame) => frames.push(frame));
  return frames;
}

function captureCloses(socket: NodeNetSocket): boolean[] {
  const closes: boolean[] = [];
  socket.onClose((hadError) => closes.push(hadError));
  return closes;
}

async function connectedSocket(host = "127.0.0.1") {
  const made = makeSocket(new FakeLowLevelSocket(), host);
  await made.socket.connect();
  return made;
}

describe("connect()", () => {
  it("opens and reports the factory's clock + timeout contract", async () => {
    const { socket, factoryOptions } = makeSocket(new FakeLowLevelSocket());
    await socket.connect();
    expect(socket.isOpen()).toBe(true);
    expect(factoryOptions()?.connectTimeoutMs).toBe(30_000); // SERVER_IO_TIMEOUT_MS default
    expect(factoryOptions()?.clock).toBeInstanceOf(FakeClock);
  });

  it("refuses a second connect()", async () => {
    const { socket } = await connectedSocket();
    await expect(socket.connect()).rejects.toMatchObject({ code: "protocol_violation" });
  });

  it.each(LOOPBACK)("host %s → allowed=%s", async (host, allowed) => {
    if (allowed) {
      await expect(connectedSocket(host)).resolves.toBeTruthy();
    } else {
      // doc §MCP bridge: unencrypted protocol must remain on loopback.
      await expect(connectedSocket(host)).rejects.toMatchObject({ code: "protocol_violation" });
    }
  });

  it("passes a TransportError from the factory through unchanged", async () => {
    const refused = new TransportError("connection_refused", "connection refused");
    const socket = new NodeNetSocket({
      endpoint: { host: "127.0.0.1", port: 1 },
      clock: new FakeClock(),
      socketFactory: async () => {
        throw refused;
      },
    });
    await expect(socket.connect()).rejects.toBe(refused);
  });

  it("wraps a plain node-style ECONNREFUSED as connection_refused", async () => {
    const socket = new NodeNetSocket({
      endpoint: { host: "127.0.0.1", port: 1 },
      clock: new FakeClock(),
      socketFactory: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
          code: "ECONNREFUSED",
        });
      },
    });
    const error = await socket.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isTransportError(error)).toBe(true);
    expect((error as TransportError).code).toBe("connection_refused");
    expect((error as TransportError).message).toContain("ECONNREFUSED");
  });
});

describe("send()", () => {
  it("writes the encoded frame as one newline-terminated line", async () => {
    const { socket, fake } = await connectedSocket();
    await socket.send(buildAuthFrame(TEST_TOKEN));
    expect(fake.written).toEqual([
      `{"id":"auth","method":"auth","params":{"token":"${TEST_TOKEN}"}}\n`,
    ]);
  });

  it("resolves even under backpressure (write returns false)", async () => {
    const { socket, fake } = await connectedSocket();
    fake.writeReturns = false;
    await socket.send({ kind: "request", id: 1, method: "doc.inspect", params: null });
    expect(fake.written.length).toBe(1);
  });

  it("rejects with protocol_violation before the socket is open", async () => {
    const { socket } = makeSocket(new FakeLowLevelSocket());
    await expect(
      socket.send({ kind: "request", id: 1, method: "doc.inspect", params: null }),
    ).rejects.toMatchObject({ code: "protocol_violation" });
  });

  it("rejects a >1 MiB request line BEFORE writing (§Transport limits)", async () => {
    const { socket, fake } = await connectedSocket();
    await expect(
      socket.send({
        kind: "request",
        id: 1,
        method: "doc.render",
        params: { blob: "x".repeat(1 << 20) },
      }),
    ).rejects.toMatchObject({ code: "frame_too_large" });
    expect(fake.written.length).toBe(0); // nothing went on the wire
  });
});

describe("frame decoding from byte chunks", () => {
  it("delivers one frame for one line", async () => {
    const { socket, fake } = await connectedSocket();
    const frames = captureFrames(socket);
    fake.receive(bytes('{"id":1,"ok":true,"result":{"authenticated":true}}\n'));
    expect(frames).toEqual([{ kind: "reply", id: 1, result: { authenticated: true } }]);
  });

  it("delivers two frames when one chunk carries two lines", async () => {
    const { socket, fake } = await connectedSocket();
    const frames = captureFrames(socket);
    fake.receive(bytes('{"id":1,"ok":true,"result":1}\n{"id":2,"ok":false,"error":"x"}\n'));
    expect(frames.map((f) => f.kind)).toEqual(["reply", "error"]);
  });

  it("reassembles a line split across chunks", async () => {
    const { socket, fake } = await connectedSocket();
    const frames = captureFrames(socket);
    const line = bytes('{"id":1,"ok":true,"result":"hello"}\n');
    fake.receive(line.subarray(0, 10));
    fake.receive(line.subarray(10));
    expect(frames).toEqual([{ kind: "reply", id: 1, result: "hello" }]);
  });

  it("survives a multi-byte UTF-8 character split across chunks", async () => {
    const { socket, fake } = await connectedSocket();
    const frames = captureFrames(socket);
    const line = bytes('{"id":1,"ok":true,"result":"é"}\n');
    const split = line.indexOf(0xc3); // first byte of the 2-byte é
    fake.receive(line.subarray(0, split));
    fake.receive(line.subarray(split));
    expect(frames).toEqual([{ kind: "reply", id: 1, result: "é" }]);
  });

  it("keeps a trailing partial line buffered until its newline arrives", async () => {
    const { socket, fake } = await connectedSocket();
    const frames = captureFrames(socket);
    fake.receive(bytes('{"id":1,"ok":true,"result":1}\n{"id":2,"ok":tr'));
    expect(frames.length).toBe(1);
    fake.receive(bytes('ue,"result":2}\n'));
    expect(frames.map((f) => f.kind)).toEqual(["reply", "reply"]);
  });

  it("ignores blank lines (rpc.rs serve_lines skips them)", async () => {
    const { socket, fake } = await connectedSocket();
    const frames = captureFrames(socket);
    const errors = captureErrors(socket);
    fake.receive(bytes("\n\n   \n"));
    fake.receive(bytes('{"id":1,"ok":true,"result":1}\n'));
    expect(frames.length).toBe(1);
    expect(errors.length).toBe(0);
  });

  it("flags a non-JSON line as protocol_violation and destroys", async () => {
    const { socket, fake } = await connectedSocket();
    const errors = captureErrors(socket);
    const closes = captureCloses(socket);
    fake.receive(bytes("this is not JSON\n"));
    expect(errors.map((e) => e.code)).toEqual(["protocol_violation"]);
    expect(fake.isDestroyed()).toBe(true);
    expect(socket.isOpen()).toBe(false);
    expect(closes).toEqual([true]);
  });
});

describe("reply byte ceiling (§Transport limits: 8 MiB incl. newline)", () => {
  it("fails and destroys when a lineless chunk grows past the ceiling", async () => {
    const { socket, fake } = await connectedSocket();
    const errors = captureErrors(socket);
    fake.receive(new Uint8Array(MAX_REPLY_BYTES + 1)); // no newline yet
    expect(errors.map((e) => e.code)).toEqual(["frame_too_large"]);
    expect(errors[0]?.mayHaveCompleted).toBe(true); // the request may have run
    expect(fake.isDestroyed()).toBe(true);
  });

  it("fails when a single oversized complete line arrives", async () => {
    const { socket, fake } = await connectedSocket();
    const errors = captureErrors(socket);
    const line = new Uint8Array(MAX_REPLY_BYTES + 2);
    line[line.byteLength - 1] = 10; // trailing newline
    fake.receive(line);
    expect(errors.map((e) => e.code)).toEqual(["frame_too_large"]);
    expect(fake.isDestroyed()).toBe(true);
  });

  it("accepts a reply line exactly at the ceiling", async () => {
    const { socket, fake } = await connectedSocket();
    const frames = captureFrames(socket);
    const errors = captureErrors(socket);
    const prefix = '{"id":1,"ok":true,"result":"';
    const suffix = '"}\n';
    const exact = `${prefix}${"x".repeat(MAX_REPLY_BYTES - prefix.length - suffix.length)}${suffix}`;
    expect(exact.length).toBe(MAX_REPLY_BYTES); // includes the newline (§Transport limits)
    fake.receive(bytes(exact));
    expect(frames.length).toBe(1);
    expect(errors.length).toBe(0);
  });
});

describe("stream errors and close", () => {
  it("maps a stream error to connection_dropped_mid_call then close(hadError=true)", async () => {
    const { socket, fake } = await connectedSocket();
    const errors = captureErrors(socket);
    const closes = captureCloses(socket);
    fake.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    expect(errors.map((e) => e.code)).toEqual(["connection_dropped_mid_call"]);
    expect(errors[0]?.mayHaveCompleted).toBe(true);
    expect(closes).toEqual([true]);
    expect(socket.isOpen()).toBe(false);
  });

  it("surfaces a clean close without an error event", async () => {
    const { socket, fake } = await connectedSocket();
    const errors = captureErrors(socket);
    const closes = captureCloses(socket);
    fake.emit("close", false);
    expect(errors.length).toBe(0);
    expect(closes).toEqual([false]);
  });

  it("write callback failures surface as connection_dropped_mid_call", async () => {
    const socket = new NodeNetSocket({
      endpoint: { host: "127.0.0.1", port: 7878 },
      clock: new FakeClock(),
      socketFactory: async () => ({
        write(_chunk: string | Uint8Array, callback?: (error?: unknown) => void): boolean {
          callback?.(new Error("write EPIPE"));
          return true;
        },
        destroy(): void {},
        on(_event: string, _listener: (...args: unknown[]) => void): unknown {
          return undefined;
        },
      }),
    });
    await socket.connect();
    await expect(
      socket.send({ kind: "request", id: 1, method: "doc.inspect", params: null }),
    ).rejects.toMatchObject({ code: "connection_dropped_mid_call" });
  });

  it("close() is idempotent and delivers onClose exactly once", async () => {
    const { socket, fake } = await connectedSocket();
    const closes = captureCloses(socket);
    await socket.close();
    await socket.close();
    expect(closes).toEqual([false]);
    expect(fake.destroyedCount).toBe(1);
    expect(socket.isOpen()).toBe(false);
  });
});

describe("StdioTransport stub (§Headless server: stdio needs no auth handshake)", () => {
  it("fails loudly on every operation until implemented", () => {
    const transport = new StdioTransport();
    const operations: Array<() => unknown> = [
      () => transport.connect(),
      () => transport.send({ kind: "request", id: 1, method: "x", params: null }),
      () => transport.onFrame(() => undefined),
      () => transport.onError(() => undefined),
      () => transport.onClose(() => undefined),
      () => transport.close(),
    ];
    for (const operation of operations) {
      let caught: unknown;
      try {
        operation();
      } catch (error) {
        caught = error;
      }
      expect(isTransportError(caught)).toBe(true);
      expect((caught as TransportError).code).toBe("protocol_violation");
      expect((caught as TransportError).message).toContain("not implemented");
    }
    expect(transport.isOpen()).toBe(false);
  });
});

describe("connection_dropped_mid_call error factory (doc-mandated semantics)", () => {
  it("carries may-have-completed wording and defaults", () => {
    const error = connectionDroppedMidCall("boom");
    expect(error.mayHaveCompleted).toBe(true);
    expect(error.hint).toContain("may have completed");
    expect(error.hint).toContain("never automatically resent");
  });

  it("protocol_violation defaults never claim completion", () => {
    const error = protocolViolation("nope");
    expect(error.mayHaveCompleted).toBe(false);
  });
});
