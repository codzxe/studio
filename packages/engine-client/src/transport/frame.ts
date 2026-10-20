// @studio/engine-client — pure control-protocol framing (newline-delimited JSON lines).
// Owner: W2-A (src/transport/** only).
//
// Protocol truth (pinned vendor revision, read-only):
//   - docs/control-protocol.md §Methods: the first request on EVERY TCP connection must be
//     {"id":"auth","method":"auth","params":{"token":"<64 hexadecimal characters>"}}; no
//     other method is dispatched before it succeeds. A later `auth` frame gets
//     {"ok":false,"error":"already authenticated"} and the connection keeps serving.
//   - After auth, each request is one JSON line {"id":…,"method":…,"params":…}; each reply is
//     one JSON line with the same id: {"id":…,"ok":true,"result":…} | {"id":…,"ok":false,
//     "error":"…"}. rpc.rs writes id:null into pre-dispatch error replies (oversized or
//     non-UTF-8 request lines).
//   - §Transport limits: 1 MiB maximum encoded request line; 8 MiB maximum encoded JSON
//     reply including the newline; 16 simultaneous connections per listener; 30 s socket
//     read/write timeout; 256 batch steps.
//   - crates/automation/src/rpc.rs (envelope, `serve_lines`) and security.rs (constants,
//     token shape) — verified against the pinned revision.
//
// The wire is NOT byte-count/length-field framed: the only "length prefix" is the bounded
// line length above. Frames are one UTF-8 JSON object per "\n"-terminated line. This module
// is pure: no I/O, no globals, no clock.

import { z } from "zod";

import { frameTooLarge, protocolViolation } from "./errors.js";

// ---------------------------------------------------------------------------
// Wire constants (§Transport limits + security.rs; keep in lockstep with the pinned engine).
// ---------------------------------------------------------------------------

/** Method name of the mandatory first frame on every TCP connection (doc §Methods). */
export const AUTH_METHOD = "auth";

/** The id the doc's auth example uses; the auth reply echoes it. */
export const AUTH_FRAME_ID = "auth";

/** Maximum encoded request line, including its newline: 1 MiB (security.rs MAX_REQUEST_BYTES). */
export const MAX_REQUEST_BYTES = 1 << 20;

/** Maximum encoded JSON reply, including the newline: 8 MiB (§Transport limits). */
export const MAX_REPLY_BYTES = 8 << 20;

/** Maximum simultaneously serviced connections per listener (§Transport limits). */
export const MAX_CONNECTIONS_PER_LISTENER = 16;

/** Maximum steps in one headless `batch` / MCP `command_batch` request (§Transport limits). */
export const MAX_BATCH_STEPS = 256;

/** Idle/read+write timeout the engine enforces on loopback TCP (security.rs IO_TIMEOUT). */
export const SERVER_IO_TIMEOUT_MS = 30_000;

/**
 * A new TCP connection must complete `auth` within this window, however much it sends
 * meanwhile (security.rs AUTH_DEADLINE; the engine closes at the deadline, #4965).
 */
export const AUTH_DEADLINE_MS = 10_000;

/** Server reply deadline for a dispatched request (doc §Methods: "waits up to 60 seconds"). */
export const SERVER_REPLY_DEADLINE_MS = 60_000;

/**
 * Client call timeout, STRICTLY below the engine's 60 s reply deadline, "so the bridge's
 * error is the one callers see" (doc §MCP bridge; bridge.rs DEFAULT_CALL_TIMEOUT = 55 s).
 * Compile-time guard below keeps the invariant.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 55_000;

/**
 * Reconnect before a send once a cached connection has been idle this long: the app closes
 * idle control connections after SERVER_IO_TIMEOUT_MS, and reconnecting at 25 s keeps the
 * request off a socket the app may have dropped (doc §MCP bridge; bridge.rs IDLE_RECONNECT
 * = IO_TIMEOUT − 5 s). The client layer owns the policy; this constant is the reference.
 */
export const DEFAULT_IDLE_RECONNECT_MS = SERVER_IO_TIMEOUT_MS - 5_000;

/** True while the client call timeout stays strictly below the engine's reply deadline
 *  (doc §MCP bridge). frame.test.ts asserts it; drift fails CI before it ships. */
export const CALL_TIMEOUT_BELOW_SERVER_DEADLINE: boolean =
  DEFAULT_CALL_TIMEOUT_MS < SERVER_REPLY_DEADLINE_MS;

// ---------------------------------------------------------------------------
// JSON value types + Zod schemas (AGENTS.md: Zod at every boundary; the wire is one).
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Request/reply correlation id. Numbers are used for requests (1, 2, …); replies echo the
 * request id verbatim, and pre-dispatch error replies carry id:null (rpc.rs).
 */
