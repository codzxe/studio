/**
 * SharePlayer tests (§M7 task 5): the honest v1 playback surface — exactly
 * what the public manifest serves. A video asset plays (native controls +
 * ±1s nudges + live playhead ticks for comment anchoring); an image asset
 * is a poster still; an empty manifest is an honest empty stage. Version
 * metadata renders from `currentVersion`; there is NO composed playback and
 * no fake frame-step timeline (documented gap, not a mock).
 */

import type { ShareManifest, ShareManifestAsset } from "@studio/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TICKS_PER_SECOND } from "./share-format";
import { SharePlayer, pickPreviewAsset, versionLabel } from "./share-player";

const VIDEO_ASSET: ShareManifestAsset = {
  name: "reveal.mp4",
  mime: "video/mp4",
  width: 1920,
  height: 1080,
  durationTicks: TICKS_PER_SECOND * 10,
  url: "https://cdn.example/signed/reveal.mp4",
};

const IMAGE_ASSET: ShareManifestAsset = {
  name: "poster.png",
  mime: "image/png",
  width: 1920,
  height: 1080,
  durationTicks: null,
  url: "https://cdn.example/signed/poster.png",
};

const LABELLED: ShareManifest = {
  currentVersion: {
    version: 14,
    label: "Client cut",
    sizeBytes: 123,
    createdAt: "2026-10-01T10:00:00Z",
    url: "https://cdn.example/signed/version",
  },
  assets: [],
  updatedAt: "2026-10-20T09:00:00Z",
};

const CURRENT = LABELLED.currentVersion as NonNullable<ShareManifest["currentVersion"]>;

describe("pickPreviewAsset", () => {
  it("prefers a video asset over an image (real playback beats a still)", () => {
    const manifest: ShareManifest = { ...LABELLED, assets: [IMAGE_ASSET, VIDEO_ASSET] };
    expect(pickPreviewAsset(manifest)).toEqual({
      name: "reveal.mp4",
      url: VIDEO_ASSET.url,
      kind: "video",
    });
  });

  it("falls back to the first image as the poster still", () => {
    const manifest: ShareManifest = { ...LABELLED, assets: [IMAGE_ASSET] };
    expect(pickPreviewAsset(manifest)).toEqual({
      name: "poster.png",
      url: IMAGE_ASSET.url,
      kind: "image",
    });
  });

  it("returns null when nothing is playable (no invented preview)", () => {
    const fontAsset: ShareManifestAsset = {
      name: "titles.woff2",
      mime: "font/woff2",
      width: null,
      height: null,
      durationTicks: null,
      url: "https://cdn.example/signed/font",
    };
    expect(pickPreviewAsset({ ...LABELLED, assets: [fontAsset] })).toBeNull();
  });
});

describe("versionLabel", () => {
  it("labels the version with its name", () => {
    expect(versionLabel(LABELLED)).toBe("v14 · Client cut");
  });

  it("renders an unlabeled version and the honest no-version state", () => {
    expect(versionLabel({ ...LABELLED, currentVersion: { ...CURRENT, label: null } })).toBe("v14");
    expect(versionLabel({ ...LABELLED, currentVersion: null })).toBe("No versions yet");
  });
});

describe("SharePlayer", () => {
  it("plays a video asset: native controls, honest source label, playhead ticks out", () => {
    const onPlayheadChange = vi.fn();
    render(
      <SharePlayer
        manifest={{ ...LABELLED, assets: [VIDEO_ASSET] }}
        onPlayheadChange={onPlayheadChange}
      />,
    );

    const video = screen.getByTestId("share-player-video") as HTMLVideoElement;
    expect(video).toHaveAttribute("src", VIDEO_ASSET.url);
    expect(video).toHaveAttribute("controls");
    expect(screen.queryByTestId("share-poster")).not.toBeInTheDocument();
    expect(screen.getByText(/Source preview — “reveal.mp4”/)).toBeInTheDocument();
    expect(screen.queryByTestId("share-player-empty")).not.toBeInTheDocument();

    video.currentTime = 3.25;
    fireEvent.timeUpdate(video);
    expect(onPlayheadChange).toHaveBeenLastCalledWith(Math.round(3.25 * TICKS_PER_SECOND));
  });

  it("nudges the playhead ±1s for precise anchoring", async () => {
    const user = userEvent.setup();
    const onPlayheadChange = vi.fn();
    render(
      <SharePlayer
        manifest={{ ...LABELLED, assets: [VIDEO_ASSET] }}
        onPlayheadChange={onPlayheadChange}
      />,
    );

    const video = screen.getByTestId("share-player-video") as HTMLVideoElement;
    video.currentTime = 5;
    fireEvent.timeUpdate(video);
    expect(screen.getByTestId("share-time-readout")).toHaveTextContent("5.0s");

    await user.click(screen.getByTestId("share-nudge-forward"));
    expect(screen.getByTestId("share-time-readout")).toHaveTextContent("6.0s");
    expect(video.currentTime).toBe(6);

    await user.click(screen.getByTestId("share-nudge-back"));
    expect(screen.getByTestId("share-time-readout")).toHaveTextContent("5.0s");
    expect(video.currentTime).toBe(5);
  });

  it("renders an image asset as the poster still", () => {
    render(<SharePlayer manifest={{ ...LABELLED, assets: [IMAGE_ASSET] }} />);

    const poster = screen.getByTestId("share-poster") as HTMLImageElement;
    expect(poster).toHaveAttribute("src", IMAGE_ASSET.url);
    expect(poster).toHaveAccessibleName("Still preview: poster.png");
    expect(screen.queryByTestId("share-player-video")).not.toBeInTheDocument();
    expect(screen.getByText(/Still preview — “poster.png”/)).toBeInTheDocument();
  });

  it("renders an honest empty stage when the manifest carries no preview", () => {
    render(<SharePlayer manifest={LABELLED} />);

    expect(screen.getByTestId("share-player-empty")).toHaveTextContent(
      "No preview media is shared on this link yet.",
    );
    expect(screen.queryByTestId("share-player-video")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-poster")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-version-label")).toHaveTextContent("v14 · Client cut");
  });
});
