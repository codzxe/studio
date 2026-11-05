"use client";

/**
 * ChatSurface — the chat-first studio's MAIN surface: a full-page,
 * ChatGPT-style conversation with the motion-graphics agent. Visual direction:
 * the PauseVFX dark-warm look (deep warm background, a soft orange horizon
 * glow, an Instrument-Serif italic accent in the hero) — the product reads as
 * "a chat that makes films", not "an editor with a chat panel".
 *
 * Key property (the user's ask): **no engine is visible here**. The editor
 * iframe mounts live but HIDDEN underneath (see ChatFirstStudio) — the agent's
 * tool bridge still needs a real engine to execute against — while this
 * surface owns the whole viewport. `onOpenEngine` flips the mode bar to the
 * full editor; the session stays mounted, so nothing re-boots and the built
 * film is simply THERE.
 *
 * ChatGPT-class overhaul (this file):
 * - **Conversation rail** (`ChatSidebar`): New chat, search, date-grouped
 *   thread list, Open-Engine foot. Static rail on `md+` (the shell reserves
 *   the column), off-canvas drawer below — one `sidebarOpen` boolean drives
 *   both, owned by the shell so the mode-bar toggle and ⌘B share it.
 * - **History on reload** — `useThreadHistory` adopts the newest thread once
 *   per mount and reconstructs its transcript (read-only cards; plans never
 *   resurrect actionable) — the exact wiring the editor slot uses.
 * - **Per-message affordances** — Retry AND Edit-and-resend are wired
 *   (live-run guarded), plus the thread's scroll-to-bottom pill.
 * - **@-mentions** — the canvas getter (ONE read-only comp.info per call)
 *   feeds the composer's mention popover; refreshed on thread adoption.
 * - **Model picker** — rides the mode bar through the `onChatReady` handle
 *   (the same hand-off pattern as `onApplyPorts`).
 * - **Hero** — the PauseVFX landing pattern with a 2×2 suggestion grid.
 */

import type { ApiClient } from "@studio/api-client";
import { type EditorBridge, attachEditorBridge } from "@studio/editor-bridge";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatSidebar } from "@/components/chat-studio/chat-sidebar";
import { downloadTranscript, transcriptToMarkdown } from "@/components/chat-studio/studio-export";
import { StudioMessageToolbar } from "@/components/chat-studio/studio-message-toolbar";
import {
  chatFirstSettingsStore,
  useChatFirstSettings,
} from "@/components/chat-studio/studio-settings-panel";
import { StudioThreadSearch, findMatches } from "@/components/chat-studio/studio-thread-search";
import { fireStudioToast } from "@/components/chat-studio/studio-toast";
import { StudioWelcome } from "@/components/chat-studio/studio-welcome";
import { ChatComposer } from "@/components/chat/composer";
import { ClarifyCard, EditErrorCard } from "@/components/chat/edit-cards";
import { modelDisplayName } from "@/components/chat/header";
import { ModelPicker } from "@/components/chat/model-picker";
import { RunProgressStrip, deriveRunProgress } from "@/components/chat/progress-strip";
import { CHAT_SEED_COMPOSER_EVENT } from "@/components/chat/quick-actions";
import { ChatThread } from "@/components/chat/thread";
import { editorChatShortcutBus } from "@/components/editor-host/chat-shortcut-bus";
import type { EditorHostPayload } from "@/components/editor-host/types";
import type { MentionItem } from "@/lib/chat/mentions";
import { type ChatApplyPorts, type ChatContextApi, ChatProvider } from "@/lib/chat/provider";
import { LIVE_RUN_PHASES } from "@/lib/chat/run-state";
import type { ChatUiMessage } from "@/lib/chat/types";
import { threadHistorySeamsFromClient, useThreadHistory } from "@/lib/chat/use-thread-history";
import { Film, Palette, Repeat, Sparkles } from "lucide-react";

