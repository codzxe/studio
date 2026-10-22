"use client";

// Guest comments on the /s/:token review page (BUILD_PLAN §M7 task 5 +
// §M7 task 1 "guest comments on share links").
//
// What this component does:
//   - lists the PUBLIC `ShareComment` rows (id-stripped: no member ids, no
//     guest emails — `guestName` is the only attribution a guest row exposes
//     and member-authored rows render as “Studio member”);
//   - threads them client-side (`parentCommentId`; guests post top-level
//     only — the gateway rejects `parentId` on this surface);
//   - composes a NEW guest comment with the anchor chips the public meta
//     allows: the comp anchor (see the anchoring note below) + an optional
//     time anchor from the live player playhead;
//   - persists the reviewer's name/email in sessionStorage ONLY as pre-fill
//     convenience (D-10) — never a credential, never the share password.
//
// V1 ANCHORING NOTE (documented gap): `ShareInfo.compId` is null in v1 (a
// token shares the whole project) and the public manifest deliberately
// carries NO composition list, so a fresh share link exposes no comp id to
// anchor to. The composer resolves the comp anchor as:
//   1. `ShareInfo.compId` when a future version pins one;
//   2. else the comp id already visible in the discussion (latest row);
//   3. else the literal fallback `"project"` — a project-level anchor the
//      member surface sees as a general comment.
// The right fix is a public comps list (or a non-null ShareInfo.compId) on
// the gateway; tracked in the M7-I worklog findings.

import { isApiError } from "@studio/api-client";
import type { ShareComment } from "@studio/contracts";
import { Avatar, Badge, Button, Input, Spinner, Textarea } from "@studio/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  formatSeconds,
  loadGuestIdentity,
  saveGuestIdentity,
  secondsFromTicks,
} from "./share-format";
import type { SharePort } from "./share-port";
import { type ShareFailure, describeShareFailure } from "./share-port";

// Contracts bounds mirrored locally (runtime imports of the NodeLast barrel
// are banned in apps/web; the gateway + api-client re-validate anyway).
export const GUEST_NAME_MAX = 80;
export const GUEST_EMAIL_MAX = 200;
export const COMMENT_BODY_MAX = 2000;

/** The v1 project-level anchor when no comp id is publicly known (see header). */
export const PROJECT_ANCHOR_COMP_ID = "project";

/** Resolve the composer's comp anchor from what the public surface exposes. */
export function resolveAnchorCompId(
  comments: readonly ShareComment[],
  pinnedCompId: string | null,
): string {
  if (pinnedCompId !== null && pinnedCompId.length > 0) return pinnedCompId;
  for (const comment of comments) {
    if (comment.compId.length > 0) return comment.compId;
  }
  return PROJECT_ANCHOR_COMP_ID;
}

/** Human label for an anchor chip (the fallback reads as project-level). */
export function anchorCompLabel(compId: string): string {
  return compId === PROJECT_ANCHOR_COMP_ID ? "Project" : compId;
}

export interface ShareCommentsProps {
  readonly port: SharePort;
  readonly token: string;
  /** The share password, when the link is protected (sent as the gate header). */
  readonly password?: string;
  /** Live playhead in engine ticks (from the player); null = no time anchor. */
  readonly playheadTicks: number | null;
  /** `ShareInfo.compId` — null in v1 (see the anchoring note). */
  readonly pinnedCompId: string | null;
}

interface CommentNode {
  readonly comment: ShareComment;
  readonly children: readonly CommentNode[];
}

/**
 * Thread the FLAT wire list (server order: newest first) into a
 * chronological tree: roots ordered oldest→newest, replies under their
 * parent (depth ≤ 3 is enforced server-side; rendering is recursive).
 */
export function buildCommentTree(items: readonly ShareComment[]): readonly CommentNode[] {
  const byParent = new Map<string | null, ShareComment[]>();
  for (const comment of items) {
    const key = comment.parentCommentId === null ? null : comment.parentCommentId;
    const bucket = byParent.get(key);
    if (bucket === undefined) {
      byParent.set(key, [comment]);
    } else {
      bucket.push(comment);
    }
  }
  const roots = [...(byParent.get(null) ?? [])].reverse(); // oldest first
  const build = (comment: ShareComment): CommentNode => {
    const replies = [...(byParent.get(comment.id) ?? [])].reverse();
    return { comment, children: replies.map(build) };
  };
  return roots.map(build);
}

