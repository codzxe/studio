import { FaqItem } from "@/components/marketing/faq-item";
import {
  MarketingLink,
  MarketingPage,
  MarketingSection,
} from "@/components/marketing/marketing-page";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";

export const metadata = pageMetadata({
  title: "FAQ",
  description: `${Brand.productName} questions answered honestly: browser support, project formats, credits, the agent's models, privacy, and cancellation.`,
  path: "/faq",
});

/**
 * /faq — §8.1 §9 as a page of its own (M9-E, AUD-5). Honest answers only:
 * every claim mirrors what the product actually does today (browser
 * requirements from the editor's serving model, formats from the D-2 render
 * catalog, credits from the ledger semantics, models from the plan catalog),
 * and the privacy answer links the real policy page. Accessible accordion
 * (faq-item.tsx): buttons with aria-expanded, panels as labelled regions.
 */
export default function FaqPage() {
  return (
    <MarketingPage
      testid="faq-page"
      kicker={`${Brand.productName} — FAQ`}
      title="Questions, answered."
      intro="Browser support, project formats, credits, the agent's models, privacy and cancellation — the honest version of each answer, no marketing varnish."
      narrow
    >
      <MarketingSection label="00:00:01 — THE ANSWERS">
        <div className="flex flex-col">
          <FaqItem
            id="browsers"
            question="Which browsers are supported?"
            answer={
              <>
                Any recent browser with WebGPU or WebGL2: Chrome or Edge 113+, Firefox 121+, Safari
                18+. The editor needs a cross-origin-isolated context, so it is served with
                COOP/COEP headers from our own origin — that part is automatic, nothing to
                configure. If the editor cannot boot in your browser you get a clear failure message
                with a retry, not a broken canvas; project pages still work for versions, renders,
                comments and shared review links.
              </>
            }
          />
          <FaqItem
            id="formats"
            question="What file formats does the project use?"
            answer={
              <>
                Projects are <code>.ecproj</code> files: import one, or export yours at any time —
                compositions, layers, keyframes and effects stay intact. Media you add to a
                composition (images, video, audio, fonts, LUTs) uploads into your workspace and is
                referenced by the project. Renders currently export as MP4 (H.264) or PNG sequences;
                ProRes, GIF and WAV are on the format list but not enabled yet.
              </>
            }
          />
          <FaqItem
            id="data"
            question="Where does my data live?"
            answer={
              <>
                Project files and uploaded assets live in your workspace&apos;s object storage;
                every save is an immutable version snapshot, so nothing gets overwritten. Your
                content is never used to train models. The{" "}
                <MarketingLink href="/legal/privacy">privacy policy</MarketingLink> has the details,
                including the third parties the service needs to run.
              </>
            }
          />
          <FaqItem
            id="models"
            question="Which models does the agent use?"
            answer={
              <>
                Two tiers, shown by name in the chat: Fast for everyday edits and quick questions,
                Smart for heavy multi-step work. The trial runs on Fast; every paid plan can pick
                Fast or Smart. Before each run you see the plan — steps, affected layers, risk level
                and the estimated cost in credits — and you apply it with a click. An optional
                auto-apply exists for a small, safe set of edits and it is off by default.
              </>
            }
          />
          <FaqItem
            id="credits"
            question="What are credits and how do they work?"
            answer={
              <>
                Credits are the unit you buy and spend. Your plan includes a monthly allowance;
                one-time top-ups add more. Agent runs and cloud renders draw down the balance, and
                every cost is shown in credits — with two decimals where a fraction is spent — never
                in model tokens. A run or render reserves its estimate up front and refunds what it
                did not use; cancelled or failed jobs refund in full. The ledger in billing records
                every entry.
              </>
            }
          />
          <FaqItem
            id="cancellation"
            question="Can I cancel? What about refunds?"
            answer={
              <>
                Cancel from billing — two clicks, no retention flow. Cancellation stops future
                charges and never deletes your work; downgrades apply at the end of the billing
                period, and if payment fails the workspace goes read-only rather than blank.
                Reserved credits for a cancelled or failed run or render come back automatically —
                the ledger shows it. If a charge looks wrong,{" "}
                <MarketingLink href={`mailto:${Brand.contact.support}`} external>
                  write to support
                </MarketingLink>{" "}
                with the workspace name and we will look at the ledger with you.
              </>
            }
          />
          <FaqItem
            id="editor"
            question="Can I use the editor without the agent?"
            answer={
              <>
                Yes. The agent is a floating panel beside the timeline, not a paywall — every manual
                tool, keyframe and effect works without it, and the panel collapses or hides
                entirely. The agent is there when a change is easier said than clicked.
              </>
            }
          />
          <FaqItem
            id="trial"
            question="Is there a free tier?"
            answer={
              <>
                No. The trial lasts 14 days and requires a card at start; there is no permanent free
                plan. Cancel during the trial and the card is not charged at trial end — the{" "}
                <MarketingLink href="/pricing">pricing page</MarketingLink> lists what each plan and
                the trial include.
              </>
            }
          />
        </div>
      </MarketingSection>

      <MarketingSection label="END — FAQ">
        <p className="max-w-[68ch] text-body-s leading-relaxed text-secondary">
          Something we did not answer?{" "}
          <MarketingLink href={`mailto:${Brand.contact.support}`} external>
            {Brand.contact.support}
          </MarketingLink>{" "}
          — we answer as humans, not a ticket wall.
        </p>
      </MarketingSection>
    </MarketingPage>
  );
}
