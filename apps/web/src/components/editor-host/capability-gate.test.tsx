/**
 * EditorCapabilityGate tests (W2-09, §8.7/§8.11/§13) — the gate arms.
 * "Has WebGPU" means an adapter actually ANSWERS `requestAdapter` — a browser
 * with hardware acceleration off still exposes `navigator.gpu` and refuses
 * every adapter request, and the gate must NOT let the editor boot into
 * "failed to create wgpu surface" on such a machine:
 *
 *   probe → true  → children mount, engine warm-up starts exactly once
 *   probe → false → the §8.7 full-page UnsupportedGpuState
 *                   (hardware-acceleration hint + static-preview offer),
 *                   children never mount
 *
 * The probe itself (adapter arms, WebGL2 floor, the high-performance adapter
 * request, the session-cached verdict) lives in `@/lib/editor-warmup` and is
 * tested in its own module tests — here it is a CONTROLLED MOCK (the gate
 * only consumes the verdict), same pattern as `warmEditorWasm`:
 * - @/lib/editor-warmup — mocked: the gate only triggers the warm-up; its own
 *   module tests own the download/compile state machine and the probe.
 * - window.matchMedia — the vitest-setup shim (matches:false) is plain
 *   WRITABLE, so the <1024px arm swaps the value and restores it after.
 *
 * The probe is async, so every arm awaits the verdict (findByTestId) instead
 * of asserting the first painted frame.
 */

import { probeEditorGpu, warmEditorWasm } from "@/lib/editor-warmup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorCapabilityGate } from "./capability-gate";

vi.mock("@/lib/editor-warmup", () => ({
  probeEditorGpu: vi.fn(),
  warmEditorWasm: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(warmEditorWasm).mockClear();
  vi.mocked(probeEditorGpu).mockReset();
});

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

type MatchMediaStub = (query: string) => MediaQueryList;

/** Swap window.matchMedia (the setup shim is writable) and restore after. */
function stubMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia as MatchMediaStub;
  const fake = ((query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as MatchMediaStub;
  window.matchMedia = fake as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original as unknown as typeof window.matchMedia;
  };
}

/** Control the gate's (mocked) probe verdict. */
function stubProbe(supported: boolean): void {
  vi.mocked(probeEditorGpu).mockResolvedValue(supported);
}

/** The gate's children — presence is the whole contract in supported arms. */
function Children() {
  return <div data-testid="gate-child">editor host</div>;
}

function renderGate(slug = "launch-film"): void {
  render(
    <EditorCapabilityGate slug={slug}>
      <Children />
    </EditorCapabilityGate>,
  );
}

// ---------------------------------------------------------------------------
// Gate arms (§8.7): a supported verdict mounts the editor children and starts
// the warm-up exactly once; an unsupported verdict shows the §8.11 state
// ---------------------------------------------------------------------------

describe("EditorCapabilityGate — gate arms", () => {
  it("a supported verdict: mounts the editor children and starts the engine warm-up", async () => {
    stubProbe(true);
    renderGate();

    expect(await screen.findByTestId("gate-child")).toBeInTheDocument();
    expect(screen.queryByTestId("unsupported-gpu-state")).not.toBeInTheDocument();
    expect(warmEditorWasm).toHaveBeenCalledTimes(1);
  });

  it("an unsupported verdict (hardware acceleration off): the §8.11 state, children never mount, no warm-up", async () => {
    stubProbe(false);
    renderGate("launch-film");

    // The children (the wasm editor host) never boot on an unsupported box.
    expect(await screen.findByTestId("unsupported-gpu-state")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("editor-capability-gate")).toHaveAttribute(
        "data-gate-state",
        "unsupported",
      );
    });
    expect(screen.queryByTestId("gate-child")).not.toBeInTheDocument();
    expect(warmEditorWasm).not.toHaveBeenCalled();

    // §8.11 copy: explain + supported browsers + the rendered-preview offer +
    // the fixable cause (hardware acceleration off in the browser).
    const state = screen.getByTestId("unsupported-gpu-state");
    const supportedBrowsers = within(state).getByRole("link", { name: "Supported browsers" });
    expect(supportedBrowsers).toHaveAttribute("href", "https://caniuse.com/webgpu");
    expect(state).toHaveTextContent(/hardware\s+acceleration/i);

    // The static-preview offer links to THIS project's version history.
    const preview = screen.getByTestId("editor-gate-preview-link");
    expect(preview).toHaveAttribute("href", "/w/launch-film/history");
    expect(preview).toHaveTextContent("Open version history");
  });
});

// ---------------------------------------------------------------------------
// §13 — the <1024px dismissible "best on desktop" note (editor stays usable)
// ---------------------------------------------------------------------------

describe("EditorCapabilityGate — best-on-desktop note", () => {
  it("shows the dismissible note below 1024px while the editor stays mounted", async () => {
    stubProbe(true);
    const restoreMatchMedia = stubMatchMedia(true);
    try {
      renderGate();

      // §13: "show a note but keep it usable" — children + note together.
      expect(await screen.findByTestId("gate-child")).toBeInTheDocument();
      const note = screen.getByTestId("editor-best-on-desktop-note");
      expect(note).toHaveTextContent(/best on a desktop/i);

      // Dismissal is a labelled icon-only button (§10) and it sticks.
      fireEvent.click(screen.getByTestId("editor-best-on-desktop-dismiss"));
      expect(screen.queryByTestId("editor-best-on-desktop-note")).not.toBeInTheDocument();
      expect(screen.getByTestId("gate-child")).toBeInTheDocument();
    } finally {
      restoreMatchMedia();
    }
  });

  it("no note at ≥1024px", async () => {
    stubProbe(true);
    const restoreMatchMedia = stubMatchMedia(false);
    try {
      renderGate();
      expect(await screen.findByTestId("gate-child")).toBeInTheDocument();
      expect(screen.queryByTestId("editor-best-on-desktop-note")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia();
    }
  });

  it("no note in the unsupported arm — the §8.11 state replaces the editor page", async () => {
    stubProbe(false);
    const restoreMatchMedia = stubMatchMedia(true);
    try {
      renderGate();
      expect(await screen.findByTestId("unsupported-gpu-state")).toBeInTheDocument();
      expect(screen.queryByTestId("gate-child")).not.toBeInTheDocument();
      expect(screen.queryByTestId("editor-best-on-desktop-note")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia();
    }
  });
});