function CommentRow({ node, depth }: { node: CommentNode; depth: number }) {
  const { comment, children } = node;
  const author = comment.guestName !== null ? comment.guestName : "Studio member";
  return (
    <li
      data-testid={`share-comment-${comment.id}`}
      className="flex flex-col gap-2 border-b border-border py-4 last:border-b-0"
    >
      <div className="flex items-start gap-3">
        <Avatar name={author} size="sm" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="share-comment-author"
              className="text-body-s font-medium text-primary"
            >
              {author}
            </span>
            {comment.resolvedAt !== null ? (
              <Badge variant="success" data-testid="share-comment-resolved">
                Resolved
              </Badge>
            ) : null}
            <span
              data-testid="share-comment-anchor-comp"
              className="rounded-xs border border-border bg-input px-1.5 py-0.5 font-mono text-hint tracking-[0.04em] text-muted"
              title={`Anchored to composition ${comment.compId}`}
            >
              comp {anchorCompLabel(comment.compId)}
            </span>
            {comment.timeTicks !== null ? (
              <span
                data-testid="share-comment-anchor-time"
                className="tabular rounded-xs border border-border bg-input px-1.5 py-0.5 font-mono text-hint tracking-[0.04em] text-muted"
              >
                at {formatSeconds(secondsFromTicks(comment.timeTicks))}
              </span>
            ) : null}
          </div>
          <p
            data-testid="share-comment-body"
            className="text-body-s leading-relaxed break-words text-secondary"
          >
            {comment.body}
          </p>
        </div>
      </div>
      {children.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1 border-l border-border pl-4">
          {children.map((child) => (
            <CommentRow key={child.comment.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ShareComments({
  port,
  token,
  password,
  playheadTicks,
  pinnedCompId,
}: ShareCommentsProps) {
  const [items, setItems] = useState<readonly ShareComment[] | null>(null);
  const [listFailure, setListFailure] = useState<ShareFailure | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [body, setBody] = useState("");
  const [anchorTime, setAnchorTime] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; body?: string }>(
    {},
  );
  const [submitFailure, setSubmitFailure] = useState<ShareFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [posted, setPosted] = useState(false);

  const options = useMemo<{ readonly password?: string }>(
    () => (password === undefined ? {} : { password }),
    [password],
  );

  const load = useCallback(async (): Promise<void> => {
    setListFailure(null);
    try {
      const page = await port.listComments(token, options);
      setItems(page.items);
    } catch (error) {
      setItems([]);
      setListFailure(describeShareFailure(error));
    }
  }, [port, token, options]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Mount-only pre-fill: the saved identity (D-10 convenience) fills the
    // composer before the reviewer starts typing.
    const saved = loadGuestIdentity(window.sessionStorage);
    setGuestName((current) => (current === "" ? saved.name : current));
    setGuestEmail((current) => (current === "" ? saved.email : current));
  }, []);

  const anchorCompId = items !== null ? resolveAnchorCompId(items, pinnedCompId) : null;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitFailure(null);
    setPosted(false);
    const name = guestName.trim();
    const email = guestEmail.trim();
    const text = body.trim();
    const errors: { name?: string; email?: string; body?: string } = {};
    if (name.length === 0) errors.name = "Add your name so the team knows who's reviewing.";
    else if (name.length > GUEST_NAME_MAX)
      errors.name = `Keep your name under ${GUEST_NAME_MAX} characters.`;
    if (email.length === 0) errors.email = "Add your email so replies can reach you.";
    else if (email.length > GUEST_EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = "That email doesn't look right.";
    }
    if (text.length === 0) errors.body = "Write a comment first.";
    else if (text.length > COMMENT_BODY_MAX) {
      errors.body = `Comments are capped at ${COMMENT_BODY_MAX} characters.`;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const created = await port.createComment(
        token,
        {
          compId: resolveAnchorCompId(items ?? [], pinnedCompId),
          timeTicks: anchorTime && playheadTicks !== null ? playheadTicks : undefined,
          body: text,
          guestName: name,
          guestEmail: email,
        },
        options,
      );
      setItems((current) => [...(current ?? []), created]);
      setBody("");
      setAnchorTime(false);
      setPosted(true);
      saveGuestIdentity(window.sessionStorage, { name, email });
    } catch (error) {
      setSubmitFailure(describeShareFailure(error));
      if (isApiError(error) && error.status === 404) void load();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      data-testid="share-comments"
      aria-label="Comments"
      className="flex flex-col gap-4 rounded-md border border-border bg-panel p-4 md:p-6"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-title-l text-primary">Comments</h2>
        {items !== null ? (
          <p className="tabular text-caption text-muted" data-testid="share-comments-count">
            {items.length} {items.length === 1 ? "comment" : "comments"}
          </p>
        ) : null}
      </div>

      {items === null && listFailure === null ? (
        <div className="flex items-center gap-3 py-6" data-testid="share-comments-loading">
          <Spinner size={20} label="Loading comments" />
          <p className="text-body-s text-muted">Loading comments…</p>
        </div>
      ) : null}

      {listFailure !== null ? (
        <div className="flex flex-col gap-3" data-testid="share-comments-error">
          <p role="alert" className="text-body-s text-danger">
            {listFailure.message}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {items !== null && listFailure === null && items.length === 0 ? (
        <p data-testid="share-comments-empty" className="py-4 text-body-s text-secondary">
          No comments yet — be the first to leave one.
        </p>
      ) : null}

      {items !== null && items.length > 0 ? (
        <ul data-testid="share-comment-list" className="flex flex-col">
          {buildCommentTree(items).map((node) => (
            <CommentRow key={node.comment.id} node={node} depth={0} />
          ))}
        </ul>
      ) : null}

      {/* ------------------------------------------------------------- composer */}
      <form
        data-testid="share-composer"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-4 border-t border-border pt-4"
      >
        <h3 className="text-title-m text-primary">Leave a comment</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            id="share-guest-name"
            data-testid="share-composer-name"
            label="Name"
            required
            maxLength={GUEST_NAME_MAX}
            value={guestName}
            error={fieldErrors.name ?? null}
            onChange={(event) => setGuestName(event.currentTarget.value)}
            autoComplete="name"
          />
          <Input
            id="share-guest-email"
            data-testid="share-composer-email"
            label="Email"
            type="email"
            required
            maxLength={GUEST_EMAIL_MAX}
            value={guestEmail}
            error={fieldErrors.email ?? null}
            onChange={(event) => setGuestEmail(event.currentTarget.value)}
            autoComplete="email"
          />
        </div>
        <Textarea
          id="share-guest-body"
          data-testid="share-composer-body"
          label="Comment"
          required
          maxLength={COMMENT_BODY_MAX}
          rows={4}
          value={body}
          error={fieldErrors.body ?? null}
          onChange={(event) => setBody(event.currentTarget.value)}
          placeholder="What should change, and where?"
        />

        <div className="flex flex-wrap items-center gap-2" data-testid="share-composer-anchors">
          {anchorCompId !== null ? (
            <span
              data-testid="share-composer-anchor-comp"
              className="rounded-xs border border-border bg-input px-1.5 py-0.5 font-mono text-hint tracking-[0.04em] text-muted"
              title="Anchored to composition"
            >
              comp {anchorCompLabel(anchorCompId)}
            </span>
          ) : null}
          {playheadTicks !== null ? (
            <button
              type="button"
              data-testid="share-composer-anchor-time"
              aria-pressed={anchorTime}
              onClick={() => setAnchorTime((value) => !value)}
              className={`tabular rounded-xs border px-1.5 py-0.5 font-mono text-hint tracking-[0.04em] transition-colors duration-120 ${
                anchorTime
                  ? "border-signal bg-signal/10 text-signal"
                  : "border-border bg-input text-muted hover:border-border-strong"
              }`}
            >
              {anchorTime ? "✓ " : ""}at {formatSeconds(secondsFromTicks(playheadTicks))}
            </button>
          ) : null}
        </div>

        {submitFailure !== null ? (
          <p role="alert" data-testid="share-composer-error" className="text-caption text-danger">
            {submitFailure.message}
          </p>
        ) : null}
        {posted && submitFailure === null ? (
          <p data-testid="share-composer-success" className="text-caption text-success">
            Comment posted.
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          data-testid="share-composer-submit"
          loading={submitting}
          className="self-start"
        >
          Post comment
        </Button>
      </form>
    </section>
  );
}
