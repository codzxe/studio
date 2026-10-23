"use client";

/**
 * ProjectsListView — the /w/projects client root (W2-04, §8.5).
 *
 * The RSC route resolves the workspace (lib/workspace-membership) and hands
 * this view the FIRST page of the active (unarchived) window (limit 50).
 * Everything interactive lives here:
 *
 * - Grid/table toggle (default grid) — `?view=`.
 * - Filters All / Mine / Shared / Archived — `?filter=`. Archived switches to
 *   the archived-only window via the real API `archived:true` param (W1-c)
 *   through the `loadProjectsPage` server action; Mine/Shared filter the
 *   loaded window client-side by `createdBy === me.user.id`.
 * - Sort Updated / Created / Name — client-side (the wire has no sort param).
 * - Debounced search (250ms) over the LOADED pages — `?q=`. HONEST LIMIT:
 *   PROJECTS_QUERY_SCHEMA carries only `archived` + pagination (no server
 *   search/sort/shared-filter), so v1 filters the loaded window client-side
 *   and the field is labelled "Search loaded projects" accordingly.
 * - Bulk select with Archive/Restore (`projects.patch`), Duplicate
 *   (`projects.duplicate` — 429 QUOTA_EXCEEDED surfaces typed) and Delete
 *   (danger ConfirmDialog, type-to-confirm §7.5, soft delete §9.1).
 * - "Load more" on `nextCursor` (§8.5: no janky auto-load).
 * - Empty search: "No projects match 'x'." + clear filters.
 * - Per-card link → /w/[slug]/history (the hub owns per-project actions).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY; action
 * failures land in ONE typed banner (`projects-bulk-error`) with the §7.3
 * message + hint + request id (§14).
 */

import { type ApiClient, type CallOptions, createApiClient, isApiError } from "@studio/api-client";
import type { PatchProjectRequest } from "@studio/contracts";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ProjectCard,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@studio/ui";
import { CircleAlert, LayoutGrid, Rows3 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { loadProjectsPage } from "@/app/(app)/w/(shell)/projects/actions";
import { formatTimeAgo } from "@/components/activity/activity-feed";
import { BulkActionsBar } from "./bulk-actions-bar";
import {
  PROJECTS_PAGE_LIMIT,
  type ProjectsListRow,
  type ProjectsPageError,
  type ProjectsPageResult,
} from "./projects-wire";

// ---------------------------------------------------------------------------
// Filter / sort / view vocabularies (§8.5)
// ---------------------------------------------------------------------------

export type ProjectsFilter = "all" | "mine" | "shared" | "archived";
export type ProjectsSort = "updated" | "created" | "name";
export type ProjectsViewMode = "grid" | "table";

/** Search debounce (ms) — rapid keystrokes coalesce to one commit. */
const SEARCH_DEBOUNCE_MS = 250;

const FILTERS: readonly { readonly value: ProjectsFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "shared", label: "Shared" },
  { value: "archived", label: "Archived" },
];

function asFilter(value: string | null): ProjectsFilter {
  return value === "mine" || value === "shared" || value === "archived" ? value : "all";
}

function asSort(value: string | null): ProjectsSort {
  return value === "created" || value === "name" ? value : "updated";
}

function asViewMode(value: string | null): ProjectsViewMode {
  return value === "table" ? "table" : "grid";
}

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real client + server action satisfy
// ---------------------------------------------------------------------------

/** List query — mirrors PROJECTS_QUERY_SCHEMA (cursor/limit/archived). */
export interface ProjectsListQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly archived?: boolean;
}

/**
 * The projects surface the browser needs. Production builds `list` from the
 * `loadProjectsPage` server action (the `archived` param + window-consistent
 * cursors — see actions.ts for why `client.projects.list` cannot carry them
 * yet) and the mutations from `@studio/api-client` (same-origin `/v1` +
 * `x-workspace-id`); tests fake it.
 */
