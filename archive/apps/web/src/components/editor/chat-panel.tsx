"use client";

// apps/web/src/components/editor/chat-panel.tsx (W8-F)
//
// ChatPanel — the right panel's chat-edit loop (§23.5/§24.2):
//
//   POST /v1/runs  { documentId, prompt, tier: "quick" }   (§24.2 — chat-editing
//                   one element costs the quick tier: 1 credit, §5.2/§14.1;
//                   §20-#8's acceptance: "make the subhead smaller" changes
//                   only that element's layers, diff ≤ 2 changed layers)
//   GET  /v1/runs/:id  polled for the inline mini-run status (§13.1) until a
//                   §5.1 terminal state, within the quick tier's 2-minute
//                   wall clock. The api.ts SSE helper (RunEventStream) is the
//                   fancier transport for the streaming wave — polling keeps
//                   this panel hermetic and unkillable by reconnect storms.
//   POST /v1/documents/:id/undo  ONE step (§13.1/§24.2: an agent run undoes
//                   as one step) — the "Undo last edit" button.
//
// Mutating calls carry an Idempotency-Key (§13): the api client injects one
// per request; retries of a poll are reads and need none.

import { Send, Undo2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Badge, Button, cn, statusBadgeVariant } from "@studio/ui";
import { isApiError, type GatewayClient } from "../../lib/api";
import {
  MAX_RUN_POLLS,
  PROMPT_MAX_CHARS,
  QUICK_TIER,
  QUICK_TIER_CREDITS,
  RUN_POLL_INTERVAL_MS,
  commandReplySchema,
  errorText,
  extractRunError,
  isTerminalRunStatus,
  makeNoticeMessage,
  makeRunMessage,
  makeTextMessage,
  runCreatedReplySchema,
  runDetailSchema,
  updateRunMessage,
  type ChatMessage,
  type RunDetail,
} from "./editor-model";

/** Cancels an in-flight poll loop on unmount (no setState after teardown). */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function newId(): string {
  return crypto.randomUUID();
}

export interface ChatPanelProps {
  /** Typed gateway client (apps/web/src/lib/api.ts). */
  readonly client: GatewayClient;
  readonly documentId: string;
  /** Parent records the new revision — the preview canvas' refresh key. */
  readonly onRevision: (revision: number) => void;
  /** Fired after a settled run or an undo — parent re-syncs the layer tree. */
  readonly onLayersStale?: () => void;
  readonly className?: string;
}

