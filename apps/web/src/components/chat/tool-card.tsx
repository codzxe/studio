"use client";

/**
 * Tool card (M4-F) — EDITOR_CHAT_UX §6.1: collapsed by default (one line + a
 * result summary), Expand → args + full result in a 12px mono block with Copy;
 * status is never colour-only (§10). §9.2: the card is a button with expanded
 * state.
 *
 * Exported surface (docs/phases/M4-SEAMS.md "Wave-2 UI contract", binding):
 *   ToolCardProps + ToolCard, TOOL_CARD_LABELS (M4-J reuses the name map).
 *
 * Safety: tool results are UNTRUSTED model/bridge output. They are rendered as
 * text (React-escaped, never dangerouslySetInnerHTML); `pngBase64` blobs are
 * replaced by a size marker in any text surface and rendered as a real
 * `<img>` (data: URL) instead, so megabytes of base64 are never painted as
 * text or copied to the clipboard.
 */

import type { ToolCardState } from "@/lib/chat/types";
import { Button, Spinner } from "@studio/ui";
import { ChevronDown } from "lucide-react";
import { type ReactElement, useState } from "react";

/** Friendly names for the 5 registered M4 tools (unknown ids fall back to the raw name). */
export const TOOL_CARD_LABELS: Readonly<Record<string, string>> = {
  "studio.get_context": "Inspect project",
  "studio.list_layers": "List layers",
  "studio.get_properties": "Read properties",
  "studio.plan_edit": "Plan edit",
  "studio.render_preview": "Render preview",
};

export interface ToolCardProps {
  card: ToolCardState;
}

/** Collapsed-line result preview: compact JSON, hard-capped at 80 chars. */
const PREVIEW_LIMIT = 80;

function toolLabel(name: string): string {
  const mapped = TOOL_CARD_LABELS[name];
  if (mapped !== undefined) return mapped;
  return name.length > 0 ? name : "Tool call";
}

/** Recursively replace image blobs with a short marker (never render base64 as text). */
function redactForDisplay(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(redactForDisplay);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      key === "pngBase64" && typeof entry === "string"
        ? `<${entry.length}-byte PNG — shown as image>`
        : redactForDisplay(entry);
  }
  return out;
}

function formatJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(redactForDisplay(value), null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Seam 6 failure shape `{ error, message }` → the human message (fallback: the code). */
function failureMessage(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.error !== "string") return null;
  return typeof record.message === "string" && record.message.length > 0
    ? record.message
    : record.error;
}

/** `render_preview` results carry a PNG blob → render it, never print it. */
function previewImage(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;
  return typeof record.pngBase64 === "string" && record.pngBase64.length > 0
    ? record.pngBase64
    : null;
}

function summarize(card: ToolCardState): string {
  if (card.status === "failed") return failureMessage(card.result) ?? "Failed";
  if (card.result === undefined) return "";
  let text = "";
  try {
    text = JSON.stringify(redactForDisplay(card.result)) ?? String(card.result);
  } catch {
    text = String(card.result);
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/** Pre-clipboard fallback (non-secure contexts / headless shells). */
function legacyCopy(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
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

function StatusMark({ status }: { status: ToolCardState["status"] }) {
  if (status === "queued" || status === "running") {
    return <Spinner size={16} label={status === "running" ? "Running" : "Queued"} />;
  }
  if (status === "done") {
    return (
      <span
        data-testid="tool-card-status-mark"
        aria-hidden="true"
        className="shrink-0 text-success"
      >
        ✓
      </span>
    );
  }
  return (
    <span
      data-testid="tool-card-status-mark"
      aria-hidden="true"
      className="shrink-0 font-bold text-danger"
    >
      !
    </span>
  );
}

export function ToolCard({ card }: ToolCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const label = toolLabel(card.name);
  const summary = summarize(card);
  const live = card.status === "queued" || card.status === "running";
  const detailsId = `tool-card-details-${card.toolCallId}`;
  const image = expanded ? previewImage(card.result) : null;

  const onCopy = () => {
    const payload = formatJson({ name: card.name, args: card.args, result: card.result });
    const clipboard =
      typeof navigator === "undefined" || navigator.clipboard == null
        ? undefined
        : navigator.clipboard;
    if (clipboard != null && typeof clipboard.writeText === "function") {
      clipboard.writeText(payload).then(
        () => setCopied(true),
        () => setCopied(legacyCopy(payload)),
      );
    } else {
      setCopied(legacyCopy(payload));
    }
  };

  return (
    <div
      data-testid="tool-card"
      data-status={card.status}
      data-tool={card.name}
      className={`rounded-sm border border-border bg-elevated ${live ? "opacity-75" : ""}`}
    >
      <button
        type="button"
        data-testid="tool-card-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label} details`}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-body-s text-primary transition-colors duration-120 hover:bg-input"
      >
        <span aria-hidden="true" className="shrink-0 text-muted">
          ◈
        </span>
        <span className="shrink-0 truncate font-medium">{label}</span>
        <StatusMark status={card.status} />
        {summary !== "" ? (
          <span
            data-testid="tool-card-summary"
            className="min-w-0 flex-1 truncate text-caption text-muted"
          >
            {summary}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className={`shrink-0 text-muted transition-transform duration-120 ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded ? (
        <div
          id={detailsId}
          data-testid="tool-card-details"
          className="flex flex-col gap-2 border-t border-subtle px-2.5 py-2"
        >
          {image !== null ? (
            <img
              src={`data:image/png;base64,${image}`}
              alt="Rendered preview"
              data-testid="tool-card-image"
              className="max-h-40 w-fit rounded-xs border border-subtle"
            />
          ) : null}
          {card.args !== undefined ? (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-caption text-muted">Args</p>
              <pre
                data-testid="tool-card-args"
                className="overflow-x-auto rounded-xs border border-subtle bg-elevated p-2"
              >
                <code className="font-mono text-mono text-secondary">{formatJson(card.args)}</code>
              </pre>
            </div>
          ) : null}
          {card.result !== undefined ? (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-caption text-muted">Result</p>
              <pre
                data-testid="tool-card-result"
                className="overflow-x-auto rounded-xs border border-subtle bg-elevated p-2"
              >
                <code className="font-mono text-mono text-secondary">
                  {formatJson(card.result)}
                </code>
              </pre>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              data-testid="tool-card-copy"
              onClick={onCopy}
              aria-label={`Copy ${label} details`}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
