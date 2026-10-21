import { LegalCrossLinks, LegalPage, LegalSection } from "@/components/marketing/legal-page";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";

export const metadata = pageMetadata({
  title: "Privacy Policy",
  description:
    "What Studio collects, what it is used for, where it lives, and the things we never do with your work.",
  path: "/legal/privacy",
});

export default function PrivacyPage() {
  return (
    <LegalPage
      testid="legal-privacy"
      title="Privacy Policy"
      intro="What we collect, why we collect it, where it lives, and the things we never do with your work."
    >
      <LegalSection n="01" title="What we collect">
        <p>
          Account data: your name, email address and workspace membership. Content: the projects,
          assets and versions you store in the service. Usage data: billing records, credit ledger
          entries, render jobs and technical telemetry like page errors and timing.
        </p>
      </LegalSection>

      <LegalSection n="02" title="What we use it for">
        <p>
          To run the service: authenticating you, storing your projects, running the agent when you
          ask it to, queuing renders and billing your plan. To keep the service working: debugging,
          rate limiting and detecting abuse. To answer you: support conversations.
        </p>
      </LegalSection>

      <LegalSection n="03" title="What we never do">
        <p>
          We never sell your data. We never use your project content to train machine-learning
          models. Agent prompts are processed by model providers to answer your request in that
          moment — not retained for their training.
        </p>
      </LegalSection>

      <LegalSection n="04" title="Where your data lives">
        <p>
          Project files and assets live in object storage attached to your workspace&apos;s region.
          Databases and queues run in the same region. Third parties involved in running the
          service: our hosting provider, Stripe for payments, and the model providers that serve
          agent requests. Each gets only what the task requires.
        </p>
      </LegalSection>

      <LegalSection n="05" title="Your choices">
        <p>
          You can export your project files at any time. You can delete a workspace, which removes
          its projects and assets from active storage. You can ask us for a copy of your personal
          data or its deletion by writing to us.
        </p>
      </LegalSection>

      <LegalSection n="06" title="Security and contact">
        <p>
          Sessions use secure httpOnly cookies; access is role-scoped inside a workspace. Found
          something sensitive? Responsible disclosures go to{" "}
          <a
            href={`mailto:${Brand.contact.security}`}
            className="underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            {Brand.contact.security}
          </a>
          .
        </p>
      </LegalSection>

      <LegalCrossLinks />
    </LegalPage>
  );
}
