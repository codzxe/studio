// Test helpers: envelope Responses, SSE responses and controlled streams.
// Node >=22 provides Response/ReadableStream/TextEncoder natively.

import { ok } from "@studio/contracts";

export interface RecordedCall {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

export type FakeFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A fetch double that records every call and replays scripted handlers. */
export function fetchRecorder(handler: FakeFetch): {
  readonly calls: RecordedCall[];
  readonly fetch: FakeFetch;
} {
  const calls: RecordedCall[] = [];
  const fetch: FakeFetch = async (input, init) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  return { calls, fetch };
}

/** Scripted responses, one per call (last one repeats). */
export function queueResponses(...responses: Response[]): {
  calls: RecordedCall[];
  fetch: FakeFetch;
} {
  let index = 0;
  return fetchRecorder(() => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response === undefined
      ? Promise.reject(new TypeError("fetch failed"))
      : Promise.resolve(response);
  });
}

export function jsonOk(data: unknown, status = 200, meta?: Record<string, unknown>): Response {
  const body = JSON.stringify(meta === undefined ? ok(data) : ok(data, meta));
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

export function jsonErr(
  status: number,
  body: { code: string; message: string; hint?: string; retryable?: boolean; requestId?: string },
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: body.code,
        message: body.message,
        ...(body.hint === undefined ? {} : { hint: body.hint }),
        retryable: body.retryable ?? false,
        requestId: body.requestId ?? "req_test_0000000000000000000000",
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export function textResponse(status: number, body: string, contentType: string): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

const encoder = new TextEncoder();

/** A 200 text/event-stream Response that enqueues `chunks` and closes. */
export function sseResponse(chunks: readonly (string | Uint8Array)[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        if (typeof chunk === "string") controller.enqueue(encoder.encode(chunk));
        else controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export interface ControlledStream {
  readonly response: Response;
  enqueue(text: string): void;
  fail(error: Error): void;
  close(): void;
}

/** A live 200 event-stream the test can enqueue into over time. */
export function controlledStream(): ControlledStream {
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    enqueue(text) {
      try {
        sink?.enqueue(encoder.encode(text));
      } catch {
        // reader already cancelled (terminal event) — fine
      }
    },
    fail(error) {
      try {
        sink?.error(error);
      } catch {
        // already closed/cancelled
      }
    },
    close() {
      try {
        sink?.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Splits text into byte chunks of `size` bytes (chunk-boundary torture). */
export function byteChunks(text: string, size: number): string[] {
  const bytes = encoder.encode(text);
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < bytes.length; i += size) {
    const slice = bytes.subarray(i, Math.min(i + size, bytes.length));
    // TextDecoder never splits a code point when slicing the *stream* — emulate
    // by decoding with the fatal stream flag off; multi-byte chars split across
    // chunk boundaries are handled by the parser's streaming decoder instead,
    // so feed raw bytes back as typed arrays via sseBytes below when needed.
    chunks.push(decoder.decode(slice, { stream: true }));
  }
  return chunks;
}

/** Raw byte chunks (may split UTF-8 code points) for parser torture tests. */
export function byteChunkArrays(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return chunks;
}

/** SSE-frames `payloads` as `data:` lines. */
export function sseLines(...payloads: unknown[]): string {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
}
