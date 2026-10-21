import { LegalCrossLinks, LegalPage, LegalSection } from "@/components/marketing/legal-page";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";

export const metadata = pageMetadata({
  title: "Terms of Service",
  description:
    "The working terms for the Studio beta: workspaces, trials, billing, your content and acceptable use.",
  path: "/legal/terms",
});

export default function TermsPage() {
  return (
    <LegalPage
      testid="legal-terms"
      title="Terms of Service"
      intro="How the service works, who is responsible for what, and what you can expect from us while the product is in beta."
    >
      <LegalSection n="01" title="The service">
        <p>
          Studio is a browser-based motion-graphics workspace: a compositing editor, an agent that
          proposes and applies edits to your compositions, storage for projects and versions, and a
          render queue. You get a workspace, projects live inside it, and your plan decides seats,
          credits and model tiers.
        </p>
      </LegalSection>

      <LegalSection n="02" title="Accounts and workspaces">
        <p>
          You sign in with email or an OAuth provider. A workspace is the tenant boundary: it owns
          members, projects, credits and billing. Roles are owner, admin, editor and viewer; the
          role list in your workspace settings is the source of truth for what each can do.
        </p>
        <p>
          You are responsible for activity under your account, for keeping your credentials safe,
          and for who you invite into your workspace.
        </p>
      </LegalSection>

      <LegalSection n="03" title="Trials and billing">
        <p>
          The trial lasts 14 days and requires a card at start. There is no free tier. Plans and
          credit top-ups are charged through Stripe; you can cancel any time from billing, and
          cancellation stops future charges — it does not delete your work.
        </p>
        <p>
          If payment fails, workspaces go read-only until billing is fixed. Projects are never
          deleted for non-payment.
        </p>
      </LegalSection>

      <LegalSection n="04" title="Your content">
        <p>
          Your projects, assets and renders remain yours. We store them to provide the service,
          render them when you queue a render, and show them to the workspace members you choose. We
          do not use your project content to train models.
        </p>
      </LegalSection>

      <LegalSection n="05" title="Acceptable use">
        <p>
          Don&apos;t upload content you have no right to use, don&apos;t use the service to break
          the law or attack our systems, and keep agent usage within your plan&apos;s credits. The
          credit ledger is the usage record of truth.
        </p>
      </LegalSection>

      <LegalSection n="06" title="Changes and availability">
        <p>
          This is a beta: features, prices and plan limits may change before launch, and we will
          give reasonable notice of pricing changes. We aim for high availability and publish
          incidents to the status page. The service is provided without a formal SLA during beta.
        </p>
      </LegalSection>

      <LegalSection n="07" title="Contact">
        <p>
          Questions about these terms, or anything else legal? Write to{" "}
          <a
            href={`mailto:${Brand.contact.support}`}
            className="underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            {Brand.contact.support}
          </a>{" "}
          — we answer as humans, not a ticket wall.
        </p>
      </LegalSection>

      <LegalCrossLinks />
    </LegalPage>
  );
}
