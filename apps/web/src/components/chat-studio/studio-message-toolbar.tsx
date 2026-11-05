"use client";

/**
 * StudioMessageToolbar — ROUND 12 "Chat UI v3" per-message affordances for
 * ASSISTANT rows. The editor's `MessageActions` (chat/message-actions.tsx)
 * only wires USER rows (copy/retry/edit); assistant replies had no copy
 * affordance at all. This presentational toolbar complements it:
 *
 * - **Copy** — clipboard write mirroring message-actions' `copyText` (with
 *   the execCommand fallback for jsdom/HTTP shells), flipping to a Check
 *   icon + "Copied" confirmation for 1.6s;
 * - **Download** — visible only when the host wired `onExportOne` (absent ⇒
 *   hidden, never a dead button); forwards the raw message text;
 * - **Run chip** — when the row carries a `runId`, a tiny muted mono
 *   `run:…{last 6}` chip (full id in the tooltip). Informational, NOT a
 *   button.
 *
 * Hidden until hover/focus: the container is `opacity-0` and surfaces on
 * `group-hover`/`focus-within` — the parent message row carries the `group`
 * class (same contract as MessageActions).
 *
 * The callbacks stay text-based (`onExportOne(text)`), so this layer never
 * touches the controller.
 */

import { Check, Copy, Download } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

export interface StudioMessageToolbarProps {
  /** The assistant message body the toolbar operates on. */
  readonly text: string;
  /** The run that produced the reply (renders the `run:…{last 6}` chip). */
  readonly runId?: string;
  /** Host-provided single-message export; absent ⇒ Download is hidden. */
  readonly onExportOne?: (text: string) => void;
}

/** Clipboard write with the execCommand fallback (jsdom/HTTP shells). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function StudioMessageToolbar({
  text,
  runId,
  onExportOne,
}: StudioMessageToolbarProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(() => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1600);
    });
  }, [text]);

  const onDownload = useCallback(() => {
    onExportOne?.(text);
  }, [onExportOne, text]);

  const buttonBase =
    "inline-flex h-6 w-6 items-center justify-center rounded-xs p-0 text-muted transition-colors duration-120 hover:bg-elevated hover:text-primary";

  return (
    <div
      data-testid="studio-message-toolbar"
      className="flex items-center gap-0.5 opacity-0 transition-opacity duration-120 focus-within:opacity-100 group-hover:opacity-100"
    >
      <button
        type="button"
        className={buttonBase}
        aria-label={copied ? "Copied" : "Copy message"}
        data-testid="studio-message-copy"
        data-copied={copied}
        onClick={onCopy}
      >
        {copied ? (
          <Check size={13} strokeWidth={1.9} aria-hidden="true" />
        ) : (
          <Copy size={13} strokeWidth={1.9} aria-hidden="true" />
        )}
      </button>
      {onExportOne !== undefined ? (
        <button
          type="button"
          className={buttonBase}
          aria-label="Download message"
          title="Download message"
          data-testid="studio-message-download"
          onClick={onDownload}
        >
          <Download size={13} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
      {runId !== undefined && runId !== "" ? (
        <span
          data-testid="studio-message-run-chip"
          title={runId}
          className="ml-1 select-none font-mono text-hint text-muted"
        >
          {`run:…${runId.slice(-6)}`}
        </span>
      ) : null}
    </div>
  );
}
