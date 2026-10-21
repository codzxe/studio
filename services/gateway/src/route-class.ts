// @studio/gateway — route class resolution for rate limiting (§7.1).
//
// auth 10/min · chat 20/min · mutations 60/min · reads 240/min (W2-b spec).

import type { RouteClass } from "./rate-limit.js";

export function routeClassFor(method: string, path: string): RouteClass {
  if (path.startsWith("/v1/auth/") || path === "/v1/auth") return "auth";
  if (method === "POST" && /^\/v1\/threads\/[^/]+\/chat$/.test(path)) return "chat";
  if (method === "GET" || method === "HEAD") return "read";
  return "mutation";
}
