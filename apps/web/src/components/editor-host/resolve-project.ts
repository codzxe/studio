import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import type { EditorHostPayload } from "@/components/editor-host/types";
import { parseManifest } from "@/lib/editor-session";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import type { ProjectResolve } from "@studio/contracts";

/**
 * Shared RSC project resolution for BOTH editor surfaces: the classic
 * `/w/:slug/editor` route and the new chat-first `/w/:slug` studio route
 * (chat-main + hidden engine + optional Engine mode).
 *
 * Resolves the project by slug through `GET /v1/projects/resolve/:slug`
 * (ONE gateway call: one auth pass + one joined SQL + the manifest — the
 * TTFB fix for the perf round) and hands the client host ONE serializable
 * payload — the client does not re-fetch the manifest on mount. The pre-fix
 * code scanned `/v1/me` + per-workspace project pages + the manifest as
 * separate gateway calls; on a many-workspace account that fan-out paid the
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
 */
const resolveEditorProject = cache(async (slug: string): Promise<EditorHostPayload> => {
  const resolved = await gatewayCall<ProjectResolve>(
    `/v1/projects/resolve/${encodeURIComponent(slug)}`,
  );
  const currentVersion = resolved.manifest.currentVersion;
  const payload: EditorHostPayload = {
    workspaceId: resolved.workspaceId,
    manifest: {
      project: {
        id: resolved.project.id,
        slug: resolved.project.slug,
        name: resolved.project.name,
      },
      currentVersion:
        currentVersion === null
          ? null
          : {
              id: currentVersion.id,
              label: currentVersion.label,
              sha256: currentVersion.sha256,
              sizeBytes: currentVersion.sizeBytes,
            },
      assets: resolved.manifest.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        // §6.3 stable virtual path (the bridge derives the same shape):
        virtualPath: `/assets/${asset.id}/${asset.name}`,
        downloadUrl: asset.url,
        sizeBytes: asset.sizeBytes,
      })),
      projectFileUrl: currentVersion === null ? null : currentVersion.url,
    },
  };
  // The client serves this payload through `getManifest`; validate it with
  // the engine's own parser so a wire drift fails HERE, not mid-open.
  parseManifest(payload.manifest);
  return payload;
});

/**
 * Resolve + map auth/tenant failures onto route outcomes. `nextPath` is the
 * sign-in round-trip target (the route that requested the resolution).
 */
export async function loadEditorProject(
  slug: string,
  nextPath: string,
): Promise<EditorHostPayload> {
  try {
    return await resolveEditorProject(slug);
  } catch (error) {
    if (isGatewayHttpError(error)) {
      if (error.status === 401 || error.code === "UNAUTHORIZED") {
        redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
      }
      if (error.isNotFound) notFound();
      // Other gateway failures: sanitized typed error → the Next error boundary.
      throw error;
    }
    throw error;
  }
}
