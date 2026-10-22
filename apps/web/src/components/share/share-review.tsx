"use client";

// ShareReview — the /s/:token client root (BUILD_PLAN §M7 task 5).
//
// PUBLIC SURFACE, NO EDITOR: anonymous visitors get a review player and
// comments, never the editor wasm. The only auth-ish artifact on the page is
// the share password itself, and it lives in React state for the tab's
// session only — it is NOT persisted (unlike the guest name/email pre-fill,
// which is sessionStorage convenience per D-10), because a password is a
// credential and convenience must not outlive the tab.
//
// Phases:
//   gate     — `ShareInfo.hasPassword` and not yet unlocked: a clean password
//              form. Wrong/missing password = one inline error (the gateway
//              answers both with the same 401 — no oracle); 429 = "too many
//              attempts" per the 10/min per-IP window. Request access sits
//              beside it (someone locked out is exactly who requests access).
//   unlocked — the manifest + comments surface: the player (see
//              share-player.tsx for what v1 can honestly render), the
//              comment list + guest composer, and request access below.
//
// The RSC route hands over `token` + `ShareInfo` (fetched through the
// gateway seam, so unknown/expired/revoked links never reach this component
// — they 404 at the page). Everything here speaks the SharePort.

import { Brand } from "@studio/config";
import type { ShareInfo, ShareManifest } from "@studio/contracts";
import { Button, Input, Spinner } from "@studio/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ShareComments } from "./share-comments";
import { SharePlayer } from "./share-player";
import {
  type ShareFailure,
  type SharePort,
  createDefaultSharePort,
  describeShareFailure,
} from "./share-port";
import { ShareRequestAccess } from "./share-request-access";

export interface ShareReviewProps {
  /** Raw share token from the URL — the capability itself. */
  readonly token: string;
  /** Share metadata from `GET /v1/share/:token` (fetched by the RSC route). */
  readonly info: ShareInfo;
  /** Port seam override (tests inject fakes; default = the real api-client). */
  readonly port?: SharePort;
}

