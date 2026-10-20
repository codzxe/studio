// @studio/engine-client — byte transport seam. Owner: W2-A (src/transport/** only).
//
// Protocol truth (pinned vendor revision, read-only):
//   - docs/control-protocol.md §MCP bridge: the engine only listens on loopback ("the
//     protocol is unencrypted and must remain on loopback; do not tunnel or proxy it to an
//     untrusted host"); a transport failure while sending or waiting for a reply reports that
//     the operation may have completed.
//   - §Headless server: `photocraft-cli serve` answers the same JSON-lines envelope on stdio
//     WITHOUT the TCP auth handshake ("access is inherited from the process pipe"), or on
//     127.0.0.1:<port> with the first-frame auth exchange.
//   - §Transport limits + security.rs: 1 MiB request lines, 8 MiB replies incl. newline, 30 s
//     socket read/write timeout; a TCP connection is closed after an oversized line; an
//     oversized incoming reply is dropped without automatic retry.
//
// No @types/node is required: the default factory imports `node:net` dynamically through a
// structural surface (this package does not declare @types/node; tighten if a future owner
// adds it).

import type { FramedMessage } from "./frame.js";
import { decodeFrame, encodeFrame, MAX_REPLY_BYTES, SERVER_IO_TIMEOUT_MS } from "./frame.js";
import {
  connectionDroppedMidCall,
  connectionRefused,
  frameTooLarge,
  isTransportError,
  MAY_HAVE_COMPLETED_HINT,
  protocolViolation,
  TransportError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Clock seam (injectable timers keep unit tests deterministic, AGENTS.md).
// ---------------------------------------------------------------------------

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

type GlobalTimerRegistry = {
  setTimeout(fn: (...args: never[]) => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** System clock through a structural read of globalThis (no @types/node needed). */
export const SYSTEM_CLOCK: Clock = {
  setTimeout(fn, ms) {
    return (globalThis as unknown as GlobalTimerRegistry).setTimeout(fn, ms);
  },
  clearTimeout(handle) {
    (globalThis as unknown as GlobalTimerRegistry).clearTimeout(handle);
  },
};

// ---------------------------------------------------------------------------
// TransportSocket — the interface the protocol layer drives.
// ---------------------------------------------------------------------------

/**
 * The five task-mandated members are connect/send/onFrame/close/isOpen. onError and
 * onClose are additions required by the doc's own semantics: a transport failure while
 * sending or waiting for a reply must be surfaced to the caller as "may have completed"
 * (§MCP bridge), and decode failures (frame_too_large, protocol_violation) need a channel
 * that is not a frame. testing.ts fakes implement the same surface.
 */
export interface TransportSocket {
  connect(): Promise<void>;
  send(frame: FramedMessage): Promise<void>;
  onFrame(callback: (frame: FramedMessage) => void): void;
  close(): Promise<void>;
  isOpen(): boolean;
  /** Transport-level failure observed on the stream (stream error, oversized line, bad frame). */
  onError(callback: (error: TransportError) => void): void;
  /** Stream ended; hadError is true when the close followed a stream error. */
  onClose(callback: (hadError: boolean) => void): void;
}

/** Loopback-only target (doc §MCP bridge security note). */
export interface SocketEndpoint {
  readonly host: string;
  readonly port: number;
}

const IPV4_LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True for the only addresses the engine can ever listen on, mirroring the vendor bridge's
 * loopback check: 127.0.0.0/8 (IPv4 loopback is the whole /8), IPv4-mapped loopback, ::1
 * and "localhost".
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") {
    return true;
  }
  const dotted = host.toLowerCase().startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  return IPV4_LOOPBACK_PATTERN.test(dotted);
}

// ---------------------------------------------------------------------------
// Low-level socket seam (net.Socket subset, structural; injectable for tests).
// ---------------------------------------------------------------------------

export interface LowLevelSocket {
  /** Returns false under backpressure; the callback still settles the write. */
  write(chunk: string | Uint8Array, callback?: (error?: unknown) => void): boolean;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface LowLevelConnectOptions {
  readonly clock: Clock;
  readonly connectTimeoutMs: number;
}

export type LowLevelSocketFactory = (
  endpoint: SocketEndpoint,
  options: LowLevelConnectOptions,
) => Promise<LowLevelSocket>;

/** Structural surface of the `node:net` pieces this module touches. */
interface RawNodeSocket {
  on(event: string, listener: (...args: never[]) => void): unknown;
  write(chunk: string, callback?: (error?: unknown) => void): boolean;
  destroy(): void;
  setNoDelay?(noDelay?: boolean): unknown;
}

interface NetModule {
  createConnection(options: { host: string; port: number }): RawNodeSocket;
}

/** Non-literal specifier keeps the import dynamic (optional peer; no static types needed). */
const NET_MODULE_NAME = "node:net";

function describeConnectError(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "unexpected failure";
}

/** Default factory: real TCP to a loopback engine listener, via node:net. */
export const defaultTcpSocketFactory: LowLevelSocketFactory = async (endpoint, options) => {
  let netModule: NetModule;
  try {
    netModule = (await import(NET_MODULE_NAME)) as unknown as NetModule;
  } catch (error) {
    throw connectionRefused("cannot load the node:net TCP module", { cause: error });
  }
  const raw = netModule.createConnection({ host: endpoint.host, port: endpoint.port });
  raw.setNoDelay?.(true);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { readonly ok: true } | { readonly ok: false; error: unknown }) => {
      if (settled) {
        return;
      }
      settled = true;
      options.clock.clearTimeout(timer);
      if (outcome.ok) {
        resolve();
        return;
      }
      reject(
        connectionRefused(
          `connect to ${endpoint.host}:${endpoint.port} failed (${describeConnectError(outcome.error)})`,
          { hint: "The request was not sent; nothing was applied.", cause: outcome.error },
        ),
      );
    };
    const timer = options.clock.setTimeout(() => {
      raw.destroy();
      finish({ ok: false, error: new Error("connect timeout") });
    }, options.connectTimeoutMs);
    raw.on("connect", () => finish({ ok: true }));
    raw.on("error", (args: never[]) =>
      finish({ ok: false, error: args.length > 0 ? args[0] : undefined }),
    );
  });

  // The pre-connect "error" listener stays registered (a settled no-op) so a later stream
  // error never becomes an unhandled 'error' event; the adapter's own listener surfaces it.
  return {
    write(chunk, callback) {
      if (typeof chunk !== "string") {
        // NodeNetSocket only writes encoded frame lines (strings); anything else is a bug.
        callback?.(protocolViolation("node:net transport writes text frames only"));
        return false;
      }
      return raw.write(chunk, callback);
    },
    destroy() {
      raw.destroy();
    },
    on(event, listener) {
      return raw.on(event, listener as (...args: never[]) => void);
    },
  };
};

