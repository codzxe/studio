"use client";

/**
 * ChatPanelSlot — the M4-J composer of everything (M4-SEAMS.md Seam 7
 * "Integration"; EDITOR_CHAT_UX §2/§3/§9; DECISIONS.md D-5/D-18).
 *
 * The slot is the ONE place the pinned wave-2 components meet the provider:
 * it owns the chat LAYOUT (M4-E's `useChatLayout` — the provider
 * deliberately does not import peer-dir modules), maps the M3 shortcut bus
 * onto layout/controller actions, and renders the collapsed pill or the
 * composed `ChatPanel` (header / context strip / thread / composer / footer)
 * plus the context popover overlay and transient M5 notice chips.
 *
 * Wiring pins:
 * - `toggleChat` cycles collapsed→floating→sidebar (D-5) — implemented locally
 *   as `cyclePanelMode`; M4-E's optional `nextLayoutAction` helper is not part
 *   of the seams contract, so the slot keeps the cycle deterministic itself.
 * - `agent`/`send` focus the composer via the `studio:chat-focus-composer`
 *   window CustomEvent (M4-G listens; this container focus is the fallback).
 * - `inlineEdit`/`undoAgentRun` never dispatch — they surface the M5 notice
 *   chip (D-5: inline edit and undo ARE M5).
 * - `escape` closes the popover FIRST, then collapses the panel (ECUX §9).
 * - Sidebar mode never restyles the editor (D-18): the slot reports the dock
 *   state/width up via `onSidebarDock` and the HOST resizes the viewport
 *   wrapper — the iframe only ever sees a window resize.
 * - The `studio:chat-quick-action` window CustomEvent (thread/composer chips)
 *   is handled ONCE, inside the provider — not duplicated here.
 */

import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatCollapsedPill, ChatPanel } from "@/components/chat/panel";
import { ChatComposer } from "@/components/chat/composer";
import { ChatHeader, modelDisplayName } from "@/components/chat/header";
import { ChatFooter } from "@/components/chat/footer";
import { ContextPopover } from "@/components/chat/context-popover";
import { ContextStrip } from "@/components/chat/context-strip";
import { ChatThread } from "@/components/chat/thread";
import { type ChatMode, useChatLayout } from "@/components/chat/use-layout";
import type { ChatContextApi } from "@/lib/chat/provider";
import { LIVE_RUN_PHASES } from "@/lib/chat/run-state";
import { formatTokenEstimate } from "@/lib/chat/tokens";
import type { ChatShortcutEvent } from "./chat-shortcut-bus";

export interface ChatPanelSlotProps {
  /** The provider api (render-prop from the host's <ChatProvider>). */
  readonly api: ChatContextApi;
  /**
   * D-18 sidebar docking: the slot reports `docked` + the panel width; the
   * editor host resizes the editor viewport wrapper (never the iframe styles).
   */
  readonly onSidebarDock: (docked: boolean, widthPx: number) => void;
}

/** D-5: Cmd/Ctrl+L cycles collapsed → floating → sidebar (→ collapsed). */
function cyclePanelMode(mode: ChatMode): ChatMode {
  if (mode === "collapsed") return "floating";
  if (mode === "floating") return "sidebar";
  return "collapsed";
}

/**
 * §4.4 quick-action chips for an empty thread (pinned M4 subset): shortcuts
 * to prompts, not hidden automation — each rides the normal send path.
 */
const EMPTY_QUICK_ACTIONS = [
  { label: "Explain this comp", prompt: "Explain what this composition does." },
  { label: "What's on this comp?", prompt: "List the layers of the current composition." },
  { label: "Render a preview", prompt: "Render a preview of the current composition." },
] as const;

/** How long a transient notice chip stays up (ms). */
const NOTICE_MS = 4000;

/** The §3.1 shortcut sheet copy surfaced by the more menu until M5's sheet. */
const SHORTCUTS_NOTICE = "⌘L chat · ⌘I agent · ⌘↵ send · ⌘. stop · Esc close";

