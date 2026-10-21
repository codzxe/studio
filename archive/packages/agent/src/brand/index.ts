// @studio/agent/brand — public surface. Owner: W7-F (docs/AGENTS.md).
//
// Not yet re-exported from src/index.ts: the barrel is shared registry file
// (W6-P owns src/index.ts); its owner adds `export * from "./brand/index.js"`
// plus tests/barrel.test.ts rows — the guards/ precedent (see index.ts notes).
// Collision audit at authoring time: no clashes with the existing barrel
// surface (BrandTokens/FONT_ROLES/DEFAULT_BRAND/… are unique in src/).

export * from "./tokens.js";
export * from "./service.js";
