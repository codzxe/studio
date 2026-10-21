"use client";

// apps/web/src/components/editor/document-editor.tsx (W8-F)
//
// DocumentEditor — the editor page's root client component. Three-panel
// layout built from @studio/ui's collapsible Panels:
//
//   ┌──────────┬────────────────────────────┬──────────┐
//   │  Layers   │        Preview canvas       │ Chat edit │
//   │  (Panel)  │  (signed PNG + zoom, §13.1) │  (Panel)  │
//   └──────────┴────────────────────────────┴──────────┘
//
// W8-C PAGE CONTRACT (the placeholder in apps/web/src/app/(app)/documents/[id]/page.tsx
// renders this component — keep in sync):
//
//   import DocumentEditor from "@/components/editor/document-editor";
//
//   <DocumentEditor
//     documentId={params.id}          // route id — required unless `document` has it
//     document={payload.document}      // GET /v1/documents/:id inner `document`
//                                      //   object (W4-F toDocumentDto; parsed with
//                                      //   documentPayloadSchema — unknown-tolerant)
//     layers={payload.layers}          // OPTIONAL compact layer tree
//                                      //   (layerTreeSchema shape — engine layer.list /
//                                      //   document.inspect rows; §13.1
//                                      //   GET /v1/documents/:id/layers once the
//                                      //   gateway ships it; may also ride inside the
//                                      //   `document` payload as `layers`)
//     client={gatewayClient}          // OPTIONAL typed client (src/lib/api.ts);
//                                      //   defaults to createGatewayClientFromEnv()
//   />
//
// The editor owns the cross-panel state: the document REVISION (the preview
// canvas' refresh key — §13.2 `preview.updated`), the layer tree (optimistic
// §13.1 `layer.setProps` visibility commands with typed rollback), selection,
// and the §13 command posting discipline (one in-flight manual command, one
// Idempotency-Key per user action, §3.4).

import "./editor.css";

import { useEffect, useState } from "react";
import { Badge, Panel, PanelContent, PanelHeader, PanelResizeHandle, cn } from "@studio/ui";
import { createGatewayClientFromEnv, type GatewayClient } from "../../lib/api";
import { ChatPanel } from "./chat-panel";
import {
  commandReplySchema,
  countLayers,
  documentPayloadSchema,
  errorText,
  layerTreeSchema,
  setLayerVisible,
  visibilityCommand,
  type LayerNode,
} from "./editor-model";
import { LayersTree } from "./layers-tree";
import { PreviewCanvas } from "./preview-canvas";

export interface DocumentEditorProps {
  /** Route document id — required unless `document` carries one. */
  readonly documentId?: string;
  /**
   * GET /v1/documents/:id inner `document` object (W4-F toDocumentDto; the
   * reply envelope's `document` field). Unknown-tolerant on purpose: the
   * payload is validated with documentPayloadSchema at this boundary.
   */
  readonly document?: unknown;
  /**
   * Compact layer tree (layerTreeSchema shape — see editor-model.ts for the
   * documented payload). Also read off `document.layers` when present.
   */
  readonly layers?: unknown;
  /** Typed gateway client; built from NEXT_PUBLIC_API_BASE_URL when omitted. */
  readonly client?: GatewayClient;
  readonly className?: string;
}

/** First node flagged selected in the payload, if any. */
function initiallySelected(layers: readonly LayerNode[]): string | null {
  for (const node of layers) {
    if (node.selected === true) {
      return node.id;
    }
    const child = initiallySelected(node.children ?? []);
    if (child !== null) {
      return child;
    }
  }
  return null;
}

