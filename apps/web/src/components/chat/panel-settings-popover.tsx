"use client";

/**
 * PanelSettingsPopover — ROUND 12 "Chat UI v3" polish (research/
 * round12-design.md: "opacity slider + density + font-size knobs in a
 * Panel settings popover, reset-geometry button").
 *
 * Pure PRESENTATION: the knobs call `onChange` and the popover never
 * touches storage itself (the host owns the settings store — the slot
 * wires it to `usePanelSettings`). The reset button is SEPARATE
 * (`onResetGeometry`, the layout store's `reset()`) from the settings —
 * geometry and settings persist under different keys by design.
 *
 * Self-sufficient: the popover ships its OWN TooltipProvider (Radix providers
 * nest safely), so a bare mount — the header's `settings` slot already sits
 * inside the header's provider — never throws "must be used within
 * TooltipProvider".
 */

import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@studio/ui";
import { RotateCcw, Settings2 } from "lucide-react";
import type { CSSProperties, ReactElement } from "react";
import {
  type ChatPanelDensity,
  type ChatPanelFontSize,
  type ChatPanelSettings,
  MAX_PANEL_OPACITY,
  MIN_PANEL_OPACITY,
  OPACITY_STEP,
  clampPanelOpacity,
} from "./panel-settings";

export interface PanelSettingsPopoverProps {
  readonly settings: ChatPanelSettings;
  /** The slot persists the next settings (the shared store's `set`). */
  readonly onChange: (next: ChatPanelSettings) => void;
  /** "Reset geometry" — the layout store's `reset()` (mode preserved). */
  readonly onResetGeometry: () => void;
  /** Whether the panel is currently maximized (labels the button honestly). */
  readonly maximized?: boolean;
  /** Toggle maximize/restore (the double-click gesture's button twin). */
  readonly onToggleMaximize?: () => void;
}

/** One tiny segmented control (density / font size) — a toggle-button group. */
function Segmented<T extends string>(props: {
  readonly testId: string;
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onSelect: (value: T) => void;
}): ReactElement {
  return (
    <fieldset
      aria-label={props.label}
      data-testid={props.testId}
      className="flex w-full gap-1 rounded-sm border border-border bg-elevated p-0.5"
    >
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            data-testid={`${props.testId}-${option.value}`}
            data-active={active}
            onClick={() => props.onSelect(option.value)}
            className={`h-6 flex-1 rounded-xs text-caption transition-colors duration-120 ${
              active ? "bg-input text-primary" : "text-secondary hover:text-primary"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** A labelled row — a plain group (the control carries its own aria-label). */
function Row(props: { readonly label: string; readonly children: ReactElement }): ReactElement {
  return (
    <div className="flex w-full flex-col gap-1">
      <span className="text-caption text-secondary">{props.label}</span>
      {props.children}
    </div>
  );
}

export function PanelSettingsPopover({
  settings,
  onChange,
  onResetGeometry,
  maximized = false,
  onToggleMaximize,
}: PanelSettingsPopoverProps): ReactElement {
  const setOpacity = (raw: string): void => {
    onChange({ ...settings, opacity: clampPanelOpacity(Number.parseFloat(raw)) });
  };
  const setDensity = (density: ChatPanelDensity): void => {
    onChange({ ...settings, density });
  };
  const setFontSize = (fontSize: ChatPanelFontSize): void => {
    onChange({ ...settings, fontSize });
  };

  return (
    <TooltipProvider>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0 text-secondary hover:text-primary"
                aria-label="Panel settings"
                data-testid="chat-panel-settings"
              >
                <Settings2 size={15} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Panel settings</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" side="bottom" data-testid="chat-panel-settings-popover">
          <div className="flex w-56 flex-col gap-3 p-1">
            <Row label={`Opacity ${Math.round(settings.opacity * 100)}%`}>
              <input
                type="range"
                data-testid="chat-settings-opacity"
                min={MIN_PANEL_OPACITY}
                max={MAX_PANEL_OPACITY}
                step={OPACITY_STEP}
                value={settings.opacity}
                aria-label="Panel background opacity"
                onChange={(event) => setOpacity(event.target.value)}
                className="w-full accent-[var(--signal)]"
                style={{ accentColor: "var(--signal)" } as CSSProperties}
              />
            </Row>
            <Row label="Density">
              <Segmented
                testId="chat-settings-density"
                label="Density"
                value={settings.density}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "normal", label: "Normal" },
                ]}
                onSelect={setDensity}
              />
            </Row>
            <Row label="Font size">
              <Segmented
                testId="chat-settings-font"
                label="Font size"
                value={settings.fontSize}
                options={[
                  { value: "s", label: "S" },
                  { value: "m", label: "M" },
                  { value: "l", label: "L" },
                ]}
                onSelect={setFontSize}
              />
            </Row>
            <div className="flex w-full items-center gap-1.5">
              {onToggleMaximize !== undefined ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 flex-1 px-2 text-caption"
                  data-testid="chat-settings-toggle-maximize"
                  onClick={onToggleMaximize}
                >
                  {maximized ? "Restore panel" : "Maximize panel"}
                </Button>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 p-0 text-secondary hover:text-primary"
                    aria-label="Reset panel geometry"
                    data-testid="chat-settings-reset-geometry"
                    onClick={onResetGeometry}
                  >
                    <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reset position and size</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
