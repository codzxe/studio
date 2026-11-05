"use client";

import { PresenceStrip } from "@/components/presence/presence-strip";
import { type PresenceBeatContext, usePresence } from "@/components/presence/use-presence";
import type { MentionItem } from "@/lib/chat/mentions";
import { type ChatApplyPorts, ChatProvider } from "@/lib/chat/provider";
import { activateGpuFallback } from "@/lib/editor-gpu-fallback";
import {
  type ReadOnlyGateHandle,
  createReadOnlyGate,
  wrapReadOnlyBridge,
} from "@/lib/editor-session";
import { type EditorWarmupSnapshot, editorWarmupSnapshot } from "@/lib/editor-warmup";
import { Brand } from "@studio/config";
import { type EditorBridge, attachEditorBridge } from "@studio/editor-bridge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BootFailureBanner,
  BootOverlay,
  ConflictBanner,
  DeviceLostOverlay,
  EditorOfflineBanner,
  GpuFallbackBanner,
  LeaseWarningBanner,
  LoadFailedBanner,
  MissingAssetsBanner,
  ReadOnlyBanner,
  SaveErrorBanner,
  SavedChip,
} from "./banners";
import { ChatPanelSlot } from "./chat-panel-slot";
import { type ChatShortcutBus, editorChatShortcutBus } from "./chat-shortcut-bus";
import { EditorTopBar } from "./editor-top-bar";
import { LeaseBanner } from "./lease-banner";
import { ProjectBar } from "./project-bar";
import { createApiSession } from "./session-client";
import type { EditorHostPayload, EditorSessionFactory } from "./types";
import { useEditorSession } from "./use-editor-session";

/**
 * `EditorHost` — the editor page body (M3.5/M3.6/M3.7, BUILD_PLAN §M3 tasks
 * 3–7): a full-bleed same-origin iframe of the frozen editor dist
 * (`/editor/?empty` — the `?empty` flag skips the dist's local-session
 * restore), additive banners, and the save trigger wiring. HARD RULES 7/12:
 * no injected CSS, no editor restyle — and, since w3-b05 (seamless app+editor
 * merge), a PERSISTENT host-side top bar (`EditorTopBar`) above the iframe:
 * the M3.5 "no top nav" line is superseded by the round-13 product ask
 * ("the editor and the app must feel like the same product — there must
 * always be a way back to the dashboard"), while the bar keeps the D-18
 * discipline: it lives OUTSIDE the iframe, and the editor surface below it
 * is only ever RESIZED (like the docked chat sidebar), never restyled. The
 * project bar's Share button is REAL (W4-KILL, audit REPLACE-2): it opens
 * the share dialog against the live share API (issue/list/revoke) whenever
 * a session api client exists.
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
  /**
   * Chat-first studio seam (round 16): hands the session's apply ports to the
   * page ONCE they exist, so the page's OWN ChatProvider (the full-page chat)
   * can apply + autosave agent batches exactly like the editor's sidebar
   * chat does. Without it the chat-first run ends "proposed" — compiled and
   * charged but never applied to the engine, never saved as a version.
   * The ports are a stable useMemo (the hook pins identity), so the effect
   * fires once per session.
   */
  readonly onApplyPorts?: (ports: ChatApplyPorts) => void;
}

