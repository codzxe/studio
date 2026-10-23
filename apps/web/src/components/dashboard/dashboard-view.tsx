"use client";

/**
 * DashboardView (W2-03, §8.4) — the `/w` client root.
 *
 * The RSC route (`app/(app)/w/(shell)/page.tsx`) resolves the workspace
 * (lib/workspace-membership: `/v1/me → memberships`, `?ws`, no-membership →
 * `/onboarding`) and fetches the ONE projects read (`GET /v1/projects` page
 * 1, limit 12) through the gateway seam, then hands this component a
 * serializable payload. Everything interactive lives here:
 *
 * - time-aware greeting (not cute, §8.4) — derived from the RSC-stamped
 *   `nowIso` so SSR and client render identically (the house pattern: the
 *   billing/history pages stamp `nowIso` for the same reason);
 * - actions row: New project (the ONE primary, opens the dialog) +
 *   Import .ecproj (secondary, opens the import dialog);
 * - Recent grid: ≤8 ProjectCards with the 40ms slate stagger (§6.3) — the
 *   16:9 slate thumbnail is the designed §7.3 honest stand-in (real
 *   thumbnails arrive with a thumbnail route), and `— · 0 comps` is the
 *   honest duration/comps stand-in (Project rows carry neither in v1);
 * - EmptyState "No projects yet." carries the same two actions (§7.12 one
 *   primary) — when it renders, the header actions row hides so exactly ONE
 *   "New project" button is visible at a time (§7.1 one primary per view);
 *   with `hasWorkspace: false` (embedded/test arm — the /w RSC redirects
 *   no-membership users to /onboarding first) it also links /onboarding;
 * - loading: 6 skeleton cards, never a spinner (§8.4);
 * - error: one inline banner + retry through the port; the greeting and
 *   actions stay usable (§8.4 "keep the rest of the page usable").
 *
 * The dialogs compose the narrow create/upload seams of {@link DashboardPort}
 * (the asBillingPort pattern): production builds it from `createApiClient`
 * same-origin with the workspace header; tests fake it.
 */

import { type ApiClient, type CallOptions, createApiClient } from "@studio/api-client";
import type { CreateProjectRequest, Page, Project, ProjectVersion } from "@studio/contracts";
import { Button, EmptyState, FrameLine, ProjectCard, Skeleton } from "@studio/ui";
import { CircleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useState } from "react";

import { formatTimeAgo } from "../activity/activity-feed";
import { ImportProjectDialog, type ImportUploadInput } from "./import-project-dialog";
import { NewProjectDialog } from "./new-project-dialog";

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/**
 * The upload input the dashboard needs — `baseVersionId` NULLABLE for the
 * imported file's FIRST version (§9.3). The api-client's own input type is
 * being widened to match by sibling W3-G2 in this same wave.
 */
export type DashboardUploadInput = ImportUploadInput;

/** The dashboard's gateway surface. Production: `asDashboardPort(client)`. */
export interface DashboardPort {
  readonly projects: {
    /** GET /v1/projects — page 1 of the Recent grid. */
    readonly list: (query?: { readonly limit?: number }) => Promise<Page<Project>>;
    /** POST /v1/projects — the New project dialog. */
    readonly create: (body: CreateProjectRequest, options?: CallOptions) => Promise<Project>;
  };
  readonly versions: {
    /** POST /v1/projects/:id/versions — the Import .ecproj dialog. */
    readonly upload: (
      projectId: string,
      input: DashboardUploadInput,
      options?: CallOptions,
    ) => Promise<ProjectVersion>;
  };
}

/**
 * Compile-time pin (and tiny adapter): the production `ApiClient` satisfies
 * {@link DashboardPort} — the view never hand-rolls a call.
 */
export function asDashboardPort(client: ApiClient): DashboardPort {
  return {
    projects: {
      list: (query) => client.projects.list(query),
      create: client.projects.create,
    },
    versions: {
      upload: (projectId, input, options) =>
        client.versions.upload(
          projectId,
          // TODO(W3-G2, same wave): drop this cast once the sibling task
          // widens ApiClient["versions"]["upload"]'s input to
          // `baseVersionId: string | null` (the gateway already accepts null
          // for a project's FIRST snapshot — services/gateway
          // routes/versions.ts UPLOAD_VERSION_GATEWAY_SCHEMA). This is the
          // ONE call site; client.ts is sibling-owned and NOT edited here.
          // The value passes through unchanged — type-only.
          input as unknown as Parameters<typeof client.versions.upload>[1],
          options,
        ),
    },
  };
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** Builds the production port for one workspace page load. */
function createDefaultDashboardPort(workspaceId: string): DashboardPort {
  return asDashboardPort(
    createApiClient({ baseUrl: API_BASE_URL, headers: { "x-workspace-id": workspaceId } }),
  );
}

// ---------------------------------------------------------------------------
// Payload types (the RSC hand-off)
// ---------------------------------------------------------------------------

/** One Recent-grid row — the slice of the Project wire the view renders. */
export interface DashboardProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly updatedAt: string;
}

