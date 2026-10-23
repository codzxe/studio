import { Badge } from "./badge";
import { Button } from "./button";
/**
 * Card / ProjectCard — §7.3 example gallery (documentation-as-code).
 *
 * The quiet panel card and the thumbnail-dominating project card, in one
 * token-styled file. Typecheck-only docs — never run by vitest.
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ProjectCard,
} from "./card";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

/** Example real thumbnail — a 16/9 composition frame (§7.3: the work is the hero). */
function ExampleThumbnail() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 160 90"
      className="h-full w-full"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <rect x="8" y="8" width="144" height="74" stroke="var(--line-strong)" />
      <path d="M8 58h144" stroke="var(--line-strong)" />
      <circle cx="80" cy="33" r="9" stroke="var(--line-strong)" />
    </svg>
  );
}

export default function CardExample() {
  return (
    <section
      aria-label="Card examples"
      className="flex flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Composed panel card — no shadow at rest (§7.3)</h3>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Render minutes</CardTitle>
            <CardDescription>Current cycle · Starter plan</CardDescription>
          </CardHeader>
          <CardContent>12 of 30 minutes used across 4 renders.</CardContent>
          <CardFooter>
            <Button size="sm" variant="secondary">
              View invoices
            </Button>
            <Button size="sm" variant="primary">
              Buy credits
            </Button>
          </CardFooter>
        </Card>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>ProjectCard — 16/9 slate thumbnail, staggered reveal (§8.4)</h3>
        <div className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
          <ProjectCard
            name="Launch film"
            duration="00:12"
            comps={3}
            updated="Updated 2h ago"
            stagger={0}
            onOpen={() => {}}
          />
          <ProjectCard
            name="Teaser"
            duration="00:04"
            comps={1}
            updated="Updated yesterday"
            stagger={40}
            thumbnail={<ExampleThumbnail />}
            onOpen={() => {}}
            onDuplicate={() => {}}
            onMore={() => {}}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>ProjectCard with a status badge in context</h3>
        <div className="flex max-w-2xl flex-wrap gap-3">
          <Badge variant="signal">New</Badge>
          <ProjectCard
            name="Titles v4"
            duration="00:12"
            comps={3}
            updated="Updated 2h ago"
            onOpen={() => {}}
          />
        </div>
      </div>
    </section>
  );
}
