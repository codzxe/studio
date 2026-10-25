/**
 * The GPU compatibility-mode circuit breaker (M3 tail 6, 2026-10-25).
 *
 * The failure: on machines where Chrome's WebGPU stack dies at device
 * creation — the field report is `GPU device lost (Unknown): "A valid
 * external Instance reference no longer exists"` (a Dawn/WebGPU failure;
 * WebGL2 rides ANGLE/D3D11, a different driver path) — the device-loss
 * recovery (save → reload) looped forever: every reload booted the engine on
 * WebGPU again, the fresh device died the same way, and the editor never
 * opened. A reload cannot fix a persistently broken WebGPU.
 *
 * The breaker: the FIRST device loss in a tab session arms a sessionStorage
 * marker (same-origin iframe + parent share the tab's sessionStorage). While
 * armed, the editor iframe boots with `?gpu=webgl2&nogpuworkers` — the dist's
 * proven no-adapter path: its pre-flight takes the WebGL2 context first and
 * egui-wgpu falls back to its WebGL backend, and the frame/job workers
 * render on their CPU (their own WebGPU devices would die the same way).
 * WebGL2 is slower but runs everywhere; availability beats peak perf.
 *
 * The marker is per TAB (sessionStorage, not localStorage): a one-off GPU
 * process crash costs at most the tab's session on WebGL2, never the
 * machine's verdict. The editor route's banner offers "Try WebGPU again"
 * (clears the marker + reloads) after a driver update; a new tab starts
 * clean. Storage failures (privacy mode) degrade to the plain behavior.
 */

/** The sessionStorage key the Studio host and the dist's page both use. */
export const GPU_FALLBACK_MARKER = "studio:editor-gpu-fallback";

/**
 * The storage seam (tests inject a fake; production uses the tab's
 * sessionStorage — absent on the server and in some privacy modes).
 */
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): StorageLike | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    // Some privacy modes throw on the very access.
    return null;
  }
}

/** True when the tab is in compatibility mode (boots the editor on WebGL2). */
export function gpuFallbackActive(storage: StorageLike | null = tabStorage()): boolean {
  try {
    return storage?.getItem(GPU_FALLBACK_MARKER) === "1";
  } catch {
    return false;
  }
}

/** Arm the breaker — called at the top of the device-loss recovery, before
 * the save: whichever reload path ends up running (early success, clean
 * project, the overlay's Reload now) reopens on WebGL2. Never throws. */
export function activateGpuFallback(storage: StorageLike | null = tabStorage()): void {
  try {
    storage?.setItem(GPU_FALLBACK_MARKER, "1");
  } catch {
    // Storage blocked: the reload retries WebGPU (the old behavior).
  }
}

/** Disarm the breaker — "Try WebGPU again". Never throws. */
export function clearGpuFallback(storage: StorageLike | null = tabStorage()): void {
  try {
    storage?.removeItem(GPU_FALLBACK_MARKER);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The editor iframe's document URL. `/editor/?empty` normally; with the
 * breaker armed, `?gpu=webgl2&nogpuworkers` is appended so the dist boots
 * the engine on WebGL2 and its workers on the CPU. This is also the URL the
 * app-start prewarm prefetches (the HTTP cache key includes the query).
 * Read once per page load — the iframe must never see its `src` change.
 */
export function editorIframeSrc(storage: StorageLike | null = tabStorage()): string {
  return gpuFallbackActive(storage) ? "/editor/?empty&gpu=webgl2&nogpuworkers" : "/editor/?empty";
}
