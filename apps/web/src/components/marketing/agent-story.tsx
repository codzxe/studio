import { Badge, Button, Card, RiskBadge, StatusDot } from "@studio/ui";
import { Check } from "lucide-react";

/**
 * The agent three-step story (§8.1 §3): ask → review the plan → applied, with
 * the approval model visible. Presentational only — this is the real content
 * of a chat plan card, built from @studio/ui pieces (Card, RiskBadge, Badge,
 * StatusDot, Button), honest per §13 tone: no "AI magic", no invented metrics.
 */

/** Small numbered step header — editorial, left-aligned. */
function StepLabel({
  step,
  id,
  title,
  line,
}: {
  step: string;
  id: string;
  title: string;
  line: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="tabular text-mono text-muted">{step}</span>
      <div>
        <h3 id={id} className="text-title-m text-primary">
          {title}
        </h3>
        <p className="text-body-s text-muted">{line}</p>
      </div>
    </div>
  );
}

/** Step 1 — Ask: a real chat exchange. */
export function AskCard() {
  return (
    <Card className="flex flex-col gap-3" data-testid="agent-story-ask">
      {/* User message surface per §9: ink-3, 8px radius, no bubble tail. */}
      <p className="rounded-[8px] bg-elevated p-3 text-body-s text-primary">
        Make the title reveal feel weightier — stretch the ease-out over eight frames.
      </p>
      <div className="flex flex-col gap-2">
        <StatusDot tone="signal" pulse data-testid="agent-story-reading">
          Agent reading the comp
        </StatusDot>
        <p className="text-body-s leading-relaxed text-secondary">
          Found the title layer, its scale keyframes and the background fade — three layers, all
          animatable.
        </p>
      </div>
    </Card>
  );
}

/** Step 2 — Review the plan: a realistic plan card with actions. */
export function PlanCard() {
  return (
    <Card className="flex flex-col gap-4 border-strong bg-elevated" data-testid="agent-story-plan">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-medium text-primary">Plan · Edit 3 layers</h3>
        <RiskBadge level="low" />
        <Badge variant="neutral">
          <span className="tabular">~12 credits</span>
        </Badge>
      </div>
      <ol className="flex flex-col gap-2 text-body-s text-secondary">
        <li className="border-l border-border pl-3">
          Stretch the title scale ease-out from 4f to 8f — ease-out quart.
        </li>
        <li className="border-l border-border pl-3">
          Delay the background fade by six frames to sit under the reveal.
        </li>
        <li className="border-l border-border pl-3">
          Render a preview frame at 00:02:00 for the result.
        </li>
      </ol>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm">
          Preview
        </Button>
        <Button variant="primary" size="sm">
          Apply
        </Button>
        <Button variant="ghost" size="sm">
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** Step 3 — Applied: result row with the one-step undo. */
export function AppliedCard() {
  return (
    <Card className="flex flex-col gap-3" data-testid="agent-story-applied">
      <div className="flex items-center gap-2 text-body-s text-primary">
        <Check size={16} strokeWidth={1.75} aria-hidden="true" className="text-success" />
        <span className="tabular">Applied · 3 layers · 0.8s</span>
      </div>
      <p className="text-body-s leading-relaxed text-secondary">
        The comp updates live. Nothing is destructive — every run is one undo step, and the version
        history records the change.
      </p>
      <Button variant="link" size="sm">
        Undo
      </Button>
    </Card>
  );
}

/** The composed three-step story. */
export function AgentStory() {
  return (
    <div className="grid gap-8 md:grid-cols-3 md:gap-6 lg:gap-8">
      <section className="flex flex-col gap-4" aria-labelledby="agent-step-ask">
        <StepLabel
          step="01"
          id="agent-step-ask"
          title="Ask"
          line="Plain language, right next to the timeline."
        />
        <AskCard />
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="agent-step-plan">
        <StepLabel
          step="02"
          id="agent-step-plan"
          title="Review the plan"
          line="Every edit arrives as a plan before it touches a layer."
        />
        <PlanCard />
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="agent-step-applied">
        <StepLabel
          step="03"
          id="agent-step-applied"
          title="Applied"
          line="One undo step, versions recorded."
        />
        <AppliedCard />
      </section>
    </div>
  );
}
