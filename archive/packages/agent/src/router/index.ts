// @studio/agent — §5.3 router subsystem barrel. Owner: W6-H (docs/AGENTS.md).
//
// router.ts: ModelRouter (tier→class routing, per-provider circuit breakers,
// same-class failover, providerHealth snapshots, off-peak batch preference).
// provider-adapter.ts: ProviderLike seam + worker factory contract (this
// package never imports provider SDKs), §5.4 static-prefix cache adviser and
// per-provider cache-hit tracking hooks (§5.3 ≥60% target).
//
// NOTE (barrel owner, W1 lineage): adding `export * from "./router/index.js"`
// to src/index.ts is safe — checked: zero name collisions with
// budgets/errors/events/eventbus/models/plan/state exports, and this barrel
// deliberately re-exports nothing from ../models.js.
export * from "./provider-adapter.js";
export * from "./router.js";
