"use client";

/**
 * StudioSettingsPanel — the chat-first studio's settings module (ONE file,
 * two halves):
 *
 * 1. **The store** — the user's chat preferences (density, message
 *    timestamps, reduce-motion, auto-scroll follow) as a
 *    `useSyncExternalStore` external store, persisted in localStorage under
 *    `studio.chat-first.settings.v1`. It mirrors the editor's
 *    panel-settings pattern exactly: pure, never-throwing model code;
 *    SSR-safe DEFAULT server snapshot (hydration-safe); validated +
 *    re-clamped on load (corrupt JSON → defaults, invalid FIELDS → their
 *    default — per field, not all-or-nothing); clamped + best-effort saved
 *    on every set.
 * 2. **The panel** — a presentational popover card listing each setting as
 *    a labelled row (a segmented control for density, switch-style
 *    `aria-pressed` buttons for the booleans) with a "Data lives in this
 *    browser" footer. The open state is the PARENT's: `open`/`onClose`
 *    props, no portals, no storage writes here.
 *
 * Intended wiring (the editor's PanelSettingsPopover contract, chat-first):
 *
 *   const { settings, setSettings } = useChatFirstSettings();
 *   <StudioSettingsPanel
 *     open={settingsOpen}
 *     settings={settings}
 *     onChange={setSettings}
 *     onClose={() => setSettingsOpen(false)}
 *   />
 *
 * The card is `absolute right/top` — mount it inside a `relative` ancestor
 * (the mode bar / the surface's header row).
 */

import { X } from "lucide-react";
import { type ReactElement, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Model (the panel-settings.ts pattern, chat-first)
// ---------------------------------------------------------------------------

export type ChatFirstDensity = "compact" | "normal";

export interface ChatFirstSettings {
  /** Rail + message spacing ("compact" tightens the chat surface's gaps). */
  readonly density: ChatFirstDensity;
  /** Render message timestamps in the thread. */
  readonly showTimestamps: boolean;
  /** Trim animations + streaming flourishes (a manual prefers-reduced-motion). */
  readonly reduceMotion: boolean;
  /** Keep the newest message pinned in view while a run streams. */
  readonly autoScrollFollow: boolean;
}

/** D-10 discipline: the key is the chat-first literal, versioned. */
export const CHAT_FIRST_SETTINGS_STORAGE_KEY = "studio.chat-first.settings.v1";

export const DEFAULT_SETTINGS: ChatFirstSettings = {
  density: "normal",
  showTimestamps: true,
  reduceMotion: false,
  autoScrollFollow: true,
};

/**
 * Clamp any input into a total, valid `ChatFirstSettings`: unknown shapes
 * fall back to `DEFAULT_SETTINGS`, invalid FIELDS fall back per field (so a
 * partially corrupt record keeps its valid knobs). Pure and total — the
 * load path AND every store write go through this.
 */
export function clampChatFirstSettings(raw: unknown): ChatFirstSettings {
  const candidate = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    Record<keyof ChatFirstSettings, unknown>
  >;
  return {
    density:
      candidate.density === "compact" || candidate.density === "normal"
        ? candidate.density
        : DEFAULT_SETTINGS.density,
    showTimestamps:
      typeof candidate.showTimestamps === "boolean"
        ? candidate.showTimestamps
        : DEFAULT_SETTINGS.showTimestamps,
    reduceMotion:
      typeof candidate.reduceMotion === "boolean"
        ? candidate.reduceMotion
        : DEFAULT_SETTINGS.reduceMotion,
    autoScrollFollow:
      typeof candidate.autoScrollFollow === "boolean"
        ? candidate.autoScrollFollow
        : DEFAULT_SETTINGS.autoScrollFollow,
  };
}

/** Load persisted settings (validated + re-clamped); defaults when absent/corrupt. */
export function loadChatFirstSettings(): ChatFirstSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(CHAT_FIRST_SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return clampChatFirstSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS; // quota/private mode/corrupt JSON — never fatal
  }
}

/** Persist best-effort (quota-safe; the in-memory store stays truth). */
export function saveChatFirstSettings(settings: ChatFirstSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_FIRST_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota exceeded / storage disabled — never fatal.
  }
}

// ---------------------------------------------------------------------------
// Store (the use-layout.ts pattern, hydration-safe)
// ---------------------------------------------------------------------------

export interface ChatFirstSettingsStore {
  getSnapshot(): ChatFirstSettings;
  getServerSnapshot(): ChatFirstSettings;
  subscribe(listener: () => void): () => void;
  set(next: ChatFirstSettings): void;
  reset(): void;
}

/**
 * Create a settings store. The app uses the module singleton (below); tests
 * create isolated stores with injectable initial/load. Every write is
 * clamped, persisted (best-effort) and value-checked: a value-equal set
 * stays silent so `useSyncExternalStore`'s snapshot stays referentially
 * stable.
 */
export function createChatFirstSettingsStore(options?: {
  readonly initial?: ChatFirstSettings;
  readonly load?: () => ChatFirstSettings;
}): ChatFirstSettingsStore {
  const load = options?.load ?? loadChatFirstSettings;
  const listeners = new Set<() => void>();
  let current = options?.initial ?? load();
  return {
    getSnapshot: () => current,
    getServerSnapshot: () => DEFAULT_SETTINGS,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      const clamped = clampChatFirstSettings(next);
      if (
        clamped.density === current.density &&
        clamped.showTimestamps === current.showTimestamps &&
        clamped.reduceMotion === current.reduceMotion &&
        clamped.autoScrollFollow === current.autoScrollFollow
      ) {
        return;
      }
      current = clamped;
      saveChatFirstSettings(current);
      for (const listener of [...listeners]) listener();
    },
    reset() {
      this.set(DEFAULT_SETTINGS);
    },
  };
}

