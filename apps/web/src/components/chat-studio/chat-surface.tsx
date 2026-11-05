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
 * Composition (mirrors chat-panel-slot.tsx, minus the panel chrome):
 * - useEngineBridge polls for the hidden editor iframe and attaches ONE
 *   bridge (the styled "waking" state rides out the ~10s wasm boot)
 * - ChatProvider → ChatStudioInner (render-prop api)
 * - empty thread → the PauseVFX-style hero (headline + task pills + composer)
 * - non-empty → the conversation column (ChatThread + composer + live
 *   progress strip)
 * - the "Open in Engine" CTA card after a completed run — the build happened
 *   in the hidden engine; this is the invitation to go look.
 */

import type { ApiClient } from "@studio/api-client";
import { type EditorBridge, attachEditorBridge } from "@studio/editor-bridge";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/composer";
import { ClarifyCard, EditErrorCard } from "@/components/chat/edit-cards";
import { modelDisplayName } from "@/components/chat/header";
import { RunProgressStrip, deriveRunProgress } from "@/components/chat/progress-strip";
import { CHAT_SEED_COMPOSER_EVENT } from "@/components/chat/quick-actions";
import { ChatThread } from "@/components/chat/thread";
import { editorChatShortcutBus } from "@/components/editor-host/chat-shortcut-bus";
import type { EditorHostPayload } from "@/components/editor-host/types";
import type { MentionItem } from "@/lib/chat/mentions";
import {
  type ChatApplyPorts,
  type ChatContextApi,
  ChatProvider,
} from "@/lib/chat/provider";
import { LIVE_RUN_PHASES } from "@/lib/chat/run-state";

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
}

const FULL_FILM_PROMPT =
  "Make a 10-second motion-graphics film: one continuous scene, a title, keyframed reveals and a glowing accent.";
const RESTYLE_PROMPT =
  "Restyle every layer: add glow, a gradient-ramp background and soft blur for depth.";
const ANIMATE_PROMPT =
  "Animate the current composition: keyframe scale, position and opacity so it plays as a loop.";

/** PauseVFX-flavored starter prompts (task pills under the hero composer). */
const STARTER_PROMPTS: readonly {
  readonly pill: string;
  readonly prompt: string;
}[] = [
  { pill: "Full film", prompt: FULL_FILM_PROMPT },
  {
    pill: "One scene",
    prompt:
      "Build one 3-second scene: an animated title over a glowing background with a keyframed camera push.",
  },
  { pill: "Restyle", prompt: RESTYLE_PROMPT },
  { pill: "Animate", prompt: ANIMATE_PROMPT },
  { pill: "Explain", prompt: "Explain what this composition does and how it is built." },
];

const QUICK_CHIPS: readonly { readonly label: string; readonly prompt: string }[] = [
  { label: "Make a 10-second launch film", prompt: FULL_FILM_PROMPT },
  { label: "Add glow + gradients", prompt: RESTYLE_PROMPT },
  { label: "Keyframe everything", prompt: ANIMATE_PROMPT },
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

export function ChatSurface({ payload, client, applyPorts, onOpenEngine }: ChatSurfaceProps): ReactElement {
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
      {(api) => <ChatStudioInner api={api} onOpenEngine={onOpenEngine} />}
    </ChatProvider>
  );
}

// ---------------------------------------------------------------------------
// The inner surface: provider api → PauseVFX-styled chat page.
// ---------------------------------------------------------------------------

function ChatStudioInner({
  api,
  onOpenEngine,
}: {
  api: ChatContextApi;
  onOpenEngine: () => void;
}): ReactElement {
  const snapshot = api.snapshot;
  const streaming = LIVE_RUN_PHASES.has(snapshot.phase);
  const progress = useMemo(() => deriveRunProgress(snapshot), [snapshot]);
  const messages = snapshot.messages;
  const empty = messages.length === 0;

  // §7 visibility: this surface IS the chat, so the provider's 1 Hz inspect
  // poll runs whenever we are mounted.
  useEffect(() => {
    api.setPanelVisible(true);
    return () => api.setPanelVisible(false);
  }, [api]);

  // Re-send helper (mirror chat-panel-slot): block while a run is live.
  const resendFrom = useCallback(
    (text: string): void => {
      if (text.trim() === "") return;
      if (LIVE_RUN_PHASES.has(api.snapshot.phase)) return;
      api.send({ message: text });
    },
    [api],
  );
  const onRetryFrom = useCallback(
    (messageId: string): void => {
      const message = messages.find((entry) => entry.id === messageId);
      if (message !== undefined) resendFrom(message.text);
    },
    [messages, resendFrom],
  );

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

  const composer = (
    <div data-testid="studio-chat-composer-stack" className="mx-auto w-full max-w-3xl px-4 pb-4">
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
        creditHint={modelDisplayName(api.activeModelId ?? "studio-fast")}
      />
      <div className="mt-2 px-1">
        <RunProgressStrip phase={snapshot.phase} chips={progress.chips} />
      </div>
    </div>
  );

  return (
    <div className="relative h-full overflow-hidden bg-page" data-testid="studio-chat-page">
      {/* The PauseVFX horizon: a soft orange glow rising from the bottom —
          decorative, behind everything, never interactive. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 horizon-glow"
      />

      {empty ? (
        /* -------- HERO: the PauseVFX landing pattern -------- */
        <div className="relative flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-10">
          <h1 className="max-w-2xl text-center font-display text-display-xl text-primary">
            What are we <em className="italic text-signal">making</em>?
          </h1>
          <p className="max-w-xl text-center text-body-s text-secondary">
            Describe the motion piece. The agent builds every layer, keyframe and effect — the
            engine stays out of sight until you want it.
          </p>
          <div className="w-full max-w-2xl">{composer}</div>
          <div className="flex max-w-2xl flex-wrap items-center justify-center gap-2">
            {STARTER_PROMPTS.map((starter) => (
              <button
                key={starter.pill}
                type="button"
                data-testid={`studio-starter-${starter.pill.toLowerCase().replace(/\s+/g, "-")}`}
                onClick={() => seedComposer(starter.prompt)}
                className="flex h-8 items-center rounded-pill border border-subtle bg-panel px-3.5 text-label text-secondary duration-120 ease-out hover:border-strong hover:text-primary"
              >
                {starter.pill}
              </button>
            ))}
          </div>
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
              />
            </div>
          </div>
          <div className="shrink-0 pt-2">
            {composer}
            {!streaming ? (
              <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 pb-3">
                {QUICK_CHIPS.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    onClick={() => seedComposer(chip.prompt)}
                    className="flex h-7 items-center rounded-pill border border-subtle bg-panel px-3 text-caption text-secondary duration-120 ease-out hover:border-strong hover:text-primary"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
