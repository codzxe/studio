"use client";

/**
 * ChatPanelSlot — the M4-J composer of everything (M4-SEAMS.md Seam 7
 * "Integration"; EDITOR_CHAT_UX §2/§3/§4/§9; DECISIONS.md D-5/D-18) + the M5-I
 * agent-UX chrome (BUILD_PLAN §M5.7).
 *
 * The slot is the ONE place the pinned wave-2 components meet the provider:
 * it owns the chat LAYOUT (M4-E's `useChatLayout` — the provider deliberately
 * imports no peer-dir module), maps the M3 shortcut bus onto
 * layout/controller actions through M4-E's `nextLayoutAction`, and renders
 * the collapsed pill or the composed `ChatPanel`
 * (header / context strip / thread / composer / footer) plus the context
 * popover overlay and transient M5 notice chips.
 *
 * M5-I additions (all additive; the editor itself is never touched — law #7):
 * - **Quick actions (§4.4)**: token chips above the composer, seeded with the
 *   current selection context. A click publishes the CANCELABLE
 *   `studio:chat-seed-composer` window event (a draft-capable composer
 *   claims it); unclaimed, the M4 `studio:chat-quick-action` send path is the
 *   fallback. Either way a quick action is chat-only — it can propose, never
 *   mutate (§4.4 "shortcuts to prompts, not hidden automation").
 * - **Inline edit (§4.2, D-5)**: `Cmd/Ctrl+K` opens the `InlineEditBar` above
 *   the composer (Enter submits through `api.send` tagged `inlineEdit: true`
 *   — see the seam note in `./inline-edit.tsx`; Escape closes).
 * - **Agent mode (§4.3, D-5)**: `Cmd/Ctrl+I` expands the panel, focuses the
 *   composer and raises the "Agent mode" chip until dismissed.
 * - **Edit cards (§6.4/§8.6)**: the clarify card (latest assistant plan with
 *   `intent === "clarify"` — question + candidate-layer answer chips) and the
 *   error card (newest failed tool card — human copy only, law #1) render
 *   above the composer while they are the thread's newest activity.
 * - **Host-side shortcut listener (D-5)**: the bridge seam forwards
 *   `Cmd/Ctrl+K/I` from INSIDE the iframe; the slot additionally publishes
 *   the same two from the PARENT document onto the SAME bus so the shortcuts
 *   work wherever focus sits. It binds ONLY here — the slot mounts only on
 *   the editor route, so everywhere else `Cmd/Ctrl+K` stays the command
 *   palette (D-5).
 *
 * Wiring pins kept from M4:
 * - `toggleChat`/`agent` go through `nextLayoutAction` (M4-E's deterministic
 *   bus→layout mapping); `newChat` resets the thread via `api.newThread()`,
 *   `stop` hits the §8.3 fused cancel, `send` focuses the composer,
 *   `undoAgentRun` still surfaces the M5 notice chip (apply/undo is M5-F's).
 * - `agent`/`send` focus the composer via the `studio:chat-focus-composer`
 *   window CustomEvent (M4-G listens; this container focus is the fallback).
 * - `escape` closes layers top-first (§9): inline bar → context popover →
 *   composer-area transients (agent chip / clarify card) → panel collapse.
 * - Sidebar mode never restyles the editor (D-18): the slot reports dock
 *   state/width up via `onSidebarDock` and the HOST resizes the viewport
 *   wrapper — the iframe only ever sees a window resize.
 * - The `studio:chat-quick-action` window CustomEvent (thread/composer chips)
 *   is handled ONCE, inside the provider — not duplicated here.
 */