// ---------------------------------------------------------------------------
// NodeNetSocket — TCP framing over one net socket.
// ---------------------------------------------------------------------------

export interface TcpTransportOptions {
  readonly endpoint: SocketEndpoint;
  /** Default SERVER_IO_TIMEOUT_MS (30 s), mirroring the engine's own socket deadline. */
  readonly connectTimeoutMs?: number;
  readonly clock?: Clock;
  readonly socketFactory?: LowLevelSocketFactory;
}

type SocketState = "idle" | "connecting" | "open" | "closed";

const EMPTY_BYTES = new Uint8Array(0);

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.byteLength === 0) {
    return tail;
  }
  const merged = new Uint8Array(head.byteLength + tail.byteLength);
  merged.set(head, 0);
  merged.set(tail, head.byteLength);
  return merged;
}

interface TextDecoderLike {
  decode(bytes: Uint8Array): string;
}

function createTextDecoder(): TextDecoderLike {
  const ctor = (globalThis as unknown as { TextDecoder?: new () => TextDecoderLike })
    .TextDecoder;
  if (ctor === undefined) {
    throw protocolViolation("TextDecoder is unavailable; UTF-8 frame decoding needs it");
  }
  return new ctor();
}

export class NodeNetSocket implements TransportSocket {
  private readonly endpoint: SocketEndpoint;
  private readonly connectTimeoutMs: number;
  private readonly clock: Clock;
  private readonly factory: LowLevelSocketFactory;
  private readonly decoder: TextDecoderLike = createTextDecoder();
  private socket: LowLevelSocket | null = null;
  private state: SocketState = "idle";
  private pendingBytes = EMPTY_BYTES;
  private sawError = false;
  private closeDelivered = false;
  private readonly frameCallbacks: Array<(frame: FramedMessage) => void> = [];
  private readonly errorCallbacks: Array<(error: TransportError) => void> = [];
  private readonly closeCallbacks: Array<(hadError: boolean) => void> = [];

