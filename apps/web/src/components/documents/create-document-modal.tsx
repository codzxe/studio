"use client";

// apps/web — create-document modal (W8-C, §13.1 POST /v1/documents).
//
// Name + canvas size: three presets (1080 × 1080, 1280 × 720, 1920 × 1080)
// plus custom width/height validated client-side against the plan ceiling
// (document-sizes.ts mirror; the server re-validates and its 4xx/402 envelope
// is displayed below the form — flat envelope + hint per docs/AGENTS.md).
//
// Optimistic flow: useCreateDocument() patches the documents list cache on
// submit (a pending card appears in the library immediately) and rolls it
// back if the gateway refuses. On success the modal closes and stays on the
// library — the new card is the real row; opening it routes to the editor.
//
// A11y: Radix Dialog (focus trap, Escape, aria-labelledby/describedby — see
// @studio/ui/components/dialog.tsx); presets are a native radio group inside
// a fieldset/legend; custom inputs use useFieldIds wiring; inline errors ride
// aria-invalid + aria-describedby; the server error is a role="alert" region.

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useFieldIds,
} from "@studio/ui";
import { type FormEvent, useId, useState } from "react";
import { z } from "zod";
import {
  CUSTOM_SIZE_PRESET_ID,
  DEFAULT_PLAN_CEILING_MP,
  DOCUMENT_SIZE_PRESETS,
  type DocumentSizePreset,
  parseSizeInput,
  validateCanvasSize,
} from "./document-sizes";
import { toErrorEnvelope, useCreateDocument } from "./use-documents";

// Mirror of the gateway's documentNameSchema (routes/documents.ts W4-F):
// trimmed, 1–200 chars.
const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(200, "Names are at most 200 characters.");

export interface CreateDocumentModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Plan canvas ceiling in megapixels for client-side validation (§14.1
   * 32/64/128). Defaults to the starter floor until the shell can pass the
   * real workspace plan (GET /v1/me is contract-only today).
   */
  readonly planMaxMegapixels?: number;
}

interface CustomSizeState {
  readonly width: number | null;
  readonly height: number | null;
}

