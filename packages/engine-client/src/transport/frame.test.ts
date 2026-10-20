// Framing tests — byte-exact against the pinned protocol doc and rpc.rs.
// Pure table-driven logic; no sockets, no timers (AGENTS.md).

import { describe, expect, it } from "vitest";

import {
  AUTH_DEADLINE_MS,
  AUTH_FRAME_ID,
  AUTH_METHOD,
  buildAuthFrame,
  decodeFrame,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_IDLE_RECONNECT_MS,
  encodeFrame,
  isNotificationFrame,
  isValidControlToken,
  matchReplyId,
  MAX_BATCH_STEPS,
  MAX_CONNECTIONS_PER_LISTENER,
  MAX_REPLY_BYTES,
  MAX_REQUEST_BYTES,
  SERVER_IO_TIMEOUT_MS,
  SERVER_REPLY_DEADLINE_MS,
  utf8ByteLength,
  type FramedMessage,
} from "./frame.js";
import { isTransportError } from "./errors.js";
import { TEST_TOKEN, TEST_TOKEN_UPPER } from "./testing.js";

function expectTransportError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isTransportError(caught)) {
    throw new Error(`expected a TransportError with code ${code}, got ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
}

describe("wire constants match the doc (§Transport limits, security.rs)", () => {
  it("caps and deadlines are the documented values", () => {
    expect(MAX_REQUEST_BYTES).toBe(1 << 20); // 1 MiB request line
    expect(MAX_REPLY_BYTES).toBe(8 << 20); // 8 MiB reply, incl. the newline
    expect(MAX_CONNECTIONS_PER_LISTENER).toBe(16);
    expect(MAX_BATCH_STEPS).toBe(256);
    expect(SERVER_IO_TIMEOUT_MS).toBe(30_000);
    expect(AUTH_DEADLINE_MS).toBe(10_000);
    expect(SERVER_REPLY_DEADLINE_MS).toBe(60_000);
  });

  it("client call timeout is strictly below the server's 60 s reply deadline", () => {
    // doc §MCP bridge: "The client's call timeout is 55s, strictly below the server's 60s
    // reply deadline, so the bridge's error is the one callers see."
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(55_000);
    expect(DEFAULT_CALL_TIMEOUT_MS).toBeLessThan(SERVER_REPLY_DEADLINE_MS);
  });

  it("idle-reconnect threshold stays below the 30 s idle cutoff", () => {
    // bridge.rs: IDLE_RECONNECT = IO_TIMEOUT − 5 s
    expect(DEFAULT_IDLE_RECONNECT_MS).toBe(SERVER_IO_TIMEOUT_MS - 5_000);
    expect(DEFAULT_IDLE_RECONNECT_MS).toBeLessThan(SERVER_IO_TIMEOUT_MS);
  });
});

describe("token shape (security.rs validate_token)", () => {
  it.each([
    ["the rpc.rs test token", TEST_TOKEN],
    ["uppercase hex matches either case", TEST_TOKEN_UPPER],
  ])("accepts %s", (_name, token) => {
    expect(isValidControlToken(token)).toBe(true);
    const frame = buildAuthFrame(token);
    expect(frame.kind).toBe("auth");
    expect(frame.id).toBe(AUTH_FRAME_ID);
  });

  it.each([
    ["63 hex chars", TEST_TOKEN.slice(0, 63)],
    ["65 hex chars", `${TEST_TOKEN}0`],
    ["non-hex 64 chars", "z".repeat(64)],
    ["empty", ""],
    ["binary junk", "\u0000".repeat(64)],
  ])("rejects %s", (_name, token) => {
    expect(isValidControlToken(token)).toBe(false);
    expectTransportError(() => buildAuthFrame(token), "protocol_violation");
  });
});

describe("encodeFrame — byte-exact wire lines", () => {
  it("auth frame matches the doc §Methods example exactly", () => {
    const line = encodeFrame(buildAuthFrame(TEST_TOKEN));
    expect(line).toBe(
      `{"id":"${AUTH_FRAME_ID}","method":"${AUTH_METHOD}","params":{"token":"${TEST_TOKEN}"}}\n`,
    );
  });

  it("request frames match the doc examples (params object, omitted, null)", () => {
    expect(encodeFrame({ kind: "request", id: 1, method: "ui.inspect", params: {} })).toBe(
      '{"id":1,"method":"ui.inspect","params":{}}\n',
    );
    expect(encodeFrame({ kind: "request", id: 2, method: "doc.inspect", params: null })).toBe(
      '{"id":2,"method":"doc.inspect"}\n',
    );
    expect(
      encodeFrame({ kind: "request", id: 3, method: "engine.execute", params: { command: "filter.blur.gaussianBlur", params: { radius: 3 } } }),
    ).toBe(
      '{"id":3,"method":"engine.execute","params":{"command":"filter.blur.gaussianBlur","params":{"radius":3}}}\n',
    );
  });

  it("reply and error frames match rpc.rs json! literals", () => {
    expect(encodeFrame({ kind: "reply", id: 1, result: { authenticated: true } })).toBe(
      '{"id":1,"ok":true,"result":{"authenticated":true}}\n',
    );
    expect(encodeFrame({ kind: "error", id: 2, error: "unknown tool `foo`" })).toBe(
      '{"id":2,"ok":false,"error":"unknown tool `foo`"}\n',
    );
    // rpc.rs oversized-line reply: id null, pre-dispatch rejection.
    expect(
      encodeFrame({ kind: "error", id: null, error: `request exceeds ${MAX_REQUEST_BYTES} bytes` }),
    ).toBe(`{"id":null,"ok":false,"error":"request exceeds ${MAX_REQUEST_BYTES} bytes"}\n`);
  });

  it("notifications carry no id (JSON-RPC shape; the engine never sends one)", () => {
    expect(encodeFrame({ kind: "notification", method: "jobs.progress", params: null })).toBe(
      '{"method":"jobs.progress"}\n',
    );
    expect(isNotificationFrame({ kind: "notification", method: "x", params: null })).toBe(true);
  });

  it("refuses a null id on outgoing requests and auth frames", () => {
    expectTransportError(
      () => encodeFrame({ kind: "request", id: null, method: "doc.inspect", params: null }),
      "protocol_violation",
    );
    expectTransportError(
      () => encodeFrame({ kind: "auth", id: null, token: TEST_TOKEN }),
      "protocol_violation",
    );
  });
});

describe("encodeFrame — byte ceilings (§Transport limits)", () => {
  it("rejects a request line over 1 MiB before anything is written", () => {
    expectTransportError(
      () =>
        encodeFrame({
          kind: "request",
          id: 1,
          method: "doc.render",
          params: { blob: "x".repeat(MAX_REQUEST_BYTES) },
        }),
      "frame_too_large",
    );
  });

  it("rejects a reply line over 8 MiB (including the newline)", () => {
    expectTransportError(
      () =>
        encodeFrame({
          kind: "reply",
          id: 1,
          result: "y".repeat(MAX_REPLY_BYTES),
        }),
      "frame_too_large",
    );
  });

  it("accepts a reply exactly at the 8 MiB ceiling and rejects one byte over", () => {
    const overhead = utf8ByteLength('{"id":1,"ok":true,"result":""}\n'); // 31
    const atCeiling = encodeFrame({
      kind: "reply",
      id: 1,
      result: "x".repeat(MAX_REPLY_BYTES - overhead),
    });
    expect(utf8ByteLength(atCeiling)).toBe(MAX_REPLY_BYTES); // the newline is inside the cap
    expectTransportError(
      () =>
        encodeFrame({
          kind: "reply",
          id: 1,
          result: "x".repeat(MAX_REPLY_BYTES - overhead + 1),
        }),
      "frame_too_large",
    );
  });
});

describe("utf8ByteLength (pure)", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["€", 3],
    ["😀", 4], // surrogate pair = one code point = 4 UTF-8 bytes
    ["aéb😀", 8],
  ])("%s → %d bytes", (input, expected) => {
    expect(utf8ByteLength(input)).toBe(expected);
  });
});

describe("decodeFrame — doc- and rpc.rs-derived lines", () => {
  it.each([
    ["auth request line", `{"id":"auth","method":"auth","params":{"token":"${TEST_TOKEN}"}}`, "auth"],
    ["request without params", '{"id":1,"method":"doc.inspect"}', "request"],
    ["request with null params", '{"id":1,"method":"doc.inspect","params":null}', "request"],
    ["success reply", '{"id":1,"ok":true,"result":{"authenticated":true}}', "reply"],
    ["bare-array success reply", '{"id":3,"ok":true,"result":[1,2]}', "reply"],
    ["null-result reply", '{"id":4,"ok":true,"result":null}', "reply"],
    ["error reply", '{"id":2,"ok":false,"error":"unknown tool `foo`"}', "error"],
    ["id:null pre-dispatch error", '{"id":null,"ok":false,"error":"request is not valid UTF-8"}', "error"],
    ["already-authenticated error", '{"id":"auth","ok":false,"error":"already authenticated"}', "error"],
    ["notification-shaped line", '{"method":"server.hi","params":{}}', "notification"],
  ])("decodes %s", (_name, line, expectedKind) => {
    const frame = decodeFrame(line);
    expect(frame.kind).toBe(expectedKind);
  });

  it("round-trips every frame kind", () => {
    const frames: FramedMessage[] = [
      buildAuthFrame(TEST_TOKEN),
      { kind: "request", id: 1, method: "engine.commands", params: null },
      { kind: "request", id: 2, method: "engine.execute", params: { command: "doc.inspect" } },
      { kind: "reply", id: 1, result: [{ name: "brush" }] },
      { kind: "error", id: 2, error: "timeout: not run" },
      { kind: "error", id: null, error: "request exceeds 1048576 bytes" },
      { kind: "notification", method: "m", params: { a: 1 } },
    ];
    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("tolerates a trailing newline (lines delivered with their terminator)", () => {
    expect(decodeFrame('{"id":7,"ok":true,"result":1}\n')).toEqual({
      kind: "reply",
      id: 7,
      result: 1,
    });
  });

  it.each([
    ["not JSON", "oops"],
    ["a bare number", "42"],
    ["a bare string", '"hi"'],
    ["an array", "[1,2]"],
    ["no method, no ok", '{"id":1}'],
    ["ok:true without result", '{"id":1,"ok":true}'],
    ["ok:false without error", '{"id":1,"ok":false}'],
    ["ok with a non-string error", '{"id":1,"ok":false,"error":5}'],
    ["method is not a string", '{"id":1,"method":5}'],
  ])("rejects %s with protocol_violation", (_name, line) => {
    expectTransportError(() => decodeFrame(line), "protocol_violation");
  });

  it("rejects a line over the 8 MiB reply ceiling with frame_too_large", () => {
    expectTransportError(() => decodeFrame(`{"id":1,"ok":true,"result":"${"z".repeat(MAX_REPLY_BYTES)}"}`), "frame_too_large");
  });
});

describe("matchReplyId — ids are typed on the wire", () => {
  it("matches replies and errors by strict equality only", () => {
    expect(matchReplyId({ kind: "reply", id: 1, result: null }, 1)).toBe(true);
    expect(matchReplyId({ kind: "error", id: 1, error: "x" }, 1)).toBe(true);
    expect(matchReplyId({ kind: "reply", id: "1", result: null }, 1)).toBe(false);
    expect(matchReplyId({ kind: "reply", id: 1, result: null }, "1")).toBe(false);
    expect(matchReplyId({ kind: "reply", id: 2, result: null }, 1)).toBe(false);
    expect(matchReplyId({ kind: "reply", id: null, result: null }, 1)).toBe(false);
    expect(matchReplyId(buildAuthFrame(TEST_TOKEN), AUTH_FRAME_ID)).toBe(false);
    expect(matchReplyId({ kind: "request", id: 1, method: "x", params: null }, 1)).toBe(false);
  });
});