import { ClarifyCard, EditErrorCard } from "@/components/chat/edit-cards";
import {
  CHAT_SEED_COMPOSER_EVENT,
  QuickActions,
  buildQuickActions,
  selectionNamesOf,
} from "@/components/chat/quick-actions";
import { ChatComposer } from "@/components/chat/composer";
import { ContextPopover } from "@/components/chat/context-popover";
import { ContextStrip } from "@/components/chat/context-strip";
import { ChatFooter } from "@/components/chat/footer";
import { ChatHeader, modelDisplayName } from "@/components/chat/header";
import { nextLayoutAction } from "@/components/chat/layout";
import { type ChatLayoutStore, useChatLayout } from "@/components/chat/use-layout";
import { ChatCollapsedPill, ChatPanel } from "@/components/chat/panel";
import { CHAT_QUICK_ACTION_EVENT, ChatThread } from "@/components/chat/thread";
import type { EditPlan } from "@studio/contracts";
import { Badge, Button } from "@studio/ui";
import { X } from "lucide-react";
import type { ChatContextApi } from "@/lib/chat/provider";
import { LIVE_RUN_PHASES } from "@/lib/chat/run-state";
import { formatTokenEstimate } from "@/lib/chat/tokens";
import type { ToolCardState } from "@/lib/chat/types";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatShortcutEvent } from "./chat-shortcut-bus";
import { type InlineEditSubmit, InlineEditBar } from "./inline-edit";

// Re-exported for the editor host + tests: the submit seam type of the bar.
export type { InlineEditSubmit } from "./inline-edit";

export interface ChatPanelSlotProps {
  /** The provider api (render-prop from the host's <ChatProvider>). */
  readonly api: ChatContextApi;
  /**
   * D-18 sidebar docking: the slot reports `docked` + the panel width; the
   * editor host resizes the editor viewport wrapper (never the iframe styles).
   */
  readonly onSidebarDock: (docked: boolean, widthPx: number) => void;
  /**
   * Test/embedding seam (use-layout's optional-store contract): defaults to
   * the app singleton. Production (the editor host) never passes it.
   */
  readonly layoutStore?: ChatLayoutStore;
}

