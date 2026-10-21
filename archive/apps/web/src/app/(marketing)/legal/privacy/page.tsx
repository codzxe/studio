// Privacy & data usage — HONEST PLACEHOLDER (W8-M).
//
// Data-usage policy per spec §1.5 constraint 6 and §16.2:
//   - Customer content never flows through free LLM tiers that train on
//     data — only paid, no-training endpoints (Vertex AI / Bedrock /
//     Anthropic / OpenAI paid keys).
//   - No training or fine-tuning on customer data (§1.4).
//   - Prompts + renders are never logged beyond the run's retention window
//     without an explicit workspace setting (§1.5-6). The default retention
//     window value publishes with the ops wave — TODO(legal-review): pin the
//     default number; it is deliberately NOT invented here.
//   - Cards stay with Stripe; minimal PII (§14.3).
//   - No-cookie analytics on the marketing site (§16.2).
//
// TODO(legal-review): entity, jurisdiction, retention numbers, DPA, and the
// final binding wording before production launch.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy & data usage",
  description: "Placeholder privacy and data-usage policy — pending legal review.",
};

const SECTIONS: readonly { readonly heading: string; readonly body: readonly string[] }[] = [
  {
    heading: "What we process",
    body: [
      "Account basics (email and workspace membership), the documents you create, the prompts you write, the assets you upload, and the renders produced by runs.",
      "Payments run through Stripe — we never see or store card data — and we keep personal information to the minimum needed to run the service.",
    ],
  },
  {
    heading: "How AI processing works",
    body: [
      "Your prompts, documents and renders are sent only to paid model endpoints that contractually do not train on customer data. Free LLM tiers are never used for customer content.",
      "We do not train or fine-tune models on anything you create or upload.",
    ],
  },
  {
    heading: "Logs and retention",
    body: [
      "Run logs (prompts and renders) are kept for a run's retention window and then removed; they are not kept longer unless you explicitly enable extended logging for your workspace.",
      "TODO(legal-review): the default retention window length publishes here with the billing/ops rollout — no number is invented on this placeholder page.",
    ],
  },
  {
    heading: "Isolation",
    body: [
      "Each workspace's documents and engine sessions are isolated — one engine session per workspace per request, never shared across tenants. Uploads are validated (format sniffing, size caps) and EXIF location metadata is stripped by default.",
    ],
  },
  {
    heading: "Analytics and cookies",
    body: [
      "This marketing site uses cookie-free analytics: no cookies, no cross-site tracking, no ad-tech. Product telemetry is tied to your account for service operation only.",
    ],
  },
  {
    heading: "Your choices",
    body: [
      "Workspace settings control extended log retention. You can delete documents and assets from your workspace. TODO(legal-review): export and deletion request process lands with the reviewed policy.",
    ],
  },
] as const;

export default function PrivacyPage() {
  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-14" data-testid="marketing-legal-privacy">
      <p className="inline-block rounded-full border border-border bg-surface-muted px-3 py-1 font-mono text-xs text-muted-foreground">
        placeholder — pending legal review
      </p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Privacy &amp; data usage</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Plain-language data-usage policy. This page is a placeholder until
        legal review completes — it is informative, not a binding policy.
      </p>
      <div className="mt-10 space-y-8">
        {SECTIONS.map((section) => (
          <div key={section.heading}>
            <h2 className="text-lg font-semibold">{section.heading}</h2>
            <div className="mt-2 space-y-2">
              {section.body.map((paragraph) => (
                <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
