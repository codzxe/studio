import { IdleCommentsRegion } from "@/components/comments/idle-comments-region";

import { EditorCapabilityGate } from "@/components/editor-host/capability-gate";
import { EditorHost } from "@/components/editor-host/editor-host";
import { loadEditorProject } from "@/components/editor-host/resolve-project";
import type { EditorHostPayload } from "@/components/editor-host/types";
import { pageMetadata } from "@/lib/seo";

/**
 * The editor route (M3.5): `/w/:projectSlug/editor`.
 *
 * RSC resolves the project by slug through `GET /v1/projects/resolve/:slug`
 * (ONE gateway call: one auth pass + one joined SQL + the manifest — the TTFB
 * fix for the perf round) and hands the client host ONE serializable payload
 * — the client does not re-fetch the manifest on mount. The pre-fix code
 * scanned `/v1/me` + per-workspace project pages + the manifest as separate
 * gateway calls; on a many-workspace account that fan-out paid the
 * auth+workspace middleware (and better-auth's per-org lookups in `/v1/me`)
 * once per call — ~90 sequential DB roundtrips and a measured 7-10s TTFB.
 *
 * - Missing project, soft-deleted or archived project, or a project in a
 *   workspace this user is not a member of → `notFound()` (hard rule 3:
 *   cross-tenant = 404).
 * - Expired session (the proxy checks cookie presence; the gateway checks
 *   validity) → redirect to /sign-in with a `next` round-trip.
 * - A project with NO version yet → the editor opens START-FROM-SCRATCH:
 *   the engine boots its own default empty project and the first save
 *   creates v1 through the root-upload path (baseVersionId null, W3-G3).
 *   (Previously this dead-ended on an empty-state page — a chicken-and-egg:
 *   you could not save a first version without opening the editor.)
 */

// The resolve + auth/tenant mapping lives in `resolve-project.ts`, shared with
// the chat-first `/w/[slug]` studio route (one resolution shape, one behavior
// for both surfaces).
const loadEditorPage = (slug: string): Promise<EditorHostPayload> =>
  loadEditorProject(slug, `/w/${slug}/editor`);

interface EditorPageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

export async function generateMetadata({ params }: EditorPageProps) {
  const { slug } = await params;
  const name = (await loadEditorPage(slug)).manifest.project.name;
  return pageMetadata({
    title: `${name} — editor`,
    description: `Edit “${name}” in the Studio editor.`,
    path: `/w/${slug}/editor`,
  });
}

export default async function EditorPage({ params }: EditorPageProps) {
  const { slug } = await params;
  const payload = await loadEditorPage(slug);

  return (
    <>
      {/*
        W2-09 §8.7 capability gate: the editor canvas needs WebGPU/WebGL2 —
        unsupported browsers get the full-page UnsupportedGpuState + the
        static-preview offer (the project's history page) instead of a broken
        canvas, and <1024px viewports get the dismissible §13 desktop note.
      */}
      <EditorCapabilityGate slug={slug} projectName={payload.manifest.project.name}>
        <EditorHost payload={payload} />
      </EditorCapabilityGate>
      {/*
        M7-F COMMENTS SLOT REGION — the comments UI mount (BUILD_PLAN §M7 task 1).
        The editor-host files are M7-G's this wave, so the region mounts here,
        self-sufficient: it boots its own workspace-scoped ApiClient and
        attaches a dedicated read-only bridge to the host's iframe (discovered
        by its stable testid). If the integrator later prefers the IN-HOST
        mount, move this one line into editor-host.tsx as:
          <CommentsRegion workspaceId={payload.workspaceId}
            projectId={payload.manifest.project.id}
            projectName={payload.manifest.project.name}
            client={sessionHandle.api} bridge={chatBridge} />
        and DELETE this slot (one mount, never two).

        ROUND-13: the slot renders through IdleCommentsRegion — the region's
        ~160KB of chunks (panel UI + tooltips) left the editor's critical
        path and now load once the browser goes idle after first paint (the
        LCP/INP fix; see idle-comments-region.tsx).
      */}
      <IdleCommentsRegion
        workspaceId={payload.workspaceId}
        projectId={payload.manifest.project.id}
        projectName={payload.manifest.project.name}
      />
    </>
  );
}
