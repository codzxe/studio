"use client";

/**
 * ChatFirstStudio — the `/w/[slug]` studio route body: the product's
 * chat-first surface with an OPTIONAL engine.
 *
 * Architecture (one session, two faces):
 *
 *   ┌─ StudioModeBar ────────────────────────────────────────────────┐
 *   │ [☰] ← Dashboard {thread} [search][gear][model][+] [Chat ●|Engine] │
 *   ├────────────────────────────────────────────────────────────────┤
 *   │  mode === "engine" → the editor fills the surface              │
 *   │  mode === "chat"   → ChatSurface fills the surface, with the   │
 *   │    ChatGPT-style conversation rail on its left, while the      │
 *   │    editor runs LIVE but hidden beneath (opacity-0 +            │
 *   │    pointer-events-none + aria-hidden + inert) — the agent's    │
 *   │    tool bridge needs a real, booted engine; the user just      │
 *   │    never sees it.                                              │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The EditorHost is mounted ONCE (never per-mode): one wasm boot, one project
 * lease, one autosave — flipping modes is instant and the film the agent
 * built in chat mode is on the canvas the moment Engine opens. The chat layer
 * is OPAQUE (bg-page), so no editor pixel ever shows through in chat mode.
 *
 * Chat chrome wiring (the onApplyPorts pattern): ChatSurface reports a
 * `StudioChatHandle` (provider api + gestures + fresh-data seams) through
 * `onChatReady` and NULL on unmount; the mode bar renders the conversation
 * title, the model picker, search/settings/new-chat from it. `sidebarOpen`
 * is owned HERE so the mode-bar toggle and ⌘B share one source of truth.
 *
 * ChatGPT-class shell features mounted here (wave-2 fleet modules):
 * - **⌘K command palette** (`StudioCommandPalette`) — new chat, toggle
 *   sidebar, open engine, search, settings, shortcuts, export.
 * - **Settings popover** (`StudioSettingsPanel`) — density, timestamps,
 *   motion, auto-scroll; persisted per browser via the chat-first store.
 * - **Keyboard shortcuts help** (`StudioShortcutsModal`) — ⌘/ or palette.
 * - **Toast host** (`StudioToastHost`) — every guard/notice surfaces here.
 * - **Transcript export** (`studio-export`) — copy / download markdown.
 * - **Shortcuts**: ⌘K palette, ⌘B rail, ⌘⇧O new chat, ⌘/ help, ⌘. stop.
 */

import {
  Clapperboard,
  Copy,
  Download,
  Keyboard,
  MessageSquarePlus,
  PanelLeft,
  Search,
  Settings,
} from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import type { ChatApplyPorts } from "@/lib/chat/provider";

import { ChatSurface, type StudioChatHandle } from "@/components/chat-studio/chat-surface";
import {
  type PaletteCommand,
  StudioCommandPalette,
} from "@/components/chat-studio/studio-command-palette";
import {
  copyTranscript,
  downloadTranscript,
  transcriptToMarkdown,
} from "@/components/chat-studio/studio-export";
import { type StudioMode, StudioModeBar } from "@/components/chat-studio/studio-mode-bar";
import {
  StudioSettingsPanel,
  chatFirstSettingsStore,
  useChatFirstSettings,
} from "@/components/chat-studio/studio-settings-panel";
import { StudioShortcutsModal } from "@/components/chat-studio/studio-shortcuts-modal";
import { StudioToastHost, fireStudioToast } from "@/components/chat-studio/studio-toast";
import { ModelPicker } from "@/components/chat/model-picker";
import { EditorCapabilityGate } from "@/components/editor-host/capability-gate";
import { EditorHost } from "@/components/editor-host/editor-host";
import { createApiSession } from "@/components/editor-host/session-client";
import type { EditorHostPayload, EditorSessionFactory } from "@/components/editor-host/types";

export interface ChatFirstStudioProps {
  /** The RSC-resolved manifest slice (same shape the editor route gets). */
  readonly payload: EditorHostPayload;
  /** Test seams (mirrors EditorHostProps). */
  readonly sessionFactory?: (payload: EditorHostPayload) => EditorSessionFactory;
}

