import { AgentStory } from "@/components/marketing/agent-story";
import { EditorFrame } from "@/components/marketing/editor-frame";
import { FilmSlot } from "@/components/marketing/film-slot";
import { PricingCards } from "@/components/marketing/pricing-cards";
import { Brand } from "@studio/config";
import { Avatar, Badge, FrameLine, buttonVariants } from "@studio/ui";
import { Clapperboard, FileUp, KeySquare, LayoutGrid, MessageSquare } from "lucide-react";
import Link from "next/link";

/**
 * The landing page — docs/UI_DESIGN_SYSTEM.md §8.1, all eleven sections in
 * order. Honest surfaces throughout (§16): no fake logos, no invented
 * metrics, no gradient text; ONE .hero-atmosphere radial on the hero.
 *
 * Section markers carry data-testid="landing-*" for the section test; the
 * footer (§11) is rendered by the (marketing) layout and carries
 * data-testid="landing-footer".
 */

/** Shared editorial rhythm for a section shell (§5.1 gutters, §5.2 left edge). */
function SectionShell({
  id,
  testid,
  children,
  className = "",
}: {
  id?: string;
  testid?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      data-testid={testid}
      className={`mx-auto w-full max-w-(--width-marketing-max) px-5 py-20 md:px-8 lg:px-12 xl:px-16 xl:py-28 ${className}`}
    >
      {children}
    </section>
  );
}

