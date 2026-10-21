// ─────────────────────────────────────────────────────────────────────────────
// TRUTHFULNESS SELF-CHECK — spec §16.2 "Truthfulness rules" + §25 rule 15.
// This block lives at the top of the pricing component ON PURPOSE. Re-verify
// every bullet on every edit of this file:
//
//   1. No competitor names or comparisons anywhere on this page — never the
//      forbidden names (§1.5-1, §25-15); the internal codename stays out of
//      user-facing strings too.
//   2. No "unlimited"-style claims: everything is metered in credits; there
//      is NO free tier — only the one-time 30-credit trial (§1.4, §14.1).
//   3. PSD export is labeled EXPERIMENTAL every place it is mentioned
//      (§10.3: best-effort with a fidelity report; never promise perfect PSD).
//   4. AI image limits are stated: 1024² = 1 credit per image, HD = 2
//      credits per image (§14.1); daily workspace cap = 2× monthly credits
//      by default (§14.2 rule 7).
//   5. The credit cost of every action is shown HERE, before sign-up
//      (§16.2): runs 1/2/5 by tier; model multipliers premium ×2, max ×4;
//      image generation per image; 1 credit = $0.10 of list price.
//   6. Prices mirror §14.1 EXACTLY — $30→100 cr, $60→250 cr, $120→600 cr,
//      extra seat +$8, packs $10 per 100 credits (no expiry while
//      subscribed), trial = one-time 30 credits, no card, one per account
//      (email + payment-fingerprint dedupe).
//   7. No invented perks: retention, support and export-fidelity are named
//      as plan axes (§14.1) whose exact values publish with the billing
//      rollout — TODO(billing) below — so they are not spelled with made-up
//      numbers here.
//
// If a new marketing claim does not fit inside this list, delete the claim.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";

type Plan = {
  readonly name: string;
  readonly priceUsd: number;
  readonly creditsPerMonth: number;
  readonly seats: number;
  readonly concurrentRuns: number;
  readonly maxCanvasMp: number;
};

// §14.1 verbatim: $30/mo → 100 credits, $60/mo → 250, $120/mo → 600;
// seats 1/3/10, concurrent runs 1/3/6, max canvas 32/64/128 MP.
const PLANS: readonly Plan[] = [
  { name: "Starter", priceUsd: 30, creditsPerMonth: 100, seats: 1, concurrentRuns: 1, maxCanvasMp: 32 },
  { name: "Pro", priceUsd: 60, creditsPerMonth: 250, seats: 3, concurrentRuns: 3, maxCanvasMp: 64 },
  { name: "Max", priceUsd: 120, creditsPerMonth: 600, seats: 10, concurrentRuns: 6, maxCanvasMp: 128 },
] as const;

// §14.1: run costs quick 1 / standard 2 / complex 5; model multipliers
// premium ×2, max ×4; image generation 1024² = 1, HD = 2 (per image).
const ACTION_COSTS: readonly { readonly action: string; readonly cost: string }[] = [
  { action: "Quick edit run", cost: "1 credit" },
  { action: "Standard run", cost: "2 credits" },
  { action: "Complex run", cost: "5 credits" },
  { action: "Premium model route", cost: "×2 the run's tier (standard → 4 credits)" },
  { action: "Max model route", cost: "×4 the run's tier (standard → 8 credits)" },
  { action: "Generated image, 1024²", cost: "1 credit per image" },
  { action: "Generated image, HD", cost: "2 credits per image" },
] as const;

export function Pricing() {
  return (
    <section
      id="pricing"
      className="mx-auto w-full max-w-6xl scroll-mt-16 px-6 py-14"
      data-testid="marketing-pricing"
    >
      <h2 className="text-2xl font-semibold tracking-tight">Pricing</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Every plan includes the full editor. Plans differ in credits, seats,
        concurrent runs and canvas size — and every action&apos;s credit cost is
        on this page, before you sign up.
      </p>

      {/* 3 plan cards — §14.1 numbers only */}
      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        {PLANS.map((plan) => (
          <article key={plan.name} className="flex flex-col rounded-lg border border-border bg-surface p-6">
            <h3 className="text-lg font-semibold">{plan.name}</h3>
            <p className="mt-3 text-3xl font-semibold tracking-tight">
              ${plan.priceUsd}
              <span className="text-base font-normal text-muted-foreground">/mo</span>
            </p>
            <p className="mt-1 font-mono text-sm text-muted-foreground">
              {plan.creditsPerMonth} credits per month
            </p>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li>{plan.seats} seat{plan.seats === 1 ? "" : "s"} (extra seats +$8/mo each)</li>
              <li>{plan.concurrentRuns} concurrent agent run{plan.concurrentRuns === 1 ? "" : "s"}</li>
              <li>Max canvas {plan.maxCanvasMp} MP</li>
              <li>Full editor included</li>
              <li>
                Native <code className="font-mono">.pcraft</code>, PNG and JPG exports
              </li>
              <li>PSD export — experimental, with a fidelity report</li>
              <li>Credit packs: $10 per 100 credits</li>
            </ul>
            <Link
              href="/sign-up"
              className="mt-6 rounded-md bg-accent px-4 py-2.5 text-center text-sm font-semibold text-accent-foreground transition hover:opacity-90"
            >
              Start with 30 trial credits
            </Link>
          </article>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* credit cost per action — §14.1, shown before sign-up */}
        <div className="rounded-lg border border-border bg-surface p-6">
          <h3 className="text-base font-semibold">What things cost</h3>
          <p className="mt-1 text-sm text-muted-foreground">1 credit = $0.10 of list price.</p>
          <table className="mt-4 w-full text-sm">
            <tbody>
              {ACTION_COSTS.map((row) => (
                <tr key={row.action} className="border-b border-border/60 last:border-b-0">
                  <td className="py-2 pr-4 text-muted-foreground">{row.action}</td>
                  <td className="py-2 text-right font-mono">{row.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Runs reserve their cost up front and commit only on success;
            failed runs release credits, and a failure we caused is refunded
            in full. Daily workspace spending is capped at 2× your monthly
            plan credits by default. Repairs and retries within a run never
            cost extra.
          </p>
        </div>

        {/* packs, trial, and the no-free-tier statement — §14.1 / §1.4 */}
        <div className="rounded-lg border border-border bg-surface p-6">
          <h3 className="text-base font-semibold">Credits, packs and the trial</h3>
          <dl className="mt-4 space-y-4 text-sm">
            <div>
              <dt className="font-semibold">Credit packs</dt>
              <dd className="text-muted-foreground">
                $10 per 100 credits, any plan. Packs never expire while you are
                subscribed (expiry terms are stated in the terms of service).
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Trial</dt>
              <dd className="text-muted-foreground">
                One-time 30-credit grant when you create your account — no card
                required, once per account (email and payment-fingerprint
                dedupe).
              </dd>
            </div>
            <div>
              <dt className="font-semibold">No free tier</dt>
              <dd className="text-muted-foreground">
                After the trial it is a paid plan. We do not run a free tier —
                metered credits keep the service sustainable and honest.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Seats</dt>
              <dd className="text-muted-foreground">
                Starter / Pro / Max include 1 / 3 / 10 seats; every additional
                seat is +$8/mo.
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Retention, support and export-fidelity perks also vary by plan;
            their exact values publish with the billing rollout — no numbers
            are invented here.
          </p>
        </div>
      </div>
    </section>
  );
}
