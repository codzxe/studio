// FAQ (W8-M) — spec §16.2 section 6: FAQ must cover what is editable, PSD
// (experimental), refunds, and data usage. All answers are grounded in the
// spec: §10.1/§10.3 (editability, formats), §14.2 (refunds/credits),
// §1.4/§1.5-6 (trial, no free tier, data usage). No competitor names, no
// "unlimited" claims, PSD labeled experimental.

import Link from "next/link";

type FaqItem = {
  readonly question: string;
  readonly answer: readonly string[];
  readonly link?: { readonly href: string; readonly label: string };
};

const FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: "What exactly is editable in the result?",
    answer: [
      "Every agent result is a real layered document — the native .pcraft file plus PNG and JPG exports. Layers are named and grouped the way a human would structure a file: Background, Photo, Content (Headline, Subhead), Brand (Badge, Logo), Effects.",
      "Text stays editable text. Photos land as replaceable smart objects. Masks and adjustments are non-destructive. You can edit anything by hand in the editor or by chat, version it, comment on it, and undo an entire agent run in one step.",
    ],
  },
  {
    question: "Is PSD export production-ready?",
    answer: [
      "No — PSD export is experimental. It is best-effort and always comes with a fidelity report listing anything the export could not carry over. We never promise a perfect PSD, and we label it experimental everywhere we mention it.",
      "The native .pcraft format is lossless and round-trip-perfect; PNG and JPG exports are exact renders. PSD gets the experimental label until its fidelity is solid.",
    ],
  },
  {
    question: "How do refunds and failed runs work?",
    answer: [
      "Runs reserve their credit cost up front and commit only on success. If a run fails before doing any work, the full reservation is released — you pay nothing. A partial failure charges at most half the run's cost, and the document rolls back unless you choose to keep the partial work.",
      "If a failure was our bug, we refund it fully and flag the run for review. Repairs and retries within a run never cost extra.",
      "The trial is a one-time 30-credit grant with no card required — one per account. There is no free tier after that.",
    ],
  },
  {
    question: "How is my data used?",
    answer: [
      "Your prompts, documents and renders are processed only through paid API endpoints that do not train on your data. We never route customer content through free LLM tiers, and we do not train or fine-tune models on anything you create here.",
      "Prompts and renders are not logged beyond a run's retention window unless you explicitly turn that on for your workspace. Payments are handled by Stripe — card data never touches our servers."
    ],
    link: {
      href: "/legal/privacy",
      label: "Read the privacy page (placeholder, pending legal review)",
    },
  },
  {
    question: "What does a run cost, and where do I see it?",
    answer: [
      "Quick edit runs cost 1 credit, standard runs 2, complex runs 5. Premium model routes double the tier's cost; max routes quadruple it. Generated images cost 1 credit per image at 1024², 2 per HD image. 1 credit = $0.10.",
      "Every action's cost is shown on the pricing section of this page — before you sign up — and each run shows its credit cost before it starts.",
    ],
  },
  {
    question: "Can my team work in one workspace?",
    answer: [
      "Yes. Plans include 1, 3 or 10 seats (Starter, Pro, Max) with roles, invites, comments and versions; extra seats are +$8/mo each. Workspaces are isolated from each other by design.",
    ],
  },
] as const;

export function Faq() {
  return (
    <section id="faq" className="mx-auto w-full max-w-4xl scroll-mt-16 px-6 py-14" data-testid="marketing-faq">
      <h2 className="text-2xl font-semibold tracking-tight">FAQ</h2>
      <div className="mt-8 space-y-3">
        {FAQ_ITEMS.map((item) => (
          <details key={item.question} className="group rounded-lg border border-border bg-surface px-5 py-4">
            <summary className="list-none text-sm font-semibold underline-offset-4 hover:underline">
              {item.question}
            </summary>
            <div className="mt-3 space-y-2">
              {item.answer.map((paragraph) => (
                <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">
                  {paragraph}
                </p>
              ))}
              {item.link ? (
                <Link
                  href={item.link.href}
                  className="inline-block text-sm font-medium underline underline-offset-4"
                >
                  {item.link.label}
                </Link>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
