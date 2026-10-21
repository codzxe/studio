"use client";

// Manifest modal (W8-J) — the "full inspect payload" view over
// `GET /v1/templates/:id` / `GET /v1/components/:id` (§7.4 / §8.3 inspect):
// a slots table with bounds and fonts (§7.2), rules, palette swatches, the
// layer map, component variables, anchors and comps, plus the raw manifest
// JSON for honest verification. Fetches go through use-catalog, so an
// `id@version` manifest is fetched once and cached (versioned content).

import { Badge, Button, Dialog, DialogContent, DialogTitle, Skeleton } from "@studio/ui";
import type { ReactNode } from "react";
import { isApiError } from "../../lib/api";
import {
  useComponentManifest,
  useTemplateManifest,
  type ComponentManifest,
  type ComponentVariable,
  type ManifestTarget,
  type TemplateManifest,
  type TemplateSlot,
  type SlotBounds,
} from "./use-catalog";

// ---------------------------------------------------------------------------
// Pure display helpers (kept exported for future component tests)
// ---------------------------------------------------------------------------

/** `[x, y, w, h]` → `"x, y, w × h"`; missing bounds (component slots) → null. */
export function formatBounds(bounds: SlotBounds | undefined): string | null {
  if (bounds === undefined) {
    return null;
  }
  const [x = 0, y = 0, w = 0, h = 0] = bounds;
  return `${x}, ${y}, ${w} × ${h}`;
}

/** Bounds column value for any slot kind (color/visibility slots have none). */
export function slotBounds(slot: TemplateSlot): string | null {
  if (slot.kind === "color" || slot.kind === "visibility") {
    return null;
  }
  return formatBounds(slot.bounds);
}

/**
 * Human summary of a slot's fill-time contract (§7.3): what `template.fill`
 * enforces for this slot — geometry, font, caps — in one cell.
 */
export function describeSlotConstraints(slot: TemplateSlot): string {
  const parts: string[] = [];
  switch (slot.kind) {
    case "text": {
      parts.push(slot.font);
      if (slot.weight !== undefined) {
        parts.push(slot.weight);
      }
      parts.push(`${slot.size}px`);
      if (slot.lineHeight !== undefined) {
        parts.push(`line-height ${slot.lineHeight}`);
      }
      if (slot.maxLines !== undefined) {
        parts.push(`≤ ${slot.maxLines} lines`);
      }
      if (slot.maxChars !== undefined) {
        parts.push(`≤ ${slot.maxChars} chars`);
      }
      if (slot.align !== undefined) {
        parts.push(slot.align);
      }
      if (slot.color !== undefined) {
        parts.push(slot.color);
      }
      if (slot.autoFit !== undefined) {
        parts.push(`auto-fit ${slot.autoFit.minSize}–${slot.autoFit.maxSize}px`);
      }
      break;
    }
    case "image": {
      parts.push(slot.fit);
      if (slot.minPixels !== undefined) {
        const [w = 0, h = 0] = slot.minPixels;
        parts.push(`min ${w}×${h}px`);
      }
      if (slot.focal !== undefined) {
        const [fx = 0, fy = 0] = slot.focal;
        parts.push(`focal ${fx}, ${fy}`);
      }
      break;
    }
    case "component": {
      parts.push(slot.component);
      if (slot.vars !== undefined) {
        const vars = Object.entries(slot.vars).map(
          ([name, value]) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
        );
        if (vars.length > 0) {
          parts.push(`vars ${vars.join(", ")}`);
        }
      }
      break;
    }
    case "color": {
      parts.push(slot.color === undefined ? "no default colour" : slot.color);
      break;
    }
    case "visibility": {
      parts.push(slot.default === false ? "hidden by default" : "visible by default");
      break;
    }
  }
  return parts.join(" · ");
}

