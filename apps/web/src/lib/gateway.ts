import type { Err, Ok } from "@studio/contracts";
import { cookies } from "next/headers";

/**
 * `gatewayCall` — the RSC/route-handler seam for the gateway's `/v1` API
 * (PRODUCT_ARCHITECTURE §7.2/§7.3).
 *
 * Server-side ONLY (imports `next/headers`). Browser-side calls never use
 * this module: they stay same-origin (`createApiClient({ baseUrl: "/v1" })`
 * from `@studio/api-client`; Caddy fronts `/v1` in production — see
 * apps/web/README.md §Env).
 *
 * - Base URL: `process.env.GATEWAY_INTERNAL_URL` (default
 *   `http://127.0.0.1:8787`); the path is the full `/v1/...` route.
 * - Forwards every request cookie (in particular the better-auth session
 *   cookie, `better-auth.session_token`) as the `cookie` header — the
 *   gateway's auth middleware reads the session from it.
 * - `workspaceId` becomes the `x-workspace-id` header the gateway's
 *   `requireWorkspace` middleware requires (org id or slug).
 * - Unwraps the §7.3 envelope: `Ok` → the `data`, `Err` → a typed
 *   {@link GatewayHttpError} (status, stable code, requestId, safe
 *   message/hint). Non-envelope or unparseable bodies are normalized to a
 *   generic, sanitized error — raw response text, internal paths, upstream
 *   URLs and object keys never surface (§7.3).
 *
 * `@studio/contracts` is imported as `import type` ONLY (Turbopack
 * constraint: runtime imports of the NodeNext contracts barrel are
 * forbidden from apps/web); the envelope guards below restate the §7.3
 * shape instead of importing the runtime helpers.
 */

const DEFAULT_GATEWAY_INTERNAL_URL = "http://127.0.0.1:8787";

// ── Round 5: the in-process gateway seam ────────────────────────────────────
//
// Production-on-Vercel posture: the gateway is mounted INSIDE this Next
// runtime (src/app/v1/[...path]/route.ts serves the prebuilt api/gateway.mjs
// bundle). With GATEWAY_INLINE=true this seam calls THAT SAME bundle
// in-process — `gatewayFetch(new Request(…))` — instead of a full HTTPS
// round-trip to GATEWAY_INTERNAL_URL (the deployment's own public URL),
// which cold-started a SECOND serverless invocation and roughly doubled
// every RSC page's latency (measured: /onboarding ≈ 3.4 s cold, /w ≈ 0.75 s
// per hop). One module specifier on both sides ⇒ the bundler resolves both
// imports to ONE module instance ⇒ one memoized app + one db pool.
//
// Dev (`pnpm dev`) and the self-hosted topology (infra/caddy fronts a
// separate gateway process) keep the HTTP path — GATEWAY_INLINE is unset.
const INLINE_GATEWAY = process.env.GATEWAY_INLINE === "true";

/** Cosmetic absolute origin for the synthesized in-process Request (Hono routes on the pathname). */
function inlineOrigin(): string {
  const url = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";
  return url.replace(/\/+$/, "");
}

/** Per-request options for {@link gatewayCall}. */
export interface GatewayRequestInit {
  /** Workspace id or slug → `x-workspace-id` (requireWorkspace reads it). */
  readonly workspaceId?: string;
  /** HTTP method; defaults to `GET`. */
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** JSON-encoded request body (sets `content-type: application/json`). */
  readonly body?: unknown;
  /** §7.2 idempotency key for mutations (the gateway requires one). */
  readonly idempotencyKey?: string;
  /** Cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Typed gateway failure — the §7.3 `Err` body (or a sanitized stand-in when
 * no envelope arrived). Safe to render: `message`/`hint` never contain raw
 * response bodies, internal paths or object keys.
 */
export class GatewayHttpError extends Error {
  /** HTTP status; `0` never happens here (network errors rethrow fetch's TypeError — see {@link gatewayCall}). */
  readonly status: number;
  /** Stable §7.3 wire code (or `INTERNAL_ERROR`/`MALFORMED_RESPONSE` stand-ins). */
  readonly code: string;
  /** Correlates with the gateway's request log. */
  readonly requestId: string;
  /** Actionable next step, safe to show. */
  readonly hint?: string;
  /** Safe to retry after a pause? */
  readonly retryable: boolean;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    hint?: string;
    retryable?: boolean;
  }) {
    super(init.message);
    this.name = "GatewayHttpError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? "req_unknown";
    this.hint = init.hint;
    this.retryable = init.retryable ?? false;
  }

  /** §12.1/hard-rule 3 semantics: missing or cross-tenant → 404, never 403. */
  get isNotFound(): boolean {
    return this.status === 404 || this.code === "NOT_FOUND" || this.code === "WORKSPACE_NOT_FOUND";
  }
}