  constructor(options: TcpTransportOptions) {
    this.endpoint = options.endpoint;
    this.connectTimeoutMs = options.connectTimeoutMs ?? SERVER_IO_TIMEOUT_MS;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.factory = options.socketFactory ?? defaultTcpSocketFactory;
  }

  async connect(): Promise<void> {
    if (this.state !== "idle") {
      throw protocolViolation(`connect() called on a socket in state "${this.state}"`);
    }
    // Doc §MCP bridge: the engine only listens on loopback; this unencrypted protocol must
    // never be pointed at anything else.
    if (!isLoopbackHost(this.endpoint.host)) {
      throw protocolViolation(
        `refusing non-loopback control endpoint ${this.endpoint.host}:${this.endpoint.port}`,
        {
          hint: "The control protocol is unencrypted and must remain on loopback (control-protocol.md §MCP bridge security note).",
        },
      );
    }
    this.state = "connecting";
    let socket: LowLevelSocket;
    try {
      socket = await this.factory(this.endpoint, {
        clock: this.clock,
        connectTimeoutMs: this.connectTimeoutMs,
      });
    } catch (error) {
      this.state = "closed";
      if (isTransportError(error)) {
        throw error;
      }
      throw connectionRefused(
        `connect to ${this.endpoint.host}:${this.endpoint.port} failed (${describeConnectError(error)})`,
        { cause: error },
      );
    }
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.handleStreamError(error));
    socket.on("close", (hadError) => this.handleClosed(hadError === true));
    this.state = "open";
  }

  async send(frame: FramedMessage): Promise<void> {
    if (this.state !== "open" || this.socket === null) {
      throw protocolViolation(`send() requires an open socket, got state "${this.state}"`);
    }
    const line = encodeFrame(frame); // throws frame_too_large BEFORE anything is written
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (error === undefined) {
          resolve();
        } else {
          // Doc §MCP bridge: a transport failure while SENDING a request "reports that the
          // operation may have completed" — the bytes may already have been on the wire.
          reject(
            connectionDroppedMidCall("the connection failed while a frame was being written", {
              cause: error,
            }),
          );
        }
      };
      try {
        socket.write(line, settle);
      } catch (error) {
        settle(error);
      }
    });
  }

  onFrame(callback: (frame: FramedMessage) => void): void {
    this.frameCallbacks.push(callback);
  }

  onError(callback: (error: TransportError) => void): void {
    this.errorCallbacks.push(callback);
  }

  onClose(callback: (hadError: boolean) => void): void {
    this.closeCallbacks.push(callback);
  }

  async close(): Promise<void> {
    this.dropSocket();
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  // -- internal plumbing -----------------------------------------------------

  private fail(error: TransportError): void {
    if (this.state !== "open") {
      return;
    }
    this.sawError = true;
    for (const callback of this.errorCallbacks.slice()) {
      callback(error);
    }
    this.dropSocket();
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (this.state !== "closed") {
      this.state = "closed";
    }
    if (socket !== null) {
      try {
        socket.destroy();
      } catch {
        // The stream was already gone; the close event (or its absence) settles it.
      }
    }
  }

  private handleData(chunk: unknown): void {
    if (!(chunk instanceof Uint8Array)) {
      this.fail(protocolViolation("socket delivered a non-binary chunk"));
      return;
    }
    if (chunk.byteLength === 0) {
      return;
    }
    if (chunk.indexOf(10) === -1) {
      // Partial line still growing: buffer it and enforce the reply ceiling.
      this.pendingBytes = concatBytes(this.pendingBytes, chunk);
      this.enforceReplyCeiling();
      return;
    }
    const all = concatBytes(this.pendingBytes, chunk);
    this.pendingBytes = EMPTY_BYTES;
    let start = 0;
    for (;;) {
      const newline = all.indexOf(10, start);
      if (newline === -1) {
        break;
      }
      let lineEnd = newline;
      if (lineEnd > start && all[lineEnd - 1] === 13) {
        lineEnd -= 1; // tolerate CRLF
      }
      const line = this.decoder.decode(all.subarray(start, lineEnd));
      start = newline + 1;
      this.processLine(line);
      if (this.state !== "open") {
        return;
      }
    }
    if (start < all.byteLength) {
      this.pendingBytes = all.subarray(start);
      this.enforceReplyCeiling();
    }
  }

  /** §Transport limits: an 8 MiB reply ceiling including the newline; oversized incoming
   *  replies are dropped without automatic retry (§MCP bridge). */
  private enforceReplyCeiling(): void {
    if (this.pendingBytes.byteLength > MAX_REPLY_BYTES) {
      this.fail(
        frameTooLarge(`incoming reply line exceeds ${MAX_REPLY_BYTES} bytes`, {
          mayHaveCompleted: true,
          hint: MAY_HAVE_COMPLETED_HINT,
        }),
      );
    }
  }

  private processLine(line: string): void {
    if (line.trim().length === 0) {
      return; // rpc.rs serve_lines: blank lines are ignored
    }
    let frame: FramedMessage;
    try {
      frame = decodeFrame(line);
    } catch (error) {
      this.fail(isTransportError(error) ? error : protocolViolation("frame decoding failed"));
      return;
    }
    for (const callback of this.frameCallbacks.slice()) {
      callback(frame);
    }
  }

  private handleStreamError(error: unknown): void {
    if (this.state !== "open") {
      return;
    }
    this.fail(
      connectionDroppedMidCall("the connection stream failed while in use", { cause: error }),
    );
  }

  private handleClosed(hadError: boolean): void {
    if (this.closeDelivered) {
      return;
    }
    this.closeDelivered = true;
    this.state = "closed";
    this.socket = null;
    const flagged = hadError || this.sawError;
    for (const callback of this.closeCallbacks.slice()) {
      callback(flagged);
    }
  }
}