export interface ChatSurfaceProps {
  readonly payload: EditorHostPayload;
  /** The session api-client (carries x-workspace-id) — the chat's wire. */
  readonly client: ApiClient;
  /**
   * The session's apply ports (EditorHost's onApplyPorts hand-off). REQUIRED
   * for a real build: without them the run's compiled batch stays "proposed"
   * — never applied to the engine, never saved as a version. Undefined only
   * in the first instants before the host publishes them (the composer is
   * usable before then; a send from that window is applied by nothing).
   */
  readonly applyPorts?: ChatApplyPorts | null;
  /** Mode-bar callback: flip to the full editor (the session is shared). */
  readonly onOpenEngine: () => void;
  /**
   * The chat handle hand-off (the onApplyPorts pattern): the surface reports
   * its provider api + the New-chat gesture once, and NULL on unmount — the
   * shell renders the mode-bar chrome (title, model picker, new chat) from it.
   */
  readonly onChatReady?: (handle: StudioChatHandle | null) => void;
  /** The rail's visibility (shell-owned so ⌘B and the toggle share it). */
  readonly sidebarOpen?: boolean;
  readonly onToggleSidebar?: () => void;
}

/** What the shell receives from `onChatReady`. */
export interface StudioChatHandle {
  readonly api: ChatContextApi;
  /** New chat = provider reset + thread-list refresh (the slot's gesture). */
  readonly newChat: () => void;
  /** The FULL merged transcript (history + live), always fresh via ref. */
  readonly getMessages: () => readonly ChatUiMessage[];
  readonly projectName: string;
  /** Opens the in-conversation search bar (mode-bar/palette chrome). */
  readonly openSearch: () => void;
}

const FULL_FILM_PROMPT =
  "Make a 10-second motion-graphics film: one continuous scene, a title, keyframed reveals and a glowing accent.";
const RESTYLE_PROMPT =
  "Restyle every layer: add glow, a gradient-ramp background and soft blur for depth.";
const ANIMATE_PROMPT =
  "Animate the current composition: keyframe scale, position and opacity so it plays as a loop.";
const EXPLAIN_PROMPT = "Explain what this composition does and how it is built.";

/** Hero suggestion cards — the ChatGPT grid, PauseVFX flavored. */
const SUGGESTIONS: readonly {
  readonly icon: typeof Film;
  readonly title: string;
  readonly detail: string;
  readonly prompt: string;
  readonly testid: string;
}[] = [
  {
    icon: Film,
    title: "Make a film",
    detail: "A 10-second launch film with a title and keyframed reveals",
    prompt: FULL_FILM_PROMPT,
    testid: "studio-starter-film",
  },
  {
    icon: Palette,
    title: "Restyle everything",
    detail: "Glow, gradient ramps and soft depth on every layer",
    prompt: RESTYLE_PROMPT,
    testid: "studio-starter-restyle",
  },
  {
    icon: Repeat,
    title: "Loop it",
    detail: "Keyframe scale, position and opacity into a clean loop",
    prompt: ANIMATE_PROMPT,
    testid: "studio-starter-loop",
  },
  {
    icon: Sparkles,
    title: "Explain the build",
    detail: "What this composition does and how it is constructed",
    prompt: EXPLAIN_PROMPT,
    testid: "studio-starter-explain",
  },
];

/** Seeds the composer with an editable draft (the composer claims the event). */
function seedComposer(prompt: string): void {
  window.dispatchEvent(new CustomEvent(CHAT_SEED_COMPOSER_EVENT, { detail: prompt }));
}

// ---------------------------------------------------------------------------
// The bridge attach loop: the engine iframe lives inside the (hidden) editor
// host and takes ~10s to boot the wasm. Poll for the element, then let
// attachEditorBridge's 60s ready window ride out the boot; retry on failure
// until the deadline. The chat stays on the styled "waking" state until the
// handshake lands.
// ---------------------------------------------------------------------------

const BRIDGE_ATTACH_DEADLINE_MS = 120_000;
const BRIDGE_ATTACH_POLL_MS = 2_500;

