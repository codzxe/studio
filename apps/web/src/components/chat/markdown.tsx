/**
 * Minimal SAFE markdown renderer (M4-F) — EDITOR_CHAT_UX §3.3 "markdown subset:
 * paragraphs/bold/italic/code/lists — NO raw HTML, escape everything".
 *
 * Exported surface (docs/phases/M4-SEAMS.md "Wave-2 UI contract", binding):
 *   Markdown({ text }) — everything else here is internal.
 *
 * Safety model (M4-N injection posture): the renderer NEVER builds an HTML
 * string and never calls dangerouslySetInnerHTML — every token becomes a typed
 * React node and React escapes all text content at render time, so `<script>`
 * in model output is literal text, not markup. Links are DELIBERATELY
 * text-only: `[label](url)` renders just the label (no anchor is ever created
 * from model text) and bare URLs stay plain text.
 *
 * Supported (the pinned subset, nothing more): paragraphs, **bold**, *italic*,
 * `code`, fenced ``` blocks, "- " lists, headings h1–h3.
 */

import { type ReactElement, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; lines: readonly string[] }
  | { kind: "list"; items: readonly string[] }
  | { kind: "code"; lines: readonly string[] };

const FENCE = /^```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const LIST_ITEM = /^-\s+/;

/** A paragraph keeps accumulating until a blank line or another block starts. */
function startsBlock(line: string): boolean {
  return FENCE.test(line.trim()) || HEADING.test(line) || LIST_ITEM.test(line);
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") {
      i += 1;
      continue;
    }
    // Fenced code block: ``` opens (language tag ignored), ``` closes; an
    // unterminated fence swallows the rest safely (it can never run).
    if (FENCE.test(line.trim())) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const inner = lines[i];
        if (inner === undefined) break;
        if (FENCE.test(inner.trim())) {
          i += 1;
          break;
        }
        body.push(inner);
        i += 1;
      }
      blocks.push({ kind: "code", lines: body });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const hashes = heading[1]?.length ?? 0;
      const level = hashes === 1 ? 1 : hashes === 2 ? 2 : 3;
      blocks.push({ kind: "heading", level, text: heading[2] ?? "" });
      i += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i];
        if (item === undefined || !LIST_ITEM.test(item)) break;
        items.push(item.replace(LIST_ITEM, ""));
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length) {
      const run = lines[i];
      if (run === undefined || run.trim() === "" || startsBlock(run)) break;
      paragraph.push(run);
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline parsing (code spans first, then bold, then italic, then text-only links)
// ---------------------------------------------------------------------------

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]*\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let tokenIndex = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;
    tokenIndex += 1;
    if (token.startsWith("`")) {
      out.push(
        <code
          key={key}
          className="rounded-xs bg-input px-1 py-0.5 font-mono text-mono text-secondary"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-primary">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      // [label](url) → text-only label; the URL is never rendered and no
      // anchor is ever created from model text.
      const close = token.indexOf("]");
      out.push(<span key={key}>{token.slice(1, close)}</span>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// Blocks → React nodes
// ---------------------------------------------------------------------------

function renderBlocks(blocks: readonly Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.kind) {
      case "heading": {
        // Headings keep their semantics but are rescaled to the chat column
        // (a model h1 is a paragraph-level heading here, not a page title).
        const cls = "font-semibold text-primary";
        if (block.level === 1) {
          return (
            <h1 key={key} className={`text-body ${cls}`}>
              {renderInline(block.text, key)}
            </h1>
          );
        }
        if (block.level === 2) {
          return (
            <h2 key={key} className={`text-body ${cls}`}>
              {renderInline(block.text, key)}
            </h2>
          );
        }
        return (
          <h3 key={key} className={`text-body-s ${cls}`}>
            {renderInline(block.text, key)}
          </h3>
        );
      }
      case "paragraph":
        return (
          <p key={key}>
            {block.lines.flatMap((line, lineIndex) =>
              lineIndex === 0
                ? renderInline(line, `${key}-${lineIndex}`)
                : [" ", ...renderInline(line, `${key}-${lineIndex}`)],
            )}
          </p>
        );
      case "list":
        return (
          <ul key={key} className="list-disc pl-5">
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
            ))}
          </ul>
        );
      case "code":
        return (
          <pre
            key={key}
            data-testid="chat-md-code"
            className="overflow-x-auto rounded-xs border border-subtle bg-input p-2"
          >
            <code className="font-mono text-mono text-secondary">{block.lines.join("\n")}</code>
          </pre>
        );
    }
  });
}

/** Render the safe markdown subset. Empty/whitespace-only input renders nothing. */
export function renderMarkdown(text: string): ReactNode[] {
  return renderBlocks(parseBlocks(text));
}

/**
 * The chat markdown renderer (14px/1.55 per EDITOR_CHAT_UX §10; the message
 * component constrains the 72ch width).
 */
export function Markdown({ text }: { text: string }): ReactElement {
  return (
    <div
      data-testid="chat-markdown"
      className="flex min-w-0 flex-col gap-2 text-sm leading-[1.55] text-primary"
    >
      {renderMarkdown(text)}
    </div>
  );
}
