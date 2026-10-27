/**
 * ModelsPreferencesView tests (W2-07) — the §8.9 "Models" + "Preferences"
 * surfaces:
 *
 * - models.list → the allowed models + the default-model radio writing the
 *   studio.chat.model.v1 seam (preselect = the plan's first model while
 *   nothing is saved; a saved off-plan default reads as unselected + note);
 * - the auto-apply toggle: D-22 copy VERBATIM ("Apply is always your
 *   explicit click"), OPTIMISTIC flip, server adoption on success, typed
 *   §7.3 revert on failure, and the sanitized generic degrade;
 * - the chat layout reset clearing studio.chat.layout.v1 (ECUX §2.5);
 * - the dark-only honest note (§8.9 "Preferences: theme (dark only v1)").
 *
 * Deterministic RTL; the port is faked; no network.
 */

import { ApiError } from "@studio/api-client";
import type { SettingsResponse } from "@studio/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelsPreferencesView } from "./models-preferences-view";
import {
  DEFAULT_MODEL_STORAGE_KEY,
  readDefaultModel,
  writeDefaultModel,
} from "./models-preferences-view";
import type { SettingsPort } from "./settings-port";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAST = {
  id: "studio-fast",
  tier: "fast",
  use: "Quick drafts and everyday edits",
  creditsPer1kInput: 0.01,
  creditsPer1kOutput: 0.03,
};

const SMART = {
  id: "studio-smart",
  tier: "smart",
  use: "Multi-step reasoning and complex motion",
  creditsPer1kInput: 0.12,
  creditsPer1kOutput: 0.4,
};

function fakePort(overrides: Partial<SettingsPort> = {}): SettingsPort {
  return {
    createApiKey: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listApiKeys: vi.fn().mockRejectedValue(new Error("not stubbed")),
    revokeApiKey: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listAudit: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listModels: vi.fn().mockResolvedValue({ plan: "pro", models: [FAST, SMART] }),
    getSettings: vi.fn().mockResolvedValue({ autoApplyEnabled: false }),
    updateSettings: vi.fn().mockResolvedValue({ autoApplyEnabled: true }),
    ...overrides,
  };
}

function renderView(port: SettingsPort) {
  return render(<ModelsPreferencesView workspaceId="ws_first" api={port} />);
}

beforeEach(() => {
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Models + the default-model seam
// ---------------------------------------------------------------------------

describe("ModelsPreferencesView — models & default model", () => {
  it("renders the allowed models from models.list; the first is preselected while nothing is saved", async () => {
    const port = fakePort();
    renderView(port);

    expect(await screen.findByTestId("model-option-studio-fast")).toBeInTheDocument();
    expect(screen.getByTestId("model-option-studio-smart")).toBeInTheDocument();
    // Display names + tier labels come from the chat picker's helpers — one
    // name per model id across every surface.
    expect(screen.getByTestId("models-radio-group")).toHaveTextContent("Fast");
    expect(screen.getByTestId("models-radio-group")).toHaveTextContent("Smart");
    // Nothing saved → the plan's first model is the effective default.
    expect(screen.getByTestId("model-option-studio-fast")).toHaveAttribute("data-active");
    expect(screen.getByTestId("model-option-studio-smart")).not.toHaveAttribute("data-active");
    expect(port.listModels).toHaveBeenCalledTimes(1);
    expect(readDefaultModel()).toBeNull();
  });

  it("picking a model writes the studio.chat.model.v1 seam", async () => {
    const port = fakePort();
    const user = userEvent.setup();
    renderView(port);
    await screen.findByTestId("model-option-studio-fast");

    await user.click(screen.getByTestId("model-radio-studio-smart"));

    expect(window.localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY)).toBe("studio-smart");
    expect(screen.getByTestId("model-option-studio-smart")).toHaveAttribute("data-active");
    expect(screen.getByTestId("model-option-studio-fast")).not.toHaveAttribute("data-active");
  });

  it("a saved default is honored on load (the seam is read at mount)", async () => {
    writeDefaultModel("studio-smart");
    const port = fakePort();
    renderView(port);

    await screen.findByTestId("model-option-studio-smart");
    expect(screen.getByTestId("model-option-studio-smart")).toHaveAttribute("data-active");
    expect(screen.getByTestId("model-option-studio-fast")).not.toHaveAttribute("data-active");
  });

  it("a saved default that is off-plan reads as unselected + the honest note", async () => {
    writeDefaultModel("studio-vision"); // not on the pro list above
    const port = fakePort();
    renderView(port);

    expect(await screen.findByTestId("model-off-plan-note")).toHaveTextContent(
      "Your saved default isn’t on this plan",
    );
    expect(screen.getByTestId("model-option-studio-fast")).not.toHaveAttribute("data-active");
    expect(screen.getByTestId("model-option-studio-smart")).not.toHaveAttribute("data-active");
  });

  it("surfaces the typed models failure and retries", async () => {
    const port = fakePort({
      listModels: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError({
            code: "INTERNAL_ERROR",
            message: "Something went wrong on our side.",
            status: 500,
          }),
        )
        .mockResolvedValueOnce({ plan: "pro", models: [FAST, SMART] }),
    });
    renderView(port);

    expect(await screen.findByTestId("models-error")).toHaveTextContent(
      "Something went wrong on our side.",
    );
    await userEvent.click(screen.getByTestId("models-retry"));
    expect(await screen.findByTestId("model-option-studio-fast")).toBeInTheDocument();
  });

  it("empty entitlement surface → the honest empty state", async () => {
    const port = fakePort({
      listModels: vi.fn().mockResolvedValue({ plan: "trial", models: [] }),
    });
    renderView(port);
    expect(await screen.findByTestId("models-empty")).toHaveTextContent(
      "No models available on this plan.",
    );
  });
});

