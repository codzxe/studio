// Web container healthcheck (W1-K) — §17.2: every Compose service exposes a
// healthcheck; this is the web one. The gateway's own liveness lives at
// `GET /v1/health` on the gateway service (§13.1) — the two are separate.

import { NextResponse } from "next/server";

// Never cached (CDN/proxy must not serve a stale liveness answer).
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    { ok: true, service: "web" },
    { headers: { "cache-control": "no-store" } },
  );
}
