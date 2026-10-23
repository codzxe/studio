import {
  MarketingLink,
  MarketingPage,
  MarketingSection,
} from "@/components/marketing/marketing-page";
import {
  PricingCards,
  RenderFormatsNote,
  TopUpBlock,
  TrialBlock,
} from "@/components/marketing/pricing-cards";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";

export const metadata = pageMetadata({
  title: "Pricing",
  description: `${Brand.productName} plans: Starter, Pro and Studio with included monthly credits, seats and render minutes, one-time credit top-ups, and a 14-day trial with card.`,
  path: "/pricing",
});

/**
 * /pricing — §8.1 §8 as a page of its own (M9-E, AUD-5: the landing's pricing
 * anchor is a teaser; this is the honest, catalog-derived spread). Every
 * number comes from `@studio/config` PLAN_CATALOG via the shared cards; no
 * invented discounts, no fake annual "save X%" (§8.8), no free tier.
 */
export default function PricingPage() {
  return (
    <MarketingPage
      testid="pricing-page"
      kicker={`${Brand.productName} — Pricing`}
      title="Three plans. Plain numbers."
      intro="Every plan includes monthly credits, seats, storage and render minutes. One-time top-ups cover the busy months. Card required for the 14-day trial — no free tier."
    >
      <MarketingSection label="00:00:01 — THE PLANS">
        <PricingCards />
      </MarketingSection>

      <MarketingSection label="00:00:02 — TOP-UPS">
        <TopUpBlock />
      </MarketingSection>

      <MarketingSection label="00:00:03 — THE TRIAL">
        <TrialBlock />
      </MarketingSection>

      <MarketingSection label="00:00:04 — RENDER FORMATS">
        <RenderFormatsNote />
      </MarketingSection>

      <MarketingSection label="END — PRICING">
        <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
          Plans are billed monthly through Stripe; you can change or cancel from billing any time
          and your work is never deleted for cancelling. Prices shown are the working beta numbers —
          finalised at launch, and always on this page. Questions about what a plan covers?{" "}
          <MarketingLink href="/faq">Read the FAQ</MarketingLink>
          {" or "}
          <MarketingLink href={`mailto:${Brand.contact.support}`} external>
            write to us
          </MarketingLink>
          .
        </p>
      </MarketingSection>
    </MarketingPage>
  );
}