/** A component variable's §8.2 default, rendered for the variables table. */
export function describeVariableDefault(variable: ComponentVariable): string {
  if (variable.kind === "text") {
    return variable.default === "" ? "(empty string)" : variable.default;
  }
  if (variable.kind === "color") {
    return variable.default;
  }
  return variable.default ? "visible" : "hidden";
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ManifestModalProps {
  readonly open: boolean;
  /** The pinned manifest to inspect — always an explicit id@version. */
  readonly target: ManifestTarget | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function ManifestModal({ open, target, onOpenChange }: ManifestModalProps) {
  // Both hooks stay mounted (rules of hooks); each is enabled only while its
  // kind is selected. The id@version pin is explicit so a card never shows a
  // newer manifest than the pin it was opened from (§7.2 immutability).
  const tplId = target !== null && target.kind === "template" ? target.id : null;
  const tplVersion = target !== null && target.kind === "template" ? target.version : null;
  const cmpId = target !== null && target.kind === "component" ? target.id : null;
  const cmpVersion = target !== null && target.kind === "component" ? target.version : null;
  const template = useTemplateManifest(tplId, tplVersion);
  const component = useComponentManifest(cmpId, cmpVersion);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] max-w-3xl overflow-y-auto bg-surface text-foreground"
      >
        {target === null ? null : target.kind === "template" ? (
          template.isPending ? (
            <ManifestLoading />
          ) : template.isError ? (
            <ManifestError error={template.error} onRetry={() => void template.refetch()} />
          ) : (
            <TemplateManifestBody manifest={template.data.template} />
          )
        ) : component.isPending ? (
          <ManifestLoading />
        ) : component.isError ? (
          <ManifestError error={component.error} onRetry={() => void component.refetch()} />
        ) : (
          <ComponentManifestBody manifest={component.data.component} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ManifestLoading() {
  return (
    <div role="status" aria-label="Loading manifest" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-6 w-40 bg-surface-muted" />
        <Skeleton className="h-5 w-32 rounded-full bg-surface-muted" />
      </div>
      <Skeleton className="h-4 w-full bg-surface-muted" />
      <Skeleton className="h-44 w-full bg-surface-muted" />
    </div>
  );
}

function ManifestError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const message = isApiError(error) ? error.message : "The manifest could not be loaded.";
  const hint = isApiError(error) ? error.hint : undefined;
  return (
    <div role="alert" className="flex flex-col gap-3 text-sm">
      <DialogTitle>Manifest unavailable</DialogTitle>
      <p>{message}</p>
      {hint !== undefined ? <p className="text-muted-foreground">{hint}</p> : null}
      <Button
        variant="outline"
        className="w-fit border-border bg-surface hover:bg-surface-muted"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function MetaRows({ rows }: { readonly rows: readonly { label: string; value: ReactNode }[] }) {
  const present = rows.filter((row) => row.value !== undefined && row.value !== null);
  if (present.length === 0) {
    return null;
  }
  return (
    <dl className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
      {present.map((row) => (
        <div key={row.label} className="flex gap-2">
          <dt className="w-24 shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Swatch({ hex }: { readonly hex: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-4 shrink-0 rounded-sm border border-border"
        style={{ backgroundColor: hex }}
      />
      <code className="font-mono text-[11px]">{hex}</code>
    </span>
  );
}

function RawJson({ manifest }: { readonly manifest: TemplateManifest | ComponentManifest }) {
  return (
    <details className="rounded-md border border-border bg-surface-muted p-3">
      <summary className="cursor-pointer text-xs font-medium">Raw manifest JSON</summary>
      <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed">
        {JSON.stringify(manifest, null, 2)}
      </pre>
    </details>
  );
}

function SectionHeading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <h4 id={id} className="text-sm font-semibold">
      {children}
    </h4>
  );
}

// ---------------------------------------------------------------------------
// Template manifest (§7.2)
// ---------------------------------------------------------------------------

function TemplateManifestBody({ manifest }: { readonly manifest: TemplateManifest }) {
  const slots = manifest.slots ?? {};
  const slotNames = Object.keys(slots).sort((a, b) => a.localeCompare(b));
  const layerMap = manifest.layerMap ?? {};
  const layerNames = Object.keys(layerMap).sort((a, b) => a.localeCompare(b));
  const rules = manifest.rules;
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <DialogTitle className="text-left">{manifest.name}</DialogTitle>
          <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
            {`${manifest.id}@${manifest.version}`}
          </Badge>
        </div>
        {manifest.description !== undefined ? (
          <p className="text-sm text-muted-foreground">{manifest.description}</p>
        ) : null}
      </header>

      <MetaRows
        rows={[
          {
            label: "Canvas",
            value: `${manifest.canvas.width} × ${manifest.canvas.height} px`,
          },
          ...(manifest.canvas.background !== undefined
            ? [
                {
                  label: "Background",
                  value: <Swatch hex={manifest.canvas.background} />,
                },
              ]
            : []),
          ...(manifest.tags !== undefined
            ? [{ label: "Tags", value: manifest.tags.join(", ") }]
            : []),
          ...(manifest.license !== undefined ? [{ label: "License", value: manifest.license }] : []),
          ...(manifest.author !== undefined ? [{ label: "Author", value: manifest.author }] : []),
          ...(manifest.thumbnail !== undefined
            ? [
                {
                  label: "Thumbnail",
                  value: <code className="font-mono">{manifest.thumbnail}</code>,
                },
              ]
            : []),
        ]}
      />

      {slotNames.length > 0 ? (
        <section aria-labelledby="manifest-slots-heading" className="flex flex-col gap-2">
          <SectionHeading id="manifest-slots-heading">{`Slots (${slotNames.length})`}</SectionHeading>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">Slot</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Kind</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Layer</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Bounds (x, y, w × h)</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Constraints</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Requirement</th>
                </tr>
              </thead>
              <tbody>
                {slotNames.map((name) => {
                  const slot = slots[name];
                  if (slot === undefined) {
                    return null;
                  }
                  return (
                    <tr key={name} className="border-t border-border align-top">
                      <td className="px-2 py-1.5 font-mono">{name}</td>
                      <td className="px-2 py-1.5">{slot.kind}</td>
                      <td className="px-2 py-1.5 font-mono">{slot.layer}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono">
                        {slotBounds(slot) ?? "—"}
                      </td>
                      <td className="max-w-[20rem] px-2 py-1.5">
                        {describeSlotConstraints(slot)}
                      </td>
                      <td className="px-2 py-1.5">
                        {slot.optional === true ? "optional" : "required"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Optional slots stay present but hidden until filled (§7.3) — template layers are
            never deleted.
          </p>
        </section>
      ) : null}

      {rules !== undefined ? (
        <section aria-labelledby="manifest-rules-heading" className="flex flex-col gap-2">
          <SectionHeading id="manifest-rules-heading">Rules</SectionHeading>
          <MetaRows
            rows={[
              ...(rules.safeArea !== undefined
                ? [{ label: "Safe area", value: `${rules.safeArea} px` }]
                : []),
              ...(rules.minContrast !== undefined
                ? [{ label: "Min contrast", value: `${rules.minContrast}:1` }]
                : []),
              ...(rules.maxTextLayers !== undefined
                ? [{ label: "Max text layers", value: rules.maxTextLayers }]
                : []),
            ]}
          />
          {rules.mustLayers !== undefined && rules.mustLayers.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <span className="text-muted-foreground">Must layers:</span>
              {rules.mustLayers.map((layer) => (
                <Badge key={layer} variant="outline" className="font-mono text-[10px]">
                  {layer}
                </Badge>
              ))}
            </div>
          ) : null}
          {rules.palette !== undefined && rules.palette.length > 0 ? (
            <ul className="flex flex-wrap gap-3" aria-label="Palette">
              {rules.palette.map((hex) => (
                <li key={hex}>
                  <Swatch hex={hex} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {layerNames.length > 0 ? (
        <section aria-labelledby="manifest-layers-heading" className="flex flex-col gap-2">
          <SectionHeading id="manifest-layers-heading">{`Layer map (${layerNames.length})`}</SectionHeading>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">Layer</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Role</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {layerNames.map((name) => {
                  const entry = layerMap[name];
                  if (entry === undefined) {
                    return null;
                  }
                  const notes = [
                    entry.fill !== undefined ? <Swatch key="fill" hex={entry.fill} /> : null,
                    entry.mask !== undefined
                      ? `mask: ${entry.mask}${
                          entry.maskRadius !== undefined ? ` (${entry.maskRadius})` : ""
                        }`
                      : null,
                    entry.component !== undefined ? `component: ${entry.component}` : null,
                  ].filter((note) => note !== null);
                  return (
                    <tr key={name} className="border-t border-border align-top">
                      <td className="px-2 py-1.5 font-mono">{name}</td>
                      <td className="px-2 py-1.5">{entry.role}</td>
                      <td className="px-2 py-1.5">
                        <span className="flex flex-wrap items-center gap-2">{notes}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <RawJson manifest={manifest} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component manifest (§8.2)
// ---------------------------------------------------------------------------

function ComponentManifestBody({ manifest }: { readonly manifest: ComponentManifest }) {
  const variables = manifest.variables ?? {};
  const variableNames = Object.keys(variables).sort((a, b) => a.localeCompare(b));
  const anchors = manifest.anchors ?? {};
  const anchorNames = Object.keys(anchors).sort((a, b) => a.localeCompare(b));
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <DialogTitle className="text-left">{manifest.name}</DialogTitle>
          <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
            {`${manifest.id}@${manifest.version}`}
          </Badge>
        </div>
        {manifest.description !== undefined ? (
          <p className="text-sm text-muted-foreground">{manifest.description}</p>
        ) : null}
      </header>

      <MetaRows
        rows={[
          {
            label: "Default size",
            value: `${manifest.defaultSize.width} × ${manifest.defaultSize.height} px`,
          },
          ...(manifest.tags !== undefined
            ? [{ label: "Tags", value: manifest.tags.join(", ") }]
            : []),
          ...(manifest.author !== undefined ? [{ label: "Author", value: manifest.author }] : []),
          ...(manifest.license !== undefined ? [{ label: "License", value: manifest.license }] : []),
        ]}
      />

      {variableNames.length > 0 ? (
        <section aria-labelledby="manifest-vars-heading" className="flex flex-col gap-2">
          <SectionHeading id="manifest-vars-heading">{`Variables (${variableNames.length})`}</SectionHeading>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">Variable</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Kind</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Default</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Constraints</th>
                </tr>
              </thead>
              <tbody>
                {variableNames.map((name) => {
                  const variable = variables[name];
                  if (variable === undefined) {
                    return null;
                  }
                  return (
                    <tr key={name} className="border-t border-border align-top">
                      <td className="px-2 py-1.5 font-mono">{name}</td>
                      <td className="px-2 py-1.5">{variable.kind}</td>
                      <td className="px-2 py-1.5">
                        {variable.kind === "color" ? (
                          <Swatch hex={variable.default} />
                        ) : (
                          <span className="font-mono">{describeVariableDefault(variable)}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {variable.kind === "text" && variable.maxChars !== undefined
                          ? `≤ ${variable.maxChars} chars`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {anchorNames.length > 0 ? (
        <section aria-labelledby="manifest-anchors-heading" className="flex flex-col gap-2">
          <SectionHeading id="manifest-anchors-heading">Anchors</SectionHeading>
          <ul className="flex flex-wrap gap-1.5">
            {anchorNames.map((name) => {
              const point = anchors[name];
              if (point === undefined) {
                return null;
              }
              const [fx = 0, fy = 0] = point;
              return (
                <li key={name}>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {`${name} (${fx}, ${fy})`}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {manifest.comps !== undefined && manifest.comps.length > 0 ? (
        <section aria-labelledby="manifest-comps-heading" className="flex flex-col gap-2">
          <SectionHeading id="manifest-comps-heading">Comps</SectionHeading>
          <ul className="flex flex-wrap gap-1.5">
            {manifest.comps.map((comp) => (
              <li key={comp}>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {comp}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <RawJson manifest={manifest} />
    </div>
  );
}