/**
 * §4.4 quick-action chips for an empty thread (pinned M4 subset): shortcuts
 * to prompts, not hidden automation — each rides the normal send path (the
 * thread dispatches `studio:chat-quick-action`, the provider owns the send).
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

/** The seam-6 tool failure shape `{ error: string; message?: string }`. */
function seamSixFailure(result: unknown): { code: string; message?: string } | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.error !== "string") return null;
  return {
    code: record.error,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

/** The name inside a context block's `data` (tolerant of every degraded shape). */
function contextDataName(
  context:
    | { readonly blocks: ReadonlyArray<{ readonly kind?: unknown; readonly data?: unknown }> }
    | null
    | undefined,
  kind: string,
): string | null {
  const block = context?.blocks.find((entry) => entry?.kind === kind);
  const data = block?.data;
  if (typeof data !== "object" || data === null) return null;
  const name = (data as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : null;
}

/** The newest failed tool card of the thread's LAST message (else null). */
function lastFailedToolCard(
  message: { readonly role: string; readonly toolCards: readonly ToolCardState[] } | undefined,
): ToolCardState | null {
  if (message === undefined || message.role !== "assistant") return null;
  for (let i = message.toolCards.length - 1; i >= 0; i--) {
    const card = message.toolCards[i];
    if (card !== undefined && card.status === "failed" && card.result !== undefined) return card;
  }
  return null;
}

export function ChatPanelSlot({
  api,
  onSidebarDock,
  layoutStore,
}: ChatPanelSlotProps): ReactElement {
  const { layout, setMode, reset } = useChatLayout(layoutStore);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // -- M5-I state: the two cursor-style modes + the card-dismissal cursors ----
  const [inlineOpen, setInlineOpen] = useState(false);
  const [inlineFocusSeq, setInlineFocusSeq] = useState(0);
  const [agentMode, setAgentMode] = useState(false);
  const [clarifyDismissedId, setClarifyDismissedId] = useState<string | null>(null);
  const [errorDismissedId, setErrorDismissedId] = useState<string | null>(null);

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

  /**
   * §4.4 seed seam: hand the composer a seeded DRAFT. Cancelable — a
   * draft-capable composer claims the event with preventDefault(); until
   * that listener exists (M4-G seam, integrator note) the unclaimed seed
   * rides the M4-pinned quick-action send path instead. Both routes are
   * chat-only: neither can mutate the editor.
   */
  const seedComposer = useCallback(
    (prompt: string): void => {
      const seed = new CustomEvent<string>(CHAT_SEED_COMPOSER_EVENT, {
        detail: prompt,
        cancelable: true,
      });
      window.dispatchEvent(seed);
      if (!seed.defaultPrevented) {
        window.dispatchEvent(new CustomEvent(CHAT_QUICK_ACTION_EVENT, { detail: prompt }));
      }
      focusComposer();
    },
    [focusComposer],
  );

  /** Open the inline bar (§4.2) — idempotent: a re-trigger only re-focuses. */
  const openInlineEdit = useCallback((): void => {
    setAgentMode(false); // one focused entry at a time (§4.2 takes over §4.3)
    setInlineFocusSeq((seq) => seq + 1);
    setInlineOpen(true);
  }, []);

  /** Close the inline bar and hand focus back to the composer (§9.2). */
  const closeInlineEdit = useCallback((): void => {
    setInlineOpen(false);
    focusComposer();
  }, [focusComposer]);

  /**
   * §4.2 submit: the message is tagged `inlineEdit: true` through the chat
   * seam (see ./inline-edit.tsx — M5-F widens ChatSendInput to carry it).
   */
  const submitInlineEdit = useCallback(
    (input: InlineEditSubmit): void => {
      setInlineOpen(false);
      api.send(input);
      focusComposer();
    },
    [api, focusComposer],
  );

  // -- host-side shortcut publishing (D-5) ------------------------------------
  // The bridge seam (use-editor-session) forwards Cmd/Ctrl+K/I from INSIDE
  // the iframe; keypresses on the parent document never cross that seam, so
  // the slot publishes them onto the SAME bus itself. Bound ONLY here: the
  // slot mounts only inside the editor host, keeping every other route's
  // Cmd/Ctrl+K free for the command palette (D-5).
  const shortcutBus = api.shortcutBus;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "k" && key !== "i") return;
      event.preventDefault();
      shortcutBus.publish(key === "k" ? "inlineEdit" : "agent", event.key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutBus]);

  // -- derived render state ----------------------------------------------------
  const { snapshot } = api;
  const streaming = LIVE_RUN_PHASES.has(snapshot.phase);
  const collapsed = layout.mode === "collapsed";
  const messages = snapshot.messages;
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;

  // §4.4: the composer-row chips are the "after a selection" surface.
  const selectionNames = selectionNamesOf(api.context);
  const quickActionChips = buildQuickActions(api.flags.selection, selectionNames);

  // §8.6 clarify: the NEWEST assistant plan that is a clarify question.
  const clarifyVisible =
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    lastMessage.plan !== undefined &&
    lastMessage.plan.intent === "clarify" &&
    lastMessage.id !== clarifyDismissedId;
  const clarifyPlan: EditPlan | null = clarifyVisible ? (lastMessage?.plan ?? null) : null;

  // §6.4 error card: the newest failed tool card on the thread's last message.
  const failedCard = lastFailedToolCard(lastMessage);
  const failedShape = failedCard === null ? null : seamSixFailure(failedCard.result);
  const failureVisible =
    failedShape !== null &&
    failedCard !== null &&
    failedCard.toolCallId !== errorDismissedId &&
    !clarifyVisible; // one question at a time above the composer
  const failureRetryable = snapshot.phase === "failed";

  // §4.2 scope: the current selection, else the active comp.
  const inlineScope =
    selectionNames !== null && selectionNames.length > 0
      ? selectionNames.join(", ")
      : contextDataName(api.context, "activeComp");

  const composerDisabled = useMemo(() => {
    if (snapshot.error?.code === "INSUFFICIENT_CREDITS") {
      // §3.4: the composer disables with a clear message; the peer's Upgrade
      // affordance stays reachable (never a silent dead input).
      return { reason: "credits" as const, message: snapshot.error.message };
    }
    if (snapshot.error?.code === "MODEL_NOT_ENTITLED") {
      return { reason: "plan" as const, message: snapshot.error.message };
    }
    return null;
  }, [snapshot.error]);

  // -- shortcut bus (M3.6/D-5) → layout + controller actions -----------------
  useEffect(() => {
    const handler = (event: ChatShortcutEvent): void => {
      // Layout-affecting shortcuts ride M4-E's deterministic mapping.
      const action = nextLayoutAction(layout, event.shortcut);
      if (action.type === "setMode") setMode(action.mode);

      switch (event.shortcut) {
        case "toggleChat":
          break; // fully handled by nextLayoutAction above
        case "agent": {
          // Cmd/Ctrl+I must reach a composer: expand when collapsed (the
          // action above), then raise agent mode + focus either way (§4.3).
          setAgentMode(true);
          focusComposer();
          break;
        }
        case "send":
          focusComposer();
          break;
        case "inlineEdit": {
          // D-5: inside the editor route Cmd/Ctrl+K opens the inline bar
          // (never the command palette); a collapsed chat expands first so
          // the bar lands next to its composer.
          if (layout.mode === "collapsed") setMode("floating");
          openInlineEdit();
          break;
        }
        case "undoAgentRun":
          showNotice("Undo arrives with M5.");
          break;
        case "newChat":
          api.newThread();
          setAgentMode(false); // a fresh thread starts unmoded
          break;
        case "stop":
          api.stop();
          break;
        case "escape": {
          // §9 escape order, topmost layer first: the inline bar, then the
          // context popover, then the composer-area transients (agent chip /
          // clarify card), then the panel itself.
          if (inlineOpen) {
            closeInlineEdit();
            break;
          }
          if (popoverOpen) {
            setPopoverOpen(false);
            break;
          }
          if (agentMode || clarifyVisible) {
            setAgentMode(false);
            if (lastMessage !== undefined) setClarifyDismissedId(lastMessage.id);
            break;
          }
          setMode("collapsed");
          break;
        }
      }
    };
    return api.shortcutBus.subscribe(handler);
  }, [
    api,
    layout,
    popoverOpen,
    setMode,
    focusComposer,
    showNotice,
    inlineOpen,
    agentMode,
    clarifyVisible,
    lastMessage,
    closeInlineEdit,
    openInlineEdit,
  ]);

  // Visibility gates the provider's 1 Hz inspect poll + context collects (§11).
  useEffect(() => {
    api.setPanelVisible(layout.mode !== "collapsed");
  }, [api, layout.mode]);

  // D-18: report the dock state/width so the HOST can resize the viewport.
  useEffect(() => {
    onSidebarDock(layout.mode === "sidebar", layout.w);
  }, [layout.mode, layout.w, onSidebarDock]);

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
      onCycleMode={() => {
        const action = nextLayoutAction(layout, "toggleChat");
        if (action.type === "setMode") setMode(action.mode);
      }}
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
      pinned={api.pinned}
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
      error={snapshot.error}
    />
  );

  // M5-I: the composer stack — the agent-UX chrome sits ABOVE the pinned M4
  // composer (§4.2/§4.3/§4.4/§6.4), inside the panel's composer area.
  const composer = (
    <div data-testid="chat-composer-stack" className="flex w-full flex-col gap-2 px-3 pb-2">
      {agentMode ? (
        <div
          data-testid="chat-agent-mode"
          className="flex w-full items-center gap-2 rounded-sm border border-signal/40 bg-elevated px-2.5 py-1.5"
        >
          <Badge variant="signal" data-testid="chat-agent-mode-badge">
            Agent mode
          </Badge>
          <p className="min-w-0 flex-1 truncate text-caption text-secondary">
            Describe the change — the agent shows a plan before it edits.
          </p>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Exit agent mode"
            data-testid="chat-agent-mode-exit"
            className="h-6 w-6 shrink-0 p-0 text-secondary hover:text-primary"
            onClick={() => setAgentMode(false)}
          >
            <X size={13} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {clarifyPlan !== null ? (
        <ClarifyCard
          plan={clarifyPlan}
          onAnswer={seedComposer}
          onDismiss={() => {
            if (lastMessage !== undefined) setClarifyDismissedId(lastMessage.id);
          }}
        />
      ) : null}

      {failureVisible && failedShape !== null ? (
        <EditErrorCard
          failure={failedShape}
          onRetry={failureRetryable ? api.retry : undefined}
          onDismiss={() => {
            if (failedCard !== null) setErrorDismissedId(failedCard.toolCallId);
          }}
        />
      ) : null}

      {composerDisabled === null && quickActionChips.length > 0 ? (
        <QuickActions actions={quickActionChips} onSeed={seedComposer} />
      ) : null}

      <InlineEditBar
        open={inlineOpen}
        scopeLabel={inlineScope}
        lockMessage={composerDisabled === null ? null : composerDisabled.message}
        focusSeq={inlineFocusSeq}
        onSubmit={submitInlineEdit}
        onClose={closeInlineEdit}
      />

      <ChatComposer
        streaming={streaming}
        disabled={composerDisabled}
        onSend={(message) => api.send({ message })}
        onStop={api.stop}
        creditHint={`${modelDisplayName(activeModel)} · ${formatTokenEstimate(contextTokens)}`}
      />
    </div>
  );

  const footer = (
    <ChatFooter
      modelLabel={modelDisplayName(activeModel)}
      creditEstimate={creditEstimate}
      shortcutHint="⌘↵ to send"
    />
  );

  // The popover anchors itself inside its mounting box (peer contract: an
  // anchor span at top-right, just under the header) — so the overlay box
  // mirrors the panel's geometry exactly: floating uses the panel's own
  // x/y/w/h, sidebar the docked right rail.
  const panelBoxStyle: CSSProperties =
    layout.mode === "sidebar"
      ? { position: "absolute", top: 0, right: 0, width: layout.w, height: "100%", zIndex: 20 }
      : {
          position: "absolute",
          top: layout.y,
          left: layout.x,
          width: layout.w,
          height: layout.h,
          zIndex: 20,
        };

  const removePinnedAtIndex = useCallback(
    (index: number): void => {
      const item = api.pinned[index];
      if (item !== undefined) api.removePinned(item);
    },
    [api],
  );

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
            onCycleMode={() => {
              const action = nextLayoutAction(layout, "toggleChat");
              if (action.type === "setMode") setMode(action.mode);
            }}
            onClose={() => setMode("collapsed")}
          />
        </div>
      )}

      {popoverOpen && !collapsed ? (
        <div
          className="pointer-events-auto"
          data-testid="chat-context-popover"
          style={panelBoxStyle}
        >
          <ContextPopover
            blocks={api.context?.blocks ?? []}
            totalTokenEstimate={api.context?.totalTokenEstimate ?? 0}
            pinned={api.pinned}
            onToggleBlock={(kind, on) => api.setFlag(kind, on)}
            onRemoveAll={api.clearOptionalBlocks}
            onRemovePinned={removePinnedAtIndex}
            onDone={() => setPopoverOpen(false)}
          />
        </div>
      ) : null}

      {noticeText !== null ? (
        collapsed ? (
          <output
            data-testid="chat-notice"
            style={{ position: "absolute", right: 72, top: "50%" }}
            className="pointer-events-none absolute rounded-sm border border-border bg-panel px-3 py-2 text-body text-primary shadow-pop"
          >
            {noticeText}
          </output>
        ) : (
          // Inside the panel's own box so the chip lands above the composer.
          <div className="pointer-events-none" style={panelBoxStyle} data-testid="chat-notice-box">
            <output
              data-testid="chat-notice"
              style={{
                position: "absolute",
                bottom: 88,
                left: "50%",
                transform: "translateX(-50%)",
                maxWidth: "100%",
              }}
              className="pointer-events-none absolute rounded-sm border border-border bg-panel px-3 py-2 text-body text-primary shadow-pop"
            >
              {noticeText}
            </output>
          </div>
        )
      ) : null}
    </div>
  );
}
