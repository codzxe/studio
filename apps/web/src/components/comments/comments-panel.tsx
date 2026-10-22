"use client";

/**
 * `CommentsPanel` — the M7-F review surface (BUILD_PLAN §M7 task 1; UI
 * design language per EDITOR_CHAT_UX §10 + UI_DESIGN_SYSTEM §8.7/§9: the
 * panel sits ON the dark editor, tokens only, no blur/glass).
 *
 * Composition (anchored threads over the flat M7-A wire):
 * - HEADER: title + project name + close. The project is the panel's scope
 *   (the wire requires a project), so the PROJECT chip lives here — rows
 *   carry the comp/layer/time anchor chips.
 * - FILTERS: resolved filter (Open | Resolved | All → the wire's server-side
 *   `resolved` param) + comp filter (Menu, options from the live project —
 *   D-15: `compId` filters server-side, so a filter never splits a thread).
 * - LIST: threaded rows (tree.ts), cursor pagination ("Load more" appends
 *   pages; threads rebuild over the accumulated window).
 * - CREATE BOX: prefilled anchor from the CURRENT editor context via the
 *   bridge `ui.inspect` seam (anchor.ts — the chat collector's recipe,
 *   reused), refreshed on demand.
 *
 * LEASE LAW (the D-23 pin): when M7-C's lease-state says another member
 * holds the edit lease, the panel shows the note and comment creation STAYS
 * ENABLED — review is the point of the read-only state; the lease gates
 * project WRITES, never comments. Nothing in this panel is disabled by the
 * lease.
 *
 * DATA LAW (PRODUCT_ARCHITECTURE §8.3 + the M4-N corpus): every body,
 * comp/layer name and guest name is UNTRUSTED — rendered as React text,
 * truncated with CSS (`truncate`), never interpolated into markup, commands
 * or copy. Anchor time renders as `mm:ss` (engine ticks).
 *
 * Author labels never leak ids (law #1): "You" (viewer id match), "Member"
 * (any other member — no member-list endpoint exists on this surface), or
 * the guest's recorded name for guest rows.
 */

import type { Comment } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import {
  Badge,
  Button,
  EmptyState,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  Skeleton,
  Textarea,
  cn,
} from "@studio/ui";
import { Check, ChevronDown, MessageSquare, RotateCw, X } from "lucide-react";
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CommentAnchorPrefill,
  collectAnchorNames,
  collectCommentAnchor,
  formatTimeTicks,
  listCompOptions,
} from "./anchor";
import { type CommentRowView, buildCommentThreads } from "./tree";
import {
  type AnchorNames,
  COMMENTS_PAGE_LIMIT,
  COMMENT_MAX_VISUAL_DEPTH,
  type CommentsClient,
  type CompOption,
  type LeaseSnapshot,
} from "./types";

/** COMMENT_BODY_MAX restated (contracts is type-only from apps/web). */
const MAX_BODY_CHARS = 2000;
const TOO_LONG_HINT = "Comments are 2,000 characters max.";
const NO_ANCHOR_HINT = "Open a composition in the editor to anchor a new comment.";
const GENERIC_ERROR = "That didn’t work. Try again in a moment.";