export type RequestId = string | number | null;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const paramsSchema = z.record(z.string(), jsonValueSchema);
const idSchema = z.union([z.string(), z.number(), z.null()]);

// ---------------------------------------------------------------------------
// FramedMessage — the auth-first-frame rule captured as a discriminated union.
// ---------------------------------------------------------------------------

/** The mandatory first frame on every TCP connection (doc §Methods). */
export interface AuthFrame {
  readonly kind: "auth";
  readonly id: RequestId;
  /** 64 hexadecimal characters (security.rs validate_token). */
  readonly token: string;
}

export interface RequestFrame {
  readonly kind: "request";
  readonly id: RequestId;
  readonly method: string;
  /** Params must be a JSON object; omit or null for none (doc §Methods, engine.execute). */
  readonly params?: JsonObject | null;
}

export interface ReplyFrame {
  readonly kind: "reply";
  readonly id: RequestId;
  readonly result: JsonValue;
}

export interface ErrorFrame {
  readonly kind: "error";
  readonly id: RequestId;
  readonly error: string;
}

/**
 * Server-initiated notification (JSON-RPC style, no id). The pinned engine NEVER sends
 * one — replies are the only server→client frames — but the union keeps unknown method-
 * bearing lines typed instead of silently dropped. The connection skips them like any
 * other frame whose id does not match the outstanding request.
 */
export interface NotificationFrame {
  readonly kind: "notification";
  readonly method: string;
  readonly params?: JsonObject | null;
}

export type FramedMessage = AuthFrame | RequestFrame | ReplyFrame | ErrorFrame | NotificationFrame;

const authLineSchema = z
  .object({
    id: idSchema,
    method: z.literal(AUTH_METHOD),
    params: z.object({ token: z.string() }).optional(),
  })
  .transform((v): AuthFrame => ({ kind: "auth", id: v.id, token: v.params?.token ?? "" }));

const requestLineSchema = z
  .object({
    id: idSchema,
    method: z.string(),
    params: paramsSchema.nullish(),
  })
  .transform((v): RequestFrame => ({
    kind: "request",
    id: v.id,
    method: v.method,
    params: v.params ?? null,
  }));

const replyLineSchema = z
  .object({ id: idSchema, ok: z.literal(true), result: jsonValueSchema })
  .transform((v): ReplyFrame => ({ kind: "reply", id: v.id, result: v.result }));

const errorLineSchema = z
  .object({ id: idSchema, ok: z.literal(false), error: z.string() })
  .transform((v): ErrorFrame => ({ kind: "error", id: v.id, error: v.error }));

const notificationLineSchema = z
  .object({ method: z.string(), params: paramsSchema.nullish() })
  .transform((v): NotificationFrame => ({
    kind: "notification",
    method: v.method,
    params: v.params ?? null,
  }));

// ---------------------------------------------------------------------------
// Guards + helpers.
// ---------------------------------------------------------------------------

export function isAuthFrame(frame: FramedMessage): frame is AuthFrame {
  return frame.kind === "auth";
}

export function isRequestFrame(frame: FramedMessage): frame is RequestFrame {
  return frame.kind === "request";
}

export function isReplyFrame(frame: FramedMessage): frame is ReplyFrame {
  return frame.kind === "reply";
}

export function isErrorFrame(frame: FramedMessage): frame is ErrorFrame {
  return frame.kind === "error";
}

export function isNotificationFrame(frame: FramedMessage): frame is NotificationFrame {
  return frame.kind === "notification";
}

/**
 * True when `frame` is a reply or error whose id equals `id` under strict typing. Ids are
 * typed on the wire: the number 1 and the string "1" do NOT match. The doc (§MCP bridge):
 * "reply lines whose `id` does not match the request are skipped".
 */
export function matchReplyId(frame: FramedMessage, id: RequestId): boolean {
  return (frame.kind === "reply" || frame.kind === "error") && frame.id === id;
}

// ---------------------------------------------------------------------------
// Token shape (security.rs validate_token: exactly 64 hex characters, either case).
// ---------------------------------------------------------------------------

const HEX_DIGITS = /^[0-9a-fA-F]+$/;
export const CONTROL_TOKEN_HEX_LENGTH = 64;

export function isValidControlToken(token: string): boolean {
  return token.length === CONTROL_TOKEN_HEX_LENGTH && HEX_DIGITS.test(token);
}

/** Builds the mandatory first frame; validates the token shape fail-fast. */
export function buildAuthFrame(token: string): AuthFrame {
  if (!isValidControlToken(token)) {
    throw protocolViolation(
      `control token must contain exactly ${CONTROL_TOKEN_HEX_LENGTH} hexadecimal characters`,
      {
        hint: "Load the token through the auth module (token file, never a CLI argument); the engine rejects any other shape.",
      },
    );
  }
  return { kind: "auth", id: AUTH_FRAME_ID, token };
}

