"use client";

// apps/web — DocumentEditor PLACEHOLDER (W8-C stub, owned by W8-F).
//
// =====================================================================
// CONTRACT (frozen by W8-C — the documents overview route depends on it):
// =====================================================================
// Route: apps/web/src/app/(app)/documents/[id]/page.tsx imports
//   `DocumentEditor` from "@/components/documents/document-editor"
// and renders it inside the document overview (document-overview.tsx),
// below the meta bar. W8-F implements the real editor here — replace ONLY
// this file's internals (keep the exported name + props so the route, the
// overview and any tests stay stable), or re-point the two import sites and
// delete this file in the same commit (fleet note in the worklog).
//
// Props:
//   documentId — route id of the document (tenant checks live in the
//                gateway; encode ids when building request paths).
//   document   — DocumentDetail | null: gateway DTO (name, width_px,
//                height_px, current_revision, template_id, created_at,
//                latest_version…); null only while the overview is loading.
//
// What W8-F can assume:
//   - The overview renders the meta bar + loading/error states; the editor
//     receives data only in the "ready" state.
//   - useDocument/useDocuments/useCreateDocument (use-documents.ts) expose
//     the typed client + cache; after commits invalidate
//     documentsKeys.detail(id) / documentsKeys.lists() (see the INVALIDATION
//     NOTES there).
//   - Run progress over SSE: lib/api.ts RunEventStream (§13.2) — invalidate
//     the detail key on `preview.updated` / terminal events.
//   - @studio/ui Panel/Skeleton/Badge are available for the canvas + rails
//     (see the TOKEN NOTE in documents-library.tsx for the current gap).
//
// What this placeholder does now: an empty, correctly-shaped canvas frame
// with the document's aspect ratio and an honest empty-state message (no
// forbidden product names, §1.5).

import type { DocumentDetail } from "./use-documents";

export interface DocumentEditorProps {
  readonly documentId: string;
  /** Gateway document DTO; null while the overview is still loading. */
  readonly document: DocumentDetail | null;
}

export function DocumentEditor({ documentId, document }: DocumentEditorProps) {
  // Placeholder framing only — W8-F replaces everything below.
  const aspectRatio =
    document === null ? undefined : `${document.width_px} / ${document.height_px}`;
  return (
    <div
      data-document-id={documentId}
      className="flex min-h-96 w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-surface-muted"
      style={aspectRatio === undefined ? undefined : { aspectRatio }}
    >
      <p className="max-w-md p-6 text-center text-sm text-muted-foreground">
        The editable canvas opens here — layers, chat and versions arrive with the editor build.
      </p>
    </div>
  );
}
