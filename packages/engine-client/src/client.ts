// @studio/engine-client — the EngineClient facade. Owner: W2-D (src/{errors,retry,client,index}.ts).
//
// Failure semantics (docs/BUILD_PROMPT.md §3.4, verified against the pinned vendor):
//   - Timeouts: per-tool 5 s typical, 30 s render, injected per call ("waitMs"); the
//     facade enforces its own deadline on every exchange and ALWAYS stays strictly below
//     the engine's 60 s reply deadline (transport/frame.ts DEFAULT_CALL_TIMEOUT_MS = 55 s),
//     "so the bridge's error is the one callers see" (control-protocol.md §MCP bridge).
//     On timeout the connection is dropped; cancel/rollback/refund/report is the worker's
//     §3.4 follow-up, driven by the typed envelope this facade returns.
//   - Idempotency/edits: a transport failure while a MUTATING call is in flight returns
//     connection_dropped_mid_call ("the operation may have completed; inspect the document
//     before retrying. Edits are never automatically resent (#1007)"). Pure reads —
//     inspect/list/render/commands — auto-retry ONCE on a fresh connection (§MCP bridge).
//   - §5.7: every engine error string travels verbatim as `data`, never interpreted.
//
// Division of labour: transport/ (W2-A) owns wire mechanics via ProtocolConnection
// (auth ordering, id correlation, skipped non-matching replies, TransportError
// classification); methods/ (W2-C) owns param/result schemas and builders; budgets.ts
// (W2-B) owns the reply budget; auth.ts (W2-B) owns token loading; THIS module owns the
// policy: per-kind retry, §3.4 timeout defaults, AbortSignal, and the envelope surface.

import type { EngineAuth } from "./auth.js";
import { generateControlToken, isControlToken, parseEngineAuth, resolveEngineToken } from "./auth.js";
import { validateReplySize } from "./budgets.js";
import {
  buildFailure,
  PROTOCOL_METHODS,
  summarizeIssues,
  type BuiltMethodCall,
  type MethodCall,
} from "./methods/protocol.js";
import {
  batch as buildBatch,
  engineCommands as buildEngineCommands,
  engineExecute as buildEngineExecute,
  engineExecuteBackground as buildEngineExecuteBackground,
  jobsCancel as buildJobsCancel,
  jobsList as buildJobsList,
  methodsCall as buildMethodsCall,
  type BatchInput,
  type BatchResult,
  type CommandListResult,
  type EngineExecuteInput,
  type JobsCancelResult,
  type JobsListResult,
  type ZodTypeShim,
} from "./methods/engine-commands.js";
import {
  docClose as buildDocClose,
  docImportDataSets as buildDocImportDataSets,
  docInspect as buildDocInspect,
  docNew as buildDocNew,
  docOpen as buildDocOpen,
  docPlace as buildDocPlace,
  docSelect as buildDocSelect,
  sessionList as buildSessionList,
  type DocCloseResult,
  type DocIndexInput,
  type DocNewInput,
  type DocNewResult,
  type DocOpenInput,
  type DocOpenResult,
  type DocPlaceInput,
  type DocPlaceResult,
  type DocumentInspect,
  type DocSelectInput,
  type SessionList,
} from "./methods/document.js";
import {
  docExportDataSets as buildDocExportDataSets,
  docExportLayers as buildDocExportLayers,
  docRender as buildDocRender,
  docSave as buildDocSave,
  type DocExportDataSetsInput,
  type DocExportDataSetsResult,
  type DocExportLayersInput,
  type DocExportLayersResult,
  type DocImportDataSetsInput,
  type DocImportDataSetsResult,
  type DocRenderInput,
  type DocSaveInput,
  type DocSaveResult,
  type RenderResult,
} from "./methods/export-data-shim.js";
import {
  engineError,
  engineOk,
  engineReplyFailure,
  mapTransportThrow,
  type EngineErrorEnvelope,
  type EngineOutcome,
} from "./errors.js";
import {
  abortOutcome,
  connectAttemptPlan,
  MAX_CONNECT_ATTEMPTS,
  mutateMidCallFailure,
  shouldAutoRetry,
  type BackoffPolicy,
  type CallKind,
} from "./retry.js";
import { ProtocolConnection, type ConnectionBudget } from "./transport/connection.js";
import { DEFAULT_CALL_TIMEOUT_MS, decodeFrame, encodeFrame } from "./transport/frame.js";
import { isTransportError, type TransportError } from "./transport/errors.js";
import type { Clock, TransportSocket } from "./transport/socket.js";
import { SYSTEM_CLOCK } from "./transport/socket.js";
import type { JsonObject } from "./transport/frame.js";
import { connectionDroppedMidCall, protocolViolation } from "./transport/errors.js";

