"use client";

import { ChatProvider } from "@/lib/chat/provider";
import { Brand } from "@studio/config";
import { type EditorBridge, attachEditorBridge } from "@studio/editor-bridge";
import { useCallback, useEffect, useState } from "react";
import {
  BootFailureBanner,
  BootOverlay,
  ConflictBanner,
  LeaseWarningBanner,
  LoadFailedBanner,
  MissingAssetsBanner,
  ReadOnlyBanner,
  SaveErrorBanner,
  SavedChip,
} from "./banners";
import { ChatPanelSlot } from "./chat-panel-slot";
import { type ChatShortcutBus, editorChatShortcutBus } from "./chat-shortcut-bus";
import { ProjectBar } from "./project-bar";
import { createApiSession } from "./session-client";
import type { EditorHostPayload, EditorSessionFactory } from "./types";
import { useEditorSession } from "./use-editor-session";

/**
 * `EditorHost` — the editor page body (M3.5/M3.6/M3.7, BUILD_PLAN §M3 tasks
 * 3–7): a full-bleed same-origin iframe of the frozen editor dist
 * (`/editor/?empty` — the `?empty` flag skips the dist's local-session
 * restore), a CSS-only floating project bar, additive banners, and the save
 * trigger wiring. HARD RULES 7/12: no injected CSS, no editor restyle, no
 * persistent top nav, no presence — Share is a disabled M7 placeholder.
 *
 * The iframe URL keeps its trailing slash (`skipTrailingSlashRedirect`) so
 * every relative asset URL in the upstream dist resolves; COOP/COEP come from
 * `next.config.ts` headers. `allow` stays minimal (plain same-origin).
 */
export interface EditorHostProps {
  /** The RSC-resolved manifest slice (single fetch; no client re-fetch). */
  readonly payload: EditorHostPayload;
  /** Test seam for the session client + lease port. */
  readonly sessionFactory?: (payload: EditorHostPayload) => EditorSessionFactory;
  /** Test seam for the shortcut bus (default: the module singleton). */
  readonly shortcutBus?: ChatShortcutBus;
}

