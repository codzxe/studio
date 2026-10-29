// @studio/gateway — route class resolution for rate limiting (§7.1).
//
// auth 10/min · chat 20/min · mutations 60/min · reads 240/min (W2-b spec).

import type { RouteClass } from "./rate-limit.js";

export function routeClassFor(method: string, path: string): RouteClass {
  if (path.startsWith("/v1/auth/") || path === "/v1/auth") return "auth";
  // AUD-A6 (2026-10-30 deep audit): the 20/min "chat" bucket used to match
  // the UNMOUNTED round-10 /chat route — every expensive live endpoint
  // (model turns, metered generative tools, render queueing) fell into the
  // loose 60/min mutation bucket. The turn route IS the chat surface now.
  if (method === "POST" && /^\/v1\/threads\/[^/]+\/(chat|turn)$/.test(path)) return "chat";
  if (method === "POST" && /^\/v1\/threads\/[^/]+\/tools\//.test(path)) return "chat";
  if (method === "POST" && path === "/v1/renders") return "chat";
  if (method === "GET" || method === "HEAD") return "read";
  return "mutation";
}
