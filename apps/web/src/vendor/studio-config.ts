/**
 * Turbopack shim for `@studio/config` — see apps/web/README.md
 * "Turbopack and NodeNext barrels".
 *
 * Why this exists: Next 16 builds only with Turbopack, and Turbopack does not
 * implement webpack's `extensionAlias` (".js" → ".ts"). @studio/config is a
 * NodeNext package — its barrel re-exports are written as
 * `export * from "./brand.js"` (required by tsc under NodeNext), which
 * Turbopack cannot resolve. packages/config is outside this app's editable
 * surface, so apps/web maps the specifier `@studio/config` to this shim via
 * tsconfig paths instead: app code keeps the single `@studio/config`
 * import idiom, and this file re-exports the exact source module.
 *
 * Scope: apps/web needs the brand tokens (Brand, brandViolations,
 * assertBrandSafe) and, since M8, the render-format catalog surface
 * (RENDER_FORMATS / ENABLED_RENDER_FORMATS / isRenderFormatEnabled and types)
 * for the Render dialog + history surfaces. plans.ts is dependency-free
 * (no node:crypto chain), so re-exporting it is web-safe. Do NOT blindly add
 * `export * from …/env|errors|ids` here: those modules import `node:crypto`
 * and further `.js`-suffixed siblings, so they are server-side anyway (env
 * parsing belongs to the gateway, Wave 3).
 *
 * Delete this file (and its tsconfig paths entry) once the package moves to
 * bundler-resolution re-exports or Turbopack ships extensionAlias support.
 */
export * from "../../../../packages/config/src/brand";
export * from "../../../../packages/config/src/plans";
