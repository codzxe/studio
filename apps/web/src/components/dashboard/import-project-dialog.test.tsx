/**
 * ImportProjectDialog tests (W2-03, §8.4) — the first-version import flow:
 * the .ecproj file gate (wrong extension / empty file inline arms), the
 * filename-derived editable name, the create+upload hand-off (sha256 over
 * the exact bytes via the editor-session helper — pinned against
 * node:crypto — with baseVersionId: null, the §9.3 first-snapshot
 * descriptor the gateway accepts), the success navigation to the hub, and
 * the partial-failure law #4 arms: a 409 PROJECT_VERSION_CONFLICT typed
 * surfacing keeps the created project (retry REPLAYS the same
 * idempotency key — no duplicate projects) while a failed create starts
 * the next attempt fresh. Both seams are faked; next/navigation is mocked.
 */

import { createHash } from "node:crypto";
import { ApiError, type ApiErrorInit, type CallOptions } from "@studio/api-client";
import type { CreateProjectRequest, Project, ProjectVersion } from "@studio/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ImportProjectDialog,
  type ImportUploadInput,
  formatFileSize,
  projectNameFromFile,
} from "./import-project-dialog";

const routerPush = vi.fn();
const routerRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh, replace: vi.fn() }),
  usePathname: () => "/w",
  useSearchParams: () => new URLSearchParams(),
}));

const USER = userEvent.setup();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE_BYTES = new TextEncoder().encode('{"compositions":[{"id":"comp_main"}]}');
const FILE_SHA256 = createHash("sha256").update(FILE_BYTES).digest("hex");

const PROJECT: Project = {
  id: "prj_imported",
  workspaceId: "ws_first",
  name: "my-film",
  slug: "my-film",
  thumbnailUrl: null,
  archived: false,
  currentVersionId: null,
  createdBy: "user_1",
  createdAt: "2026-10-21T12:00:00Z",
  updatedAt: "2026-10-21T12:00:00Z",
  deletedAt: null,
};

const VERSION: ProjectVersion = {
  id: "ver_1",
  projectId: "prj_imported",
  version: 1,
  parentVersionId: null,
  sha256: FILE_SHA256,
  sizeBytes: FILE_BYTES.byteLength,
  label: "Imported .ecproj",
  agentRunId: null,
  createdBy: "user_1",
  createdAt: "2026-10-21T12:00:00Z",
};

/** A typed §7.3 failure exactly as the api-client materializes it. */
function apiError(init: ApiErrorInit): ApiError {
  return new ApiError(init);
}

type CreateMock = ReturnType<
  typeof vi.fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>
>;
type UploadMock = ReturnType<
  typeof vi.fn<
    (projectId: string, input: ImportUploadInput, options?: CallOptions) => Promise<ProjectVersion>
  >
>;

function renderDialog(create: CreateMock, upload: UploadMock) {
  const onOpenChange = vi.fn();
  render(
    <ImportProjectDialog
      open
      onOpenChange={onOpenChange}
      createProject={(body, options) => create(body, options)}
      uploadVersion={(projectId, input, options) => upload(projectId, input, options)}
    />,
  );
  return { onOpenChange };
}

/** Picks a file through the real file input (userEvent.upload). */
async function pickFile(name: string, bytes: Uint8Array): Promise<void> {
  const input = screen.getByTestId("import-project-file") as HTMLInputElement;
  // slice() hands the File its own ArrayBuffer-backed view (BlobPart).
  await USER.upload(input, new File([bytes.slice()], name, { type: "application/octet-stream" }));
}

/**
 * Drops a file onto the input bypassing the picker's `accept` filter — the
 * onChange validator is the second gate for drag-in/hostile paths (the
 * accept attribute already filters what userEvent.upload will deliver).
 */
function forceFile(name: string, bytes: Uint8Array): void {
  const input = screen.getByTestId("import-project-file") as HTMLInputElement;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([bytes.slice()], name, { type: "text/plain" })],
  });
  fireEvent.change(input);
}

