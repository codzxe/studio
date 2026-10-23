"use client";

/**
 * ModelsPreferencesView — the §8.9 "Models" + "Preferences" surfaces
 * (UI_DESIGN_SYSTEM §8.9; W2-07, manifest "SETTINGS PART 2"): the plan's
 * allowed models with a default-model radio, the D-22 auto-apply toggle, the
 * chat layout reset, and the dark-only honest note.
 *
 * Entitlement law (§8.2/§10.1, the model-picker's own law): the model list
 * comes EXCLUSIVELY from `GET /v1/models` (`client.models.list()` through the
 * port) — this view never hardcodes a catalog and never re-gates: off-plan
 * models are simply never on the wire.
 *
 * The default-model seam (D-10 naming, ECUX-literal):
 * - `studio.chat.model.v1` — VERIFIED 2026-10-23: NO pre-existing key exists
 *   anywhere in apps/web (the chat provider keeps the active model in React
 *   state only, lib/chat/provider.tsx — it defaults to the FIRST allowed
 *   model). This module defines the canonical key and WRITES it; the chat
 *   provider reading it is the chat owner's follow-up (worklog hand-forward).
 *   The copy stays honest: the default is "saved on this device" — it makes
 *   no claim the current chat build already honors it.
 * - `studio.chat.layout.v1` — the chat overlay's PERSISTED layout key
 *   (components/chat/layout.ts LAYOUT_STORAGE_KEY, ECUX §2.5/D-10). The reset
 *   button clears it — REUSED by import, never re-declared (no drift).
 *
 * Auto-apply (DECISIONS D-22, VERBATIM ruling): "Apply is always your
 * explicit click." The toggle is OPTIMISTIC — it flips immediately, calls
 * PATCH /v1/me/settings, and reverts with the typed §7.3 error on failure.
 * The setting is UI guidance only in v1; the plan card may pre-arm, but the
 * client never executes a batch from the event alone. Server policy gates
 * auto-apply to low-risk reversible plans inside the credit/step budget.
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY.
 */

import type { ModelsResponse } from "@studio/contracts";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "@studio/ui";
import { Check, CircleAlert, Eye, Sparkles, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";

import { LAYOUT_STORAGE_KEY } from "@/components/chat/layout";
import { modelDisplayName, modelTierLabel } from "@/components/chat/model-picker";

import {
  type SettingsActionError,
  type SettingsPort,
  createDefaultSettingsPort,
  toSettingsActionError,
} from "./settings-port";

// ---------------------------------------------------------------------------
// The default-model localStorage seam (D-10: ECUX-literal key)
// ---------------------------------------------------------------------------

/**
 * The default-model preference key. See the module doc: no pre-existing key
 * existed at W2-07 time (verified by grep across apps/web + packages); this
 * constant is the canonical seam, exported so the chat provider can adopt it
 * without re-declaring the literal.
 */
export const DEFAULT_MODEL_STORAGE_KEY = "studio.chat.model.v1";

/** Quota-safe read: absent, corrupt or blocked storage → null (never throws). */
export function readDefaultModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Quota-safe write (best-effort persistence — the saveLayout house pattern). */
export function writeDefaultModel(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

/** Quota-safe remove — the chat layout reset (ECUX §2.5 persistence). */
export function clearChatLayout(): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Model row display (reuses the picker's exported helpers — one display name
// per model id everywhere; the rate math mirrors the picker's formatRate)
// ---------------------------------------------------------------------------

type ModelSummary = ModelsResponse["models"][number];

/** Shortest exact decimal ("0.01", "0.4"); rounds away float noise. */
function formatCredits(value: number): string {
  const rounded = Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value;
  return String(rounded);
}

/** "≈0.01–0.03 cr /1k tokens"; flat "≈1 cr /1k tokens" when both rates match. */
function formatRate(entry: ModelSummary): string {
  const input = formatCredits(entry.creditsPer1kInput);
  const output = formatCredits(entry.creditsPer1kOutput);
  return input === output ? `≈${input} cr /1k tokens` : `≈${input}–${output} cr /1k tokens`;
}

const TIER_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  fast: Zap,
  smart: Sparkles,
  vision: Eye,
};

function TierGlyph({ tier, className }: { tier: string; className?: string }): ReactElement {
  const Glyph = TIER_GLYPHS[tier] ?? Sparkles;
  return <Glyph size={14} strokeWidth={1.75} aria-hidden="true" className={className} />;
}

// ---------------------------------------------------------------------------
// D-22 copy (VERBATIM ruling fragment — pinned by tests)
// ---------------------------------------------------------------------------

/** The D-22 ruling fragment, VERBATIM — tests pin this exact substring. */
export const D22_COPY = "Apply is always your explicit click";

const AUTO_APPLY_HELPER = "Pre-arms safe agent plans. Apply is always your explicit click.";

const AUTO_APPLY_POLICY =
  "Server-gated: only low-risk, reversible plans inside the credit and step budget pre-arm. Everything else waits for you.";

// ---------------------------------------------------------------------------
// Fetch states
// ---------------------------------------------------------------------------

type ModelsState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly models: readonly ModelSummary[] };

type SettingsState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "ready"; readonly autoApplyEnabled: boolean };

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface ModelsPreferencesViewProps {
  readonly workspaceId: string;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: SettingsPort;
}

