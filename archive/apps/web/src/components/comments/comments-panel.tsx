"use client";

// apps/web/src/components/comments — review-comments side panel (W8-H).
// Spec anchors: §12.1 comments (x/y px + resolved_at), §15.2 RBAC (viewer:
// read + comment), §19 Phase 3 "comments with positions".
//
// MOUNT CONTRACT (W8-F — full wiring note in this folder's README): mount
// inside the editor's right-hand <PanelContent> (@studio/ui Panel). The
// panel owns ONLY the list/composer; canvas position picking is the
// <CommentPinOverlay> contract — the editor mediates the two via three
// props: `pendingPosition` (composer opens when set), `onStartPlacement`
// ("add comment" button → editor enables canvas placement), and
// `onCancelPlacement` (composer cancel / Esc → editor clears the mode).
// Both components read the SAME React Query cache entry (use-comments.ts
// `commentsQueryKey`), so optimistic updates move pins and rows together.

import { Check, RotateCcw } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { isApiError, type GatewayClient } from "@/lib/api";
import {
  COMMENT_BODY_MAX,
  formatRelativeTime,
  sortCommentsByCreation,
  validateCommentBody,
  type CanvasComment,
  type CanvasPoint,
} from "./comment-utils";
import {
  useAddComment,
  useComments,
  useResolveComment,
} from "./use-comments";

/** User-safe text for any thrown error — never raw Error internals. */
function errorText(error: unknown): string {
  // Gateway messages are human-safe by contract (§13.3: no stack traces,
  // paths or internal ids), so the envelope message can surface verbatim.
  return isApiError(error) ? error.message : "Something went wrong. Please try again.";
}

export interface CommentsPanelProps {
  /** The document under review (§13.1 documents scope). */
  readonly documentId: string;
  /** Injected gateway client; omit for the env-configured default. */
  readonly client?: GatewayClient;
  /**
   * Canvas position (px) the editor captured via <CommentPinOverlay
   * onPlace>. Non-null opens the new-comment composer; the POST requires it
   * (comments.x/y are NOT NULL, §12.1).
   */
  readonly pendingPosition?: CanvasPoint | null;
  /** Thread the editor highlights (row ↔ pin, both directions). */
  readonly activeCommentId?: string | null;
  /** Row click → editor highlights/scrolls to the matching pin. */
  readonly onSelectComment?: (commentId: string) => void;
  /** "Add comment" → editor starts canvas placement mode. */
  readonly onStartPlacement?: () => void;
  /** Composer cancel / Esc during placement → editor clears the mode. */
  readonly onCancelPlacement?: () => void;
  /**
   * Interim notifications (§19 Phase 3): opt-in polling until the realtime
   * layer ships comment events (see use-comments.ts header).
   */
  readonly refetchIntervalMs?: number;
  readonly className?: string;
}

/**
 * Thread list + composer + resolved filter for one document's comments
 * (§19 Phase 3). Data flows exclusively through the hooks in
 * use-comments.ts — no direct fetches, no local copies of server state.
 */
