/**
 * The GPU compatibility-mode circuit breaker (lib/editor-gpu-fallback.ts):
 * the marker arms on the first device loss in a tab, the iframe URL carries
 * `?gpu=webgl2&nogpuworkers` while armed, and every storage failure degrades
 * to the plain `/editor/?empty` behavior (privacy modes, no sessionStorage).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  GPU_FALLBACK_MARKER,
  activateGpuFallback,
  clearGpuFallback,
  editorIframeSrc,
  gpuFallbackActive,
} from "./editor-gpu-fallback";

/** A storage fake that can also be told to throw (privacy mode). */
function fakeStorage(): Storage & { broken: boolean } {
  const map = new Map<string, string>();
  const state = { broken: false };
  return {
    get broken() {
      return state.broken;
    },
    set broken(value: boolean) {
      state.broken = value;
    },
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => {
      if (state.broken) throw new Error("Access is denied for this document");
      return map.get(key) ?? null;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      if (state.broken) throw new Error("Access is denied for this document");
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (state.broken) throw new Error("Access is denied for this document");
      map.set(key, value);
    },
  };
}

describe("editor-gpu-fallback", () => {
  afterEach(() => {
    sessionStorage.removeItem(GPU_FALLBACK_MARKER);
  });

  it("is inactive by default and the iframe URL is the plain dist boot", () => {
    expect(gpuFallbackActive()).toBe(false);
    expect(editorIframeSrc()).toBe("/editor/?empty");
  });

  it("arming switches the iframe URL to the WebGL2 + CPU-worker boot", () => {
    activateGpuFallback();
    expect(gpuFallbackActive()).toBe(true);
    expect(sessionStorage.getItem(GPU_FALLBACK_MARKER)).toBe("1");
    // gpu=webgl2: the dist's no-adapter path (WebGL2 context first).
    // nogpuworkers: frame/job workers render on their CPU — their own
    // WebGPU devices would die the same way the presentation device did.
    expect(editorIframeSrc()).toBe("/editor/?empty&gpu=webgl2&nogpuworkers");
  });

  it("clearing restores the WebGPU boot (the banner's Try WebGPU again)", () => {
    activateGpuFallback();
    clearGpuFallback();
    expect(gpuFallbackActive()).toBe(false);
    expect(editorIframeSrc()).toBe("/editor/?empty");
  });

  it("degrades to the plain behavior when storage is unavailable or blocked", () => {
    // No storage at all (SSR/privacy mode): everything reads inactive, and
    // arming is a no-op that must never throw.
    expect(gpuFallbackActive(null)).toBe(false);
    expect(editorIframeSrc(null)).toBe("/editor/?empty");
    expect(() => activateGpuFallback(null)).not.toThrow();
    expect(() => clearGpuFallback(null)).not.toThrow();

    // A storage that throws on access: same degradation, no throw.
    const broken = fakeStorage();
    broken.broken = true;
    expect(() => gpuFallbackActive(broken)).not.toThrow();
    expect(gpuFallbackActive(broken)).toBe(false);
    expect(editorIframeSrc(broken)).toBe("/editor/?empty");
    expect(() => activateGpuFallback(broken)).not.toThrow();
  });

  it("an injected storage seam drives the verdict (the test seam contract)", () => {
    const storage = fakeStorage();
    storage.setItem(GPU_FALLBACK_MARKER, "1");
    expect(gpuFallbackActive(storage)).toBe(true);
    expect(editorIframeSrc(storage)).toBe("/editor/?empty&gpu=webgl2&nogpuworkers");
    clearGpuFallback(storage);
    expect(gpuFallbackActive(storage)).toBe(false);
    expect(editorIframeSrc(storage)).toBe("/editor/?empty");
  });
});