export interface CommentsPanelProps {
  /** The narrow comments port (the production ApiClient satisfies it). */
  readonly client: CommentsClient;
  readonly projectId: string;
  /** Project display name for the header; absent → the header shows no chip. */
  readonly projectName?: string | null;
  /** Live editor bridge for anchors + names; null/absent → degraded mode. */
  readonly bridge?: EditorBridge | null;
  /** Viewer id (`GET /v1/me`) for "You"/"by you" labels; null → "Member". */
  readonly viewerId?: string | null;
  /** Lease snapshot (M7-C lease-state); absent → no lease note. */
  readonly lease?: LeaseSnapshot | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

/** The resolved filter tri-state — Open (default), Resolved, All. */
type ResolvedFilter = "open" | "resolved" | "all";

/** One resolved-filter segment button. */
function ResolvedFilterButton(props: {
  readonly filter: ResolvedFilter;
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <Button
      variant={props.active ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={props.active}
      data-testid={`comments-filter-${props.filter}`}
      className={cn("h-6 px-2 text-caption", props.active && "text-primary")}
      onClick={props.onSelect}
    >
      {props.label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Small render helpers (pure — hostile inputs stay data)
// ---------------------------------------------------------------------------

/** Truncation bound for anchor names (CSS `truncate` still guards layout). */
const NAME_TRUNCATE = 32;

/** Comp/layer display: the live name, else the raw anchor id as data. */
function anchorName(name: string | null | undefined, id: string): string {
  if (typeof name === "string" && name.length > 0) return name;
  return id.length > NAME_TRUNCATE ? `${id.slice(0, NAME_TRUNCATE)}…` : id;
}

/** Row author label — ids never surface (law #1). */
function authorLabel(comment: Comment, viewerId: string | null): string {
  if (comment.authorId === null) {
    return comment.guestName !== null && comment.guestName !== "" ? comment.guestName : "Guest";
  }
  if (viewerId !== null && comment.authorId === viewerId) return "You";
  return "Member";
}

/** Deterministic short stamp ("Oct 26, 14:32") — UTC so tests never see a TZ. */
const WHEN_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : WHEN_FORMAT.format(date);
}

/** A safe human message for any rejection (api-client messages are safe). */
function failureMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : GENERIC_ERROR;
}

/** One anchor chip (comp / layer / time) — hostile names render as text. */
function AnchorChip(props: {
  readonly testId: string;
  readonly icon: "comp" | "layer" | "time";
  readonly label: string;
}): ReactElement {
  const title =
    props.icon === "comp" ? "Composition" : props.icon === "layer" ? "Layer" : "Playhead";
  return (
    <span
      data-testid={props.testId}
      title={`${title}: ${props.label}`}
      className="inline-flex max-w-40 items-center rounded-xs border border-border bg-input px-1.5 py-0.5 font-sans text-hint whitespace-nowrap text-secondary"
    >
      <span className="truncate">{props.label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function CommentsPanel({
  client,
  projectId,
  projectName,
  bridge,
  viewerId = null,
  lease = null,
  open,
  onClose,
}: CommentsPanelProps): ReactElement | null {
  // -- list state -------------------------------------------------------------
  const [rows, setRows] = useState<readonly Comment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  // -- filters ----------------------------------------------------------------
  const [resolvedFilter, setResolvedFilter] = useState<ResolvedFilter>("open");
  const [compFilter, setCompFilter] = useState<string | null>(null);

  // -- editor-context state (bridge-derived) ------------------------------------
  const [anchor, setAnchor] = useState<CommentAnchorPrefill | null>(null);
  const [anchorReady, setAnchorReady] = useState(false);
  const [names, setNames] = useState<AnchorNames | null>(null);
  const [compOptions, setCompOptions] = useState<readonly CompOption[]>([]);

  // -- composer state -----------------------------------------------------------
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [postedNotice, setPostedNotice] = useState<string | null>(null);

  // -- reply state --------------------------------------------------------------
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  // Stale-response guard: a generation counter per list fetch.
  const generationRef = useRef(0);

  const resolvedQueryValue = useCallback(
    (): boolean | undefined =>
      resolvedFilter === "open" ? false : resolvedFilter === "resolved" ? true : undefined,
    [resolvedFilter],
  );

  // -- list fetching ------------------------------------------------------------
  const fetchPage = useCallback(
    async (
      cursor: string | null,
    ): Promise<{ items: readonly Comment[]; nextCursor: string | null }> => {
      const query: Record<string, string | number | boolean | undefined> = {
        limit: COMMENTS_PAGE_LIMIT,
        ...(compFilter === null ? {} : { compId: compFilter }),
        ...(resolvedQueryValue() === undefined ? {} : { resolved: resolvedQueryValue() }),
      };
      if (cursor !== null) query.cursor = cursor;
      const page = await client.comments.listThreadedComments(projectId, query);
      return { items: page.items, nextCursor: page.nextCursor };
    },
    [client, compFilter, projectId, resolvedQueryValue],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    setLoading(true);
    setListError(null);
    try {
      const page = await fetchPage(null);
      if (generationRef.current !== generation) return;
      setRows(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setRows([]);
      setNextCursor(null);
      setListError(failureMessage(error));
    } finally {
      if (generationRef.current === generation) {
        setLoading(false);
        setLoadedOnce(true);
      }
    }
  }, [fetchPage]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingMore || nextCursor === null) return;
    const generation = ++generationRef.current;
    setLoadingMore(true);
    setListError(null);
    try {
      const page = await fetchPage(nextCursor);
      if (generationRef.current !== generation) return;
      setRows((previous) => {
        const seen = new Set(previous.map((row) => row.id));
        return [...previous, ...page.items.filter((row) => !seen.has(row.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setListError(failureMessage(error));
    } finally {
      if (generationRef.current === generation) setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, nextCursor]);

  // Open → load the first page. `refresh` identity changes with the FILTERS
  // (fetchPage deps), so this one effect covers open + every filter change
  // with exactly one fetch — no separate filter effect, no double fetch.
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Editor context per OPEN: anchor prefill + comp/layer names + comp options.
  // No bridge (region mounted outside a live editor) → degraded immediately.
  useEffect(() => {
    if (!open) return;
    if (bridge === null || bridge === undefined) {
      setAnchorReady(true);
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      const [collected, anchorNames, options] = await Promise.all([
        collectCommentAnchor(bridge),
        collectAnchorNames(bridge),
        listCompOptions(bridge),
      ]);
      if (cancelled) return;
      setAnchor(collected);
      setAnchorReady(true);
      setNames(anchorNames);
      setCompOptions(options);
      setCompFilter((current) =>
        current !== null && options.every((option) => option.id !== current) ? null : current,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, bridge]);

  // -- mutations ----------------------------------------------------------------

  const trimmedDraft = draft.trim();
  const draftTooLong = trimmedDraft.length > MAX_BODY_CHARS;
  const canCreate = anchor !== null && !sending && !draftTooLong && trimmedDraft.length > 0;

  const submitCreate = useCallback(async (): Promise<void> => {
    if (anchor === null || trimmedDraft.length === 0 || draftTooLong) return;
    setSending(true);
    setComposerError(null);
    setPostedNotice(null);
    try {
      const created = await client.comments.create(projectId, {
        compId: anchor.compId,
        ...(anchor.layerId === null ? {} : { layerId: anchor.layerId }),
        ...(anchor.timeTicks === null ? {} : { timeTicks: anchor.timeTicks }),
        body: trimmedDraft,
      });
      setDraft("");
      // Newest-first wire: prepend when the row is visible under the current
      // filters, else keep the draft clear + say where it went.
      const visibleUnderFilters =
        (resolvedFilter === "open" || resolvedFilter === "all") &&
        (compFilter === null || compFilter === created.compId);
      if (visibleUnderFilters) {
        setRows((previous) =>
          previous.some((row) => row.id === created.id) ? previous : [created, ...previous],
        );
      } else {
        setPostedNotice("Comment posted. Switch filters to see it.");
      }
    } catch (error) {
      setComposerError(failureMessage(error));
    } finally {
      setSending(false);
    }
  }, [anchor, client, compFilter, draftTooLong, projectId, resolvedFilter, trimmedDraft]);

  const submitReply = useCallback(
    async (targetId: string): Promise<void> => {
      const body = replyDraft.trim();
      if (body.length === 0 || body.length > MAX_BODY_CHARS) return;
      setReplySending(true);
      setReplyError(null);
      try {
        const reply = await client.comments.replyComment(targetId, { body });
        setReplyDraft("");
        setReplyTargetId(null);
        // Replies render reading-order (oldest first), so APPEND — the
        // rebuilt tree puts the newest reply last in its thread.
        setRows((previous) =>
          previous.some((row) => row.id === reply.id) ? previous : [...previous, reply],
        );
      } catch (error) {
        setReplyError(failureMessage(error));
      } finally {
        setReplySending(false);
      }
    },
    [client, replyDraft],
  );

  const toggleResolve = useCallback(
    async (comment: Comment): Promise<void> => {
      try {
        const updated =
          comment.resolvedAt === null
            ? await client.comments.resolveComment(comment.id)
            : await client.comments.resolveComment(comment.id, { resolved: false });
        const threadRootId = rootIdOfRow(updated.id, rows);
        // Thread-level filter semantics: a resolved root takes its replies
        // out of "Open"; a reopened root leaves "Resolved".
        const threadFailsFilter =
          (updated.resolvedAt !== null && resolvedFilter === "open") ||
          (updated.resolvedAt === null && resolvedFilter === "resolved");
        setRows((previous) => {
          const replaced = previous.map((row) => (row.id === updated.id ? updated : row));
          if (!threadFailsFilter || threadRootId === null) return replaced;
          return replaced.filter((row) => rootIdOfRow(row.id, previous) !== threadRootId);
        });
      } catch (error) {
        setListError(failureMessage(error));
      }
    },
    [client, resolvedFilter, rows],
  );

  // -- derived render state -----------------------------------------------------

  const threads = useMemo(() => buildCommentThreads(rows), [rows]);
  const resolvedCount = useMemo(
    () => rows.filter((row) => row.resolvedAt !== null && row.parentCommentId === null).length,
    [rows],
  );
  const leaseHeldByOther = lease !== null && lease.holderName !== null && lease.youAre !== "holder";
  const compName = compFilter === null ? null : compOptions.find((c) => c.id === compFilter);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <aside
      aria-label="Comments"
      data-testid="comments-panel"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="pointer-events-auto absolute top-0 right-0 bottom-0 z-[35] flex w-[380px] max-w-full flex-col overflow-hidden border-l border-border bg-panel shadow-modal"
    >
      {/* Header — the project IS the panel scope, so the project chip lives here. */}
      <header
        data-testid="comments-header"
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel px-3"
      >
        <MessageSquare
          size={15}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-secondary"
        />
        <span data-testid="comments-title" className="shrink-0 font-medium text-primary">
          Comments
        </span>
        {projectName !== null && projectName !== undefined && projectName !== "" ? (
          <span
            data-testid="comments-project"
            title={projectName}
            className="min-w-0 flex-1 truncate text-caption text-muted"
          >
            {projectName}
          </span>
        ) : (
          <div aria-hidden="true" className="min-w-0 flex-1" />
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0 text-secondary hover:text-primary"
          aria-label="Close comments"
          data-testid="comments-close"
          onClick={onClose}
        >
          <X size={15} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </header>

      {/* Filters: resolved tri-state (server-side `resolved`) + comp (D-15). */}
      <div
        data-testid="comments-filters"
        className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2"
      >
        <div className="flex items-center gap-0.5" aria-label="Filter by resolved state">
          <ResolvedFilterButton
            filter="open"
            active={resolvedFilter === "open"}
            label="Open"
            onSelect={() => setResolvedFilter("open")}
          />
          <ResolvedFilterButton
            filter="resolved"
            active={resolvedFilter === "resolved"}
            label={resolvedCount > 0 ? `Resolved · ${resolvedCount}` : "Resolved"}
            onSelect={() => setResolvedFilter("resolved")}
          />
          <ResolvedFilterButton
            filter="all"
            active={resolvedFilter === "all"}
            label="All"
            onSelect={() => setResolvedFilter("all")}
          />
        </div>
        <div aria-hidden="true" className="min-w-0 flex-1" />
        {compOptions.length > 0 ? (
          <Menu>
            <MenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 max-w-36 shrink-0 gap-1 px-2 text-caption text-secondary hover:text-primary"
                aria-label="Filter by composition"
                data-testid="comments-comp-filter"
              >
                <span className="truncate">{compName?.name ?? "All comps"}</span>
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </MenuTrigger>
            <MenuContent align="end" data-testid="comments-comp-menu">
              <MenuRadioGroup
                value={compFilter ?? "all"}
                onValueChange={(value) => setCompFilter(value === "all" ? null : value)}
              >
                <MenuRadioItem value="all" data-testid="comments-comp-option-all">
                  All comps
                </MenuRadioItem>
                {compOptions.map((option) => (
                  <MenuRadioItem
                    key={option.id}
                    value={option.id}
                    data-testid={`comments-comp-option-${option.id}`}
                  >
                    <span className="max-w-56 truncate">{option.name}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        ) : null}
      </div>

      {/* D-23 pin: another member holds the edit lease — review still works. */}
      {leaseHeldByOther && lease !== null ? (
        <div
          data-testid="comments-lease-note"
          data-holder={lease.holderName}
          className="shrink-0 border-b border-border bg-elevated px-3 py-2 text-caption text-secondary"
        >
          {lease.holderName} is editing — you can still read and comment.
        </div>
      ) : null}

      {/* Thread list */}
      <div data-testid="comments-list" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && !loadedOnce ? (
          <div data-testid="comments-loading" className="flex flex-col gap-2 px-1">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : listError !== null ? (
          <div
            data-testid="comments-error"
            className="flex flex-col items-start gap-2 px-1 py-3 text-caption text-danger"
          >
            <p className="text-body-s text-primary">{listError}</p>
            <Button
              variant="secondary"
              size="sm"
              data-testid="comments-retry"
              onClick={() => void refresh()}
            >
              Retry
            </Button>
          </div>
        ) : threads.length === 0 ? (
          <div data-testid="comments-empty" className="px-1">
            <EmptyState
              withIllustration={false}
              className="py-10"
              title={
                resolvedFilter === "open"
                  ? compFilter === null
                    ? "No open comments. Leave the first note."
                    : "No open comments on this comp."
                  : resolvedFilter === "resolved"
                    ? "Nothing resolved yet."
                    : "No comments yet."
              }
            />
          </div>
        ) : (
          <>
            {threads.map((thread) => (
              <section
                key={thread.root.comment.id}
                data-testid={`comment-thread-${thread.root.comment.id}`}
                className="mb-2 flex flex-col gap-1 rounded-sm border border-border bg-elevated/40 p-2"
              >
                {thread.rows.map((row) => (
                  <CommentRow
                    key={row.comment.id}
                    row={row}
                    viewerId={viewerId}
                    names={names}
                    canReply={row.depth < COMMENT_MAX_VISUAL_DEPTH}
                    replyOpen={replyTargetId === row.comment.id}
                    replyDraft={replyDraft}
                    replySending={replySending}
                    replyError={replyError}
                    onReplyOpen={() => {
                      setReplyTargetId(row.comment.id);
                      setReplyDraft("");
                      setReplyError(null);
                    }}
                    onReplyDraftChange={setReplyDraft}
                    onReplyCancel={() => setReplyTargetId(null)}
                    onReplySubmit={() => void submitReply(row.comment.id)}
                    onToggleResolve={() => void toggleResolve(row.comment)}
                  />
                ))}
              </section>
            ))}
            {nextCursor !== null ? (
              <div className="flex justify-center pb-2">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="comments-load-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Create box — prefilled anchor from the current editor context. */}
      <div
        data-testid="comments-composer"
        className="shrink-0 border-t border-border bg-panel px-3 py-2"
      >
        {anchor !== null ? (
          <div
            data-testid="comments-composer-anchor"
            className="mb-1.5 flex items-center gap-1 text-caption text-muted"
          >
            <AnchorChip
              testId="comments-composer-anchor-comp"
              icon="comp"
              label={anchorName(anchor.compName, anchor.compId)}
            />
            {anchor.layerId !== null ? (
              <AnchorChip
                testId="comments-composer-anchor-layer"
                icon="layer"
                label={anchorName(anchor.layerName, anchor.layerId)}
              />
            ) : null}
            {anchor.timeTicks !== null ? (
              <AnchorChip
                testId="comments-composer-anchor-time"
                icon="time"
                label={formatTimeTicks(anchor.timeTicks) ?? "0:00"}
              />
            ) : null}
            <div aria-hidden="true" className="min-w-0 flex-1" />
            <Button
              variant="ghost"
              size="iconSm"
              className="h-6 w-6 p-0 text-secondary hover:text-primary"
              aria-label="Refresh anchor from the editor"
              title="Refresh anchor from the editor"
              data-testid="comments-composer-refresh"
              disabled={bridge === null || bridge === undefined}
              onClick={() => {
                if (bridge === null || bridge === undefined) return;
                void collectCommentAnchor(bridge).then(setAnchor);
              }}
            >
              <RotateCw size={12} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <p data-testid="comments-composer-hint" className="mb-1.5 text-caption text-muted">
            {anchorReady ? NO_ANCHOR_HINT : "Reading the editor context…"}
          </p>
        )}

        <div className="relative w-full">
          <Textarea
            rows={2}
            aria-label="Write a comment"
            placeholder="Leave a note for the team…"
            value={draft}
            disabled={anchor === null || sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              const withModifier = event.metaKey || event.ctrlKey;
              if (event.shiftKey && !withModifier) return;
              event.preventDefault();
              void submitCreate();
            }}
            className="pr-11 text-body-s"
          />
          <Button
            variant="primary"
            size="iconSm"
            className="absolute right-1.5 bottom-1.5"
            aria-label="Post comment"
            data-testid="comments-composer-send"
            disabled={!canCreate}
            onClick={() => void submitCreate()}
          >
            <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-1 flex w-full items-start justify-between gap-2 text-caption text-muted">
          {composerError !== null ? (
            <output data-testid="comments-composer-error" className="text-danger">
              {composerError}
            </output>
          ) : draftTooLong ? (
            <output className="text-danger">{TOO_LONG_HINT}</output>
          ) : postedNotice !== null ? (
            <output data-testid="comments-composer-posted">{postedNotice}</output>
          ) : (
            <span>Enter to post · Shift+Enter for a new line</span>
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// One row (root or reply — visual depth from tree.ts)
// ---------------------------------------------------------------------------

function CommentRow(props: {
  readonly row: CommentRowView;
  readonly viewerId: string | null;
  readonly names: AnchorNames | null;
  readonly canReply: boolean;
  readonly replyOpen: boolean;
  readonly replyDraft: string;
  readonly replySending: boolean;
  readonly replyError: string | null;
  readonly onReplyOpen: () => void;
  readonly onReplyDraftChange: (value: string) => void;
  readonly onReplyCancel: () => void;
  readonly onReplySubmit: () => void;
  readonly onToggleResolve: () => void;
}): ReactElement {
  const { comment, depth, promoted } = props.row;
  const indent = (Math.min(depth, COMMENT_MAX_VISUAL_DEPTH) - 1) * 14;
  const isRoot = comment.parentCommentId === null;
  const resolved = comment.resolvedAt !== null;
  const compName = props.names?.comps.get(comment.compId) ?? null;
  const layerName =
    comment.layerId === null ? null : (props.names?.layers.get(comment.layerId) ?? null);
  const resolvedByYou =
    comment.resolvedBy !== null && props.viewerId !== null && comment.resolvedBy === props.viewerId;
  // Depth 3 is the last visual level (server caps replies at depth 3), and a
  // resolved row closes its reply affordance — reopen to continue a thread.
  const canReply = props.canReply && !resolved;

  return (
    <article
      data-testid={`comment-row-${comment.id}`}
      data-depth={depth}
      data-promoted={promoted || undefined}
      className={cn(
        "flex flex-col gap-1 rounded-sm",
        isRoot ? "bg-transparent" : "bg-elevated/50",
        resolved && "opacity-80",
      )}
      style={indent > 0 ? { paddingLeft: indent } : undefined}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          data-testid={`comment-author-${comment.id}`}
          className="truncate font-medium text-primary"
        >
          {authorLabel(comment, props.viewerId)}
        </span>
        <span data-testid={`comment-when-${comment.id}`} className="shrink-0 text-hint text-muted">
          {formatWhen(comment.createdAt)}
        </span>
        {resolved ? (
          <Badge variant="success" data-testid={`comment-resolved-${comment.id}`} className="gap-1">
            <Check size={10} strokeWidth={2} aria-hidden="true" />
            Resolved{resolvedByYou ? " by you" : ""}
          </Badge>
        ) : null}
      </div>

      <p
        data-testid={`comment-body-${comment.id}`}
        className="text-body-s whitespace-pre-wrap break-words text-secondary"
      >
        {comment.body}
      </p>

      <div className="flex flex-wrap items-center gap-1">
        <AnchorChip
          testId={`comment-anchor-comp-${comment.id}`}
          icon="comp"
          label={anchorName(compName, comment.compId)}
        />
        {comment.layerId !== null ? (
          <AnchorChip
            testId={`comment-anchor-layer-${comment.id}`}
            icon="layer"
            label={anchorName(layerName, comment.layerId)}
          />
        ) : null}
        {comment.timeTicks !== null ? (
          <AnchorChip
            testId={`comment-anchor-time-${comment.id}`}
            icon="time"
            label={formatTimeTicks(comment.timeTicks) ?? "0:00"}
          />
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        {canReply ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-caption text-secondary hover:text-primary"
            data-testid={`comment-reply-open-${comment.id}`}
            onClick={props.onReplyOpen}
          >
            Reply
          </Button>
        ) : null}
        {isRoot ? (
          resolved ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-caption text-secondary hover:text-primary"
              data-testid={`comment-reopen-${comment.id}`}
              onClick={props.onToggleResolve}
            >
              Reopen
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-caption text-secondary hover:text-primary"
              data-testid={`comment-resolve-${comment.id}`}
              onClick={props.onToggleResolve}
            >
              Resolve
            </Button>
          )
        ) : null}
      </div>

      {props.replyOpen ? (
        <div data-testid={`comment-reply-box-${comment.id}`} className="flex flex-col gap-1 pt-0.5">
          <Textarea
            rows={2}
            aria-label="Write a reply"
            placeholder="Reply…"
            value={props.replyDraft}
            disabled={props.replySending}
            onChange={(event) => props.onReplyDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              const withModifier = event.metaKey || event.ctrlKey;
              if (event.shiftKey && !withModifier) return;
              event.preventDefault();
              props.onReplySubmit();
            }}
            className="text-body-s"
          />
          {props.replyError !== null ? (
            <p
              className="text-caption text-danger"
              data-testid={`comment-reply-error-${comment.id}`}
            >
              {props.replyError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-caption"
              data-testid={`comment-reply-cancel-${comment.id}`}
              onClick={props.onReplyCancel}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="h-6 px-2 text-caption"
              aria-label="Post reply"
              data-testid={`comment-reply-send-${comment.id}`}
              disabled={props.replySending || props.replyDraft.trim().length === 0}
              onClick={props.onReplySubmit}
            >
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The thread root id of one row inside the CURRENT accumulated window. */
function rootIdOfRow(commentId: string, rows: readonly Comment[]): string | null {
  const byId = new Map<string, Comment>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const seen = new Set<string>();
  let cursor: Comment | undefined = byId.get(commentId);
  for (;;) {
    if (cursor === undefined) return null;
    if (cursor.parentCommentId === null) return cursor.id;
    if (seen.has(cursor.id) || seen.has(cursor.parentCommentId)) return cursor.id;
    seen.add(cursor.id);
    cursor = byId.get(cursor.parentCommentId);
  }
}