export function EditorHost({ payload, sessionFactory, shortcutBus }: EditorHostProps) {
  // M4-J: the host materializes the session ONCE (the hook previously built it
  // inside its own useState initializer) so the chat overlay can reach the
  // session's api client. Behavior is unchanged: exactly one session per page
  // load, the hook drives it, tests inject factories as before.
  const [sessionHandle] = useState<EditorSessionFactory>(
    () => sessionFactory?.(payload) ?? createApiSession({ payload }),
  );
  const session = useEditorSession({
    payload,
    sessionFactory: () => sessionHandle,
    shortcutBus,
  });
  const { state } = session;
  const projectName = payload.manifest.project.name;
  const bus = shortcutBus ?? editorChatShortcutBus;

  // ---------------------------------------------------------------------------
  // M4-J: the chat overlay over the editor (additive only — D-18). The host
  // attaches a SECOND bridge to the same booted iframe for the chat's
  // read-only queries (the M3 session bridge stays the load/save authority);
  // it exists only while the editor is open AND the session factory exposed
  // an api-client. Test sessions without `api` mount no chat layer at all.
  // ---------------------------------------------------------------------------
  const chatClient = sessionHandle.api;
  const [chatBridge, setChatBridge] = useState<EditorBridge | null>(null);
  // `session` (the hook's api object) is a fresh literal per render — NEVER a
  // dependency here (an unstable dep would dispose/re-attach the chat bridge
  // on every host re-render). The stable pieces are pinned instead.
  const chatIframeRef = session.iframeRef;
  useEffect(() => {
    if (state.phase !== "open" || chatClient === undefined) return;
    const iframe = chatIframeRef.current;
    if (iframe === null) return;
    let disposed = false;
    attachEditorBridge(iframe).then(
      (bridge) => {
        if (disposed) bridge.dispose();
        else setChatBridge(bridge);
      },
      () => {
        // Chat stays dormant when the handshake fails; the M3 session's own
        // bridge/ banners own the editor-open failure UX.
      },
    );
    return () => {
      disposed = true;
      setChatBridge((current) => {
        current?.dispose();
        return null;
      });
    };
  }, [state.phase, chatClient, chatIframeRef]);

  // D-18: sidebar mode "changes only the iframe width" — the viewport wrapper
  // resizes (never restyles) the editor; the iframe keeps its own classes.
  const [chatSidebar, setChatSidebar] = useState<{ docked: boolean; widthPx: number }>({
    docked: false,
    widthPx: 420,
  });
  const handleSidebarDock = useCallback((docked: boolean, widthPx: number): void => {
    setChatSidebar({ docked, widthPx: Math.round(widthPx) });
  }, []);

  const savedLabel =
    state.savedVersion === undefined
      ? null
      : state.savedVersion.label === null
        ? state.savedVersion.id
        : state.savedVersion.label;

  const bootFailed = state.boot === "failed";
  const loadFailed = state.phase === "load-failed";

  return (
    <main
      id="main"
      data-testid="editor-host"
      data-editor-phase={state.phase}
      data-editor-boot={state.boot}
      className="fixed inset-0 overflow-hidden bg-app"
    >
      {/* The editor: full-bleed, same-origin, restyled by NOBODY (rule 7).
          Keyed by bootAttempt so Retry remounts a fresh wasm boot.
          M4-J: the wrapper div carries the sidebar-mode width (D-18 — the
          editor only ever sees a viewport resize; its own styles are untouched). */}
      <div
        data-testid="editor-viewport"
        className="absolute inset-0"
        style={chatSidebar.docked ? { width: `calc(100% - ${chatSidebar.widthPx}px)` } : undefined}
      >
        <iframe
          key={session.bootAttempt}
          ref={session.iframeRef}
          src="/editor/?empty"
          title={`${Brand.productName} editor`}
          data-testid="editor-iframe"
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>

      {/* M3.5 chrome — floating, auto-hides via CSS (hover sliver / focus). */}
      <ProjectBar projectName={projectName} readOnly={state.readOnly} />

      {/* M4-J chat overlay — additive layer over the editor (D-18). The layer
          root swallows no editor clicks (pointer-events: none); the panel and
          the collapsed pill re-enable pointer events on their own subtrees. */}
      {chatBridge !== null && chatClient !== undefined ? (
        <div className="pointer-events-none absolute inset-0 z-30" data-testid="chat-layer">
          <ChatProvider
            client={chatClient}
            bridge={chatBridge}
            workspaceId={payload.workspaceId}
            projectId={payload.manifest.project.id}
            shortcutBus={bus}
          >
            {(api) => <ChatPanelSlot api={api} onSidebarDock={handleSidebarDock} />}
          </ChatProvider>
        </div>
      ) : null}

      {/* M3.7 boot UI (covers the iframe while the wasm boots / fails). */}
      {state.phase === "booting" && state.boot === "loading" ? (
        <BootOverlay projectName={projectName} />
      ) : null}
      {bootFailed && <BootFailureBanner bootError={state.bootError} onRetry={session.retryBoot} />}

      {/* Hard load failure (manifest/download/open) — reload is the remedy. */}
      {loadFailed && !bootFailed && (
        <LoadFailedBanner loadError={state.loadError} onReload={() => window.location.reload()} />
      )}

      {/* §9.3 read-only (lease refused) — non-blocking, the iframe stays usable. */}
      {state.phase === "open" && state.readOnly ? (
        <ReadOnlyBanner holderName={state.readOnlyHolder} />
      ) : null}

      {/* Permissive lease-warning fallback (still saving). */}
      {state.phase === "open" && state.leaseWarning && !state.conflict ? (
        <LeaseWarningBanner />
      ) : null}

      {/* 409 park (D-6/§9.3): blocking — never a silent overwrite. */}
      {state.conflict ? <ConflictBanner onReload={session.reloadServerVersion} /> : null}

      {/* M3.3: missing assets never block the open. */}
      {state.phase !== "load-failed" ? <MissingAssetsBanner missing={state.missingAssets} /> : null}

      {/* D-6 save feedback — transient, bottom-right. */}
      {state.saveError && !state.conflict ? <SaveErrorBanner /> : null}
      {!state.saveError && savedLabel !== null ? <SavedChip label={savedLabel} /> : null}
    </main>
  );
}
