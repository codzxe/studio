"use client";

/**
 * HistoryPageView — the `/w/:slug/history` client root (BUILD_PLAN §M7 task 4:
 * "Version timeline; labels; restore with confirmation; diff summary" +
 * "Activity feed with actor, action, target, time; audit export").
 *
 * The RSC route (`app/(app)/w/[slug]/history/page.tsx`) resolves the project by
 * slug across the user's workspaces and hands this view ONE serializable
 * payload (project id/name, workspace id, current version id, the caller's
 * role-derived permissions, viewer/owner ids, an `nowIso` stamp). Everything
 * interactive lives here, composing the M7-H kit:
 *
 * - Overview tab — `HubOverview` (§8.6: metadata, lease-aware "Open editor"
 *   CTA, the Share action; W2-05).
 * - Versions tab — `VersionTimeline` (timeline, inline labels, restore
 *   confirm, diff summaries) through `@studio/api-client` same-origin calls.
 * - Comments tab — `HubComments` (the M7-F panel in degraded mode; W2-05).
 * - Renders tab — `RendersHubPanel` (queue/history; §M8 task 2).
 * - Activity tab — `ActivityFeed` (day-grouped, cursor-paginated audit feed).
 * - Right rail — `HubRightRail` (members with access, live lease status,
 *   asset count; §8.6; W2-05).
 * - Audit export — the admin-only "Export audit log" button →
 *   `client.activity.auditExport` → a JSON download. The api-client returns
 *   the PARSED payload (the gateway's Content-Disposition filename is
 *   mirrored client-side: `studio-audit-{project}.json`); ids/emails are
 *   compliance DATA in that file and nowhere else on the page (law #1).
 *
 * Authorization is role-derived from the RSC payload (editor+ can restore and
 * label; owner/admin can export) — the gateway re-checks every capability,
 * and the §M7 lease gate answers typed `LEASE_HELD` errors that surface
 * in place with message + hint + request id (§7.3/§14).
 */

import { createApiClient, isApiError } from "@studio/api-client";
import type { ApiClient, CallOptions } from "@studio/api-client";
import type {
  ActivityEntry,
  AuditExport,
  Page,
  ProjectManifest,
  ProjectVersion,
  RestoreVersionRequest,
  SetVersionLabelRequest,
  VersionDiffSummary,
  VersionTimelineEntry,
} from "@studio/contracts";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger, buttonVariants } from "@studio/ui";
import { CircleAlert, Download } from "lucide-react";
import { useCallback, useState } from "react";
import type { ReactElement } from "react";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { HubComments } from "@/components/hub/hub-comments";
import { HubOverview } from "@/components/hub/hub-overview";
import type { HubPort, ShareLinksPort } from "@/components/hub/hub-port";
import { HubRightRail } from "@/components/hub/hub-right-rail";
import { RendersHubPanel, type RendersHubPort } from "@/components/renders-hub/renders-panel";
import { VersionTimeline } from "@/components/versions/version-timeline";

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/**
 * The history surface `@studio/api-client` exposes. Production builds it from
 * `createApiClient` (same-origin `/v1` + `x-workspace-id`); tests fake it.
 */
