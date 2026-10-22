# @studio/web — Next.js app

Next.js 16 (App Router, Turbopack) + Tailwind v4 via `@studio/ui`. Marketing
site, auth pages and (from Wave 3) the signed-in SaaS shell. TypeScript
strict. Design system: `packages/ui` (see `packages/ui/README.md`).

## Dev commands

```sh
pnpm install                                # from the repo root
pnpm --filter @studio/web dev               # http://localhost:3000
pnpm --filter @studio/web build             # production build (must pass)
pnpm --filter @studio/web start             # serve the production build
pnpm --filter @studio/web typecheck         # tsc --noEmit
pnpm --filter @studio/web test              # vitest (jsdom + @testing-library)
pnpm --filter @studio/web lint              # biome check src
```

Editor dev proxy: set `EDITOR_DEV_SERVER_URL=http://127.0.0.1:8765` (the
`cargo xtask web --serve 8765` server) and `next dev` proxies `/editor/*` to
it — see `next.config.ts`.

## Fonts

Loaded with `next/font/google` (Instrument Serif, Instrument Sans, JetBrains
Mono) and wired into the `@studio/ui` font contract by overriding the three
stack variables in `src/app/globals.css` (`--font-display-stack`,
`--font-sans-stack`, `--font-mono-stack` → the `--font-*` variables exported
by `next/font` in `src/app/layout.tsx`).

**Fallback (documented per task spec):** if `next build` cannot reach Google
Fonts (sandboxed/offline network), switch to the `@fontsource` packages:

```sh
pnpm --filter @studio/web add @fontsource/instrument-serif @fontsource/instrument-sans @fontsource/jetbrains-mono
```

then in `src/app/layout.tsx` remove the three `next/font/google` imports and
the `variable` classes, and in `src/app/globals.css` replace the `:root`
override block with direct family names — the SAME three `--font-*-stack`
variable names are kept, only their values change:

```css
:root {
  --font-display-stack: "Instrument Serif", Georgia, serif;
  --font-sans-stack: "Instrument Sans", system-ui, -apple-system, sans-serif;
  --font-mono-stack: "JetBrains Mono", ui-monospace, "SF Mono", monospace;
}
@import "@fontsource/instrument-serif";
@import "@fontsource/instrument-sans/400.css";
@import "@fontsource/instrument-sans/500.css";
@import "@fontsource/instrument-sans/600.css";
@import "@fontsource/jetbrains-mono";
```

No other file changes: every component consumes the CSS variables, never the
`next/font` variables directly.

## Serving the editor (production shape, documented)

`/editor/*` is NOT served by Next itself in production: Caddy (or whatever
static server fronting the box) serves the `cargo xtask web --dist` output
with these headers (mirrored in `next.config.ts` for the dev server):

- `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` on `/editor/:path*` — the WASM editor needs a shared
  ArrayBusffer-capable context.
- `Cache-Control: public, max-age=31536000, immutable` on `/editor/:build*` —
  the dist output is content-hashed (`/editor/<build>/…`), so every asset is
  immutable.
- The `.wasm` `Content-Type` (`application/wasm`) is handled by the static
  server (Caddy in production, the `cargo xtask` dev server in development);
  Next never proxies the wasm body, so it sets no MIME type for it.

## Env

- `NEXT_PUBLIC_APP_URL` — canonical origin used by `src/lib/auth-client.ts`
  (`baseURL` = `${NEXT_PUBLIC_APP_URL}/v1/auth`). Unset → falls back to the
  dev origin `http://localhost:3000`. better-auth validates the URL at
  module-evaluation time, so it must be absolute (the gateway mounts auth
  under `/v1/auth`, docs/PRODUCT_ARCHITECTURE.md §7.1/§7.2).
- `GATEWAY_INTERNAL_URL` — server-side (RSC/route-handler) base URL of the
  gateway for `/v1` calls with session-cookie forwarding (the gateway listens
  on 8787; Caddy fronts it in production). Default: `http://127.0.0.1:8787`.
  Browser-side calls stay same-origin (`/v1/…` via the static server proxy)
  and never use this var.
- `EDITOR_DEV_SERVER_URL` — optional dev proxy for `/editor/:path*`.

## Turbopack and NodeNext barrels (`@studio/config`)

Next 16 builds only with Turbopack, and Turbopack does not implement
webpack's `extensionAlias` (".js" → ".ts"). `@studio/config` is a NodeNext
package — its barrel is written `export * from "./brand.js"` (required by
tsc under NodeNext) — which Turbopack cannot resolve. Since the packages are
outside this app's editable surface, `apps/web/tsconfig.json` maps the
specifier `@studio/config` to `src/vendor/studio-config.ts`, a shim that
re-exports the exact source module (`packages/config/src/brand.ts`), so app
code keeps the single `@studio/config` import idiom. Tests are unaffected
(vite handles extension aliasing and resolves the real barrel).

Do not extend the shim to env/errors/ids blindly: those modules import
`node:crypto` and further `.js`-suffixed siblings — server-side concerns
(gateway). Delete the shim and its tsconfig paths entry once the packages
move to bundler-resolution re-exports or Turbopack ships `extensionAlias`.