export function CommentsPanel({
  documentId,
  client,
  pendingPosition = null,
  activeCommentId = null,
  onSelectComment,
  onStartPlacement,
  onCancelPlacement,
  refetchIntervalMs,
  className = "",
}: CommentsPanelProps) {
  const commentsQuery = useComments({ documentId, client, refetchIntervalMs });
  const addComment = useAddComment({ documentId, client });
  const resolveComment = useResolveComment({ documentId, client });

  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState("");

  const comments = useMemo(
    () => sortCommentsByCreation(commentsQuery.data ?? []),
    [commentsQuery.data],
  );
  // Relative-time "now" anchor: fixed per list snapshot (no ticking),
  // refreshes whenever the cache updates. suppressHydrationWarning on the
  // <time> elements absorbs the server/client clock gap.
  const now = useMemo(() => new Date(), [comments]);
  const unresolvedCount = comments.filter((c) => c.resolvedAt === null).length;
  const visible = showResolved ? comments : comments.filter((c) => c.resolvedAt === null);
  const pendingResolveId = resolveComment.isPending
    ? (resolveComment.variables?.commentId ?? null)
    : null;

  const bodyCheck = validateCommentBody(draft);
  const draftError = draft.length > 0 && !bodyCheck.ok ? bodyCheck.message : null;

  async function onComposerSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!bodyCheck.ok || pendingPosition === null || addComment.isPending) {
      return;
    }
    try {
      await addComment.mutateAsync({
        body: draft.trim(),
        x: pendingPosition.x,
        y: pendingPosition.y,
      });
      setDraft("");
      onCancelPlacement?.(); // editor clears the mode + pending position
    } catch {
      // Surfaced through addComment.error below — nothing to unwind here;
      // the hook already rolled the optimistic insert back.
    }
  }

  function onToggleResolved(comment: CanvasComment): void {
    resolveComment.mutate({
      commentId: comment.id,
      resolved: comment.resolvedAt === null,
    });
  }

  const mutationError = addComment.error ?? resolveComment.error;

  return (
    <section
      aria-label="Comments"
      className={`flex h-full min-h-0 flex-col rounded-lg border border-border bg-surface ${className}`}
    >
      {/* Header: title + unresolved count + resolved filter toggle. */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Comments
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
            {unresolvedCount}
          </span>
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={showResolved}
          onClick={() => setShowResolved((value) => !value)}
          className="text-xs text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </button>
      </header>

      {/* Thread list (§12.1: flat today — one row = one thread item). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {commentsQuery.isPending ? (
          <div className="space-y-3 py-2" aria-hidden="true">
            <div className="h-12 animate-pulse rounded-md bg-surface-muted" />
            <div className="h-12 animate-pulse rounded-md bg-surface-muted" />
          </div>
        ) : commentsQuery.isError ? (
          <div role="alert" className="space-y-2 py-4 text-center text-sm text-muted-foreground">
            <p>{errorText(commentsQuery.error)}</p>
            <button
              type="button"
              onClick={() => void commentsQuery.refetch()}
              className="rounded-md border border-border px-3 py-1 text-xs transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {comments.length === 0
              ? "No comments yet — click the canvas to start one."
              : "All comments resolved."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((comment) => {
              const resolved = comment.resolvedAt !== null;
              const active = comment.id === activeCommentId;
              return (
                <li key={comment.id}>
                  <article
                    className={`-mx-1 rounded-md px-1 py-2.5 transition ${
                      active ? "bg-surface-muted ring-1 ring-ring" : ""
                    } ${resolved ? "opacity-75" : ""}`}
                  >
                    {/* The select region is a real button — native keyboard
                        activation (Enter/Space), no static onClick to appease
                        a11y rules for; the resolve button stays a sibling. */}
                    <button
                      type="button"
                      onClick={() => onSelectComment?.(comment.id)}
                      aria-current={active ? "true" : undefined}
                      className="block w-full cursor-pointer rounded-md text-left outline-none transition focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground"
                    >
                      <header className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-semibold">
                          {comment.authorName ?? "Member"}
                        </span>
                        <time
                          dateTime={comment.createdAt.toISOString()}
                          suppressHydrationWarning
                          className="shrink-0 text-[11px] font-normal text-muted-foreground"
                        >
                          {formatRelativeTime(comment.createdAt, now)}
                        </time>
                      </header>
                      <p className="mt-1 break-words whitespace-pre-wrap text-sm">
                        {comment.body}
                      </p>
                    </button>
                    <footer className="mt-2 flex items-center justify-between gap-2">
                      {resolved ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Resolved
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">
                          {comment.x}, {comment.y} px
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={pendingResolveId === comment.id}
                        onClick={() => onToggleResolved(comment)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-surface-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {resolved ? (
                          <>
                            <RotateCcw className="h-3 w-3" aria-hidden="true" />
                            Reopen
                          </>
                        ) : (
                          "Resolve"
                        )}
                      </button>
                    </footer>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Composer / entry point (bottom). */}
      <footer className="border-t border-border px-3 py-3">
        {mutationError !== null ? (
          <p role="alert" className="mb-2 text-xs text-red-600">
            {errorText(mutationError)}
          </p>
        ) : null}

        {pendingPosition !== null ? (
          <form onSubmit={onComposerSubmit} className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              New comment at {pendingPosition.x}, {pendingPosition.y} px
            </p>
            <label className="block">
              <span className="sr-only">Comment body</span>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={COMMENT_BODY_MAX}
                rows={3}
                aria-describedby="comments-panel-body-hint"
                placeholder="Share feedback about this spot…"
                className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span
                id="comments-panel-body-hint"
                className={`text-[11px] ${
                  draft.length > COMMENT_BODY_MAX ? "text-red-600" : "text-muted-foreground"
                }`}
              >
                {draftError ?? `${draft.length}/${COMMENT_BODY_MAX}`}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDraft("");
                    onCancelPlacement?.();
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addComment.isPending || !bodyCheck.ok}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {addComment.isPending ? "Posting…" : "Post"}
                </button>
              </span>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => onStartPlacement?.()}
            disabled={onStartPlacement === undefined}
            title={
              onStartPlacement === undefined
                ? "Canvas placement wires up with the editor (W8-F)"
                : undefined
            }
            className="w-full rounded-md border border-border px-3 py-2 text-sm transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add a comment
          </button>
        )}
      </footer>
    </section>
  );
}
