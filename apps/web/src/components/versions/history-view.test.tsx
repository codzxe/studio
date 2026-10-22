/**
 * HistoryPageView tests (M7-H) — tab composition (Versions fetches on
 * mount, Activity lazily on first activation), role-derived authorization
 * (editor+ restore/label; admin-only audit export), the audit export
 * download (parsed payload → JSON file mirroring the gateway's
 * Content-Disposition filename; truncation note), the current-version
 * download wiring through the manifest (§9.2 signed URL, scheme-guarded),
 * and the restore → "Current" marker move through the page port.
 */

import { ApiError } from "@studio/api-client";
import type {
  ActivityEntry,
  AuditExport,
  Page,
  ProjectManifest,
  ProjectVersion,
  VersionDiffSummary,
  VersionTimelineEntry,
} from "@studio/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityPageFetcher } from "@/components/activity/activity-feed";
import { HistoryPageView, type HistoryPort, sanitizeAuditFilePart } from "./history-view";
import type { VersionPageFetcher } from "./version-timeline";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-10-21T16:00:00.000Z";

function version(overrides: Partial<VersionTimelineEntry> = {}): VersionTimelineEntry {
  return {
    id: "ver_0001",
    projectId: "prj_demo",
    version: 1,
    parentVersionId: null,
    sha256: "a".repeat(64),
    sizeBytes: 2048,
    label: null,
    agentRunId: null,
    createdBy: "usr_alex",
    createdAt: "2026-10-21T14:32:05.000Z",
    createdByName: "Alex",
    isAgent: false,
    sha256Prefix: "aaaaaaaaaaaa",
    ...overrides,
  };
}

function activity(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "aud_0001",
    projectId: "prj_demo",
    actorId: "usr_alex",
    actorName: "Alex",
    action: "version.uploaded",
    targetType: "version",
    targetId: "ver_0001",
    createdAt: "2026-10-21T14:32:05.000Z",
    ...overrides,
  };
}

const AUDIT_EXPORT: AuditExport = {
  projectId: "prj_demo",
  generatedAt: NOW,
  maxRows: 1000,
  rowCount: 2,
  truncated: false,
  rows: [
    {
      id: "aud_0002",
      actorId: "usr_sam",
      actorName: "Sam",
      actorEmail: "sam@example.test",
      action: "version.restored",
      targetType: "version",
      targetId: "ver_0002",
      metadata: { confirmLabel: "Launch cut" },
      ip: "203.0.113.7",
      createdAt: "2026-10-21T15:00:00.000Z",
    },
    {
      id: "aud_0001",
      actorId: "usr_alex",
      actorName: "Alex",
      actorEmail: "alex@example.test",
      action: "version.uploaded",
      targetType: "version",
      targetId: "ver_0001",
      metadata: null,
      ip: null,
      createdAt: "2026-10-21T14:32:05.000Z",
    },
  ],
};

const MANIFEST: ProjectManifest = {
  projectId: "prj_demo",
  currentVersion: {
    id: "ver_cur",
    version: 2,
    sha256: "a".repeat(64),
    label: "Current",
    sizeBytes: 2048,
    createdAt: "2026-10-21T14:32:05.000Z",
    url: "https://storage.test/signed/prj/ver_cur.ecproj",
  },
  assets: [],
  updatedAt: NOW,
};

interface ViewOverrides {
  readonly port: HistoryPort;
  readonly canEdit: boolean;
  readonly canExport: boolean;
  readonly currentVersionId: string | null;
  readonly openUrl: (url: string) => void;
}

function makePort(overrides: Partial<HistoryPort> = {}): HistoryPort {
  return {
    listVersions: vi.fn(async () => ({ items: [version()], nextCursor: null })),
    listActivity: vi.fn(async () => ({ items: [activity()], nextCursor: null })),
    diff: vi.fn(
      async (): Promise<VersionDiffSummary> => ({
        fromParent: null,
        summary: "First version — nothing to compare against.",
      }),
    ),
    restore: vi.fn(async () => version({ id: "ver_new", version: 3 })),
    setLabel: vi.fn(async (_versionId: string, body: { label: string }) =>
      version({ label: body.label }),
    ),
    auditExport: vi.fn(async () => AUDIT_EXPORT),
    manifest: vi.fn(async () => MANIFEST),
    ...overrides,
  };
}

function renderView(
  overrides: Partial<ViewOverrides> & { readonly openUrl?: (url: string) => void } = {},
): HistoryPort {
  const port = overrides.port ?? makePort();
  render(
    <HistoryPageView
      projectId="prj_demo"
      projectName="Launch film"
      workspaceId="ws_demo"
      slug="launch-film"
      currentVersionId={overrides.currentVersionId ?? "ver_0001"}
      canEdit={overrides.canEdit ?? true}
      canExport={overrides.canExport ?? true}
      nowIso={NOW}
      api={port}
      openUrl={overrides.openUrl}
    />,
  );
  return port;
}

const USER = userEvent.setup();

