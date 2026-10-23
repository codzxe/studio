import { CommentsRegion } from "@/components/comments/comments-region";
import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { EditorCapabilityGate } from "@/components/editor-host/capability-gate";
import { EditorHost } from "@/components/editor-host/editor-host";
import type { EditorHostPayload } from "@/components/editor-host/types";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import { parseManifest } from "@/lib/editor-session";
import { pageMetadata } from "@/lib/seo";

/**
 * The editor route (M3.5): `/w/:projectSlug/editor`.
 *
 * RSC resolves the project by slug (there is no by-slug gateway endpoint —
 * the user's workspaces are scanned and their project lists matched on
 * `slug`), fetches the manifest server-side, and hands the client host ONE
 * serializable payload — the client does not re-fetch the manifest on mount.
 *
 * - Missing project, soft-deleted project, or a project in a workspace this
 *   user is not a member of → `notFound()` (hard rule 3: cross-tenant = 404).
 * - Expired session (the proxy checks cookie presence; the gateway checks
 *   validity) → redirect to /sign-in with a `next` round-trip.
 * - A project with no version yet → friendly empty state (M2's create/upload
 *   flow owns the first snapshot; the editor needs a version to open).
 */

// ---------------------------------------------------------------------------
// Wire shapes consumed (§7.2, type-only re-statements — see lib/gateway.ts)
// ---------------------------------------------------------------------------

interface MembershipWire {
  readonly workspaceId: string;
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
}

interface ProjectRowWire {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly deletedAt: string | null;
}

interface ManifestWire {
  readonly projectId: string;
  readonly currentVersion: {
    readonly id: string;
    readonly sha256: string;
    readonly label: string | null;
    readonly sizeBytes: number;
    readonly url: string;
  } | null;
  readonly assets: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly sizeBytes: number;
    readonly url: string;
  }>;
}

/** Bounded slug scan: §7.2 pages are 50 rows; 4 pages per workspace is ample. */
const PROJECT_PAGE_LIMIT = 50;
const MAX_PROJECT_PAGES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemberships(value: unknown): MembershipWire[] {
  if (!isRecord(value) || !Array.isArray(value.memberships)) return [];
  const out: MembershipWire[] = [];
  for (const raw of value.memberships) {
    if (!isRecord(raw) || !isRecord(raw.workspace)) continue;
    if (typeof raw.workspaceId !== "string") continue;
    out.push({ workspaceId: raw.workspaceId, workspace: raw.workspace as MembershipWire["workspace"] });
  }
  return out;
}

function parseProjectRow(value: unknown): ProjectRowWire | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.name !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    deletedAt: typeof value.deletedAt === "string" ? value.deletedAt : null,
  };
}

async function listProjects(
  workspaceId: string,
  cursor?: string,
): Promise<{ items: ProjectRowWire[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(PROJECT_PAGE_LIMIT) });
  if (cursor !== undefined) query.set("cursor", cursor);
  const data = await gatewayCall<{ items?: unknown; nextCursor?: unknown }>(
    `/v1/projects?${query.toString()}`,
    { workspaceId },
  );
  const rows = Array.isArray(data?.items) ? data.items : [];
  const items = rows.map(parseProjectRow).filter((row): row is ProjectRowWire => row !== null);
  return { items, nextCursor: typeof data?.nextCursor === "string" ? data.nextCursor : null };
}

async function fetchManifest(workspaceId: string, projectId: string): Promise<ManifestWire> {
  const data = await gatewayCall<Record<string, unknown>>(
    `/v1/projects/${encodeURIComponent(projectId)}/manifest`,
    { workspaceId },
  );
  if (!isRecord(data) || !Array.isArray(data.assets)) {
    throw new Error("editor route: the project manifest response was malformed");
  }
  return data as unknown as ManifestWire;
}

type EditorResolution =
  | { readonly status: "missing" }
  | {
      readonly status: "no-version";
      readonly project: { readonly id: string; readonly slug: string; readonly name: string };
    }
  | { readonly status: "ready"; readonly payload: EditorHostPayload };

