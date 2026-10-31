"use client";

/**
 * ChatProvider — the M4 page-integration wiring brain (M4-SEAMS.md Seam 7
 * "Integration (M4-J)"; EDITOR_CHAT_UX §5/§9/§11; PRODUCT_ARCHITECTURE §7.4).
 *
 * One client context owns everything the chat overlay needs, so the panel
 * slot (components/editor-host/chat-panel-slot.tsx) only composes wave-2 UI:
 *
 * - **Thread lifecycle (lazy)**: no thread exists until the first send. The
 *   first `send` starts ONE `client.threads.create(projectId)` (POST
 *   /v1/projects/:id/threads) and queues every input in a promise-queue; when
 *   the thread id resolves, the controller is created and the queue flushes in
 *   order. Later sends reuse the same thread. `newThread()` drops the id (and
 *   any unsent queue) — the next send lazily creates a fresh thread.
 * - **Controller**: `createChatController` (the ROUND-12 client-driven
 *   loop) per thread; the `ChatUiState` is surfaced through
 *   `useSyncExternalStore` so the render-prop re-renders on every fold.
 * - **Tool executor wiring (round 12)**: the loop executes read/generative
 *   tools INSIDE the chat controller — the provider only supplies the
 *   per-run factory around i5's `createClientToolExecutor`
 *   (live bridge + api-client + the run's id/context). Write tools never
 *   execute during the run (proposal carriers merge into the plan card).
 * - **Canvas snapshot (round 12)**: a compact `TurnCanvas` (active comp,
 *   ≤80 layer rows, selection, playhead, fps, duration) is rebuilt from
 *   `bridge.inspect()` + `comp.info` on the 1 Hz poll and right before
 *   every send; the controller includes it in turn bodies on step 0 and
 *   whenever its JSON hash changed since the last included turn.
 * - **Context orchestration**: effective flags = `autoFlags(latest inspect)`
 *   overlaid with the user's explicit popover overrides (removed auto-context
 *   STAYS removed, ECUX §3.2). A 1 Hz `bridge.inspect()` poll (§11) runs only
 *   while the panel is visible; `collectContextSnapshot` runs on demand — when
 *   the panel opens, when flags/pinned change and right before every send.
 * - **Models**: `client.models.list()` on mount (one retry, then `[]` per the
 *   wave-2 header contract: `null` = loading, `[]` = entitlement failure → the
 *   picker hides). The active model defaults to the first allowed model —
 *   UNLESS the user saved a default model in Settings (`studio.chat.model.v1`,
 *   the D-10 seam in lib/chat/default-model.ts, W5-03): a saved default that
 *   is still on-plan becomes the active model; an off-plan or absent save
 *   falls back to the first allowed model.
 * - **Quick actions**: the ONE window listener for M4-F/M4-G's
 *   `studio:chat-quick-action` CustomEvent lives HERE (not in the slot) so a
 *   single event can never double-dispatch and it works in every layout mode.
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY — the
 * one sanctioned exception is the chat controller's `mergeEditPlans` call
 * (the round-12 design pins that PURE contracts seam for the client's plan
 * merge); the only other runtime tool validation runs inside
 * `@studio/api-client/chat-tools` via the executor. No network besides the
 * api-client calls pinned above.
 */

