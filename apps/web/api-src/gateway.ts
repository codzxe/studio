// apps/web — Vercel serverless gateway adapter (§14 deployment, serverless box).
//
// Zero-config function: Vercel mounts this file at `/api/gateway`, compiled
// by @vercel/node (esbuild) SEPARATELY from the Next build — the Next
// app/Turbopack graph never sees the gateway source (no vendor-shim leakage).
// The web app proxies every browser/RSC `/v1/*` request here via the
// production next.config rewrite, which carries the gateway path in the `p`
// query parameter:
//
//   https://<web>/v1/auth/sign-up
//     -> (Next rewrite, server-side proxy — cookies/origin preserved)
//   https://<gateway>/api/gateway?p=auth/sign-up
//     -> (this adapter rebuilds the full /v1 request)
//   Hono app /v1/auth/sign-up
//
// All other query parameters of the original request (tokens, cursors…) are
// forwarded untouched. The adapter is the ONLY Vercel-specific surface: the
// gateway itself (handler.ts) stays a plain (Request) => Promise<Response>.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { gatewayFetch } from "../../../services/gateway/src/handler.js";

/** Hop-by-hop / transport headers owned by the lambda runtime, never copied. */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Rebuild the upstream `/v1/...` URL: `p` param first, request path fallback. */
function upstreamUrl(requestUrl: string | undefined): URL {
  const origin = process.env.APP_URL ?? "http://127.0.0.1";
  const url = new URL(requestUrl ?? "/", origin);

  let path: string | undefined = url.searchParams.get("p") ?? undefined;
  if (path !== undefined) {
    path = `/v1/${path.replace(/^\/+/, "")}`;
  } else {
    // Direct invocation (health probes, curl): /api/* strips the mount, any
    // other path passes through; both then get the /v1 prefix Hono expects.
    const raw = url.pathname.startsWith("/api") ? url.pathname.slice("/api".length) : url.pathname;
    path = raw.startsWith("/v1") ? raw : `/v1${raw}`;
  }

  const search = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key !== "p") search.append(key, value);
  }
  const query = search.toString();
  return new URL(`${origin}${path}${query === "" ? "" : `?${query}`}`);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = upstreamUrl(req.url);
  const method = (req.method ?? "GET").toUpperCase();

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }

  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (METHODS_WITH_BODY.has(method) && req.readableLength !== 0) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  let response: Response;
  try {
    response = await gatewayFetch(new Request(url, init));
  } catch (error) {
    // EnvFatalError and friends already print safely; never echo values.
    const message = error instanceof Error ? error.message : "gateway build failed";
    // biome-ignore lint/suspicious/noConsole: function entrypoint must report build failures to the lambda log
    console.error("[gateway] request handling failed:", message);
    res.writeHead(503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "SERVICE_UNAVAILABLE", message: "Try again in a moment.", retryable: true },
      }),
    );
    return;
  }

  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders[key] = value;
  });
  res.writeHead(response.status, outHeaders);

  if (response.body === null) {
    res.end();
    return;
  }
  // Pass-through streaming (SSE chat included).
  const stream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );
  stream.on("error", () => {
    res.destroy();
  });
  stream.pipe(res);
}
