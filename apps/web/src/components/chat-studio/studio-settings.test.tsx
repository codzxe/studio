/**
 * Studio settings tests (the chat-first settings module) — the store model
 * (defaults, the set/subscribe roundtrip, clamp-on-set), the localStorage
 * persistence contract (validated + re-clamped load, best-effort save,
 * SSR-safe server snapshot), the singleton + hook seam, and the panel
 * (every control toggles, aria-pressed state follows the props, the close
 * gesture). Deterministic; no network; jsdom.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_FIRST_SETTINGS_STORAGE_KEY,
  type ChatFirstSettings,
  type ChatFirstSettingsStore,
  DEFAULT_SETTINGS,
  StudioSettingsPanel,
  chatFirstSettingsStore,
  clampChatFirstSettings,
  createChatFirstSettingsStore,
  loadChatFirstSettings,
  saveChatFirstSettings,
  useChatFirstSettings,
} from "./studio-settings-panel";

const COMPACT: ChatFirstSettings = {
  density: "compact",
  showTimestamps: false,
  reduceMotion: true,
  autoScrollFollow: false,
};

/** The persisted record (null when absent) — read back through the pinned key. */
function readStored(): unknown {
  const raw = window.localStorage.getItem(CHAT_FIRST_SETTINGS_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("chat-first settings model", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("exposes the pinned defaults, and a fresh store starts on them", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      density: "normal",
      showTimestamps: true,
      reduceMotion: false,
      autoScrollFollow: true,
    });
    const store = createChatFirstSettingsStore();
    expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS);
    expect(store.getServerSnapshot()).toEqual(DEFAULT_SETTINGS);
  });

  it("runs the set/subscribe roundtrip and stops notifying after unsubscribe", () => {
    const store = createChatFirstSettingsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    act(() => {
      store.set(COMPACT);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual(COMPACT);

    // Value-equal set → no commit (the snapshot stays referentially stable).
    act(() => {
      store.set({ ...COMPACT });
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    act(() => {
      store.set(DEFAULT_SETTINGS);
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clamps out-of-contract writes on every set and persists the clamped value", () => {
    const store = createChatFirstSettingsStore();
    act(() => {
      store.set({
        density: "compact",
        showTimestamps: "yes" as unknown as boolean,
        reduceMotion: true,
        autoScrollFollow: 0 as unknown as boolean,
      });
    });
    const clamped = { ...DEFAULT_SETTINGS, density: "compact", reduceMotion: true };
    expect(store.getSnapshot()).toEqual(clamped);
    expect(readStored()).toEqual(clamped);
  });

  it("clamps field-by-field: invalid fields fall back, valid fields survive", () => {
    expect(
      clampChatFirstSettings({
        density: "compact",
        showTimestamps: false,
        reduceMotion: "off",
        autoScrollFollow: null,
      }),
    ).toEqual({
      density: "compact",
      showTimestamps: false,
      reduceMotion: false,
      autoScrollFollow: true,
    });
    expect(clampChatFirstSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(clampChatFirstSettings("junk")).toEqual(DEFAULT_SETTINGS);
    expect(clampChatFirstSettings({ density: "compact" })).toEqual({
      ...DEFAULT_SETTINGS,
      density: "compact",
    });
  });

  it("persists every set and restores the persisted settings on construction", () => {
    const store = createChatFirstSettingsStore();
    act(() => {
      store.set(COMPACT);
    });
    expect(readStored()).toEqual(COMPACT);
    expect(createChatFirstSettingsStore().getSnapshot()).toEqual(COMPACT);
  });

  it("falls back to the defaults on corrupt JSON and re-clamps invalid values on load", () => {
    window.localStorage.setItem(CHAT_FIRST_SETTINGS_STORAGE_KEY, "{not json");
    expect(loadChatFirstSettings()).toEqual(DEFAULT_SETTINGS);

    window.localStorage.setItem(
      CHAT_FIRST_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        density: "cozy",
        showTimestamps: "yes",
        reduceMotion: false,
        autoScrollFollow: 0,
      }),
    );
    expect(loadChatFirstSettings()).toEqual({
      density: "normal",
      showTimestamps: true,
      reduceMotion: false,
      autoScrollFollow: true,
    });

    // Partial records keep their valid fields (per-field clamp, not all-or-nothing).
    window.localStorage.setItem(
      CHAT_FIRST_SETTINGS_STORAGE_KEY,
      JSON.stringify({ density: "compact", showTimestamps: false }),
    );
    expect(loadChatFirstSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      density: "compact",
      showTimestamps: false,
    });
  });

  it("is SSR-safe: no window → the defaults on load and a no-op save", () => {
    vi.stubGlobal("window", undefined);
    try {
      expect(loadChatFirstSettings()).toEqual(DEFAULT_SETTINGS);
      expect(() => saveChatFirstSettings(COMPACT)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(window.localStorage.getItem(CHAT_FIRST_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("keeps the hydration contract: the server snapshot is the defaults even with persisted state", () => {
    saveChatFirstSettings(COMPACT);
    const store = createChatFirstSettingsStore();
    expect(store.getSnapshot()).toEqual(COMPACT);
    expect(store.getServerSnapshot()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("chatFirstSettingsStore — the app singleton", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shares one store across get/set/subscribe/reset, persisted under the pinned key", () => {
    const listener = vi.fn();
    const unsubscribe = chatFirstSettingsStore.subscribe(listener);

    act(() => {
      chatFirstSettingsStore.set(COMPACT);
    });
    expect(chatFirstSettingsStore.getSnapshot()).toEqual(COMPACT);
    expect(listener).toHaveBeenCalled();
    expect(readStored()).toEqual(COMPACT);

    act(() => {
      chatFirstSettingsStore.reset();
    });
    expect(chatFirstSettingsStore.getSnapshot()).toEqual(DEFAULT_SETTINGS);
    expect(readStored()).toEqual(DEFAULT_SETTINGS);

    unsubscribe();
  });
});

function SettingsProbe({ store }: { readonly store: ChatFirstSettingsStore }): ReactElement {
  const { settings, setSettings, resetSettings } = useChatFirstSettings(store);
  return (
    <div>
      <span data-testid="hook-snapshot">
        {settings.density}:{String(settings.showTimestamps)}
      </span>
      <button
        type="button"
        data-testid="hook-set"
        onClick={() => setSettings({ ...settings, density: "compact", showTimestamps: false })}
      >
        set
      </button>
      <button type="button" data-testid="hook-reset" onClick={() => resetSettings()}>
        reset
      </button>
    </div>
  );
}

describe("useChatFirstSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("subscribes via useSyncExternalStore and re-renders on set/reset", async () => {
    const user = userEvent.setup();
    const store = createChatFirstSettingsStore();
    render(<SettingsProbe store={store} />);

    expect(screen.getByTestId("hook-snapshot")).toHaveTextContent("normal:true");
    await user.click(screen.getByTestId("hook-set"));
    expect(screen.getByTestId("hook-snapshot")).toHaveTextContent("compact:false");
    expect(store.getSnapshot()).toEqual({
      ...DEFAULT_SETTINGS,
      density: "compact",
      showTimestamps: false,
    });
    await user.click(screen.getByTestId("hook-reset"));
    expect(screen.getByTestId("hook-snapshot")).toHaveTextContent("normal:true");
  });
});

describe("StudioSettingsPanel", () => {
  function mount(options?: { readonly settings?: ChatFirstSettings }) {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <StudioSettingsPanel
        open
        settings={options?.settings ?? DEFAULT_SETTINGS}
        onChange={onChange}
        onClose={onClose}
      />,
    );
    return { onChange, onClose };
  }

  it("renders every control with the default aria-pressed state and the local-data footer", () => {
    mount();
    expect(screen.getByTestId("studio-settings-panel")).toBeInTheDocument();
    expect(screen.getByTestId("studio-settings-density-normal")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("studio-settings-density-compact")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("studio-settings-timestamps")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("studio-settings-reduce-motion")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("studio-settings-autoscroll")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("studio-settings-close")).toHaveAccessibleName("Close settings");
    expect(screen.getByText("Data lives in this browser")).toBeInTheDocument();
  });

  it("toggles timestamps / reduce-motion / autoscroll through the switches", async () => {
    const user = userEvent.setup();
    const { onChange } = mount();
    await user.click(screen.getByTestId("studio-settings-timestamps"));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, showTimestamps: false });
    await user.click(screen.getByTestId("studio-settings-reduce-motion"));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, reduceMotion: true });
    await user.click(screen.getByTestId("studio-settings-autoscroll"));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, autoScrollFollow: false });
  });

  it("switches density through the segmented control (both ways)", async () => {
    const user = userEvent.setup();
    const { onChange } = mount();
    await user.click(screen.getByTestId("studio-settings-density-compact"));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, density: "compact" });
    await user.click(screen.getByTestId("studio-settings-density-normal"));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_SETTINGS);
  });

  it("reflects non-default settings in every pressed state (controlled render)", () => {
    const props = { onChange: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<StudioSettingsPanel open settings={COMPACT} {...props} />);
    expect(screen.getByTestId("studio-settings-density-compact")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("studio-settings-timestamps")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("studio-settings-reduce-motion")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("studio-settings-autoscroll")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    rerender(<StudioSettingsPanel open settings={DEFAULT_SETTINGS} {...props} />);
    expect(screen.getByTestId("studio-settings-density-normal")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("studio-settings-timestamps")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("fires onClose from the ✕ button", async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    await user.click(screen.getByTestId("studio-settings-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders nothing while closed", () => {
    render(
      <StudioSettingsPanel
        open={false}
        settings={DEFAULT_SETTINGS}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("studio-settings-panel")).not.toBeInTheDocument();
  });

  it("wires to the real store end-to-end: clicks persist through the shared hook", async () => {
    const user = userEvent.setup();
    const store = createChatFirstSettingsStore();
    function Harness(): ReactElement {
      const { settings, setSettings } = useChatFirstSettings(store);
      return (
        <StudioSettingsPanel
          open
          settings={settings}
          onChange={setSettings}
          onClose={() => undefined}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByTestId("studio-settings-density-compact"));
    await user.click(screen.getByTestId("studio-settings-reduce-motion"));
    const expected = { ...DEFAULT_SETTINGS, density: "compact", reduceMotion: true };
    expect(store.getSnapshot()).toEqual(expected);
    expect(readStored()).toEqual(expected);
  });
});