// ---------------------------------------------------------------------------
// StdioTransport — headless stdio mode stub (TODO).
// ---------------------------------------------------------------------------

function stdioNotImplemented(operation: string): TransportError {
  return protocolViolation(
    `StdioTransport.${operation} is not implemented yet; headless serve over stdio needs no TCP auth handshake (control-protocol.md §Headless server)`,
    {
      hint: "Use NodeNetSocket against `photocraft-cli serve --port <port>` (loopback, first-frame auth) until the stdio transport lands.",
    },
  );
}

/**
 * TODO(W2+): headless stdio transport. `photocraft-cli serve` answers the SAME JSON-lines
 * envelope on stdio and — unlike TCP — does NOT require the first-frame auth exchange,
 * because "access is inherited from the process pipe" (doc §Headless server). The
 * implementation will spawn the process (the engine-pool supervisor owns its lifecycle),
 * pipe frames, skip the auth exchange, and enforce the same 1 MiB request / 8 MiB reply
 * byte ceilings. Until then every method fails loudly so no caller silently sends to null.
 */
export class StdioTransport implements TransportSocket {
  connect(): Promise<void> {
    throw stdioNotImplemented("connect");
  }

  send(_frame: FramedMessage): Promise<void> {
    throw stdioNotImplemented("send");
  }

  onFrame(_callback: (frame: FramedMessage) => void): void {
    throw stdioNotImplemented("onFrame");
  }

  onError(_callback: (error: TransportError) => void): void {
    throw stdioNotImplemented("onError");
  }

  onClose(_callback: (hadError: boolean) => void): void {
    throw stdioNotImplemented("onClose");
  }

  close(): Promise<void> {
    throw stdioNotImplemented("close");
  }

  isOpen(): boolean {
    return false;
  }
}
