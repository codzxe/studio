/**
 * EditorCapabilityGate tests (W2-09, §8.7/§8.11/§13) — the probe arms.
 * "Has WebGPU" means an adapter actually ANSWERS `requestAdapter` — a browser
 * with hardware acceleration off still exposes `navigator.gpu` and refuses
 * every adapter request, and the gate must NOT let the editor boot into
 * "failed to create wgpu surface" on such a machine:
 *
 *   adapter answers (asking for the high-performance GPU) → children
 *   adapter null/rejects + WebGL2 floor (canvas context probe) → children
 *   neither → the §8.7 full-page UnsupportedGpuState (hardware-acceleration
 *             hint + static-preview offer), children never mount
 *
 * Also pinned: a supported verdict starts the engine warm-up exactly once.
 *
 * Seams are browser-global, so each arm stubs what jsdom lacks:
 * - navigator.gpu — absent in jsdom; shaped per arm (requestAdapter answering,
 *   null, or throwing).
 * - HTMLCanvasElement.prototype.getContext — jsdom's is "Not implemented"
 *   (returns null with a console error); spied per arm.
 * - window.matchMedia — the vitest-setup shim (matches:false) is plain
 *   WRITABLE, so the <1024px arm swaps the value and restores it after.
 * - @/lib/editor-warmup — mocked: the gate only triggers it; its own module
 *   tests own the download/compile state machine.
 *
 * The probe is async (one adapter request), so every arm awaits the verdict
 * (findByTestId) instead of asserting the first painted frame.
 */

import { warmEditorWasm } from "@/lib/editor-warmup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorCapabilityGate } from "./capability-gate";

vi.mock("@/lib/editor-warmup", () => ({
  warmEditorWasm: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(warmEditorWasm).mockClear();
  // "Absent" for the probe is undefined (biome bans `delete`; a
  // defined-undefined property is the honest stub).
  (navigator as Navigator & { gpu?: unknown }).gpu = undefined;
});

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

/** A requestAdapter stub the probe can call (records its options). */
function adapterStub(result: "adapter" | "null" | "throw") {
  return vi.fn(async (_options?: unknown) => {
    if (result === "adapter") return { adapter: true };
    if (result === "null") return null;
    throw new Error("WebGPU is unavailable (hardware acceleration off)");
  });
}

/**
 * Define (or clear) navigator.gpu with a given requestAdapter behaviour.
 * `undefined` is the "absent" stub — the probe treats a gpu object without a
 * callable requestAdapter as absent too (partial implementations).
 */
function stubNavigatorGpu(requestAdapter?: ReturnType<typeof adapterStub>): void {
  const nav = navigator as Navigator & { gpu?: unknown };
  Object.defineProperty(nav, "gpu", {
    value: requestAdapter === undefined ? undefined : { requestAdapter },
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
// Probe arms (§8.7): a working adapter or the WebGL2 floor → children;
// neither → §8.11 state; a supported verdict warms the engine exactly once
// ---------------------------------------------------------------------------

describe("EditorCapabilityGate — capability probe", () => {
  it("a WebGPU adapter answers: mounts the editor children, the canvas probe never runs, the engine warm-up starts", async () => {
    const requestAdapter = adapterStub("adapter");
    stubNavigatorGpu(requestAdapter);
    // The canvas probe must never even run when an adapter answers.
    const getContext = stubWebgl2(null);
    renderGate();

    expect(await screen.findByTestId("gate-child")).toBeInTheDocument();
    expect(screen.queryByTestId("unsupported-gpu-state")).not.toBeInTheDocument();
    expect(getContext).not.toHaveBeenCalled();
    // The dist's own boot pre-flight asks the same: the high-performance GPU,
    // not the browser's default (power-saving) adapter.
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
    expect(warmEditorWasm).toHaveBeenCalledTimes(1);
  });

  it("navigator.gpu exists but every adapter request is refused (hardware acceleration off) with no WebGL2: the §8.11 state, children never mount, no warm-up", async () => {
    stubNavigatorGpu(adapterStub("null"));
    stubWebgl2(null);
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

  it("a throwing adapter request (broken WebGPU) falls through to the WebGL2 floor: mounts the children", async () => {
    stubNavigatorGpu(adapterStub("throw"));
    stubWebgl2({} as WebGL2RenderingContext);
    renderGate();

    expect(await screen.findByTestId("gate-child")).toBeInTheDocument();
    expect(screen.queryByTestId("unsupported-gpu-state")).not.toBeInTheDocument();
    expect(warmEditorWasm).toHaveBeenCalledTimes(1);
  });

  it("no navigator.gpu at all (WebGL2-only browser): the floor alone mounts the children", async () => {
    stubNavigatorGpu(undefined);
    stubWebgl2({} as WebGL2RenderingContext);
    renderGate();

    expect(await screen.findByTestId("gate-child")).toBeInTheDocument();
    expect(screen.queryByTestId("unsupported-gpu-state")).not.toBeInTheDocument();
    expect(warmEditorWasm).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §13 — the <1024px dismissible "best on desktop" note (editor stays usable)
// ---------------------------------------------------------------------------

describe("EditorCapabilityGate — best-on-desktop note", () => {
  it("shows the dismissible note below 1024px while the editor stays mounted", async () => {
    stubNavigatorGpu(undefined);
    stubWebgl2({} as WebGL2RenderingContext);
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
    stubNavigatorGpu(undefined);
    stubWebgl2({} as WebGL2RenderingContext);
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
    stubNavigatorGpu(adapterStub("null"));
    stubWebgl2(null);
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
