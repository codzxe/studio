"use client";

// apps/web — brand tokens editor (W8-L; §7.5/§10.2, spec §10.2 colours/fonts).
//
// Edits the workspace brand kit — palette (≤ 10 canonical #RRGGBB swatches),
// the four §5.5 font roles, logo asset and tone words — and saves the WHOLE
// canonical record via PATCH /v1/workspaces/:id { brand_tokens } (W4-E
// contract: the gateway stores the record opaquely and enforces admin+;
// the agent consumes it as BrandTokens, packages/agent/src/brand/tokens.ts).
//
// Editor state lives in brand-model.ts (pure, table-tested): raw drafts are
// validated per field, canonicalization is the save gate, and dirty tracking
// is canonical-compare (cosmetic whitespace never blocks or fakes a change).
//
// LOGO PICKER reuses the W8-I contract (components/assets/use-assets.ts):
// a plain file input POSTs multipart to /uploads (kind=image) and the
// returned asset id becomes `logoAssetId`; the preview reads the asset back
// through the §15.1 short-lived signed URL. No drag-drop chrome, no cropper —
// the asset library page stays the full-featured path.
//
// A11y: every control is a native element with Label wiring (useFieldIds);
// swatch rows pair a labelled hex input with a native colour picker; field
// problems render inline via aria-invalid + aria-describedby. Rows are their
// own components so hook order never depends on list length.

