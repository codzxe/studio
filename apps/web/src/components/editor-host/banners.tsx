"use client";

import type { MissingAsset } from "@/lib/editor-session";
import { useOnlineStatus } from "@/lib/use-online-status";
import { Badge, Button, Spinner } from "@studio/ui";
import { AlertTriangle, CircleAlert, TriangleAlert, WifiOff } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * The editor-host banners (M3.5/M3.7). Every banner sits OVER the editor
 * iframe (ECUX §1: additive chrome only — nothing is injected into the
 * editor), uses design-system tokens only, and pairs state with a label
 * (never colour alone, UI_DESIGN_SYSTEM §3.1).
 */

/** Shared floating-panel chrome for a banner/chip. */
function panel(className: string, children: ReactNode, testId?: string): ReactNode {
  return (
    <div
      data-testid={testId}
      className={`pointer-events-auto flex items-center gap-2 rounded-sm border border-border bg-panel/95 px-3 py-2 text-body-s text-primary shadow-pop ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Boot (M3.7) — loading screen + wasm failure with the dist's error + Retry
// ---------------------------------------------------------------------------

export function BootOverlay({ projectName }: { readonly projectName: string }) {
  return (
    <output
      data-testid="editor-boot-loading"
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-app"
      aria-label={`Preparing the editor for ${projectName}`}
    >
      <Spinner size={24} label={`Preparing the editor for ${projectName}`} />
      <p className="text-body text-secondary">Preparing “{projectName}”…</p>
      <p className="text-caption text-muted">The editor loads once per session.</p>
    </output>
  );
}

export interface BootFailureBannerProps {
  /** The dist's own error string (helps support; copy stays non-technical). */
  readonly bootError?: string;
  readonly onRetry: () => void;
}

export function BootFailureBanner({ bootError, onRetry }: BootFailureBannerProps) {
  return (
    <div
      data-testid="editor-boot-failed"
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-app px-6"
      role="alert"
    >
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <CircleAlert size={24} strokeWidth={1.75} className="text-danger" aria-hidden="true" />
        <h1 className="text-title-l font-display text-primary">The editor could not start.</h1>
        <p className="text-body text-secondary">
          This browser or device could not run the editor just now. Retry, or refresh the page.
        </p>
        {typeof bootError === "string" && bootError.length > 0 ? (
          <p className="text-caption break-all text-muted" data-testid="editor-boot-error">
            {bootError}
          </p>
        ) : null}
      </div>
      <Button onClick={onRetry} data-testid="editor-boot-retry">
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project load failure (M3.3) — reload is the remedy
// ---------------------------------------------------------------------------

export function LoadFailedBanner({
  loadError,
  onReload,
}: {
  readonly loadError?: string;
  readonly onReload: () => void;
}) {
  return (
    <div
      data-testid="editor-load-failed"
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-app px-6"
      role="alert"
    >
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <CircleAlert size={24} strokeWidth={1.75} className="text-danger" aria-hidden="true" />
        <h1 className="text-title-l font-display text-primary">The project could not open.</h1>
        <p className="text-body text-secondary">
          {loadError === undefined
            ? "Reload the page to try again."
            : `Reload the page to try again. (${loadError})`}
        </p>
      </div>
      <Button onClick={onReload} data-testid="editor-load-retry">
        Reload
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflict (M3.4/§9.3) — BLOCKING: never silently overwrite
// ---------------------------------------------------------------------------

export function ConflictBanner({ onReload }: { readonly onReload: () => void }) {
  return (
    <div
      data-testid="editor-conflict-banner"
      className="absolute inset-x-0 top-12 z-40 mx-auto flex max-w-lg justify-center px-4"
      role="alertdialog"
      aria-label="This project changed on the server"
    >
      {panel(
        "flex-col items-start gap-3 border-danger/40 sm:flex-row sm:items-center",
        <>
          <div className="flex items-center gap-2">
            <TriangleAlert
              size={16}
              strokeWidth={1.75}
              className="text-danger"
              aria-hidden="true"
            />
            <span>This project changed on the server.</span>
          </div>
          <span className="text-body-s text-secondary">
            Your unsaved changes stay in this tab — loading the server version replaces them.
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={onReload}
            data-testid="editor-conflict-load-server"
          >
            Load server version
          </Button>
        </>,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only (§9.3) — non-blocking
// ---------------------------------------------------------------------------

export function ReadOnlyBanner({ holderName }: { readonly holderName?: string }) {
  const holder = holderName === undefined || holderName === "" ? "Someone else" : holderName;
  return (
    <output
      data-testid="editor-readonly-banner"
      className="absolute inset-x-0 top-12 z-20 mx-auto flex max-w-lg justify-center px-4"
    >
      {panel(
        "border-warning/40",
        <>
          <AlertTriangle size={16} strokeWidth={1.75} className="text-warning" aria-hidden="true" />
          <span>
            Opened read-only — <strong>{holder}</strong> is editing.
          </span>
          <Badge variant="warning">Read-only</Badge>
        </>,
      )}
    </output>
  );
}

/** The lease check failed — permissive fallback (still saving), soft warning. */
export function LeaseWarningBanner() {
  return (
    <output
      data-testid="editor-lease-warning"
      className="absolute inset-x-0 top-12 z-20 mx-auto flex max-w-lg justify-center px-4"
    >
      {panel(
        "border-warning/40",
        <>
          <AlertTriangle size={16} strokeWidth={1.75} className="text-warning" aria-hidden="true" />
          <span>
            Couldn’t confirm editing access — if someone else is editing, saves may not stick.
          </span>
        </>,
      )}
    </output>
  );
}

// ---------------------------------------------------------------------------
// Missing assets (M3.3) — non-blocking, expandable
// ---------------------------------------------------------------------------

export function MissingAssetsBanner({ missing }: { readonly missing: readonly MissingAsset[] }) {
  const [expanded, setExpanded] = useState(false);
  if (missing.length === 0) return null;
  const label =
    missing.length === 1
      ? "1 asset could not be loaded"
      : `${missing.length} assets could not be loaded`;
  return (
    <div className="absolute bottom-4 left-4 z-20" data-testid="editor-missing-assets-banner">
      <div className="pointer-events-auto flex flex-col gap-2">
        {expanded
          ? panel(
              "flex-col items-start gap-2",
              <>
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    size={16}
                    strokeWidth={1.75}
                    className="text-warning"
                    aria-hidden="true"
                  />
                  <span>{label}:</span>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setExpanded(false)}
                    data-testid="editor-missing-assets-collapse"
                  >
                    Hide
                  </Button>
                </div>
                <ul
                  className="flex max-w-md flex-col gap-1"
                  data-testid="editor-missing-assets-list"
                >
                  {missing.map((entry) => (
                    <li key={entry.asset.id} className="text-caption break-all text-muted">
                      {entry.asset.name} — {entry.reason}
                    </li>
                  ))}
                </ul>
              </>,
            )
          : panel(
              "",
              <>
                <AlertTriangle
                  size={16}
                  strokeWidth={1.75}
                  className="text-warning"
                  aria-hidden="true"
                />
                <span>{label}.</span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setExpanded(true)}
                  data-testid="editor-missing-assets-expand"
                >
                  Details
                </Button>
              </>,
            )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save feedback (D-6) — transient, non-alarming
// ---------------------------------------------------------------------------

export function SaveErrorBanner() {
  return (
    <output data-testid="editor-save-error" className="absolute right-4 bottom-4 z-20">
      {panel(
        "border-warning/40",
        <>
          <AlertTriangle size={16} strokeWidth={1.75} className="text-warning" aria-hidden="true" />
          <span>Couldn’t save just now — your changes are kept and retried automatically.</span>
        </>,
      )}
    </output>
  );
}

// ---------------------------------------------------------------------------
// Offline (§8.11, W5-06) — the editor route's offline state
// ---------------------------------------------------------------------------

/**
 * The editor route sits OUTSIDE the app shell, so the shell's OfflineBanner
 * never mounts here — this is the editor's own §8.11 arm: honest about what
 * is at risk (nothing — the last saved version is on the server, unsaved
 * changes are kept and retried by the autosave controller), what to do
 * (reconnect), and nothing else. Renders null while online, so the editor UI
 * is unchanged (criterion 4); bottom-center keeps it clear of the saved chip
 * (bottom-right), the missing-assets banner (bottom-left) and the top banner
 * stack (read-only / lease / conflict).
 */
export function EditorOfflineBanner() {
  const online = useOnlineStatus();

  if (online) {
    return null;
  }

  return (
    <output
      data-testid="editor-offline-banner"
      className="absolute inset-x-0 bottom-16 z-20 mx-auto flex max-w-md justify-center px-4"
    >
      {panel(
        "border-warning/40",
        <>
          <WifiOff size={16} strokeWidth={1.75} className="text-warning" aria-hidden="true" />
          <span>
            You're offline. Your last saved version is safe — unsaved changes are kept and retried
            automatically.
          </span>
        </>,
      )}
    </output>
  );
}

export function SavedChip({ label }: { readonly label: string }) {
  return (
    <output className="absolute right-4 bottom-4 z-20" data-testid="editor-saved-chip">
      {panel(
        "border-success/40",
        <>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          <span>
            Saved<span className="text-muted"> · {label}</span>
          </span>
        </>,
      )}
    </output>
  );
}
