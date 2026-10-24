import type { NextConfig } from "next";

/**
 * Editor serving model (docs/PRODUCT_ARCHITECTURE.md §6.1/§14):
 *
 * - Production: the static server in front of the box (Caddy) serves
 *   `/editor/*` from the `cargo xtask web --dist` output. Next never touches
 *   the wasm body, so the `application/wasm` Content-Type is the static
 *   server's responsibility (Caddy: `encode`, mime detection handles it).
 * - Dev: `cargo xtask web --serve 8765` and set
 *   `EDITOR_DEV_SERVER_URL=http://127.0.0.1:8765`; the rewrite below proxies
 *   `/editor/:path*` to it. Without the env var there is no proxy and Next
 *   404s `/editor/*` (a public/editor/ directory would take precedence if
 *   one is ever dropped in).
 *
 * API serving model (W5-01): production fronts `/v1/*` at the same origin
 * (infra/caddy Caddyfile); in dev the `/v1/:path*` rewrite below proxies to
 * GATEWAY_INTERNAL_URL so a plain `next dev` boot speaks the production
 * shape (no separate edge proxy needed).
 *
 * Headers:
 * - COOP/COEP on `/editor/:path*` — the WASM editor needs a cross-origin
 *   isolated context (SharedArrayBuffer).
 * - `/editor/:build*` — the dist output is content-hashed
 *   (`/editor/<build>/assets/…`), so those assets are immutable and get a
 *   one-year cache.
 * - Global: nosniff + strict-origin-when-cross-origin.
 */

const EDITOR_DEV_SERVER_URL =
  process.env.NODE_ENV === "production" ? undefined : process.env.EDITOR_DEV_SERVER_URL;

// W5-01: dev-only `/v1` proxy to the gateway. The browser talks same-origin
// `/v1/*` (`createApiClient({ baseUrl: "/v1" })` — auth-client too, via
// NEXT_PUBLIC_APP_URL); production fronts both with one origin (infra/caddy
// Caddyfile) and the E2E recipe boots its own edge proxy (playwright.config.ts).
// A plain `next dev` boot had NO `/v1` route at all, so every client-side API
// call — including the sign-in POST itself — 404'd. This rewrite gives
// `pnpm dev:web` + `pnpm dev:gateway` the production shape out of the box:
// `/v1/:path*` → the same GATEWAY_INTERNAL_URL origin the RSC seam
// (src/lib/gateway.ts) already uses. Dev only; `next build` never emits it.
const GATEWAY_INTERNAL_URL = (
  process.env.NODE_ENV === "production"
    ? undefined
    : (process.env.GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:8787")
)?.replace(/\/+$/, "");

// W3-I: Turbopack still lacks webpack's `extensionAlias` (".js" → ".ts"),
// so the NodeNext workspace packages (`@studio/config` via the vendor shim,
// `@studio/contracts` via tsconfig paths — see README "Turbopack and NodeNext
// barrels") cannot be compiled by `next dev`/`next build` ("Can't resolve
// './errors.js'" on every page). The loader below rewrites their relative
// `.js`-suffixed import specifiers to extensionless form — the same mapping
// tsx (gateway) and vitest (Vite) already apply to these exact files — scoped
// by resourcePath to `packages/config` + `packages/contracts` only. Delete
// this block when the packages move to bundler-resolution re-exports.
const nodenextLoader = new URL(
  "../../scripts/captures/nodenext-js-strip-loader.cjs",
  import.meta.url,
).pathname;

const nextConfig: NextConfig = {
  // Dev cross-origin allowlist (Next 16 blockCrossSiteDEV; W2-B8 finding):
  // dev serves `/_next/*` chunks + the HMR socket ONLY to allowlisted
  // origins, so any proxy or loopback-IP access that is not literally
  // `localhost` is treated as cross-origin and the client bootstrap is
  // silently blocked (pages render SSR HTML but never hydrate). The
  // playwright.config.ts webServer edge (http://127.0.0.1:3100 → next dev
  // :3000) and direct `http://127.0.0.1:<port>` browsing both hit this.
  //
  // Matcher semantics (next/dist server/lib/router-utils/block-cross-site-dev
  // + app-render/csrf-protection `isCsrfOriginAllowed`): entries match the
  // request's origin HOSTNAME only — no scheme, no port, wildcards for
  // subdomains. `localhost` and `**.localhost` are already allowed by
  // default, so the one entry below covers 127.0.0.1 on ANY port (the edge's
  // 3100, a direct 3000, whatever the fleet picks). Dev-only: the check
  // exists solely inside the dev server; `next build` ignores this key.
  allowedDevOrigins: ["127.0.0.1"],

  turbopack: {
    rules: {
      "*.ts": {
        loaders: [{ loader: nodenextLoader }],
      },
    },
  },

  poweredByHeader: false,
  // The editor is served at `/editor/` (trailing slash). Next would otherwise
  // 308 `/editor/` → `/editor`, which breaks the editor's relative asset URLs
  // (`effectcraft_web_bg.wasm` resolves against `/editor` as a *file*, landing
  // on `/effectcraft_web_bg.wasm`). Keeping both forms lets the iframe keep
  // the trailing slash so every relative URL in the upstream dist works.
  skipTrailingSlashRedirect: true,
  async headers() {
    return [
      {
        source: "/editor/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        // Hashed editor dist assets (`/editor/<build>/…`) are content-addressed.
        source: "/editor/:build*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  async rewrites() {
    // W5-01: dev-only `/v1` → gateway proxy (see GATEWAY_INTERNAL_URL above).
    // Always first in the list so it wins over any future catch-alls; the
    // editor dev-server rewrites stay below it (disjoint path spaces).
    const v1Rewrites =
      GATEWAY_INTERNAL_URL !== undefined
        ? [{ source: "/v1/:path*", destination: `${GATEWAY_INTERNAL_URL}/v1/:path*` }]
        : [];
    if (!EDITOR_DEV_SERVER_URL) {
      return [
        ...v1Rewrites,
        // Bare `/editor` + `/editor/` → the committed dist's index.html
        // (public/editor/). Next's public handler serves the dist's files
        // verbatim (`/editor/effectcraft_web.js` → 200) but does NOT resolve
        // a directory index for `/editor/`, so the iframe URL `/editor/?empty`
        // 404s and the editor-host parks on "booting" — the e2e suite's
        // editor never loads. Both bare forms rewrite to the index so the
        // dist's relative asset URLs keep resolving against `/editor/`
        // (skipTrailingSlashRedirect above keeps the trailing-slash form
        // alive; an EDITOR_DEV_SERVER_URL boot keeps its own proxy below).
        { source: "/editor", destination: "/editor/index.html" },
        { source: "/editor/", destination: "/editor/index.html" },
      ];
    }
    return [
      ...v1Rewrites,
      // Bare `/editor` and `/editor/` both resolve to the dist index so the
      // iframe URL `/editor/?empty` boots correctly in dev.
      {
        source: "/editor",
        destination: `${EDITOR_DEV_SERVER_URL}/`,
      },
      {
        source: "/editor/:path*",
        destination: `${EDITOR_DEV_SERVER_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
