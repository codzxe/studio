// apps/web/src/components/flows/revision-events.ts (W8-P)
//
// The revision-refresh broadcast — the tiny cross-panel contract for "the
// document's revision changed; re-sync anything you render".
//
// WHO EMITS (today): flows/use-undo-redo.ts after a successful §13.1
//   POST /v1/documents/:id/{undo,redo} (§20-#7: one undo reverts the whole
//   agent run; redo restores it). The editor's own runs (W8-F chat-panel)
//   still use their onRevision callback prop — the event and the prop are
//   two views of the same seam; panels may consume either.
//
// WHO CONSUMES (contract): any editor panel that renders revision-derived
//   data — preview canvas (re-render at the new revision), layers tree
//   (refetch `GET /documents/:id/layers`), version timeline (refetch
//   versions), properties panel. Two supported styles:
//
//   1. Event (no import coupling to the emitter):
//        subscribeRevisionRefresh((detail) => { … });
//      or the React hook from ./use-undo-redo.ts:
//        useRevisionRefresh(documentId, (detail) => { … });
//
//   2. Query invalidation: panels built on @tanstack/react-query may
//      instead invalidate in their own listener, e.g.
//        queryClient.invalidateQueries({ queryKey: ["document", documentId] });
//      The event deliberately carries everything a key needs; nothing here
//      owns a queryClient.
//
// SHAPE (frozen — additive changes only): { documentId, revision, source, at }.
// Detail is NOT typed `any`; unknown fields are ignored by consumers. The
// event name is namespaced ("studio:") and internal-only (§1.5 codename law:
// never user-facing).

/** Window event type. Frozen — a rename is a breaking contract change. */
export const REVISION_REFRESH_EVENT = "studio:document-revision-refresh" as const;

/** Why the revision changed. Additive only. */
export type RevisionRefreshSource = "undo" | "redo";

/** Payload panels receive. `revision` is the document's §5.6 monotonic revision. */
export interface RevisionRefreshDetail {
  readonly documentId: string;
  readonly revision: number;
  readonly source: RevisionRefreshSource;
  /** Date.now() at emit — for "latest wins" merges in multi-emitter futures. */
  readonly at: number;
}

export type RevisionRefreshListener = (detail: RevisionRefreshDetail) => void;

/** Type-predicate for the CustomEvent detail at the consumption boundary. */
function isRevisionRefreshDetail(value: unknown): value is RevisionRefreshDetail {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RevisionRefreshDetail>;
  return (
    typeof candidate.documentId === "string" &&
    typeof candidate.revision === "number" &&
    (candidate.source === "undo" || candidate.source === "redo") &&
    typeof candidate.at === "number"
  );
}

/**
 * Emit the broadcast. SSR-safe: a no-op without a `window` (the flows are
 * client components, but prerenders must never explode on a stray call).
 */
export function broadcastRevisionRefresh(detail: RevisionRefreshDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<RevisionRefreshDetail>(REVISION_REFRESH_EVENT, { detail }));
}

/**
 * Subscribe on `window`; returns the unsubscribe function. Malformed details
 * (a future emitter drifting from the frozen shape) are skipped defensively —
 * consumers never see a partial payload.
 */
export function subscribeRevisionRefresh(listener: RevisionRefreshListener): () => void {
  if (typeof window === "undefined") {
    return (): void => undefined; // SSR: nothing to subscribe to
  }
  const handler = (event: Event): void => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (isRevisionRefreshDetail(detail)) {
      listener(detail);
    }
  };
  window.addEventListener(REVISION_REFRESH_EVENT, handler);
  return (): void => {
    window.removeEventListener(REVISION_REFRESH_EVENT, handler);
  };
}