export function isGatewayHttpError(error: unknown): error is GatewayHttpError {
  return error instanceof GatewayHttpError;
}

/** Hard rule 3: missing/cross-tenant lookups are 404s. */
export function isGatewayNotFound(error: unknown): boolean {
  return isGatewayHttpError(error) && error.isNotFound;
}

// ---------------------------------------------------------------------------
// §7.3 envelope (type-only restatement — no runtime contracts import)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOkEnvelope(value: unknown): value is Ok<unknown> {
  return isRecord(value) && "data" in value && !("error" in value);
}

function isErrEnvelope(value: unknown): value is Err {
  return (
    isRecord(value) &&
    !("data" in value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

/** Generic, sanitized messages when the body is not a §7.3 envelope. */
const GENERIC_MESSAGES: Readonly<Record<number, string>> = {
  400: "That request didn't look right.",
  401: "Your session may have expired.",
  403: "You don't have permission to do that.",
  404: "Not found.",
  429: "Too many requests. Slow down for a moment, then retry.",
};

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

function gatewayBaseUrl(): string {
  const url = process.env.GATEWAY_INTERNAL_URL ?? DEFAULT_GATEWAY_INTERNAL_URL;
  return url.replace(/\/+$/, "");
}

/** The forwarded `cookie` header for this RSC request ("" when none). */
async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * One gateway call: envelope unwrap into `T`. Throws {@link GatewayHttpError}
 * for every §7.3 `Err` and for non-envelope bodies (sanitized); network
 * failures reject with the fetch error itself.
 */
export async function gatewayCall<T = unknown>(
  path: string,
  init: GatewayRequestInit = {},
): Promise<T> {
  if (!path.startsWith("/v1/") && path !== "/v1") {
    throw new Error(`gatewayCall: path must be the full /v1 route, got ${JSON.stringify(path)}`);
  }
  const url = `${gatewayBaseUrl()}${path}`;

  const headers = new Headers({ accept: "application/json" });
  const cookie = await cookieHeader();
  if (cookie !== "") headers.set("cookie", cookie);
  if (init.workspaceId !== undefined) headers.set("x-workspace-id", init.workspaceId);
  if (init.idempotencyKey !== undefined) headers.set("Idempotency-Key", init.idempotencyKey);

  const request: RequestInit = {
    method: init.method ?? "GET",
    headers,
    signal: init.signal,
    // RSC data is per-request; the gateway signs fresh URLs on every read.
    cache: "no-store",
  };
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    request.body = JSON.stringify(init.body);
  }

  let response: Response;
  if (INLINE_GATEWAY) {
    // In-process: same specifier as src/app/v1/[...path]/route.ts (one module
    // instance). Headers/body below (cookie, x-workspace-id, Idempotency-Key)
    // are forwarded verbatim — the gateway validates the session itself.
    const { gatewayFetch } = await import("../../api/gateway.mjs");
    response = await gatewayFetch(new Request(`${inlineOrigin()}${path}`, request));
  } else {
    response = await fetch(url, request);
  }
  const status = response.status;
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  if (bodyText === "") {
    if (status >= 200 && status < 300) return undefined as T;
    throw new GatewayHttpError({
      status,
      code: status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR",
      message: GENERIC_MESSAGES[status] ?? "Something went wrong on our side.",
      hint: status === 401 ? "Sign in again." : "Try again in a moment.",
      retryable: status === 429 || status >= 500,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // §7.3: never surface raw bodies.
    throw new GatewayHttpError({
      status,
      code: "MALFORMED_RESPONSE",
      message: GENERIC_MESSAGES[status] ?? "Something went wrong on our side.",
      hint: "Try again in a moment.",
      retryable: status >= 500,
    });
  }

  if (isErrEnvelope(parsed)) {
    const error = parsed.error;
    throw new GatewayHttpError({
      status,
      code: error.code,
      message: error.message,
      requestId: typeof error.requestId === "string" ? error.requestId : undefined,
      hint: typeof error.hint === "string" ? error.hint : undefined,
      retryable: error.retryable === true,
    });
  }

  if (isOkEnvelope(parsed)) {
    if (status < 200 || status >= 300) {
      // A 2xx envelope on an error status is a gateway bug — sanitized.
      throw new GatewayHttpError({
        status,
        code: "MALFORMED_RESPONSE",
        message: "Something went wrong on our side.",
        hint: "Try again in a moment.",
        retryable: true,
      });
    }
    return parsed.data as T;
  }

  throw new GatewayHttpError({
    status,
    code: "MALFORMED_RESPONSE",
    message: GENERIC_MESSAGES[status] ?? "Something went wrong on our side.",
    hint: "Try again in a moment.",
    retryable: status >= 500,
  });
}