// ---------------------------------------------------------------------------
// Public option surfaces
// ---------------------------------------------------------------------------

/**
 * Structural stand-in for the DOM/Node AbortSignal: the real type satisfies it, and the
 * facade stays compilable without a DOM lib (same approach as transport/socket.ts).
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** §3.4 timeout defaults: 5 s per-tool reads, 30 s render; connect/auth gets 5 s. */
export interface EngineTimeouts {
  readonly readMs?: number;
  readonly renderMs?: number;
  readonly connectMs?: number;
}

/** The net-like socket seam (tests/fake-socket.ts): write lines, receive "data" chunks. */
export interface LineSocket {
  write(chunk: string): boolean;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "close", listener: (hadError: boolean) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  connect?(): unknown;
  destroy?(error?: Error): void;
}

/** Token source: the inline 64-hex token, a provider, or a token-file config (auth.ts). */
export type AuthOption = string | (() => string | Promise<string>) | EngineAuth;

export interface EngineClientOptions {
  /** Factory for W2-A TransportSocket instances (the engine-pool path). */
  readonly transport?: () => TransportSocket;
  /**
   * Factory for net-like JSON-lines sockets (the tests/fake-socket.ts seam; pinned by
   * tests/contract.test.ts). Exactly one of `transport`/`connect` is required.
   */
  readonly connect?: () => LineSocket;
  /**
   * Control token. Default: a fresh supervisor token via generateControlToken() — only
   * useful when the same process spawned the engine with that token (§0 spike); the
   * engine-pool always passes the session token explicitly.
   */
  readonly auth?: AuthOption;
  /** §3.4 timeout overrides (read 5 s, render 30 s, connect 5 s). */
  readonly timeouts?: EngineTimeouts;
  /** Connect-backoff knobs (retry.ts; inject `random` for deterministic tests). */
  readonly backoff?: BackoffPolicy;
  /** Injectable timers (FakeClock in tests; SYSTEM_CLOCK by default). */
  readonly clock?: Clock;
  /** Shared listener-cap budget (transport/connection.ts, 16 per listener). */
  readonly budget?: ConnectionBudget;
  readonly budgetKey?: string;
}

export interface CallOptions {
  /** 'read' may auto-retry once; 'mutate' never auto-resends (§MCP bridge). */
  readonly kind: CallKind;
  /** Overrides the §3.4 default for this call (clamped below the 55 s bridge ceiling). */
  readonly waitMs?: number;
  readonly signal?: AbortSignalLike;
}

/** Wrapper-level opts: kind is fixed by the method, callers may override time/abort. */
export interface WrapperOptions {
  readonly waitMs?: number;
  readonly signal?: AbortSignalLike;
}

/** engine.execute opts: the caller classifies the command (default 'mutate'). */
export interface ExecuteOptions extends WrapperOptions {
  readonly kind?: CallKind;
}

export class EngineClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineClientConfigError";
  }
}

// ---------------------------------------------------------------------------
// §3.4 timeout resolution (pure, exported for tests)
// ---------------------------------------------------------------------------

const DEFAULT_READ_MS = 5_000;
const DEFAULT_RENDER_MS = 30_000;
const DEFAULT_CONNECT_MS = 5_000;

/** The only methods with the §3.4 render budget (30 s): doc.render. */
const RENDER_METHODS: ReadonlySet<string> = new Set([PROTOCOL_METHODS.docRender]);

