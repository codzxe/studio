// apps/web — typed gateway fetch core (W1-K; split out of src/lib/api.ts by W8-O).
//
// The web app talks to the backend ONLY through src/lib/api/* (spec §13; the
// gateway is a separate service — §3.1). Every non-2xx response is unwrapped
// from its typed `{ ok:false, code, message, hint, … }` envelope into a thrown
// `ApiError` — callers never inspect raw payloads.
//
// Envelope note: the gateway (W1-H) emits the FLAT `ok:false` shape mandated
// by docs/AGENTS.md; spec §13.3 sketches the same fields nested under
// `error: { … }`. Both are accepted here until the contract wave reconciles
// them — the shape is a server detail, never the caller's problem.
//
// Hermetic by design: no module-scope env access (lazy `getDefaultGatewayClient`
// memo + `createGatewayClientFromEnv` read env on first CALL), `fetch` is
// injectable, and the SSE wire schema is a local mirror of §13.2 (see sse.ts)
// so unit tests never touch the network or the filesystem.
//
// W8-O additions over the W1-K core (all additive, kept API-compatible):
//   - `auth` option: session-cookie default (§13 Better Auth cookie rides
//     `credentials: "include"`) or a bearer API-key seam for machine clients;
//   - `createIdempotencyKey()` helper (§13 mutating header) with a fallback
//     for non-secure browser contexts;
//   - `timeoutMs` plumbing (client default + per-request override) composed
//     with the caller's AbortSignal.

import { z } from "zod";
import { getClientEnv, type EnvSource } from "../env";
import { RunEventStream, type RunEventStreamOptions } from "./sse";

// ---------------------------------------------------------------------------
// Errors — flat envelope unwrap → ApiError (§13.3 codes)
// ---------------------------------------------------------------------------

/** Typed transport error — mirrors the gateway envelope (§13.3 codes). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly docsUrl: string | undefined;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    hint?: string;
    retryable?: boolean;
    docsUrl?: string;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.hint = init.hint;
    this.retryable = init.retryable ?? false;
    this.docsUrl = init.docsUrl;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// Flat shape (gateway W1-H + docs/AGENTS.md code style).
const flatErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean().optional(),
  docs_url: z.string().optional(),
});

// Nested shape (§13.3 wire example) — tolerated, not produced by the gateway.
const nestedErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    retryable: z.boolean().optional(),
    docs_url: z.string().optional(),
  }),
});

/**
 * Turn a non-2xx response body into an ApiError WITHOUT leaking internals:
 * unrecognized bodies collapse to a generic `unexpected_response`.
 *
 * @internal consumed by ./sse.ts (RunEventStream reconnect loop) — exported
 * only because the SSE module must unwrap envelopes without importing the
 * full client; it is NOT part of the public caller surface.
 */
export function toApiError(status: number, body: unknown): ApiError {
  const flat = flatErrorEnvelopeSchema.safeParse(body);
  if (flat.success) {
    return new ApiError({
      code: flat.data.code,
      message: flat.data.message,
      status,
      hint: flat.data.hint,
      retryable: flat.data.retryable ?? status >= 500,
      docsUrl: flat.data.docs_url,
    });
  }
  const nested = nestedErrorEnvelopeSchema.safeParse(body);
  if (nested.success) {
    return new ApiError({
      code: nested.data.error.code,
      message: nested.data.error.message,
      status,
      hint: nested.data.error.hint,
      retryable: nested.data.error.retryable ?? status >= 500,
      docsUrl: nested.data.error.docs_url,
    });
  }
  return new ApiError({
    code: "unexpected_response",
    message: "The server returned an unexpected response.",
    status,
    retryable: status >= 500,
  });
}

/**
 * Best-effort JSON body read for error envelopes; a non-JSON body is treated
 * as "no envelope" so `toApiError` collapses it generically (§13.3: never
 * leak internals).
 *
 * @internal shared with ./sse.ts.
 */
export async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gateway client
// ---------------------------------------------------------------------------

/** Injectable fetch (tests pass a fake; production uses the global). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Auth injection seam (§13 auth). Default is the Better Auth session cookie
 * (it rides `credentials: "include"`); `bearer` switches the client to an
 * `Authorization: Bearer <token>` header with cookies omitted — the seam for
 * machine/API-key callers. TODO(W8-B): when the auth wave lands, build the
 * production client with the session default; do NOT read tokens from env here.
 */
export type GatewayAuth =
  | { readonly type: "session-cookie" }
  | { readonly type: "bearer"; readonly token: string };

export interface GatewayClient {
  /** Versioned base (no trailing slash), e.g. `http://localhost:8787/v1`. */
  readonly baseUrl: string;
  /** Low-level request; unwraps error envelopes into thrown ApiError. */
  request<T>(path: string, options?: RequestOptions<T>): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions<T>, "method">): Promise<T>;
  post<T>(path: string, options?: Omit<RequestOptions<T>, "method">): Promise<T>;
  /** SSE stream of run progress events (§13.1 `GET /v1/runs/:id/events`). */
  streamRunEvents(options: RunEventStreamOptions): RunEventStream;
}

export interface RequestOptions<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /**
   * Zod schema for a successful response body — pass one at every call site
   * you rely on ("Zod at every boundary"); without it the parsed JSON is
   * returned with an unchecked `as T` cast.
   */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  headers?: Record<string, string>;
  /** §13: mutating calls carry an `Idempotency-Key` (auto-generated UUID). */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /**
   * W8-O: per-request timeout covering connection + server processing
   * (time-to-headers). Composed with `signal` — either aborts the fetch.
   * Overrides the client-level `timeoutMs`. The timeout surfaces as a
   * retryable `timeout` ApiError; a caller-side abort keeps the W1-K
   * `network_error` mapping.
   */
  timeoutMs?: number;
}

