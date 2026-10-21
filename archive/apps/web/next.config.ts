// apps/web — Next.js 15 App Router config (W1-K).
//
// The web app is marketing + product UI only (§16.2 option (a) — one deploy,
// ADR-0002); it calls the separate gateway (§13) and never touches the
// engine, DB or Valkey directly (§3.1).

import type { NextConfig } from "next";

// §15.2 baseline hardening. TODO(W8): a real CSP needs a nonce middleware
// (Next inline-scripts hydration data); land it with the editor UI wave.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // TLS terminates at Caddy (§17.2); harmless on http dev, meaningful in prod.
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
];

const nextConfig: NextConfig = {
  // §17.2: the web container is built for Docker Compose — standalone keeps
  // the runtime image to server.js + traced node_modules.
  output: "standalone",
  // Only vars with this prefix are inlined into the browser bundle (the
  // default, pinned explicitly — src/lib/env.ts owns the NEXT_PUBLIC_
  // contract; server-only vars stay out of the client by construction).
  envPrefix: "NEXT_PUBLIC_",
  // Route-typed <Link href> — experimental until Next 15.5; graduate to the
  // top-level `typedRoutes` key when the version pin moves past 15.5.
  experimental: { typedRoutes: true },
  // @studio/config ships TS sources (main: ./src/index.ts) — compile it into
  // the Next bundle instead of requiring a prebuilt dist for imports.
  transpilePackages: ["@studio/config"],
  images: {
    // NOTE (§13.1): document previews and assets will be served from the
    // gateway / S3 via short-lived signed URLs — there are no remote image
    // hosts today. Wave 8 (editor UI) must add `remotePatterns` (or route
    // gateway previews through `unoptimized`) when the canvas lands. This
    // shell uses no next/image and commits no image/font files (§1.5).
    remotePatterns: [],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
