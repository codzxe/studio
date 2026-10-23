/**
 * The wire top-up pack catalog, pinned ONCE for all of apps/web
 * (packages/contracts/src/routes/billing.ts `TOP_UP_PACKS`:
 * credits100/credits500/credits2000; credits in DISPLAY units, prices in
 * Stripe and never on the wire).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY —
 * runtime imports of the NodeNext contracts barrel are forbidden from web
 * product code (Turbopack; see lib/gateway.ts). So the catalog is restated
 * here as ONE local literal, type-pinned via `satisfies readonly
 * BillingTopUpPack[]` so a wire-side pack change is a typecheck failure, and
 * top-up-packs.test.ts pins the VALUES against the real contracts catalog
 * (tests may runtime-import @studio/contracts — they are never bundled).
 *
 * Consumers: the billing page's TopUpFlow default and the marketing pricing
 * page's TopUpBlock. If you need the pack list, import it from here — never
 * re-pin it locally.
 */

import type { BillingTopUpPack } from "@studio/contracts";

/**
 * The top-up pack catalog (display credits per pack; prices live in Stripe).
 * Mirrors `@studio/contracts` `TOP_UP_PACKS` — see the module header.
 */
export const TOP_UP_PACKS: readonly BillingTopUpPack[] = Object.freeze([
  { packId: "credits100", credits: 100 },
  { packId: "credits500", credits: 500 },
  { packId: "credits2000", credits: 2000 },
] satisfies readonly BillingTopUpPack[]);
