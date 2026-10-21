"use client";

// Upload dropzone (W8-I) — §20.2 client-side mirror of the gateway's upload
// gates. Drag or click; every dropped file runs the local guards (JPEG/PNG
// whitelist, 25 MB cap, header-only dimension read → friendly 60 MP
// warning) BEFORE it is queued, so bad files cost zero bytes. Survivors are
// uploaded one-by-one (the gateway accepts a single `file` part per POST)
// with an indeterminate progress bar + status text; §13.3 failures map to
// friendly copy with the envelope's hint (guards.ts).
//
// EXIF notice (§20.2): the badge states the standing promise — EXIF metadata
// is stripped from JPEG uploads server-side (colour profiles kept), so
// location/camera data never enters the library.

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MEGAPIXELS } from "@studio/config";
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import { useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  UPLOAD_ACCEPT_ATTRIBUTE,
  describeUploadFailure,
  formatBytes,
  validateClientFile,
  type FailureCopy,
} from "./guards";
import { useUploadAsset, type UploadAssetResponse } from "./use-assets";

/** One queued upload (client guards passed, waiting for its turn). */
interface QueuedUpload {
  readonly id: string;
  readonly file: File;
}

/** Terminal outcome of one dropped file — succeeded, or rejected/failed with copy. */
interface UploadResultItem {
  readonly id: string;
  readonly name: string;
  readonly status: "succeeded" | "rejected" | "failed";
  /** §12.1 byte-dedupe hit — the existing asset was reused. */
  readonly duplicate?: boolean;
  /** Rejection (client) or failure (§13.3 envelope) copy. */
  readonly failure?: FailureCopy;
}

export interface UploadDropzoneProps {
  /** Fires for each successful upload (duplicate hits included). */
  readonly onUploaded?: (response: UploadAssetResponse) => void;
}

export function UploadDropzone({ onUploaded }: UploadDropzoneProps) {
  const uploadAsset = useUploadAsset();
  const inputId = useId();
  const pendingRef = useRef<QueuedUpload[]>([]);
  const drainingRef = useRef(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResultItem[]>([]);
  const [dragActive, setDragActive] = useState(false);

  /**
   * Sequential drain: one multipart POST at a time (the gateway parses
   * exactly one `file` part per request). A ref lock makes the loop
   * StrictMode-safe and lets files dropped mid-drain join the queue.
   */
  async function drain(): Promise<void> {
    if (drainingRef.current) {
      return;
    }
    drainingRef.current = true;
    try {
      for (;;) {
        const next = pendingRef.current.shift();
        if (next === undefined) {
          break;
        }
        setUploadingName(next.file.name);
        try {
          const response = await uploadAsset.mutateAsync({ file: next.file });
          if (onUploaded !== undefined) {
            onUploaded(response);
          }
          setResults((previous) => [
            ...previous,
            {
              id: next.id,
              name: next.file.name,
              status: "succeeded",
              duplicate: response.duplicate,
            },
          ]);
        } catch (error: unknown) {
          setResults((previous) => [
            ...previous,
            {
              id: next.id,
              name: next.file.name,
              status: "failed",
              failure: describeUploadFailure(error),
            },
          ]);
        }
      }
    } finally {
      drainingRef.current = false;
      setUploadingName(null);
    }
  }

  /** Pre-validate every file, queue the survivors, record the rejections. */
  async function enqueue(files: readonly File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const accepted: QueuedUpload[] = [];
    const rejected: UploadResultItem[] = [];
    for (const file of files) {
      const id = crypto.randomUUID();
      const guard = await validateClientFile(file);
      if (guard.ok) {
        accepted.push({ id, file });
      } else {
        rejected.push({
          id,
          name: file.name,
          status: "rejected",
          failure: { title: guard.title, hint: guard.hint },
        });
      }
    }
    setResults((previous) => [...previous, ...rejected]);
    if (accepted.length > 0) {
      pendingRef.current.push(...accepted);
      void drain();
    }
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      void enqueue(files);
    }
    event.target.value = ""; // re-selecting the same file must re-fire change
  }

  function onDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) {
      void enqueue(files);
    }
  }

  function onDragActivate(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault(); // allow the drop
    if (!dragActive) {
      setDragActive(true);
    }
  }

  function onDragLeave(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return; // moving between the label's children — still inside
    }
    setDragActive(false);
  }

  function dismiss(id: string): void {
    setResults((previous) => previous.filter((item) => item.id !== id));
  }

  return (
    <div className="space-y-3">
      {/*
       * The input is a sibling of the label (explicit htmlFor), sr-only but
       * keyboard-focusable: Enter/Space open the native picker, clicking the
       * label does the same, and drops land on the label.
       */}
      <input
        id={inputId}
        type="file"
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        multiple
        onChange={onInputChange}
        className="sr-only"
      />
      <label
        htmlFor={inputId}
        onDragEnter={onDragActivate}
        onDragOver={onDragActivate}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={
          dragActive
            ? "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent bg-accent/5 px-6 py-10 text-center transition-colors"
            : "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-surface px-6 py-10 text-center transition-colors hover:bg-surface-muted"
        }
      >
        <Upload className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-semibold">Drop images here, or click to browse</p>
        <p className="text-xs text-muted-foreground">
          JPEG or PNG · up to {formatBytes(MAX_UPLOAD_BYTES)} · images over{" "}
          {MAX_UPLOAD_MEGAPIXELS} MP are rejected
        </p>
        {/* §20.2 EXIF notice badge — the upload promise, stated where files land. */}
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          EXIF stripped on upload
        </span>
      </label>

      {uploadingName !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
        >
          <LoaderCircle
            className="size-4 shrink-0 animate-spin text-accent"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              Uploading &quot;{uploadingName}&quot;…
            </p>
            {/* Indeterminate bar — fetch streaming is not needed for a single
             * multipart POST; the pulse bar + status text carry the state. */}
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
              <div className="h-full w-full animate-pulse rounded-full bg-accent" />
            </div>
          </div>
        </div>
      ) : null}

      {results.length > 0 ? (
        <ul aria-label="Upload results" className="space-y-1.5">
          {results.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
            >
              {item.status === "succeeded" ? (
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0 text-emerald-600"
                  aria-hidden="true"
                />
              ) : (
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0 text-red-600"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {item.name}
                  {item.status === "succeeded" && item.duplicate === true
                    ? " — already in your library"
                    : ""}
                </p>
                {item.failure !== undefined ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.failure.title}
                    {item.failure.hint !== undefined ? (
                      <span className="block">{item.failure.hint}</span>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  dismiss(item.id);
                }}
                aria-label={`Dismiss ${item.name}`}
                className="rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
