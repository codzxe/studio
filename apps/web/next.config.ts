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
    if (!EDITOR_DEV_SERVER_URL) {
      return [];
    }
    return [
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