export function ChatPanelSlot({ api, onSidebarDock }: ChatPanelSlotProps): ReactElement {
  const { layout, setMode, reset } = useChatLayout();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const showNotice = useCallback((text: string): void => {
    setNotice(text);
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  // Clear the pending notice timer on unmount.
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  /** Focus the composer: the M4-G CustomEvent is the pin; container focus is the fallback. */
  const focusComposer = useCallback((): void => {
    containerRef.current?.focus();
    window.dispatchEvent(new CustomEvent("studio:chat-focus-composer"));
  }, []);

  // -- shortcut bus (M3.6/D-5) → layout + controller actions -----------------
  useEffect(() => {
    const handler = (event: ChatShortcutEvent): void => {
      switch (event.shortcut) {
        case "toggleChat":
          setMode(cyclePanelMode(layout.mode));
          break;
        case "agent":
        case "send":
          focusComposer();
          break;
        case "inlineEdit":
          showNotice("Inline edit arrives with M5.");
          break;
        case "undoAgentRun":
          showNotice("Undo arrives with M5.");
          break;
        case "newChat":
          api.newThread();
          break;
        case "stop":
          api.stop();
          break;
        case "escape":
          // §9 escape order: popovers first, then the panel.
          if (popoverOpen) {
            setPopoverOpen(false);
            break;
          }
          setMode("collapsed");
          break;
      }
    };
    return api.shortcutBus.subscribe(handler);
  }, [api, layout.mode, popoverOpen, setMode, focusComposer, showNotice]);

  // Visibility gates the provider's 1 Hz inspect poll + context collects (§11).
  useEffect(() => {
    api.setPanelVisible(layout.mode !== "collapsed");
  }, [api, layout.mode]);

  // D-18: report the dock state/width so the HOST can resize the viewport.
  useEffect(() => {
    onSidebarDock(layout.mode === "sidebar", layout.w);
  }, [layout.mode, layout.w, onSidebarDock]);

  // -- derived render state ----------------------------------------------------
  const { snapshot } = api;
  const streaming = LIVE_RUN_PHASES.has(snapshot.phase);
  const collapsed = layout.mode === "collapsed";

  const composerDisabled = useMemo(() => {
    if (snapshot.error?.code === "INSUFFICIENT_CREDITS") {
      // §3.4: the composer disables with a clear message; the peer's Upgrade
      // affordance stays clickable (never a silent dead input).
      return { reason: "credits" as const, message: snapshot.error.message };
    }
    if (snapshot.error?.code === "MODEL_NOT_ENTITLED") {
      return { reason: "plan" as const, message: snapshot.error.message };
    }
    return null;
  }, [snapshot.error]);

  const activeModel = api.activeModelId ?? "studio-fast";
  const contextTokens = api.context?.totalTokenEstimate ?? 0;

  const creditEstimate = useMemo(() => {
    const rates = api.models?.find((entry) => entry.id === activeModel);
    if (rates === undefined) return formatTokenEstimate(contextTokens);
    const credits = Math.max(1, Math.ceil((contextTokens / 1000) * rates.creditsPer1kInput));
    return `~${credits} credit${credits === 1 ? "" : "s"}`;
  }, [api.models, activeModel, contextTokens]);

  // -- composed slots (pinned wave-2 props) -----------------------------------
  const header = (
    <ChatHeader
      phase={snapshot.phase}
      title={api.threadTitle}
      models={api.models}
      activeModelId={api.activeModelId}
      onModelPick={api.setActiveModelId}
      contextCount={(api.context?.blocks.length ?? 0) + api.pinned.length}
      onContextClick={() => setPopoverOpen((open) => !open)}
      onCycleMode={() => setMode(cyclePanelMode(layout.mode))}
      onToggleDock={() => setMode(layout.mode === "sidebar" ? "floating" : "sidebar")}
      onClose={() => setMode("collapsed")}
      onNewChat={api.newThread}
      onResetPosition={reset}
      onShortcuts={() => showNotice(SHORTCUTS_NOTICE)}
    />
  );

  const strip = (
    <ContextStrip
      blocks={api.context?.blocks ?? []}
      totalTokenEstimate={api.context?.totalTokenEstimate ?? 0}
      onRemoveBlock={(kind) => api.setFlag(kind, false)}
      onAddContext={() => setPopoverOpen(true)}
    />
  );

  const thread = (
    <ChatThread
      messages={snapshot.messages}
      phase={snapshot.phase}
      activeRunId={snapshot.activeRunId}
      onRetry={api.retry}
      emptyQuickActions={EMPTY_QUICK_ACTIONS}
    />
  );

  const composer = (
    <ChatComposer
      streaming={streaming}
      disabled={composerDisabled}
      onSend={(message) => api.send({ message })}
      onStop={api.stop}
      creditHint={`${modelDisplayName(activeModel)} · ${formatTokenEstimate(contextTokens)}`}
    />
  );

  const footer = (
    <ChatFooter
      modelLabel={modelDisplayName(activeModel)}
      creditEstimate={creditEstimate}
      shortcutHint="⌘↵ to send"
    />
  );

  // The popover overlays the panel, under the header (§5.3); sidebar anchors
  // to the right edge, floating to the panel's own geometry.
  const popoverStyle: CSSProperties =
    layout.mode === "sidebar"
      ? { position: "absolute", top: 48, right: 0, width: layout.w, maxWidth: "90vw", zIndex: 20 }
      : {
          position: "absolute",
          top: layout.y + 48,
          left: layout.x,
          width: layout.w,
          maxWidth: "90vw",
          zIndex: 20,
        };

  // The notice chip rides just above the composer in the panel's own area.
  const noticeStyle: CSSProperties =
    layout.mode === "sidebar"
      ? { position: "absolute", right: 12, bottom: 120, maxWidth: 280 }
      : {
          position: "absolute",
          left: Math.max(8, layout.x),
          top: Math.max(8, layout.y + layout.h - 72),
          width: Math.min(layout.w, 280),
        };

  const noticeText = notice ?? api.threadError?.message ?? null;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-testid="chat-slot"
      data-chat-mode={layout.mode}
      className="pointer-events-none absolute inset-0"
    >
      {collapsed ? (
        <div className="pointer-events-auto" data-testid="chat-collapsed-layer">
          <ChatCollapsedPill onExpand={() => setMode("floating")} streaming={streaming} />
        </div>
      ) : (
        <div className="pointer-events-auto" data-testid="chat-panel-layer">
          <ChatPanel
            layout={layout}
            streaming={streaming}
            header={header}
            strip={strip}
            thread={thread}
            composer={composer}
            footer={footer}
            onCycleMode={() => setMode(cyclePanelMode(layout.mode))}
            onClose={() => setMode("collapsed")}
          />
        </div>
      )}

      {popoverOpen && !collapsed ? (
        <div className="pointer-events-auto" data-testid="chat-context-popover" style={popoverStyle}>
          <ContextPopover
            blocks={api.context?.blocks ?? []}
            totalTokenEstimate={api.context?.totalTokenEstimate ?? 0}
            onToggleBlock={(kind, on) => api.setFlag(kind, on)}
            onRemoveAll={api.clearOptionalBlocks}
            onDone={() => setPopoverOpen(false)}
          />
        </div>
      ) : null}

      {noticeText !== null ? (
        <output
          data-testid="chat-notice"
          style={noticeStyle}
          className="pointer-events-none absolute rounded-sm border border-border bg-panel px-3 py-2 text-body text-primary shadow-pop"
        >
          {noticeText}
        </output>
      ) : null}
    </div>
  );
}
