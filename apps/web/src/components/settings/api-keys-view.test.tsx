/**
 * ApiKeysView tests (W2-07) — the §8.9 "API keys" surface:
 *
 * - the list: name/scopes/created/expires/lastUsedAt(null-honest "Never
 *   used")/enabled, cursor load-more with dedupe;
 * - the create dialog: Checkbox-less scope chips (aria-pressed toggles),
 *   client-side validation (name 1–32, ≥1 scope), the expiry preset →
 *   deterministic expiresAt from the RSC-stamped nowIso;
 * - the show-once law: CreatedApiKey.key renders EXACTLY ONCE with copy +
 *   "we cannot show it again"; dismissing the panel drops the secret from
 *   the DOM for good;
 * - revoke: the §7.5 type-to-confirm dialog names the KEY, the idempotent
 *   DELETE path, and the typed error banner;
 * - the honest read-only arm for non-admins (no doomed 403 fetch).
 *
 * Deterministic RTL; the port is faked; no network.
 */

import { ApiError } from "@studio/api-client";
import type { ApiKey, CreatedApiKey } from "@studio/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { API_KEY_SCOPES, ApiKeysView } from "./api-keys-view";
import type { SettingsPort } from "./settings-port";

// ---------------------------------------------------------------------------
// Fixtures (the real §7.2 wire shapes)
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-10-21T12:00:00Z";

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key_ci",
    name: "CI renders",
    scopes: ["renders:queue", "projects:read"],
    createdAt: "2026-10-01T10:00:00Z",
    expiresAt: "2027-10-01T10:00:00Z",
    lastUsedAt: null,
    enabled: true,
    ...overrides,
  };
}

function createdApiKey(overrides: Partial<CreatedApiKey> = {}): CreatedApiKey {
  return {
    ...apiKey({ id: "key_new", name: "Deploy script" }),
    startsAt: NOW_ISO,
    key: "studio_live_abcd1234efgh5678",
    ...overrides,
  };
}

function fakePort(overrides: Partial<SettingsPort> = {}): SettingsPort {
  return {
    createApiKey: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listApiKeys: vi.fn().mockRejectedValue(new Error("not stubbed")),
    revokeApiKey: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listAudit: vi.fn().mockRejectedValue(new Error("not stubbed")),
    listModels: vi.fn().mockRejectedValue(new Error("not stubbed")),
    getSettings: vi.fn().mockRejectedValue(new Error("not stubbed")),
    updateSettings: vi.fn().mockRejectedValue(new Error("not stubbed")),
    ...overrides,
  };
}

function renderView(port: SettingsPort, canManage = true) {
  return render(
    <ApiKeysView workspaceId="ws_first" canManage={canManage} nowIso={NOW_ISO} api={port} />,
  );
}

