// Security & privacy (W8-M) — spec §16.2 section 7: security and privacy
// content on the landing page, linking to the legal pages. Every claim below
// is grounded in the spec: workspace isolation (§3.2, §25-4), gateway-mediated
// engine access (§0 stack), paid no-training LLM endpoints only (§1.5-6),
// no training on customer data (§1.4), Stripe-scoped payments + minimal PII
// (§14.3), no-cookie analytics (§16.2).

import Link from "next/link";

const SECURITY_POINTS: readonly string[] = [
  "Workspaces are isolated: one engine session per workspace per request — sessions are never shared across tenants.",
  "The browser never talks to the raw engine. A gateway mediates and authorizes every call.",
  "Uploads are validated (format sniffing, size caps) and EXIF location metadata is stripped by default.",
  "One transaction per agent run — a full command log is stored for replay and audit, and one undo reverts the whole run.",
] as const;

const PRIVACY_POINTS: readonly string[] = [
  "Your prompts, documents and renders only reach paid API endpoints that do not train on your data — never free LLM tiers.",
  "We do not train or fine-tune models on customer content.",
  "Prompts and renders are not logged beyond a run's retention window unless you explicitly enable it for your workspace.",
  "Card data stays with Stripe; we store minimal PII.",
  "This marketing site runs cookie-free analytics — no cross-site tracking.",
] as const;

export function Security() {
  return (
    <section
      id="security"
      className="mx-auto w-full max-w-6xl scroll-mt-16 px-6 py-14"
      data-testid="marketing-security"
    >
      <h2 className="text-2xl font-semibold tracking-tight">Security &amp; privacy</h2>
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-6">
          <h3 className="text-base font-semibold">How we protect your work</h3>
          <ul className="mt-3 space-y-2">
            {SECURITY_POINTS.map((point) => (
              <li key={point} className="text-sm leading-relaxed text-muted-foreground">
                — {point}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-border bg-surface p-6">
          <h3 className="text-base font-semibold">How your data is handled</h3>
          <ul className="mt-3 space-y-2">
            {PRIVACY_POINTS.map((point) => (
              <li key={point} className="text-sm leading-relaxed text-muted-foreground">
                — {point}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        <Link href="/legal/privacy" className="font-medium underline underline-offset-4">
          Privacy page
        </Link>{" "}
        (placeholder, pending legal review) ·{" "}
        <Link href="/legal/terms" className="font-medium underline underline-offset-4">
          Terms of service
        </Link>{" "}
        (placeholder, pending legal review)
      </p>
    </section>
  );
}