/** Expiry line: “Expires <date>” (ISO → local date; never a raw timestamp). */
export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `Expires ${date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
}

export function ShareReview({ token, info, port }: ShareReviewProps) {
  const client = useMemo<SharePort>(() => port ?? createDefaultSharePort(), [port]);

  const [password, setPassword] = useState("");
  const [gateFailure, setGateFailure] = useState<ShareFailure | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [manifest, setManifest] = useState<ShareManifest | null>(null);
  const [manifestFailure, setManifestFailure] = useState<ShareFailure | null>(null);
  const [playheadTicks, setPlayheadTicks] = useState<number | null>(null);
  const [unlocked, setUnlocked] = useState(!info.hasPassword);

  /** The gate submit: one call proves the password AND loads the player surface. */
  const unlock = useCallback(async (): Promise<void> => {
    if (password.trim().length === 0) {
      setGateFailure({
        kind: "wrong-password",
        message: "Enter the share password to unlock this link.",
      });
      return;
    }
    setUnlocking(true);
    setGateFailure(null);
    try {
      const next = await client.getManifest(token, { password });
      setManifest(next);
      setManifestFailure(null);
      setUnlocked(true);
    } catch (error) {
      setGateFailure(describeShareFailure(error));
    } finally {
      setUnlocking(false);
    }
  }, [client, token, password]);

  /** Open links: load the manifest once on mount (no gate round-trip). */
  useEffect(() => {
    if (info.hasPassword) return;
    let cancelled = false;
    client
      .getManifest(token)
      .then((next) => {
        if (cancelled) return;
        setManifest(next);
        setUnlocked(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setManifestFailure(describeShareFailure(error));
      });
    return () => {
      cancelled = true;
    };
  }, [client, token, info.hasPassword]);

  /** Retry after a mid-review failure (re-sends the password when present). */
  const retryManifest = useCallback(async (): Promise<void> => {
    setManifestFailure(null);
    try {
      const next =
        info.hasPassword && password.length > 0
          ? await client.getManifest(token, { password })
          : await client.getManifest(token);
      setManifest(next);
    } catch (error) {
      setManifestFailure(describeShareFailure(error));
    }
  }, [client, token, info.hasPassword, password]);

  const expiry = info.expiresAt !== null ? formatExpiry(info.expiresAt) : "";

  return (
    <div
      data-testid="share-page"
      className="mx-auto flex w-full max-w-(--width-marketing-max) flex-1 flex-col gap-8 px-5 py-12 md:px-8 lg:px-12 lg:py-16"
    >
      {/* ------------------------------------------------------------ header */}
      <header className="flex flex-col gap-3" data-testid="share-header">
        <p className="text-label uppercase tracking-[0.06em] text-muted">
          Shared review{expiry.length > 0 ? ` · ${expiry}` : ""}
        </p>
        <h1
          data-testid="share-project-name"
          className="font-display text-display-m text-balance text-primary"
        >
          {info.projectName}
        </h1>
        <p className="max-w-[68ch] text-body-s text-secondary">
          Read the preview, leave anchored comments and let the team know what to change.
        </p>
      </header>

      {/* -------------------------------------------------------------- gate */}
      {!unlocked ? (
        <div className="flex max-w-xl flex-col gap-6" data-testid="share-gate">
          <form
            data-testid="share-gate-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
            className="flex flex-col gap-4 rounded-md border border-border bg-panel p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 className="font-display text-title-l text-primary">
                This link is password protected.
              </h2>
              <p className="text-body-s text-secondary">
                Enter the share password the workspace gave you.
              </p>
            </div>
            <Input
              id="share-password"
              data-testid="share-gate-input"
              label="Share password"
              type="password"
              required
              autoComplete="off"
              value={password}
              error={gateFailure !== null ? gateFailure.message : null}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="primary"
              data-testid="share-gate-submit"
              loading={unlocking}
              className="self-start"
            >
              Unlock
            </Button>
          </form>
          <ShareRequestAccess port={client} token={token} variant="compact" />
        </div>
      ) : null}

      {/* ---------------------------------------------------------- unlocked */}
      {unlocked ? (
        <div className="flex flex-col gap-6" data-testid="share-surface">
          {manifest === null && manifestFailure === null ? (
            <div
              className="flex items-center gap-3 rounded-md border border-border bg-panel p-6"
              data-testid="share-loading"
            >
              <Spinner size={20} label="Loading the review surface" />
              <p className="text-body-s text-muted">Loading the review surface…</p>
            </div>
          ) : null}

          {manifestFailure !== null ? (
            <div
              className="flex flex-col gap-3 rounded-md border border-border bg-panel p-6"
              data-testid="share-unavailable"
            >
              <p role="alert" className="text-body-s text-danger">
                {manifestFailure.message}
              </p>
              <Button
                variant="secondary"
                size="sm"
                data-testid="share-retry"
                onClick={() => void retryManifest()}
                className="self-start"
              >
                Try again
              </Button>
              <p className="text-caption text-muted">
                The link may have expired or been revoked since it opened.
              </p>
            </div>
          ) : null}

          {manifest !== null ? (
            <>
              <SharePlayer manifest={manifest} onPlayheadChange={setPlayheadTicks} />
              <ShareComments
                port={client}
                token={token}
                password={info.hasPassword ? password : undefined}
                playheadTicks={playheadTicks}
                pinnedCompId={info.compId}
              />
            </>
          ) : null}

          <ShareRequestAccess port={client} token={token} variant="full" />
        </div>
      ) : null}

      {/* ---------------------------------------------------------- branding */}
      <footer className="mt-auto border-t border-border pt-6" data-testid="share-branding">
        <a
          href="/"
          className="text-body-s text-secondary transition-colors duration-120 hover:text-signal"
        >
          Made with {Brand.productName}
        </a>
      </footer>
    </div>
  );
}