// jsdom has no object-URL implementation — stub the download seams.
const createObjectURL = vi.fn(() => "blob:audit-1");
const revokeObjectURL = vi.fn();
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterAll(() => {
  clickSpy.mockRestore();
});

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  clickSpy?.mockClear();
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("HistoryPageView composition", () => {
  it("defaults to the Versions tab; fetches the timeline but not the feed until asked", async () => {
    const port = renderView();
    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toBeInTheDocument();
    });
    expect(port.listVersions).toHaveBeenCalledWith({ limit: 25 });
    expect(port.listActivity).not.toHaveBeenCalled();
    expect(screen.getByTestId("history-panel-versions")).toBeInTheDocument();
    // Radix keeps the inactive panel wrapper mounted but hidden — its CONTENT
    // (the feed) is not mounted, so nothing fetched.
    expect(screen.getByTestId("history-panel-activity")).toHaveAttribute("data-state", "inactive");
    expect(screen.queryAllByTestId("activity-row")).toHaveLength(0);

    await USER.click(screen.getByTestId("history-tab-activity"));
    await waitFor(() => {
      expect(port.listActivity).toHaveBeenCalledWith({ limit: 25 });
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row")).toHaveLength(1);
    });
  });

  it("renders the project name and the editor deep link", async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByTestId("history-project-name")).toHaveTextContent("Launch film");
    });
    expect(screen.getByTestId("history-open-editor").getAttribute("href")).toBe(
      "/w/launch-film/editor",
    );
  });

  it("hides restore and label editing for read-only members (role-derived)", async () => {
    const port = renderView({ canEdit: false });
    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("version-restore")).toBeNull();
    expect(screen.queryByTestId("version-label-edit-button")).toBeNull();
    // View diff stays available (viewer+ read).
    expect(screen.getByTestId("version-diff-toggle")).toBeInTheDocument();
    expect(port.restore).not.toHaveBeenCalled();
    expect(port.setLabel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Audit export (admin-only)
// ---------------------------------------------------------------------------

describe("audit export", () => {
  it("gates the button to admins (owner/admin roles from the RSC payload)", async () => {
    const port = renderView({ canExport: false });
    await USER.click(screen.getByTestId("history-tab-activity"));
    await waitFor(() => {
      expect(screen.getAllByTestId("activity-row")).toHaveLength(1);
    });
    expect(screen.queryByTestId("audit-export-button")).toBeNull();
    expect(port.auditExport).not.toHaveBeenCalled();
  });

  it("downloads the parsed export as a JSON file with the gateway's filename", async () => {
    renderView({ canExport: true });
    await USER.click(screen.getByTestId("history-tab-activity"));
    const button = await screen.findByTestId("audit-export-button");
    await USER.click(button);

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("studio-audit-prj_demo.json");
    expect(anchor.rel).toBe("noopener");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit-1");

    await waitFor(() => {
      expect(screen.getByTestId("audit-export-note")).toHaveTextContent(
        "Downloaded 2 events as a JSON file.",
      );
    });
  });

  it("notes the export bound when the gateway truncated older rows", async () => {
    const port = makePort({
      auditExport: vi.fn(async () => ({ ...AUDIT_EXPORT, rowCount: 1000, truncated: true })),
    });
    renderView({ port, canExport: true });
    await USER.click(screen.getByTestId("history-tab-activity"));
    await USER.click(await screen.findByTestId("audit-export-button"));
    await waitFor(() => {
      expect(screen.getByTestId("audit-export-note")).toHaveTextContent("most recent 1000 events");
    });
  });

  it("surfaces typed export failures with the §14 message + hint + request id", async () => {
    const port = makePort({
      auditExport: vi.fn(async () => {
        throw new ApiError({
          code: "FORBIDDEN",
          message: "You don't have permission to do that.",
          hint: "Ask a workspace admin to export the audit log.",
          status: 403,
          requestId: "req_export_01",
        });
      }),
    });
    renderView({ port, canExport: true });
    await USER.click(screen.getByTestId("history-tab-activity"));
    await USER.click(await screen.findByTestId("audit-export-button"));
    await waitFor(() => {
      expect(screen.getByTestId("audit-export-error")).toHaveTextContent(
        "You don't have permission to do that.",
      );
    });
    expect(screen.getByTestId("audit-export-error")).toHaveTextContent("req_export_01");
    expect(screen.getByTestId("audit-export-error")).toHaveTextContent(
      "Ask a workspace admin to export the audit log.",
    );
  });

  it("sanitizes the filename part against hostile ids", () => {
    expect(sanitizeAuditFilePart("prj_demo")).toBe("prj_demo");
    expect(sanitizeAuditFilePart("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeAuditFilePart("///")).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// Current-version download (manifest signed URL, §9.2)
// ---------------------------------------------------------------------------

describe("current-version download", () => {
  it("offers Download only on the current row and opens the signed manifest URL", async () => {
    const openUrl = vi.fn();
    const current = version({ id: "ver_cur", version: 2, label: "Current" });
    const old = version({ id: "ver_old", version: 1 });
    const port = makePort({
      listVersions: vi.fn(async () => ({ items: [current, old], nextCursor: null })),
    });
    renderView({ port, currentVersionId: "ver_cur", openUrl });

    await waitFor(() => {
      expect(screen.getAllByTestId("version-row")).toHaveLength(2);
    });
    const [currentRow, oldRow] = screen.getAllByTestId("version-row") as [HTMLElement, HTMLElement];
    expect(currentRow.querySelector('[data-testid="version-download"]')).not.toBeNull();
    expect(oldRow.querySelector('[data-testid="version-download"]')).toBeNull();

    const downloadButton = currentRow.querySelector<HTMLButtonElement>(
      '[data-testid="version-download"]',
    );
    if (downloadButton === null) throw new Error("download button missing");
    await USER.click(downloadButton);
    await waitFor(() => {
      expect(port.manifest).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith("https://storage.test/signed/prj/ver_cur.ecproj");
    });
  });

  it("refuses non-http(s) manifest URLs and explains instead of navigating", async () => {
    const openUrl = vi.fn();
    const port = makePort({
      listVersions: vi.fn(
        async (): Promise<Page<VersionTimelineEntry>> => ({
          items: [version({ id: "ver_cur", version: 2 })],
          nextCursor: null,
        }),
      ),
      manifest: vi.fn(async (): Promise<ProjectManifest> => {
        const current = MANIFEST.currentVersion;
        if (current === null) throw new Error("fixture needs a current version");
        return { ...MANIFEST, currentVersion: { ...current, url: "javascript:alert(1)" } };
      }),
    });
    renderView({ port, currentVersionId: "ver_cur", openUrl });
    await waitFor(() => {
      expect(screen.getByTestId("version-download")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-download"));
    await waitFor(() => {
      expect(screen.getByTestId("history-download-error")).toHaveTextContent(
        "The download link could not be opened.",
      );
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("surfaces typed manifest failures in place", async () => {
    const openUrl = vi.fn();
    const port = makePort({
      listVersions: vi.fn(
        async (): Promise<Page<VersionTimelineEntry>> => ({
          items: [version({ id: "ver_cur", version: 2 })],
          nextCursor: null,
        }),
      ),
      manifest: vi.fn(async (): Promise<ProjectManifest> => {
        throw new ApiError({
          code: "LEASE_HELD",
          message: "Sam is editing this project right now.",
          status: 409,
          requestId: "req_dl_01",
        });
      }),
    });
    renderView({ port, currentVersionId: "ver_cur", openUrl });
    await waitFor(() => {
      expect(screen.getByTestId("version-download")).toBeInTheDocument();
    });
    await USER.click(screen.getByTestId("version-download"));
    await waitFor(() => {
      expect(screen.getByTestId("history-download-error")).toHaveTextContent(
        "Sam is editing this project right now. (req_dl_01)",
      );
    });
    expect(openUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Restore moves the "Current" marker (§9.3: the new version becomes current)
// ---------------------------------------------------------------------------

describe("restore through the page port", () => {
  it("restores with the exact typed label and moves the Current marker to the new version", async () => {
    let versionCalls = 0;
    const restored: ProjectVersion = {
      id: "ver_new",
      projectId: "prj_demo",
      version: 3,
      parentVersionId: "ver_0002",
      sha256: "b".repeat(64),
      sizeBytes: 2048,
      label: "Restored from v2",
      agentRunId: null,
      createdBy: "usr_alex",
      createdAt: "2026-10-21T15:40:00.000Z",
    };
    const listVersions: VersionPageFetcher = vi.fn(async () => {
      versionCalls += 1;
      if (versionCalls === 1) {
        return {
          items: [version({ id: "ver_0002", version: 2, label: "Launch cut" })],
          nextCursor: null,
        };
      }
      return {
        items: [
          version({ id: "ver_new", version: 3, label: "Restored from v2" }),
          version({ id: "ver_0002", version: 2, label: "Launch cut" }),
        ],
        nextCursor: null,
      };
    });
    const port = makePort({
      listVersions,
      restore: vi.fn(async () => restored),
    });
    renderView({ port, currentVersionId: "ver_0002" });

    await waitFor(() => {
      expect(screen.getByTestId("version-row")).toHaveAttribute("data-current", "true");
    });
    await USER.click(screen.getByTestId("version-restore"));
    await USER.type(screen.getByTestId("restore-input"), "Launch cut");
    await USER.click(screen.getByTestId("restore-confirm"));

    await waitFor(() => {
      expect(port.restore).toHaveBeenCalledWith("ver_0002", { confirmLabel: "Launch cut" });
    });
    const rows = await waitFor(() => {
      const all = screen.getAllByTestId("version-row");
      expect(all).toHaveLength(2);
      return all;
    });
    expect(rows[0]).toHaveAttribute("data-version", "3");
    expect(rows[0]).toHaveAttribute("data-current", "true");
    expect(rows[1]).toHaveAttribute("data-current", "false");
  });
});
