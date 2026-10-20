// @studio/engine-client — ProtocolConnection: one socket lifecycle per instance.
// Owner: W2-A (src/transport/** only).
//
// Protocol truth (pinned vendor revision, read-only):
//   - docs/control-protocol.md §Methods: "The first request on every TCP connection must
//     authenticate. No other method is dispatched before this succeeds."
//     {"id":"auth","method":"auth","params":{"token":"<64 hex>"}}. Auth success replies
//     {"id":"auth","ok":true,"result":{"authenticated":true}}.
//   - §MCP bridge: the bridge keeps ONE authenticated connection; drops and reconnects before
//     a call once the connection may have gone idle (the app closes idle connections after
//     30 s); a transport failure while sending or waiting for a reply — including a reply
//     timeout — drops the connection and "reports that the operation may have completed";
//     EDITS ARE NEVER AUTOMATICALLY RESENT (#1007); "the next separate call reconnects and
//     authenticates"; "reply lines whose `id` does not match the request are skipped"; the
//     client call timeout is 55 s, strictly below the server's 60 s reply deadline; pure
//     reads may opt into ONE retry on a fresh connection (call_read — owned by the client
//     layer, not this class).
//   - §Transport limits + security.rs: at most 16 simultaneously serviced connections per
//     listener; excess connections are rejected before command dispatch (ConnectionLimiter).
//
// Division of labour: this class owns wire mechanics (auth ordering, correlation, timeouts,
// reconnect). Retry policy, call_read and error→envelope mapping belong to the client layer
// (retry/errors/client.ts owner); token acquisition belongs to auth.ts.

import type { Clock, TransportSocket } from "./socket.js";
import { SYSTEM_CLOCK } from "./socket.js";
import type { FramedMessage, JsonObject, JsonValue, RequestId } from "./frame.js";
import {
  AUTH_DEADLINE_MS,
  AUTH_FRAME_ID,
  DEFAULT_CALL_TIMEOUT_MS,
  buildAuthFrame,
  isValidControlToken,
  MAX_CONNECTIONS_PER_LISTENER,
  matchReplyId,
} from "./frame.js";
import {
  authRejected,
  connectionDroppedMidCall,
  connectionRefused,
  isTransportError,
  MAY_HAVE_COMPLETED_HINT,
  protocolViolation,
  replyTimeout,
  TransportError,
} from "./errors.js";
import { z } from "zod";

/** new → authenticating → ready → dropped. */
export type ConnectionState = "new" | "authenticating" | "ready" | "dropped";

/** Creates one socket per connection attempt; called once per connect()/reconnect(). */
export type SocketFactory = () => TransportSocket;

/**
 * Wire-faithful outcome of one request/reply exchange. An engine-level error reply
 * (`{"ok":false,"error":"…"}`, e.g. "unknown tool `foo`") is DATA here — the request was
 * delivered, dispatched and answered; the client layer maps the error string to its typed
 * catalog. Transport failures throw TransportError instead.
 */
export type WireReply = { readonly ok: true; readonly result: JsonValue } | { readonly ok: false; readonly wireError: string };

/** security.rs authentication_reply: {"ok":true,"result":{"authenticated":true}}. */
const AUTH_RESULT_SCHEMA = z.object({ authenticated: z.literal(true) });

/**
 * Client-side awareness of the listener's connection cap (§Transport limits: "at most 16
 * simultaneously serviced connections per listener"; excess connections are rejected before
 * command dispatch). The engine-pool/client layer shares ONE budget keyed per listener so a
 * fleet of connections never trips the server-side limiter.
 */
export class ConnectionBudget {
  private readonly inUseCounts = new Map<string, number>();

  constructor(readonly maxPerListener: number = MAX_CONNECTIONS_PER_LISTENER) {}

  tryAcquire(listenerKey: string): boolean {
    const current = this.inUseCounts.get(listenerKey) ?? 0;
    if (current >= this.maxPerListener) {
      return false;
    }
    this.inUseCounts.set(listenerKey, current + 1);
    return true;
  }

  release(listenerKey: string): void {
    const current = this.inUseCounts.get(listenerKey) ?? 0;
    if (current <= 1) {
      this.inUseCounts.delete(listenerKey);
    } else {
      this.inUseCounts.set(listenerKey, current - 1);
    }
  }

  inUse(listenerKey: string): number {
    return this.inUseCounts.get(listenerKey) ?? 0;
  }
}

