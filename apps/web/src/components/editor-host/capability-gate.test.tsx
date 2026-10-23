/**
 * EditorCapabilityGate tests (W2-09, §8.7/§8.11/§13) — the four probe arms:
 * WebGPU (navigator.gpu), the WebGL2 floor (canvas context probe), neither
 * (full-page UnsupportedGpuState + the static-preview offer), and the
 * <1024px dismissible "best on desktop" note.
 *
 * Seams are browser-global, so each arm stubs what jsdom lacks:
 * - navigator.gpu — absent in jsdom; defined/deleted per arm.
 * - HTMLCanvasElement.prototype.getContext — jsdom's is "Not implemented"
 *   (returns null with a console error); spied per arm.
 * - window.matchMedia — the vitest-setup shim (matches:false) is plain
 *   WRITABLE, so the <1024px arm swaps the value and restores it after.
 *
 * Deterministic: no network, no timers; the probe is a synchronous effect.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorCapabilityGate } from "./capability-gate";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // "Absent" for the probe is undefined (biome bans `delete`; the gate tests
  // `navigator.gpu !== undefined`, so an undefined value is the honest stub).
  (navigator as Navigator & { gpu?: unknown }).gpu = undefined;
});

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

/**
 * Define (or clear) navigator.gpu for the WebGPU arm. `undefined` is the
 * "absent" stub — the gate probes `navigator.gpu !== undefined` (biome bans
 * the delete operator, and a defined-undefined property is indistinguishable
 * to that probe).
 */
function stubNavigatorGpu(present: boolean): void {
  const nav = navigator as Navigator & { gpu?: unknown };
  Object.defineProperty(nav, "gpu", {
    value: present ? {} : undefined,
    configurable: true,
    writable: true,
  });
}

/** Stub canvas.getContext("webgl2") — `null` = no WebGL2, truthy = present. */
function stubWebgl2(context: WebGL2RenderingContext | null) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as WebGL2RenderingContext | null);
}

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
// Probe arms (§8.7): navigator.gpu || WebGL2 → children; neither → §8.11 state
// ---------------------------------------------------------------------------

describe("EditorCapabilityGate — capability probe", () => {
  it("WebGPU (navigator.gpu): mounts the editor children, no gate state, no note", () => {
    stubNavigatorGpu(true);
    // The canvas probe must never even run when WebGPU answers.
    const getContext = stubWebgl2(null);
    renderGate();

    expect(screen.getByTestId("gate-child")).toBeInTheDocument();
    expect(screen.queryByTestId("unsupported-gpu-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-best-on-desktop-note")).not.toBeInTheDocument();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("WebGL2 floor (no navigator.gpu, canvas context present): mounts the children", () => {
    stubNavigatorGpu(false);
    stubWebgl2({} as WebGL2RenderingContext);
    renderGate();

    expect(screen.getByTestId("gate-child")).toBeInTheDocument();
    expect(screen.queryByTestId("unsupported-gpu-state")).not.toBeInTheDocument();
  });

  it("neither GPU: the full-page §8.11 state — supported browsers + static-preview offer, children never mount", () => {
    stubNavigatorGpu(false);
    stubWebgl2(null);
    renderGate("launch-film");

    // The children (the wasm editor host) never boot on an unsupported box.
    expect(screen.queryByTestId("gate-child")).not.toBeInTheDocument();

    const gate = screen.getByTestId("editor-capability-gate");
    expect(gate).toHaveAttribute("data-gate-state", "unsupported");

    // §8.11 copy: explain + supported browsers + the rendered-preview offer.
    const state = screen.getByTestId("unsupported-gpu-state");
    const supportedBrowsers = within(state).getByRole("link", { name: "Supported browsers" });
    expect(supportedBrowsers).toHaveAttribute("href", "https://caniuse.com/webgpu");

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
  it("shows the dismissible note below 1024px while the editor stays mounted", () => {
    stubNavigatorGpu(true);
    const restoreMatchMedia = stubMatchMedia(true);
    try {
      renderGate();

      // §13: "show a note but keep it usable" — children + note together.
      expect(screen.getByTestId("gate-child")).toBeInTheDocument();
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

  it("no note at ≥1024px", () => {
    stubNavigatorGpu(true);
    const restoreMatchMedia = stubMatchMedia(false);
    try {
      renderGate();
      expect(screen.getByTestId("gate-child")).toBeInTheDocument();
      expect(screen.queryByTestId("editor-best-on-desktop-note")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia();
    }
  });

  it("no note in the unsupported arm — the §8.11 state replaces the editor page", () => {
    stubNavigatorGpu(false);
    stubWebgl2(null);
    const restoreMatchMedia = stubMatchMedia(true);
    try {
      renderGate();
      expect(screen.queryByTestId("gate-child")).not.toBeInTheDocument();
      expect(screen.getByTestId("unsupported-gpu-state")).toBeInTheDocument();
      expect(screen.queryByTestId("editor-best-on-desktop-note")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia();
    }
  });
});