export interface HistoryPort {
  /** GET /v1/projects/:id/versions — the §M7.4 timeline (cursor pages). */
  readonly listVersions: (query: {
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<Page<VersionTimelineEntry>>;
  /** GET /v1/projects/:id/activity — the audit feed (cursor pages). */
  readonly listActivity: (query: {
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<Page<ActivityEntry>>;
  /** GET /v1/projects/:id/versions/:versionId/diff — structural summary. */
  readonly diff: (versionId: string) => Promise<VersionDiffSummary>;
  /** POST …/restore — creates a NEW version (§9.3); confirmLabel required. */
  readonly restore: (
    versionId: string,
    body: RestoreVersionRequest,
    options?: CallOptions,
  ) => Promise<ProjectVersion>;
  /** POST …/label — D-24: the label is the ONLY mutable version field. */
  readonly setLabel: (
    versionId: string,
    body: SetVersionLabelRequest,
    options?: CallOptions,
  ) => Promise<ProjectVersion>;
  /** GET /v1/projects/:id/audit-export — admin-only, bounded JSON payload. */
  readonly auditExport: () => Promise<AuditExport>;
  /** GET /v1/projects/:id/manifest — the CURRENT version's signed URL (§9.2). */
  readonly manifest: () => Promise<ProjectManifest>;
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** Builds the production port for one project page load. */
export function createHistoryPort(workspaceId: string, projectId: string): HistoryPort {
  const client: ApiClient = createApiClient({
    baseUrl: API_BASE_URL,
    headers: { "x-workspace-id": workspaceId },
  });
  return {
    listVersions: (query) => client.versions.list(projectId, query),
    listActivity: (query) => client.activity.list(projectId, query),
    diff: (versionId) => client.versions.diff(projectId, versionId),
    restore: (versionId, body, options) =>
      client.versions.restore(projectId, versionId, body, options),
    setLabel: (versionId, body, options) =>
      client.versions.label(projectId, versionId, body, options),
    auditExport: () => client.activity.auditExport(projectId),
    manifest: () => client.projects.manifest(projectId),
  };
}

// ---------------------------------------------------------------------------
// Audit export download (mirrors the gateway's Content-Disposition filename)
// ---------------------------------------------------------------------------

/** Filename part: hostile ids can never smuggle path separators. */
export function sanitizeAuditFilePart(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe.length > 0 ? safe : "project";
}

/**
 * Saves the parsed export payload as a JSON download. The gateway serves the
 * same bytes as `attachment; filename="studio-audit-<project>.json"` — the
 * client (which returns the parsed payload, not the response) mirrors that
 * name so both entry points produce the same file.
 */
export function saveAuditExportFile(payload: AuditExport, projectId: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `studio-audit-${sanitizeAuditFilePart(projectId)}.json`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** §7.3-shaped action failure (§14: message + hint + request id). */
export interface HistoryActionError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

function toActionError(cause: unknown): HistoryActionError {
  if (isApiError(cause)) {
    return { message: cause.message, hint: cause.hint, requestId: cause.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

function boundedText(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorLine(error: HistoryActionError): string {
  const message = boundedText(error.message, 200);
  return error.requestId === undefined ? message : `${message} (${error.requestId})`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HistoryPageViewProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly workspaceId: string;
  readonly slug: string;
  /** The project's current version id — drives the timeline "Current" marker. */
  readonly currentVersionId: string | null;
  /** Editor+ (role owner/admin/editor) can restore and rename versions. */
  readonly canEdit: boolean;
  /** Owner/admin only — the audit export surface (`requireWorkspace("admin")`). */
  readonly canExport: boolean;
  /**
   * The calling user's id (`GET /v1/me` via the RSC payload) — hub "You"
   * labels. Optional so sibling surfaces keep compiling; the page always
   * passes it.
   */
  readonly viewerId?: string | null;
  /** The project's `createdBy` — resolved to an owner name on the Overview tab. */
  readonly ownerId?: string | null;
  /** ISO instant stamped by the RSC — pins the feed's relative times. */
  readonly nowIso: string;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: HistoryPort;
  /**
   * Renders tab port (§M8 task 2 — the project-hub renders surface).
   * Injectable for tests; production leaves it undefined and the panel
   * builds its own same-origin client.
   */
  readonly rendersApi?: RendersHubPort;
  /**
   * Hub port (W2-05 §8.6) — Overview tab + right rail. Injectable for
   * tests; production leaves it undefined and each hub component builds
   * its own same-origin client.
   */
  readonly hubApi?: HubPort;
  /** Share-links port (Overview's secondary Share action; tests inject). */
  readonly shareApi?: ShareLinksPort;
  /** URL opener seam for the current-version download (tests spy it). */
  readonly openUrl?: (url: string) => void;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function HistoryPageView({
  projectId,
  projectName,
  workspaceId,
  slug,
  currentVersionId,
  canEdit,
  canExport,
  viewerId = null,
  ownerId = null,
  nowIso,
  api,
  rendersApi,
  hubApi,
  shareApi,
  openUrl,
}: HistoryPageViewProps): ReactElement {
  const port = api ?? createHistoryPort(workspaceId, projectId);
  const open = openUrl ?? ((url: string) => window.open(url, "_blank", "noopener,noreferrer"));

  const [currentId, setCurrentId] = useState<string | null>(currentVersionId);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<HistoryActionError | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const runAuditExport = useCallback((): void => {
    setExportBusy(true);
    setExportError(null);
    setExportNote(null);
    void (async () => {
      try {
        const payload = await port.auditExport();
        saveAuditExportFile(payload, projectId);
        setExportBusy(false);
        setExportNote(
          payload.truncated
            ? `Downloaded the most recent ${payload.maxRows} events. Older events are not included.`
            : `Downloaded ${payload.rowCount} ${payload.rowCount === 1 ? "event" : "events"} as a JSON file.`,
        );
      } catch (cause) {
        setExportBusy(false);
        setExportError(toActionError(cause));
      }
    })();
  }, [port, projectId]);

  const runDownload = useCallback((): void => {
    // The ONLY version-bytes surface that exists is the CURRENT version's
    // signed URL on the manifest (§9.2) — the timeline only offers this
    // action on the current row.
    setDownloadBusy(true);
    setDownloadError(null);
    void (async () => {
      try {
        const manifest = await port.manifest();
        const url = manifest.currentVersion?.url;
        if (typeof url !== "string" || !(url.startsWith("http://") || url.startsWith("https://"))) {
          setDownloadBusy(false);
          setDownloadError("The download link could not be opened.");
          return;
        }
        setDownloadBusy(false);
        open(url);
      } catch (cause) {
        setDownloadBusy(false);
        setDownloadError(errorLine(toActionError(cause)));
      }
    })();
  }, [open, port]);

  return (
    <main id="main" data-testid="history-view" className="min-h-svh bg-app px-5 py-10">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-label uppercase tracking-[0.06em] text-muted">History</p>
            <h1
              className="mt-1 truncate text-title-l font-medium text-primary"
              data-testid="history-project-name"
            >
              {projectName}
            </h1>
            <p className="mt-1 text-body-s text-secondary">
              Every saved version and everything that happened on this project.
            </p>
          </div>
          <a
            href={`/w/${encodeURIComponent(slug)}/editor`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            data-testid="history-open-editor"
          >
            Open editor
          </a>
        </header>

        <div className="flex flex-col items-start gap-6 lg:flex-row">
          <Tabs defaultValue="versions" data-testid="history-tabs" className="min-w-0 w-full">
            <TabsList aria-label="History sections">
              <TabsTrigger value="overview" data-testid="history-tab-overview">
                Overview
              </TabsTrigger>
              <TabsTrigger value="versions" data-testid="history-tab-versions">
                Versions
              </TabsTrigger>
              <TabsTrigger value="comments" data-testid="history-tab-comments">
                Comments
              </TabsTrigger>
              <TabsTrigger value="renders" data-testid="history-tab-renders">
                Renders
              </TabsTrigger>
              <TabsTrigger value="activity" data-testid="history-tab-activity">
                Activity
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-4" data-testid="history-panel-overview">
              <HubOverview
                projectId={projectId}
                projectName={projectName}
                workspaceId={workspaceId}
                slug={slug}
                viewerId={viewerId}
                ownerId={ownerId}
                canEdit={canEdit}
                nowIso={nowIso}
                api={hubApi}
                shareApi={shareApi}
              />
            </TabsContent>

            <TabsContent value="versions" className="mt-4" data-testid="history-panel-versions">
              <VersionTimeline
                currentVersionId={currentId}
                fetchPage={port.listVersions}
                fetchDiff={port.diff}
                restore={canEdit ? port.restore : undefined}
                setLabel={canEdit ? port.setLabel : undefined}
                onDownload={currentId === null ? undefined : runDownload}
                onCurrentVersionChange={setCurrentId}
                editorHref={`/w/${encodeURIComponent(slug)}/editor`}
              />
              {downloadBusy ? (
                <p className="mt-3 text-caption text-muted" data-testid="history-download-busy">
                  Preparing the download…
                </p>
              ) : null}
              {downloadError !== null ? (
                <p
                  role="alert"
                  data-testid="history-download-error"
                  className="mt-3 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
                >
                  <CircleAlert
                    size={16}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className="shrink-0 text-danger"
                  />
                  {downloadError}
                </p>
              ) : null}
            </TabsContent>

            <TabsContent value="comments" className="mt-4" data-testid="history-panel-comments">
              <HubComments
                workspaceId={workspaceId}
                projectId={projectId}
                projectName={projectName}
                viewerId={viewerId}
              />
            </TabsContent>

            <TabsContent value="renders" className="mt-4" data-testid="history-panel-renders">
              <RendersHubPanel
                projectId={projectId}
                workspaceId={workspaceId}
                canQueue={canEdit}
                nowIso={nowIso}
                editorHref={`/w/${encodeURIComponent(slug)}/editor`}
                api={rendersApi}
              />
            </TabsContent>

            <TabsContent value="activity" className="mt-4" data-testid="history-panel-activity">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-caption text-muted">
                  Actions by everyone with access, newest first.
                </p>
                {canExport ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={exportBusy}
                    disabled={exportBusy}
                    onClick={runAuditExport}
                    data-testid="audit-export-button"
                  >
                    <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                    Export audit log
                  </Button>
                ) : null}
              </div>
              {exportError !== null ? (
                <div
                  role="alert"
                  data-testid="audit-export-error"
                  className="mb-4 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
                >
                  <CircleAlert
                    size={16}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-danger"
                  />
                  <span className="min-w-0 flex-1">
                    {errorLine(exportError)}
                    {exportError.hint === undefined ? null : (
                      <span className="block text-muted">{boundedText(exportError.hint, 160)}</span>
                    )}
                  </span>
                </div>
              ) : null}
              {exportNote !== null ? (
                <p
                  data-testid="audit-export-note"
                  className="mb-4 rounded-sm border border-border bg-elevated/40 px-3 py-2 text-caption text-secondary"
                >
                  {exportNote}
                </p>
              ) : null}
              <ActivityFeed fetchPage={port.listActivity} nowIso={nowIso} />
            </TabsContent>
          </Tabs>

          {/* §8.6 right rail — members with access, lease status, asset count. */}
          <HubRightRail
            workspaceId={workspaceId}
            projectId={projectId}
            viewerId={viewerId}
            canEdit={canEdit}
            api={hubApi}
          />
        </div>
      </div>
    </main>
  );
}