export function DocumentEditor({
  documentId,
  document,
  layers: layersProp,
  client: clientProp,
  className,
}: DocumentEditorProps) {
  // Client: injected or env-built. The env factory can throw (missing
  // NEXT_PUBLIC_API_BASE_URL, §4 fail-fast) — caught here so a misconfigured
  // box renders a clear card instead of a thrown render (auth-form precedent).
  const [clientState] = useState<{ client: GatewayClient | null; error: string | null }>(() => {
    if (clientProp !== undefined) {
      return { client: clientProp, error: null };
    }
    try {
      return { client: createGatewayClientFromEnv(), error: null };
    } catch (error) {
      return { client: null, error: error instanceof Error ? error.message : null };
    }
  });

  const [documentState] = useState(() => documentPayloadSchema.safeParse(document));
  const documentPayload = documentState.success ? documentState.data : null;
  const resolvedDocumentId = documentId ?? documentPayload?.id ?? null;

  // §13.1 GET /v1/documents/:id/layers is the planned HTTP surface; today the
  // tree arrives via props (or `document.layers`). Layers are RE-SYNCED from
  // the endpoint after runs/undo once it exists — see refreshLayers().
  const [layerTree, setLayerTree] = useState<readonly LayerNode[]>(() => {
    const source =
      layersProp !== undefined && layersProp !== null
        ? layersProp
        : documentPayload?.["layers"];
    const parsed = layerTreeSchema.safeParse(source);
    return parsed.success ? parsed.data : [];
  });
  const [revision, setRevision] = useState(() => documentPayload?.current_revision ?? 0);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(() =>
    initiallySelected(layerTree),
  );
  const [busyLayerId, setBusyLayerId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  const client = clientState.client;

  /**
   * Layer-tree re-sync (§13.1 layers endpoint — not shipped by the gateway
   * yet). Returns null on failure by design: the caller keeps the last good
   * tree, and the revision-bumped preview canvas keeps the visual truth.
   */
  async function fetchLayers(): Promise<readonly LayerNode[] | null> {
    if (client === null || resolvedDocumentId === null) {
      return null;
    }
    try {
      return await client.get(`/documents/${encodeURIComponent(resolvedDocumentId)}/layers`, {
        schema: layerTreeSchema,
      });
    } catch {
      return null; // not shipped (404/405) or transient — keep the current tree
    }
  }

  async function refreshLayers(): Promise<void> {
    const tree = await fetchLayers();
    if (tree !== null) {
      setLayerTree(tree);
    }
  }

  // One-time catch-up when the page passed no tree (endpoint or nothing).
  useEffect(() => {
    if (layerTree.length === 0) {
      void refreshLayers();
    }
    // Mount-only: the tree either arrived via props or it did not — later
    // refreshes ride onRunSettled/onLayersStale, not on re-renders.
  }, []);

  /**
   * Eye-toggle flow — a §13.1 manual command: `layer.setProps { layer, visible }`
   * via POST /v1/documents/:id/commands (§13.4: the same allowlist the agent
   * uses). Optimistic flip + typed rollback; the reply's revision_after is the
   * preview canvas' refresh key.
   */
  async function toggleVisibility(node: LayerNode): Promise<void> {
    if (client === null || resolvedDocumentId === null || busyLayerId !== null) {
      return;
    }
    setBusyLayerId(node.id);
    setLayerTree((current) => setLayerVisible(current, node.id, !node.visible));
    try {
      const reply = await client.post(
        `/documents/${encodeURIComponent(resolvedDocumentId)}/commands`,
        {
          body: visibilityCommand(node.id, !node.visible),
          schema: commandReplySchema,
          // §3.4: one idempotency key per user action — a network retry of the
          // same action replays; two clicks are two commands.
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setRevision(reply.revision_after);
      setCommandError(null);
    } catch (error) {
      // Roll the optimistic flip back and show the typed §13.3 message.
      setLayerTree((current) => setLayerVisible(current, node.id, node.visible));
      setCommandError(errorText(error, "The layer change could not be applied."));
    } finally {
      setBusyLayerId(null);
    }
  }

  if (resolvedDocumentId === null) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <p role="alert" className="max-w-sm rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
          This document could not be opened — no document id was provided.
        </p>
      </div>
    );
  }

  if (client === null) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <p role="alert" className="max-w-sm rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
          {clientState.error ?? "The editor could not reach the server."}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("document-editor flex h-full min-h-0 w-full", className)}>
      {/* Left rail — compact layer tree (§10.1) */}
      <Panel side="left" className="bg-surface text-foreground">
        <PanelHeader
          title="Layers"
          actions={
            <Badge variant="outline">
              {countLayers(layerTree)} layer{countLayers(layerTree) === 1 ? "" : "s"}
            </Badge>
          }
        />
        <PanelContent>
          {commandError === null ? null : (
            <p
              role="alert"
              className="shrink-0 rounded-md border border-border bg-surface-muted px-3 py-2 text-xs text-red-600"
            >
              {commandError}
            </p>
          )}
          <LayersTree
            layers={layerTree}
            selectedLayerId={selectedLayerId}
            busyLayerId={busyLayerId}
            onSelect={setSelectedLayerId}
            onToggleVisibility={(node) => {
              void toggleVisibility(node);
            }}
          />
        </PanelContent>
      </Panel>

      <PanelResizeHandle side="left" />

      {/* Center — signed preview PNG (§13.1), zoom fit/100%, checkerboard */}
      <main
        aria-label="Preview canvas"
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <PreviewCanvas
          client={client}
          documentId={resolvedDocumentId}
          documentName={documentPayload?.name}
          revision={revision}
          documentWidthPx={documentPayload?.width_px}
          documentHeightPx={documentPayload?.height_px}
        />
      </main>

      <PanelResizeHandle side="right" />

      {/* Right rail — chat-edit loop (§23.5/§24.2) */}
      <Panel side="right" className="bg-surface text-foreground">
        <PanelHeader
          title="Chat edit"
          actions={
            <Badge variant="outline" title="§5.2/§14.1 quick tier">
              Quick · 1 credit
            </Badge>
          }
        />
        <PanelContent className="gap-0 overflow-hidden p-0">
          <ChatPanel
            client={client}
            documentId={resolvedDocumentId}
            onRevision={setRevision}
            onLayersStale={() => {
              void refreshLayers();
            }}
          />
        </PanelContent>
      </Panel>
    </div>
  );
}

export default DocumentEditor;