beforeEach(() => {
  routerPush.mockClear();
  routerRefresh.mockClear();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("projectNameFromFile / formatFileSize", () => {
  it("strips the .ecproj extension and bounds the result by the name schema", () => {
    expect(projectNameFromFile("my-film.ecproj")).toBe("my-film");
    expect(projectNameFromFile("Weird Name.ECPROJ")).toBe("Weird Name");
    expect(projectNameFromFile("no-extension.json")).toBe("no-extension.json");
    expect(projectNameFromFile(`${"x".repeat(200)}.ecproj`)).toHaveLength(120);
  });

  it("formats §14 file sizes; hostile input degrades to —", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(13_040_000)).toBe("12.4 MB");
    expect(formatFileSize(Number.NaN)).toBe("—");
    expect(formatFileSize(-1)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

describe("ImportProjectDialog", () => {
  it("renders an accessible modal; Import stays disabled until a file is picked", () => {
    renderDialog(vi.fn(), vi.fn());

    expect(screen.getByRole("dialog", { name: "Import .ecproj" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Project file/)).toBeInTheDocument();
    expect(screen.getByTestId("import-project-import")).toBeDisabled();
  });

  it("rejects a non-.ecproj file inline and keeps the import disabled", async () => {
    renderDialog(vi.fn(), vi.fn());

    forceFile("not-a-project.txt", FILE_BYTES);

    expect(
      await screen.findByText("Pick a .ecproj file — that's the project file format."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("import-project-import")).toBeDisabled();
  });

  it("rejects an empty file inline", async () => {
    renderDialog(vi.fn(), vi.fn());

    await pickFile("empty.ecproj", new Uint8Array());

    expect(await screen.findByText("The file is empty.")).toBeInTheDocument();
    expect(screen.getByTestId("import-project-import")).toBeDisabled();
  });

  it("derives the editable name and shows the §14 file meta after picking", async () => {
    renderDialog(vi.fn(), vi.fn());

    await pickFile("my-film.ecproj", FILE_BYTES);

    expect((screen.getByLabelText(/^Project name/) as HTMLInputElement).value).toBe("my-film");
    expect(screen.getByTestId("import-project-import")).toBeEnabled();
    expect(
      screen.getByText(`my-film.ecproj · ${formatFileSize(FILE_BYTES.byteLength)}`),
    ).toBeInTheDocument();
  });

  it("imports: create → first-version upload (baseVersionId null, exact sha256) → hub", async () => {
    const create = vi
      .fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>()
      .mockResolvedValue(PROJECT);
    const upload = vi
      .fn<
        (
          projectId: string,
          input: ImportUploadInput,
          options?: CallOptions,
        ) => Promise<ProjectVersion>
      >()
      .mockResolvedValue(VERSION);
    const { onOpenChange } = renderDialog(create, upload);

    await pickFile("my-film.ecproj", FILE_BYTES);
    await USER.click(screen.getByTestId("import-project-import"));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/w/my-film/history"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // The create seam: derived name + one idempotency key (law #4).
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toEqual({ name: "my-film" });
    expect((create.mock.calls[0]?.[1] as CallOptions).idempotencyKey).toMatch(/^.{8,128}$/);

    // The upload seam: §9.3 FIRST-version descriptor — baseVersionId null
    // (the W3-G2 pin), the exact sha256 over the exact bytes, the label.
    expect(upload).toHaveBeenCalledTimes(1);
    const [projectId, input, options] = upload.mock.calls[0] as [
      string,
      ImportUploadInput,
      CallOptions,
    ];
    expect(projectId).toBe("prj_imported");
    expect(input.baseVersionId).toBeNull();
    expect(input.sha256).toBe(FILE_SHA256);
    expect(input.label).toBe("Imported .ecproj");
    // The exact bytes round-trip (Array.from: vitest's toEqual compares the
    // buffer by reference for typed arrays — same trap, different buffers).
    expect(input.bytes).toBeInstanceOf(Uint8Array);
    expect((input.bytes as Uint8Array).byteLength).toBe(FILE_BYTES.byteLength);
    expect(Array.from(input.bytes as Uint8Array)).toEqual(Array.from(FILE_BYTES));
    expect(options.idempotencyKey).toMatch(/^.{8,128}$/);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("surfaces the typed 409 stale-base conflict after the create, then replays idempotently", async () => {
    const create = vi
      .fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>()
      .mockResolvedValue(PROJECT);
    const upload = vi
      .fn<
        (
          projectId: string,
          input: ImportUploadInput,
          options?: CallOptions,
        ) => Promise<ProjectVersion>
      >()
      .mockRejectedValueOnce(
        apiError({
          status: 409,
          code: "PROJECT_VERSION_CONFLICT",
          message: "This changed while you were working.",
          hint: "Open the latest version, or restore yours from history.",
          requestId: "req_conflict_1",
        }),
      )
      .mockResolvedValueOnce(VERSION);
    const { onOpenChange } = renderDialog(create, upload);

    await pickFile("my-film.ecproj", FILE_BYTES);
    await USER.click(screen.getByTestId("import-project-import"));

    // The typed 409 arrives inline with the §7.3 fields, prefixed by the
    // honest "the project was created" context; the page refreshes so the
    // created row is visible; no navigation happened.
    expect(await screen.findByTestId("import-project-error")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The project was created, but the import failed. This changed while you were working.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Open the latest version, or restore yours from history."),
    ).toBeInTheDocument();
    expect(screen.getByText("Request req_conflict_1")).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();

    // Law #4 retry: the SAME create idempotency key is replayed (the gateway
    // answers the stored project row — no duplicate projects) and only the
    // upload re-runs.
    await USER.click(screen.getByTestId("import-project-import"));
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/w/my-film/history"));

    expect(create).toHaveBeenCalledTimes(2);
    const firstKey = (create.mock.calls[0]?.[1] as CallOptions).idempotencyKey;
    const retryKey = (create.mock.calls[1]?.[1] as CallOptions).idempotencyKey;
    expect(retryKey).toBe(firstKey);
    expect(upload).toHaveBeenCalledTimes(2);
    // Both upload attempts still speak the first-version descriptor.
    expect((upload.mock.calls[1]?.[1] as ImportUploadInput).baseVersionId).toBeNull();
  });

  it("surfaces a typed create failure without the created-project prefix; the next attempt is fresh", async () => {
    const create = vi
      .fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>()
      .mockRejectedValueOnce(
        apiError({
          status: 429,
          code: "QUOTA_EXCEEDED",
          message: "Your plan is at its project limit.",
          hint: "Upgrade, or archive a project first.",
          requestId: "req_quota_2",
        }),
      )
      .mockResolvedValueOnce(PROJECT);
    const upload = vi
      .fn<
        (
          projectId: string,
          input: ImportUploadInput,
          options?: CallOptions,
        ) => Promise<ProjectVersion>
      >()
      .mockResolvedValue(VERSION);
    renderDialog(create, upload);

    await pickFile("my-film.ecproj", FILE_BYTES);
    await USER.click(screen.getByTestId("import-project-import"));

    expect(await screen.findByText("Your plan is at its project limit.")).toBeInTheDocument();
    expect(screen.queryByText(/The project was created/)).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();

    // The create never landed — the retry is a NEW attempt with a fresh key.
    await USER.click(screen.getByTestId("import-project-import"));
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/w/my-film/history"));
    expect(create).toHaveBeenCalledTimes(2);
    const firstKey = (create.mock.calls[0]?.[1] as CallOptions).idempotencyKey;
    const retryKey = (create.mock.calls[1]?.[1] as CallOptions).idempotencyKey;
    expect(retryKey).not.toBe(firstKey);
  });

  it("blocks an emptied name inline and never calls the seams", async () => {
    const create = vi.fn();
    const upload = vi.fn();
    renderDialog(create, upload);

    await pickFile("my-film.ecproj", FILE_BYTES);
    await USER.clear(screen.getByLabelText(/^Project name/));
    await USER.click(screen.getByTestId("import-project-import"));

    expect(await screen.findByText("Name the project — it needs a name.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("sends the edited name when the user overrides the derived one", async () => {
    const create = vi
      .fn<(body: CreateProjectRequest, options?: CallOptions) => Promise<Project>>()
      .mockResolvedValue({ ...PROJECT, name: "Custom name", slug: "custom-name" });
    const upload = vi
      .fn<
        (
          projectId: string,
          input: ImportUploadInput,
          options?: CallOptions,
        ) => Promise<ProjectVersion>
      >()
      .mockResolvedValue(VERSION);
    renderDialog(create, upload);

    await pickFile("my-film.ecproj", FILE_BYTES);
    await USER.clear(screen.getByLabelText(/^Project name/));
    await USER.type(screen.getByLabelText(/^Project name/), "Custom name");
    await USER.click(screen.getByTestId("import-project-import"));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith("/w/custom-name/history"));
    expect(create.mock.calls[0]?.[0]).toEqual({ name: "Custom name" });
  });
});