export interface ProjectsListPort {
  readonly list: (query: ProjectsListQuery) => Promise<ProjectsPageResult>;
  readonly patch: (
    id: string,
    body: PatchProjectRequest,
    options?: CallOptions,
  ) => Promise<ProjectsListRow>;
  readonly delete: (id: string, options?: CallOptions) => Promise<null>;
  readonly duplicate: (id: string, options?: CallOptions) => Promise<ProjectsListRow>;
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/**
 * Compile-time pin: the production mutation surface is `ApiClient["projects"]`
 * (`Project` from contracts satisfies {@link ProjectsListRow} structurally).
 */
export function asProjectsMutationPort(
  client: ApiClient,
): Pick<ProjectsListPort, "patch" | "delete" | "duplicate"> {
  return {
    patch: (id, body, options) => client.projects.patch(id, body, options),
    delete: (id, options) => client.projects.delete(id, options),
    duplicate: (id, options) => client.projects.duplicate(id, options),
  };
}

/** Builds the production port for one workspace page load. */
export function createProjectsListPort(workspaceId: string): ProjectsListPort {
  const client: ApiClient = createApiClient({
    baseUrl: API_BASE_URL,
    headers: { "x-workspace-id": workspaceId },
  });
  return {
    list: (query) => loadProjectsPage(workspaceId, query),
    ...asProjectsMutationPort(client),
  };
}

// ---------------------------------------------------------------------------
// Errors (§7.3 message + hint + request id — one typed surface)
// ---------------------------------------------------------------------------

function toBulkError(cause: unknown): ProjectsPageError {
  if (isApiError(cause)) {
    return { message: cause.message, hint: cause.hint, requestId: cause.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

function errorLine(error: ProjectsPageError): string {
  const message = error.message.length > 200 ? `${error.message.slice(0, 199)}…` : error.message;
  return error.requestId === undefined ? message : `${message} (${error.requestId})`;
}

function errorBanner(error: ProjectsPageError): ReactElement {
  return (
    <div
      role="alert"
      data-testid="projects-bulk-error"
      className="flex flex-col gap-1 rounded-sm border border-danger/30 bg-danger/10 p-4 text-body-s"
    >
      <span className="font-medium text-primary">{error.message}</span>
      {error.hint !== undefined && <span className="text-secondary">{error.hint}</span>}
      {error.requestId !== undefined && (
        <span className="text-caption text-muted">Request id {error.requestId}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sorting / window state
// ---------------------------------------------------------------------------

function instantMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function compareRows(a: ProjectsListRow, b: ProjectsListRow, sort: ProjectsSort): number {
  if (sort === "name") return a.name.localeCompare(b.name);
  if (sort === "created") return instantMs(b.createdAt) - instantMs(a.createdAt);
  return instantMs(b.updatedAt) - instantMs(a.updatedAt);
}

/** One loading window (active or archived) of accumulated cursor pages. */
interface WindowState {
  readonly items: readonly ProjectsListRow[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly loaded: boolean;
}

const EMPTY_WINDOW: WindowState = {
  items: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
};

/** Append a page, deduping by id (idempotent on replays). */
function mergeRows(
  current: readonly ProjectsListRow[],
  page: readonly ProjectsListRow[],
): readonly ProjectsListRow[] {
  const seen = new Set(current.map((row) => row.id));
  const merged = [...current];
  for (const row of page) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

/** Stable keys for the loading skeletons (no index-as-key). */
const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ProjectsListViewProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** `me.user.id` — drives the Mine/Shared client-side filters. */
  readonly userId: string;
  /** owner/admin/editor — the bulk mutation affordances (gateway re-checks). */
  readonly canEdit: boolean;
  /** First page of the ACTIVE (unarchived) window, from the RSC read. */
  readonly initialItems: readonly ProjectsListRow[];
  readonly initialNextCursor: string | null;
  /** ISO instant stamped by the RSC — pins the relative times. */
  readonly nowIso: string;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: ProjectsListPort;
  /** Search debounce in ms (tests shrink it). */
  readonly debounceMs?: number;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function ProjectsListView({
  workspaceId,
  workspaceName,
  userId,
  canEdit,
  initialItems,
  initialNextCursor,
  nowIso,
  api,
  debounceMs,
}: ProjectsListViewProps): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [port] = useState<ProjectsListPort>(() => api ?? createProjectsListPort(workspaceId));
  const portRef = useRef(port);
  portRef.current = port;

  // -- URL-seeded state (?q= &view= &filter= — §8.5 URL state) --------------
  const [filter, setFilter] = useState<ProjectsFilter>(() => asFilter(searchParams.get("filter")));
  const [viewMode, setViewMode] = useState<ProjectsViewMode>(() =>
    asViewMode(searchParams.get("view")),
  );
  const [sortKey, setSortKey] = useState<ProjectsSort>("updated");
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");

  // -- windows ---------------------------------------------------------------
  const [active, setActive] = useState<WindowState>(() => ({
    items: initialItems,
    nextCursor: initialNextCursor,
    loading: false,
    loadingMore: false,
    error: null,
    loaded: true,
  }));
  const [archived, setArchived] = useState<WindowState>(EMPTY_WINDOW);

  // -- bulk state --------------------------------------------------------------
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<ProjectsPageError | null>(null);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // -- URL writes (state is the source of truth; the URL mirrors it) ----------
  const writeUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      router.replace(qs === "" ? pathname : `${pathname}?${qs}`);
    },
    [pathname, router, searchParams],
  );

  // Debounced search commit (§8.5): rapid keystrokes coalesce into one
  // `query` commit + one `?q=` write.
  useEffect(() => {
    if (searchInput === query) return;
    const timer = setTimeout(() => {
      setQuery(searchInput);
      writeUrl({ q: searchInput === "" ? null : searchInput });
    }, debounceMs ?? SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, query, debounceMs, writeUrl]);

  // The archived window loads lazily: first switch to the Archived filter
  // (or a hard load with ?filter=archived) fetches page 1 through the port.
  const archivedInFlight = useRef(false);
  const archivedAutoLoaded = useRef(false);
  const loadArchivedFirst = useCallback(async (): Promise<void> => {
    if (archivedInFlight.current) return;
    archivedInFlight.current = true;
    setArchived((window) => ({ ...window, loading: true, error: null }));
    const result = await portRef.current.list({ archived: true, limit: PROJECTS_PAGE_LIMIT });
    archivedInFlight.current = false;
    if (result.ok) {
      setArchived({
        items: result.items,
        nextCursor: result.nextCursor,
        loading: false,
        loadingMore: false,
        error: null,
        loaded: true,
      });
    } else {
      setArchived((window) => ({ ...window, loading: false, error: errorLine(result.error) }));
    }
  }, []);

  useEffect(() => {
    if (filter !== "archived" || archivedAutoLoaded.current || archived.loaded) return;
    archivedAutoLoaded.current = true;
    void loadArchivedFirst();
  }, [filter, archived.loaded, loadArchivedFirst]);

  const loadMoreInFlight = useRef(false);
  const loadMore = useCallback(async (): Promise<void> => {
    if (loadMoreInFlight.current) return;
    const isArchivedWindow = filter === "archived";
    const window = isArchivedWindow ? archived : active;
    const cursor = window.nextCursor;
    if (cursor === null || window.loading || window.loadingMore) return;
    loadMoreInFlight.current = true;
    const setter = isArchivedWindow ? setArchived : setActive;
    setter((current) => ({ ...current, loadingMore: true, error: null }));
    const result = await portRef.current.list({
      cursor,
      limit: PROJECTS_PAGE_LIMIT,
      ...(isArchivedWindow ? { archived: true } : {}),
    });
    loadMoreInFlight.current = false;
    if (result.ok) {
      setter((current) => ({
        ...current,
        items: mergeRows(current.items, result.items),
        nextCursor: result.nextCursor,
        loadingMore: false,
      }));
    } else {
      setter((current) => ({ ...current, loadingMore: false, error: errorLine(result.error) }));
    }
  }, [filter, archived, active]);

  // -- derived display list ----------------------------------------------------
  const currentWindow = filter === "archived" ? archived : active;
  const trimmedQuery = query.trim().toLowerCase();
  const displayed = useMemo(() => {
    let rows = currentWindow.items;
    if (filter === "mine") rows = rows.filter((row) => row.createdBy === userId);
    else if (filter === "shared") rows = rows.filter((row) => row.createdBy !== userId);
    if (trimmedQuery !== "")
      rows = rows.filter((row) => row.name.toLowerCase().includes(trimmedQuery));
    return [...rows].sort((a, b) => compareRows(a, b, sortKey));
  }, [currentWindow.items, filter, userId, trimmedQuery, sortKey]);

  // -- selection -----------------------------------------------------------------
  function toggleSelected(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allVisibleSelected = displayed.length > 0 && displayed.every((row) => selected.has(row.id));

  function toggleSelectAllVisible(): void {
    setSelected((current) => {
      if (displayed.every((row) => current.has(row.id))) {
        const next = new Set(current);
        for (const row of displayed) next.delete(row.id);
        return next;
      }
      const next = new Set(current);
      for (const row of displayed) next.add(row.id);
      return next;
    });
  }

  function changeFilter(next: ProjectsFilter): void {
    if (next === filter) return;
    setFilter(next);
    setSelected(new Set());
    writeUrl({ filter: next === "all" ? null : next });
  }

  function changeViewMode(next: ProjectsViewMode): void {
    if (next === viewMode) return;
    setViewMode(next);
    writeUrl({ view: next === "grid" ? null : next });
  }

  function clearFilters(): void {
    setSearchInput("");
    setQuery("");
    setFilter("all");
    setSelected(new Set());
    writeUrl({ q: null, filter: null });
  }

  // -- bulk mutations -------------------------------------------------------------
  interface BulkOutcome<T> {
    readonly ok: ReadonlyArray<{ readonly id: string; readonly value: T }>;
    readonly failure: ProjectsPageError | null;
    readonly failedCount: number;
  }

  async function runBulk<T>(
    ids: readonly string[],
    mutate: (id: string) => Promise<T>,
  ): Promise<BulkOutcome<T>> {
    const settled = await Promise.allSettled(ids.map((id) => mutate(id)));
    const ok: { id: string; value: T }[] = [];
    let failure: ProjectsPageError | null = null;
    let failedCount = 0;
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      const id = ids[index];
      if (id === undefined || outcome === undefined) continue;
      if (outcome.status === "fulfilled") {
        ok.push({ id, value: outcome.value });
      } else {
        failedCount += 1;
        if (failure === null) failure = toBulkError(outcome.reason);
      }
    }
    return { ok, failure, failedCount };
  }

  function applyOutcome<T>(
    outcome: BulkOutcome<T>,
    apply: (okId: string, value: T) => void,
    note: (count: number) => string,
  ): void {
    for (const entry of outcome.ok) apply(entry.id, entry.value);
    const okIds = new Set(outcome.ok.map((entry) => entry.id));
    setSelected((current) => {
      const next = new Set(current);
      for (const id of okIds) next.delete(id);
      return next;
    });
    if (outcome.ok.length > 0) setBulkNote(note(outcome.ok.length));
    if (outcome.failure !== null) setBulkError(outcome.failure);
  }

  async function handleArchiveOrRestore(): Promise<void> {
    if (bulkBusy || selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    setBulkNote(null);
    const archiving = filter !== "archived";
    const outcome = await runBulk([...selected], (id) => port.patch(id, { archived: archiving }));
    applyOutcome(
      outcome,
      (_id, row) => {
        if (archiving) {
          setActive((window) => ({
            ...window,
            items: window.items.filter((p) => p.id !== row.id),
          }));
          // The row now lives in the archived window — add it there too when
          // that window has been loaded, so switching filters shows it.
          setArchived((window) =>
            window.loaded ? { ...window, items: mergeRows(window.items, [row]) } : window,
          );
        } else {
          setArchived((window) => ({
            ...window,
            items: window.items.filter((p) => p.id !== row.id),
          }));
          setActive((window) => ({ ...window, items: mergeRows([row], window.items) }));
        }
      },
      (count) =>
        `${archiving ? "Archived" : "Restored"} ${count} ${count === 1 ? "project" : "projects"}.`,
    );
    setBulkBusy(false);
  }

  async function duplicateIds(ids: readonly string[]): Promise<void> {
    if (bulkBusy || ids.length === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    setBulkNote(null);
    const outcome = await runBulk(ids, (id) => port.duplicate(id));
    applyOutcome(
      outcome,
      (_id, row) => {
        // The copy starts unarchived — it belongs to the active window.
        setActive((window) => ({ ...window, items: mergeRows([row], window.items) }));
      },
      (count) => `Duplicated ${count} ${count === 1 ? "project" : "projects"}.`,
    );
    setBulkBusy(false);
  }

  async function confirmDelete(): Promise<void> {
    if (bulkBusy || selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    setBulkNote(null);
    const outcome = await runBulk([...selected], (id) => port.delete(id));
    applyOutcome(
      outcome,
      (id) => {
        setActive((window) => ({ ...window, items: window.items.filter((p) => p.id !== id) }));
        setArchived((window) => ({ ...window, items: window.items.filter((p) => p.id !== id) }));
      },
      (count) => `Deleted ${count} ${count === 1 ? "project" : "projects"}.`,
    );
    setBulkBusy(false);
    setDeleteOpen(false);
  }

  // -- rendering helpers ------------------------------------------------------------
  function openPath(row: ProjectsListRow): string {
    return `/w/${row.slug}/history`;
  }

  function gridCard(row: ProjectsListRow, index: number): ReactElement {
    const isSelected = selected.has(row.id);
    return (
      <div
        key={row.id}
        data-testid={`projects-card-${row.id}`}
        className="relative"
        data-selected={isSelected || undefined}
      >
        <label className="absolute top-2 left-2 z-10 flex h-6 w-6 items-center justify-center rounded-sm border border-border bg-app/90">
          <input
            type="checkbox"
            className="size-4 accent-signal"
            checked={isSelected}
            onChange={() => toggleSelected(row.id)}
            aria-label={`Select ${row.name}`}
            data-testid={`projects-select-${row.id}`}
          />
        </label>
        {row.archived ? (
          <Badge variant="warning" className="absolute top-2 right-2 z-10">
            Archived
          </Badge>
        ) : null}
        <ProjectCard
          name={row.name}
          // Honest stand-ins (the list wire carries neither duration nor
          // comps — the hub manifest owns them; mirrors the slate-thumbnail
          // precedent): "— · 0 comps" until a comps seam lands.
          duration="—"
          comps={0}
          updated={`Updated ${formatTimeAgo(row.updatedAt, nowIso)}`}
          stagger={index < 8 ? index * 40 : undefined}
          onOpen={() => router.push(openPath(row))}
          onDuplicate={() => {
            void duplicateIds([row.id]);
          }}
          // v1: "more" opens the hub — the per-project action surface.
          onMore={() => router.push(openPath(row))}
        />
      </div>
    );
  }

  const selectAllCheckbox = (
    <input
      type="checkbox"
      className="size-4 accent-signal"
      checked={allVisibleSelected}
      onChange={toggleSelectAllVisible}
      aria-label="Select all loaded projects"
      data-testid="projects-select-all"
    />
  );

  function tableRow(row: ProjectsListRow): ReactElement {
    const isSelected = selected.has(row.id);
    return (
      <TableRow key={row.id} selected={isSelected} data-testid={`projects-row-${row.id}`}>
        <TableCell className="w-10">
          <input
            type="checkbox"
            className="size-4 accent-signal"
            checked={isSelected}
            onChange={() => toggleSelected(row.id)}
            aria-label={`Select ${row.name}`}
            data-testid={`projects-select-${row.id}`}
          />
        </TableCell>
        <TableCell>
          <Link
            href={openPath(row)}
            className="text-body-s text-primary underline-offset-3 hover:text-signal hover:underline"
          >
            {row.name}
          </Link>
        </TableCell>
        <TableCell>{row.createdBy === userId ? "You" : "Member"}</TableCell>
        <TableCell>{formatTimeAgo(row.updatedAt, nowIso)}</TableCell>
        <TableCell>{formatTimeAgo(row.createdAt, nowIso)}</TableCell>
      </TableRow>
    );
  }

  const skeletonGrid = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {SKELETON_KEYS.map((key) => (
        <div key={key} className="overflow-hidden rounded-md border border-border bg-panel">
          <Skeleton className="aspect-video w-full" />
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );

  const skeletonTable = (
    <div className="flex flex-col gap-2">
      {SKELETON_KEYS.slice(0, 5).map((key) => (
        <Skeleton key={key} className="h-11 w-full" />
      ))}
    </div>
  );

  // -- empty states (§7.12 / §8.5) ------------------------------------------------
  const filterOrQueryActive = filter !== "all" || query.trim() !== "";
  let emptyState: ReactElement | null = null;
  if (currentWindow.loading) {
    emptyState = viewMode === "grid" ? skeletonGrid : skeletonTable;
  } else if (displayed.length === 0) {
    if (!currentWindow.loaded && currentWindow.error !== null) {
      // First-page failure: the error banner + Retry above IS the content.
      emptyState = null;
    } else if (query.trim() !== "") {
      emptyState = (
        <EmptyState
          data-testid="projects-empty-search"
          title={`No projects match '${query.trim()}'.`}
          action={
            filterOrQueryActive ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      );
    } else if (filter === "mine") {
      emptyState = (
        <EmptyState
          data-testid="projects-empty-mine"
          title="You haven't created any projects."
          action={
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      );
    } else if (filter === "shared") {
      emptyState = (
        <EmptyState
          data-testid="projects-empty-shared"
          title="No projects from other members."
          action={
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      );
    } else if (filter === "archived") {
      emptyState = (
        <EmptyState
          data-testid="projects-empty-archived"
          title="No archived projects."
          action={
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      );
    } else {
      emptyState = (
        <EmptyState
          data-testid="projects-empty-all"
          title="No projects yet."
          secondaryLink={{ label: "Back to workspace", href: "/w" }}
        />
      );
    }
  }

  const selectedCount = selected.size;
  const deleteTitle =
    selectedCount === 1 ? "Delete 1 project?" : `Delete ${selectedCount} projects?`;

  return (
    <main id="main" data-testid="projects-view" className="min-h-svh bg-app px-5 py-10">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-title-l font-medium text-primary">Projects</h1>
            <p className="text-body-s text-muted">Every project in {workspaceName}.</p>
          </div>
        </header>

        {/* §8.5 filters */}
        <Tabs
          value={filter}
          onValueChange={(value) => changeFilter(asFilter(value))}
          data-testid="projects-filters"
        >
          <TabsList variant="pill">
            {FILTERS.map((entry) => (
              <TabsTrigger
                key={entry.value}
                value={entry.value}
                variant="pill"
                data-testid={`projects-filter-${entry.value}`}
              >
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Toolbar: honest-label search (loaded window only — §8.5 v1), sort,
            grid/table toggle. */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full max-w-md">
            <SearchInput
              label="Search loaded projects"
              placeholder="Search loaded projects"
              shortcut={null}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              data-testid="projects-search"
            />
          </div>
          <div className="flex items-end gap-2">
            <Select
              value={sortKey}
              onValueChange={(value) => setSortKey(asSort(value))}
              data-testid="projects-sort"
            >
              <SelectTrigger label="Sort" placeholder="Sort" triggerSize="sm" />
              <SelectContent>
                <SelectItem value="updated">Updated</SelectItem>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="name">Name</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 rounded-pill border border-border bg-panel p-1">
              <Button
                variant={viewMode === "grid" ? "secondary" : "ghost"}
                size="iconSm"
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
                onClick={() => changeViewMode("grid")}
                data-testid="projects-view-grid"
              >
                <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
              </Button>
              <Button
                variant={viewMode === "table" ? "secondary" : "ghost"}
                size="iconSm"
                aria-label="Table view"
                aria-pressed={viewMode === "table"}
                onClick={() => changeViewMode("table")}
                data-testid="projects-view-table"
              >
                <Rows3 size={16} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>

        <BulkActionsBar
          selectedCount={selectedCount}
          archivedWindow={filter === "archived"}
          canEdit={canEdit}
          busy={bulkBusy}
          onArchiveOrRestore={() => {
            void handleArchiveOrRestore();
          }}
          onDuplicate={() => {
            void duplicateIds([...selected]);
          }}
          onDelete={() => setDeleteOpen(true)}
          onClear={() => setSelected(new Set())}
        />

        {bulkError !== null ? errorBanner(bulkError) : null}

        {bulkNote !== null && (
          <p data-testid="projects-bulk-note" className="text-body-s text-secondary">
            {bulkNote}
          </p>
        )}

        {currentWindow.error !== null && (
          <div
            role="alert"
            data-testid="projects-load-error"
            className="flex flex-wrap items-center gap-3 rounded-sm border border-danger/30 bg-danger/10 p-4 text-body-s"
          >
            <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="text-danger" />
            <span className="text-primary">{currentWindow.error}</span>
            {!currentWindow.loaded ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void loadArchivedFirst();
                }}
              >
                Retry
              </Button>
            ) : null}
          </div>
        )}

        {/* Content */}
        {emptyState !== null ? (
          emptyState
        ) : viewMode === "grid" ? (
          <div
            data-testid="projects-grid"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {displayed.map((row, index) => gridCard(row, index))}
          </div>
        ) : (
          <Table data-testid="projects-table" stickyHeader>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">{selectAllCheckbox}</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{displayed.map((row) => tableRow(row))}</TableBody>
          </Table>
        )}

        {/* §8.5: a "Load more" button; no janky auto-load. */}
        {currentWindow.nextCursor !== null && !currentWindow.loading ? (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              loading={currentWindow.loadingMore}
              onClick={() => {
                void loadMore();
              }}
              data-testid="projects-load-more"
            >
              Load more
            </Button>
          </div>
        ) : null}

        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={deleteTitle}
          description="Deleted projects are removed from every list right away. This is a soft delete — recovery is only possible within the workspace retention window."
          confirmLabel="Delete"
          confirmText="delete"
          danger
          busy={bulkBusy}
          onConfirm={() => {
            void confirmDelete();
          }}
        />
      </div>
    </main>
  );
}
