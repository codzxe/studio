// @studio/engine-client — pure test doubles for the transport layer. Owner: W2-A.
//
// Exported from src (not a test file) so the sibling engine-client test owners (tests/)
// can drive the same seams without re-implementing fakes. Everything here is in-memory and
// deterministic: no real sockets, no real timers (AGENTS.md: tests <5 s, no network).

import type { FramedMessage } from "./frame.js";
import { encodeFrame } from "./frame.js";
import type { Clock } from "./socket.js";
import type { TransportSocket } from "./socket.js";
import { TransportError } from "./errors.js";

/** The 64-hex test token rpc.rs's own tests use; a public fixture, never a secret. */
export const TEST_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Same token with uppercase hex letters (security.rs: hex matches in either case). */
export const TEST_TOKEN_UPPER = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

// ---------------------------------------------------------------------------
// FakeClock — manually advanced time.
// ---------------------------------------------------------------------------

interface ScheduledTask {
  runAtMs: number;
  order: number;
  fn: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  nowMs = 0;
  private nextOrder = 0;
  private readonly tasks = new Map<number, ScheduledTask>();

  /** Timers still scheduled — asserts cleanup (no leaked timeouts after a settle). */
  get timerCount(): number {
    return this.tasks.size;
  }

  setTimeout(fn: () => void, ms: number): number {
    if (ms < 0) {
      ms = 0;
    }
    const handle = this.nextOrder;
    this.nextOrder += 1;
    this.tasks.set(handle, { runAtMs: this.nowMs + ms, order: handle, fn, cancelled: false });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.tasks.delete(handle);
    }
  }

  /** Runs every task due within `ms`, in (deadline, schedule-order) order. */
  advance(ms: number): void {
    const until = this.nowMs + ms;
    for (;;) {
      let due: ScheduledTask | null = null;
      let dueKey = -1;
      for (const [key, task] of this.tasks) {
        if (task.runAtMs <= until && (due === null || task.runAtMs < due.runAtMs || (task.runAtMs === due.runAtMs && task.order < due.order))) {
          due = task;
          dueKey = key;
        }
      }
      if (due === null) {
        break;
      }
      this.tasks.delete(dueKey);
      this.nowMs = due.runAtMs;
      due.fn();
    }
    this.nowMs = until;
  }
}

// ---------------------------------------------------------------------------
// FakeSocket — in-memory TransportSocket for ProtocolConnection tests.
// ---------------------------------------------------------------------------

/**
 * Records every sent frame/line and lets a test script the server side: push replies,
 * refuse connects, drop mid-call. No sockets, no timers — tests advance FakeClock.
 */
export class FakeSocket implements TransportSocket {
  connectCount = 0;
  closeCount = 0;
  readonly sentFrames: FramedMessage[] = [];
  readonly sentLines: string[] = [];
  readonly skippedFrames: FramedMessage[] = [];
  private open = false;
  private connectError: TransportError | null = null;
  private sendError: TransportError | null = null;
  private readonly frameCallbacks: Array<(frame: FramedMessage) => void> = [];
  private readonly errorCallbacks: Array<(error: TransportError) => void> = [];
  private readonly closeCallbacks: Array<(hadError: boolean) => void> = [];

  /** Makes the next connect() reject with this error. */
  failConnectsWith(error: TransportError): void {
    this.connectError = error;
  }

  /** Makes the next send() reject with this error (transport failure while writing). */
  failSendWith(error: TransportError): void {
    this.sendError = error;
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.connectError !== null) {
      this.connectError = null;
      throw this.connectError;
    }
    this.open = true;
  }

  async send(frame: FramedMessage): Promise<void> {
    if (!this.open) {
      throw new TransportError(
        "protocol_violation",
        "FakeSocket.send on a closed socket",
      );
    }
    this.sentFrames.push(frame);
    this.sentLines.push(encodeFrame(frame));
    if (this.sendError !== null) {
      const error = this.sendError;
      this.sendError = null;
      throw error;
    }
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
    this.closeCount += 1;
    if (this.open) {
      this.open = false;
      for (const callback of this.closeCallbacks.slice()) {
        callback(false);
      }
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Server→client: deliver a decoded frame. */
  deliver(frame: FramedMessage): void {
    for (const callback of this.frameCallbacks.slice()) {
      callback(frame);
    }
  }

  /** Stream error, then close (mirrors NodeNetSocket: error, then close(hadError=true)). */
  failWith(error: TransportError): void {
    this.open = false;
    for (const callback of this.errorCallbacks.slice()) {
      callback(error);
    }
    for (const callback of this.closeCallbacks.slice()) {
      callback(true);
    }
  }

  /** Silent close; hadError false (e.g. the app closed an idle connection). */
  drop(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    for (const callback of this.closeCallbacks.slice()) {
      callback(false);
    }
  }
}

// ---------------------------------------------------------------------------
// FakeLowLevelSocket — in-memory net.Socket stand-in for NodeNetSocket tests.
// ---------------------------------------------------------------------------

type Bytes = (string | Uint8Array)[];
type Listener = (...args: unknown[]) => void;

/** Emits "connect" on first write or immediately; supports data/error/close like net.Socket. */
export class FakeLowLevelSocket {
  readonly written: Bytes = [];
  destroyedCount = 0;
  /** Set false to simulate TCP backpressure (write returns false; callback still fires). */
  writeReturns = true;
  private listeners = new Map<string, Listener[]>();
  private connectedEmitted = false;
  private destroyed = false;

  constructor(readonly autoConnect = true) {}

  on(event: string, listener: Listener): unknown {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === "connect") {
      this.connectedEmitted = true;
    }
    for (const listener of (this.listeners.get(event) ?? []).slice()) {
      listener(...args);
    }
  }

  /** Test helper: push server bytes (a Uint8Array chunk) through the "data" event. */
  receive(chunk: Uint8Array): void {
    this.emit("data", chunk);
  }

  write(chunk: string | Uint8Array, callback?: (error?: unknown) => void): boolean {
    if (this.autoConnect && !this.connectedEmitted) {
      this.emit("connect");
    }
    this.written.push(chunk);
    if (callback !== undefined) {
      callback();
    }
    return this.writeReturns;
  }

  destroy(): void {
    this.destroyedCount += 1;
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}
