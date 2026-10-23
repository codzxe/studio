/**
 * TopUpPacks pin tests (W2-B2) — the ONE web-side copy of the wire pack
 * catalog cannot drift from `@studio/contracts` `TOP_UP_PACKS`:
 *
 * - values: identical pack ids + credits, same order (tests may
 *   runtime-import @studio/contracts — they are never bundled; the
 *   documented apply-failures.test.ts precedent);
 * - shape: frozen + satisfies-pinned to `readonly BillingTopUpPack[]`, so a
 *   contracts-side pack change is a typecheck failure for the literal.
 *
 * The pricing page (TopUpBlock) and the billing flow (TopUpFlow default)
 * both render from this module — a failure here means the /pricing top-ups
 * block or the billing pack picker is out of sync with the wire.
 */

import { TOP_UP_PACKS } from "@studio/contracts";
import { describe, expect, it } from "vitest";

import { TOP_UP_PACKS as WEB_TOP_UP_PACKS } from "./top-up-packs";

describe("top-up-packs — the web pin", () => {
  it("matches the @studio/contracts TOP_UP_PACKS catalog exactly (ids, credits, order)", () => {
    expect([...WEB_TOP_UP_PACKS]).toEqual([...TOP_UP_PACKS]);
  });

  it("is frozen — no consumer can mutate the shared catalog", () => {
    expect(Object.isFrozen(WEB_TOP_UP_PACKS)).toBe(true);
  });
});