/** Display section heading — serif, short (§4.2 display-l for landing sections). */
function SectionHeading({ title, line }: { title: string; line: string }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-display text-display-m text-balance text-primary md:text-display-l">
        {title}
      </h2>
      <p className="max-w-[68ch] text-body-l text-secondary">{line}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ §8.1 1 · Hero */

const PROOF_TOKENS = ["Keyframes", "3D", "300+ effects", "Agent edits", "Version history"] as const;

/* ---------------------------------------------------------------- §8.1 5 · Workflow */

const WORKFLOW_STEPS = [
  {
    step: "01",
    icon: FileUp,
    title: "Import",
    line: "Bring in media, fonts, LUTs — or an existing .ecproj project.",
  },
  {
    step: "02",
    icon: LayoutGrid,
    title: "Compose",
    line: "Layer compositions, shapes, text, 3D — real layers, named.",
  },
  {
    step: "03",
    icon: KeySquare,
    title: "Animate",
    line: "Keyframes with real eases on every property. Frame-accurate.",
  },
  {
    step: "04",
    icon: MessageSquare,
    title: "Review",
    line: "Comments anchored to a comp, a layer or a frame. Resolve, ship.",
  },
  {
    step: "05",
    icon: Clapperboard,
    title: "Render",
    line: "Queue MP4, ProRes, PNG sequences, GIF or WAV renders.",
  },
] as const;

/* --------------------------------------------------------- §8.1 7 · Performance rows */

/**
 * The §6 performance BUDGETS (BUILD_PLAN §6), not measurements — nothing has
 * a measured p75 yet (docs/performance.md: “Not yet measured”). Presenting
 * them as “p75, reference machine” would be an invented metric (§16.6/§17);
 * the copy below says they are budgets and where the measured numbers will
 * come from.
 */
const PERFORMANCE_ROWS = [
  { metric: "Editor ready, warm cache (budget)", value: "< 6 s" },
  { metric: "Editor ready, cold (budget)", value: "< 12 s" },
  { metric: "First chat token (budget)", value: "< 1.5 s" },
  { metric: "Local apply (budget)", value: "< 300 ms" },
  { metric: "Playback, 1080p (budget)", value: "60 fps" },
] as const;

/* ------------------------------------------------------------------ §8.1 8 · Pricing */

// The section renders the SAME catalog-derived PricingCards component as
// /pricing (components/marketing/pricing-cards.tsx → @studio/config
// PLAN_CATALOG). No local plan table exists on this page by design: a second
// price set here is exactly the drift the stub audit killed (W4-KILL), so the
// landing can never contradict /pricing again.

/* --------------------------------------------------------------------- §8.1 9 · FAQ */

const FAQ_ITEMS = [
  {
    q: "Which browsers are supported?",
    a: "Any recent browser with WebGPU or WebGL2: Chrome and Edge 113+, Firefox 121+, Safari 18+. The editor checks capabilities when it loads — if your browser can't run it, you get a rendered preview instead of a broken canvas.",
  },
  {
    q: "What file formats can I import and export?",
    a: "Projects are .ecproj files: import and export the whole project — compositions, layers, keyframes, effects and the render queue intact. Renders export as MP4, ProRes, PNG sequences, GIF or WAV.",
  },
  {
    q: "Where does my data live?",
    a: "Project files and uploaded assets live in your workspace's object storage; every save is an immutable version snapshot, so nothing gets overwritten. Data stays inside your workspace's storage region and is never used to train models.",
  },
  {
    q: "Which models does the agent use?",
    a: "A fast model for everyday edits and a smart model for heavy reasoning, routed per plan. Before a run you see the plan, its risk level and the estimated credit cost — model names and costs are shown up front, never hidden.",
  },
  {
    q: "Can I use the editor without the agent?",
    a: "Yes. The agent is a panel beside the timeline, not a paywall — every manual tool, keyframe and effect works without it. You can hide the panel entirely.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes — from billing, in two clicks, no retention flow. Your work is never deleted for non-payment: unpaid workspaces go read-only, not blank.",
  },
] as const;

/* --------------------------------------------------------------------------- page */

export default function LandingPage() {
  return (
    <>
      {/* 1 · Hero — one atmosphere radial, serif headline, honest subline. */}
      <section
        data-testid="landing-hero"
        className="relative overflow-hidden"
        aria-labelledby="hero-title"
      >
        <div className="hero-atmosphere" aria-hidden="true" />
        <div className="relative mx-auto flex w-full max-w-(--width-marketing-max) flex-col gap-6 px-5 py-20 md:px-8 lg:px-12 xl:px-16 xl:py-28">
          <p className="text-label uppercase tracking-[0.06em] text-muted">
            {Brand.productName} — Agent Motion Suite
          </p>
          <h1
            id="hero-title"
            className="font-display text-display-m text-balance text-primary md:text-display-xl"
          >
            {Brand.tagline}.
          </h1>
          <p className="max-w-[68ch] text-body-l text-secondary">{Brand.heroSubline}</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link href="/sign-up" className={buttonVariants({ variant: "primary", size: "lg" })}>
              Start 14-day trial
            </Link>
            <a href="#film" className={buttonVariants({ variant: "secondary", size: "lg" })}>
              Watch the 90s film
            </a>
          </div>
          <p className="text-caption text-muted">Card required · Cancel anytime · No free tier</p>
          {/* W5-03: id="film" — the hero "Watch the 90s film" anchor resolves
              here (a dead in-page anchor is the dead-link class the stub
              sweep kills; the slot itself is W5-02's capture-owed slate). */}
          <div id="film" className="mt-6 w-full">
            <FilmSlot />
          </div>
        </div>
      </section>

      {/* 2 · Proof strip — factual capabilities, not logos. */}
      <section
        id="work"
        data-testid="landing-proof"
        className="border-y border-border bg-page"
        aria-label="The work"
      >
        <div className="mx-auto w-full max-w-(--width-marketing-max) px-5 py-12 md:px-8 lg:px-12 xl:px-16">
          <FrameLine label="00:00:01 — THE WORK" draw />
          <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-baseline lg:justify-between">
            <p className="text-body-l text-secondary">
              Frame-accurate timeline. Real layers. Editable output.
            </p>
            <ul
              className="flex flex-wrap items-center gap-x-3 gap-y-2 text-caption text-muted"
              aria-label="Capabilities"
            >
              {PROOF_TOKENS.map((token, index) => (
                <li key={token} className="flex items-center gap-3">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-disabled">
                      ·
                    </span>
                  ) : null}
                  <span>{token}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 3 · The agent — ask, review the plan, applied. */}
      <SectionShell id="agent" testid="landing-agent">
        <SectionHeading
          title="The agent"
          line="Ask in plain language. Review the plan. Apply with one undo step."
        />
        <div className="mt-12">
          <AgentStory />
        </div>
      </SectionShell>

      {/* 4 · The editor — full-bleed annotated viewport, no fake screenshots. */}
      <section
        id="product"
        data-testid="landing-editor"
        className="border-y border-border bg-page"
        aria-label="The editor"
      >
        <div className="mx-auto flex w-full max-w-(--width-marketing-max) flex-col gap-8 px-5 py-20 md:px-8 lg:px-12 xl:px-16 xl:py-28">
          <SectionHeading
            title="The editor"
            line="A complete compositing environment — compositions, a keyframe timeline, 3D and hundreds of built-in effects — running as-is in the browser."
          />
          <EditorFrame />
        </div>
      </section>

      {/* 5 · Workflow — import, compose, animate, review, render. */}
      <SectionShell testid="landing-workflow">
        <FrameLine label="00:00:04 — WORKFLOW" draw />
        <div className="mt-12">
          <SectionHeading
            title="From media to master"
            line="Five steps, no detours — the same project file from first import to final render."
          />
        </div>
        <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-5 lg:gap-6">
          {WORKFLOW_STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <li key={step.step} className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="tabular text-mono text-muted">{step.step}</span>
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-panel text-secondary"
                  >
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                </div>
                <h3 className="text-title-m text-primary">{step.title}</h3>
                <p className="text-body-s leading-relaxed text-secondary">{step.line}</p>
              </li>
            );
          })}
        </ol>
      </SectionShell>

      {/* 6 · Collaboration — comments, versions, presence. */}
      <SectionShell testid="landing-collaboration">
        <SectionHeading
          title="Collaboration"
          line="Comments anchored to the work. Versions that never rewrite. One writer at a time — no mystery merges."
        />
        <div className="mt-12 grid gap-6 md:grid-cols-3 lg:gap-8">
          {/* Comments */}
          <div className="flex flex-col gap-3 rounded-md border border-border bg-panel p-6">
            <h3 className="text-title-m text-primary">Comments</h3>
            <p className="text-body-s leading-relaxed text-secondary">
              Notes anchored to a composition, a layer or a frame — resolved in place, nothing
              floats free.
            </p>
            <div className="mt-2 flex items-start gap-3 border-t border-border pt-4">
              <Avatar name="Alex Jordan" size="sm" />
              <p className="text-body-s text-secondary">
                Hold this reveal two frames longer — it lands early.
              </p>
            </div>
          </div>
          {/* Versions */}
          <div className="flex flex-col gap-3 rounded-md border border-border bg-panel p-6">
            <h3 className="text-title-m text-primary">Versions</h3>
            <p className="text-body-s leading-relaxed text-secondary">
              Every save is an immutable snapshot. Restoring creates a new version — history never
              rewrites.
            </p>
            <ol className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
              {["v14 · applied by agent", "v13 · preview render", "v12 · manual save"].map(
                (entry, index) => (
                  <li key={entry} className="flex items-center gap-2 text-caption text-muted">
                    {/* §3.1 — violet is reserved for version/comment accents. */}
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-pill ${index === 0 ? "bg-violet" : "bg-muted"}`}
                    />
                    <span className="tabular">{entry}</span>
                  </li>
                ),
              )}
            </ol>
          </div>
          {/* Presence */}
          <div className="flex flex-col gap-3 rounded-md border border-border bg-panel p-6">
            <h3 className="text-title-m text-primary">Presence</h3>
            <p className="text-body-s leading-relaxed text-secondary">
              See who is in the project and who holds the write lease — one writer at a time,
              everyone reads.
            </p>
            <div className="mt-2 flex flex-col gap-3 border-t border-border pt-4">
              <div className="flex -space-x-2">
                <Avatar name="Alex Jordan" size="sm" className="ring-2 ring-app" />
                <Avatar name="Mia Reyes" size="sm" className="ring-2 ring-app" />
                <Avatar name="Tom Silva" size="sm" className="ring-2 ring-app" />
              </div>
              <Badge variant="signal" className="self-start">
                <span className="tabular">Alex is editing</span>
              </Badge>
              <p className="text-caption text-muted">
                Lease example — 2-minute heartbeat, 5-minute expiry.
              </p>
            </div>
          </div>
        </div>
      </SectionShell>

      {/* 7 · Performance — honest SLO numbers only. */}
      <section
        data-testid="landing-performance"
        className="border-y border-border bg-page"
        aria-label="Performance"
      >
        <div className="mx-auto w-full max-w-(--width-marketing-max) px-5 py-20 md:px-8 lg:px-12 xl:px-16 xl:py-28">
          <FrameLine label="00:00:09 — PERFORMANCE" draw />
          <div className="mt-12">
            <SectionHeading
              title="Fast where it counts"
              line="GPU-accelerated, browser-native, no install. These are the budgets we hold ourselves to — not measurements; the measured numbers get published here when staging deploys begin."
            />
          </div>
          <dl className="mt-12 flex flex-col">
            {PERFORMANCE_ROWS.map((row) => (
              <div
                key={row.metric}
                className="flex items-baseline justify-between gap-6 border-b border-border py-4"
              >
                <dt className="text-body text-secondary">{row.metric}</dt>
                <dd className="tabular font-mono text-body-l text-primary">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-caption text-muted">
            Performance budgets from our build plan; p75 measurements land with the first staging
            deploys.
          </p>
        </div>
      </section>

      {/* 8 · Pricing — the /pricing cards verbatim (catalog-derived, §8.8). */}
      <SectionShell id="pricing" testid="landing-pricing">
        <FrameLine label="00:00:11 — PRICING" draw />
        <div className="mt-12">
          <SectionHeading
            title="Pricing"
            line="Three plans with included monthly credits, seats, storage and render minutes. One-time credit top-ups any time."
          />
        </div>
        <div className="mt-12">
          <PricingCards />
        </div>
        <div className="mt-8 flex flex-col gap-2 border-t border-border pt-6">
          <p className="text-body-s text-secondary">
            Need more mid-cycle? One-time credit top-ups, priced at checkout — never a forced
            upgrade.
          </p>
          <p className="text-body-s text-secondary">
            14 days free with card. No free tier. Cancel anytime.
          </p>
        </div>
      </SectionShell>

      {/* 9 · FAQ — honest answers, native disclosures (no JS needed). */}
      <section
        data-testid="landing-faq"
        className="border-y border-border bg-page"
        aria-labelledby="faq-title"
      >
        <div className="mx-auto w-full max-w-(--width-marketing-max) px-5 py-20 md:px-8 lg:px-12 xl:px-16 xl:py-28">
          <h2
            id="faq-title"
            className="font-display text-display-m text-balance text-primary md:text-display-l"
          >
            Questions, answered
          </h2>
          <div className="mt-12 flex flex-col">
            {FAQ_ITEMS.map((item) => (
              <details key={item.q} className="group border-b border-border">
                <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-body text-primary transition-colors duration-120 hover:text-signal">
                  {item.q}
                  <span
                    aria-hidden="true"
                    className="text-muted transition-transform duration-180 ease-out group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-[80ch] pb-5 text-body-s leading-relaxed text-secondary">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* 10 · Final CTA — title card. */}
      <SectionShell testid="landing-final-cta" className="text-center">
        <h2 className="font-display text-display-m text-balance text-primary md:text-display-l">
          Start the 14-day trial.
        </h2>
        <div className="mt-8 flex flex-col items-center gap-3">
          <Link href="/sign-up" className={buttonVariants({ variant: "primary", size: "lg" })}>
            Start 14-day trial
          </Link>
          <p className="text-caption text-muted">Card required.</p>
        </div>
      </SectionShell>

      {/* 11 · Footer — rendered by the (marketing) layout (SiteFooter). */}
    </>
  );
}