/** A bounded §7.3 failure surface (message + hint + request id, §14). */
export interface DashboardLoadError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

export interface DashboardViewProps {
  /** The active workspace — scopes the production port's header. */
  readonly workspaceId: string;
  /** Display name for the greeting; null → the greeting stands alone. */
  readonly userName: string | null;
  /** ISO instant stamped by the RSC — the greeting bucket + relative times. */
  readonly nowIso: string;
  /**
   * Server-fetched page-1 rows. `null` = the read failed (see initialError)
   * or is in flight — the view shows the error banner / 6 skeletons.
   */
  readonly initialProjects: readonly DashboardProject[] | null;
  /** Why the server-side read failed, when it did (§8.4 error state). */
  readonly initialError: DashboardLoadError | null;
  /**
   * False only when the hosting surface has no workspace context — the /w
   * RSC redirects no-membership users to /onboarding before rendering, so
   * production keeps the default; the arm covers embedded reuse and pins
   * the manifest's "if no workspace was ever created" affordance.
   */
  readonly hasWorkspace?: boolean;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: DashboardPort;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** §8.4 wireframe: 3 cards per row at desktop width. */
const RECENT_GRID_CLASS = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

/** The Recent grid caps at 8 cards (§6.3 stagger: index × 40ms, max 8). */
const RECENT_LIMIT = 8;

/** Stable keys for the 6 static skeleton cards (§8.4 loading state). */
const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;

/** The server read's page size (manifest W2-03: page 1, limit 12). */
const PROJECTS_PAGE_LIMIT = 12;

/**
 * Time-of-day greeting from the hour [0,24) — "Good morning/afternoon/
 * evening", never cute (§8.4). Deterministic from the RSC-stamped nowIso so
 * server and client markup match.
 */
export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** UTC hour of an ISO instant; null when unparseable (hostile input). */
function hourFromIso(nowIso: string): number | null {
  const date = new Date(nowIso);
  return Number.isNaN(date.getTime()) ? null : date.getUTCHours();
}

/** Greeting line: "Good evening, Alex" / "Good evening." — hostile input degrades. */
export function greetingLine(userName: string | null, nowIso: string): string {
  const hour = hourFromIso(nowIso);
  const greeting = hour === null ? "Welcome" : greetingForHour(hour);
  const trimmed = userName?.trim();
  return trimmed ? `${greeting}, ${trimmed}` : `${greeting}.`;
}

/** `Page<Project>` wire → the view's rows (malformed rows are dropped). */
export function toDashboardProjects(page: Page<Project>): readonly DashboardProject[] {
  const out: DashboardProject[] = [];
  for (const project of page.items) {
    if (
      typeof project?.id !== "string" ||
      typeof project.name !== "string" ||
      typeof project.slug !== "string" ||
      typeof project.updatedAt !== "string"
    ) {
      continue;
    }
    out.push({
      id: project.id,
      name: project.name,
      slug: project.slug,
      updatedAt: project.updatedAt,
    });
  }
  return out;
}

/** Typed §7.3 failure → the bounded banner surface; anything else → generic. */
function toLoadError(cause: unknown): DashboardLoadError {
  // The read goes through the api-client port (client-side retries), so the
  // typed surface is ApiError; the RSC pre-parses its own arm server-side.
  if (cause instanceof Error && "code" in cause && "requestId" in cause) {
    const typed = cause as { message?: string; hint?: string; requestId?: string };
    return {
      message:
        typeof typed.message === "string" ? typed.message : "Your projects could not be loaded.",
      hint: typeof typed.hint === "string" ? typed.hint : undefined,
      requestId: typeof typed.requestId === "string" ? typed.requestId : undefined,
    };
  }
  return { message: "Your projects could not be loaded.", hint: "Try again in a moment." };
}

/** One skeleton card — preserves the ProjectCard footprint (§7.13 no shift). */
function DashboardSkeletonCard(): ReactElement {
  return (
    <div
      data-testid="dashboard-skeleton-card"
      className="overflow-hidden rounded-md border border-border bg-panel"
    >
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DashboardView
// ---------------------------------------------------------------------------

export function DashboardView({
  workspaceId,
  userName,
  nowIso,
  initialProjects,
  initialError,
  hasWorkspace = true,
  api,
}: DashboardViewProps): ReactElement {
  const router = useRouter();
  const port = api ?? createDefaultDashboardPort(workspaceId);

  const [projects, setProjects] = useState<readonly DashboardProject[] | null>(initialProjects);
  const [loadError, setLoadError] = useState<DashboardLoadError | null>(initialError);
  const [reloading, setReloading] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const retry = (): void => {
    if (reloading) return;
    setReloading(true);
    setLoadError(null);
    port.projects
      .list({ limit: PROJECTS_PAGE_LIMIT })
      .then((page) => {
        setProjects(toDashboardProjects(page));
        setReloading(false);
      })
      .catch((cause: unknown) => {
        // Keep any previously-loaded rows visible under the banner (§8.4:
        // the rest of the page stays usable); a still-empty read keeps null.
        setLoadError(toLoadError(cause));
        setReloading(false);
      });
  };

  const recent = projects?.slice(0, RECENT_LIMIT) ?? null;
  // §8.4 state machine — skeletons mean LOADING (retry in flight, or the
  // defensive null-payload arm), never an error; an error with no rows
  // renders the banner alone (the rows are unknown, not loading, not empty).
  const showSkeletons = reloading || (projects === null && loadError === null);
  const isEmpty = projects !== null && projects.length === 0;
  // §7.1 one primary per view: while the EmptyState owns the actions (§7.12
  // one primary + secondary), the header actions row hides — exactly ONE
  // "New project" button is visible in every state.
  const showHeaderActions = !isEmpty;

  return (
    <main id="main" data-testid="dashboard-view" className="min-h-svh bg-app px-5 py-10">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8">
        <header
          data-testid="dashboard-header"
          className="flex flex-wrap items-end justify-between gap-4"
        >
          <h1 data-testid="dashboard-greeting" className="text-title-l font-medium text-primary">
            {greetingLine(userName, nowIso)}
          </h1>
          {showHeaderActions ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="dashboard-actions">
              <Button data-testid="dashboard-new-project" onClick={() => setNewProjectOpen(true)}>
                New project
              </Button>
              <Button
                variant="secondary"
                data-testid="dashboard-import"
                onClick={() => setImportOpen(true)}
              >
                Import .ecproj
              </Button>
            </div>
          ) : null}
        </header>

        {loadError !== null ? (
          <div
            role="alert"
            data-testid="dashboard-error"
            className="flex flex-wrap items-start gap-3 rounded-sm border border-danger/40 bg-danger/10 p-4"
          >
            <CircleAlert
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-danger"
            />
            <div className="min-w-0 flex-1" data-testid="dashboard-error-copy">
              <p className="text-body-s text-primary">{loadError.message}</p>
              {loadError.hint !== undefined ? (
                <p className="mt-0.5 text-caption text-secondary">{loadError.hint}</p>
              ) : null}
              {loadError.requestId !== undefined ? (
                <p className="mt-0.5 text-caption text-muted">Request {loadError.requestId}</p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="secondary"
              data-testid="dashboard-retry"
              loading={reloading}
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        ) : null}

        <section aria-label="Recent projects" data-testid="dashboard-recent">
          <FrameLine label="00:00:00 — RECENT" draw />
          <div className="mt-5">
            {showSkeletons ? (
              // §8.4 loading: 6 skeleton cards, not a spinner.
              <div className={RECENT_GRID_CLASS} data-testid="dashboard-skeleton-grid">
                {SKELETON_KEYS.map((key) => (
                  <DashboardSkeletonCard key={key} />
                ))}
              </div>
            ) : isEmpty ? (
              <EmptyState
                data-testid="dashboard-empty"
                title="No projects yet."
                action={
                  <>
                    <Button
                      data-testid="dashboard-empty-new-project"
                      onClick={() => setNewProjectOpen(true)}
                    >
                      New project
                    </Button>
                    <Button
                      variant="secondary"
                      data-testid="dashboard-empty-import"
                      onClick={() => setImportOpen(true)}
                    >
                      Import .ecproj
                    </Button>
                  </>
                }
                secondaryLink={
                  hasWorkspace ? undefined : { label: "Create a workspace", href: "/onboarding" }
                }
              />
            ) : recent !== null ? (
              <div className={RECENT_GRID_CLASS} data-testid="dashboard-grid">
                {recent.map((project, index) => (
                  <ProjectCard
                    key={project.id}
                    data-testid="dashboard-project-card"
                    name={project.name}
                    // Honest stand-ins until the manifest/thumbnail reads
                    // land (§7.3): the wire's Project row carries neither
                    // duration nor composition counts.
                    duration="—"
                    comps={0}
                    updated={`Updated ${formatTimeAgo(project.updatedAt, nowIso)}`}
                    stagger={index * 40}
                    onOpen={() => router.push(`/w/${project.slug}/history`)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        createProject={port.projects.create}
      />
      <ImportProjectDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        createProject={port.projects.create}
        uploadVersion={port.versions.upload}
      />
    </main>
  );
}
