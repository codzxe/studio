// tests/reference-transport.ts — a minimal JSON-lines control-protocol transport.
//
// W2-E owns tests/** + fixtures/**; `src/` (the real EngineClient, W2-D) is authored in
// parallel. Per the task's fallback ("if missing at authoring time, test the transport +
// methods layers directly and note it"), this file is the executable protocol spec the
// contract tests drive against FakeSocket: correlation, error paths and client-side
// budget enforcement, all pinned to vendor/photocraft/crates/automation/src/rpc.rs and
// security.rs. When src lands, contract.test.ts exercises the real EngineClient with
// the same fixtures and FakeSocket; this reference stays usable by other packages' tests
// (no @studio dependencies beyond zod) and as an oracle for the client's behaviour.

import { envelopeSchema, MAX_BATCH_STEPS, MAX_REPLY_BYTES, MAX_REQUEST_BYTES } from "./protocol-schemas.js";

/** Typed transport failure. Never a bare string throw (AGENTS.md error style). */
export class EngineTransportError extends Error {
  readonly code: "engine_error" | "connection_closed" | "budget_exceeded" | "protocol_violation";
  readonly engineMessage?: string;

  constructor(
    code: EngineTransportError["code"],
    message: string,
    options: { engineMessage?: string; cause?: Error } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "EngineTransportError";
    this.code = code;
    this.engineMessage = options.engineMessage;
  }
}

export type WireReply = {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: EngineTransportError) => void;
}

/** The socket surface a JSON-lines client needs (FakeSocket satisfies it 1:1). */
export interface TransportSocket {
  write(chunk: string): boolean;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "close", listener: (hadError: boolean) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface JsonLinesTransportOptions {
  maxRequestBytes?: number;
  maxReplyBytes?: number;
  maxBatchSteps?: number;
}

/**
 * One JSON-lines connection: newline-framed `{"id","method","params"}` requests,
 * newline-framed `{"id","ok","result"|"error"}` replies (docs/control-protocol.md).
 *
 * Protocol-faithful details under test:
 *   - replies are matched strictly by `id`; `id: null` replies (bad JSON, oversized
 *     request) are connection-level notices and never resolve a pending call;
 *   - unknown ids are recorded as orphans and ignored;
 *   - `ok: false` rejects with the server's error string, not a thrown string;
 *   - a request line larger than MAX_REQUEST_BYTES is refused client-side before it is
 *     written (the server rejects it and TCP closes the connection);
 *   - a reply line larger than MAX_REPLY_BYTES is a protocol violation and fails every
 *     pending call (the server caps replies itself — budgets.rs);
 *   - close/destroy rejects all pending calls with `connection_closed`.
 */
export class JsonLinesTransport {
  private readonly socket: TransportSocket;
  private readonly maxRequestBytes: number;
  private readonly maxReplyBytes: number;
  private readonly maxBatchSteps: number;

  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private closed = false;

  /** Transport-level replies with id null (recorded, never resolved into a call). */
  readonly notices: WireReply[] = [];
  /** Replies whose id matched no pending call (a correct client ignores them). */
  readonly orphans: WireReply[] = [];
  /** Raw server lines that failed envelope validation. */
  readonly malformedLines: string[] = [];

  constructor(socket: TransportSocket, options: JsonLinesTransportOptions = {}) {
    this.socket = socket;
    this.maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
    this.maxReplyBytes = options.maxReplyBytes ?? MAX_REPLY_BYTES;
    this.maxBatchSteps = options.maxBatchSteps ?? MAX_BATCH_STEPS;

    socket.on("data", (chunk) => {
      this.onData(chunk);
    });
    socket.on("close", () => {
      this.failAllPending(new EngineTransportError("connection_closed", "engine connection closed"));
    });
    socket.on("error", (error) => {
      this.failAllPending(new EngineTransportError("connection_closed", "engine connection failed", { cause: error }));
    });
  }

  /** Send one request and resolve its `result` (or reject with the `error` string). */
  call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const line = `${JSON.stringify({ id, method, params })}\n`;

    if (line.length > this.maxRequestBytes) {
      // The server would reject this line and (on TCP) drop the connection — refuse locally.
      return Promise.reject(
        new EngineTransportError("budget_exceeded", `request exceeds ${this.maxRequestBytes} bytes`),
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(JSON.stringify(id), {
        resolve: (value) => {
          resolve(value);
        },
        reject,
      });
      if (this.closed || this.socket.write(line) === false) {
        this.failAllPending(new EngineTransportError("connection_closed", "engine connection is not writable"));
      }
    });
  }

  /**
   * `batch {steps}` with the client-side step guard: the server refuses more than
   * MAX_BATCH_STEPS steps (security.rs; error "batch contains N steps; maximum is 256"),
   * so a client must fail fast before writing anything.
   */
  async batch(steps: ReadonlyArray<unknown>): Promise<unknown> {
    if (steps.length > this.maxBatchSteps) {
      throw new EngineTransportError(
        "budget_exceeded",
        `batch contains ${steps.length} steps; maximum is ${this.maxBatchSteps}`,
      );
    }
    return this.call("batch", { steps });
  }

  /** `auth` — the first frame on every TCP connection (docs/control-protocol.md). */
  async auth(token: string): Promise<{ authenticated: true }> {
    return (await this.call("auth", { token })) as { authenticated: true };
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxReplyBytes) {
      this.failAllPending(new EngineTransportError("protocol_violation", "reply line exceeds budget"));
    }
  }

  private onLine(line: string): void {
    if (line.length > this.maxReplyBytes) {
      this.failAllPending(new EngineTransportError("protocol_violation", "reply line exceeds budget"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.malformedLines.push(line);
      this.failAllPending(
        new EngineTransportError("protocol_violation", "reply line is not valid JSON", { cause: error as Error }),
      );
      return;
    }
    const reply = envelopeSchema.safeParse(parsed);
    if (!reply.success) {
      this.malformedLines.push(line);
      this.failAllPending(new EngineTransportError("protocol_violation", "reply failed envelope validation"));
      return;
    }
    const wire = reply.data;
    if (wire.id === null) {
      this.notices.push(wire);
      return; // transport-level error: belongs to no request
    }
    const key = JSON.stringify(wire.id);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      this.orphans.push(wire);
      return;
    }
    this.pending.delete(key);
    if (wire.ok) {
      pending.resolve("result" in wire ? wire.result : undefined);
    } else {
      pending.reject(
        new EngineTransportError("engine_error", wire.error ?? "engine error", { engineMessage: wire.error }),
      );
    }
  }

  private failAllPending(error: EngineTransportError): void {
    this.closed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(error);
    }
  }
}
