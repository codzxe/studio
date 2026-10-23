"use client";

/**
 * BulkActionsBar (W2-04, §8.5) — the "N selected" action strip for the
 * projects browser's bulk selection. Pure presentational: the view owns the
 * selection set, the dialogs and the port calls; this bar only names the
 * actions and reports busyness.
 *
 * - Archive (the active window) vs Restore (the archived window) — same
 *   `projects.patch` lifecycle toggle, labelled by context.
 * - Duplicate — `projects.duplicate` (429 QUOTA_EXCEEDED surfaces typed in
 *   the view's banner).
 * - Delete — opens the view's danger ConfirmDialog (type-to-confirm, §7.5).
 * - Viewers (canEdit false) get no mutation actions — the gateway re-checks
 *   every capability regardless.
 */

import { Button } from "@studio/ui";
import { Archive, ArchiveRestore, Copy, Trash2 } from "lucide-react";
import type { ReactElement } from "react";

export interface BulkActionsBarProps {
  /** Number of currently selected rows; 0 renders nothing. */
  readonly selectedCount: number;
  /** The archived window shows "Restore" instead of "Archive". */
  readonly archivedWindow: boolean;
  /** owner/admin/editor — the bulk mutation affordances (gateway re-checks). */
  readonly canEdit: boolean;
  /** Any bulk mutation is in flight (disables every action). */
  readonly busy: boolean;
  readonly onArchiveOrRestore: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly onClear: () => void;
}

export function BulkActionsBar({
  selectedCount,
  archivedWindow,
  canEdit,
  busy,
  onArchiveOrRestore,
  onDuplicate,
  onDelete,
  onClear,
}: BulkActionsBarProps): ReactElement | null {
  if (selectedCount === 0) return null;

  const noun = selectedCount === 1 ? "project" : "projects";

  return (
    <div
      data-testid="projects-bulk-bar"
      data-archived-window={archivedWindow || undefined}
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-panel px-3 py-2"
    >
      <p className="text-body-s text-secondary" data-testid="projects-bulk-count">
        <span className="tabular-nums font-medium text-primary">{selectedCount}</span> {noun}{" "}
        selected
      </p>
      {canEdit ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onArchiveOrRestore}
            data-testid="projects-bulk-archive"
          >
            {archivedWindow ? (
              <ArchiveRestore size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Archive size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
            {archivedWindow ? "Restore" : "Archive"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onDuplicate}
            data-testid="projects-bulk-duplicate"
          >
            <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
            Duplicate
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={onDelete}
            data-testid="projects-bulk-delete"
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
            Delete
          </Button>
        </>
      ) : null}
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
