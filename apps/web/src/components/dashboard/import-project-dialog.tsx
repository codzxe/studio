"use client";

/**
 * ImportProjectDialog (W2-03, §8.4) — import a `.ecproj` file as a NEW
 * project whose FIRST version is the file itself.
 *
 * Flow: pick `.ecproj` → name (derived from the filename, editable) →
 * `POST /v1/projects` → `POST /v1/projects/:id/versions` (the two-phase
 * upload: sha256 via the editor-session WebCrypto helper with its
 * deterministic fallback) → navigate to the project's hub.
 *
 * First-version semantics (§9.3): a fresh project has `currentVersionId`
 * null, so the only non-conflicting descriptor is `baseVersionId: null` —
 * the gateway accepts null (services/gateway routes/versions.ts). The typed
 * client's nullability is being widened by sibling W3-G2 IN THIS WAVE; the
 * one call-site cast lives in `asDashboardPort` (dashboard-view.tsx), not
 * here — this dialog speaks the nullable `DashboardUploadInput` seam.
 *
 * Idempotency & partial failure (law #4): the CREATE key is held for the
 * whole attempt-set — if the upload fails after the project row exists, a
 * retry replays the SAME project (the gateway's idempotency middleware
 * answers the stored row; no duplicate projects) and only re-runs the
 * upload. The page is refreshed on that arm so the created row is visible
 * behind the error. A create that never landed clears the key, so the next
 * attempt starts fresh. Typed §7.3 failures surface inline (message + hint
 * + request id); a 409 PROJECT_VERSION_CONFLICT (stale base) arrives as its
 * typed message like every other code — never a stack (law #1).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY — the
 * name bound is PROJECT_NAME_SCHEMA restated locally (1–120 chars).
 */

import { type CallOptions, isApiError } from "@studio/api-client";
import type { CreateProjectRequest, Project, ProjectVersion } from "@studio/contracts";
import {
  Button,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
} from "@studio/ui";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useEffect, useRef, useState } from "react";

import { sha256Hex } from "@/lib/editor-session";

/** PROJECT_NAME_SCHEMA (contracts routes/projects.ts), restated locally. */
const NAME_MAX_LENGTH = 120;

/** Timeline label for the imported first version (VERSION_LABEL_SCHEMA ≤ 280). */
const IMPORTED_LABEL = "Imported .ecproj";

/** A bounded §7.3 failure surface (message + hint + request id, §14). */
export interface ImportProjectError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

/**
 * The upload input the import flow needs — `baseVersionId` NULLABLE: the
 * imported file becomes the project's FIRST version (§9.3). Mirrors the
 * api-client's upload input with the W3-G2 nullability applied.
 */
export interface ImportUploadInput {
  readonly baseVersionId: string | null;
  readonly sha256: string;
  readonly label?: string;
  readonly bytes: Blob | Uint8Array;
}

/** The `POST /v1/projects` seam. */
export type CreateProject = (body: CreateProjectRequest, options?: CallOptions) => Promise<Project>;

/** The `POST /v1/projects/:id/versions` seam (two-phase upload). */
export type UploadVersion = (
  projectId: string,
  input: ImportUploadInput,
  options?: CallOptions,
) => Promise<ProjectVersion>;

export interface ImportProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The create seam (the dashboard's port in production; a fake in tests). */
  readonly createProject: CreateProject;
  /** The upload seam (the dashboard's port in production; a fake in tests). */
  readonly uploadVersion: UploadVersion;
}

/** `my-film.ecproj` → `my-film` (bounded by the name schema, trimmed). */
export function projectNameFromFile(fileName: string): string {
  const stem = fileName.replace(/\.ecproj$/i, "").trim();
  return stem.length > NAME_MAX_LENGTH ? stem.slice(0, NAME_MAX_LENGTH) : stem;
}

/** §14 file size display ("2 KB", "12.4 MB"); hostile input → "—". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal, trailing ".0" dropped by the number's own formatting.
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Typed §7.3 failure → the bounded inline surface; anything else → generic. */
function toImportError(cause: unknown, projectCreated: boolean): ImportProjectError {
  const base: ImportProjectError = isApiError(cause)
    ? { message: cause.message, hint: cause.hint, requestId: cause.requestId }
    : { message: "The import could not be completed.", hint: "Try again in a moment." };
  // The project row exists but the file did not land — say so honestly; the
  // retry replays the same project (idempotency key), so no duplicates.
  return projectCreated
    ? { ...base, message: `The project was created, but the import failed. ${base.message}` }
    : base;
}

/**
 * File → bytes: `Blob.arrayBuffer` first (every production browser), with a
 * FileReader fallback for hosts without it (older jsdom — same degrade
 * philosophy as the sha256 helper's crypto.subtle fallback).
 */
async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The file could not be read."));
    });
    reader.readAsArrayBuffer(file);
  });
}

