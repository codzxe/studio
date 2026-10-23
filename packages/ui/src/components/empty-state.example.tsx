import { Button } from "./button";
/**
 * EmptyState — §7.12 example gallery (documentation-as-code).
 *
 * One clear sentence, one primary action, one secondary link; optional
 * geometric 1px illustration; no 3D characters, no emoji. Typecheck-only
 * docs — never run by vitest.
 */
import { EmptyState } from "./empty-state";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function EmptyStateExample() {
  return (
    <section
      aria-label="Empty state examples"
      className="flex max-w-2xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Canonical — sentence + primary action + secondary link</h3>
        <EmptyState
          title="No projects yet. Start from a composition or import an .ecproj."
          action={<Button>New project</Button>}
          secondaryLink={{ label: "Import a project", href: "/w/import" }}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>No illustration — inside tables and drawers</h3>
        <EmptyState
          title="No comments on this composition yet."
          withIllustration={false}
          action={<Button variant="secondary">Ask the agent to add one</Button>}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Custom 1px illustration</h3>
        <EmptyState
          title="No renders yet. Render a version to see it here."
          illustration={
            <svg
              aria-hidden="true"
              viewBox="0 0 96 48"
              className="h-12 w-24 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            >
              <circle cx="48" cy="24" r="12" stroke="var(--line-strong)" />
              <path d="M44 24h8M48 20v8" stroke="var(--line-strong)" />
            </svg>
          }
          action={<Button>New render</Button>}
        />
      </div>
    </section>
  );
}
