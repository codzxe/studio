"use client";

// apps/web/src/components/flows/use-undo-redo.ts (W8-P)
//
// useUndoRedo — the toolbar seam for §20-#7 / §13.1:
//
//   POST /v1/documents/:id/undo   ONE step — an agent run undoes as one step;
//                                 the whole run reverts to the pre-run state.
//   POST /v1/documents/:id/redo   ONE step — redo restores what undo reverted.
//
//   lib/api.ts (W1-K) injects the §13 Idempotency-Key on both POSTs, so a
//   double click cannot double-apply (the server memoizes by key).
//
// FEEDBACK: every outcome lands in `notice` — a small FlowNotice the mount
// renders as a transient toast ("Run undone — one step", task text; the
// revision rides along as a suffix, never the headline).
//
// REVISION REFRESH: a successful step (a) calls the optional onRevision /
// onLayersStale callback seam (the W8-F chat-panel pattern) and (b) emits the
// window broadcast `studio:document-revision-refresh` (./revision-events.ts —
// the documented contract the editor panels consume). Both fire; panels pick
// whichever style they are built with.
//
// W8-F's chat-panel.tsx owns its own in-chat undo button; this hook is the
// editor-toolbar twin (mounted through EditorActions — see flows/README.md).

import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayClient } from "../../lib/api";
import {
  REDO_NOTICE_TEXT,
  UNDO_NOTICE_TEXT,
  flowErrorText,
  formatRevisionNotice,
  undoRedoReplySchema,
} from "./flows-model";
import {
  subscribeRevisionRefresh,
  broadcastRevisionRefresh,
  type RevisionRefreshListener,
} from "./revision-events";

/** One transient toast — rendered by the mount, dismissed by timer or click. */
export interface FlowNotice {
  /** Stable id — the mount's auto-dismiss timer keys on it. */
  readonly id: string;
  readonly tone: "success" | "error";
  readonly text: string;
  readonly revision: number | null;
  /** Date.now() at emit — lets a mount merge notices "latest wins". */
  readonly at: number;
}

export interface UseUndoRedoOptions {
  /** Typed gateway client (apps/web/src/lib/api.ts). */
  readonly client: GatewayClient;
  readonly documentId: string;
  /** Callback seam: parent records the new revision (preview canvas refresh key). */
  readonly onRevision?: (revision: number) => void;
  /** Callback seam: parent re-syncs the layer tree (chat-panel pattern). */
  readonly onLayersStale?: () => void;
}

export interface UseUndoRedoResult {
  /** POST /documents/:id/undo — one step (§13.1); toasts the outcome. */
  readonly undoOne: () => Promise<void>;
  /** POST /documents/:id/redo — one step (§13.1); toasts the outcome. */
  readonly redoOne: () => Promise<void>;
  /** True while a step POST is in flight (both buttons disable on it). */
  readonly busy: boolean;
  /** Latest toast; null when dismissed. Auto-dismiss is the mount's job. */
  readonly notice: FlowNotice | null;
  readonly dismissNotice: () => void;
}

function makeNotice(tone: FlowNotice["tone"], text: string, revision: number | null): FlowNotice {
  return { id: crypto.randomUUID(), tone, text, revision, at: Date.now() };
}

export function useUndoRedo(options: UseUndoRedoOptions): UseUndoRedoResult {
  const { client, documentId, onRevision, onLayersStale } = options;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<FlowNotice | null>(null);
  // Double-submit guard that survives render races (a ref, not just state).
  const busyRef = useRef(false);

  const step = useCallback(
    async (kind: "undo" | "redo"): Promise<void> => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const reply = await client.post(
          `/documents/${encodeURIComponent(documentId)}/${kind}`,
          { schema: undoRedoReplySchema },
        );
        // Revision refresh, style (b): the documented window broadcast
        // (./revision-events.ts — panels subscribe via useRevisionRefresh).
        broadcastRevisionRefresh({
          documentId,
          revision: reply.revision_after,
          source: kind,
          at: Date.now(),
        });
        // Revision refresh, style (a): the callback seam (chat-panel pattern).
        onRevision?.(reply.revision_after);
        onLayersStale?.();
        setNotice(
          makeNotice(
            "success",
            formatRevisionNotice(
              kind === "undo" ? UNDO_NOTICE_TEXT : REDO_NOTICE_TEXT,
              reply.revision_after,
            ),
            reply.revision_after,
          ),
        );
      } catch (error) {
        // Typed envelope (§13.3) → message — hint; never codes/paths/stack.
        setNotice(
          makeNotice(
            "error",
            flowErrorText(
              error,
              kind === "undo"
                ? "The last step could not be undone."
                : "The redo could not be applied.",
            ),
            null,
          ),
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [client, documentId, onRevision, onLayersStale],
  );

  const undoOne = useCallback((): Promise<void> => step("undo"), [step]);
  const redoOne = useCallback((): Promise<void> => step("redo"), [step]);
  const dismissNotice = useCallback((): void => {
    setNotice(null);
  }, []);

  return { undoOne, redoOne, busy, notice, dismissNotice };
}

/**
 * useRevisionRefresh — the consumer side of the broadcast (./revision-events.ts).
 * Panels use this to re-sync revision-derived data without importing the
 * emitter. Pass `documentId` to see only that document's refreshes, or null
 * to observe every document (e.g. a cross-document listener in the shell).
 *
 *   useRevisionRefresh(documentId, (detail) => {
 *     queryClient.invalidateQueries({ queryKey: ["document", documentId] });
 *   });
 */
export function useRevisionRefresh(
  documentId: string | null,
  listener: RevisionRefreshListener,
): void {
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  }, [listener]);
  useEffect(() => {
    return subscribeRevisionRefresh((detail) => {
      if (documentId !== null && detail.documentId !== documentId) {
        return; // another document's refresh — not ours
      }
      listenerRef.current(detail);
    });
  }, [documentId]);
}