export interface GatewayClientOptions {
  /** Gateway base INCLUDING `/v1` (see .env.example — NEXT_PUBLIC_API_BASE_URL). */
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly defaultHeaders?: Record<string, string>;
  /** Auth seam (W8-O) — defaults to the §13 session cookie. */
  readonly auth?: GatewayAuth;
  /** Client-wide default request timeout; per-request `timeoutMs` wins. */
  readonly timeoutMs?: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Idempotency-Key helper (§13: every mutating endpoint carries one)
// ---------------------------------------------------------------------------

/**
 * Mint an RFC 4122 v4 idempotency key. `crypto.randomUUID` needs a secure
 * context (or Node ≥ 19); the fallback keeps the header present on plain-HTTP
 * LAN previews — collision odds remain negligible for retry dedupe (§3.4).
 */
export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  const group = (from: number, to: number) => hex.slice(from, to).join("");
  return `${group(0, 4)}-${group(4, 6)}-${group(6, 8)}-${group(8, 10)}-${group(10, 16)}`;
}

// ---------------------------------------------------------------------------
// Timeout + AbortSignal plumbing (W8-O)
// ---------------------------------------------------------------------------

interface TimeoutWatch {
  /** Composed signal — aborts on EITHER the caller's signal or the timer. */
  readonly signal: AbortSignal;
  /** True when the timer (not the caller) fired — picks the `timeout` error. */
  timedOut(): boolean;
  /** Stop the timer; idempotent (call after headers arrive and on throw). */
  cleanup(): void;
}

function composeTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): TimeoutWatch | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => {
    controller.abort();
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let done = false;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const baseUrl = trimTrailingSlash(options.baseUrl);
  const fetchFn: FetchLike =
    options.fetch ??
    ((input, init) => {
      // Better Auth session cookie travels with every call (§13 auth).
      return fetch(input, init);
    });
  const auth: GatewayAuth = options.auth ?? { type: "session-cookie" };
  const bearerToken = auth.type === "bearer" ? auth.token : undefined;
  // Bearer callers authenticate via the header; cookies are deliberately
  // omitted so a browser session can never ride an API-key request.
  const credentials: RequestCredentials = bearerToken !== undefined ? "omit" : "include";

  async function request<T>(path: string, requestOptions?: RequestOptions<T>): Promise<T> {
    const method = requestOptions?.method ?? "GET";
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(bearerToken !== undefined ? { authorization: `Bearer ${bearerToken}` } : {}),
      ...(options.defaultHeaders ?? {}),
      ...(requestOptions?.headers ?? {}),
    };
    if (requestOptions?.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (method !== "GET") {
      // §13: every mutating endpoint requires an Idempotency-Key header
      // (or derives one from a client-generated UUID).
      headers["Idempotency-Key"] = requestOptions?.idempotencyKey ?? createIdempotencyKey();
    }

    const watch = composeTimeout(
      requestOptions?.signal,
      requestOptions?.timeoutMs ?? options.timeoutMs,
    );
    const signal = watch?.signal ?? requestOptions?.signal;

    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers,
        credentials,
        ...(requestOptions?.body !== undefined
          ? { body: JSON.stringify(requestOptions.body) }
          : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch {
      watch?.cleanup();
      if (watch?.timedOut() === true) {
        throw new ApiError({
          code: "timeout",
          message: "The server took too long to respond.",
          status: 0,
          retryable: true,
        });
      }
      // Network failure / caller abort — typed, retryable, no raw internals.
      throw new ApiError({
        code: "network_error",
        message: "Could not reach the server.",
        status: 0,
        retryable: true,
      });
    }
    watch?.cleanup();

    if (!response.ok) {
      throw toApiError(response.status, await readJsonBody(response));
    }

    const text = await response.text();
    if (text === "") {
      return undefined as T; // 200/204 with no body (e.g. sign-out)
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError({
        code: "unexpected_response",
        message: "The server returned an unexpected response.",
        status: response.status,
        retryable: false,
      });
    }
    if (requestOptions?.schema !== undefined) {
      return requestOptions.schema.parse(json); // contract drift throws ZodError
    }
    return json as T;
  }

  return {
    baseUrl,
    request,
    get: (path, requestOptions) => request(path, { ...requestOptions, method: "GET" }),
    post: (path, requestOptions) => request(path, { ...requestOptions, method: "POST" }),
    streamRunEvents: (streamOptions) =>
      new RunEventStream(
        {
          baseUrl,
          fetch: fetchFn,
          credentials,
          ...(bearerToken !== undefined
            ? { headers: { authorization: `Bearer ${bearerToken}` } }
            : {}),
        },
        streamOptions,
      ),
  };
}

/** Factory wired to the NEXT_PUBLIC_ env contract (src/lib/env.ts). */
export function createGatewayClientFromEnv(source?: EnvSource): GatewayClient {
  return createGatewayClient({ baseUrl: getClientEnv(source).apiBaseUrl });
}

let defaultClient: GatewayClient | undefined;

/**
 * W8-O: one lazily-built gateway client per runtime context (memoized — the
 * env read happens on first CALL, never at import/prerender time, per the
 * src/lib/env.ts contract). The shared hooks layer (./hooks.ts) builds its
 * query/mutation closures on this accessor.
 */
export function getDefaultGatewayClient(): GatewayClient {
  defaultClient ??= createGatewayClientFromEnv();
  return defaultClient;
}
