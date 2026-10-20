// Marketing home stub (W1-K) — spec §16.2 option (a): marketing routes live
// inside this Next app. This is the wave-1 hero + feature skeleton; the
// full §16.2 build-out is tracked in apps/web/README.md.
//
// Truthfulness rules (§16.2): no competitor names, no "unlimited" claims,
// PSD stays labeled experimental, and pricing numbers only appear once the
// pricing page mirrors §14 exactly.

import Link from "next/link";

// TODO(branding): "Layerly" is a temporary neutral working name (W1-K).
const SITE_NAME = "Layerly";

const features = [
  {
    title: "Editable layers, not flat pixels",
    body: "Every result is a real layered document — backgrounds, photos, text, shapes and masks. Refine any layer by hand or by chat, then export the native file, PNG, JPG or experimental PSD.",
  },
  {
    title: "One-undo agent runs",
    body: "Each agent run is a single transaction against the document. Undo reverts the whole run in one step — or keep the partial work you like.",
  },
  {
    title: "Start from templates",
    body: "Reusable templates and components keep layouts consistent. The agent composes with real layout primitives and validates every render.",
  },
] as const;

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* TODO(§16.2): sticky site header with nav + pricing link. */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        {/* TODO(branding): placeholder wordmark — replace with real logo. */}
        <span className="font-mono text-lg font-semibold tracking-tight">{SITE_NAME}</span>
        <Link
          href="/sign-in"
          className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      {/* TODO(§16.2): hero gets a 20–40 s looping prompt → layered-result
          screen capture with the layers panel visible, plus a "watch it build
          layers" proof strip. No images until real assets exist. */}
      <main className="flex flex-1 flex-col">
        <section className="mx-auto w-full max-w-4xl px-6 py-20 text-center">
          <p
            className="mb-4 inline-block rounded-full border border-border bg-surface-muted px-3 py-1 font-mono text-xs text-muted-foreground"
          >
            prompt → layered document
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Describe it. Get a real, layered document.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            Type what you want. AI agents compose editable layers inside a
            professional image editor — never a flat AI image. Then keep editing
            by hand or by chat, with versions, comments and export.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {/* TODO(§16.2): CTA copy must state trial credits exactly per §14.1
                (one-time 30 credits, no card) on the real pricing page. */}
            <Link
              href="/sign-up"
              className="rounded-md bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
            >
              Create your account
            </Link>
            <Link
              href="/sign-in"
              className="rounded-md border border-border bg-surface px-5 py-3 text-sm font-semibold transition hover:bg-surface-muted"
            >
              Sign in
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            New accounts start with one-time trial credits — no card required.
          </p>
        </section>

        {/* TODO(§16.2 wave 8): template gallery with downloadable outputs,
            before/after (flat image vs editable layers), pricing table
            mirroring §14, FAQ, security & privacy pages, changelog. */}
        <section className="mx-auto grid w-full max-w-6xl gap-6 px-6 pb-20 sm:grid-cols-3">
          {features.map((feature) => (
            <article
              key={feature.title}
              className="rounded-lg border border-border bg-surface p-6 text-left"
            >
              <h2 className="text-base font-semibold">{feature.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.body}
              </p>
            </article>
          ))}
        </section>
      </main>

      {/* TODO(§16.2): footer with legal pages (privacy, terms, refunds),
          status-page link and the interactive wasm-editor demo. */}
      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} {SITE_NAME}. All rights reserved.
      </footer>
    </div>
  );
}
