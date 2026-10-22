"use client";

// The share player (BUILD_PLAN §M7 task 5): what an anonymous reviewer can
// actually watch. It renders EXACTLY what the public manifest serves — never
// an editor, never a frame renderer.
//
// PLAYBACK HONESTY (v1 gap, verified against services/gateway/src/routes/
// share.ts): the public surface serves NO per-frame render path. The editor
// bridge's renderFrame is editor-wasm-only (anonymous users never load the
// editor), and the render queue is the member-only M8 surface — so the
// composition itself cannot be played back on /s/:token in v1. What the
// manifest DOES carry:
//
//   - `assets[]` — the project's uploaded source media with signed URLs.
//     A video asset is genuinely playable in the browser (native controls,
//     ±1s nudges for precise anchoring); an image asset is a still preview.
//   - `currentVersion` — version number/label (metadata only; the file
//     object is the editor's project format — parsing it here would be
//     inventing a renderer, which the v1 pin forbids).
//
// So the player surfaces the first video asset if the project has one, else
// the first image as a poster still, else an honest empty stage — and the
// playhead feeds the comment composer's time anchor. The gap (no composed
// playback, no frame stepping) is documented in the worklog, not papered
// over with a fake timeline.

import type { ShareManifest } from "@studio/contracts";
import { Badge } from "@studio/ui";
import { useRef, useState } from "react";

import { formatSeconds, ticksFromSeconds } from "./share-format";

/** One manifest asset as the player sees it. */
export interface ShareAssetView {
  readonly name: string;
  readonly url: string;
  readonly kind: "video" | "image";
}

/** Pick the honest preview asset: first video beats first image (real playback). */
export function pickPreviewAsset(manifest: ShareManifest): ShareAssetView | null {
  for (const asset of manifest.assets) {
    if (asset.mime.startsWith("video/")) {
      return { name: asset.name, url: asset.url, kind: "video" };
    }
  }
  for (const asset of manifest.assets) {
    if (asset.mime.startsWith("image/")) {
      return { name: asset.name, url: asset.url, kind: "image" };
    }
  }
  return null;
}

export interface SharePlayerProps {
  readonly manifest: ShareManifest;
  /** Live playhead in engine ticks — the composer's time anchor source. */
  readonly onPlayheadChange?: (ticks: number | null) => void;
}

/** Version line: `v14 · Client cut` (or an honest "no versions yet"). */
export function versionLabel(manifest: ShareManifest): string {
  const version = manifest.currentVersion;
  if (version === null) return "No versions yet";
  return version.label !== null && version.label.length > 0
    ? `v${version.version} · ${version.label}`
    : `v${version.version}`;
}

export function SharePlayer({ manifest, onPlayheadChange }: SharePlayerProps) {
  const preview = pickPreviewAsset(manifest);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [seconds, setSeconds] = useState(0);

  function report(nextSeconds: number): void {
    setSeconds(nextSeconds);
    onPlayheadChange?.(ticksFromSeconds(nextSeconds));
  }

  /** ±1s nudge — honest seek controls for precise comment anchoring. */
  function nudge(delta: number): void {
    const video = videoRef.current;
    if (video === null) return;
    const duration = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
    const next = Math.min(Math.max(0, video.currentTime + delta), Math.max(0, duration));
    video.currentTime = next;
    report(next);
  }

  return (
    <section
      data-testid="share-player"
      aria-label="Project preview"
      className="flex flex-col gap-3 rounded-md border border-border bg-panel p-4"
    >
      <div className="flex items-center justify-between gap-4">
        <p className="text-label uppercase tracking-[0.06em] text-muted">Preview</p>
        <Badge variant="neutral" data-testid="share-version-label">
          {versionLabel(manifest)}
        </Badge>
      </div>

      {preview === null ? (
        <div
          data-testid="share-player-empty"
          className="flex min-h-64 items-center justify-center rounded-sm border border-dashed border-border bg-input px-6 text-center"
        >
          <p className="max-w-[48ch] text-body-s text-secondary">
            No preview media is shared on this link yet. You can still read and leave comments
            below.
          </p>
        </div>
      ) : null}

      {preview !== null && preview.kind === "video" ? (
        <div className="flex flex-col gap-3">
          {/* v1: the public manifest carries no caption/text-track asset, so
              there is nothing honest to reference here — flagged in the M7-I
              worklog (with M8's worker renders, caption tracks can ride the
              manifest and this suppression goes away). */}
          {/* biome-ignore lint/a11y/useMediaCaption: no caption source exists on the v1 public manifest */}
          <video
            ref={videoRef}
            data-testid="share-player-video"
            src={preview.url}
            controls
            preload="metadata"
            aria-label={`Source preview: ${preview.name}`}
            className="w-full rounded-sm border border-border bg-black"
            onTimeUpdate={(event) => report(event.currentTarget.currentTime)}
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="share-nudge-back"
                onClick={() => nudge(-1)}
                className="rounded-sm border border-border bg-input px-2.5 py-1 text-caption text-secondary transition-colors duration-120 hover:border-border-strong hover:text-primary"
              >
                −1s
              </button>
              <button
                type="button"
                data-testid="share-nudge-forward"
                onClick={() => nudge(1)}
                className="rounded-sm border border-border bg-input px-2.5 py-1 text-caption text-secondary transition-colors duration-120 hover:border-border-strong hover:text-primary"
              >
                +1s
              </button>
            </div>
            <p
              data-testid="share-time-readout"
              className="tabular font-mono text-caption text-muted"
            >
              {formatSeconds(seconds)}
            </p>
          </div>
        </div>
      ) : null}

      {preview !== null && preview.kind === "image" ? (
        <img
          data-testid="share-poster"
          src={preview.url}
          alt={`Still preview: ${preview.name}`}
          className="w-full rounded-sm border border-border bg-black object-contain"
        />
      ) : null}

      <p className="text-caption text-muted">
        {preview === null
          ? "Composed playback isn't available on review links yet."
          : preview.kind === "video"
            ? `Source preview — “${preview.name}”. Composed playback isn't available on review links yet.`
            : `Still preview — “${preview.name}”. Composed playback isn't available on review links yet.`}
      </p>
    </section>
  );
}
