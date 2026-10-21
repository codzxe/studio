# flows/ — undo/redo + export flows (W8-P)

Editor-facing client flows for §13.1 undo/redo and §13.1/§10.3 exports.
Everything here talks to the gateway through the typed client
(`apps/web/src/lib/api.ts`, W1-K) — no raw `fetch`, no invented endpoints.

```
flows/
├── flows-model.ts       pure logic + wire schemas (unit-tested, no React)
├── revision-events.ts    the revision-refresh broadcast contract
├── use-undo-redo.ts      undoOne / redoOne hooks + toast + useRevisionRefresh
├── use-exports.ts        enqueue → 202 → bounded 2 s poll → signed URL
├── export-dialog.tsx     format picker (§10.3) + job list mini-history
├── editor-actions.tsx    <EditorActions/> — the toolbar convenience mount
└── index.ts              public barrel
```

## Where to mount — the editor toolbar

Mount **`<EditorActions/>`** in the editor toolbar (next to the document
title / zoom controls; `components/editor/document-editor.tsx` is the natural
owner — editor/ is W8-F's path, so it is not wired here):

```tsx
<EditorActions
  client={client}          // GatewayClient from lib/api.ts
  documentId={documentId}
  canUndo={hasHistory}     // optional availability hints (chat-panel pattern);
  canRedo={hasRedo}        // default true — the server rejects empty stacks
                           // with a typed envelope that lands as a toast
  psdExportEnabled={false} // §2.3 feature flag — psd stays disabled until true
  canvasSize={{ width: canvas.widthPx, height: canvas.heightPx }}
  onRevision={setRevision}      // preview-canvas refresh key (chat-panel seam)
  onLayersStale={markStale}     // layers-tree re-sync (chat-panel seam)
/>
```

`<EditorActions/>` wires the three buttons together and renders one
`aria-live` toast region (auto-dismiss 6 s): undo/redo toasts
(“Run undone — one step”, “Run restored — one step”) and export toasts.

For a custom toolbar, compose the pieces yourself:

- `useUndoRedo({ client, documentId, onRevision, onLayersStale })` →
  `{ undoOne, redoOne, busy, notice, dismissNotice }` —
  `POST /v1/documents/:id/{undo,redo}` (§13.1), one step = one agent run
  (§20-#7).
- `<ExportDialog client documentId open onOpenChange psdEnabled onNotice/>`
  — standalone dialog if the toolbar already exists.

## Revision-refresh contract (what panels consume)

After a successful undo/redo the document revision changed, so every panel
that renders revision-derived data must refresh. Two supported styles, both
fired by `useUndoRedo`:

1. **Window event** (no import coupling to the emitter) — `revision-events.ts`:

   ```ts
   // style 1a — plain subscribe:
   const off = subscribeRevisionRefresh((detail) => refetch());
   // style 1b — React hook (from ./use-undo-redo.ts):
   useRevisionRefresh(documentId, (detail) => refetch());
   ```

   Event name: `studio:document-revision-refresh` (frozen; internal-only
   name per §1.5). Detail (additive-only):
   `{ documentId: string, revision: number, source: "undo" | "redo", at: number }`.

2. **Callback seam** (the W8-F chat-panel pattern): pass `onRevision` /
   `onLayersStale` into `useUndoRedo` / `<EditorActions/>`.

Panels built on react-query should invalidate in their own listener, e.g.
`queryClient.invalidateQueries({ queryKey: ["document", documentId] })` — the
flows deliberately do not own a queryClient. Today the emitter is only
undo/redo (W8-F's runs still use their callback prop); any future emitter
(restore, external edits) broadcasts the same event.

## Export dialog behavior (§10.3 / §13.1)

- **Formats**: `.pcraft` default + recommended (lossless, round-trip-perfect);
  PNG/JPG with width/height inputs (blank = document size, ≤ 8192 px/side)
  and the 1–100 quality slider (JPG only — PNG is lossless); PSD carries the
  §2.3 experimental warning label + fidelity-report note and is **disabled
  behind the psd feature flag** (`psdExportEnabled`, default off — mirror of
  `psd_export` in `@studio/config` flags, default-off by §4).
- **Flow**: `POST /v1/documents/:id/exports` → **202** `{ export_id, status,
  revision, warnings }` → poll loop (2 s interval, bounded at 150 polls ≈
  5 min) against `GET /v1/documents/:id/exports?limit=20` (the per-document
  job list IS the status surface — the gateway has no per-job GET) →
  terminal `succeeded` → fresh **signed URL** (≤ 15 min TTL) → auto-download
  (hidden anchor click) + the visible note that re-downloading an existing
  export is free (§10.3 gating).
- **Status machine** (display phases): `queued` → `processing` → `ready` /
  `failed`, mapped from the wire statuses `queued/running/succeeded/failed`
  (`flows-model.ts exportPhase`, unit-tested). Failed rows show a plain
  message (the wire list row carries no error payload); create-call failures
  show the full §13.3 envelope (`message — hint`, e.g. plan_limit
  “HD export requires Pro”).
- Poll loops live only while the dialog is open (unmount aborts); jobs keep
  processing server-side and every dialog open reloads the history with
  fresh signed URLs.

## Notes for other owners

- `flows-model.ts` mirrors wire shapes from the gateway
  (`services/exports.ts` W4-L, `routes/commands.ts` W4-K). Contract drift
  throws via Zod at the boundary (`schema.parse` in `lib/api.ts`).
- No files outside `flows/` are touched by this wave; the mount snippets
  above are the hand-off. If `components/editor/document-editor.tsx` (W8-F)
  wants the toolbar, importing `../flows` is the intended seam.