export interface ProtocolConnectionOptions {
  /** 64-hex control token (doc §Methods). auth.ts owns loading it; we only send it. */
  readonly token: string;
  /** Default DEFAULT_CALL_TIMEOUT_MS (55 s < the server's 60 s reply deadline). */
  readonly callTimeoutMs?: number;
  /** Default AUTH_DEADLINE_MS (10 s; security.rs — the engine closes past it, #4965). */
  readonly authTimeoutMs?: number;
  readonly clock?: Clock;
  readonly budget?: ConnectionBudget;
  /** One key per engine listener (e.g. "host:port"); default "engine". */
  readonly budgetKey?: string;
  /** Observability for frames skipped because their id does not match (§MCP bridge). */
  readonly onSkippedFrame?: (frame: FramedMessage, pendingId: RequestId | null) => void;
}

interface PendingAuth {
  readonly resolve: () => void;
  readonly reject: (error: TransportError) => void;
  timer: unknown;
}

interface PendingCall {
  readonly id: number;
  readonly method: string;
  readonly resolve: (reply: WireReply) => void;
  readonly reject: (error: TransportError) => void;
  timer: unknown;
}

export class ProtocolConnection {
  private readonly socketFactory: SocketFactory;
  private readonly token: string;
  private readonly callTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly clock: Clock;
  private readonly budget: ConnectionBudget | undefined;
  private readonly budgetKey: string;
  private readonly onSkippedFrame:
    | ((frame: FramedMessage, pendingId: RequestId | null) => void)
    | undefined;

  private state: ConnectionState = "new";
  private socket: TransportSocket | null = null;
  private nextRequestId = 1;
  private pendingCall: PendingCall | null = null;
  private pendingAuth: PendingAuth | null = null;
  private skippedFrameCount = 0;
  private budgetHeld = false;

  constructor(socketFactory: SocketFactory, options: ProtocolConnectionOptions) {
    // Fail fast on a malformed token: the engine rejects anything but 64 hex characters
    // (security.rs validate_token), and a late auth_rejected hides the real problem.
    if (!isValidControlToken(options.token)) {
      throw protocolViolation(
        "control token must contain exactly 64 hexadecimal characters",
      );
    }
    this.socketFactory = socketFactory;
    this.token = options.token;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_DEADLINE_MS;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.budget = options.budget;
    this.budgetKey = options.budgetKey ?? "engine";
    this.onSkippedFrame = options.onSkippedFrame;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Frames whose id did not match the outstanding request (§MCP bridge: skipped). */
  get skippedFrames(): number {
    return this.skippedFrameCount;
  }

  /**
   * Opens the socket and runs the mandatory first-frame auth (doc §Methods). Only legal from
   * state "new"; reconnect() covers every later (re)establishment.
   */
  async connect(): Promise<void> {
    if (this.state !== "new") {
      throw protocolViolation(
        `connect() requires state "new" (got "${this.state}"); use reconnect()`,
      );
    }
    await this.openAndAuthenticate();
  }

  /**
   * Drops the current socket and establishes a fresh one, re-running the first-frame auth —
   * the doc requires auth "on every TCP connection". Any in-flight call settles first as
   * connection_dropped_mid_call (its reply is abandoned; the operation may have completed);
   * edits are never automatically resent (#1007) — resending is the caller's policy.
   */
  async reconnect(): Promise<void> {
    this.rejectPendingAuth(
      connectionRefused("reconnect() during authentication; the request was not sent"),
    );
    const call = this.pendingCall;
    if (call !== null) {
      this.settleCall(call, this.midCallDrop("reconnect() while a request was in flight"));
    }
    const old = this.socket;
    this.socket = null;
    this.releaseBudget();
    if (old !== null) {
      try {
        await old.close();
      } catch {
        // Already dead; the fresh connection below is what matters.
      }
    }
    this.state = "dropped";
    await this.openAndAuthenticate();
  }

  /**
   * One request/reply exchange: assigns a fresh numeric id, sends the request, resolves with
   * the correlated reply. Reply lines whose id does not match are SKIPPED (§MCP bridge).
   * One outstanding request at a time — the bridge runs one exchange per connection.
   *
   * Throws TransportError for transport failures (nothing about the document is implied
   * unless mayHaveCompleted is true); resolves with { ok:false, wireError } when the ENGINE
   * answered with a protocol error reply.
   */
  async call(method: string, params?: JsonObject | null): Promise<WireReply> {
    if (this.state !== "ready") {
      throw connectionRefused(
        `connection is "${this.state}", not ready; the request was not sent`,
        {
          hint: "Connect (or reconnect) first; a fresh connection re-runs the auth handshake.",
        },
      );
    }
    if (this.pendingCall !== null) {
      throw protocolViolation(
        "one outstanding request per connection (the bridge runs one exchange per call)",
      );
    }
    const socket = this.socket;
    if (socket === null) {
      throw connectionRefused("connection is ready but the socket is gone; nothing was sent");
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const frame: FramedMessage = { kind: "request", id, method, params: params ?? null };

    return await new Promise<WireReply>((resolve, reject) => {
      // settleCall() guards by pending-call identity, so a timeout, a late reply, a socket
      // error and a close can all race and exactly one outcome wins.
      const pending: PendingCall = {
        id,
        method,
        timer: 0,
        resolve,
        reject,
      };
      pending.timer = this.clock.setTimeout(() => {
        // §MCP bridge: a reply timeout is a transport failure — drop the connection; the
        // operation may have completed, so nothing is resent from here.
        this.settleCall(pending, this.callTimedOut(pending));
        this.dropConnection();
      }, this.callTimeoutMs);
      this.pendingCall = pending;
      socket.send(frame).catch((error: unknown) => {
        this.settleCall(pending, this.sendFailed(error));
        this.dropConnection();
      });
    });
  }

  /** Graceful shutdown. An in-flight call settles as connection_dropped_mid_call. */
  async close(): Promise<void> {
    this.rejectPendingAuth(
      connectionRefused("close() during authentication; the request was not sent"),
    );
    const call = this.pendingCall;
    if (call !== null) {
      this.settleCall(call, this.midCallDrop("close() while a request was in flight"));
    }
    this.state = "dropped";
    this.releaseBudget();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        await socket.close();
      } catch {
        // Already dead; state is dropped either way.
      }
    }
  }