export function resolveWaitMs(
  method: string,
  waitMs: number | undefined,
  timeouts: Required<EngineTimeouts>,
): number {
  const requested =
    waitMs ?? (RENDER_METHODS.has(method) ? timeouts.renderMs : timeouts.readMs);
  // transport/frame.ts: the client call timeout stays strictly below the engine's 60 s
  // reply deadline so the client's error is the one callers see (§MCP bridge).
  return Math.max(1, Math.min(requested, DEFAULT_CALL_TIMEOUT_MS));
}

// ---------------------------------------------------------------------------
// LineSocket → TransportSocket adapter (lets the facade drive both socket seams)
// ---------------------------------------------------------------------------

/**
 * Adapts the net-like JSON-lines seam (tests/fake-socket.ts, pinned by
 * tests/contract.test.ts) onto W2-A's TransportSocket so ProtocolConnection can drive it.
 * Line buffering tolerates chunked and/or CRLF writes; decode failures surface as
 * protocol_violation, mirroring NodeNetSocket.
 */
class LineSocketAdapter implements TransportSocket {
  private readonly underlying: LineSocket;
  private readonly frameCallbacks: Array<(frame: unknown) => void> = [];
  private readonly errorCallbacks: Array<(error: TransportError) => void> = [];
  private readonly closeCallbacks: Array<(hadError: boolean) => void> = [];
  private open = false;
  private buffer = "";
  private wired = false;

  constructor(underlying: LineSocket) {
    this.underlying = underlying;
  }

  async connect(): Promise<void> {
    const connect = this.underlying.connect;
    if (typeof connect === "function") {
      try {
        await connect();
      } catch (error) {
        if (isTransportError(error)) {
          throw error;
        }
        throw protocolViolation("the line socket refused connect()", { cause: error });
      }
    }
    this.wire();
    this.open = true;
  }

  async send(frame: Parameters<TransportSocket["send"]>[0]): Promise<void> {
    if (!this.open) {
      throw protocolViolation("send() requires an open socket");
    }
    // encodeFrame enforces the 1 MiB request line BEFORE anything is written (§Transport
    // limits) and throws TransportError(frame_too_large) — nothing is sent.
    const line = encodeFrame(frame);
    this.wire();
    try {
      this.underlying.write(line);
    } catch (error) {
      // §MCP bridge: a failure while a frame is being written "may have completed".
      throw connectionDroppedMidCall("writing the request line failed", { cause: error });
    }
  }

  onFrame(callback: (frame: Parameters<TransportSocket["onFrame"]> extends never ? never : import("./transport/frame.js").FramedMessage) => void): void {
    this.frameCallbacks.push(callback as (frame: unknown) => void);
  }

  onError(callback: (error: TransportError) => void): void {
    this.errorCallbacks.push(callback);
  }

  onClose(callback: (hadError: boolean) => void): void {
    this.closeCallbacks.push(callback);
  }

