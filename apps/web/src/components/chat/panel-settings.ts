"use client";

/**
 * Chat panel settings model (ROUND 12 "Chat UI v3", the moat polish) —
 * opacity (panel BACKGROUND alpha), density, font size + a reset-geometry
 * companion knob, persisted per user in localStorage following the layout
 * store's pattern (components/chat/layout.ts + use-layout.ts):
 *
 * - pure, never throws, SSR-safe (`typeof window` guards);
 * - validated + defaulted on load (corrupt/private-mode → defaults);
 * - a module singleton store consumed through `useSyncExternalStore` with a
 *   DEFAULT server snapshot — hydration-safe exactly like the geometry;
 * - storage key `studio.chat.settings.v1` (the layout key's sibling).
 *
 * The knobs apply WITHOUT touching the pinned token system:
 * - opacity < 1 → an inline `background-color: color-mix(...)` on the panel
 *   (overrides the `bg-panel` class; 1 = no style, byte-identical render);
 * - fontSize ≠ "m" → the panel root sets `--chat-font-size`, consumed by the
 *   markdown/message layer (`fontSize: var(--chat-font-size)`); "m" = no var;
 * - density → a `data-chat-density` attribute the thread layer reads for
 *   tighter gaps ("compact") vs the pinned spacing ("normal").
 */

import { useSyncExternalStore } from "react";

/** CSS custom properties the panel settings may set on the shell. */
export type CssVars = {
  readonly backgroundColor?: string;
  readonly "--chat-font-size"?: string;
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ChatPanelDensity = "compact" | "normal";
export type ChatPanelFontSize = "s" | "m" | "l";

export interface ChatPanelSettings {
  /** Panel BACKGROUND alpha, 0.4–1 (1 = opaque, the default). */
  readonly opacity: number;
  readonly density: ChatPanelDensity;
  readonly fontSize: ChatPanelFontSize;
}

export const PANEL_SETTINGS_STORAGE_KEY = "studio.chat.settings.v1";

export const DEFAULT_PANEL_SETTINGS: ChatPanelSettings = {
  opacity: 1,
  density: "normal",
  fontSize: "m",
};

/** Slider bounds (0.4 keeps floating text readable over any canvas). */
export const MIN_PANEL_OPACITY = 0.4;
export const MAX_PANEL_OPACITY = 1;
export const OPACITY_STEP = 0.05;

/** Resolved font-size px for the message column; "m" = no override (14px base). */
export const PANEL_FONT_SIZE_PX: Readonly<Record<ChatPanelFontSize, number | null>> = {
  s: 13,
  m: null,
  l: 15.5,
};

export function clampPanelOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_PANEL_OPACITY, Math.max(MIN_PANEL_OPACITY, value));
}

function isStoredSettings(value: unknown): value is ChatPanelSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof ChatPanelSettings, unknown>>;
  return (
    (candidate.density === "compact" || candidate.density === "normal") &&
    (candidate.fontSize === "s" || candidate.fontSize === "m" || candidate.fontSize === "l") &&
    Number.isFinite(candidate.opacity)
  );
}

/** Load persisted settings (validated + clamped); defaults when absent/corrupt. */
export function loadPanelSettings(): ChatPanelSettings {
  if (typeof window === "undefined") return DEFAULT_PANEL_SETTINGS;
  try {
    const raw = window.localStorage.getItem(PANEL_SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_PANEL_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSettings(parsed)) return DEFAULT_PANEL_SETTINGS;
    return {
      opacity: clampPanelOpacity(parsed.opacity as number),
      density: parsed.density as ChatPanelDensity,
      fontSize: parsed.fontSize as ChatPanelFontSize,
    };
  } catch {
    return DEFAULT_PANEL_SETTINGS; // quota/private mode/corrupt — never fatal
  }
}

/** Persist best-effort (quota-safe; the in-memory store stays truth). */
export function savePanelSettings(settings: ChatPanelSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PANEL_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota exceeded / storage disabled — never fatal.
  }
}

/**
 * The panel's inline style fragments derived from the settings. `opacity`
 * paints the BACKGROUND ONLY (never the text) via color-mix; `fontSize`
 * exposes the `--chat-font-size` var the markdown/message layer consumes.
 * All-DEFAULT settings ⇒ an empty object (byte-identical M4 render).
 */
export function panelSettingsStyle(settings: ChatPanelSettings): CssVars {
  const fontPx = PANEL_FONT_SIZE_PX[settings.fontSize];
  return {
    ...(settings.opacity < 1
      ? {
          backgroundColor: `color-mix(in srgb, var(--bg-panel) ${Math.round(
            settings.opacity * 100,
          )}%, transparent)`,
        }
      : {}),
    ...(fontPx !== null ? { "--chat-font-size": `${fontPx}px` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store (the use-layout.ts pattern, hydration-safe)
// ---------------------------------------------------------------------------

export interface ChatPanelSettingsStore {
  getSnapshot(): ChatPanelSettings;
  getServerSnapshot(): ChatPanelSettings;
  subscribe(listener: () => void): () => void;
  set(next: ChatPanelSettings): void;
  reset(): void;
}

export function createPanelSettingsStore(options?: {
  readonly initial?: ChatPanelSettings;
  readonly load?: () => ChatPanelSettings;
}): ChatPanelSettingsStore {
  const load = options?.load ?? loadPanelSettings;
  const listeners = new Set<() => void>();
  let current = options?.initial ?? load();
  return {
    getSnapshot: () => current,
    getServerSnapshot: () => DEFAULT_PANEL_SETTINGS,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (
        next.opacity === current.opacity &&
        next.density === current.density &&
        next.fontSize === current.fontSize
      ) {
        return;
      }
      current = next;
      savePanelSettings(current);
      for (const listener of [...listeners]) listener();
    },
    reset() {
      this.set(DEFAULT_PANEL_SETTINGS);
    },
  };
}

let appStore: ChatPanelSettingsStore | null = null;

function panelSettingsStore(): ChatPanelSettingsStore {
  if (appStore === null) {
    appStore = createPanelSettingsStore();
  }
  return appStore;
}

export interface UsePanelSettings {
  readonly settings: ChatPanelSettings;
  readonly setSettings: (next: ChatPanelSettings) => void;
  readonly resetSettings: () => void;
}

/**
 * Subscribe to the shared panel-settings store. The optional store argument
 * is the test seam (the layout store's `useChatLayout(store?)` pattern);
 * production uses the module singleton.
 */
export function usePanelSettings(store?: ChatPanelSettingsStore): UsePanelSettings {
  const s = store ?? panelSettingsStore();
  const settings = useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
  return { settings, setSettings: s.set, resetSettings: () => s.reset() };
}
