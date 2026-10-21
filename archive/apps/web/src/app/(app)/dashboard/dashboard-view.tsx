"use client";

// app/(app)/dashboard/dashboard-view — the dashboard index client view
// (W8-A): quick-start card (New from prompt / New from template), recent
// documents grid, recent runs strip. All data flows through the placeholder
// api hooks in src/hooks/use-session.tsx (typed gateway client, spec §13).
//
// TODO(W8 follow-ups): document cards link into the editor route once it
// exists; "New from prompt" starts an agent run (POST /v1/documents/:id/runs)
// instead of only creating the document; run rows link to the run timeline.

import { LayoutTemplate, LoaderCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  useCreateDocument,
  useRecentDocuments,
  useRecentRuns,
  useSession,
  type DocumentSummary,
} from "@/hooks/use-session";
import { isApiError } from "@/lib/api";

const RECENT_DOCUMENTS_LIMIT = 8;
const RECENT_RUNS_LIMIT = 6;
/** Placeholder canvas default until the new-document dialog lands. */
const DEFAULT_CANVAS_WIDTH = 1080;
const DEFAULT_CANVAS_HEIGHT = 1080;

// Fixed locale keeps the server-rendered markup identical to the client
// hydration pass (Intl would otherwise resolve different locales).
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(date: Date): string {
  return DATE_TIME_FORMAT.format(date);
}

function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** ApiError messages are user-safe (§13.3); anything else stays generic. */
function toDisplayMessage(error: unknown): string {
  return isApiError(error) ? error.message : "Something went wrong. Please try again.";
}

const CARD_CLASS = "rounded-lg border border-border bg-surface";
const ERROR_CLASS = "rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground";
const EMPTY_CLASS =
  "rounded-lg border border-dashed border-border bg-surface p-4 text-sm text-muted-foreground";
const RETRY_CLASS = "font-medium text-foreground underline underline-offset-2";
const INPUT_CLASS =
  "h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm font-medium transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const DOCUMENT_SKELETON_IDS = ["doc-a", "doc-b", "doc-c", "doc-d"] as const;
const RUN_SKELETON_IDS = ["run-a", "run-b", "run-c"] as const;

