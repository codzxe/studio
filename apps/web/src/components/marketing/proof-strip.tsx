// Proof strip (W8-M) — spec §16.2 section 2: "watch it build layers" proof
// strip. Shows the run lifecycle (§5.1) with the credit cost of each stage
// per §14/§14.2. Repair cycles and retries within a tier never cost extra
// (§14.2 rule 5); the deterministic validator runs in the worker without an
// LLM call (§11.1).

type ProofStep = {
  readonly title: string;
  readonly body: string;
  readonly cost: string;
};

const STEPS: readonly ProofStep[] = [
  {
    title: "Plan",
    body: "Your brief becomes a structured, schema-validated plan — intents, slots, checks. Not vibes.",
    cost: "0 cr",
  },
  {
    title: "Build",
    body: "The agent calls typed tools that place real, named layers — text, photos, groups, masks, components.",
    cost: "run: 1 / 2 / 5 cr",
  },
  {
    title: "Verify",
    body: "Every render passes a deterministic validator; a vision critic scores it against your brief.",
    cost: "included in the run",
  },
  {
    title: "Commit",
    body: "One transaction: a new version with a replayable command log. One undo reverts the whole run.",
    cost: "0 cr",
  },
] as const;

export function ProofStrip() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-14" data-testid="marketing-proof-strip">
      <h2 className="text-2xl font-semibold tracking-tight">Watch it build layers</h2>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Every run is a step-by-step timeline you can inspect — what the agent
        planned, what it placed, what the checks said — before you keep the
        result.
      </p>
      <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
              <span className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
                {step.cost}
              </span>
            </div>
            <h3 className="mt-3 text-base font-semibold">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">
        Failed runs release their credits; repairs and retries within a tier
        never cost extra. If our bug caused a failure, we refund it fully.
      </p>
    </section>
  );
}