import type { ChatShortcutBus } from "@/components/editor-host/chat-shortcut-bus";
import type { ApiClient, ModelsResponse } from "@studio/api-client";
import type { ContextSelection, ModelId, PinnedContextItem, TurnCanvas } from "@studio/contracts";
import type { EditorBridge, UiInspect } from "@studio/editor-bridge";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type ApplyAutosavePort,
  type ApplyController,
  type ApplyEngineEvent,
  type ApplySessionPort,
  createApplyController,
} from "./apply";
import { type ChatController, createChatController } from "./chat-controller";
import { type ContextSnapshot, DEFAULT_FLAGS, autoFlags, collectContextSnapshot } from "./context";
import { readDefaultModel } from "./default-model";
import { createInitialChatUiState } from "./run-state";
import { createClientToolExecutor } from "./tool-executor";
import type { ChatSendInput, ChatUiError, ChatUiState } from "./types";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The §8.2 wire item behind the model picker (structural twin of G2's `ModelsListEntry`). */
export type ChatModelSummary = ModelsResponse["models"][number];

/** A context flag key — exactly the `ContextSelection` keys (§5.1). */
export type ChatContextFlagKey = keyof ContextSelection;

/**
 * M5-Q (BUILD_PLAN §M5.4/§M5.5): the plan-card wiring surface the thread layer
 * consumes (thread.tsx reads it via `useContext` — null-tolerant so a
 * provider-less mount keeps rendering the read-only M4 card).
 */
export interface ChatPlanWiring {
  /** True when the session's ApplyController is constructed (ports wired). */
  readonly ready: boolean;
  /** The thread controller (apply/undo/reapply/dismissPlan/resolveCandidate). */
  readonly controller: ChatController | null;
  /** The stable bridge — M5-H's PlanPreview creates its throwaway controller from it. */
  readonly bridge: EditorBridge;
  /** The session's current version id (reapply-drift gate, §M5.5); null without a port. */
  readonly sessionVersionId: string | null;
}

/** Everything the panel slot (and any chat descendant) consumes. */
export interface ChatContextApi {
  /**
   * Null until the lazily-created thread exists (first send); the facade
   * methods below never need the controller directly.
   */
  readonly controller: ChatController | null;
  /** Live thread UI state (the initial idle state while no controller exists). */
  readonly snapshot: ChatUiState;
  /** `null` = still loading; `[]` = the entitlement fetch failed (picker hidden); else the plan's models. */
  readonly models: readonly ChatModelSummary[] | null;
  /** The id the next send uses; defaults to the first allowed model once models load. */
  readonly activeModelId: ModelId | null;
  /** The lazy thread's id; null before the first send (and after `newThread`). */
  readonly threadId: string | null;
  /** Header title: the thread's title, or "Agent" (ECUX §3.1). */
  readonly threadTitle: string;
  /** Thread-creation failures (the unsent queue is dropped); cleared by the next send/newThread. */
  readonly threadError: ChatUiError | null;
  /** Effective context flags (auto + user overrides, §5.1/§5.3). */
  readonly flags: ContextSelection;
  /** Latest collected context snapshot (blocks + estimates); null before the first on-demand collect. */
  readonly context: ContextSnapshot | null;
  /** The user's pinned chips (§5.2), sent with every message. */
  readonly pinned: readonly PinnedContextItem[];
  /** Whether the chat panel is visible (gates the 1 Hz inspect poll + collects). */
  readonly panelVisible: boolean;
  /** The editor-route shortcut bus (M3.6/D-5) the slot subscribes to. */
  readonly shortcutBus: ChatShortcutBus;

  /**
   * Send now (fresh context collect → thread/controller → wire). While a run
   * is live the engine queues it as a steer message (§3.4); before the lazy
   * thread exists it queues until the thread id resolves (promise-queue).
   */
  send(input: { readonly message: string; readonly model?: ModelId }): void;
  /** §8.3 stop via the engine's fused cancel. */
  stop(): void;
  /** Retry a failed/paused run through the engine. */
  retry(): void;
  /** Drop the current thread (and unsent queue); the next send creates a fresh one. */
  newThread(): void;
  /**
   * ROUND 12 (Chat UI v3): adopt an EXISTING thread (the switcher + the
   * reload auto-restore). Recreates the controller for it via the same
   * `[threadId]` effect that serves lazily-created threads — the only
   * wiring change the history/switcher feature needed here. History rows
   * are rendered by the PANEL layer (use-thread-history), never folded
   * into live state.
   */
  openThread(threadId: string, title?: string | null): void;
  /** Pick the active model for the next send. */
  setActiveModelId(id: ModelId): void;
  /** Toggle one context block; a user toggle sticks until they change it again (§3.2). */
  setFlag(kind: ChatContextFlagKey, on: boolean): void;
  /** Context popover "Remove all" — every currently-on block goes off. */
  clearOptionalBlocks(): void;
  addPinned(item: PinnedContextItem): void;
  removePinned(item: PinnedContextItem): void;
  /** The slot reports visibility per layout mode (collapsed = hidden). */
  setPanelVisible(visible: boolean): void;
  /** Re-collect the context snapshot on demand (never throws; last write wins). */
  refreshContext(): void;
  /** M5-Q: the plan-card wiring surface (see {@link ChatPlanWiring}); absent on
   *  read-only/legacy api shapes — the thread then renders the M4 card. */
  readonly planWiring?: ChatPlanWiring;
}

/**
 * The M5-Q apply-session ports the HOST PAGE passes (it owns the M3-B
 * autosave controller and the session's version pointer — see
 * `use-editor-session`). With these the provider constructs ONE
 * `ApplyController` per session (M5-F's `createApplyController`) wiring the
 * REAL bridge + REAL autosave (`saveNow("agent-apply")`, D-6) + the
 * api-client's `runs.applyRun`/`undoRun` + the reapply gate's version port.
 * Absent (the read-only embed) the plan cards stay callback-less — the M4.6
 * read-only property holds: no engine, no Apply control.
 *
 * Prefer a referentially STABLE object (a `useMemo`/module literal in the
 * host); identity churn is harmless (the controller is a stateless closure
 * over these ports) but stable ports keep the wiring object stable too.
 */
export interface ChatApplyPorts {
  /** The M3-B autosave controller (D-6: the apply moment is saveNow("agent-apply")). */
  readonly autosave: ApplyAutosavePort;
  /** The version pointer — the §M5.5 reapply-drift gate; conservative when absent. */
  readonly session?: ApplySessionPort;
  /** Apply/undo milestone notifications for the host (banners, telemetry). */
  readonly onEvent?: (event: ApplyEngineEvent) => void;
}

export interface ChatProviderProps {
  /** The live api-client (session-client's `createApiSession().api` — carries `x-workspace-id`). */
  readonly client: ApiClient;
  /** The editor bridge bound to the open editor (the host attaches it). */
  readonly bridge: EditorBridge;
  readonly workspaceId: string;
  readonly projectId: string;
  /** The M3 chat shortcut bus instance from the editor host. */
  readonly shortcutBus: ChatShortcutBus;
  /** The M5 apply-session ports (see {@link ChatApplyPorts}); omit for read-only embeds. */
  readonly applyPorts?: ChatApplyPorts;
  /** Render-prop: receives the api (no second context system needed). */
  readonly children: (api: ChatContextApi) => ReactNode;
}

// ---------------------------------------------------------------------------
// useSyncExternalStore plumbing for the pre-thread idle state
// ---------------------------------------------------------------------------

const IDLE_CHAT_STATE: ChatUiState = createInitialChatUiState();

const neverSubscribe = (): (() => void) => () => undefined;
const idleSnapshot = (): ChatUiState => IDLE_CHAT_STATE;

/** §11: poll `ui.inspect` at 1 Hz while the chat is open (4 Hz is the M5 budget target). */
const INSPECT_POLL_MS = 1000;

const THREAD_TITLE_FALLBACK = "Agent";

/** §8.6 canvas bounds mirror (contracts MAX_TURN_CANVAS_LAYERS = 80). */
const MAX_CANVAS_LAYERS = 80;

/**
 * ROUND 12: builds the compact turn canvas snapshot (TURN WIRE CONTRACT) —
 * `ui.inspect` for selection/playhead/fps + ONE `comp.info` query for the
 * active composition's name/duration and its top `MAX_CANVAS_LAYERS` layer
 * rows (`{id, name, type}`). Best-effort: ANY failure or a missing bridge
 * answer resolves `null` (the controller treats a null canvas as "nothing
 * changed" — never a send blocker). Pure apart from the bridge reads.
 */
async function buildCanvasSnapshot(
  bridge: EditorBridge,
  inspection?: UiInspect | null,
): Promise<TurnCanvas | null> {
  try {
    const [polled, info] = await Promise.all([
      inspection === undefined ? bridge.inspect().catch(() => null) : inspection,
      bridge.query<Record<string, unknown> | null>("comp.info", {}).catch(() => null),
    ]);
    if (info === null || typeof info !== "object") return null;
    const layers: TurnCanvas["layers"] = [];
    if (Array.isArray(info.layers)) {
      for (const raw of info.layers) {
        if (layers.length >= MAX_CANVAS_LAYERS) break;
        if (typeof raw !== "object" || raw === null) continue;
        const record = raw as Record<string, unknown>;
        if (typeof record.id !== "number" || typeof record.name !== "string") continue;
        layers.push({
          id: record.id,
          name: record.name,
          type: typeof record.type === "string" ? record.type : "",
        });
      }
    }
    const activeComp = typeof info.name === "string" && info.name !== "" ? info.name : undefined;
    return {
      ...(activeComp !== undefined ? { activeComp } : {}),
      layers,
      selection: polled?.selectedLayers ?? [],
      playhead: polled?.time ?? 0,
      fps: typeof info.frameRate === "number" ? info.frameRate : (polled?.fps ?? 30),
      duration: typeof info.duration === "number" ? info.duration : 0,
    };
  } catch {
    return null; // a failed canvas read never breaks the run (§5 doctrine)
  }
}

function toThreadError(error: unknown): ChatUiError {
  return {
    code: "THREAD_CREATE_FAILED",
    message:
      error instanceof Error && error.message !== ""
        ? error.message
        : "Could not start a new chat.",
    retryable: true,
  };
}

/**
 * The chat api context (M5-Q: exported so `ChatThread` can read the plan-card
 * wiring with a NULL-TOLERANT `useContext` — a provider-less mount (the M4
 * thread tests, storybook embeds) reads `null` and renders the read-only
 * card exactly as before).
 */
export const ChatApiContext = createContext<ChatContextApi | null>(null);

export function ChatProvider({
  client,
  bridge,
  workspaceId,
  projectId,
  shortcutBus,
  applyPorts,
  children,
}: ChatProviderProps): ReactNode {
  // -- thread lifecycle ------------------------------------------------------
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState<string>(THREAD_TITLE_FALLBACK);
  const [threadError, setThreadError] = useState<ChatUiError | null>(null);
  const [controller, setController] = useState<ChatController | null>(null);
  const pendingRef = useRef<ChatSendInput[]>([]);
  const controllerRef = useRef<ChatController | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const threadCreateRef = useRef<Promise<string> | null>(null);
  /** Bumped by newThread(): a create resolving for a dropped thread is ignored. */
  const threadGenerationRef = useRef(0);

  // -- models ----------------------------------------------------------------
  const [models, setModels] = useState<readonly ChatModelSummary[] | null>(null);
  const [activeModelId, setActiveModelId] = useState<ModelId | null>(null);

  // -- context (§5) -----------------------------------------------------------
  const [inspect, setInspect] = useState<UiInspect | null>(null);
  const [overrides, setOverrides] = useState<Partial<Record<ChatContextFlagKey, boolean>>>({});
  /** Effective flags — identity only changes when a VALUE changes (the 1 Hz poll recomputes, not re-renders). */
  const [flags, setFlags] = useState<ContextSelection>(DEFAULT_FLAGS);
  useEffect(() => {
    const merged: ContextSelection = { ...autoFlags(inspect), ...overrides };
    const changed = (Object.keys(merged) as ChatContextFlagKey[]).some(
      (key) => merged[key] !== flags[key],
    );
    if (changed) setFlags(merged);
  }, [inspect, overrides, flags]);

  const [pinned, setPinned] = useState<PinnedContextItem[]>([]);
  const [contextSnapshot, setContextSnapshot] = useState<ContextSnapshot | null>(null);
  const [panelVisible, setPanelVisibleState] = useState(false);
  /** Guards stale async collects: only the latest seq's result lands. */
  const collectSeqRef = useRef(0);

  // -- engine snapshot (re-renders the render-prop on every fold) --------------
  const snapshot = useSyncExternalStore(
    controller === null ? neverSubscribe : controller.subscribe,
    controller === null ? idleSnapshot : controller.getSnapshot,
  );

  // -- canvas snapshot (round 12): refreshed by the §11 poll + before every
  //    send; the controller reads it SYNCHRONOUSLY at each turn boundary
  //    (step 0 + hash change) through the stable `canvasSnapshot` closure.
  //
  const canvasRef = useRef<TurnCanvas | null>(null);

  // -- w8 live-apply: the user's auto-apply preference, fetched ONCE per
  //    session (GET /v1/me/settings) and cached in a ref — the controller
  //    reads it SYNCHRONOUSLY at every turn boundary through the stable
  //    closure. Unfetched/failed ⇒ undefined ⇒ the controller's default ON
  //    (the schema default: the agent works until the user opts out).
  const autoApplyRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    // Optional chaining: test fakes build partial clients (the real ApiClient
    // always has settings); a missing seam must never break the provider.
    void client.settings
      ?.get()
      .then((response) => {
        if (!cancelled) autoApplyRef.current = response.autoApplyEnabled;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  // -------------------------------------------------------------------------
  // M5-Q: ONE ApplyController per session (BUILD_PLAN §M5.4/§M5.5). Built
  // from the host's apply ports: the REAL bridge (ONE atomic engine.batch per
  // gesture), the REAL M3-B autosave controller (D-6's saveNow("agent-apply")),
  // the api-client's runs.applyRun/undoRun and the session's version pointer
  // (the §M5.5 reapply gate). Without ports (read-only embeds) the card never
  // grows an Apply control — the M4.6 property survives M5.
  // -------------------------------------------------------------------------
  const applyEngine = useMemo<ApplyController | null>(() => {
    if (applyPorts === undefined) return null;
    return createApplyController({
      bridge,
      autosave: applyPorts.autosave,
      // CROSS-SEAM ADAPTER (M5-Q finding, documented): M5-F's ApplyApiClient
      // pins `resolvedLayers[].layerId` as a NUMBER (engine layer ids), the
      // wire contract (contracts RESOLVED_LAYER_SCHEMA → ID_SCHEMA) and the
      // api-client pin a STRING — the adapter converts at this seam so the
      // gateway's strict body validation passes. Neither pinned file changes.
      api: {
        runs: {
          applyRun: (runId, body, options) =>
            client.runs.applyRun(
              runId,
              {
                batchSha256: body.batchSha256,
                versionId: body.versionId,
                idempotencyKey: body.idempotencyKey,
                ...(body.resolvedLayers !== undefined
                  ? {
                      resolvedLayers: body.resolvedLayers.map((entry) => ({
                        requestId: entry.requestId,
                        layerId: String(entry.layerId),
                      })),
                    }
                  : {}),
              },
              options,
            ),
          undoRun: (runId, body, options) => client.runs.undoRun(runId, body, options),
        },
      },
      ...(applyPorts.session !== undefined ? { session: applyPorts.session } : {}),
      ...(applyPorts.onEvent !== undefined ? { onEvent: applyPorts.onEvent } : {}),
    });
  }, [bridge, client, applyPorts]);
  /** Read at controller-creation time without churning the thread lifecycle. */
  const applyEngineRef = useRef<ApplyController | null>(null);
  applyEngineRef.current = applyEngine;
  /** The session's current version id — re-read on every provider render (§M5.5). */
  const sessionVersionId = applyPorts?.session?.currentVersionId() ?? null;

  // -------------------------------------------------------------------------
  // Models: fetch once, retry once, then `[]` (picker hidden per wave-2 header).
  // The first adoption honors the Settings-saved default (W5-03): a saved
  // model id that is on the plan becomes the active model; anything else
  // (absent, corrupt, off-plan) falls back to the first allowed model.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const adopt = (response: ModelsResponse): void => {
      if (cancelled) return;
      setModels(response.models);
      setActiveModelId((current) => {
        if (current !== null) return current;
        // The saved default wins only when it is still on the plan; the
        // matched row's id returns so the setter keeps the ModelId type.
        const saved = readDefaultModel();
        const match =
          saved === null ? undefined : response.models.find((model) => model.id === saved);
        return match !== undefined ? match.id : (response.models[0]?.id ?? null);
      });
    };
    void (async (): Promise<void> => {
      try {
        adopt(await client.models.list());
      } catch {
        try {
          adopt(await client.models.list());
        } catch {
          if (!cancelled) setModels([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // -------------------------------------------------------------------------
  // Lazy thread + controller (one per thread; the queue flushes on creation)
  // -------------------------------------------------------------------------
  const ensureThread = useCallback((): Promise<string> => {
    if (threadIdRef.current !== null) return Promise.resolve(threadIdRef.current);
    if (threadCreateRef.current !== null) return threadCreateRef.current;
    const generation = threadGenerationRef.current;
    const created = client.threads
      .create(projectId)
      .then((thread): string => {
        threadCreateRef.current = null;
        if (generation === threadGenerationRef.current) {
          threadIdRef.current = thread.id;
          setThreadId(thread.id);
          setThreadTitle(thread.title ?? THREAD_TITLE_FALLBACK);
        }
        return thread.id;
      })
      .catch((error: unknown) => {
        threadCreateRef.current = null;
        throw error;
      });
    threadCreateRef.current = created;
    return created;
  }, [client, projectId]);

  useEffect(() => {
    if (threadId === null) return;
    const engine = applyEngineRef.current;
    const created = createChatController({
      client,
      workspaceId,
      projectId,
      threadId,
      ...(engine !== null ? { apply: engine } : {}),
      // ROUND 12: the per-run client tool executor (read/generative tools
      // run LOCALLY in the loop; the factory gets the client-generated
      // runId + the run's context selection at send time).
      toolExecutor: (run) =>
        createClientToolExecutor({
          bridge,
          client,
          workspaceId,
          threadId,
          runId: run.runId,
          flags: run.context,
        }),
      // ROUND 12: the compact canvas snapshot — step 0 + hash change.
      canvasSnapshot: () => canvasRef.current,
      // w8 live-apply: the cached auto-apply preference (undefined ⇒ ON).
      autoApplyPref: () => autoApplyRef.current,
    });
    controllerRef.current = created;
    setController(created);
    // Promise-queue flush: every send that raced the thread creation goes out
    // in order now that a controller exists.
    const queued = pendingRef.current;
    pendingRef.current = [];
    for (const input of queued) created.send(input);
    return () => {
      controllerRef.current = null;
      created.dispose();
      setController(null);
    };
  }, [threadId, client, workspaceId, projectId, bridge]);

  const refreshContext = useCallback((): void => {
    const seq = ++collectSeqRef.current;
    void collectContextSnapshot(bridge, { flags, pinned }).then((collected) => {
      if (seq !== collectSeqRef.current) return; // a newer collect superseded this one
      setContextSnapshot(collected);
    });
  }, [bridge, flags, pinned]);

  const send = useCallback(
    (input: { message: string; model?: ModelId }): void => {
      const message = input.message.trim();
      if (message === "") return;
      const model: ModelId | undefined = input.model ?? activeModelId ?? undefined;
      setThreadError(null);
      void (async (): Promise<void> => {
        // Fresh context right before the wire send (§5): the strip/estimates
        // re-render with what is actually being sent; the flags ride the body.
        // Round 12: the canvas snapshot refreshes here too — the first turn
        // of the new run carries what the editor looks like NOW.
        const collected = await collectContextSnapshot(bridge, { flags, pinned });
        canvasRef.current = await buildCanvasSnapshot(bridge);
        collectSeqRef.current += 1; // supersede any in-flight on-demand collect
        setContextSnapshot(collected);
        const wire: ChatSendInput = {
          message,
          context: flags,
          pinned,
          ...(model === undefined ? {} : { model }),
        };
        const current = controllerRef.current;
        if (current !== null) {
          current.send(wire);
          return;
        }
        pendingRef.current.push(wire);
        void ensureThread().catch((error: unknown) => {
          // The queue is dead without a thread: surface + drop it.
          pendingRef.current = [];
          setThreadError(toThreadError(error));
        });
      })();
    },
    [activeModelId, bridge, ensureThread, flags, pinned],
  );

  const stop = useCallback((): void => {
    controllerRef.current?.stop();
  }, []);

  const retry = useCallback((): void => {
    controllerRef.current?.retry();
  }, []);

  const newThread = useCallback((): void => {
    threadGenerationRef.current += 1;
    threadCreateRef.current = null;
    threadIdRef.current = null;
    pendingRef.current = [];
    canvasRef.current = null;
    setThreadError(null);
    setThreadTitle(THREAD_TITLE_FALLBACK);
    setThreadId(null); // disposes the current controller via the effect cleanup
  }, []);

  /**
   * ROUND 12 (Chat UI v3): adopt an existing thread — the switcher and the
   * reload auto-restore call this. Mirrors `newThread`'s lifecycle guards
   * (drop any in-flight create + its queue) but lands ON the given id, so
   * the `[threadId]` effect recreates the controller for it.
   */
  const openThread = useCallback((id: string, title?: string | null): void => {
    if (id === "" || id === threadIdRef.current) return;
    threadGenerationRef.current += 1; // a create racing this is dropped
    threadCreateRef.current = null;
    pendingRef.current = []; // the unsent queue belonged to the old thread
    canvasRef.current = null;
    threadIdRef.current = id;
    setThreadError(null);
    setThreadTitle(title ?? THREAD_TITLE_FALLBACK);
    setThreadId(id);
  }, []);

  // -------------------------------------------------------------------------
  // Window quick-action CustomEvent (M4-F thread chips + M4-G composer chips):
  // ONE listener, owned here — every chip reuses the same send path.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim() !== "") send({ message: detail });
    };
    window.addEventListener("studio:chat-quick-action", handler);
    return () => window.removeEventListener("studio:chat-quick-action", handler);
  }, [send]);

  // -------------------------------------------------------------------------
  // Context: 1 Hz inspect poll while visible (§11) + on-demand collects.
  // Round 12: the poll ALSO refreshes the compact canvas snapshot so mid-run
  // edits (steering the agent with the live project) ride the next turn.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!panelVisible) return;
    const tick = (): void => {
      // ONE inspect per tick, SHARED: the poll's own state update and the
      // canvas refresh both read it (never two bridge reads per second).
      void bridge.inspect().then(
        (inspection) => {
          setInspect(inspection);
          void buildCanvasSnapshot(bridge, inspection).then((canvas) => {
            canvasRef.current = canvas;
          });
        },
        () => undefined, // a missed poll never breaks chat (§5 doctrine)
      );
    };
    const timer = setInterval(tick, INSPECT_POLL_MS);
    return () => clearInterval(timer);
  }, [panelVisible, bridge]);

  // Collect on demand: when the panel opens, and on every flags/pinned change
  // (refreshContext already closes over flags/pinned — its identity changes
  // with them, so the effect re-runs without listing them twice).
  useEffect(() => {
    if (!panelVisible) return;
    refreshContext();
  }, [panelVisible, refreshContext]);

  const setFlag = useCallback((kind: ChatContextFlagKey, on: boolean): void => {
    setOverrides((current) => ({ ...current, [kind]: on }));
  }, []);

  const clearOptionalBlocks = useCallback((): void => {
    setOverrides((current) => {
      const next: Partial<Record<ChatContextFlagKey, boolean>> = { ...current };
      for (const key of Object.keys(flags) as ChatContextFlagKey[]) {
        if (flags[key]) next[key] = false;
      }
      return next;
    });
  }, [flags]);

  const addPinned = useCallback((item: PinnedContextItem): void => {
    setPinned((current) =>
      current.some((existing) => existing.kind === item.kind && existing.id === item.id)
        ? current
        : [...current, item],
    );
  }, []);

  const removePinned = useCallback((item: PinnedContextItem): void => {
    setPinned((current) =>
      current.filter((existing) => !(existing.kind === item.kind && existing.id === item.id)),
    );
  }, []);

  const setPanelVisible = useCallback((visible: boolean): void => {
    setPanelVisibleState(visible);
  }, []);

  const api: ChatContextApi = {
    controller,
    snapshot,
    models,
    activeModelId,
    threadId,
    threadTitle,
    threadError,
    flags,
    context: contextSnapshot,
    pinned,
    panelVisible,
    shortcutBus,
    planWiring: {
      ready: applyEngine !== null,
      controller,
      bridge,
      sessionVersionId,
    },
    send,
    stop,
    retry,
    newThread,
    openThread,
    setActiveModelId,
    setFlag,
    clearOptionalBlocks,
    addPinned,
    removePinned,
    setPanelVisible,
    refreshContext,
  };

  return <ChatApiContext.Provider value={api}>{children(api)}</ChatApiContext.Provider>;
}

/**
 * Read the chat api from context (for chat descendants that prefer a hook over
 * the provider's render-prop). Throws outside a `ChatProvider` — there is no
 * second context system.
 */
export function useChatContextApi(): ChatContextApi {
  const api = useContext(ChatApiContext);
  if (api === null) {
    throw new Error("useChatContextApi: missing <ChatProvider> ancestor");
  }
  return api;
}
