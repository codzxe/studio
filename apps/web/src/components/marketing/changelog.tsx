// Changelog (W8-M) — spec §16.2 section 8: changelog. This is a pre-beta
// build log: entries describe milestones that actually shipped in this
// repo (verified against the fleet worklog), with NO invented dates or
// version numbers. Dated releases start with the public beta.

type LogEntry = {
  readonly title: string;
  readonly body: string;
};

const ENTRIES: readonly LogEntry[] = [
  {
    title: "Deterministic agent runs, end to end",
    body: "A prompt becomes a layered document through the real engine protocol, with a replayable command log and a byte-stable output digest across runs.",
  },
  {
    title: "One-undo transactions",
    body: "Agent begin/commit/rollback landed in the engine command surface — an entire run reverts in a single undo.",
  },
  {
    title: "Template catalog",
    body: "15+ templates across social, print, web and presentation sets, each defined by a manifest with named layers and slot rules.",
  },
  {
    title: "Reusable components",
    body: "Badges, price tags, CTAs, dividers and more ship as variable-driven component masters that the agent instances like code imports.",
  },
  {
    title: "Quality gates",
    body: "Every run is checked by a deterministic validator, and prompt or model changes must pass the eval suite before shipping.",
  },
] as const;

export function Changelog() {
  return (
    <section
      id="changelog"
      className="mx-auto w-full max-w-6xl scroll-mt-16 px-6 py-14"
      data-testid="marketing-changelog"
    >
      <h2 className="text-2xl font-semibold tracking-tight">Changelog</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Pre-beta build log. Dated, versioned releases start with the public
        beta — no fake dates in the meantime.
      </p>
      <ol className="mt-8 space-y-3">
        {ENTRIES.map((entry) => (
          <li key={entry.title} className="rounded-lg border border-border bg-surface p-5">
            <h3 className="text-sm font-semibold">{entry.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{entry.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
