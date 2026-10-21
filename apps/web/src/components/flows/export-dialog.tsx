"use client";

// apps/web/src/components/flows/export-dialog.tsx (W8-P)
//
// ExportDialog — the §10.3/§13.1 export surface:
//
//   Format picker      .pcraft default + recommended (primary, lossless,
//                      round-trip-perfect); PNG/JPG with width/height and the
//                      1–100 quality slider (JPG — PNG is lossless); PSD
//                      carrying the §2.3 experimental warning label +
//                      fidelity-report note, DISABLED behind a feature flag.
//   Enqueue            POST /documents/:id/exports → 202 → poll → URL.
//   Job list           mini-history with the queued/processing/ready/failed
//                      status machine; ready rows expose the fresh signed URL
//                      and auto-download while the dialog is open.
//
// MOUNT: through <EditorActions/> (editor-actions.tsx) or standalone with
// `open`/`onOpenChange`. See flows/README.md for the toolbar wiring.

import { Download } from "lucide-react";
import { useId, useState, type ChangeEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  cn,
} from "@studio/ui";
import type { GatewayClient } from "../../lib/api";
import {
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_EXPORT_QUALITY,
  EXPORT_FORMAT_OPTIONS,
  EXPORT_PHASE_BADGE_VARIANT,
  EXPORT_PHASE_LABEL,
  EXPORT_QUALITY_MAX,
  EXPORT_QUALITY_MIN,
  MAX_EXPORT_SIDE_PX,
  PSD_EXPERIMENTAL_WARNING,
  PSD_FIDELITY_NOTE,
  exportFileName,
  type ExportFormat,
  type ExportJobView,
} from "./flows-model";
import { useExports } from "./use-exports";
import type { FlowNotice } from "./use-undo-redo";

export interface ExportDialogProps {
  /** Typed gateway client (apps/web/src/lib/api.ts). */
  readonly client: GatewayClient;
  readonly documentId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** §2.3 feature flag — the psd option stays disabled until this is true. */
  readonly psdEnabled?: boolean;
  /** Canvas size for the width/height placeholders (§10.3 document-size default). */
  readonly canvasSize?: { readonly width: number; readonly height: number } | null;
  /** Bubbles export toasts up to the toolbar's notice region. */
  readonly onNotice?: (notice: FlowNotice) => void;
}

export function ExportDialog({
  client,
  documentId,
  open,
  onOpenChange,
  psdEnabled = false,
  canvasSize = null,
  onNotice,
}: ExportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Unmounts while closed: the poll loops + history live only while open. */}
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            The layered .pcraft format is the primary output — lossless and
            round-trip-perfect. Re-downloading an existing export is free
            (§10.3).
          </DialogDescription>
        </DialogHeader>
        <ExportDialogForm
          client={client}
          documentId={documentId}
          psdEnabled={psdEnabled}
          canvasSize={canvasSize}
          onNotice={onNotice}
        />
      </DialogContent>
    </Dialog>
  );
}

interface ExportDialogFormProps {
  readonly client: GatewayClient;
  readonly documentId: string;
  readonly psdEnabled: boolean;
  readonly canvasSize: { readonly width: number; readonly height: number } | null;
  readonly onNotice?: (notice: FlowNotice) => void;
}

