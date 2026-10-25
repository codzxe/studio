import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatApplyPorts } from "@/lib/chat/provider";
import {
  type AutosaveController,
  type MissingAsset,
  type SaveOutcome,
  type VersionRef,
  createAutosaveController,
  loadProjectSession,
  safeFileStem,
} from "@/lib/editor-session";
import {
  type EditorBridge,
  type EditorLoadStatus,
  attachEditorBridge,
  editorLoadState,
  forwardShortcut,
} from "@studio/editor-bridge";
import { type ChatShortcutBus, editorChatShortcutBus } from "./chat-shortcut-bus";
import { createApiSession } from "./session-client";
import type { EditorHostPayload, EditorSessionFactory } from "./types";

/**
 * `useEditorSession` — the M3 host orchestration (BUILD_PLAN §M3 tasks 3–7):
 *
 * 1. Boot (M3.7): poll `editorLoadState` for the loading UI; attach the
 *    bridge once per iframe instance; a failed wasm boot (or an attach
 *    rejection — `EDITOR_LOAD_FAILED`/`EDITOR_NOT_READY`) renders the retry
 *    banner. The ONLY retry is reloading the iframe: a fresh element, a
 *    fresh wasm boot, a new bridge attach.
 * 2. Load (M3.3): `loadProjectSession` once the bridge reports ready;
 *    missing assets land in a NON-blocking banner.
 * 3. Autosave (M3.4, DECISIONS.md D-6): the controller is created ONLY when
 *    the single-writer lease is ours — a refused acquire means read-only: no
 *    controller exists, so nothing ever uploads. The controller owns the 30 s
 *    cadence, single-flight, retries, sha dedup and the terminal 409 park;
 *    the hooks below only RENDER.
 * 4. Lease (§9.3/§11): acquire on mount, renew on a 2-minute heartbeat and
 *    on window focus (acquire = renew), best-effort release on unmount. The
 *    §11 TTL is the backstop for missed beats.
 * 5. Save triggers (D-6): Cmd/Ctrl+S on the page (keypresses inside the
 *    iframe never reach this listener — the editor keeps its own shortcuts),
 *    before-close on pagehide/visibilitychange:hidden, an unsaved-changes
 *    guard on beforeunload, plus the M4 agent-apply call site.
 * 6. Shortcuts (M3.6, D-5): the bridge's `forwardShortcut` seam forwards
 *    Cmd/Ctrl+L/K/I (and friends) from inside the iframe onto the chat
 *    shortcut bus; M4's chat consumes them. Inside the editor route
 *    Cmd/Ctrl+K means inline edit (D-5) — the bus records it for now.
 */

/** §11: renew the lease every 2 minutes while the tab is open. */
const LEASE_HEARTBEAT_MS = 120_000;
/** Boot-UI poll of the dist's `effectcraftLoad` (the M3.7 seam — not a DOM poll). */
const BOOT_POLL_MS = 250;
/** How long the "Saved" chip stays up (ms). */
const SAVED_CHIP_MS = 4000;

export type EditorPhase = "booting" | "loading-project" | "open" | "load-failed";

export interface EditorSessionState {
  readonly phase: EditorPhase;
  /** The editor wasm boot phase (`editorLoadState`). */
  readonly boot: EditorLoadStatus;
  /** The dist's own error string when the wasm failed to boot. */
  readonly bootError?: string;
  /** Why the project could not be opened (engine error, safe to show). */
  readonly loadError?: string;
  readonly missingAssets: readonly MissingAsset[];
  /** Another editor holds the lease — saves are suspended (§9.3). */
  readonly readOnly: boolean;
  /** Display name of the lease holder when read-only. */
  readonly readOnlyHolder?: string;
  /** The lease check failed — permissive fallback with a warning banner. */
  readonly leaseWarning: boolean;
  /** 409 conflict park: the project changed on the server (never overwritten). */
  readonly conflict: boolean;
  /** Last save attempt failed — autosave retries; copy stays non-alarming. */
  readonly saveError: boolean;
  /** Last successful save (transient "Saved" chip). */
  readonly savedVersion?: VersionRef;
}

export interface UseEditorSessionOptions {
  /** The RSC-resolved manifest payload (workspace + project + version). */
  readonly payload: EditorHostPayload;
  /** Test seam; production builds the api-client-backed session. */
  readonly sessionFactory?: (payload: EditorHostPayload) => EditorSessionFactory;
  /** Test seam for the shortcut bus (default: the module singleton). */
  readonly shortcutBus?: ChatShortcutBus;
}

