"use client";

// Delete confirmation (W8-I) — a native <dialog> (showModal gives us the
// focus trap, Escape handling and aria-modal semantics for free) over the
// §13.1 DELETE /v1/assets/:id mutation. A §13.3 `not_found` response is
// treated as success: the asset is already gone (the gateway's contract —
// a re-delete is done, never a repeat effect). Other failures map to
// friendly copy with the envelope hint (guards.ts).

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  describeLibraryFailure,
  formatBytes,
  isNotFoundFailure,
  type FailureCopy,
} from "./guards";
import { useDeleteAsset, type AssetSummary } from "./use-assets";

const TITLE_ID = "asset-delete-title";

export interface DeleteDialogProps {
  /** The asset pending deletion; null while closed. */
  readonly asset: AssetSummary | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function DeleteDialog({ asset, open, onOpenChange }: DeleteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteAsset = useDeleteAsset();
  const [failure, setFailure] = useState<FailureCopy | null>(null);

  // showModal/close + a native close listener (belt and braces over the
  // React onClose prop): Escape and backdrop dismissal funnel into the same
  // onOpenChange(false) as the buttons. Focus lands on Cancel — the least
  // destructive action (WAI-ARIA APG confirm-dialog guidance).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const handleNativeClose = (): void => {
      onOpenChange(false);
    };
    dialog.addEventListener("close", handleNativeClose);
    if (open && !dialog.open) {
      setFailure(null);
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    return () => {
      dialog.removeEventListener("close", handleNativeClose);
    };
  }, [open, onOpenChange]);

  function onDialogClick(event: MouseEvent<HTMLDialogElement>): void {
    // The ::backdrop area reports the <dialog> itself as the click target.
    if (event.target === dialogRef.current) {
      dialogRef.current?.close();
    }
  }

  async function handleConfirm(): Promise<void> {
    if (asset === null) {
      return;
    }
    try {
      await deleteAsset.mutateAsync(asset.id); // success invalidates the cache
      onOpenChange(false);
    } catch (error: unknown) {
      if (isNotFoundFailure(error)) {
        onOpenChange(false); // §13.3: already deleted — treat as done
        return;
      }
      setFailure(describeLibraryFailure(error));
    }
  }

  return (
    <>
      {/* Native dialog backdrops are transparent — dim it (scoped by class). */}
      <style>{"dialog.asset-delete-dialog::backdrop { background: rgb(24 24 27 / 0.6); }"}</style>
      <dialog
        ref={dialogRef}
        aria-labelledby={TITLE_ID}
        onClick={onDialogClick}
        className="asset-delete-dialog w-full max-w-md rounded-lg border border-border bg-surface p-6 text-foreground shadow-lg"
      >
        <div className="flex items-start gap-3">
          <TriangleAlert
            className="mt-0.5 size-5 shrink-0 text-red-600"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <h2 id={TITLE_ID} className="text-base font-semibold">
              Delete this asset?
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              &quot;{asset?.name}&quot;
              {asset !== null ? ` (${formatBytes(asset.bytes)})` : ""} will be
              removed from your workspace library. Images already placed in
              documents keep their own copies, but new prompts cannot attach it.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => {
              onOpenChange(false);
            }}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={deleteAsset.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {deleteAsset.isPending ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {deleteAsset.isPending ? "Deleting…" : "Delete asset"}
          </button>
        </div>
        {failure !== null ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {failure.title}
            {failure.hint !== undefined ? (
              <span className="block text-xs text-muted-foreground">{failure.hint}</span>
            ) : null}
          </p>
        ) : null}
      </dialog>
    </>
  );
}
