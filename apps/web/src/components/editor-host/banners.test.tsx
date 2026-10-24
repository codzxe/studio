/**
 * banners tests (M3.7) — the boot UI's new logic:
 * - BootOverlay renders the engine warm-up's live progress (the parent page's
 *   parallel download + compile of the 49 MB module) and keeps the steady
 *   copy when there is none (idle/absent/failed — the iframe then fetches on
 *   its own and the progress would lie).
 * - BootFailureBanner names the fixable cause behind the most common boot
 *   failure: the browser refusing every GPU backend with hardware
 *   acceleration off (the machine can still have a fine discrete GPU).
 */

import type { EditorWarmupSnapshot } from "@/lib/editor-warmup";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BootFailureBanner, BootOverlay } from "./banners";

const MB = 1024 * 1024;

function snapshot(
  phase: EditorWarmupSnapshot["phase"],
  receivedBytes: number,
  totalBytes: number | null,
): EditorWarmupSnapshot {
  return { phase, receivedBytes, totalBytes };
}

afterEach(() => {
  cleanup();
});

describe("BootOverlay — engine warm-up progress", () => {
  it("names received and total megabytes while the engine downloads", () => {
    render(
      <BootOverlay projectName="Test Project" warmup={snapshot("downloading", 12 * MB, 49 * MB)} />,
    );
    expect(screen.getByTestId("editor-boot-progress")).toHaveTextContent(
      "Downloading the editor engine… 12 MB of 49 MB",
    );
  });

  it("names only the received size when the wire size is unknown (encoded body)", () => {
    render(
      <BootOverlay projectName="Test Project" warmup={snapshot("downloading", 9.5 * MB, null)} />,
    );
    expect(screen.getByTestId("editor-boot-progress")).toHaveTextContent(
      "Downloading the editor engine… 9.5 MB",
    );
  });

  it("says compiling once the body is drained, starting once the module is ready", () => {
    const { rerender } = render(
      <BootOverlay projectName="Test Project" warmup={snapshot("compiling", 49 * MB, 49 * MB)} />,
    );
    expect(screen.getByTestId("editor-boot-progress")).toHaveTextContent(
      "Compiling the editor engine…",
    );

    rerender(
      <BootOverlay projectName="Test Project" warmup={snapshot("done", 49 * MB, 49 * MB)} />,
    );
    expect(screen.getByTestId("editor-boot-progress")).toHaveTextContent(
      "Starting the editor engine…",
    );
  });

  it("keeps the steady copy with no warm-up (idle, failed or absent)", () => {
    for (const warmup of [
      undefined,
      snapshot("idle", 0, null),
      snapshot("failed", 3 * MB, null),
    ] as const) {
      const { unmount } = render(<BootOverlay projectName="Test Project" warmup={warmup} />);
      expect(screen.queryByTestId("editor-boot-progress")).not.toBeInTheDocument();
      expect(screen.getByText("The editor loads once per session.")).toBeInTheDocument();
      expect(screen.getByText(/Preparing “Test Project”/)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("BootFailureBanner — the GPU remedy hint", () => {
  it("names the hardware-acceleration remedy for the dist's wgpu surface failure", () => {
    render(
      <BootFailureBanner
        bootError={
          "editor failed to start: failed to create wgpu surface: Failed to create surface for any enabled backend: " +
          '{Gl: InstanceError { message: "canvas.getContext() returned null; webgl2 not available or canvas already in use" }}'
        }
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("editor-boot-error")).toBeInTheDocument();
    const hint = screen.getByTestId("editor-boot-gpu-hint");
    expect(hint).toHaveTextContent(/hardware acceleration/i);
    expect(hint).toHaveTextContent(/Use graphics acceleration/i);
  });

  it("keeps the plain copy for non-GPU boot errors", () => {
    render(
      <BootFailureBanner
        bootError="editor failed to start: TypeError: network error"
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("editor-boot-error")).toHaveTextContent("network error");
    expect(screen.queryByTestId("editor-boot-gpu-hint")).not.toBeInTheDocument();
  });
});
