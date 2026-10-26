// /v1/* catch-all — the embedded gateway route (§7.2 same-origin API).
//
// Production serves the gateway INSIDE the Next runtime: every /v1 request
// goes straight to the prebuilt gateway bundle (api/gateway.mjs, regenerated
// by `pnpm build` from api-src/gateway.ts — see that file for why the gateway
// is bundled ahead of time instead of imported as source). The Request/Response
// are web-standard on both sides, so no adapter is needed: cookies, SSE
// streaming and idempotency semantics pass through untouched.
//
// Dev (pnpm dev) instead rewrites /v1/* to the standalone gateway on
// GATEWAY_INTERNAL_URL (next.config.ts dev-only rewrite); afterFiles rewrites
// run before dynamic routes, so the two modes never collide. If the gateway
// is not running in dev, requests fall through to this route and fail fast
// with the §7.3 envelope (env parse / db connect).

import { gatewayFetch } from "../../../../api/gateway.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = gatewayFetch;
export const POST = gatewayFetch;
export const PUT = gatewayFetch;
export const PATCH = gatewayFetch;
export const DELETE = gatewayFetch;
export const HEAD = gatewayFetch;
export const OPTIONS = gatewayFetch;