export function CreateDocumentModal({
  open,
  onOpenChange,
  planMaxMegapixels = DEFAULT_PLAN_CEILING_MP,
}: CreateDocumentModalProps) {
  const create = useCreateDocument();

  const nameIds = useFieldIds("create-document-name");
  const widthIds = useFieldIds("create-document-width");
  const heightIds = useFieldIds("create-document-height");
  const radiosName = `create-document-size-${useId().replaceAll(":", "")}`;
  // One error element serves both custom inputs (described-by target).
  const sizeErrorId = widthIds.errorId;

  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState<string>(DOCUMENT_SIZE_PRESETS[0]?.id ?? "");
  const [customWidth, setCustomWidth] = useState("");
  const [customHeight, setCustomHeight] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);

  function reset(): void {
    setName("");
    setPresetId(DOCUMENT_SIZE_PRESETS[0]?.id ?? "");
    setCustomWidth("");
    setCustomHeight("");
    setNameError(null);
    setSizeError(null);
    create.reset();
  }

  function handleOpenChange(next: boolean): void {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const parsedName = nameSchema.safeParse(name);
    setNameError(
      parsedName.success ? null : (parsedName.error.issues[0]?.message ?? "Name is required."),
    );

    const preset = DOCUMENT_SIZE_PRESETS.find((candidate) => candidate.id === presetId);
    const custom: CustomSizeState =
      preset === undefined
        ? { width: parseSizeInput(customWidth), height: parseSizeInput(customHeight) }
        : { width: preset.width, height: preset.height };

    // Compute the NEW size error locally — the `sizeError` state in this
    // closure is stale mid-submit, and the gate below must use this value.
    const sizeFail =
      custom.width === null || custom.height === null
        ? "Enter custom width and height as whole numbers of pixels."
        : (() => {
            const check = validateCanvasSize(custom.width, custom.height, planMaxMegapixels);
            return check.ok ? null : check.message;
          })();
    setSizeError(sizeFail);

    if (
      !parsedName.success ||
      sizeFail !== null ||
      custom.width === null ||
      custom.height === null
    ) {
      return;
    }

    create.mutate(
      { name: parsedName.data, width: custom.width, height: custom.height },
      {
        onSuccess: () => {
          handleOpenChange(false); // reset() runs via handleOpenChange
        },
      },
    );
  }

  const serverEnvelope = create.error === null ? null : toErrorEnvelope(create.error);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md border-border bg-surface text-foreground">
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>
            Name it and pick canvas dimensions — start from a blank canvas and let the agent design
            it with you.
          </DialogDescription>
        </DialogHeader>

        <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
          {/* Document name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameIds.inputId}>Name</Label>
            <Input
              id={nameIds.inputId}
              value={name}
              maxLength={200}
              autoComplete="off"
              aria-invalid={nameError !== null}
              aria-describedby={nameError !== null ? nameIds.errorId : undefined}
              onChange={(event) => setName(event.target.value)}
              className="border-border"
            />
            {nameError === null ? null : (
              <p id={nameIds.errorId} className="text-xs text-red-600">
                {nameError}
              </p>
            )}
          </div>

          {/* Canvas size presets + custom */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-foreground">Canvas size</legend>
            {DOCUMENT_SIZE_PRESETS.map((preset) => (
              <SizeRadio
                key={preset.id}
                preset={preset}
                name={radiosName}
                checked={presetId === preset.id}
                onChange={() => setPresetId(preset.id)}
              />
            ))}
            <SizeRadio
              preset={{
                id: CUSTOM_SIZE_PRESET_ID,
                label: "Custom size",
                caption: "Enter your own dimensions",
              }}
              name={radiosName}
              checked={presetId === CUSTOM_SIZE_PRESET_ID}
              onChange={() => setPresetId(CUSTOM_SIZE_PRESET_ID)}
            />

            {presetId === CUSTOM_SIZE_PRESET_ID ? (
              <div className="mt-1 grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={widthIds.inputId}>Width (px)</Label>
                  <Input
                    id={widthIds.inputId}
                    type="text"
                    inputMode="numeric"
                    placeholder="1920"
                    value={customWidth}
                    aria-invalid={sizeError !== null}
                    aria-describedby={sizeError !== null ? sizeErrorId : undefined}
                    onChange={(event) => setCustomWidth(event.target.value)}
                    className="border-border"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={heightIds.inputId}>Height (px)</Label>
                  <Input
                    id={heightIds.inputId}
                    type="text"
                    inputMode="numeric"
                    placeholder="1080"
                    value={customHeight}
                    aria-invalid={sizeError !== null}
                    aria-describedby={sizeError !== null ? sizeErrorId : undefined}
                    onChange={(event) => setCustomHeight(event.target.value)}
                    className="border-border"
                  />
                </div>
                {sizeError === null ? null : (
                  <p id={sizeErrorId} className="col-span-2 text-xs text-red-600">
                    {sizeError}
                  </p>
                )}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Your plan allows canvases up to {planMaxMegapixels} megapixels. Need more? Upgrade the
              workspace plan.
            </p>
          </fieldset>

          {/* Server refusal: flat envelope + hint (§13.3), never internals. */}
          {serverEnvelope === null ? null : (
            <div
              role="alert"
              className="rounded-md border border-border bg-surface-muted p-3 text-sm"
            >
              <p className="font-medium">{serverEnvelope.message}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {serverEnvelope.hint === undefined
                  ? `Code: ${serverEnvelope.code}`
                  : `${serverEnvelope.hint} (code ${serverEnvelope.code})`}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending}
              aria-busy={create.isPending}
              className="bg-accent text-accent-foreground hover:opacity-90"
            >
              {create.isPending ? "Creating…" : "Create document"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One accessible radio row for a canvas-size option. */
function SizeRadio({
  preset,
  name,
  checked,
  onChange,
}: {
  readonly preset: Pick<DocumentSizePreset, "id" | "label" | "caption">;
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 text-sm transition-colors has-checked:border-accent has-checked:bg-surface-muted">
      <input
        type="radio"
        name={name}
        value={preset.id}
        checked={checked}
        onChange={onChange}
        className="size-4 accent-accent"
      />
      <span className="flex flex-1 flex-col">
        <span className="font-medium">{preset.label}</span>
        <span className="text-xs text-muted-foreground">{preset.caption}</span>
      </span>
    </label>
  );
}