  // -- internal plumbing -----------------------------------------------------

  private async openAndAuthenticate(): Promise<void> {
    this.state = "authenticating";
    if (this.budget !== undefined && !this.budget.tryAcquire(this.budgetKey)) {
      this.state = "dropped";
      throw connectionRefused(
        `engine listener connection cap reached (${this.budget.maxPerListener} per listener)`,
        {
          hint: "The listener services at most 16 simultaneous connections and rejects excess connections before command dispatch (§Transport limits); reuse or drain connections.",
        },
      );
    }
    this.budgetHeld = true;

    const socket = this.socketFactory();
    this.socket = socket;
    socket.onFrame((frame) => this.handleFrame(frame));
    socket.onError((error) => this.handleSocketError(error));
    socket.onClose((hadError) => this.handleSocketClose(hadError));

    try {
      await socket.connect();
    } catch (error) {
      this.state = "dropped";
      this.releaseBudget();
      throw error;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        // rejectPendingAuth() guards by identity, so timeout vs. reply vs. drop races settle
        // the handshake exactly once.
        const pending: PendingAuth = { timer: 0, resolve, reject };
        pending.timer = this.clock.setTimeout(() => {
          this.rejectPendingAuth(
            authRejected(`no authentication reply within ${this.authTimeoutMs}ms`, {
              retryable: true,
              hint: "The engine closes a TCP connection that has not authenticated within 10 s of connecting, however much it sends (#4965). Retry on a fresh connection.",
            }),
          );
          this.dropConnection();
        }, this.authTimeoutMs);
        this.pendingAuth = pending;
        // §Methods: the first frame on every TCP connection is `auth`; nothing else may be
        // dispatched before its reply. The connection layer cannot send anything else yet.
        socket.send(buildAuthFrame(this.token)).catch((error: unknown) => {
          this.rejectPendingAuth(
            isTransportError(error)
              ? error
              : connectionRefused("sending the auth frame failed", { cause: error }),
          );
          this.dropConnection();
        });
      });
    } catch (error) {
      this.state = "dropped";
      this.releaseBudget();
      this.dropConnection();
      throw error;
    }
    this.state = "ready";
  }

  private handleFrame = (frame: FramedMessage): void => {
    const auth = this.pendingAuth;
    if (auth !== null && matchReplyId(frame, AUTH_FRAME_ID)) {
      this.handleAuthReply(frame);
      return;
    }
    const call = this.pendingCall;
    if (call !== null && matchReplyId(frame, call.id)) {
      this.settleCall(
        call,
        frame.kind === "reply"
          ? { ok: true, result: frame.result }
          : { ok: false, wireError: frame.kind === "error" ? frame.error : "" },
      );
      return;
    }
    // §MCP bridge: "reply lines whose `id` does not match the request are skipped."
    this.skippedFrameCount += 1;
    this.onSkippedFrame?.(frame, call?.id ?? null);
    if (
      call !== null &&
      frame.kind === "error" &&
      frame.id === null &&
      this.pendingCall === call
    ) {
      // rpc.rs writes id:null error replies only for requests it could not bound or parse
      // (oversized / non-UTF-8 lines) — pre-dispatch rejections. This client never sends
      // such lines (encodeFrame enforces the 1 MiB ceiling), so one arriving mid-call means
      // the wire contract broke. Fail loudly and drop; never guess.
      const callToFail = this.pendingCall;
      if (callToFail !== null) {
        this.settleCall(
          callToFail,
          protocolViolation(
            `engine replied with an uncorrelated pre-dispatch error: ${frame.error}`,
          ),
        );
      }
      this.dropConnection();
    }
  };

  private handleAuthReply(frame: FramedMessage): void {
    const auth = this.pendingAuth;
    if (auth === null) {
      return;
    }
    if (frame.kind === "reply") {
      const parsed = AUTH_RESULT_SCHEMA.safeParse(frame.result);
      if (parsed.success) {
        this.acceptPendingAuth(auth);
        return;
      }
      this.rejectPendingAuth(
        protocolViolation("auth reply did not confirm authentication", {
          hint: 'Expected {"ok":true,"result":{"authenticated":true}} (security.rs authentication_reply).',
        }),
      );
      this.dropConnection();
      return;
    }
    if (frame.kind === "error") {
      this.rejectPendingAuth(
        authRejected(`the engine rejected authentication: ${frame.error}`, {
          hint: "Check the control token (token file, not a CLI argument); a repeat `auth` frame on one connection also answers this way.",
        }),
      );
      this.dropConnection();
    }
  }

  private handleSocketError = (error: TransportError): void => {
    const call = this.pendingCall;
    if (call !== null) {
      this.settleCall(call, this.midCallDrop("the connection failed mid-call", error));
    }
    this.rejectPendingAuth(
      connectionRefused("the connection dropped during authentication", { cause: error }),
    );
    this.dropConnection();
  };

  private handleSocketClose = (hadError: boolean): void => {
    void hadError; // close-without-error still abandons whatever was in flight
    const call = this.pendingCall;
    if (call !== null) {
      this.settleCall(call, this.midCallDrop("the connection closed mid-call"));
    }
    this.rejectPendingAuth(
      connectionRefused("the connection closed during authentication"),
    );
    this.dropConnection();
  };

  private settleCall(pending: PendingCall, outcome: WireReply | TransportError): void {
    if (this.pendingCall !== pending) {
      return; // already settled by a timeout/drop; late events must not double-settle
    }
    this.pendingCall = null;
    this.clock.clearTimeout(pending.timer);
    if (isTransportError(outcome)) {
      pending.reject(outcome);
    } else {
      pending.resolve(outcome);
    }
  }

  private acceptPendingAuth(auth: PendingAuth): void {
    if (this.pendingAuth !== auth) {
      return; // already settled (e.g. the deadline won a race); late events must not double-settle
    }
    this.pendingAuth = null;
    this.clock.clearTimeout(auth.timer);
    auth.resolve();
  }

  private rejectPendingAuth(error: TransportError): void {
    const auth = this.pendingAuth;
    if (auth === null) {
      return;
    }
    this.pendingAuth = null;
    this.clock.clearTimeout(auth.timer);
    auth.reject(error);
  }

  private midCallDrop(reason: string, cause?: unknown): TransportError {
    return connectionDroppedMidCall(reason, { cause });
  }

  private callTimedOut(pending: PendingCall): TransportError {
    return replyTimeout(
      `no reply for "${pending.method}" within ${this.callTimeoutMs}ms`,
      {
        hint:
          "The client call timeout (55 s) is strictly below the engine's 60 s reply deadline, so this error — not a late engine reply — is what callers see. The command may have been dispatched and may still apply. " +
          MAY_HAVE_COMPLETED_HINT,
      },
    );
  }

  private sendFailed(error: unknown): TransportError {
    return isTransportError(error)
      ? error
      : connectionDroppedMidCall("sending the request failed", { cause: error });
  }

  private dropConnection(): void {
    this.state = "dropped";
    this.releaseBudget();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.close().catch(() => undefined);
    }
  }

  private releaseBudget(): void {
    if (this.budgetHeld && this.budget !== undefined) {
      this.budget.release(this.budgetKey);
      this.budgetHeld = false;
    }
  }
}