interface EngineBridgeState {
  readonly phase: "waiting" | "ready" | "failed";
  readonly bridge: EditorBridge | null;
}

function useEngineBridge(): EngineBridgeState {
  const [state, setState] = useState<EngineBridgeState>({ phase: "waiting", bridge: null });
  useEffect(() => {
    let disposed = false;
    let current: EditorBridge | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + BRIDGE_ATTACH_DEADLINE_MS;

    const attempt = async (): Promise<void> => {
      if (disposed) return;
      const iframe = document.querySelector<HTMLIFrameElement>('[data-testid="editor-iframe"]');
      if (iframe === null) {
        if (Date.now() < deadline) timer = setTimeout(attempt, BRIDGE_ATTACH_POLL_MS);
        else setState({ phase: "failed", bridge: null });
        return;
      }
      try {
        const bridge = await attachEditorBridge(iframe);
        if (disposed) {
          bridge.dispose();
          return;
        }
        current = bridge;
        setState({ phase: "ready", bridge });
      } catch {
        if (Date.now() < deadline) timer = setTimeout(attempt, BRIDGE_ATTACH_POLL_MS);
        else setState({ phase: "failed", bridge: null });
      }
    };
    timer = setTimeout(attempt, BRIDGE_ATTACH_POLL_MS);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      current?.dispose();
    };
  }, []);
  return state;
}

/** The styled hand-off state while the hidden engine boots. */
function EngineWaiting({ failed }: { readonly failed: boolean }): ReactElement {
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-page px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 horizon-glow"
      />
      <p className="font-display text-display-m text-primary" data-testid="studio-engine-waiting">
        {failed ? "The engine could not wake up" : "Waking the engine…"}
      </p>
      <p className="mt-2 max-w-md text-center text-body-s text-secondary">
        {failed
          ? "The motion engine did not become ready in time. Reload the page to try again."
          : "One moment — the motion engine boots in the background so the agent can build your film."}
      </p>
    </div>
  );
}

export function ChatSurface({
  payload,
  client,
  applyPorts,
  onOpenEngine,
  onChatReady,
  sidebarOpen = true,
  onToggleSidebar,
}: ChatSurfaceProps): ReactElement {
  const { phase, bridge } = useEngineBridge();
  const bridgeRef = useRef<EditorBridge | null>(null);
  bridgeRef.current = bridge;

  // The @-mention canvas getter (ROUND 12 seam) — ONE read-only comp.info per
  // call against MY bridge (the host's own getter rides ITS bridge); failure
  // degrades to [] exactly like the editor route.
  const getCanvasLayers = useCallback(async (): Promise<readonly MentionItem[]> => {
    const current = bridgeRef.current;
    if (current === null) return [];
    try {
      const info = await current.query<Record<string, unknown> | null>("comp.info", {});
      if (info === null || typeof info !== "object") return [];
      const items: MentionItem[] = [];
      if (typeof info.name === "string" && info.name !== "") {
        items.push({ id: `comp:${info.name}`, label: info.name, kind: "comp" });
      }
      const layers = info.layers;
      if (Array.isArray(layers)) {
        for (const raw of layers) {
          if (items.length >= 80) break;
          if (typeof raw !== "object" || raw === null) continue;
          const record = raw as Record<string, unknown>;
          if (typeof record.name !== "string" || record.name === "") continue;
          items.push({ id: `layer:${record.name}`, label: record.name, kind: "layer" });
        }
      }
      return items;
    } catch {
      return [];
    }
  }, []);

  if (phase !== "ready" || bridge === null) {
    return <EngineWaiting failed={phase === "failed"} />;
  }

  return (
    <ChatProvider
      client={client}
      bridge={bridge}
      workspaceId={payload.workspaceId}
      projectId={payload.manifest.project.id}
      shortcutBus={editorChatShortcutBus}
      applyPorts={applyPorts ?? undefined}
    >
      {(api) => (
        <ChatStudioInner
          api={api}
          client={client}
          projectId={payload.manifest.project.id}
          projectName={payload.manifest.project.name}
          getCanvasLayers={getCanvasLayers}
          onOpenEngine={onOpenEngine}
          onChatReady={onChatReady}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={onToggleSidebar}
        />
      )}
    </ChatProvider>
  );
}

