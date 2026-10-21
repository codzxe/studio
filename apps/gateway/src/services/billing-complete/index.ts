// @studio/gateway — billing-complete barrel (W9-A).
//
// The verification + completion layer over the W4-N billing surface
// (services/stripe.ts + routes/billing.ts, both read-only inputs):
//   wiring-check.ts        startup audit (§4 fail-fast, §14.3 env mapping,
//                          price-id ↔ plan-code dedup)
//   webhook-idempotency.ts the idempotency harness (idempotency_keys replay
//                          protection + the `stripe:${eventId}` money key),
//                          in-memory fakes + the real W4-N service
//   ledger-bridge.ts       Stripe events → LedgerLike.grant / audit notes
//
// No production file imports this barrel yet: W9-A owns only this directory,
// and wiring it into src/index.ts belongs to the integration wave (see the
// W9-A worklog entry). The modules are side-effect free on import.

export * from "./ledger-bridge.js";
export * from "./webhook-idempotency.js";
export * from "./wiring-check.js";