export function ChatPanel({
  client,
  documentId,
  onRevision,
  onLayersStale,
  className,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const composerId = useId();

  // Abort the active poll when the panel unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const hasRunCard = messages.some((message) => message.kind === "run");
  const canUndo = hasRunCard && !runBusy && !undoBusy;

  async function pollRun(runId: string): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      for (let attempt = 0; attempt <= MAX_RUN_POLLS; attempt += 1) {
        await wait(RUN_POLL_INTERVAL_MS, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        let detail: RunDetail;
        try {
          detail = await client.get(`/runs/${encodeURIComponent(runId)}`, {
            schema: runDetailSchema,
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          // 4xx (except 429) cannot get better with retries — surface and stop.
          if (isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 429) {
            setMessages((current) =>
              updateRunMessage(current, {
                runId,
                status: "failed",
                error: errorText(error, "The run's status could not be checked."),
              }),
            );
            return;
          }
          continue; // transient — keep polling within the tier budget
        }
        if (isTerminalRunStatus(detail.status)) {
          setMessages((current) =>
            updateRunMessage(current, {
              runId,
              status: detail.status,
              revisionAfter: detail.revision_after ?? null,
              error: extractRunError(detail.error),
            }),
          );
          if (detail.revision_after !== null) {
            onRevision(detail.revision_after);
          }
          onLayersStale?.();
          return;
        }
        setMessages((current) => updateRunMessage(current, { runId, status: detail.status }));
      }
      // Budget exhausted without a terminal state (§5.2 wall clock) — the
      // composer re-opens and the card says what happened, no invented status.
      setMessages((current) =>
        updateRunMessage(current, {
          runId,
          error: "Still working on it — this is taking longer than a quick edit should.",
        }),
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }

  async function submitPrompt(): Promise<void> {
    const text = prompt.trim();
    if (text === "" || text.length > PROMPT_MAX_CHARS || runBusy || undoBusy) {
      return;
    }
    setMessages((current) => [
      ...current,
      makeTextMessage(newId(), "user", text),
      makeRunMessage(newId(), text, QUICK_TIER_CREDITS),
    ]);
    setPrompt("");
    setRunBusy(true);
    try {
      const created = await client.post("/runs", {
        body: { documentId, prompt: text, tier: QUICK_TIER },
        schema: runCreatedReplySchema,
      });
      setMessages((current) =>
        updateRunMessage(current, {
          runId: created.run_id,
          status: created.status,
          creditsReserved: created.credits_reserved,
        }),
      );
      await pollRun(created.run_id);
    } catch (error) {
      setMessages((current) =>
        updateRunMessage(current, {
          status: "failed",
          error: errorText(error, "The edit could not be started. Please try again."),
        }),
      );
    } finally {
      setRunBusy(false);
    }
  }

  async function undoLastEdit(): Promise<void> {
    if (!canUndo) {
      return;
    }
    setUndoBusy(true);
    try {
      const reply = await client.post(`/documents/${encodeURIComponent(documentId)}/undo`, {
        schema: commandReplySchema,
      });
      setMessages((current) => [
        ...current,
        makeNoticeMessage(
          newId(),
          `Undid the last edit — the document is back at revision ${reply.revision_after}.`,
        ),
      ]);
      onRevision(reply.revision_after);
      onLayersStale?.();
    } catch (error) {
      setMessages((current) => [
        ...current,
        makeNoticeMessage(newId(), errorText(error, "The last edit could not be undone.")),
      ]);
    } finally {
      setUndoBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submitPrompt();
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div
        role="log"
        aria-live="polite"
        aria-label="Chat edit history"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {messages.length === 0 ? (
          <p className="mx-auto max-w-xs rounded-md border border-border bg-surface-muted px-3 py-4 text-center text-sm text-muted-foreground">
            Describe the change you want — “Make the subhead smaller and add a 20% OFF
            badge.” Quick edits touch one element and cost 1 credit.
          </p>
        ) : (
          messages.map((message) => {
            if (message.kind === "run" && message.run !== undefined) {
              const run = message.run;
              return (
                <div key={message.id} className="flex justify-start">
                  <div
                    data-run-status={run.status}
                    className="editor-chat-assistant-bubble max-w-[85%] rounded-lg px-3 py-2 text-sm"
                  >
                    <Badge variant={statusBadgeVariant(run.status)}>
                      {run.status.replaceAll("_", " ")}
                    </Badge>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={run.prompt}>
                      “{run.prompt}”
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Quick edit · {run.creditsReserved} credit
                      {run.creditsReserved === 1 ? "" : "s"}
                      {run.revisionAfter === null ? "" : ` · revision ${run.revisionAfter}`}
                    </p>
                    {run.error === null ? null : (
                      <p role="alert" className="mt-1 text-xs text-red-600">
                        {run.error}
                      </p>
                    )}
                  </div>
                </div>
              );
            }
            const isUser = message.role === "user";
            return (
              <div key={message.id} className={cn("flex", isUser ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                    isUser ? "editor-chat-user-bubble" : "editor-chat-assistant-bubble",
                  )}
                >
                  {message.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={onSubmit} className="flex shrink-0 flex-col gap-2 border-t border-border p-2">
        <label htmlFor={composerId} className="sr-only">
          Describe the edit
        </label>
        <textarea
          id={composerId}
          rows={3}
          maxLength={PROMPT_MAX_CHARS}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={runBusy || undoBusy}
          placeholder="Make the subhead smaller and add a 20% OFF badge."
          className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Quick edit · 1 credit</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void undoLastEdit()}
              disabled={!canUndo}
              title="Undo the most recent edit (one step)"
              className="gap-1"
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
              {undoBusy ? "Undoing…" : "Undo last edit"}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={runBusy || undoBusy || prompt.trim() === ""}
              className="gap-1"
            >
              <Send className="size-3.5" aria-hidden="true" />
              {runBusy ? "Working…" : "Send"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
