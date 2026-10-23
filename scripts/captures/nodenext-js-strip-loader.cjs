/**
 * W3-I capture tooling — Turbopack loader that makes the NodeNext workspace
 * packages (`packages/config`, `packages/contracts`) compilable by Turbopack
 * dev, which (still) lacks webpack's `extensionAlias` (".js" → ".ts").
 *
 * The two packages are NodeNext (tsc-required `./sibling.js` specifiers that
 * point at `.ts` files — see apps/web/README.md "Turbopack and NodeNext
 * barrels"). tsx/Node (gateway) and vitest (Vite) both implement the mapping;
 * Turbopack does not, so every page tree that reaches `@studio/config`
 * (root layout, via the vendor shim) or `@studio/contracts` (chat) 500s under
 * `next dev` with `Can't resolve './errors.js'`.
 *
 * This loader rewrites RELATIVE `.js`-suffixed import specifiers back to
 * extensionless (bundler-resolution) form — a pure text transform, scoped to
 * the two NodeNext packages by resourcePath, byte-identical semantics to what
 * tsx/Vite/tsc already do for the same files. It touches nothing else: the
 * web app itself has zero `.js`-suffixed relative imports (verified by scan),
 * and `@studio/ui` / `@studio/editor-bridge` / `@studio/api-client` are
 * bundler-resolution packages with none either.
 */
module.exports = function nodenextJsStripLoader(source) {
  const path = this.resourcePath ?? "";
  if (!/(packages[\\/](config|contracts))[\\/]/.test(path)) {
    return source;
  }
  // `from "…"` (covers `import … from` and `export … from`),
  // bare `import "…"`, dynamic `import("…")` and `require("…")` — relative
  // specifiers only (`./` or `../`), trailing `.js` stripped.
  return source.replace(
    /((?:\bfrom|\bimport|\brequire\s*\()\s*)(["'])(\.{1,2}\/[^"'\n]+?)\.js(\2)/g,
    "$1$2$3$4",
  );
};
