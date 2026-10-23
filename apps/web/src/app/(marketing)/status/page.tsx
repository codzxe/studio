import {
  MarketingLink,
  MarketingPage,
  MarketingSection,
} from "@/components/marketing/marketing-page";
import { StatusBoard } from "@/components/marketing/status-board";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";

export const metadata = pageMetadata({
  title: "Status",
  description: `Live health checks for the ${Brand.productName} API and database from your own browser, maintenance notes, and how to reach support. No uptime theatre.`,
  path: "/status",
});

/**
 * /status — an HONEST status page (M9-E, AUD-5; §2.1 no invented metrics).
 *
 * What this page is: the live check above runs in the visitor's browser
 * against the public health endpoint and shows the last verified state. What
 * it deliberately is NOT: no uptime percentages (we have no measurement
 * window to publish yet), no fake incident history, and the maintenance
 * section follows §8.11 — status link, an ETA only when one is actually
 * known, no fake countdowns.
 */
export default function StatusPage() {
  return (
    <MarketingPage
      testid="status-page"
      kicker={`${Brand.productName} — Status`}
      title="The live check."
      intro="This page checks the public health endpoint from your own browser and shows the last verified state — the gateway, and the database behind it. Nothing here is simulated."
      narrow
    >
      <MarketingSection label="00:00:01 — LIVE CHECK">
        <StatusBoard />
        <p className="text-caption text-muted">
          The check runs when the page opens and when you press “Check again”. It is not a
          monitoring feed: it reports what the service answered, from where you are, at that moment.
        </p>
      </MarketingSection>

      <MarketingSection label="00:00:02 — MAINTENANCE">
        <div className="flex flex-col gap-3">
          <p className="text-body text-primary">Nothing is scheduled right now.</p>
          <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
            When we need to pause the service for maintenance, this page says what is paused, why,
            and for how long when we know it — and “when we know it” means exactly that: no
            countdowns, no vague “back soon”.
          </p>
        </div>
      </MarketingSection>

      <MarketingSection label="00:00:03 — INCIDENTS">
        <div className="flex flex-col gap-3">
          <p className="text-body text-primary">No incident archive yet.</p>
          <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
            This beta does not keep a public incident history — when something breaks, we post here
            what broke, what it affected and what we did about it, after we have verified it. We do
            not publish uptime percentages we cannot back with a real measurement window.
          </p>
          <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
            Seeing something this page does not?{" "}
            <MarketingLink href={`mailto:${Brand.contact.support}`} external>
              {Brand.contact.support}
            </MarketingLink>{" "}
            — a real report beats a stale green dot.
          </p>
        </div>
      </MarketingSection>

      <MarketingSection label="END — STATUS">
        <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
          The signed-in app surfaces its own state where it matters: saves, renders and agent runs
          report failures inline with what to do next. This page is the public corner of that
          honesty — {Brand.productName} is a beta, and it is treated like one.
        </p>
      </MarketingSection>
    </MarketingPage>
  );
}