// ---------------------------------------------------------------------------
// Encoding.
// ---------------------------------------------------------------------------

/** UTF-8 encoded byte length of a string (pure; no Buffer/TextEncoder globals needed). */
export function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (const ch of input) {
    const codePoint = ch.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function encodeBody(frame: FramedMessage): Record<string, unknown> {
  switch (frame.kind) {
    case "auth": {
      // Wire order per doc §Methods: id, method, params.
      if (!isValidControlToken(frame.token)) {
        throw protocolViolation(
          `control token must contain exactly ${CONTROL_TOKEN_HEX_LENGTH} hexadecimal characters`,
        );
      }
      if (frame.id === null) {
        throw protocolViolation("an auth frame must carry a non-null id");
      }
      return { id: frame.id, method: AUTH_METHOD, params: { token: frame.token } };
    }
    case "request": {
      if (frame.id === null) {
        throw protocolViolation("a request frame must carry a non-null id");
      }
      // Params may be omitted or null for none (doc §Methods, engine.execute).
      const body: Record<string, unknown> = { id: frame.id, method: frame.method };
      if (frame.params !== null && frame.params !== undefined) {
        body.params = frame.params;
      }
      return body;
    }
    case "notification": {
      const body: Record<string, unknown> = { method: frame.method };
      if (frame.params !== null && frame.params !== undefined) {
        body.params = frame.params;
      }
      return body;
    }
    case "reply": {
      return { id: frame.id, ok: true, result: frame.result };
    }
    case "error": {
      return { id: frame.id, ok: false, error: frame.error };
    }
  }
}

/** Direction of a frame on the wire; fixes which byte ceiling applies. */
function frameCeiling(frame: FramedMessage): number {
  return frame.kind === "reply" || frame.kind === "error" ? MAX_REPLY_BYTES : MAX_REQUEST_BYTES;
}

/**
 * Encodes one "\n"-terminated JSON line. Object keys are emitted in wire order (id, method,
 * params / id, ok, result|error) matching rpc.rs `json!` literals. Throws frame_too_large
 * when the encoded line exceeds its ceiling (§Transport limits) — client-side we never put
 * an oversized line on the wire, so the engine's "rejected before command dispatch" path
 * stays server-side-only.
 */
export function encodeFrame(frame: FramedMessage): string {
  const line = `${JSON.stringify(encodeBody(frame))}\n`;
  const ceiling = frameCeiling(frame);
  if (utf8ByteLength(line) > ceiling) {
    throw frameTooLarge(
      `encoded ${frame.kind} frame exceeds ${ceiling} bytes (the line includes its newline)`,
      {
        hint: "Split the call: the engine caps request lines at 1 MiB and replies at 8 MiB including the newline (§Transport limits).",
      },
    );
  }
  return line;
}

// ---------------------------------------------------------------------------
// Decoding.
// ---------------------------------------------------------------------------

/**
 * Decodes one line (with or without its trailing newline) into a FramedMessage. Throws
 * TransportError (protocol_violation | frame_too_large) on anything that does not match the
 * pinned envelope. Zod validates every shape at this boundary (AGENTS.md).
 */
export function decodeFrame(line: string): FramedMessage {
  let text = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (text.endsWith("\r")) {
    text = text.slice(0, -1);
  }
  if (utf8ByteLength(text) > MAX_REPLY_BYTES) {
    throw frameTooLarge(`frame line exceeds ${MAX_REPLY_BYTES} bytes (8 MiB reply ceiling)`, {
      mayHaveCompleted: true,
      hint: "The request that produced this reply may have run; inspect the document before retrying.",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw protocolViolation(
      `bad JSON in frame line: ${error instanceof Error ? error.message : "unparseable"}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw protocolViolation("frame line is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.method === "string") {
    if (obj.method === AUTH_METHOD) {
      return parseOrViolate(authLineSchema, obj, "auth frame");
    }
    if ("id" in obj) {
      return parseOrViolate(requestLineSchema, obj, "request frame");
    }
    return parseOrViolate(notificationLineSchema, obj, "notification frame");
  }
  if (obj.ok === true) {
    return parseOrViolate(replyLineSchema, obj, "reply frame");
  }
  if (obj.ok === false) {
    return parseOrViolate(errorLineSchema, obj, "error frame");
  }
  throw protocolViolation("frame line matches no envelope: expected method, ok:result or ok:error");
}

function parseOrViolate<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw protocolViolation(`frame line does not match the ${what} envelope`, {
      hint: "The engine writes exactly {id,method,params} requests and {id,ok,result|error} replies (rpc.rs).",
    });
  }
  return result.data;
}
