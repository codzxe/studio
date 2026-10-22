/**
 * The editor-route shortcut bus (M3.6, DECISIONS.md D-5).
 *
 * The bridge's `forwardShortcut` seam forwards Cmd/Ctrl+L/K/I (and their
 * Shift combos) from INSIDE the editor iframe; the host publishes them here.
 * M4's chat overlay subscribes:
 *
 *   - Cmd/Ctrl+L  → toggle the chat (collapsed pill ⇄ previous mode)
 *   - Cmd/Ctrl+K  → inline edit (INSIDE the editor route — D-5; the command
 *                   palette stays OUTSIDE the editor route)
 *   - Cmd/Ctrl+I  → agent mode
 *   - Shift variants / Cmd+. / Esc / Cmd+Enter → new chat / undo run / stop /
 *                   escape / send — recorded, consumed from M4.
 *
 * Until M4 lands the bus simply RECORDS the events (D-5: "no-op handler") so
 * the wiring is testable end-to-end without a chat to receive them.
 */

export type ChatShortcutName =
  | "toggleChat"
  | "inlineEdit"
  | "agent"
  | "stop"
  | "newChat"
  | "undoAgentRun"
  | "escape"
  | "send";

export interface ChatShortcutEvent {
  readonly shortcut: ChatShortcutName;
  /** The raw `KeyboardEvent.key` ("l", "k", "i", …). */
  readonly key: string;
  /** `Date.now()` at publish — ordering/debugging aid for M4. */
  readonly at: number;
}

export type ChatShortcutHandler = (event: ChatShortcutEvent) => void;

export interface ChatShortcutBus {
  /** Publish + record one forwarded editor shortcut. */
  publish(shortcut: ChatShortcutName, key: string): void;
  /** M4's chat subscribes here; returns an unsubscribe function. */
  subscribe(handler: ChatShortcutHandler): () => void;
  /** The most recent events (bounded, newest last) — M4 hydration/debugging. */
  recent(): readonly ChatShortcutEvent[];
}

const DEFAULT_RECENT_LIMIT = 16;

export function createChatShortcutBus(recentLimit = DEFAULT_RECENT_LIMIT): ChatShortcutBus {
  const handlers = new Set<ChatShortcutHandler>();
  const recent: ChatShortcutEvent[] = [];
  return {
    publish(shortcut, key): void {
      const event: ChatShortcutEvent = { shortcut, key, at: Date.now() };
      recent.push(event);
      if (recent.length > recentLimit) recent.splice(0, recent.length - recentLimit);
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch {
          // a buggy subscriber never breaks the editor route
        }
      }
    },
    subscribe(handler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    recent(): readonly ChatShortcutEvent[] {
      return [...recent];
    },
  };
}

/** The singleton the editor host publishes to; M4's chat will consume it. */
export const editorChatShortcutBus: ChatShortcutBus = createChatShortcutBus();
