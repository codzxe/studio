"use client";

/**
 * Chat confirm dialog (M5-G) — the small accessible modal behind the plan
 * card's HIGH-RISK confirm (EDITOR_CHAT_UX §6.2 "high risk uses a stronger
 * border and an explicit confirm checkbox"; BUILD_PLAN §M5 exit criterion
 * "high-risk actions always require confirmation").
 *
 * Accessibility (§7.5 + §9.2): role="dialog" with an accessible name (the
 * required title), aria-modal, a FOCUS TRAP and Escape-to-cancel. The trap,
 * Escape handling, focus restoration and aria wiring come from the
 * `@studio/ui` Dialog primitives (Radix) — this component only composes them
 * with the chat's action pair (quiet Cancel + explicit Confirm), so the
 * product never grows a second hand-rolled modal. Design tokens only (law #8);
 * `danger` renders the destructive confirm on --danger.
 *
 * Escape = cancel: closing by Escape, the ✕, outside click or the Cancel
 * button all funnel through `onOpenChange(false)`; ONLY the Confirm button
 * fires `onConfirm`. The parent owns `open` (the plan card closes the dialog
 * itself after emitting the apply).
 *
 * Exported surface (docs/phases/M5-SEAMS.md ownership map, M5-G):
 *   ChatConfirmDialogProps + ChatConfirmDialog.
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@studio/ui";
import type { ReactElement, ReactNode } from "react";

export interface ChatConfirmDialogProps {
  /** Controlled open state (Radix pattern). */
  open: boolean;
  /** The single close path: `false` on Escape / ✕ / outside click / Cancel. */
  onOpenChange: (open: boolean) => void;
  /** Dialog title — REQUIRED (Radix warns without one; it is the accessible name). */
  title: string;
  /** Explanation shown under the title; rendered as inert text/data. */
  description?: ReactNode;
  /** The destructive/primary confirm label (e.g. "Apply"). */
  confirmLabel: string;
  /** Quiet cancel label; defaults to "Cancel". */
  cancelLabel?: string;
  /** Fired ONLY by the explicit confirm action. */
  onConfirm: () => void;
  /** Render the confirm on --danger (destructive, §7.1). */
  danger?: boolean;
  /** Marks the confirm busy (spinner + "Working…", width preserved). */
  busy?: boolean;
}

export function ChatConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  danger = false,
  busy = false,
}: ChatConfirmDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="chat-confirm-dialog" aria-describedby={undefined}>
        <DialogTitle data-testid="chat-confirm-title">{title}</DialogTitle>
        {description !== undefined ? (
          <DialogDescription data-testid="chat-confirm-description">
            {description}
          </DialogDescription>
        ) : null}
        <DialogActions>
          <Button
            variant="secondary"
            size="sm"
            data-testid="chat-confirm-cancel"
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            data-testid="chat-confirm-confirm"
            loading={busy}
            onClick={() => onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