/** The export filename for the transcript download. */
function exportFilename(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug === "" ? "studio" : slug}-chat.md`;
}

export function ChatFirstStudio({ payload, sessionFactory }: ChatFirstStudioProps): ReactElement {
  // ONE session for both faces — created once, shared with the host.
  const [sessionHandle] = useState<EditorSessionFactory>(
    () => sessionFactory?.(payload) ?? createApiSession({ payload }),
  );
  // The host's session apply ports land here once the session hook returns
  // them — the chat provider needs them to APPLY + SAVE agent batches (the
  // exact wiring the editor's sidebar chat gets from the same hook).
  const [applyPorts, setApplyPorts] = useState<ChatApplyPorts | null>(null);
  // The chat face's handle (api + gestures + data seams) — reported by ChatSurface.
  const [chatHandle, setChatHandle] = useState<StudioChatHandle | null>(null);
  // The conversation rail: open by default on desktop, closed on mobile.
  const [mode, setMode] = useState<StudioMode>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Shell chrome: palette, settings popover, shortcuts help.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The settings store is a module singleton shared with the surface
  // (density reaches ChatThread through the surface's own read).
  const { settings, setSettings } = useChatFirstSettings(chatFirstSettingsStore);
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) setSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const projectName = payload.manifest.project.name;
  const projectSlug = payload.manifest.project.slug;

  // Chat-mode shortcuts (GPT parity). Engine mode never binds them — the
  // editor owns its own keys there.
  useEffect(() => {
    if (mode !== "chat") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;
      if (key === "b" && mod && !event.shiftKey) {
        event.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      if (key === "k" && mod && !event.shiftKey) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (key === "o" && mod && event.shiftKey) {
        event.preventDefault();
        chatHandle?.newChat();
        return;
      }
      if (key === "/" && mod) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (key === "." && mod) {
        event.preventDefault();
        chatHandle?.api.stop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, chatHandle]);

  const onNewChat = useCallback(() => chatHandle?.newChat(), [chatHandle]);

  // Transcript export (the palette's Export group + the toolbar's per-message
  // download rides the surface's own seam).
  const exportMarkdown = useCallback((): string => {
    const messages = chatHandle?.getMessages() ?? [];
    return transcriptToMarkdown(messages, {
      projectName,
      threadTitle: chatHandle?.api.threadTitle ?? null,
    });
  }, [chatHandle, projectName]);
  const onCopyTranscript = useCallback((): void => {
    void copyTranscript(exportMarkdown()).then((ok) => {
      // Honest feedback either way (the toast host renders it).
      fireStudioToast(
        ok ? "Transcript copied to your clipboard." : "Copy failed.",
        ok ? "success" : "danger",
      );
    });
  }, [exportMarkdown]);
  const onDownloadTranscript = useCallback((): void => {
    downloadTranscript(exportMarkdown(), exportFilename(projectName));
  }, [exportMarkdown, projectName]);

  // The ⌘K command set (rebuilt per render — the palette is a controlled
  // presentational component that renders null while closed).
  const paletteCommands: readonly PaletteCommand[] = [
    {
      id: "new-chat",
      label: "New chat",
      hint: "⌘⇧O",
      group: "Chat",
      icon: <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: () => chatHandle?.newChat(),
      disabled: chatHandle === null,
    },
    {
      id: "toggle-sidebar",
      label: "Toggle sidebar",
      hint: "⌘B",
      group: "Chat",
      icon: <PanelLeft size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: toggleSidebar,
    },
    {
      id: "open-engine",
      label: "Open Engine",
      group: "Navigate",
      icon: <Clapperboard size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: () => setMode("engine"),
    },
    {
      id: "search-conversation",
      label: "Search this conversation",
      group: "Navigate",
      icon: <Search size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: () => chatHandle?.openSearch(),
      disabled: chatHandle === null,
    },
    {
      id: "chat-settings",
      label: "Chat settings",
      group: "Settings",
      icon: <Settings size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: () => setSettingsOpen(true),
    },
    {
      id: "keyboard-shortcuts",
      label: "Keyboard shortcuts",
      hint: "⌘/",
      group: "Settings",
      icon: <Keyboard size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: () => setShortcutsOpen(true),
    },
    {
      id: "copy-transcript",
      label: "Copy transcript",
      group: "Export",
      icon: <Copy size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: onCopyTranscript,
      disabled: chatHandle === null || chatHandle.getMessages().length === 0,
    },
    {
      id: "download-transcript",
      label: "Download transcript (.md)",
      group: "Export",
      icon: <Download size={14} strokeWidth={1.75} aria-hidden="true" />,
      onSelect: onDownloadTranscript,
      disabled: chatHandle === null || chatHandle.getMessages().length === 0,
    },
  ];

  return (
    // Same viewport-ownership pattern as EditorHost (`fixed inset-0`): the
    // root layout gives no height chain, so the shell pins itself to the
    // viewport and the two faces split it.
    <div className="fixed inset-0 flex min-h-0 flex-col" data-testid="chat-first-studio">
      <StudioModeBar
        projectName={projectName}
        projectSlug={projectSlug}
        mode={mode}
        onModeChange={setMode}
        onToggleSidebar={toggleSidebar}
        threadTitle={chatHandle?.api.threadTitle ?? null}
        onNewChat={onNewChat}
        onOpenSearch={chatHandle !== null ? chatHandle.openSearch : undefined}
        onOpenSettings={() => setSettingsOpen((open) => !open)}
        modelPicker={
          chatHandle !== null ? (
            <ModelPicker
              models={chatHandle.api.models}
              activeModelId={chatHandle.api.activeModelId}
              onPick={chatHandle.api.setActiveModelId}
            />
          ) : undefined
        }
      />

      <div className="relative min-h-0 flex-1">
        {/* The engine face: mounted in BOTH modes; hidden (but live) in chat.
            `inert` keeps the hidden editor out of the a11y tree and focus
            order; opacity-0 keeps its WebGL canvas actually rendering.
            `transform-gpu` pins EditorHost's own `fixed inset-0` viewport
            claim to THIS layer (a transformed ancestor is the containing
            block for fixed descendants) — without it the editor escapes and
            covers the mode bar. `isolate` + `overflow-hidden` complete the
            containment. */}
        <div
          data-testid="studio-engine-layer"
          aria-hidden={mode === "chat"}
          inert={mode === "chat"}
          className={
            mode === "chat"
              ? "pointer-events-none absolute inset-0 transform-gpu isolate overflow-hidden opacity-0"
              : "absolute inset-0 transform-gpu isolate overflow-hidden"
          }
        >
          <EditorCapabilityGate slug={projectSlug} projectName={projectName}>
            <EditorHost
              payload={payload}
              sessionFactory={() => sessionHandle}
              onApplyPorts={setApplyPorts}
            />
          </EditorCapabilityGate>
        </div>

        {/* The chat face: opaque above the hidden engine. Unmounts (rather
            than hides) when Engine opens — its bridge/provider poll stops and
            the composer draft dies with it, which is exactly the chat-first
            contract: Engine mode has the editor's OWN docked sidebar chat.
            Sessions without an api-client (test fakes) mount no chat, the
            same rule the editor host applies. */}
        {mode === "chat" && sessionHandle.api !== undefined ? (
          <div data-testid="studio-chat-layer" className="mo-crossfade absolute inset-0 z-10">
            <ChatSurface
              payload={payload}
              client={sessionHandle.api}
              applyPorts={applyPorts}
              onOpenEngine={() => setMode("engine")}
              onChatReady={setChatHandle}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
            />
          </div>
        ) : null}

        {/* -- the shell chrome (chat face only) ---------------------------- */}
        {mode === "chat" ? (
          <>
            <StudioSettingsPanel
              open={settingsOpen}
              settings={settings}
              onChange={setSettings}
              onClose={() => setSettingsOpen(false)}
            />
            <StudioCommandPalette
              open={paletteOpen}
              onClose={() => setPaletteOpen(false)}
              commands={paletteCommands}
            />
            <StudioShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
          </>
        ) : null}
      </div>

      {/* The toast host: one mount for the whole shell (fires from the
          surface's live-run guards, the New-chat gesture, and palette
          actions — window-event decoupled, no prop threading). */}
      <StudioToastHost />
    </div>
  );
}
