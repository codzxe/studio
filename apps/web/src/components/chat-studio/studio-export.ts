/**
 * Studio chat export — the "Copy transcript" / "Download transcript"
 * affordances of the chat-first studio toolbar. Pure TypeScript, no React:
 * the toolbar components call these helpers directly.
 *
 * - `transcriptToMarkdown` renders the live ChatUiMessage thread as a
 *   ChatGPT-export-style markdown document (deterministic grammar, tools in
 *   card order, no trailing whitespace, one trailing newline).
 * - `copyTranscript` writes it to the clipboard with the same
 *   primary + execCommand fallback strategy as message-actions.tsx (for the
 *   jsdom/HTTP shells).
 * - `downloadTranscript` hands the document to the browser as a
 *   text/markdown blob; SSR-safe (no-op without window/document).
 */

import type { ChatUiMessage } from "@/lib/chat/types";

/** Section heading per message role (ChatGPT-export vocabulary: You / Agent). */
function roleHeading(role: ChatUiMessage["role"]): string {
  return role === "user" ? "## You" : "## Agent";
}

/** Header metadata for the exported transcript document. */
export interface TranscriptExportMeta {
  /** Project display name shown in the document header. */
  readonly projectName: string;
  /** Thread title; `null` falls back to the untitled "Chat" heading. */
  readonly threadTitle: string | null;
}

/**
 * Renders the thread transcript as a ChatGPT-export-style markdown doc:
 * `# {threadTitle ?? "Chat"} — {projectName}`, an `Exported {ISO date}`
 * line, then per message a `## You` / `## Agent` section with its text, and
 * for assistant messages that carry tool cards a `Tools:` bullet list in
 * card order (`- {name} ({status})`). Deterministic output; no trailing
 * whitespace lines; ends with a single trailing newline.
 */
export function transcriptToMarkdown(
  messages: readonly ChatUiMessage[],
  meta: TranscriptExportMeta,
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.threadTitle ?? "Chat"} — ${meta.projectName}`);
  lines.push("");
  lines.push(`Exported ${new Date().toISOString()}`);

  for (const message of messages) {
    lines.push("");
    lines.push(roleHeading(message.role));
    const text = message.text.trimEnd();
    if (text.length > 0) {
      lines.push("");
      lines.push(text);
    }
    if (message.role === "assistant" && message.toolCards.length > 0) {
      lines.push("");
      lines.push("Tools:");
      for (const card of message.toolCards) {
        lines.push(`- ${card.name} (${card.status})`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Clipboard write with the execCommand textarea fallback (mirrors
 * message-actions.tsx's copyText — the jsdom/HTTP shells). Resolves `true`
 * only when a copy path reports success.
 */
export async function copyTranscript(markdown: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(markdown);
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
    area.value = markdown;
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

/**
 * Downloads the markdown as a file: text/markdown blob → object URL →
 * temporary anchor click → revoke. No-op outside the browser (SSR guard) —
 * the affordance never mounts there, but the module is imported isomorphically.
 */
export function downloadTranscript(markdown: string, filename: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
