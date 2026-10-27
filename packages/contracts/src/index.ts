// @studio/contracts — barrel (named exports only; no default export).
//
// Wire contracts for the Studio control plane (PRODUCT_ARCHITECTURE.md §7-§10,
// EDITOR_CHAT_UX §5-§8): response envelopes (§7.3), SSE stream events (§7.4),
// the EditPlan schema (§8.6), the engine.batch contract (§8.5), the curated
// tool surface (§8.4), model routing (§8.2/§10.1) and one Zod schema set per
// §7.2 endpoint domain under ./routes.
//
// Round-12 tier split ("Tool catalog v3"): this barrel exports the TIER-2
// allowed-command ids only (./allowed-commands.js, ~10 KB — the client gate
// size budget). The FULL generated engine catalog + the prompt digest live in
// ./engine-catalog.js, exposed via the `@studio/contracts/catalog` SUBPATH —
// importing them here would ride the full params docs into the browser bundle
// through the api-client re-export seam, which the round-12 design forbids.

export * from "./envelope.js";
export * from "./allowed-commands.js";
export * from "./command-registry.js";
export * from "./engine-batch.js";
export * from "./edit-plan.js";
export * from "./events.js";
export * from "./models.js";
export * from "./tools.js";
export * from "./write-tools.js";

export * from "./routes/index.js";