/** The app singleton — the ONE store every consumer shares (module-scope, SSR-safe: the load path reads defaults without a window). */
export const chatFirstSettingsStore: ChatFirstSettingsStore = createChatFirstSettingsStore();

export interface UseChatFirstSettings {
  readonly settings: ChatFirstSettings;
  readonly setSettings: (next: ChatFirstSettings) => void;
  readonly resetSettings: () => void;
}

/**
 * Subscribe to the shared chat-first settings store. The optional `store`
 * argument is the test/embedding seam (the `useChatLayout(store?)` pattern);
 * production uses the module singleton. Hydration-safe via
 * `useSyncExternalStore`'s server snapshot (server renders DEFAULT_SETTINGS;
 * React re-renders once on the client if the persisted settings differ).
 */
export function useChatFirstSettings(store?: ChatFirstSettingsStore): UseChatFirstSettings {
  const s = store ?? chatFirstSettingsStore;
  const settings = useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
  return { settings, setSettings: s.set, resetSettings: () => s.reset() };
}

// ---------------------------------------------------------------------------
// StudioSettingsPanel (presentational — the parent owns open + the store)
// ---------------------------------------------------------------------------

export interface StudioSettingsPanelProps {
  /** Whether the card is visible (the parent owns the open state). */
  readonly open: boolean;
  /** Current settings (the shared store's snapshot — render truth). */
  readonly settings: ChatFirstSettings;
  /** Persist the next settings (the shared store's `set`). */
  readonly onChange: (next: ChatFirstSettings) => void;
  /** Dismissal gesture (the ✕ button; the parent owns Esc/backdrop). */
  readonly onClose: () => void;
}

/** One labelled row with a switch-style toggle button (`aria-pressed`). */
function ToggleRow(props: {
  readonly label: string;
  readonly hint: string;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-caption text-primary">{props.label}</span>
        <span className="text-hint text-muted">{props.hint}</span>
      </div>
      <button
        type="button"
        aria-label={props.ariaLabel}
        aria-pressed={props.pressed}
        data-testid={props.testId}
        onClick={props.onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-pill border duration-120 ease-out ${
          props.pressed ? "border-signal bg-signal" : "border-subtle bg-input"
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-pill transition-all duration-120 ease-out ${
            props.pressed ? "left-[19px] bg-primary" : "left-[3px] bg-muted"
          }`}
        />
      </button>
    </div>
  );
}

export function StudioSettingsPanel({
  open,
  settings,
  onChange,
  onClose,
}: StudioSettingsPanelProps): ReactElement | null {
  if (!open) return null;

  const patch = (partial: Partial<ChatFirstSettings>): void => {
    onChange({ ...settings, ...partial });
  };
  const densities: readonly ChatFirstDensity[] = ["normal", "compact"];

  return (
    <div
      data-testid="studio-settings-panel"
      // biome-ignore lint/a11y/useSemanticElements: the studio overlay pattern is a positioned div — a native <dialog> needs showModal()/top-layer semantics the surface-owned trigger must not take
      role="dialog"
      aria-modal={false}
      aria-label="Chat settings"
      className="absolute top-12 right-3 z-30 w-64 animate-pop-in rounded-md border border-subtle bg-panel shadow-pop"
    >
      {/* -- header ------------------------------------------------------------ */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle px-3">
        <span className="text-label uppercase tracking-wide text-primary">Chat settings</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close settings"
          data-testid="studio-settings-close"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-xs text-secondary duration-120 ease-out hover:bg-elevated hover:text-primary"
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {/* -- knobs --------------------------------------------------------------- */}
      <div className="flex flex-col gap-3.5 p-3">
        <div className="flex w-full flex-col gap-1.5">
          <span className="text-caption text-primary">Density</span>
          <fieldset
            aria-label="Density"
            className="flex w-full gap-1 rounded-sm border border-border bg-elevated p-0.5"
          >
            {densities.map((density) => {
              const active = settings.density === density;
              return (
                <button
                  key={density}
                  type="button"
                  aria-pressed={active}
                  data-testid={`studio-settings-density-${density}`}
                  onClick={() => patch({ density })}
                  className={`h-6 flex-1 rounded-xs text-caption transition-colors duration-120 ${
                    active ? "bg-input text-primary" : "text-secondary hover:text-primary"
                  }`}
                >
                  {density === "normal" ? "Normal" : "Compact"}
                </button>
              );
            })}
          </fieldset>
        </div>

        <ToggleRow
          label="Timestamps"
          hint="Show message times in the thread"
          ariaLabel="Show timestamps"
          testId="studio-settings-timestamps"
          pressed={settings.showTimestamps}
          onToggle={() => patch({ showTimestamps: !settings.showTimestamps })}
        />
        <ToggleRow
          label="Reduce motion"
          hint="Trim animations and streaming flourishes"
          ariaLabel="Reduce motion"
          testId="studio-settings-reduce-motion"
          pressed={settings.reduceMotion}
          onToggle={() => patch({ reduceMotion: !settings.reduceMotion })}
        />
        <ToggleRow
          label="Auto-scroll follow"
          hint="Keep the newest message in view while streaming"
          ariaLabel="Auto-scroll follow"
          testId="studio-settings-autoscroll"
          pressed={settings.autoScrollFollow}
          onToggle={() => patch({ autoScrollFollow: !settings.autoScrollFollow })}
        />
      </div>

      {/* -- foot: the honest privacy line -------------------------------------- */}
      <div className="shrink-0 border-t border-subtle px-3 py-2">
        <p className="text-caption text-muted">Data lives in this browser</p>
      </div>
    </div>
  );
}