  async close(): Promise<void> {
    this.open = false;
    const destroy = this.underlying.destroy;
    if (typeof destroy === "function") {
      destroy();
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  private wire(): void {
    if (this.wired) {
      return;
    }
    this.wired = true;
    this.underlying.on("data", (chunk) => this.handleChunk(chunk));
    this.underlying.on("error", (error) => {
      for (const callback of this.errorCallbacks.slice()) {
        callback(
          isTransportError(error)
            ? error
            : connectionDroppedMidCall("the connection stream failed while in use", { cause: error }),
        );
      }
    });
    this.underlying.on("close", (hadError) => {
      this.open = false;
      for (const callback of this.closeCallbacks.slice()) {
        callback(hadError);
      }
    });
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        // tolerate CRLF
      }
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.trim().length === 0) {
        continue; // rpc.rs serve_lines: blank lines are ignored
      }
      try {
        const frame = decodeFrame(trimmed);
        for (const callback of this.frameCallbacks.slice()) {
          callback(frame);
        }
      } catch (error) {
        const failure = isTransportError(error) ? error : protocolViolation("frame decoding failed");
        this.open = false;
        for (const callback of this.errorCallbacks.slice()) {
          callback(failure);
        }
        const destroy = this.underlying.destroy;
        if (typeof destroy === "function") {
          destroy();
        }
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// EngineClient
// ---------------------------------------------------------------------------

export class EngineClient {
  private readonly socketFactory: () => TransportSocket;
  private readonly inlineToken: string | null;
  private readonly tokenProvider: (() => string | Promise<string>) | null;
  private readonly engineAuth: EngineAuth | null;
  private readonly timeouts: Required<EngineTimeouts>;
  private readonly backoff: BackoffPolicy;
  private readonly clock: Clock;
  private readonly budget: ConnectionBudget | undefined;
  private readonly budgetKey: string;
  private connection: ProtocolConnection | null = null;

  constructor(options: EngineClientOptions) {
    if (typeof options.transport === "function") {
      this.socketFactory = options.transport;
    } else if (typeof options.connect === "function") {
      this.socketFactory = () => new LineSocketAdapter(options.connect!());
    } else {
      throw new EngineClientConfigError(
        "EngineClient needs a socket factory: pass `transport` (TransportSocket) or `connect` (JSON-lines socket)",
      );
    }
    const auth = options.auth;
    if (auth === undefined) {
      // Supervisor convenience only (§0 spike): real sessions pass the engine-pool token.
      this.tokenProvider = () => generateControlToken();
      this.inlineToken = null;
      this.engineAuth = null;
    } else if (typeof auth === "string") {
      if (!isControlToken(auth)) {
        throw new EngineClientConfigError(
          "inline auth must be a 64-hexadecimal-character control token (auth.ts isControlToken)",
        );
      }
      this.inlineToken = auth;
      this.tokenProvider = null;
      this.engineAuth = null;
    } else if (typeof auth === "function") {
      this.inlineToken = null;
      this.tokenProvider = auth;
      this.engineAuth = null;
    } else {
      const parsed = parseEngineAuth(auth);
      if (!parsed.ok) {
        throw new EngineClientConfigError(`engine auth config rejected: ${parsed.message}`);
      }
      this.inlineToken = null;
      this.tokenProvider = null;
      this.engineAuth = parsed.value;
    }
    const timeouts = options.timeouts ?? {};
    this.timeouts = {
      readMs: timeouts.readMs ?? DEFAULT_READ_MS,
      renderMs: timeouts.renderMs ?? DEFAULT_RENDER_MS,
      connectMs: timeouts.connectMs ?? DEFAULT_CONNECT_MS,
    };
    this.backoff = options.backoff ?? {};
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.budget = options.budget;
    this.budgetKey = options.budgetKey ?? "engine";
  }

  // -- core ----------------------------------------------------------------

  /**
   * One typed exchange. `params` must be a JSON object (or null); engine error replies
   * come back as catalog envelopes carrying the engine's verbatim text in `data` (§5.7).
   * Calls are sequential per client (one outstanding request per connection, §MCP
   * bridge); a second concurrent call fails with a non-retryable envelope.
   */
  async call<TRes = unknown>(
    method: string,
    params: unknown,
    options: CallOptions,
  ): Promise<EngineOutcome<TRes>> {
    const signal = options.signal;
    if (signal?.aborted) {
      return abortOutcome(options.kind, false);
    }
    const wireParams = normalizeParams(params);
    if (!wireParams.ok) {
      return wireParams.failure;
    }
    // Pre-flight the request line against the 1 MiB ceiling BEFORE any connection work:
    // an oversized line is refused client-side, "rejected before command dispatch" (§Transport
    // limits) — the request was never sent, so there is nothing to retry.
    try {
      encodeFrame({ kind: "request", id: 1, method, params: wireParams.value });
    } catch (error) {
      if (isTransportError(error)) {
        return engineError(error.code === "frame_too_large" ? "frame_too_large" : "engine_unavailable", {
          message: error.code === "frame_too_large" ? error.message : undefined,
          data: { source: "request_precheck", code: error.code, message: error.message },
          retryable: false,
        });
      }
      return buildFailure("invalid_params", "request params are not JSON-encodable");
    }
    const waitMs = resolveWaitMs(method, options.waitMs, this.timeouts);

    let readRetries = 0;
    let midCall: EngineErrorEnvelope | null = null;
    for (;;) {
      const acquired = await this.acquireConnection(signal, midCall);
      if (!acquired.ok) {
        return acquired;
      }
      const outcome = await this.dispatch<TRes>(
        acquired.result,
        method,
        wireParams.value,
        waitMs,
        options.kind,
        signal,
      );
      if (outcome.ok) {
        return outcome;
      }
      if (isFacadeFailure(outcome)) {
        return outcome;
      }
      const code = outcome.code;
      if (options.kind === "mutate" && code === "reply_timeout") {
        // §3.4/§MCP bridge: a mutating call that outlived its deadline may have applied;
        // never auto-resend — surface the inspect-before-retry semantics.
        return mutateMidCallFailure({ code, message: outcome.message, data: outcome.data });
      }
      if (shouldAutoRetry(options.kind, code, readRetries)) {
        readRetries += 1;
        if (code === "reply_timeout" || code === "connection_dropped_mid_call") {
          // Evidence the engine died under an in-flight request: if the fresh connection
          // cannot be established, the caller learns `engine_crashed`, not merely
          // `engine_unavailable` (§3.4 crash recovery).
          midCall = outcome;
        }
        continue; // acquireConnection builds a FRESH, freshly-authenticated connection
      }
      return outcome;
    }
  }

  /**
   * Drops any cached connection; with `reauthenticate` (default) it eagerly establishes
   * and authenticates a fresh one so the next call starts ready.
   */
  async reconnect(reauthenticate = true): Promise<EngineOutcome<void>> {
    await this.dropConnection();
    if (!reauthenticate) {
      return engineOk(undefined);
    }
    const acquired = await this.acquireConnection(undefined, null);
    return acquired.ok ? engineOk(undefined) : acquired;
  }

  /** Graceful shutdown: an in-flight call settles as connection_dropped_mid_call. */
  async close(): Promise<void> {
    await this.dropConnection();
  }

  // -- connection lifecycle ------------------------------------------------

  private async dropConnection(): Promise<void> {
    const current = this.connection;
    this.connection = null;
    if (current !== null) {
      await current.close();
    }
  }

  private async tokenForConnection(): Promise<string> {
    if (this.inlineToken !== null) {
      return this.inlineToken;
    }
    if (this.tokenProvider !== null) {
      const token = await this.tokenProvider();
      if (typeof token !== "string" || token.length === 0) {
        throw new EngineClientConfigError("the auth provider returned no usable control token");
      }
      return token;
    }
    if (this.engineAuth !== null) {
      const resolved = await resolveEngineToken(this.engineAuth);
      if (!resolved.ok) {
        throw new EngineClientConfigError(`resolving the engine token failed: ${resolved.message}`);
      }
      return resolved.value;
    }
    throw new EngineClientConfigError("no auth configured");
  }

  /**
   * Returns a READY ProtocolConnection or the failure envelope. Connect attempts back
   * off per retry.ts (max 3) and only retry failures the transport flagged retryable;
   * an explicit auth rejection fails at once. `midCall` upgrades a final connect failure
   * to engine_crashed when a previously established connection died under a request.
   */
  private async acquireConnection(
    signal: AbortSignalLike | undefined,
    midCall: EngineErrorEnvelope | null,
  ): Promise<EngineOutcome<ProtocolConnection>> {
    const current = this.connection;
    if (current !== null && current.connectionState === "ready") {
      return engineOk(current);
    }
    this.connection = null;

    let lastFailure: EngineErrorEnvelope | null = null;
    for (let failures = 0; failures < MAX_CONNECT_ATTEMPTS; failures += 1) {
      if (failures > 0) {
        const delay = connectAttemptPlan(failures - 1, this.backoff);
        if (delay !== null) {
          await sleepFor(this.clock, delay);
        }
      }
      if (signal?.aborted) {
        return abortOutcome("read", false);
      }
      let token: string;
      try {
        token = await this.tokenForConnection();
      } catch (error) {
        if (error instanceof EngineClientConfigError) {
          throw error;
        }
        throw new EngineClientConfigError("the auth provider failed");
      }
      const connection = new ProtocolConnection(this.socketFactory, {
        token,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        clock: this.clock,
        budget: this.budget,
        budgetKey: this.budgetKey,
      });
      try {
        await withDeadline(connection.connect(), this.timeouts.connectMs, this.clock);
      } catch (error) {
        if (error instanceof EngineClientConfigError) {
          throw error;
        }
        const mapped = mapTransportThrow(error);
        lastFailure = mapped;
        if (!mapped.retryable) {
          // e.g. an explicit auth rejection: retrying the same token is pointless.
          return mapped;
        }
        continue;
      }
      if (signal?.aborted) {
        await connection.close();
        return abortOutcome("read", false);
      }
      this.connection = connection;
      return engineOk(connection);
    }
    if (midCall !== null) {
      return engineError("engine_crashed", {
        data: {
          firstFailure: { code: midCall.code, message: midCall.message, data: midCall.data },
          reconnectFailure: lastFailure === null ? null : { code: lastFailure.code, message: lastFailure.message },
        },
      });
    }
    return (
      lastFailure ??
      engineError("engine_unavailable", { message: "no engine connection could be established" })
    );
  }

  // -- one exchange ----------------------------------------------------------

  private async dispatch<TRes>(
    connection: ProtocolConnection,
    method: string,
    params: JsonObject | null,
    waitMs: number,
    kind: CallKind,
    signal: AbortSignalLike | undefined,
  ): Promise<EngineOutcome<TRes>> {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: unknown = 0;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      aborted = true;
    };
    const outcome = await new Promise<EngineOutcome<TRes>>((resolve) => {
      const cleanup = (): void => {
        this.clock.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (value: EngineOutcome<TRes>): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      timer = this.clock.setTimeout(() => {
        // §3.4/§MCP bridge: no reply in time — the command may have been dispatched and
        // may still apply; drop the connection so no late reply is trusted.
        timedOut = true;
        settle(engineError("reply_timeout", { data: { source: "client_deadline", waitMs } }));
      }, waitMs);
      signal?.addEventListener("abort", onAbort);
      if (aborted) {
        settle(abortOutcome(kind, true));
        return;
      }
      connection
        .call(method, params)
        .then(
          (reply): void => {
            if (reply.ok) {
              // budgets.ts reply check (8 MiB incl. newline) — defense in depth on top of
              // the transport's own line ceiling.
              const sizeCheck = validateReplySize(JSON.stringify(reply.result));
              if (!sizeCheck.ok) {
                settle(
                  engineError("frame_too_large", {
                    data: { source: "reply_budget", message: sizeCheck.message },
                  }),
                );
                return;
              }
              settle(engineOk(reply.result as TRes));
              return;
            }
            // §5.7: the engine's own error text is data, carried verbatim.
            settle(engineReplyFailure(reply.wireError));
          },
          (reason: unknown): void => {
            settle(mapTransportThrow(reason));
          },
        )
        .catch(() => undefined);
    });
    if (aborted) {
      // An in-flight request is abandoned: drop per §MCP bridge before reporting.
      await connection.close();
      return abortOutcome(kind, true);
    }
    if (timedOut) {
      await connection.close();
      return engineError("reply_timeout", {
        data: { source: "client_deadline", waitMs, dropped: true },
      });
    }
    if (!outcome.ok && (outcome.code === "frame_too_large" || outcome.code === "engine_command_failed")) {
      const dropped = connection.connectionState !== "ready";
      if (dropped) {
        await connection.close();
      }
    }
    return outcome;
  }

  // -- typed wrappers (delegate to methods/ builders, W2-C) -------------------

  /** session.list — read: open documents and the active index. */
  sessionList(options?: WrapperOptions): Promise<EngineOutcome<SessionList>> {
    return this.executeBuilt(buildSessionList(), "read", options);
  }

  /** doc.new — mutate. */
  newDocument(input: DocNewInput = {}, options?: WrapperOptions): Promise<EngineOutcome<DocNewResult>> {
    return this.executeBuilt(buildDocNew(input), "mutate", options);
  }

  /** doc.open — mutate (changes the active document). */
  openDocument(input: DocOpenInput, options?: WrapperOptions): Promise<EngineOutcome<DocOpenResult>> {
    return this.executeBuilt(buildDocOpen(input), "mutate", options);
  }

  /** doc.place — mutate (adds a layer). */
  placeDocument(input: DocPlaceInput, options?: WrapperOptions): Promise<EngineOutcome<DocPlaceResult>> {
    return this.executeBuilt(buildDocPlace(input), "mutate", options);
  }

  /** doc.select — mutate. */
  selectDocument(input: DocSelectInput, options?: WrapperOptions): Promise<EngineOutcome<SessionList>> {
    return this.executeBuilt(buildDocSelect(input), "mutate", options);
  }

  /** doc.close — mutate. */
  closeDocument(input: DocIndexInput = {}, options?: WrapperOptions): Promise<EngineOutcome<DocCloseResult>> {
    return this.executeBuilt(buildDocClose(input), "mutate", options);
  }

  /** doc.inspect — read (§5.1 observe loop). */
  inspectDocument(input: DocIndexInput = {}, options?: WrapperOptions): Promise<EngineOutcome<DocumentInspect>> {
    return this.executeBuilt(buildDocInspect(input), "read", options);
  }

  /** doc.render — read with the §3.4 render budget (30 s default). */
  renderDocument(input: DocRenderInput = {}, options?: WrapperOptions): Promise<EngineOutcome<RenderResult>> {
    return this.executeBuilt(buildDocRender(input), "read", options);
  }

  /** doc.save — mutate (writes beneath the write root). */
  saveDocument(input: DocSaveInput, options?: WrapperOptions): Promise<EngineOutcome<DocSaveResult>> {
    return this.executeBuilt(buildDocSave(input), "mutate", options);
  }

  /** doc.exportLayers — mutate (writes files beneath the write root). */
  exportLayers(
    input: DocExportLayersInput,
    options?: WrapperOptions,
  ): Promise<EngineOutcome<DocExportLayersResult>> {
    return this.executeBuilt(buildDocExportLayers(input), "mutate", options);
  }

  /** doc.exportDataSets — mutate. */
  exportDataSets(
    input: DocExportDataSetsInput,
    options?: WrapperOptions,
  ): Promise<EngineOutcome<DocExportDataSetsResult>> {
    return this.executeBuilt(buildDocExportDataSets(input), "mutate", options);
  }

  /** doc.importDataSets — mutate. */
  importDataSets(
    input: DocImportDataSetsInput,
    options?: WrapperOptions,
  ): Promise<EngineOutcome<DocImportDataSetsResult>> {
    return this.executeBuilt(buildDocImportDataSets(input), "mutate", options);
  }

  /**
   * engine.execute — the caller classifies the command: 'mutate' (default; edits are
   * never auto-resent) or 'read' for read-only commands (document.inspect & co.), which
   * opt into the one read retry. Pass `resultSchema` to parse a known command reply.
   */
  executeCommand<TRes = unknown>(
    input: EngineExecuteInput,
    options: ExecuteOptions & { readonly resultSchema?: ZodTypeShim<TRes> } = {},
    // biome-ignore lint/suspicious/noExplicitAny: resultSchema is a zod ZodType; the
    // import above re-exports it structurally to keep this signature `any`-free.
  ): Promise<EngineOutcome<TRes>> {
    const built = buildEngineExecute(input, options.resultSchema);
    return this.executeBuilt(built, options.kind ?? "mutate", options);
  }

  /** engine.execute with wait:false — starts a background job (§Background jobs). */
  executeBackground(
    input: { readonly command: string; readonly params?: Record<string, unknown> | null },
    options?: WrapperOptions,
  ): Promise<EngineOutcome<unknown>> {
    return this.executeBuilt(buildEngineExecuteBackground(input), "mutate", options);
  }

  /** engine.commands — read: the live command registry. */
  listCommands(
    input: { readonly filter?: string } = {},
    options?: WrapperOptions,
  ): Promise<EngineOutcome<CommandListResult>> {
    return this.executeBuilt(buildEngineCommands(input), "read", options);
  }

  /** methods — read: the served method list. */
  listMethods(options?: WrapperOptions): Promise<EngineOutcome<string[]>> {
    return this.executeBuilt(buildMethodsCall(), "read", options);
  }

  /** jobs.list — read (§Background jobs: poll instead of blocking). */
  listJobs(options?: WrapperOptions): Promise<EngineOutcome<JobsListResult>> {
    return this.executeBuilt(buildJobsList(), "read", options);
  }

  /** jobs.cancel — mutate (cancels one or all running jobs). */
  cancelJobs(
    input: { readonly job?: number } = {},
    options?: WrapperOptions,
  ): Promise<EngineOutcome<JobsCancelResult>> {
    return this.executeBuilt(buildJobsCancel(input), "mutate", options);
  }

  /** batch — mutate: ordered steps, never auto-resent if the connection drops mid-call. */
  runBatch(input: BatchInput, options?: WrapperOptions): Promise<EngineOutcome<BatchResult>> {
    return this.executeBuilt(buildBatch(input), "mutate", options);
  }

  // -- shared execution ------------------------------------------------------

  /**
   * Executes one built method call (methods/protocol.ts `MethodCall`): sends the wire
   * params, validates the reply against the builder's result schema. Builder rejections
   * (invalid_params | engine_limit | unsupported) pass through untouched.
   */
  private async executeBuilt<TParams, TResult>(
    built: BuiltMethodCall<TParams, TResult>,
    kind: CallKind,
    options?: WrapperOptions,
  ): Promise<EngineOutcome<TResult>> {
    if (!isMethodCallOf(built)) {
      return built;
    }
    const call: MethodCall<TParams, TResult> = built;
    const outcome = await this.call<unknown, TResult>(call.method, call.params, {
      kind,
      waitMs: options?.waitMs,
      signal: options?.signal,
    });
    if (!outcome.ok) {
      return outcome;
    }
    const parsed = call.resultSchema.safeParse(outcome.result);
    if (!parsed.success) {
      return engineError("engine_command_failed", {
        message: "the engine reply did not match the method's result schema",
        hint: "the summary is data (§5.7); inspect or re-render before retrying",
        data: summarizeIssues(parsed.error),
      });
    }
    return engineOk(parsed.data);
  }
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function isMethodCallOf<TParams, TResult>(
  built: BuiltMethodCall<TParams, TResult>,
): built is MethodCall<TParams, TResult> {
  return built.ok;
}

function isFacadeFailure(outcome: EngineOutcome<unknown>): boolean {
  return (
    !outcome.ok &&
    typeof outcome.code === "string" &&
    !("retryable" in outcome && typeof outcome.retryable === "boolean")
  );
}

type ParamsCheck =
  | { readonly ok: true; readonly value: JsonObject | null }
  | { readonly ok: false; readonly failure: ReturnType<typeof buildFailure> };

/** The wire accepts a JSON object or nothing (rpc.rs engine.execute: "params must be a JSON object"). */
function normalizeParams(params: unknown): ParamsCheck {
  if (params === undefined || params === null) {
    return { ok: true, value: null };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    return {
      ok: false,
      failure: buildFailure("invalid_params", "call params must be a JSON object or null"),
    };
  }
  return { ok: true, value: params as JsonObject };
}

function sleepFor(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

async function withDeadline(promise: Promise<void>, ms: number, clock: Clock): Promise<void> {
  let timedOut = false;
  await Promise.race([
    promise.then(
      () => undefined,
      (reason: unknown) => {
        if (timedOut) {
          return undefined;
        }
        throw reason;
      },
    ),
    new Promise<void>((resolve) => {
      clock.setTimeout(() => {
        timedOut = true;
        resolve();
      }, ms);
    }),
  ]);
}