export interface EditorSessionApi {
  readonly state: EditorSessionState;
  readonly iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** The iframe mount key — `retryBoot` bumps it to remount a fresh wasm boot. */
  readonly bootAttempt: number;
  /** Bumping this remounts the iframe — the wasm boot retry (M3.7). */
  readonly retryBoot: () => void;
  /** "Load server version" after a conflict — a full page reload re-runs RSC. */
  readonly reloadServerVersion: () => void;
  /**
   * The M5 apply-session ports (K-1 fix): the ChatProvider builds the real
   * ApplyController from these — `saveNow("agent-apply")` uploads the
   * applied version (D-6) and `currentVersionId()` drives the reapply-drift
   * gate (M5.5). Conservative when the autosave controller is absent
   * (read-only/parked sessions): `saveNow` resolves `{saved:false}` and the
   * gate reports `null` — apply then fails safely at the gateway.
   */
  readonly applyPorts: ChatApplyPorts;
}

const INITIAL_STATE: EditorSessionState = {
  phase: "booting",
  boot: "loading",
  missingAssets: [],
  readOnly: false,
  leaseWarning: false,
  conflict: false,
  saveError: false,
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useEditorSession(options: UseEditorSessionOptions): EditorSessionApi {
  const { payload } = options;

  // One session per page load (the payload never changes); tests inject fakes.
  const [session] = useState<EditorSessionFactory>(
    () => options.sessionFactory?.(payload) ?? createApiSession({ payload }),
  );

  const [state, setState] = useState<EditorSessionState>(INITIAL_STATE);
  const [bootAttempt, setBootAttempt] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<EditorBridge | null>(null);
  const autosaveRef = useRef<AutosaveController | null>(null);
  const leaseRef = useRef(session.leases);
  const sessionIdRef = useRef<string | null>(null);
  if (sessionIdRef.current === null) {
    // §11: the lease session id — acquire = renew while it stays the same.
    sessionIdRef.current = crypto.randomUUID();
  }
  const shortcutBusRef = useRef(options.shortcutBus ?? editorChatShortcutBus);
  const savedChipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patchState = useCallback((patch: Partial<EditorSessionState>) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);

  const clearSavedChip = useCallback(() => {
    if (savedChipTimerRef.current !== null) {
      clearTimeout(savedChipTimerRef.current);
      savedChipTimerRef.current = null;
    }
  }, []);

  /** Create the autosave controller — at most once per editor open, only while we hold the lease. */
  const ensureAutosave = useCallback(
    (bridge: EditorBridge): void => {
      if (autosaveRef.current !== null) return;
      autosaveRef.current = createAutosaveController({
        bridge,
        client: session.client,
        projectId: payload.manifest.project.id,
        baseVersion: payload.manifest.currentVersion,
        // A fresh project has no file-table name yet — mirror the load flow's
        // stem so the first save (root upload) lands under a recognizable name.
        defaultSaveName: `${safeFileStem(
          payload.manifest.project.slug || payload.manifest.project.id,
        )}.ecproj`,
        hooks: {
          onSaved: (version) => {
            clearSavedChip();
            patchState({ savedVersion: version, saveError: false });
            // Transient chip (D-6): "Saved · label" clears after 4 s.
            savedChipTimerRef.current = setTimeout(() => {
              setState((current) =>
                current.savedVersion?.id === version.id
                  ? { ...current, savedVersion: undefined }
                  : current,
              );
              savedChipTimerRef.current = null;
            }, SAVED_CHIP_MS);
          },
          onConflict: () => {
            // The controller parked itself terminally (never silent
            // overwrite); recovery is the server version via full reload.
            clearSavedChip();
            patchState({ conflict: true });
          },
          onError: () => {
            patchState({ saveError: true });
          },
        },
      });
    },
    [
      clearSavedChip,
      patchState,
      payload.manifest.currentVersion,
      payload.manifest.project.id,
      payload.manifest.project.slug,
      session,
    ],
  );

  const suspendSaving = useCallback((): void => {
    autosaveRef.current?.dispose();
    autosaveRef.current = null;
  }, []);

  // ---------------------------------------------------------------------------
  // Boot + load + lease, once per iframe instance
  // ---------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootAttempt is the intentional remount trigger (the iframe key)
  useEffect(() => {
    let cancelled = false;
    let bootSettled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let detachShortcuts: (() => void) | null = null;

    const settleBoot = (patch: Partial<EditorSessionState>): void => {
      if (cancelled || bootSettled) return;
      bootSettled = true;
      if (poll !== null) {
        clearInterval(poll);
        poll = null;
      }
      patchState(patch);
    };

    // M3.7 boot UI: surface the dist's failure flag as soon as it appears.
    poll = setInterval(() => {
      const iframe = iframeRef.current;
      if (iframe === null) return;
      const loadState = editorLoadState(iframe);
      if (loadState.status === "failed") {
        settleBoot({ boot: "failed", bootError: loadState.error, phase: "load-failed" });
      }
    }, BOOT_POLL_MS);

    (async (): Promise<void> => {
      const iframe = iframeRef.current;
      if (iframe === null) return;

      let bridge: EditorBridge;
      try {
        bridge = await attachEditorBridge(iframe);
      } catch (error) {
        // EDITOR_LOAD_FAILED ("editor failed to start: …") or EDITOR_NOT_READY
        // (handshake timeout) — the iframe reload is the only retry (M3.7).
        settleBoot({ boot: "failed", bootError: messageOf(error), phase: "load-failed" });
        return;
      }
      if (cancelled) {
        bridge.dispose();
        return;
      }
      bridgeRef.current = bridge;
      settleBoot({ boot: "ready", phase: "loading-project" });

      // M3.6 (D-5): forward the chat shortcuts from inside the iframe onto
      // the bus. Handled events are prevented inside the iframe (the editor
      // never sees Cmd/Ctrl+L/K/I); M4's chat subscribes to the bus.
      detachShortcuts = forwardShortcut(iframe, {
        toggleChat: (event) => shortcutBusRef.current.publish("toggleChat", event.key),
        inlineEdit: (event) => shortcutBusRef.current.publish("inlineEdit", event.key),
        agent: (event) => shortcutBusRef.current.publish("agent", event.key),
        newChat: (event) => shortcutBusRef.current.publish("newChat", event.key),
        undoAgentRun: (event) => shortcutBusRef.current.publish("undoAgentRun", event.key),
        stop: (event) => shortcutBusRef.current.publish("stop", event.key),
        escape: (event) => shortcutBusRef.current.publish("escape", event.key),
        send: (event) => shortcutBusRef.current.publish("send", event.key),
      });

      // Load (M3.3) and the lease check (§9.3) run in parallel.
      const sessionId = sessionIdRef.current ?? "";
      const leasePromise = leaseRef.current
        .acquire(sessionId)
        .then((outcome) => ({ ok: true as const, outcome }))
        .catch((error: unknown) => ({ ok: false as const, error }));

      try {
        const outcome = await loadProjectSession({
          bridge,
          client: session.client,
          projectId: payload.manifest.project.id,
        });
        if (!cancelled) patchState({ missingAssets: outcome.missingAssets });
      } catch (error) {
        // Non-blocking asset failures never land here; this is a hard load
        // failure (manifest/download/open) — full reload is the remedy.
        if (!cancelled) patchState({ phase: "load-failed", loadError: messageOf(error) });
        return;
      }

      const lease = await leasePromise;
      if (cancelled) return;
      if (lease.ok) {
        if (!lease.outcome.acquired || lease.outcome.readOnly) {
          // Refused acquire: viewer mode. No controller is created, so no
          // save ever uploads; the iframe itself stays interactive (§9.3).
          suspendSaving();
          patchState({ readOnly: true, readOnlyHolder: lease.outcome.holderName, phase: "open" });
        } else {
          ensureAutosave(bridge);
          patchState({ readOnly: false, readOnlyHolder: undefined, phase: "open" });
        }
      } else {
        // Lease check failed (e.g. a network blip): permissive fallback —
        // create the controller so the user's work still saves; the banner
        // explains the risk. A later successful beat clears the warning.
        ensureAutosave(bridge);
        patchState({ leaseWarning: true, phase: "open" });
      }
    })().catch(() => {
      settleBoot({ boot: "failed", bootError: "The editor session could not start." });
    });

    return () => {
      cancelled = true;
      if (poll !== null) clearInterval(poll);
      detachShortcuts?.();
      suspendSaving();
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      // Best-effort lease release; the §11 TTL is the backstop.
      void leaseRef.current.release();
    };
  }, [
    bootAttempt,
    ensureAutosave,
    patchState,
    payload.manifest.project.id,
    session,
    suspendSaving,
  ]);

  // ---------------------------------------------------------------------------
  // Lease heartbeat (§11: 2-minute renew) + focus re-check
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (state.phase !== "open") return;
    const sessionId = sessionIdRef.current ?? "";
    let beating = true;

    const check = async (): Promise<void> => {
      const bridge = bridgeRef.current;
      if (bridge === null) return;
      try {
        const outcome = await leaseRef.current.acquire(sessionId);
        if (!beating) return;
        if (outcome.acquired && !outcome.readOnly) {
          // Holding (renewed) — or a read-only tab just gained the lease.
          ensureAutosave(bridge);
          patchState({
            readOnly: false,
            readOnlyHolder: undefined,
            leaseWarning: false,
          });
        } else {
          // Lost the lease (expiry race with another editor): suspend
          // immediately — never overwrite their versions.
          suspendSaving();
          patchState({ readOnly: true, readOnlyHolder: outcome.holderName });
        }
      } catch {
        // Transient: the §11 TTL (5 min) outlives one missed beat.
      }
    };

    const heartbeat = setInterval(() => void check(), LEASE_HEARTBEAT_MS);
    const onFocus = (): void => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      beating = false;
      clearInterval(heartbeat);
      window.removeEventListener("focus", onFocus);
    };
  }, [ensureAutosave, patchState, state.phase, suspendSaving]);

  // ---------------------------------------------------------------------------
  // Save triggers (D-6) + the unsaved-changes guard (M3.7)
  // ---------------------------------------------------------------------------
  const saveNow = useCallback((reason: "manual" | "before-close" | "agent-apply"): void => {
    const controller = autosaveRef.current;
    if (controller === null) return; // read-only/parked: nothing to upload
    void controller.saveNow(reason);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Page-level only: keypresses inside the iframe never reach this
      // listener, so the editor keeps its own Cmd/Ctrl+S behaviour.
      if (event.key.toLowerCase() !== "s") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      saveNow("manual");
    };
    const onPageHide = (): void => {
      // Fire-and-forget: the engine's single-flight makes this safe even mid-save.
      saveNow("before-close");
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") saveNow("before-close");
    };
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // `dirty` is the controller's cached view as of the last tick — a
      // best-effort unsaved-changes guard (M3.7).
      if (autosaveRef.current?.dirty === true) {
        event.preventDefault();
        // Legacy requirement for the browser confirmation dialog.
        event.returnValue = "";
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [saveNow]);

  // Clear the pending chip timer on unmount.
  useEffect(() => clearSavedChip, [clearSavedChip]);

  const retryBoot = useCallback((): void => {
    // Fresh iframe element → fresh wasm boot + a new bridge attach (M3.7).
    suspendSaving();
    setState(INITIAL_STATE);
    setBootAttempt((attempt) => attempt + 1);
  }, [suspendSaving]);

  const reloadServerVersion = useCallback((): void => {
    // Conflict recovery (D-6/§9.3): a full page reload re-runs the RSC fetch —
    // the server's current manifest becomes the new base version.
    window.location.reload();
  }, []);

  // K-1: referentially-stable apply ports for the ChatProvider (the provider
  // builds the real ApplyController from these; the autosaveRef indirection
  // means read-only sessions degrade conservatively without remounting).
  // `null` manifestVersionId = a fresh project (no version yet); the first
  // save advances the autosave head and the gate reads the new id from there.
  const manifestVersionId = payload.manifest.currentVersion?.id ?? null;
  const applyPorts = useMemo<ChatApplyPorts>(
    () => ({
      autosave: {
        saveNow: (reason: string): Promise<SaveOutcome> => {
          const controller = autosaveRef.current;
          if (controller === null) {
            return Promise.resolve({ saved: false } satisfies SaveOutcome);
          }
          return controller.saveNow(reason);
        },
        markDirty: (reason?: string): void => {
          autosaveRef.current?.markDirty(reason);
        },
      },
      session: {
        currentVersionId: (): string | null =>
          autosaveRef.current?.currentVersion()?.id ?? manifestVersionId,
      },
    }),
    [manifestVersionId],
  );

  return {
    state,
    iframeRef,
    bootAttempt,
    retryBoot,
    reloadServerVersion,
    applyPorts,
  };
}