/** Keyboard-opens a Radix Select and picks the option `steps` arrows down. */
async function pickSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  steps: number,
): Promise<void> {
  trigger.focus();
  await user.keyboard("{ArrowDown}"); // open + highlight the selected option
  for (let i = 0; i < steps; i += 1) {
    await user.keyboard("{ArrowDown}");
  }
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("ApiKeysView — list", () => {
  it("renders name, scopes, created, expires, null-honest lastUsedAt and the enabled badge", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({
        items: [
          apiKey(),
          apiKey({
            id: "key_old",
            name: "Legacy",
            scopes: ["*"],
            expiresAt: null,
            lastUsedAt: "2026-10-20T09:30:00Z",
            enabled: false,
          }),
        ],
        nextCursor: null,
      }),
    });
    renderView(port);

    const rows = await screen.findAllByTestId("api-key-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("CI renders");
    expect(rows[0]).toHaveTextContent("renders:queue");
    expect(rows[0]).toHaveTextContent("Oct 1, 2026");
    expect(rows[0]).toHaveTextContent("Oct 1, 2027");
    // null-honest: the key has never authenticated — say so, never a fake date.
    expect(within(rows[0] as HTMLElement).getByTestId("api-key-never-used")).toHaveTextContent(
      "Never used",
    );
    expect(within(rows[0] as HTMLElement).getByTestId("api-key-status")).toHaveTextContent(
      "Active",
    );

    expect(rows[1]).toHaveTextContent("Never");
    expect(rows[1]).toHaveTextContent("Oct 20, 2026");
    expect(within(rows[1] as HTMLElement).getByTestId("api-key-status")).toHaveTextContent(
      "Revoked",
    );

    expect(port.listApiKeys).toHaveBeenCalledWith("ws_first", { limit: 50 });
  });

  it("load-more passes the cursor and merges (dedupe by id)", async () => {
    const port = fakePort({
      listApiKeys: vi
        .fn()
        .mockResolvedValueOnce({
          items: [apiKey()],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          items: [apiKey({ id: "key_2", name: "Second" }), apiKey()],
          nextCursor: null,
        }),
    });
    renderView(port);
    await screen.findAllByTestId("api-key-row");

    await userEvent.click(screen.getByTestId("api-keys-load-more"));

    await waitFor(() => {
      expect(port.listApiKeys).toHaveBeenNthCalledWith(2, "ws_first", {
        cursor: "cursor-2",
        limit: 50,
      });
    });
    // The duplicate key_ci from page 2 is dropped — 2 unique rows.
    await waitFor(() => {
      expect(screen.getAllByTestId("api-key-row")).toHaveLength(2);
    });
  });

  it("surfaces the typed list error and retries", async () => {
    const port = fakePort({
      listApiKeys: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError({
            code: "INTERNAL_ERROR",
            message: "Something went wrong on our side.",
            status: 500,
          }),
        )
        .mockResolvedValueOnce({ items: [apiKey()], nextCursor: null }),
    });
    renderView(port);

    expect(await screen.findByTestId("api-keys-error")).toHaveTextContent(
      "Something went wrong on our side.",
    );
    await userEvent.click(screen.getByTestId("api-keys-error-retry"));
    expect(await screen.findAllByTestId("api-key-row")).toHaveLength(1);
  });

  it("hides the table behind the honest empty state", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    renderView(port);
    expect(await screen.findByTestId("api-keys-empty")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Read-only arm
// ---------------------------------------------------------------------------

describe("ApiKeysView — non-admins", () => {
  it("renders the managed-by note and never fetches (the routes are admin-only)", () => {
    const port = fakePort();
    renderView(port, false);
    expect(screen.getByTestId("api-keys-readonly")).toHaveTextContent(
      "API keys are managed by workspace owners and admins.",
    );
    expect(port.listApiKeys).not.toHaveBeenCalled();
    expect(screen.queryByTestId("api-key-create-open")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Scope vocabulary
// ---------------------------------------------------------------------------

describe("ApiKeysView — scope vocabulary (contracts mirror)", () => {
  it("pins API_KEY_SCOPES membership AND order against the contracts constant", () => {
    expect(API_KEY_SCOPES).toEqual([
      "projects:read",
      "projects:write",
      "renders:queue",
      "chat:run",
      "billing:read",
      "*",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Create dialog + show-once
// ---------------------------------------------------------------------------

describe("ApiKeysView — create", () => {
  it("validates the name before anything is sent", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    const user = userEvent.setup();
    renderView(port);
    await user.click(await screen.findByTestId("api-key-create-open"));

    await user.click(screen.getByTestId("api-key-create-submit"));
    expect(await screen.findByTestId("api-key-create-error")).toHaveTextContent(
      "Names are 1–32 characters.",
    );
    expect(port.createApiKey).not.toHaveBeenCalled();
  });

  it("requires at least one scope", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    const user = userEvent.setup();
    renderView(port);
    await user.click(await screen.findByTestId("api-key-create-open"));

    await user.type(screen.getByTestId("api-key-name-input"), "CI renders");
    await user.click(screen.getByTestId("api-key-create-submit"));
    expect(await screen.findByTestId("api-key-create-error")).toHaveTextContent(
      "Pick at least one scope.",
    );
    expect(port.createApiKey).not.toHaveBeenCalled();
  });

  it("scope chips are Checkbox-less toggles with aria-pressed", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    const user = userEvent.setup();
    renderView(port);
    await user.click(await screen.findByTestId("api-key-create-open"));

    const chip = screen.getByTestId("scope-chip-renders-queue");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  it("mints with the deterministic expiry preset and shows the key EXACTLY ONCE", async () => {
    const minted = createdApiKey();
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      createApiKey: vi.fn().mockResolvedValue(minted),
    });
    const user = userEvent.setup();
    renderView(port);
    await user.click(await screen.findByTestId("api-key-create-open"));

    await user.type(screen.getByTestId("api-key-name-input"), "Deploy script");
    await user.click(screen.getByTestId("scope-chip-renders-queue"));
    // Expiry preset: open the Select and move one option down to "7 days".
    await pickSelectOption(user, screen.getByTestId("api-key-expiry-trigger"), 1);
    await user.click(screen.getByTestId("api-key-create-submit"));

    await waitFor(() => {
      expect(port.createApiKey).toHaveBeenCalledWith("ws_first", {
        name: "Deploy script",
        scopes: ["renders:queue"],
        // nowIso + 7 days — deterministic from the RSC-stamped instant
        // (toISOString keeps millisecond precision; still ISO-8601 wire-valid).
        expiresAt: "2026-10-28T12:00:00.000Z",
      });
    });

    // Show-once panel: the plaintext key + the cannot-show-again warning.
    expect(await screen.findByTestId("api-key-secret")).toHaveTextContent(minted.key);
    expect(screen.getByTestId("api-key-created-warning")).toHaveTextContent(
      "we cannot show it again",
    );
    // The list reloaded — the new row (WITHOUT key material) is rendered.
    await waitFor(() => {
      expect(port.listApiKeys).toHaveBeenCalledTimes(2);
    });

    // Dismiss → the secret leaves the DOM for good.
    await user.click(screen.getByTestId("api-key-done"));
    expect(screen.queryByTestId("api-key-secret")).not.toBeInTheDocument();
    expect(screen.queryByText(minted.key)).not.toBeInTheDocument();
    expect(screen.getByTestId("api-keys-view")).toBeInTheDocument();
  });

  it("copies the secret through the clipboard API and confirms", async () => {
    const minted = createdApiKey();
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      createApiKey: vi.fn().mockResolvedValue(minted),
    });
    const user = userEvent.setup();
    renderView(port);
    await user.click(await screen.findByTestId("api-key-create-open"));

    await user.type(screen.getByTestId("api-key-name-input"), "Deploy script");
    await user.click(screen.getByTestId("scope-chip-projects-read"));
    await user.click(screen.getByTestId("api-key-create-submit"));
    await screen.findByTestId("api-key-secret");

    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom's navigator.clipboard is a getter-only property — define over it.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await user.click(screen.getByTestId("api-key-copy"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(minted.key);
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("surfaces the typed create failure inside the dialog", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      createApiKey: vi.fn().mockRejectedValue(
        new ApiError({
          code: "VALIDATION_FAILED",
          message: "That request didn't look right.",
          hint: "Keys need a name (1-32 chars) and at least one scope.",
          status: 400,
        }),
      ),
    });
    const user = userEvent.setup();
    renderView(port);
    await user.click(await screen.findByTestId("api-key-create-open"));

    await user.type(screen.getByTestId("api-key-name-input"), "X");
    await user.click(screen.getByTestId("scope-chip-chat-run"));
    await user.click(screen.getByTestId("api-key-create-submit"));

    expect(await screen.findByTestId("api-key-create-error")).toHaveTextContent(
      "That request didn't look right.",
    );
    // Dialog stays open — nothing was minted.
    expect(screen.getByTestId("api-key-name-input")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

describe("ApiKeysView — revoke", () => {
  it("type-to-confirm names the KEY, then revokes through the port and reloads", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [apiKey()], nextCursor: null }),
      revokeApiKey: vi.fn().mockResolvedValue({
        id: "key_ci",
        revokedAt: NOW_ISO,
        enabled: false,
      }),
    });
    const user = userEvent.setup();
    renderView(port);
    await screen.findAllByTestId("api-key-row");

    await user.click(screen.getByTestId("api-key-revoke"));
    const confirm = screen.getByTestId("confirm-confirm");
    // §7.5: the confirm action stays disabled until the NAME is typed.
    expect(confirm).toBeDisabled();
    await user.type(screen.getByTestId("confirm-input"), "CI renders");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      expect(port.revokeApiKey).toHaveBeenCalledWith("ws_first", "key_ci");
    });
    await waitFor(() => {
      expect(port.listApiKeys).toHaveBeenCalledTimes(2);
    });
  });

  it("surfaces the typed revoke failure as the action banner (dialog closes)", async () => {
    const port = fakePort({
      listApiKeys: vi.fn().mockResolvedValue({ items: [apiKey()], nextCursor: null }),
      revokeApiKey: vi.fn().mockRejectedValue(
        new ApiError({
          code: "INTERNAL_ERROR",
          message: "Something went wrong on our side.",
          status: 500,
        }),
      ),
    });
    const user = userEvent.setup();
    renderView(port);
    await screen.findAllByTestId("api-key-row");

    await user.click(screen.getByTestId("api-key-revoke"));
    await user.type(screen.getByTestId("confirm-input"), "CI renders");
    await user.click(screen.getByTestId("confirm-confirm"));

    expect(await screen.findByTestId("api-keys-action-error")).toHaveTextContent(
      "Something went wrong on our side.",
    );
  });
});
