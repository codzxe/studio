// apps/web — prebuilt gateway bundle entry (§14 deployment, serverless box).
//
// The production /v1 route (src/app/v1/[...path]/route.ts) imports the
// gateway through THIS entry, and `pnpm build` re-bundles it with esbuild
// into apps/web/api/gateway.mjs (committed; the build regenerates it, so the
// deployed artifact always matches the gateway source).
//
// Why a prebuilt bundle instead of importing the gateway source straight into
// the route: services/gateway + @studio/* are NodeNext packages whose
// `@studio/config` imports must resolve to the REAL package — but apps/web's
// tsconfig maps that specifier to the client-safe vendor shim, which lacks
// StudioError/getEnv. Bundling with a dedicated tsconfig (api-src/tsconfig.json
// — no paths, real node_modules resolution, .js→.ts NodeNext mapping) bakes
// the correct resolution into one self-contained ESM file; Turbopack then
// just consumes the artifact, never the TS graph.

export { gatewayFetch } from "../../../services/gateway/src/handler.js";