// ---------------------------------------------------------------------------
// Auto-apply (round-10 v2 — the agent executes safe plans; opt-out here)
// ---------------------------------------------------------------------------

describe("ModelsPreferencesView — auto-apply (round-10 v2)", () => {
  it("carries the v2 copy: the agent applies safe plans; Undo reverts", async () => {
    renderView(fakePort());
    await screen.findByTestId("auto-apply-toggle");
    expect(screen.getByTestId("auto-apply-card")).toHaveTextContent("one Undo reverts a whole run");
    expect(screen.getByTestId("auto-apply-card")).toHaveTextContent(
      "Deleting, replacing or exporting always waits for your review",
    );
  });

  it("toggle is OPTIMISTIC: it flips before the PATCH resolves, then adopts the server value", async () => {
    let resolveUpdate: (value: SettingsResponse) => void = () => {};
    const port = fakePort({
      updateSettings: vi.fn().mockImplementation(
        () =>
          new Promise<SettingsResponse>((resolve) => {
            resolveUpdate = resolve;
          }),
      ),
    });
    const user = userEvent.setup();
    renderView(port);
    const toggle = await screen.findByTestId("auto-apply-toggle");

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("auto-apply-state")).toHaveTextContent("Always ask before applying");

    await user.click(toggle);
    // Optimistic: on BEFORE the response lands.
    expect(toggle).toHaveAttribute("aria-checked", "true");

    resolveUpdate({ autoApplyEnabled: true });
    await waitFor(() => {
      expect(screen.getByTestId("auto-apply-state")).toHaveTextContent("Auto-apply safe plans");
    });
    expect(port.updateSettings).toHaveBeenCalledWith({ autoApplyEnabled: true });
  });

  it("a typed PATCH failure REVERTS the flip and surfaces the §7.3 message + hint", async () => {
    // Deferred rejection so the OPTIMISTIC flip is observable before the
    // failure lands (an immediately-rejected mock reverts within the click).
    let rejectUpdate: (reason?: unknown) => void = () => {};
    const port = fakePort({
      updateSettings: vi.fn().mockImplementation(
        () =>
          new Promise<SettingsResponse>((_, reject) => {
            rejectUpdate = reject;
          }),
      ),
    });
    const user = userEvent.setup();
    renderView(port);
    const toggle = await screen.findByTestId("auto-apply-toggle");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true"); // optimistic

    rejectUpdate(
      new ApiError({
        code: "VALIDATION_FAILED",
        message: "That request didn't look right.",
        hint: "Check the input and try again.",
        status: 400,
        requestId: "req_fixme",
      }),
    );

    expect(await screen.findByTestId("auto-apply-error")).toHaveTextContent(
      "That request didn't look right.",
    );
    expect(screen.getByTestId("auto-apply-error")).toHaveTextContent(
      "Check the input and try again.",
    );
    // Reverted to the server truth.
    await waitFor(() => {
      expect(screen.getByTestId("auto-apply-toggle")).toHaveAttribute("aria-checked", "false");
    });
  });

  it("an unexpected throw degrades to the sanitized generic — never a stack", async () => {
    // A raw client-side throw (network TypeError etc.): the port surface is
    // fully landed now, so the only remaining failure arms are typed ApiErrors
    // and unexpected throws — the latter must read as the bounded §7.3 generic.
    const port = fakePort({
      getSettings: vi.fn().mockRejectedValue(new TypeError("fetch failed /var/secrets")),
    });
    renderView(port);

    expect(await screen.findByTestId("auto-apply-unavailable")).toHaveTextContent(
      "Something went wrong on our side.",
    );
    expect(screen.getByTestId("auto-apply-unavailable")).not.toHaveTextContent("fetch failed");
    expect(screen.queryByTestId("auto-apply-toggle")).not.toBeInTheDocument();
  });

  it("a failed settings load offers retry and recovers", async () => {
    const port = fakePort({
      getSettings: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError({
            code: "INTERNAL_ERROR",
            message: "Something went wrong on our side.",
            status: 500,
          }),
        )
        .mockResolvedValueOnce({ autoApplyEnabled: true }),
    });
    renderView(port);

    expect(await screen.findByTestId("auto-apply-unavailable")).toHaveTextContent(
      "Something went wrong on our side.",
    );
    await userEvent.click(screen.getByTestId("auto-apply-retry"));
    const toggle = await screen.findByTestId("auto-apply-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

// ---------------------------------------------------------------------------
// Chat layout reset (ECUX §2.5) + appearance
// ---------------------------------------------------------------------------

describe("ModelsPreferencesView — chat layout reset & appearance", () => {
  it("clears the studio.chat.layout.v1 ECUX key and confirms", async () => {
    // The REAL key the chat overlay persists under (D-10 ECUX-literal).
    window.localStorage.setItem(
      "studio.chat.layout.v1",
      JSON.stringify({ mode: "sidebar", x: 10, y: 20, w: 400, h: 600 }),
    );
    const user = userEvent.setup();
    renderView(fakePort());
    await screen.findByTestId("chat-layout-reset");

    await user.click(screen.getByTestId("chat-layout-reset"));

    expect(window.localStorage.getItem("studio.chat.layout.v1")).toBeNull();
    expect(await screen.findByTestId("chat-layout-reset-note")).toHaveTextContent(
      "the editor opens with the default panel next time",
    );
  });

  it("dark-only: the honest note, never a fake theme toggle", async () => {
    renderView(fakePort());
    expect(await screen.findByTestId("dark-only-note")).toHaveTextContent("dark-only in v1");
    expect(screen.queryByRole("switch", { name: /theme/i })).not.toBeInTheDocument();
  });
});