export function ModelsPreferencesView({
  workspaceId,
  api,
}: ModelsPreferencesViewProps): ReactElement {
  const [port] = useState<SettingsPort>(() =>
    api === undefined ? createDefaultSettingsPort(workspaceId) : api,
  );

  // -- models (the §8.2 entitlement surface; the picker's own source) -------
  const [models, setModels] = useState<ModelsState>({ status: "loading" });

  const loadModels = useCallback(async (): Promise<void> => {
    setModels({ status: "loading" });
    try {
      const response = await port.listModels();
      setModels({ status: "ready", models: response.models });
    } catch (cause) {
      const { message } = toSettingsActionError(cause);
      setModels({ status: "error", message });
    }
  }, [port]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // -- user settings (GET /v1/me/settings — the D-22 auto-apply flag) -------
  const [settings, setSettings] = useState<SettingsState>({ status: "loading" });
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [updatingSettings, setUpdatingSettings] = useState(false);

  const loadSettings = useCallback(async (): Promise<void> => {
    setSettings({ status: "loading" });
    setSettingsError(null);
    try {
      const response = await port.getSettings();
      setSettings({ status: "ready", autoApplyEnabled: response.autoApplyEnabled });
    } catch (cause) {
      const { message } = toSettingsActionError(cause);
      setSettings({ status: "unavailable", message });
    }
  }, [port]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  /** Optimistic toggle: flip now, PATCH, adopt the server value or revert. */
  function onToggleAutoApply(): void {
    if (settings.status !== "ready" || updatingSettings) return;
    const next = !settings.autoApplyEnabled;
    const previous = settings.autoApplyEnabled;
    setSettings({ status: "ready", autoApplyEnabled: next });
    setSettingsError(null);
    setUpdatingSettings(true);
    void (async () => {
      try {
        const response = await port.updateSettings({ autoApplyEnabled: next });
        setSettings({ status: "ready", autoApplyEnabled: response.autoApplyEnabled });
      } catch (cause) {
        // Revert + surface the typed §7.3 failure (message/hint/request id).
        setSettings({ status: "ready", autoApplyEnabled: previous });
        const failure: SettingsActionError = toSettingsActionError(cause);
        setSettingsError(
          failure.hint === undefined ? failure.message : `${failure.message} ${failure.hint}`,
        );
      } finally {
        setUpdatingSettings(false);
      }
    })();
  }

  // -- default model (localStorage studio.chat.model.v1 — the D-10 seam) ----
  const [savedDefault, setSavedDefault] = useState<string | null>(null);

  useEffect(() => {
    setSavedDefault(readDefaultModel());
  }, []);

  const allowedModels = models.status === "ready" ? models.models : [];
  const savedOnPlan =
    savedDefault !== null && allowedModels.some((model) => model.id === savedDefault);
  // The provider's effective default today is the FIRST allowed model — the
  // radio preselects it until the user saves a pick (truthful current state).
  const selected =
    savedOnPlan === true
      ? savedDefault
      : savedDefault === null && allowedModels.length > 0
        ? (allowedModels[0]?.id ?? null)
        : null;

  function onPickModel(id: string): void {
    setSavedDefault(id);
    // Best-effort persistence (quota-safe): the in-memory pick stays truth.
    writeDefaultModel(id);
  }

  // -- chat layout reset (ECUX §2.5; clears studio.chat.layout.v1) ----------
  const [layoutReset, setLayoutReset] = useState(false);

  function onResetLayout(): void {
    clearChatLayout();
    setLayoutReset(true);
  }

  return (
    <section data-testid="models-preferences-view" aria-label="Models and preferences">
      {/* Models — the plan's allowed models + the default-model radio. */}
      <Card className="mb-4" data-testid="models-card">
        <CardHeader>
          <CardTitle>Models</CardTitle>
          <CardDescription>
            The models your plan allows, and the default you pick — saved on this device.
          </CardDescription>
        </CardHeader>

        {models.status === "loading" ? (
          <div className="flex flex-col gap-2 px-6 pb-6" data-testid="models-loading">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-5/6" />
            <Skeleton className="h-12 w-2/3" />
          </div>
        ) : models.status === "error" ? (
          <div
            role="alert"
            data-testid="models-error"
            className="mx-6 mb-6 flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
          >
            <CircleAlert
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-danger"
            />
            <p className="min-w-0 flex-1">{models.message}</p>
            <Button variant="secondary" size="sm" data-testid="models-retry" onClick={loadModels}>
              Try again
            </Button>
          </div>
        ) : models.models.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState data-testid="models-empty" title="No models available on this plan." />
          </div>
        ) : (
          <fieldset className="flex flex-col gap-1.5 px-6 pb-6" data-testid="models-radio-group">
            <legend className="text-label uppercase tracking-[0.06em] text-secondary">
              Default model
            </legend>
            {models.models.map((model) => {
              const active = model.id === selected;
              return (
                <label
                  key={model.id}
                  data-testid={`model-option-${model.id}`}
                  data-active={active || undefined}
                  className="flex cursor-pointer flex-col gap-0.5 rounded-sm px-2 py-1.5 transition-colors duration-120 hover:bg-input focus-within:outline-2 focus-within:outline-signal"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <input
                      type="radio"
                      name="default-model"
                      className="peer sr-only"
                      checked={active}
                      onChange={() => onPickModel(model.id)}
                      data-testid={`model-radio-${model.id}`}
                    />
                    <span
                      aria-hidden="true"
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border"
                    >
                      <span
                        className={
                          active
                            ? "h-2 w-2 rounded-pill bg-signal"
                            : "h-2 w-2 rounded-pill bg-transparent"
                        }
                      />
                    </span>
                    <TierGlyph tier={model.tier} className="shrink-0" />
                    <span className="truncate text-body-s font-medium text-primary">
                      {modelDisplayName(model.id)}
                    </span>
                    <Badge variant="neutral" className="shrink-0">
                      {modelTierLabel(model.tier)}
                    </Badge>
                    {active ? (
                      <Check
                        size={14}
                        strokeWidth={2}
                        aria-hidden="true"
                        className="ml-auto shrink-0 text-signal"
                        data-testid={`model-check-${model.id}`}
                      />
                    ) : null}
                  </span>
                  <span className="truncate pl-[26px] text-caption text-secondary">
                    {model.use}
                  </span>
                  <span className="pl-[26px] tabular text-caption text-muted">
                    {formatRate(model)}
                  </span>
                </label>
              );
            })}
            {savedDefault !== null && !savedOnPlan ? (
              <p data-testid="model-off-plan-note" className="mt-1 text-caption text-warning">
                Your saved default isn’t on this plan — pick a new one above.
              </p>
            ) : null}
          </fieldset>
        )}
      </Card>

      {/* Auto-apply — the D-22 toggle. */}
      <Card className="mb-4" data-testid="auto-apply-card">
        <CardHeader>
          <CardTitle>Auto-apply</CardTitle>
          <CardDescription>{AUTO_APPLY_HELPER}</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-2 px-6 pb-6">
          {settings.status === "loading" ? (
            <Skeleton className="h-6 w-64" data-testid="auto-apply-loading" />
          ) : settings.status === "unavailable" ? (
            <div
              role="alert"
              data-testid="auto-apply-unavailable"
              className="flex items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
            >
              <CircleAlert
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0 text-danger"
              />
              <p className="min-w-0 flex-1">{settings.message}</p>
              <Button
                variant="secondary"
                size="sm"
                data-testid="auto-apply-retry"
                onClick={loadSettings}
              >
                Try again
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoApplyEnabled}
                  aria-label="Auto-apply safe plans"
                  data-testid="auto-apply-toggle"
                  data-state={settings.autoApplyEnabled ? "on" : "off"}
                  disabled={updatingSettings}
                  onClick={onToggleAutoApply}
                  className={
                    settings.autoApplyEnabled
                      ? "relative h-6 w-11 shrink-0 cursor-pointer rounded-pill border border-transparent bg-signal transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-45"
                      : "relative h-6 w-11 shrink-0 cursor-pointer rounded-pill border border-border bg-input transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-45"
                  }
                >
                  <span
                    aria-hidden="true"
                    className={
                      settings.autoApplyEnabled
                        ? "absolute top-0.5 left-[22px] h-5 w-5 rounded-full bg-signal-ink transition-[left] duration-120"
                        : "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-secondary transition-[left] duration-120"
                    }
                  />
                </button>
                <span className="text-body-s text-secondary" data-testid="auto-apply-state">
                  {settings.autoApplyEnabled ? "Pre-arm safe plans" : "Always ask before applying"}
                </span>
              </div>
              <p className="text-caption text-muted">{AUTO_APPLY_POLICY}</p>
              {settingsError !== null ? (
                <p role="alert" data-testid="auto-apply-error" className="text-caption text-danger">
                  {settingsError}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Card>

      {/* Chat layout — clears studio.chat.layout.v1 (ECUX §2.5). */}
      <Card className="mb-4" data-testid="chat-layout-card">
        <CardHeader>
          <CardTitle>Chat layout</CardTitle>
          <CardDescription>
            Reset the chat panel to its default position and size — it applies the next time you
            open the editor.
          </CardDescription>
        </CardHeader>
        <div className="flex items-center gap-3 px-6 pb-6">
          <Button
            variant="secondary"
            size="sm"
            data-testid="chat-layout-reset"
            onClick={onResetLayout}
          >
            Reset chat layout
          </Button>
          {layoutReset ? (
            <p data-testid="chat-layout-reset-note" className="text-caption text-muted">
              Done — the editor opens with the default panel next time.
            </p>
          ) : null}
        </div>
      </Card>

      {/* Appearance — dark-only, honestly. */}
      <Card data-testid="appearance-card">
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription data-testid="dark-only-note">
            Studio is dark-only in v1 — the cinematic canvas is the product. A theme switch isn’t
            offered here because there is no light theme to switch to.
          </CardDescription>
        </CardHeader>
      </Card>
    </section>
  );
}