export function EditorHost({
  payload,
  sessionFactory,
  shortcutBus,
  onApplyPorts,
}: EditorHostProps) {
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
  // Chat-first studio seam: publish the stable apply ports upward once.
  const onApplyPortsRef = useRef(onApplyPorts);
  onApplyPortsRef.current = onApplyPorts;
  useEffect(() => {
    onApplyPortsRef.current?.(session.applyPorts);
  }, [session.applyPorts]);
  const projectName = payload.manifest.project.name;
  const bus = shortcutBus ?? editorChatShortcutBus;

  // ---------------------------------------------------------------------------
  // Boot progress (the engine warm-up's parallel download + compile, started by
  // the capability gate): polled at the same cadence as the dist's own
  // `studioEngineLoad` boot poll while the boot overlay is up, so the overlay
  // can say WHERE the 49 MB engine is instead of a frozen "Preparing…".
  // ---------------------------------------------------------------------------
  const [warmup, setWarmup] = useState<EditorWarmupSnapshot>(() => editorWarmupSnapshot());
  useEffect(() => {
    if (state.phase !== "booting") return;
    const poll = setInterval(() => setWarmup(editorWarmupSnapshot()), 250);
    return () => clearInterval(poll);
  }, [state.phase]);

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

  // ---------------------------------------------------------------------------
  // M7-G collab chrome slot (BUILD_PLAN §M7 tasks 2–3) — presence + lease UX
  // as an ADDITIVE overlay over the frozen editor (D-18: nothing restyles,
  // injects into or occludes the editor chrome; every piece auto-hides).
  //
  // The read-only GATE is the M7 client enforcement point (D-23): the
  // lease banner feeds it from the lease-state poll, the M3 acquire verdict
  // feeds it below, and the CHAT layer's bridge is wrapped with it — so a
  // non-holder's mutating bridge calls (apply batches, engine.execute) die
  // locally with the typed LEASE_HELD outcome while chat reads/proposals
  // pass. The gateway's lease-guard stays authoritative.
  // ---------------------------------------------------------------------------
  const projectId = payload.manifest.project.id;
  const leaseGate = useRef<ReadOnlyGateHandle | null>(null);
  if (leaseGate.current === null) leaseGate.current = createReadOnlyGate();

  // The M3 acquire verdict is a second (authoritative) gate writer: a
  // refused acquire blocks mutations immediately, before the first
  // lease-state poll lands.
  const m3ReadOnly = state.readOnly;
  const m3Holder = state.readOnlyHolder ?? null;
  useEffect(() => {
    leaseGate.current?.update(m3ReadOnly, m3Holder);
  }, [m3ReadOnly, m3Holder]);

  const chatBridgeRef = useRef<EditorBridge | null>(chatBridge);
  chatBridgeRef.current = chatBridge;

  // Beat context (§M7 task 2): my active comp as its NAME (project.summary
  // lookup, falling back to the raw id) — read fresh per beat; playheadTicks
  // stays unreported until the engine's tick unit is pinned (worklog note).
  const presenceContext = useCallback(async (): Promise<PresenceBeatContext | undefined> => {
    const bridge = chatBridgeRef.current;
    if (bridge === null) return undefined;
    try {
      const inspect = await bridge.inspect();
      const activeComp = inspect.activeComp ?? null;
      if (activeComp === null) return undefined;
      const summary = await bridge.query<{ items?: unknown }>("project.summary", {});
      const items = Array.isArray(summary?.items) ? summary.items : [];
      const match = items.find(
        (item): item is { id: number; name: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { id?: unknown }).id === activeComp &&
          typeof (item as { name?: unknown }).name === "string",
      );
      return { compId: match?.name ?? String(activeComp) };
    } catch {
      return undefined; // a context failure never fails the heartbeat
    }
  }, []);

  const presence = usePresence({
    client: chatClient ?? null,
    projectId,
    enabled: state.phase === "open",
    getContext: presenceContext,
  });

  // The chat layer rides the GATE-WRAPPED bridge (stable identity: the gate
  // is read at call time, so the wrapper flips with the lease, not a remount).
  const gateView = leaseGate.current.gate;
  const gatedChatBridge = useMemo(
    () => (chatBridge === null ? null : wrapReadOnlyBridge(chatBridge, gateView)),
    [chatBridge, gateView],
  );

  // ROUND 12 (Chat UI v3): the @-mention canvas getter — ONE read-only
  // `comp.info` per call (bounded ≤80 layer rows); any failure/absence
  // degrades to [] (the composer then falls back to the context snapshot's
  // names — never a broken popup).
  const getCanvasLayers = useCallback(async (): Promise<readonly MentionItem[]> => {
    if (gatedChatBridge === null) return [];
    try {
      const info = await gatedChatBridge.query<Record<string, unknown> | null>("comp.info", {});
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
          items.push({
            id: `layer:${typeof record.id === "number" ? record.id : record.name}`,
            label: record.name,
            kind: "layer",
          });
        }
      }
      return items;
    } catch {
      return [];
    }
  }, [gatedChatBridge]);

  // True while the M7 lease banner shows ANY chrome — the host then hides
  // the M3 read-only banner (same verdict, strictly more information).
  const [leaseBannerActive, setLeaseBannerActive] = useState(false);

  // After a banner Acquire, nudge the M3 session's lease check so the session
  // adopts the lease immediately (it owns the autosave controller). The M3
  // hook's only re-check seams are its 2-minute beat and window focus — this
  // dispatch hits that focus seam (a documented additive bridge; the M3 hook
  // should eventually expose a first-class recheck — worklog finding).
  const adoptLeaseInSession = useCallback((): void => {
    window.dispatchEvent(new Event("focus"));
  }, []);

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
      className="fixed inset-0 flex flex-col overflow-hidden bg-app"
    >
      {/* w3-b05 — the persistent SaaS-brand bar (host chrome, never editor
          chrome): product mark, project › Editor breadcrumb and the way back
          to the dashboard, on the shell TopBar's exact token pattern so the
          editor reads as the same product as /w. Everything below it (the
          iframe AND every overlay) anchors to the editor surface, so boot
          screens and recovery overlays can never hide the way out. */}
      <EditorTopBar projectName={projectName} projectSlug={payload.manifest.project.slug} />

      {/* The editor surface: everything the iframe and its floating chrome
          occupy — bounded below the persistent bar, so the editor only ever
          sees a viewport resize (D-18). */}
      <div data-testid="editor-surface" className="relative min-h-0 flex-1">
        {/* The editor: full-bleed, same-origin, restyled by NOBODY (rule 7).
            Keyed by bootAttempt so Retry remounts a fresh wasm boot.
            M4-J: the wrapper div carries the sidebar-mode width (D-18 — the
            editor only ever sees a viewport resize; its own styles are untouched).
            M3 tail 6: `src` comes from the session hook — the plain `/editor/?empty`
            boot, or the WebGL2 compatibility boot while the GPU circuit breaker
            is armed (a lost device this tab session); stable per page load. */}
        <div
          data-testid="editor-viewport"
          className="absolute inset-0"
          style={
            chatSidebar.docked ? { width: `calc(100% - ${chatSidebar.widthPx}px)` } : undefined
          }
        >
          <iframe
            key={session.bootAttempt}
            ref={session.iframeRef}
            src={session.iframeSrc}
            title={`${Brand.productName} editor`}
            data-testid="editor-iframe"
            className="absolute inset-0 h-full w-full border-0"
          />
        </div>

        {/* M3.5 chrome — floating, auto-hides via CSS (hover sliver / focus).
            W4-KILL: Share is live — the dialog mounts whenever a session api
            client exists (test sessions without one keep the bar chrome-only). */}
        <ProjectBar
          projectName={projectName}
          readOnly={state.readOnly}
          share={chatClient === undefined ? null : { projectId, client: chatClient }}
        />

        {/* M4-J chat overlay — additive layer over the editor (D-18). The layer
            root swallows no editor clicks (pointer-events: none); the panel and
            the collapsed pill re-enable pointer events on their own subtrees.
            M7-G: the chat rides the GATE-WRAPPED bridge (read-only enforcement
            lands in its execute/batch seams; reads + proposals pass — D-23). */}
        {gatedChatBridge !== null && chatClient !== undefined ? (
          <div className="pointer-events-none absolute inset-0 z-30" data-testid="chat-layer">
            <ChatProvider
              client={chatClient}
              bridge={gatedChatBridge}
              workspaceId={payload.workspaceId}
              projectId={projectId}
              shortcutBus={bus}
              applyPorts={session.applyPorts}
            >
              {(api) => (
                <ChatPanelSlot
                  api={api}
                  onSidebarDock={handleSidebarDock}
                  client={chatClient}
                  projectId={projectId}
                  getCanvasLayers={getCanvasLayers}
                />
              )}
            </ChatProvider>
          </div>
        ) : null}

        {/* M7-G presence strip (§M7 task 2): who-is-viewing avatars, driven by
            the shared heartbeat poller — additive floating chrome, auto-hidden
            while nobody beats. */}
        {state.phase === "open" && chatClient !== undefined ? (
          <PresenceStrip viewers={presence.viewers} />
        ) : null}

        {/* M7-G lease banner (§M7 task 3): the "Alex is editing" state matrix,
            request queue + expiry takeover; also drives the read-only gate.
            Mounted only when a real api client exists (test sessions without
            one keep the M3 chrome exactly as-is). */}
        {state.phase === "open" && chatClient !== undefined ? (
          <LeaseBanner
            client={chatClient}
            projectId={projectId}
            gate={leaseGate.current}
            onActiveChange={setLeaseBannerActive}
            onAcquired={adoptLeaseInSession}
          />
        ) : null}

        {/* M3.7 boot UI (covers the editor surface while the wasm boots/fails). */}
        {state.phase === "booting" && state.boot === "loading" ? (
          <BootOverlay projectName={projectName} warmup={warmup} />
        ) : null}
        {bootFailed && (
          <BootFailureBanner
            bootError={state.bootError}
            onRetry={session.retryBoot}
            compatibilityModeActive={session.gpuFallback}
            onCompatibilityMode={
              session.gpuFallback
                ? undefined
                : () => {
                    // The GPU-class escape hatch: the probes should have caught
                    // the broken-adapter classes BEFORE the boot, but when a
                    // machine slips through (a new driver-bug class, a device
                    // that dies between probe and boot), arm the proven WebGL2
                    // compatibility mode and reload — the iframe src is read
                    // once per page load, so the reload is what re-routes it.
                    activateGpuFallback();
                    window.location.reload();
                  }
            }
          />
        )}

        {/* Hard load failure (manifest/download/open) — reload is the remedy. */}
        {loadFailed && !bootFailed && (
          <LoadFailedBanner loadError={state.loadError} onReload={() => window.location.reload()} />
        )}

        {/* Graphics device lost (the dist's studio:deviceLost report): the
            recovery owns the surface — save now, then reload onto a fresh
            device; the buttons appear only when the save can't land in time. */}
        {state.deviceLost !== undefined ? (
          <DeviceLostOverlay
            deviceLost={state.deviceLost}
            onRetry={session.retryDeviceLostSave}
            onReload={session.reloadAfterDeviceLost}
          />
        ) : null}

        {/* M3 tail 6 — GPU compatibility mode (WebGL2 + CPU workers) after a
            device loss this tab session: says WHY the editor runs slower, and
            offers the way back to WebGPU after a driver update. Dismissable. */}
        {state.phase === "open" && session.gpuFallback ? (
          <GpuFallbackBanner onTryWebGpu={session.retryWebGpu} />
        ) : null}

        {/* §9.3 read-only (lease refused) — non-blocking, the iframe stays usable.
            M7-G: while the richer lease banner shows its own read-only strip,
            this M3 banner is suppressed (same verdict, more information). */}
        {state.phase === "open" && state.readOnly && !leaseBannerActive ? (
          <ReadOnlyBanner holderName={state.readOnlyHolder} />
        ) : null}

        {/* Permissive lease-warning fallback (still saving). */}
        {state.phase === "open" && state.leaseWarning && !state.conflict ? (
          <LeaseWarningBanner />
        ) : null}

        {/* 409 park (D-6/§9.3): blocking — never a silent overwrite. */}
        {state.conflict ? <ConflictBanner onReload={session.reloadServerVersion} /> : null}

        {/* M3.3: missing assets never block the open. */}
        {state.phase !== "load-failed" ? (
          <MissingAssetsBanner missing={state.missingAssets} />
        ) : null}

        {/* §8.11 offline (W5-06) — the editor route's own arm (no shell here):
            honest about the last saved version + the autosave retry, null while
            online so the editor UI is unchanged. */}
        <EditorOfflineBanner />

        {/* D-6 save feedback — transient, bottom-right. */}
        {state.saveError && !state.conflict ? <SaveErrorBanner /> : null}
        {!state.saveError && savedLabel !== null ? <SavedChip label={savedLabel} /> : null}
      </div>
    </main>
  );
}
