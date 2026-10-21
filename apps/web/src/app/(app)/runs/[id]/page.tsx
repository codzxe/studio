"use client";

// apps/web — run timeline page (W8-E). Owner: W8-E (docs/AGENTS.md).
//
// Route: GET /runs/:id → the §20 #5 acceptance surface — the UI streams a
// run's progress (plan → steps → previews → verdicts) live over the §13.2
// SSE stream and finishes with a preview.
//
// Data flow:
//   - GET /v1/runs/:id (§13.1) seeds the page (status, plan, steps, cost) via
//     React Query — the providers.tsx QueryClient is the server-state layer.
//   - GET /v1/runs/:id/events (§13.2, W1-K `RunEventStream`) streams the live
//     overlay through `useRunEvents`: Last-Event-ID connect, seq dedupe,
//     resync-sentinel reconnect, terminal → stop + final GET refresh.
//   - POST /v1/runs/:id/cancel (§3.4) while active; the SSE run.cancelled
//     event reconciles any race with the POST response.
//   - POST /v1/runs (§13.1) backs the §24.4 one-click retry: a NEW run with
//     the SAME brief. The brief comes from the documented client-side seam in
//     timeline-state.ts (readRetryBrief) — GET /v1/runs/:id does not expose
//     the original prompt; flagged for the gateway owner in the worklog.
//
// Errors render as typed, user-safe cards (§13.3 vocabulary only — no raw
// payloads, no internal ids, no stack traces).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import { PlanCard } from "@/components/runs/plan-card";
import { PreviewPanel } from "@/components/runs/preview-panel";
import { RunHeader } from "@/components/runs/run-header";
import {
  cancelRunResponseSchema,
  createRunResponseSchema,
  readRetryBrief,
  runDetailSchema,
  writeRetryBrief,
} from "@/components/runs/timeline-state";
import { Timeline } from "@/components/runs/timeline";
import { useNow, useRunEvents } from "@/components/runs/use-run-events";
import {
  CritiqueVerdictCard,
  FailureCard,
  ValidateVerdictCard,
} from "@/components/runs/verdict-card";
import { createGatewayClientFromEnv, isApiError } from "@/lib/api";

/** §3.4 — derived keys keep double-clicks idempotent (≤128 chars, capped). */
function derivedIdempotencyKey(parts: readonly string[]): string {
  return parts.join(":").slice(0, 128);
}

function PageSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8"
      aria-busy="true"
      aria-label="Loading the run"
    >
      <div className="h-20 animate-pulse rounded-lg bg-muted" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr),22rem]">
        <div className="space-y-6">
          <div className="h-48 animate-pulse rounded-lg bg-muted" />
          <div className="h-64 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="space-y-6">
          <div className="h-80 animate-pulse rounded-lg bg-muted" />
          <div className="h-40 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    </div>
  );
}

function MessageCard({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  );
}