export function DashboardView() {
  const { activeWorkspace } = useSession();

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent documents and agent runs in {activeWorkspace?.name ?? "your workspace"}.
        </p>
      </header>
      <QuickStartCard />
      <RecentDocumentsSection />
      <RecentRunsSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick start
// ---------------------------------------------------------------------------

function QuickStartCard() {
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const { pending, createDocument } = useCreateDocument();

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || pending) {
      return;
    }
    const result = await createDocument({
      name: trimmed,
      width: DEFAULT_CANVAS_WIDTH,
      height: DEFAULT_CANVAS_HEIGHT,
    });
    if (result.ok) {
      setName("");
      setMessage(null);
    } else {
      setMessage(result.message);
    }
  }

  return (
    <section aria-labelledby="quick-start-heading" className={`${CARD_CLASS} p-5`}>
      <h2 id="quick-start-heading" className="text-base font-semibold">
        Start something new
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Describe the outcome — the agent composes real editable layers, never a flat image.
      </p>
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="new-document-name" className="sr-only">
          What do you want to make?
        </label>
        <input
          id="new-document-name"
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder="A poster for our autumn sale"
          maxLength={200}
          autoComplete="off"
          className={INPUT_CLASS}
        />
        <button
          type="submit"
          disabled={pending || name.trim() === ""}
          className={PRIMARY_BUTTON_CLASS}
        >
          {pending ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          New from prompt
        </button>
      </form>
      {message !== null ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {message}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        Your prompt names the new document; the agent run and the editor follow in the next
        build. Agent runs cost credits: quick 1, standard 2, complex 5.
      </p>
      <div className="mt-4 border-t border-border pt-4">
        <Link href="/templates" className={SECONDARY_BUTTON_CLASS}>
          <LayoutTemplate className="size-4" aria-hidden="true" />
          New from template
        </Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent documents
// ---------------------------------------------------------------------------

function RecentDocumentsSection() {
  const query = useRecentDocuments(RECENT_DOCUMENTS_LIMIT);

  return (
    <section aria-labelledby="recent-documents-heading">
      <h2 id="recent-documents-heading" className="text-base font-semibold">
        Recent documents
      </h2>
      <div className="mt-3">
        {query.isPending ? (
          <>
            <span role="status" className="sr-only">
              Loading recent documents…
            </span>
            <ul aria-hidden="true" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {DOCUMENT_SKELETON_IDS.map((id) => (
                <li key={id} className={`${CARD_CLASS} p-4`}>
                  <div className="aspect-video w-full animate-pulse rounded-md bg-surface-muted" />
                  <div className="mt-3 h-4 w-2/3 animate-pulse rounded bg-surface-muted" />
                  <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-surface-muted" />
                </li>
              ))}
            </ul>
          </>
        ) : query.isError ? (
          <p role="status" className={ERROR_CLASS}>
            Couldn&apos;t load documents — {toDisplayMessage(query.error)}.{" "}
            <button
              type="button"
              onClick={() => {
                void query.refetch();
              }}
              className={RETRY_CLASS}
            >
              Retry
            </button>
          </p>
        ) : (query.data?.documents.length ?? 0) === 0 ? (
          <p className={EMPTY_CLASS}>
            No documents yet — start one above or pick a template.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {query.data?.documents.map((document) => (
              <li key={document.id}>
                <DocumentCard document={document} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DocumentCard({ document }: { document: DocumentSummary }) {
  return (
    // TODO(editor wave): link into the editor route (GET /v1/documents/:id, §13.1).
    <article className={`${CARD_CLASS} h-full p-4 transition-colors hover:border-foreground/20`}>
      <div
        aria-hidden="true"
        className="flex aspect-video items-center justify-center rounded-md bg-surface-muted"
      >
        <span className="font-mono text-xs text-muted-foreground">
          {document.width_px}×{document.height_px}
        </span>
      </div>
      <h3 className="mt-3 truncate text-sm font-medium">{document.name}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {document.template_id === null ? "Blank" : document.template_id} · rev{" "}
        {document.current_revision}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Updated {formatDateTime(document.updated_at)}
      </p>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

function RecentRunsSection() {
  const query = useRecentRuns(RECENT_RUNS_LIMIT);

  return (
    <section aria-labelledby="recent-runs-heading">
      <h2 id="recent-runs-heading" className="text-base font-semibold">
        Recent runs
      </h2>
      <div className="mt-3">
        {query.isPending ? (
          <>
            <span role="status" className="sr-only">
              Loading recent runs…
            </span>
            <ul aria-hidden="true" className="flex gap-3 overflow-hidden">
              {RUN_SKELETON_IDS.map((id) => (
                <li
                  key={id}
                  className="h-20 w-56 shrink-0 animate-pulse rounded-lg bg-surface-muted"
                />
              ))}
            </ul>
          </>
        ) : query.isError ? (
          <p role="status" className={ERROR_CLASS}>
            Couldn&apos;t load runs — {toDisplayMessage(query.error)}.{" "}
            <button
              type="button"
              onClick={() => {
                void query.refetch();
              }}
              className={RETRY_CLASS}
            >
              Retry
            </button>
          </p>
        ) : (query.data?.runs.length ?? 0) === 0 ? (
          <p className={EMPTY_CLASS}>
            No agent runs yet — the first one starts from any document.
          </p>
        ) : (
          <ul className="flex gap-3 overflow-x-auto pb-2">
            {query.data?.runs.map((run) => (
              <li
                key={run.run_id}
                className="flex min-w-56 shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  {/* TODO(theme): semantic status colors once globals.css maps
                      success/info/destructive (packages/ui tokens has them). */}
                  <span
                    className="inline-flex items-center rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium capitalize"
                  >
                    {run.status.replaceAll("_", " ")}
                  </span>
                  <span className="text-xs text-muted-foreground capitalize">{run.tier}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(run.created_at)} · {formatCredits(run.credits.charged)} credits
                  charged
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