import { Button, Input, Label, useFieldIds } from "@studio/ui";
import { ImagePlus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { type ChangeEvent, useMemo, useState } from "react";
import { useSignedAssetUrl, useUploadAsset } from "@/components/assets/use-assets";
import {
  DEFAULT_BRAND,
  FONT_ROLES,
  MAX_PALETTE_TOKENS,
  brandTokensToDraft,
  canonicalBrandDraft,
  isDraftDirty,
  normalizeHex,
  validateBrandDraft,
  type BrandProblem,
  type BrandTokens,
  type BrandTokensDraft,
  type FontRole,
} from "./brand-model";
import {
  canManageWorkspace,
  toSettingsError,
  useUpdateWorkspace,
  type WorkspaceRole,
} from "./use-settings";

// ---------------------------------------------------------------------------
// Props + static display data
// ---------------------------------------------------------------------------

export interface BrandTokensEditorProps {
  readonly workspaceId: string | null;
  /** Current workspace brand tokens (already coerced; use-settings.ts). */
  readonly tokens: BrandTokens;
  /** Caller's role — admin+ can save (§15.2 workspace.update). */
  readonly role: WorkspaceRole;
}

/** §5.5 note: fonts are registry NAMES — the workspace font set only. */
const FONT_ROLE_HINTS: Readonly<Record<FontRole, string>> = {
  display: "Headlines and big numbers",
  sans: "Body copy and UI labels",
  serif: "Quotes and long-form passages",
  mono: "Specs, prices and code",
};

/** Generic CSS fallbacks so an unbound role still previews legibly. */
const FONT_FALLBACKS: Readonly<Record<FontRole, string>> = {
  display: "sans-serif",
  sans: "sans-serif",
  serif: "serif",
  mono: "monospace",
};

/**
 * Pick readable ink for a background colour (WCAG-style luma). Receives a
 * canonical #RRGGBB; presentation-only.
 */
function inkOn(background: string): string {
  const r = Number.parseInt(background.slice(1, 3), 16);
  const g = Number.parseInt(background.slice(3, 5), 16);
  const b = Number.parseInt(background.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? "#111111" : "#FFFFFF";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BrandTokensEditor({ workspaceId, tokens, role }: BrandTokensEditorProps) {
  const canEdit = canManageWorkspace(role); // admin+ — server enforces (§15.2)
  const save = useUpdateWorkspace(workspaceId);
  const upload = useUploadAsset();

  const [draft, setDraft] = useState<BrandTokensDraft>(() => brandTokensToDraft(tokens));
  const [seeded, setSeeded] = useState(tokens);

  // Reseed only when a NEW tokens value arrives from the server (post-save
  // invalidation or refetch). React's adjust-state-during-render pattern:
  // guarded compare, then the re-render below uses the fresh seed. A
  // post-save reseed is invisible — the draft already equals the canonical
  // value — while an external change is never silently kept.
  if (seeded !== tokens) {
    setSeeded(tokens);
    setDraft(brandTokensToDraft(tokens));
  }

  const validation = useMemo(() => validateBrandDraft(draft), [draft]);
  const dirty = isDraftDirty(draft, tokens);
  const canSave = canEdit && validation.canSave && dirty && !save.isPending;
  const hasToneProblem = validation.problems.some((problem) => problem.field === "toneWords");

  const problemFor = (field: BrandProblem["field"], index: number | FontRole): string | null => {
    const problem = validation.problems.find(
      (candidate) => candidate.field === field && candidate.index === index,
    );
    return problem === undefined ? null : problem.message;
  };

  // -- palette --------------------------------------------------------------
  function setPaletteRow(index: number, value: string): void {
    setDraft({ ...draft, palette: draft.palette.map((row, i) => (i === index ? value : row)) });
  }
  function addPaletteRow(): void {
    if (draft.palette.length >= MAX_PALETTE_TOKENS) {
      return;
    }
    // First unused default colour — a sensible start, still fully editable.
    const unused =
      DEFAULT_BRAND.palette.find((color) => !draft.palette.includes(color)) ?? "#6366F1";
    setDraft({ ...draft, palette: [...draft.palette, unused] });
  }
  function removePaletteRow(index: number): void {
    setDraft({ ...draft, palette: draft.palette.filter((_, i) => i !== index) });
  }

  // -- fonts / tone / logo ---------------------------------------------------
  function setFont(fontRole: FontRole, value: string): void {
    setDraft({ ...draft, fonts: { ...draft.fonts, [fontRole]: value } });
  }
  function setToneWords(value: string): void {
    setDraft({ ...draft, toneWords: value.split(",") });
  }
  function onLogoPicked(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (file === undefined) {
      return;
    }
    // W8-I contract: multipart POST /uploads (kind=image) → asset id
    // (§12.1 byte-dedupe server-side; §13 Idempotency-Key in the helper).
    upload.mutate({ file }, {
      onSuccess: (result) => {
        setDraft((current) => ({ ...current, logoAssetId: result.asset.id }));
      },
    });
  }
  function clearLogo(): void {
    setDraft({ ...draft, logoAssetId: "" });
  }
  function resetDraft(): void {
    setDraft(brandTokensToDraft(tokens));
  }
  function saveBrandTokens(): void {
    const canonical = canonicalBrandDraft(draft);
    if (!canonical.ok) {
      return; // canSave gates this; belt-and-braces for the model gate
    }
    save.mutate({ brandTokens: canonical.value });
  }

  const saveError = save.error === null ? null : toSettingsError(save.error);
  const logoAssetId = draft.logoAssetId.trim();
  const logoUrl = useSignedAssetUrl(logoAssetId === "" ? "-" : logoAssetId, {
    enabled: logoAssetId !== "", // never fetch for an unbound logo (W8-I hook)
  }).data?.url.url ?? null;

  return (
    <div className="flex flex-col gap-6">
      {!canEdit ? (
        <p className="rounded-md border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
          Only workspace admins can change the brand kit — permissions are enforced server-side
          (§15.2). You have the <strong>{role}</strong> role in this workspace.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="flex flex-col gap-6">
          {/* Palette */}
          <section aria-labelledby="brand-palette-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 id="brand-palette-heading" className="text-sm font-semibold text-foreground">
                  Palette
                </h3>
                <p className="text-xs text-muted-foreground">
                  1–{MAX_PALETTE_TOKENS} hex colours. The agent picks from this palette unless
                  the prompt says otherwise (§10.2).
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPaletteRow}
                disabled={!canEdit || draft.palette.length >= MAX_PALETTE_TOKENS}
                className="border-border"
              >
                <Plus aria-hidden="true" />
                Add colour
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {draft.palette.map((value, index) => (
                <PaletteRow
                  key={index}
                  index={index}
                  value={value}
                  canRemove={draft.palette.length > 1}
                  canEdit={canEdit}
                  problem={problemFor("palette", index)}
                  onChange={setPaletteRow}
                  onRemove={removePaletteRow}
                />
              ))}
            </ul>
          </section>

          {/* Fonts */}
          <section aria-labelledby="brand-fonts-heading" className="flex flex-col gap-3">
            <div>
              <h3 id="brand-fonts-heading" className="text-sm font-semibold text-foreground">
                Fonts
              </h3>
              <p className="text-xs text-muted-foreground">
                Family names from the workspace font registry. A missing font is an error with an
                install hint — never a silent substitution (§10.2).
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {FONT_ROLES.map((fontRole) => (
                <FontRoleField
                  key={fontRole}
                  fontRole={fontRole}
                  value={draft.fonts[fontRole]}
                  canEdit={canEdit}
                  problem={problemFor("fonts", fontRole)}
                  onChange={setFont}
                />
              ))}
            </div>
          </section>

          {/* Logo */}
          <section aria-labelledby="brand-logo-heading" className="flex flex-col gap-3">
            <div>
              <h3 id="brand-logo-heading" className="text-sm font-semibold text-foreground">
                Logo
              </h3>
              <p className="text-xs text-muted-foreground">
                Uploads go through the asset library (POST /uploads — ≤ 25 MB image, MIME-sniffed,
                EXIF stripped per §15.2); only the asset id is stored in the brand kit.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label
                className={
                  canEdit
                    ? "inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-muted"
                    : "inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium opacity-50"
                }
              >
                <ImagePlus aria-hidden="true" className="size-4" />
                {logoAssetId === "" ? "Upload logo image" : "Replace logo image"}
                <input
                  type="file"
                  accept="image/*"
                  disabled={!canEdit}
                  onChange={onLogoPicked}
                  className="sr-only"
                />
              </label>
              {logoAssetId === "" ? null : (
                <>
                  <code className="max-w-[12rem] truncate rounded-md border border-border bg-surface-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                    {logoAssetId}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canEdit}
                    onClick={clearLogo}
                    className="text-muted-foreground hover:text-red-600"
                  >
                    <Trash2 aria-hidden="true" />
                    Clear
                  </Button>
                </>
              )}
              {upload.isPending ? (
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  Uploading…
                </p>
              ) : null}
              {upload.error === null ? null : (
                <p role="alert" className="text-xs text-red-600">
                  {toSettingsError(upload.error).message}
                </p>
              )}
            </div>
          </section>

          {/* Tone */}
          <section aria-labelledby="brand-tone-heading" className="flex flex-col gap-1.5">
            <Label htmlFor="brand-tone-input" id="brand-tone-heading">
              Tone
            </Label>
            <p className="-mt-1 text-xs text-muted-foreground">
              Up to 8 comma-separated words that steer how the agent writes copy (§5.4).
            </p>
            <Input
              id="brand-tone-input"
              value={draft.toneWords.join(", ")}
              placeholder="bold, minimal, warm"
              autoComplete="off"
              disabled={!canEdit}
              aria-invalid={hasToneProblem}
              onChange={(event) => setToneWords(event.target.value)}
              className="max-w-sm border-border"
            />
            {validation.problems
              .filter((problem) => problem.field === "toneWords")
              .map((problem) => (
                <p key={`${problem.index}-${problem.message}`} className="text-xs text-red-600">
                  {problem.message}
                </p>
              ))}
          </section>
        </div>

        {/* Live preview */}
        <aside aria-label="Brand preview" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Live preview</h3>
          <BrandPreviewCard draft={draft} logoUrl={logoUrl} />
          <p className="text-xs text-muted-foreground">
            A rough render — final documents use the workspace font registry, this palette and
            the layout the agent plans (§5.5).
          </p>
        </aside>
      </div>

      {/* Save bar */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button
          type="button"
          onClick={saveBrandTokens}
          disabled={!canSave}
          aria-busy={save.isPending}
          className="bg-accent text-accent-foreground hover:opacity-90"
        >
          {save.isPending ? "Saving…" : "Save brand kit"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={resetDraft}
          disabled={!canEdit || !dirty || save.isPending}
          className="border-border"
        >
          <RotateCcw aria-hidden="true" />
          Reset
        </Button>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {save.isSuccess && !dirty
            ? "Brand kit saved."
            : dirty
              ? "Unsaved changes"
              : "Up to date"}
        </p>
      </div>

      {saveError === null ? null : (
        <div role="alert" className="rounded-md border border-border bg-surface-muted p-3 text-sm">
          <p className="font-medium">{saveError.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {saveError.hint === undefined
              ? `Code: ${saveError.code}`
              : `${saveError.hint} (code ${saveError.code})`}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows (own components — stable hook order regardless of list length)
// ---------------------------------------------------------------------------

function PaletteRow({
  index,
  value,
  canRemove,
  canEdit,
  problem,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly value: string;
  readonly canRemove: boolean;
  readonly canEdit: boolean;
  readonly problem: string | null;
  readonly onChange: (index: number, value: string) => void;
  readonly onRemove: (index: number) => void;
}) {
  const ids = useFieldIds(`brand-palette-${index}`);
  const normalized = normalizeHex(value);
  return (
    <li className="flex items-start gap-2">
      <input
        type="color"
        aria-label={`Palette colour ${index + 1} picker`}
        value={normalized ?? "#000000"}
        onChange={(event) => onChange(index, event.target.value.toUpperCase())}
        disabled={!canEdit}
        className="mt-0.5 size-9 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-1 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex flex-1 flex-col gap-1">
        <Label htmlFor={ids.inputId} className="sr-only">
          Palette colour {index + 1}
        </Label>
        <Input
          id={ids.inputId}
          value={value}
          placeholder="#1F2937"
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-invalid={problem !== null}
          aria-describedby={problem !== null ? ids.errorId : undefined}
          disabled={!canEdit}
          onChange={(event) => onChange(index, event.target.value)}
          className="max-w-[10rem] border-border font-mono uppercase"
        />
        {problem === null ? null : (
          <p id={ids.errorId} className="text-xs text-red-600">
            {problem}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove palette colour ${index + 1}`}
        disabled={!canEdit || !canRemove}
        onClick={() => onRemove(index)}
        className="text-muted-foreground hover:text-red-600"
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  );
}

function FontRoleField({
  fontRole,
  value,
  canEdit,
  problem,
  onChange,
}: {
  readonly fontRole: FontRole;
  readonly value: string;
  readonly canEdit: boolean;
  readonly problem: string | null;
  readonly onChange: (fontRole: FontRole, value: string) => void;
}) {
  const ids = useFieldIds(`brand-font-${fontRole}`);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={ids.inputId}>
        {fontRole.charAt(0).toUpperCase() + fontRole.slice(1)}
        <span className="font-normal text-muted-foreground">{FONT_ROLE_HINTS[fontRole]}</span>
      </Label>
      <Input
        id={ids.inputId}
        value={value}
        placeholder={FONT_FALLBACKS[fontRole]}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? ids.errorId : undefined}
        disabled={!canEdit}
        onChange={(event) => onChange(fontRole, event.target.value)}
        className="border-border"
      />
      {problem === null ? null : (
        <p id={ids.errorId} className="text-xs text-red-600">
          {problem}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview card (pure presentational)
// ---------------------------------------------------------------------------

function BrandPreviewCard({
  draft,
  logoUrl,
}: {
  readonly draft: BrandTokensDraft;
  readonly logoUrl: string | null;
}) {
  const palette = draft.palette
    .map((value) => normalizeHex(value))
    .filter((value): value is string => value !== undefined);
  const background = palette[0] ?? DEFAULT_BRAND.palette[0] ?? "#FFFFFF";
  const ink = inkOn(background);
  const accent = palette[1] ?? background;
  const display = draft.fonts.display.trim();
  const sans = draft.fonts.sans.trim();
  const serif = draft.fonts.serif.trim();
  const mono = draft.fonts.mono.trim();
  const toneWords = draft.toneWords.map((word) => word.trim()).filter((word) => word !== "");

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border p-5 shadow-sm"
      style={{ backgroundColor: background, color: ink }}
    >
      <div className="flex items-center gap-3">
        {logoUrl === null ? (
          <span
            className="grid size-10 place-items-center rounded-md border font-mono text-xs"
            style={{ borderColor: ink }}
            aria-hidden="true"
          >
            Aa
          </span>
        ) : (
          // Signed asset URLs are one-off (§15.1) and expire in ≤ 15 min — a
          // plain <img> keeps the preview simple; next/image gains nothing.
          // biome-ignore lint/security/noImgElement: one-off signed asset preview
          <img src={logoUrl} alt="" className="size-10 rounded-md object-contain" />
        )}
        <span
          className="text-lg font-semibold leading-tight"
          style={{
            fontFamily: display === "" ? undefined : `"${display}", ${FONT_FALLBACKS.display}`,
          }}
        >
          {display === "" ? "Your brand headline" : display}
        </span>
      </div>

      <p
        className="text-sm opacity-90"
        style={{ fontFamily: sans === "" ? undefined : `"${sans}", ${FONT_FALLBACKS.sans}` }}
      >
        Body copy set in your sans font, for offers, captions and calls to action.
      </p>
      <p
        className="text-sm italic opacity-80"
        style={{ fontFamily: serif === "" ? undefined : `"${serif}", ${FONT_FALLBACKS.serif}` }}
      >
        “A quiet quote set in serif.”
      </p>
      <p
        className="text-xs opacity-70"
        style={{ fontFamily: mono === "" ? undefined : `"${mono}", ${FONT_FALLBACKS.mono}` }}
      >
        MONO · 1080 × 1080 · 300 DPI
      </p>

      {toneWords.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {toneWords.map((word) => (
            <span
              key={word}
              className="rounded-full border px-2 py-0.5 text-[11px]"
              style={{ borderColor: ink, backgroundColor: accent, color: inkOn(accent) }}
            >
              {word}
            </span>
          ))}
        </div>
      )}

      <div className="mt-1 flex h-3 overflow-hidden rounded-full border border-border">
        {(palette.length > 0 ? palette : DEFAULT_BRAND.palette).map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="flex-1"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}
