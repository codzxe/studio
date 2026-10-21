"use client";

// apps/web/src/components/flows/editor-actions.tsx (W8-P)
//
// <EditorActions/> — the editor-toolbar convenience mount: the three buttons
// (undo / redo / export) wired together, plus the transient toast region.
//
//   Undo   POST /documents/:id/undo — ONE step; an agent run undoes as a
//          single step and redo restores it (§20-#7, §13.1).
//   Redo   POST /documents/:id/redo — ONE step.
//   Export opens ExportDialog (§10.3 picker → §13.1 enqueue → poll → URL).
//
// Feedback: undo/redo toasts ("Run undone — one step") and export toasts
// surface in one aria-live region and auto-dismiss after 6 s. Successful
// steps also emit the revision-refresh broadcast (./revision-events.ts) and
// the onRevision / onLayersStale callback seam — see flows/README.md.
//
// MOUNT (editor toolbar, next to the document title / zoom controls):
//
//   <EditorActions
//     client={client}
//     documentId={documentId}
//     canUndo={hasHistory}
//     canRedo={hasRedoHistory}
//     psdExportEnabled={flags.psdExport}      // §2.3 flag, default off
//     canvasSize={{ width: canvas.widthPx, height: canvas.heightPx }}
//     onRevision={setRevision}                 // preview canvas refresh key
//     onLayersStale={markLayersStale}         // layers tree re-sync
//   />

import { Download, Redo2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cn } from "@studio/ui";
import type { GatewayClient } from "../../lib/api";
import { ExportDialog } from "./export-dialog";
import { useUndoRedo, type FlowNotice } from "./use-undo-redo";

/** How long a toast stays up before auto-dismissing (ms). */
const NOTICE_AUTO_DISMISS_MS = 6_000;

export interface EditorActionsProps {
  /** Typed gateway client (apps/web/src/lib/api.ts). */
  readonly client: GatewayClient;
  readonly documentId: string;
  /**
   * Availability hint for the undo button (default true — the server rejects
   * an empty undo stack with a typed envelope that lands as a toast).
   */
  readonly canUndo?: boolean;
  /** Availability hint for the redo button (same semantics as canUndo). */
  readonly canRedo?: boolean;
  /** §2.3 psd feature flag — the dialog's psd option stays disabled until true. */
  readonly psdExportEnabled?: boolean;
  /** Canvas size hints for the export dialog's dimension placeholders. */
  readonly canvasSize?: { readonly width: number; readonly height: number } | null;
  /** Callback seam: parent records the new revision after undo/redo. */
  readonly onRevision?: (revision: number) => void;
  /** Callback seam: parent re-syncs the layer tree after undo/redo. */
  readonly onLayersStale?: () => void;
  readonly className?: string;
}

export function EditorActions({
  client,
  documentId,
  canUndo = true,
  canRedo = true,
  psdExportEnabled = false,
  canvasSize = null,
  onRevision,
  onLayersStale,
  className,
}: EditorActionsProps) {
  const { undoOne, redoOne, busy, notice, dismissNotice } = useUndoRedo({
    client,
    documentId,
    onRevision,
    onLayersStale,
  });
  const [exportOpen, setExportOpen] = useState(false);
  const [dialogNotice, setDialogNotice] = useState<FlowNotice | null>(null);

  // Latest-wins toast merge: both sources carry an `at` timestamp.
  const undoNoticeId = notice?.id ?? null;
  const toast: FlowNotice | null =
    dialogNotice !== null && (notice === null || dialogNotice.at >= notice.at)
      ? dialogNotice
      : notice;

  useEffect(() => {
    const toastId = toast?.id ?? null;
    if (toastId === null) {
      return;
    }
    const timer = setTimeout(() => {
      // The timer is keyed on the toast id — a newer notice cancels it.
      if (undoNoticeId !== null && toastId === undoNoticeId) {
        dismissNotice();
      } else {
        setDialogNotice(null);
      }
    }, NOTICE_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast?.id, undoNoticeId, dismissNotice]);

  return (
    <>
      <div
        role="toolbar"
        aria-label="Document actions"
        aria-orientation="horizontal"
        className={cn("flex items-center gap-2", className)}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={busy || !canUndo}
          onClick={() => void undoOne()}
          title="Undo one step — an agent run undoes as a single step"
        >
          <Undo2 className="size-3.5" aria-hidden="true" />
          Undo
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={busy || !canRedo}
          onClick={() => void redoOne()}
          title="Redo one step — restores what undo reverted"
        >
          <Redo2 className="size-3.5" aria-hidden="true" />
          Redo
        </Button>
        <Button
          type="button"
          size="sm"
          className="gap-1"
          onClick={() => setExportOpen(true)}
          title="Export this document"
        >
          <Download className="size-3.5" aria-hidden="true" />
          Export
        </Button>
      </div>
      <div role="status" aria-live="polite" className="min-w-0">
        {toast === null ? null : (
          <p
            className={cn(
              "rounded-md border px-3 py-2 text-xs",
              toast.tone === "success"
                ? "border-success/40 bg-success/10 text-success"
                : "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            {toast.text}
          </p>
        )}
      </div>
      <ExportDialog
        client={client}
        documentId={documentId}
        open={exportOpen}
        onOpenChange={setExportOpen}
        psdEnabled={psdExportEnabled}
        canvasSize={canvasSize}
        onNotice={setDialogNotice}
      />
    </>
  );
}