export default function RunPage() {
  const params = useParams<{ id: string }>();
  const rawId = params?.id;
  const runId = typeof rawId === "string" ? rawId : Array.isArray(rawId) ? (rawId[0] ?? "") : "";
  const router = useRouter();
  const queryClient = useQueryClient();

  // One gateway client per mount (W1-K contract; env fails fast on first use).
  const [client] = useState(() => createGatewayClientFromEnv());

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () =>
      client.get(`/runs/${encodeURIComponent(runId)}`, { schema: runDetailSchema }),
    enabled: runId !== "",
  });

  // §13.2 live overlay; the terminal event triggers the final §13.1 refresh.
  const onTerminal = useCallback(() => {
    if (runId === "") {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["run", runId] });
  }, [queryClient, runId]);

  const { timeline, streamState, streamMessage, reconnect } = useRunEvents({
    client,
    runId,
    detail: runQuery.data ?? null,
    onTerminal,
  });

  const nowMs = useNow(!timeline.terminal);

  // §3.4 cancel — the run.cancelled event reconciles any race with the POST.
  const [cancelling, setCancelling] = useState(false);
  const onCancel = useCallback(() => {
    if (runId === "") {
      return;
    }
    setCancelling(true);
    client
      .post(`/runs/${encodeURIComponent(runId)}/cancel`, {
        schema: cancelRunResponseSchema,
        idempotencyKey: derivedIdempotencyKey(["cancel", runId]),
      })
      .then(() => runQuery.refetch())
      .catch(() => {
        // 409 (already terminal) is the expected race; the SSE stream and the
        // terminal refresh reconcile the view either way.
      })
      .finally(() => setCancelling(false));
  }, [client, runId, runQuery]);

  // §24.4 one-click retry — same document, tier and brief; a NEW run.
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const onRetry = useCallback(() => {
    const detail = runQuery.data;
    if (detail === null) {
      return;
    }
    const brief = readRetryBrief(runId);
    if (brief === null) {
      // The brief was never stored client-side (cold load, cleared session):
      // send the user back to the document, whose composer still has it.
      router.push(`/documents/${encodeURIComponent(detail.document_id)}`);
      return;
    }
    setRetryBusy(true);
    setRetryNotice(null);
    const templateId = timeline.plan?.template;
    client
      .post("/runs", {
        body: {
          documentId: detail.document_id,
          prompt: brief.prompt,
          tier: detail.tier,
          ...(templateId === undefined || templateId === null
            ? {}
            : { templateId }),
        },
        schema: createRunResponseSchema,
        idempotencyKey: derivedIdempotencyKey(["retry", runId, "1"]),
      })
      .then((created) => {
        writeRetryBrief(created.run_id, brief); // the retried run can retry too
        router.push(`/runs/${encodeURIComponent(created.run_id)}`);
      })
      .catch((error: unknown) => {
        setRetryNotice(
          isApiError(error)
            ? error.hint === undefined
              ? error.message
              : `${error.message} ${error.hint}`
            : "Could not start the retry. Please try again.",
        );
      })
      .finally(() => setRetryBusy(false));
  }, [client, runId, router, runQuery.data, timeline.plan?.template]);

  // ---------------------------------------------------------------------------
  // Guard views
  // ---------------------------------------------------------------------------

  if (runId === "") {
    return (
      <MessageCard
        title="This run link is incomplete"
        body="Open the run again from your document or the runs list."
      />
    );
  }

  if (runQuery.isPending) {
    return <PageSkeleton />;
  }

  const loadError = runQuery.error;
  if (loadError !== null) {
    if (isApiError(loadError) && loadError.status === 404) {
      return (
        <MessageCard
          title="Run not found"
          body="This run does not exist, or it belongs to a different workspace."
          action={
            <Link
              href="/"
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
            >
              Back to home
            </Link>
          }
        />
      );
    }
    const message = isApiError(loadError)
      ? loadError.hint === undefined
        ? loadError.message
        : `${loadError.message} ${loadError.hint}`
      : "The run could not be loaded.";
    return (
      <MessageCard
        title="Something went wrong"
        body={message}
        action={
          <button
            type="button"
            onClick={() => void runQuery.refetch()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
          >
            Try again
          </button>
        }
      />
    );
  }

  // ---------------------------------------------------------------------------
  // The timeline (§20 #5): plan → steps → previews → verdicts
  // ---------------------------------------------------------------------------

  const detail = runQuery.data;
  const warnings = timeline.succeeded?.warnings ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        {detail === null ? null : (
          <p className="mb-3">
            <Link
              href={`/documents/${encodeURIComponent(detail.document_id)}`}
              className="text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              ← Back to document
            </Link>
          </p>
        )}

        <RunHeader
          timeline={timeline}
          nowMs={nowMs}
          streamState={streamState}
          streamMessage={streamMessage}
          cancelling={cancelling}
          onCancel={onCancel}
          onReconnect={reconnect}
        />

        {warnings.length > 0 ? (
          <div
            role="status"
            className="mt-6 rounded-lg border border-amber-200 bg-amber-50/40 px-5 py-4 text-sm"
          >
            <p className="font-medium text-amber-700">Completed with warnings</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr),22rem]">
          <div className="min-w-0 space-y-6">
            <PlanCard timeline={timeline} />
            <Timeline timeline={timeline} nowMs={nowMs} />
            {timeline.status === "failed" && timeline.failure !== null ? (
              <FailureCard
                failure={timeline.failure}
                retryBusy={retryBusy}
                retryNotice={retryNotice}
                onRetry={onRetry}
              />
            ) : null}
          </div>

          <div className="space-y-6">
            <PreviewPanel timeline={timeline} />
            <ValidateVerdictCard report={timeline.validation} terminal={timeline.terminal} />
            <CritiqueVerdictCard report={timeline.critique} terminal={timeline.terminal} />
          </div>
        </div>
      </div>
    </div>
  );
}