// ---------------------------------------------------------------------------
// The inner surface: provider api → PauseVFX-styled chat page with rail.
// ---------------------------------------------------------------------------

/** md breakpoint (matches Tailwind's default) for the rail/drawer switch. */
const MD_PX = 768;

function ChatStudioInner({
  api,
  client,
  projectId,
  projectName,
  getCanvasLayers,
  onOpenEngine,
  onChatReady,
  sidebarOpen,
  onToggleSidebar,
}: {
  api: ChatContextApi;
  client: ApiClient;
  projectId: string;
  projectName: string;
  getCanvasLayers: () => Promise<readonly MentionItem[]>;
  onOpenEngine: () => void;
  onChatReady?: (handle: StudioChatHandle | null) => void;
  sidebarOpen: boolean;
  onToggleSidebar?: () => void;
}): ReactElement {
  const snapshot = api.snapshot;
  const streaming = LIVE_RUN_PHASES.has(snapshot.phase);
  const progress = useMemo(() => deriveRunProgress(snapshot), [snapshot]);

  // §7 visibility: this surface IS the chat, so the provider's 1 Hz inspect
  // poll runs whenever we are mounted.
  useEffect(() => {
    api.setPanelVisible(true);
    return () => api.setPanelVisible(false);
  }, [api]);

  // -- the handle hand-off (api + gestures + fresh-data seams) ----------------
  const refreshThreadsRef = useRef<() => void>(() => {});
  const handleRef = useRef<StudioChatHandle | null>(null);
  // The merged transcript for the shell's export/palette commands — the ref
  // is assigned right after the messages memo below, so getMessages() is
  // always fresh without re-reporting the handle on every delta.
  const messagesRef = useRef<readonly ChatUiMessage[]>([]);
  // In-conversation search: the surface owns the query + open state (the
  // mode-bar button and the shell's palette both open it via the handle).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const openSearch = useCallback((): void => setSearchOpen(true), []);
  const startNewChat = useCallback((): void => {
    api.newThread();
    refreshThreadsRef.current();
    // The composer claims this event; an empty detail clears + refocuses it
    // (the New-chat gesture lands the user on a clean draft).
    window.dispatchEvent(new CustomEvent(CHAT_SEED_COMPOSER_EVENT, { detail: "" }));
    fireStudioToast("Started a new chat.", "info");
  }, [api]);
  const reportHandle = useCallback(
    (next: StudioChatHandle | null): void => {
      handleRef.current = next;
      onChatReady?.(next);
    },
    [onChatReady],
  );
  useEffect(() => {
    reportHandle({
      api,
      newChat: startNewChat,
      getMessages: () => messagesRef.current,
      projectName,
      openSearch,
    });
    return () => reportHandle(null);
  }, [api, reportHandle, startNewChat, projectName, openSearch]);

  // -- history on reload + the thread list (the slot's exact wiring) ---------
  const seams = useMemo(() => threadHistorySeamsFromClient(client), [client]);
  const { threads, threadsLoading, history, historyLoading, refreshThreads, adoptThread } =
    useThreadHistory({
      seams,
      projectId,
      threadId: api.threadId,
      liveMessageCount: snapshot.messages.length,
      onOpenThread: (threadId, title) => {
        api.openThread(threadId, title);
      },
    });
  refreshThreadsRef.current = refreshThreads;

  const messages = useMemo<readonly ChatUiMessage[]>(
    () => (history.length === 0 ? snapshot.messages : [...history, ...snapshot.messages]),
    [history, snapshot.messages],
  );
  messagesRef.current = messages;
  const empty = messages.length === 0;
  // An adopted thread still loading its transcript must NOT flash the hero.
  const showHero = empty && !historyLoading;

  // -- chat-first settings (density / motion knobs, this-browser persisted) --
  const { settings } = useChatFirstSettings(chatFirstSettingsStore);

  // -- search matches + jump (the bar itself mounts over the transcript) -----
  const searchMatches = useMemo(
    () => (searchOpen ? findMatches(messages, searchQuery) : []),
    [messages, searchQuery, searchOpen],
  );
  const jumpToMessage = useCallback((messageId: string): void => {
    const el = document.querySelector<HTMLElement>(`article[data-message-id="${messageId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  // -- @-mention candidates ---------------------------------------------------
  const [mentionItems, setMentionItems] = useState<readonly MentionItem[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: api.threadId is the deliberate refresh trigger (new thread ⇒ fresh canvas layers); the body reads only getCanvasLayers.
  useEffect(() => {
    let cancelled = false;
    void getCanvasLayers().then((items) => {
      if (!cancelled) setMentionItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, [getCanvasLayers, api.threadId]);

  // -- rail vs drawer (one boolean, two presentations) ------------------------
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MD_PX - 1}px)`);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // -- per-message re-send (Retry / Edit-and-resend), live-run guarded --------
  // Guards surface as toasts — the shell mounts the StudioToastHost once.
  const showNotice = useCallback((message: string): void => {
    fireStudioToast(message, "danger");
  }, []);

  const resendFrom = useCallback(
    (text: string): void => {
      if (text.trim() === "") return;
      if (LIVE_RUN_PHASES.has(api.snapshot.phase)) {
        showNotice("The agent is still working — stop it first.");
        return;
      }
      api.send({ message: text });
    },
    [api, showNotice],
  );
  const onRetryFrom = useCallback(
    (messageId: string): void => {
      const message = messages.find((entry) => entry.id === messageId);
      if (message !== undefined) resendFrom(message.text);
    },
    [messages, resendFrom],
  );
  const onEditResend = useCallback(
    (_messageId: string, nextText: string): void => {
      resendFrom(nextText);
    },
    [resendFrom],
  );

  // Chat-first: the assistant hover toolbar (copy / download / run chip).
  const renderAssistantToolbar = useCallback(
    (message: ChatUiMessage): ReactElement => (
      <StudioMessageToolbar
        text={message.text}
        runId={message.runId}
        onExportOne={(text) => {
          const markdown = transcriptToMarkdown(
            [{ id: message.id, role: "assistant", text, toolCards: [] }],
            { projectName, threadTitle: api.threadTitle },
          );
          downloadTranscript(markdown, "studio-message.md");
        }}
      />
    ),
    [api.threadTitle, projectName],
  );

  // §6.4 error card: the newest failed tool card on the thread's last message.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const failedCard = lastFailedToolCard(lastMessage);
  const failedShape = failedCard === null ? null : seamSixFailure(failedCard.result);
  const [errorDismissedId, setErrorDismissedId] = useState<string | null>(null);
  const failureVisible =
    failedShape !== null && failedCard !== null && failedCard.toolCallId !== errorDismissedId;
  const failureRetryable = snapshot.phase === "failed";

  // §8.6 clarify: the NEWEST assistant plan that is a clarify question.
  const clarifyVisible =
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    lastMessage.plan !== undefined &&
    lastMessage.plan.intent === "clarify";
  const [clarifyDismissedId, setClarifyDismissedId] = useState<string | null>(null);
  const clarifyPlan =
    clarifyVisible && lastMessage?.id !== clarifyDismissedId ? (lastMessage?.plan ?? null) : null;

  // The "Open in Engine" CTA: raise it once a run COMPLETES (the build just
  // happened in the hidden engine); the user dismisses it or flips modes.
  const [showEngineCta, setShowEngineCta] = useState(false);
  const phaseRef = useRef(snapshot.phase);
  useEffect(() => {
    const previous = phaseRef.current;
    phaseRef.current = snapshot.phase;
    if (previous !== snapshot.phase && snapshot.phase === "done") {
      setShowEngineCta(true);
    }
  }, [snapshot.phase]);

  const composerStack = (
    <div data-testid="studio-chat-composer-stack" className="mx-auto w-full max-w-3xl px-4 pb-3">
      {clarifyPlan !== null ? (
        <div className="mb-2">
          <ClarifyCard
            plan={clarifyPlan}
            onAnswer={seedComposer}
            onDismiss={() => {
              if (lastMessage !== undefined) setClarifyDismissedId(lastMessage.id);
            }}
          />
        </div>
      ) : null}
      {failureVisible && failedShape !== null ? (
        <div className="mb-2">
          <EditErrorCard
            failure={failedShape}
            onRetry={failureRetryable ? api.retry : undefined}
            onDismiss={() => {
              if (failedCard !== null) setErrorDismissedId(failedCard.toolCallId);
            }}
          />
        </div>
      ) : null}
      {showEngineCta ? (
        <div
          data-testid="studio-open-engine-cta"
          className="mb-2 flex items-center gap-3 rounded-md border border-signal/40 bg-elevated px-3 py-2"
        >
          <p className="min-w-0 flex-1 truncate text-caption text-secondary">
            The film just changed — it plays in the Engine.
          </p>
          <button
            type="button"
            onClick={onOpenEngine}
            className="flex h-7 shrink-0 items-center rounded-pill bg-signal px-3 text-label text-signal-ink duration-120 ease-out hover:bg-signal-hover"
          >
            Open Engine
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setShowEngineCta(false)}
            className="shrink-0 text-caption text-muted hover:text-primary"
          >
            ✕
          </button>
        </div>
      ) : null}
      <ChatComposer
        streaming={streaming}
        onSend={(message) => api.send({ message })}
        onStop={api.stop}
        onSlashCommand={(command) => {
          // The chat-first surface keeps the editor slot's local gestures:
          // /undo and /redo drive the apply controller when idle.
          if (LIVE_RUN_PHASES.has(snapshot.phase)) {
            showNotice("The agent is still working — stop it first.");
            return;
          }
          if (command === "undo" || command === "redo") {
            showNotice(
              command === "undo" ? "Nothing applied to undo here yet." : "Nothing to redo.",
            );
            return;
          }
          showNotice("That command is not available on this surface.");
        }}
        mentionItems={mentionItems}
        creditHint={modelDisplayName(api.activeModelId ?? "studio-fast")}
      />
      <div className="mt-2 px-1">
        <RunProgressStrip phase={snapshot.phase} chips={progress.chips} />
      </div>
      {historyLoading ? (
        <p data-testid="studio-history-loading" className="px-1 pt-1 text-caption text-muted">
          Loading conversation…
        </p>
      ) : null}
    </div>
  );

  const railVisible = sidebarOpen && !isMobile;
  const drawerVisible = sidebarOpen && isMobile;

  const sidebarNode = (
    <ChatSidebar
      threads={threads}
      activeThreadId={api.threadId}
      disabled={streaming}
      loading={threadsLoading}
      onOpenThread={adoptThread}
      onNewThread={startNewChat}
      onOpenEngine={onOpenEngine}
      onClose={onToggleSidebar}
      variant={isMobile ? "drawer" : "rail"}
    />
  );

  return (
    <div
      data-testid="studio-chat-page"
      className={`relative h-full overflow-hidden bg-page ${
        settings.reduceMotion ? "[&_*]:transition-none" : ""
      }`}
    >
      {/* The PauseVFX horizon: a soft orange glow rising from the bottom —
          decorative, behind everything, never interactive. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 horizon-glow"
      />

      <div className="relative flex h-full">
        {/* -- the rail (md+): a real layout column ------------------------- */}
        {railVisible ? (
          <aside
            data-testid="studio-sidebar-rail"
            className="hidden h-full w-[264px] shrink-0 border-r border-subtle md:block"
          >
            {sidebarNode}
          </aside>
        ) : null}

        {/* -- the drawer (<md): off-canvas over a backdrop ------------------ */}
        {drawerVisible ? (
          <div className="fixed inset-0 z-40 md:hidden" data-testid="studio-sidebar-drawer">
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={onToggleSidebar}
              className="absolute inset-0 h-full w-full cursor-default bg-black/50"
            />
            <div className="absolute inset-y-0 left-0">{sidebarNode}</div>
          </div>
        ) : null}

        {/* -- the main column ---------------------------------------------- */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {showHero ? (
            /* -------- HERO: the PauseVFX welcome (StudioWelcome) -------- */
            <div className="relative h-full overflow-y-auto">
              <StudioWelcome
                projectName={projectName}
                suggestions={SUGGESTIONS.map((suggestion) => {
                  const Icon = suggestion.icon;
                  return {
                    icon: (
                      <Icon
                        size={16}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className="text-signal"
                      />
                    ),
                    title: suggestion.title,
                    detail: suggestion.detail,
                    testid: suggestion.testid,
                  };
                })}
                onPickSuggestion={(testid) => {
                  const suggestion = SUGGESTIONS.find((entry) => entry.testid === testid);
                  if (suggestion !== undefined) seedComposer(suggestion.prompt);
                }}
                recentThreads={threads.slice(0, 3).map((thread) => ({
                  id: thread.id,
                  title:
                    thread.title !== null && thread.title !== "" ? thread.title : "Untitled chat",
                }))}
                onOpenThread={(threadId) => {
                  const thread = threads.find((entry) => entry.id === threadId);
                  if (thread !== undefined) adoptThread(thread.id, thread.title);
                }}
              >
                {composerStack}
              </StudioWelcome>
            </div>
          ) : (
            /* -------- CONVERSATION: the ChatGPT layout -------- */
            <div className="relative flex h-full flex-col">
              <div className="min-h-0 flex-1 px-4 pt-4">
                <div className="mx-auto h-full w-full max-w-3xl">
                  <ChatThread
                    messages={messages}
                    phase={snapshot.phase}
                    activeRunId={snapshot.activeRunId}
                    onRetry={api.retry}
                    emptyQuickActions={[]}
                    error={snapshot.error}
                    onRetryFrom={onRetryFrom}
                    onEditResend={onEditResend}
                    density={settings.density}
                    scrollButton
                    renderAssistantToolbar={renderAssistantToolbar}
                  />
                </div>
              </div>
              <div className="shrink-0 pt-2">{composerStack}</div>
            </div>
          )}

          {/* -- in-conversation search (mode bar / palette open it) --------- */}
          <StudioThreadSearch
            open={searchOpen}
            onClose={closeSearch}
            messageIds={searchMatches}
            onJump={jumpToMessage}
            onQueryChange={setSearchQuery}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared card derivations (mirrored from chat-panel-slot §6.4/§8.6 helpers).
// ---------------------------------------------------------------------------

/** The newest failed tool card of the thread's LAST message (else null). */
function lastFailedToolCard(
  message: ChatUiMessage | undefined,
): { toolCallId: string; result: unknown } | null {
  if (message === undefined || message.role !== "assistant") return null;
  for (let i = message.toolCards.length - 1; i >= 0; i -= 1) {
    const card = message.toolCards[i];
    if (card !== undefined && card.status === "failed") {
      return { toolCallId: card.toolCallId, result: card.result ?? null };
    }
  }
  return null;
}

/**
 * The §6.4 failure shape from a tool result — the chat-panel-slot's exact
 * mapper (a result is a failure only when it carries a string `error`), so
 * the EditErrorCard's curated code copy applies unchanged.
 */
function seamSixFailure(result: unknown): { code: string; message?: string } | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.error !== "string") return null;
  return {
    code: record.error,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}