/**
 * Resolve the project by slug across the user's workspaces, then fetch its
 * manifest. Wrapped in `cache()` so `generateMetadata` and the page share ONE
 * resolution per request.
 */
const resolveEditorProject = cache(async (slug: string): Promise<EditorResolution> => {
  const me = await gatewayCall<unknown>("/v1/me");
  const memberships = parseMemberships(me);

  for (const membership of memberships) {
    let cursor: string | undefined = undefined;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const { items, nextCursor } = await listProjects(membership.workspaceId, cursor);
      const match = items.find((project) => project.slug === slug && project.deletedAt === null);
      if (match !== undefined) {
        const manifest = await fetchManifest(membership.workspaceId, match.id);
        if (manifest.currentVersion === null) {
          return { status: "no-version", project: { id: match.id, slug: match.slug, name: match.name } };
        }
        const payload: EditorHostPayload = {
          workspaceId: membership.workspaceId,
          manifest: {
            project: { id: match.id, slug: match.slug, name: match.name },
            currentVersion: {
              id: manifest.currentVersion.id,
              label: manifest.currentVersion.label,
              sha256: manifest.currentVersion.sha256,
              sizeBytes: manifest.currentVersion.sizeBytes,
            },
            assets: manifest.assets.map((asset) => ({
              id: asset.id,
              name: asset.name,
              // §6.3 stable virtual path (the bridge derives the same shape):
              virtualPath: `/assets/${asset.id}/${asset.name}`,
              downloadUrl: asset.url,
              sizeBytes: asset.sizeBytes,
            })),
            projectFileUrl: manifest.currentVersion.url,
          },
        };
        // The client serves this payload through `getManifest`; validate it
        // with the engine's own parser so a wire drift fails HERE, not mid-open.
        parseManifest(payload.manifest);
        return { status: "ready", payload };
      }
      if (nextCursor === null) break;
      cursor = nextCursor;
    }
  }
  return { status: "missing" };
});

async function loadEditorPage(slug: string): Promise<EditorResolution> {
  try {
    return await resolveEditorProject(slug);
  } catch (error) {
    if (isGatewayHttpError(error)) {
      if (error.status === 401 || error.code === "UNAUTHORIZED") {
        redirect(`/sign-in?next=${encodeURIComponent(`/w/${slug}/editor`)}`);
      }
      if (error.isNotFound) notFound();
      // Other gateway failures: sanitized typed error → the Next error boundary.
      throw error;
    }
    throw error;
  }
}

interface EditorPageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

export async function generateMetadata({ params }: EditorPageProps) {
  const { slug } = await params;
  const resolution = await loadEditorPage(slug);
  const name =
    resolution.status === "ready" ? resolution.payload.manifest.project.name
    : resolution.status === "no-version" ? resolution.project.name
    : undefined;
  return pageMetadata({
    title: name === undefined ? "Editor" : `${name} — editor`,
    description:
      name === undefined
        ? "Open a project in the Studio editor."
        : `Edit “${name}” in the Studio editor.`,
    path: `/w/${slug}/editor`,
  });
}

export default async function EditorPage({ params }: EditorPageProps) {
  const { slug } = await params;
  const resolution = await loadEditorPage(slug);
  if (resolution.status === "missing") notFound();

  if (resolution.status === "no-version") {
    return (
      <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
        <EmptyState
          data-testid="editor-no-version"
          title="This project has no saved version yet."
          secondaryLink={{ label: "Back to workspace", href: "/w" }}
        />
      </main>
    );
  }

  return (
    <>
      {/*
        W2-09 §8.7 capability gate: the editor canvas needs WebGPU/WebGL2 —
        unsupported browsers get the full-page UnsupportedGpuState + the
        static-preview offer (the project's history page) instead of a broken
        canvas, and <1024px viewports get the dismissible §13 desktop note.
      */}
      <EditorCapabilityGate slug={slug}>
        <EditorHost payload={resolution.payload} />
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
      */}
      <CommentsRegion
        workspaceId={resolution.payload.workspaceId}
        projectId={resolution.payload.manifest.project.id}
        projectName={resolution.payload.manifest.project.name}
      />
    </>
  );
}
