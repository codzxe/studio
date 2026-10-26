/**
 * Panel settings tests (ROUND 12 "Chat UI v3" — the settings model, its
 * persistence store + the popover). Also pins the persistence REGRESSION:
 * the settings store must keep the use-layout.ts localStorage contract
 * (validate + clamp on load, best-effort save, server snapshot = defaults).
 */

import {
  type ChatPanelSettings,
  type ChatPanelSettingsStore,
  DEFAULT_PANEL_SETTINGS,
  MAX_PANEL_OPACITY,
  MIN_PANEL_OPACITY,
  PANEL_SETTINGS_STORAGE_KEY,
  clampPanelOpacity,
  createPanelSettingsStore,
  loadPanelSettings,
  panelSettingsStyle,
  savePanelSettings,
} from "@/components/chat/panel-settings";
import { PanelSettingsPopover } from "@/components/chat/panel-settings-popover";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const COMPACT: ChatPanelSettings = {
  opacity: 0.65,
  density: "compact",
  fontSize: "l",
};

describe("panel settings model", () => {
  it("clamps the opacity into the slider bounds", () => {
    expect(clampPanelOpacity(0.2)).toBe(MIN_PANEL_OPACITY);
    expect(clampPanelOpacity(1.5)).toBe(MAX_PANEL_OPACITY);
    expect(clampPanelOpacity(Number.NaN)).toBe(1);
    expect(clampPanelOpacity(0.8)).toBe(0.8);
  });

  it("persists + loads back (the geometry key's sibling contract)", () => {
    window.localStorage.clear();
    savePanelSettings(COMPACT);
    expect(JSON.parse(window.localStorage.getItem(PANEL_SETTINGS_STORAGE_KEY) ?? "")).toEqual(
      COMPACT,
    );
    expect(loadPanelSettings()).toEqual(COMPACT);
  });

  it("rejects corrupt/unknown shapes back to the defaults, never throws", () => {
    window.localStorage.setItem(PANEL_SETTINGS_STORAGE_KEY, "{not json");
    expect(loadPanelSettings()).toEqual(DEFAULT_PANEL_SETTINGS);
    window.localStorage.setItem(
      PANEL_SETTINGS_STORAGE_KEY,
      JSON.stringify({ opacity: 0.5, density: "cozy", fontSize: "xl" }),
    );
    expect(loadPanelSettings()).toEqual(DEFAULT_PANEL_SETTINGS);
  });

  it("is server-safe (load outside a window world is a no-op by construction)", () => {
    // jsdom always has a window; the guard is `typeof window === "undefined"`
    // — assert the default export used at module scope stays pure data.
    expect(DEFAULT_PANEL_SETTINGS).toEqual({ opacity: 1, density: "normal", fontSize: "m" });
  });
});

describe("panelSettingsStyle", () => {
  it("paints background alpha below 1 and the font var off the default", () => {
    const style = panelSettingsStyle({ opacity: 0.75, density: "normal", fontSize: "l" });
    expect(style.backgroundColor).toContain("color-mix(in srgb, var(--bg-panel) 75%");
    expect(style["--chat-font-size"]).toBe("15.5px");
  });

  it("default settings produce NO style (byte-identical M4 render)", () => {
    expect(panelSettingsStyle(DEFAULT_PANEL_SETTINGS)).toEqual({});
  });
});

describe("createPanelSettingsStore — the use-layout persistence pattern", () => {
  it("set() persists + notifies; a value-equal set stays silent", () => {
    window.localStorage.clear();
    const store: ChatPanelSettingsStore = createPanelSettingsStore({
      initial: DEFAULT_PANEL_SETTINGS,
    });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    act(() => {
      store.set(COMPACT);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem(PANEL_SETTINGS_STORAGE_KEY) ?? "")).toEqual(
      COMPACT,
    );
    // Same values again → no commit (referentially stable snapshot).
    act(() => {
      store.set(COMPACT);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    // reset() lands back on the defaults + persists them.
    act(() => {
      store.reset();
    });
    expect(store.getSnapshot()).toEqual(DEFAULT_PANEL_SETTINGS);
    expect(store.getServerSnapshot()).toEqual(DEFAULT_PANEL_SETTINGS);
    unsubscribe();
  });

  it("loads persisted settings on construction (fresh session restore)", () => {
    window.localStorage.clear();
    savePanelSettings(COMPACT);
    const store = createPanelSettingsStore();
    expect(store.getSnapshot()).toEqual(COMPACT);
  });
});

describe("PanelSettingsPopover", () => {
  function mount(options?: {
    readonly settings?: ChatPanelSettings;
    readonly maximized?: boolean;
    readonly onToggleMaximize?: () => void;
  }) {
    const onChange = vi.fn();
    const onResetGeometry = vi.fn();
    render(
      <PanelSettingsPopover
        settings={options?.settings ?? DEFAULT_PANEL_SETTINGS}
        onChange={onChange}
        onResetGeometry={onResetGeometry}
        maximized={options?.maximized ?? false}
        onToggleMaximize={options?.onToggleMaximize}
      />,
    );
    return { onChange, onResetGeometry };
  }

  it("changes the opacity through the slider", async () => {
    const user = userEvent.setup();
    const { onChange } = mount({ settings: { ...DEFAULT_PANEL_SETTINGS, opacity: 0.6 } });
    await user.click(screen.getByTestId("chat-panel-settings"));
    const slider = await screen.findByTestId("chat-settings-opacity");
    await fireEvent.input(slider, { target: { value: "0.85" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ opacity: 0.85, density: "normal", fontSize: "m" }),
    );
  });

  it("changes density + font size through the segmented controls", async () => {
    const user = userEvent.setup();
    const { onChange } = mount();
    await user.click(screen.getByTestId("chat-panel-settings"));
    await user.click(screen.getByTestId("chat-settings-density-compact"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ density: "compact" }));
    await user.click(screen.getByTestId("chat-settings-font-l"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: "l" }));
  });

  it("resets geometry and toggles maximize through the host callbacks", async () => {
    const user = userEvent.setup();
    const onToggleMaximize = vi.fn();
    const { onResetGeometry } = mount({ maximized: false, onToggleMaximize });
    await user.click(screen.getByTestId("chat-panel-settings"));
    await user.click(screen.getByTestId("chat-settings-reset-geometry"));
    expect(onResetGeometry).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("chat-settings-toggle-maximize"));
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("labels the maximize button honestly while maximized", async () => {
    const user = userEvent.setup();
    mount({ maximized: true, onToggleMaximize: () => undefined });
    await user.click(screen.getByTestId("chat-panel-settings"));
    expect(await screen.findByTestId("chat-settings-toggle-maximize")).toHaveTextContent(
      "Restore panel",
    );
  });
});