export function ImportProjectDialog({
  open,
  onOpenChange,
  createProject,
  uploadVersion,
}: ImportProjectDialogProps) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [importError, setImportError] = useState<ImportProjectError | null>(null);
  const [busy, setBusy] = useState(false);
  /** Held across retries of ONE attempt-set (cleared on success/new file). */
  const attemptKeyRef = useRef<string | null>(null);

  // Transient state resets when the dialog closes — a reopen starts clean.
  useEffect(() => {
    if (open) return;
    setFile(null);
    setFileError(null);
    setName("");
    setNameError(null);
    setImportError(null);
    setBusy(false);
    attemptKeyRef.current = null;
  }, [open]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    // Reset the value so re-picking the SAME file fires onChange again.
    const picked = event.target.files?.[0] ?? null;
    event.target.value = "";
    setFileError(null);
    setImportError(null);
    setBusy(false);
    attemptKeyRef.current = null; // a new file is a new attempt-set
    if (picked === null) {
      setFile(null);
      return;
    }
    if (!/\.ecproj$/i.test(picked.name)) {
      setFile(null);
      setFileError("Pick a .ecproj file — that's the project file format.");
      return;
    }
    if (picked.size === 0) {
      setFile(null);
      setFileError("The file is empty.");
      return;
    }
    setFile(picked);
    setName(projectNameFromFile(picked.name));
    setNameError(null);
  };

  const onImport = (): void => {
    if (busy || file === null) return;
    const picked = file;
    const trimmed = name.trim();
    const nextNameError =
      trimmed.length === 0
        ? "Name the project — it needs a name."
        : trimmed.length > NAME_MAX_LENGTH
          ? `Project names are at most ${NAME_MAX_LENGTH} characters.`
          : null;
    setNameError(nextNameError);
    setImportError(null);
    if (nextNameError !== null) return;

    setBusy(true);
    const run = async (): Promise<void> => {
      const attemptKey = attemptKeyRef.current ?? crypto.randomUUID();
      attemptKeyRef.current = attemptKey;
      let project: Project | null = null;
      try {
        const bytes = await readFileBytes(picked);
        const sha256 = await sha256Hex(bytes);
        project = await createProject({ name: trimmed }, { idempotencyKey: attemptKey });
        await uploadVersion(
          project.id,
          {
            baseVersionId: null, // §9.3: the project's FIRST version has no base
            sha256,
            label: IMPORTED_LABEL,
            bytes,
          },
          { idempotencyKey: crypto.randomUUID() },
        );
        attemptKeyRef.current = null; // success — a future import starts fresh
        onOpenChange(false);
        router.push(`/w/${project.slug}/history`);
      } catch (cause) {
        if (project === null) {
          // The create never landed — the next attempt gets a fresh key.
          attemptKeyRef.current = null;
        } else {
          // The project row exists — refresh so it shows behind the error;
          // the retry replays the same project through the held key.
          router.refresh();
        }
        setImportError(toImportError(cause, project !== null));
      } finally {
        setBusy(false);
      }
    };
    void run();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="import-project-dialog">
        <DialogTitle>Import .ecproj</DialogTitle>
        <DialogDescription>
          Bring in a project exported from here or another workspace. The file becomes the
          project&rsquo;s first version.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-4">
          <Field
            id="import-project-file"
            label="Project file"
            helperText={
              file !== null && fileError === null
                ? `${file.name} · ${formatFileSize(file.size)}`
                : "The .ecproj export from a project."
            }
            error={fileError}
          >
            {(control) => (
              <input
                type="file"
                accept=".ecproj"
                id={control.id}
                aria-describedby={control["aria-describedby"]}
                aria-invalid={control["aria-invalid"]}
                data-testid="import-project-file"
                className="w-full rounded-sm border border-border bg-input px-2.5 py-1.5 text-body-s text-secondary transition-colors duration-120 outline-offset-2 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-signal aria-invalid:border-danger file:mr-3 file:cursor-pointer file:rounded-xs file:border-0 file:bg-elevated file:px-2.5 file:py-1 file:text-body-s file:text-primary"
                onChange={onFileChange}
              />
            )}
          </Field>
          <Input
            id="import-project-name"
            type="text"
            label="Project name"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={nameError}
            helperText="Derived from the file name — edit it if you like."
            data-testid="import-project-name"
          />
          {importError !== null ? (
            <div role="alert" data-testid="import-project-error" className="flex flex-col gap-1">
              <p className="text-caption text-danger">{importError.message}</p>
              {importError.hint !== undefined ? (
                <p className="text-caption text-muted">{importError.hint}</p>
              ) : null}
              {importError.requestId !== undefined ? (
                <p className="text-caption text-muted">Request {importError.requestId}</p>
              ) : null}
            </div>
          ) : null}
          <DialogActions>
            <DialogClose asChild>
              <Button variant="secondary" data-testid="import-project-cancel">
                Cancel
              </Button>
            </DialogClose>
            <Button
              loading={busy}
              disabled={file === null}
              onClick={onImport}
              data-testid="import-project-import"
            >
              Import project
            </Button>
          </DialogActions>
        </div>
      </DialogContent>
    </Dialog>
  );
}
