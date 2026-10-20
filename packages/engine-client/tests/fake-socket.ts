// tests/fake-socket.ts — reusable in-memory socket harness for control-protocol tests.
//
// Scope (W2-E, spec §21 Contract-testing row): a FakeSocket that
//   - records every frame the client writes (raw + parsed),
//   - replays scripted replies, fixture-style, one per request frame,
//   - can inject failures (destroy mid-call, garbage bytes, oversized reply lines),
//   - and models the TCP auth rule from docs/control-protocol.md: the first frame
//     on a connection must be `auth`; until then every other frame gets the
//     "authentication required" error and the connection closes
//     (vendor/photocraft/crates/automation/src/rpc.rs :: serve_tcp_connection).
//
// Other packages' tests import this harness directly (`import { FakeSocket } from
// "@studio/engine-client/tests/fake-socket.js"` path or a relative one) — it has no
// dependencies and no node APIs, so it runs in any vitest environment.
//
// The type surface intentionally mirrors the parts of `node:net.Socket` a JSON-lines
// client touches, so a real transport binds to it unchanged: write(chunk): boolean,
// on("data"|"close"|"error", listener), destroy(error?).

/** A parsed JSON-lines frame (`{id, method, params}` request or `{id, ok, …}` reply). */
export type WireFrame = Record<string, unknown>;

/** Listener for socket data chunks (strings here; a real socket hands over Buffers). */
export type DataListener = (chunk: string) => void;
export type CloseListener = (hadError: boolean) => void;
export type ErrorListener = (error: Error) => void;

/**
 * A scripted reply. Strings are emitted verbatim (letting tests inject malformed
 * lines); functions receive the parsed request frame plus the socket for dynamic
 * behaviour; `null` emits nothing (the reply is withheld, e.g. a never-answering
 * server under a timeout test).
 */
export type ScriptedReply = string | ((frame: WireFrame, socket: FakeSocket) => string | null) | null;

export interface FakeSocketOptions {
  /**
   * Replies to emit, in order, each time the client writes a request frame.
   * With `token` set, the first frame is authenticated instead (see below).
   */
  replies?: ScriptedReply[];
  /**
   * When set, the socket enforces the TCP auth rule: the first frame must be
   * `auth` with this exact token. It replies the recorded auth-ok shape
   * ({"id":…,"ok":true,"result":{"authenticated":true}}) or, for anything else,
   * `{"id":…,"ok":false,"error":"authentication required"}` and closes —
   * exactly security.rs :: authentication_reply. `replies` serve subsequent frames.
   */
  token?: string;
  /** Split server writes into chunks of this many characters (default 1 = no split). */
  chunkSize?: number;
  /** Emit each server line without the trailing newline (malformed framing tests). */
  omitNewline?: boolean;
}

/**
 * Minimal event-emitting socket with a scripted mock server behind it.
 *
 * ```ts
 * const fake = new FakeSocket({
 *   token: TOKEN,
 *   replies: ['{"id":1,"ok":true,"result":{"document":0}}'],
 * });
 * const client = new JsonLinesTransport(fake);
 * ```
 */
export class FakeSocket {
  readonly written: string[] = [];
  readonly writtenFrames: WireFrame[] = [];
  readonly events: string[] = [];

  private readonly replies: ScriptedReply[];
  private readonly token: string | undefined;
  private readonly chunkSize: number;
  private readonly omitNewline: boolean;

  private listeners = new Map<string, Array<DataListener | CloseListener | ErrorListener>>();
  private authenticated = false;
  private replyIndex = 0;
  private destroyed = false;

  constructor(options: FakeSocketOptions = {}) {
    this.replies = options.replies ?? [];
    this.token = options.token;
    this.chunkSize = options.chunkSize ?? 0;
    this.omitNewline = options.omitNewline ?? false;
  }

  // --- client-facing surface (the part a transport binds to) ---

  on(event: "data", listener: DataListener): this;
  on(event: "close", listener: CloseListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: string, listener: DataListener | CloseListener | ErrorListener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    this.events.push(`on:${event}`);
    return this;
  }

  /** Called by the transport for each outgoing frame. */
  write(chunk: string): boolean {
    if (this.destroyed) {
      return false;
    }
    this.written.push(chunk);
    const frame = tryParseFrame(chunk);
    this.writtenFrames.push(frame);

    if (this.token !== undefined && !this.authenticated) {
      this.answerAuthentication(frame);
      return true;
    }
    this.emitNextScriptedReply(frame);
    return true;
  }

  /** Server-side: push an unsolicited line to the client (no trailing newline added). */
  sendLine(line: string): void {
    this.emitData(line);
  }

  destroy(error?: Error): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (error !== undefined) {
      this.emit("error", error);
    }
    this.emit("close", error !== undefined);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // --- mock-server internals ---

  private answerAuthentication(frame: WireFrame): void {
    const token = paramsOf(frame)?.token;
    const id = "id" in frame ? frame.id : null;
    if (frame.method === "auth" && typeof token === "string" && token === this.token) {
      this.authenticated = true;
      this.replyRaw(JSON.stringify({ id, ok: true, result: { authenticated: true } }));
    } else {
      // security.rs :: authentication_reply — then the server drops the connection.
      this.replyRaw(JSON.stringify({ id, ok: false, error: "authentication required" }));
      this.destroy();
    }
  }

  private emitNextScriptedReply(frame: WireFrame): void {
    const scripted = this.replies[this.replyIndex];
    this.replyIndex += 1;
    const line = typeof scripted === "function" ? scripted(frame, this) : scripted;
    if (line !== null && line !== undefined) {
      this.replyRaw(line);
    }
  }

  private replyRaw(line: string): void {
    this.emitData(this.omitNewline ? line : `${line}\n`);
  }

  private emitData(data: string): void {
    const chunks = this.chunkSize > 0 ? splitInto(data, this.chunkSize) : [data];
    for (const chunk of chunks) {
      this.emit("data", chunk);
    }
  }

  private emit(event: "data", chunk: string): void;
  private emit(event: "close", hadError: boolean): void;
  private emit(event: "error", error: Error): void;
  private emit(event: string, arg: string | boolean | Error): void {
    for (const listener of this.listeners.get(event) ?? []) {
      if (typeof listener !== "function") {
        continue;
      }
      if (event === "error") {
        (listener as ErrorListener)(arg as Error);
      } else if (event === "close") {
        (listener as CloseListener)(arg as boolean);
      } else {
        (listener as DataListener)(arg as string);
      }
    }
  }
}

/** Parse a JSON-lines frame, or a sentinel `{ $unparsable: true }` for malformed writes. */
export function tryParseFrame(line: string): WireFrame {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as WireFrame;
    }
  } catch {
    // fall through
  }
  return { $unparsable: true };
}

function paramsOf(frame: WireFrame): Record<string, unknown> | null {
  const params = "params" in frame ? frame.params : null;
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return null;
}

function splitInto(data: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += size) {
    chunks.push(data.slice(i, i + size));
  }
  return chunks;
}
