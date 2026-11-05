"use client";

/**
 * ChatFirstStudio — the `/w/[slug]` studio route body: the product's
 * chat-first surface with an OPTIONAL engine.
 *
 * Architecture (one session, two faces):
 *
 *   ┌─ StudioModeBar ──────────────────────────────────────┐
 *   │  ← Dashboard   {project}        [ Chat ● | Engine ]  │
 *   ├──────────────────────────────────────────────────────┤
 *   │  mode === "engine" → the editor fills the surface    │
 *   │  mode === "chat"   → ChatSurface fills the surface,  │
 *   │    while the editor runs LIVE but hidden beneath it  │
 *   │    (opacity-0 + pointer-events-none + aria-hidden +  │
 *   │    inert) — the agent's tool bridge needs a real,    │
 *   │    booted engine; the user just never sees it.       │
 *   └──────────────────────────────────────────────────────┘
 *
 * The EditorHost is mounted ONCE (never per-mode): one wasm boot, one project
 * lease, one autosave — flipping modes is instant and the film the agent
 * built in chat mode is on the canvas the moment Engine opens. The chat layer
 * is OPAQUE (bg-page), so no editor pixel ever shows through in chat mode.
 *
 * The session handle is materialized HERE and handed to EditorHost through
 * its `sessionFactory` test seam (the exact pattern editor-host.test.tsx
 * uses), so `sessionHandle.api` also serves the chat surface's ChatProvider —
 * one api-client (one x-workspace-id) across both faces.
 */

import { type ReactElement, useState } from "react";

import type { ChatApplyPorts } from "@/lib/chat/provider";

import { ChatSurface } from "@/components/chat-studio/chat-surface";
import { type StudioMode, StudioModeBar } from "@/components/chat-studio/studio-mode-bar";
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

export function ChatFirstStudio({ payload, sessionFactory }: ChatFirstStudioProps): ReactElement {
  // ONE session for both faces — created once, shared with the host.
  const [sessionHandle] = useState<EditorSessionFactory>(
    () => sessionFactory?.(payload) ?? createApiSession({ payload }),
  );
  // The host's session apply ports land here once the session hook returns
  // them — the chat provider needs them to APPLY + SAVE agent batches (the
  // exact wiring the editor's sidebar chat gets from the same hook).
  const [applyPorts, setApplyPorts] = useState<ChatApplyPorts | null>(null);
  const [mode, setMode] = useState<StudioMode>("chat");
  const projectName = payload.manifest.project.name;
  const projectSlug = payload.manifest.project.slug;

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
            <EditorHost payload={payload} sessionFactory={() => sessionHandle} onApplyPorts={setApplyPorts} />
          </EditorCapabilityGate>
        </div>

        {/* The chat face: opaque above the hidden engine. Unmounts (rather
            than hides) when Engine opens — its bridge/provider poll stops and
            the composer draft dies with it, which is exactly the chat-first
            contract: Engine mode has the editor's OWN docked sidebar chat.
            Sessions without an api-client (test fakes) mount no chat, the
            same rule the editor host applies. */}
        {mode === "chat" && sessionHandle.api !== undefined ? (
          <div data-testid="studio-chat-layer" className="absolute inset-0 z-10">
            <ChatSurface
              payload={payload}
              client={sessionHandle.api}
              applyPorts={applyPorts}
              onOpenEngine={() => setMode("engine")}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