function ExportDialogForm({
  client,
  documentId,
  psdEnabled,
  canvasSize,
  onNotice,
}: ExportDialogFormProps) {
  const { enqueueExport, jobs, historyBusy, error, clearError } = useExports({
    client,
    documentId,
  });
  const [format, setFormat] = useState<ExportFormat>(DEFAULT_EXPORT_FORMAT);
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [quality, setQuality] = useState(DEFAULT_EXPORT_QUALITY);
  const [enqueuing, setEnqueuing] = useState(false);
  const radioGroupName = useId();
  const widthId = useId();
  const heightId = useId();
  const qualityId = useId();

  const rasterSides = format === "png" || format === "jpg";

  function pickFormat(next: ExportFormat): void {
    setFormat(next);
    clearError();
  }

  function onQualityChange(event: ChangeEvent<HTMLInputElement>): void {
    setQuality(Number(event.target.value));
  }

  async function startExport(): Promise<void> {
    if (enqueuing) {
      return;
    }
    setEnqueuing(true);
    try {
      const queued = await enqueueExport({ format, width, height, quality, psdEnabled });
      if (queued && onNotice !== undefined) {
        onNotice({
          id: crypto.randomUUID(),
          tone: "success",
          text: "Export queued — the download starts automatically when it's ready.",
          revision: null,
          at: Date.now(),
        });
      }
    } finally {
      setEnqueuing(false);
    }
  }

  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="sr-only">Format</legend>
        <div className="grid grid-cols-2 gap-2">
          {EXPORT_FORMAT_OPTIONS.map((option) => {
            const disabled = option.format === "psd" && !psdEnabled;
            const checked = format === option.format;
            return (
              <label
                key={option.format}
                className={cn(
                  "flex items-start gap-2 rounded-md border p-3 text-sm",
                  checked ? "border-ring bg-surface-muted" : "border-border",
                  disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                )}
              >
                <input
                  type="radio"
                  name={radioGroupName}
                  className="mt-1"
                  checked={checked}
                  onChange={() => pickFormat(option.format)}
                  disabled={disabled}
                />
                <span className="grid gap-0.5">
                  <span className="font-medium">
                    {option.label}
                    {option.recommended === true ? (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        · recommended
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {option.hint}
                    {disabled ? " · behind a feature flag" : ""}
                  </span>
                  {option.experimental === true ? (
                    <span className="mt-1 inline-flex w-fit rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                      Experimental
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {format === "pcraft" ? (
        <p className="text-xs text-muted-foreground">
          Lossless and replayable — reopens with the same layer tree
          (§20-#9 hash-verified replay).
        </p>
      ) : null}

      {rasterSides ? (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor={widthId}>Width (px)</Label>
              <Input
                id={widthId}
                inputMode="numeric"
                placeholder={canvasSize === null ? "document width" : String(canvasSize.width)}
                value={width}
                onChange={(event) => setWidth(event.target.value)}
                disabled={enqueuing}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={heightId}>Height (px)</Label>
              <Input
                id={heightId}
                inputMode="numeric"
                placeholder={canvasSize === null ? "document height" : String(canvasSize.height)}
                value={height}
                onChange={(event) => setHeight(event.target.value)}
                disabled={enqueuing}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave the sizes empty to export at the document's size (up to{" "}
            {MAX_EXPORT_SIDE_PX} px per side).
          </p>
          <div className="grid gap-1">
            <Label htmlFor={qualityId}>Quality — {quality}</Label>
            <input
              id={qualityId}
              type="range"
              min={EXPORT_QUALITY_MIN}
              max={EXPORT_QUALITY_MAX}
              step={1}
              value={quality}
              onChange={onQualityChange}
              disabled={enqueuing || format !== "jpg"}
              className="w-full accent-current"
            />
            <p className="text-xs text-muted-foreground">
              {format === "jpg"
                ? "1–100 — higher is better quality and larger files."
                : "PNG is lossless — quality applies to JPG only."}
            </p>
          </div>
        </div>
      ) : null}

      {format === "psd" && psdEnabled ? (
        <div
          role="note"
          className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
        >
          <p>{PSD_EXPERIMENTAL_WARNING}</p>
          <p className="mt-1">{PSD_FIDELITY_NOTE}</p>
        </div>
      ) : null}

      <div className="grid gap-1">
        <Button
          type="button"
          onClick={() => void startExport()}
          disabled={enqueuing}
          className="gap-1"
        >
          <Download className="size-4" aria-hidden="true" />
          {enqueuing ? "Queuing…" : "Start export"}
        </Button>
        {error === null ? null : (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
      </div>

      <section aria-label="Export history" className="grid gap-2">
        <h3 className="text-sm font-medium">Recent exports</h3>
        <div aria-live="polite" className="grid max-h-56 gap-2 overflow-y-auto">
          {historyBusy ? (
            <p className="text-xs text-muted-foreground">Loading past exports…</p>
          ) : jobs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No exports yet — the .pcraft format keeps every layer editable.
            </p>
          ) : (
            <ul className="grid gap-2">
              {jobs.map((job) => (
                <ExportJobRow key={job.exportId} job={job} />
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Ready exports download automatically while this dialog is open. Signed
          links expire after 15 minutes — re-download any time; re-downloading an
          existing export is free (§10.3).
        </p>
      </section>
    </div>
  );
}

function ExportJobRow({ job }: { readonly job: ExportJobView }) {
  return (
    <li
      data-export-phase={job.phase}
      className="flex items-start gap-2 rounded-md border border-border p-2 text-xs"
    >
      <Badge variant={EXPORT_PHASE_BADGE_VARIANT[job.phase]}>{EXPORT_PHASE_LABEL[job.phase]}</Badge>
      <div className="grid min-w-0 gap-0.5">
        <p className="truncate">
          {job.format} · revision {job.revision} · {jobSummary(job)}
        </p>
        {job.warnings.map((warning) => (
          <p key={warning} className="text-warning">
            {warning}
          </p>
        ))}
        {job.error === null ? null : (
          <p role="alert" className="text-red-600">
            {job.error}
          </p>
        )}
        {job.pollBudgetExhausted ? (
          <p className="text-muted-foreground">
            Still processing — reopen this dialog later to check on it.
          </p>
        ) : null}
        {job.url === null ? null : (
          <p>
            <a
              href={job.url}
              download={exportFileName(job)}
              rel="noopener"
              className="font-medium text-primary underline underline-offset-2"
            >
              Download
            </a>
            {job.expiresAt === null ? "" : " · link expires with its signing window"}
          </p>
        )}
      </div>
    </li>
  );
}

function jobSummary(job: ExportJobView): string {
  const dims =
    job.width !== null && job.height !== null
      ? `${job.width}×${job.height} px`
      : "document size";
  const quality = job.format === "jpg" && job.quality !== null ? ` · q ${job.quality}` : "";
  return `${dims}${quality}`;
}
