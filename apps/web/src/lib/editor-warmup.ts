/**
 * `warmEditorWasm` — start the editor engine's download + compile, so the
 * 49 MB module streams and compiles IN PARALLEL with whatever else is
 * happening instead of waiting for it. The dist's bootstrap
 * (`apps/web/public/editor/index.html`) adopts the compiled module through the
 * same-origin parent's `window.__studioEditorWasm` promise; if the warm-up
 * fails for any reason the iframe falls back to its own fetch, so this is a
 * pure accelerator, never a dependency.
 *
 * Progress is observable through `editorWarmupSnapshot` (the boot overlay polls
 * it at the same cadence as the dist's `studioEngineLoad`): `downloading` while
 * the byte counter runs, `compiling` once the body is drained (the streaming
 * compile overlaps both), `done`/`failed` at the end. Repeat visits are served
 * by the dist's service worker cache — the warm-up then resolves almost
 * instantly and the phases flash by.
 *
 * Two trigger points share this module (W3-D):
 *
 * - the editor route's capability gate — the "supported" verdict starts the
 *   download the moment the editor page mounts (the original trigger; covers
 *   direct links and reloads);
 * - `prewarmEditor` — the APP SHELL starts it the moment the user is anywhere
 *   in the authenticated app (dashboard, projects, billing, the project hub),
 *   so by the time they click into a project the engine is already downloaded
 *   AND compiled. This is the "load at start, open instantly" path: the 49 MB
 *   on the wire (prod: ~10 MB brotli via Caddy) is spent on browsing time the
 *   user was going to spend anyway, not on the editor-open critical path.
 */

import { activateGpuFallback, editorIframeSrc } from "./editor-gpu-fallback";

export type EditorWarmupPhase = "idle" | "downloading" | "compiling" | "done" | "failed";

export interface EditorWarmupSnapshot {
  readonly phase: EditorWarmupPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

/** The dist's index.html adopts this exact global (same-origin parent access). */
const WARMUP_WINDOW_KEY = "__studioEditorWasm";
/** The editor engine module served by the frozen dist (`/editor/`). */
const EDITOR_WASM_URL = "/editor/studio_web_bg.wasm";

const IDLE: EditorWarmupSnapshot = { phase: "idle", receivedBytes: 0, totalBytes: null };

type FetchLike = (input: string) => Promise<Response>;
type CompileLike = (response: Response) => Promise<WebAssembly.Module>;

type WarmupWindow = typeof window & {
  __studioEditorWasm?: Promise<WebAssembly.Module>;
};

let state: EditorWarmupSnapshot = IDLE;
let started = false;

/** The boot overlay's progress source (polled; never throws). */
export function editorWarmupSnapshot(): EditorWarmupSnapshot {
  return state;
}

/** The default compiler: streaming compile off the main thread. */
const defaultCompile: CompileLike = (response) => WebAssembly.compileStreaming(response);

/** Count the tee'd body so the snapshot can show received bytes. */
async function countBytes(branch: ReadableStream<Uint8Array>): Promise<void> {
  const reader = branch.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined && value.byteLength > 0) {
      state = {
        phase: "downloading",
        receivedBytes: state.receivedBytes + value.byteLength,
        totalBytes: state.totalBytes,
      };
    }
  }
  if (state.phase === "downloading") {
    // The body is drained; the streaming compile finishes from here.
    state = {
      phase: "compiling",
      receivedBytes: state.receivedBytes,
      totalBytes: state.totalBytes,
    };
  }
}

/**
 * Start (once per page session) the engine's fetch + compile and stash the
 * promise on `window.__studioEditorWasm` for the dist's bootstrap to adopt.
 * Idempotent: the second call is a no-op (React StrictMode double-mount safe).
 * A failure records `phase: "failed"` and leaves the iframe to fetch on its
 * own — the warm-up never blocks or breaks the editor boot.
 */
export function warmEditorWasm(
  fetchImpl: FetchLike = fetch,
  compile: CompileLike = defaultCompile,
): void {
  if (started || typeof window === "undefined") return;
  started = true;

  const promise = (async (): Promise<WebAssembly.Module> => {
    state = { phase: "downloading", receivedBytes: 0, totalBytes: null };
    const response = await fetchImpl(EDITOR_WASM_URL);
    if (!response.ok) {
      throw new Error(`editor warm-up: HTTP ${response.status} for ${EDITOR_WASM_URL}`);
    }
    // Content-Length is the wire size; when the body arrives encoded (gzip /
    // brotli) the decoded byte counter would outrun it — show no total then.
    const encoded = response.headers.get("content-encoding") !== null;
    const total = encoded ? null : Number(response.headers.get("content-length")) || null;
    state = { phase: "downloading", receivedBytes: 0, totalBytes: total };

    const body = response.body;
    let module: WebAssembly.Module;
    if (body && typeof body.tee === "function" && typeof Response === "function") {
      // One branch feeds the compiler, the other the byte counter.
      const [progressBranch, compileBranch] = body.tee();
      const counting = countBytes(progressBranch);
      module = await compile(new Response(compileBranch, { headers: response.headers }));
      await counting;
    } else {
      module = await compile(response);
    }
    state = { phase: "done", receivedBytes: state.receivedBytes, totalBytes: state.totalBytes };
    return module;
  })();

  // The dist adopts the REJECTED promise's absence (falls back to its own
  // fetch); record the failure here only for the boot overlay's copy.
  promise.catch(() => {
    state = { phase: "failed", receivedBytes: state.receivedBytes, totalBytes: state.totalBytes };
  });

  const w = window as WarmupWindow;
  w[WARMUP_WINDOW_KEY] = promise;
}

// ---------------------------------------------------------------------------
// W3-D — the app-start prewarm: the shared GPU probe + the dist prefetch +
// `prewarmEditor`, the one entry point the shell mounts once per session.
// ---------------------------------------------------------------------------

/** Structural stand-ins for the not-yet-typed `navigator.gpu` (the probe
 * only touches these three shapes — no @webgpu/types dependency). */
type GpuDeviceLike = {
  readonly destroy?: (() => void) | undefined;
};
type GpuAdapterLike = {
  readonly limits?: Readonly<Record<string, number>> | undefined;
  readonly requestDevice?:
    | ((descriptor?: { readonly requiredLimits?: Record<string, number> }) =>
        | Promise<GpuDeviceLike | null>
        | undefined)
    | undefined;
};
type GpuLike = {
  readonly requestAdapter?: (options?: {
    readonly powerPreference?: "low-power" | "high-performance" | undefined;
  }) => Promise<GpuAdapterLike | null> | undefined;
};

/**
 * Can a device actually be CREATED on this adapter? An adapter that merely
 * ANSWERS `requestAdapter` is not proof the engine can run: on the
 * stub-adapter class (driver blocklists, RDP/VM and software WebGPU stacks)
 * the adapter reports limits below the spec's guaranteed defaults — the
 * field report is `requestDevice` rejecting with "Limit
 * 'max_compute_workgroups_per_dimension' value 65535 is better than allowed
 * 0" — so the engine's device request (wgpu asks for the full spec-default
 * limit set explicitly) can never succeed and the boot dies after the whole
 * engine download. The probe reproduces the load-bearing member of that
 * exact request with a throwaway device: one create + destroy on healthy
 * machines, a decisive rejection on broken ones.
 */
async function webgpuDeviceUsable(adapter: GpuAdapterLike): Promise<boolean> {
  try {
    // The spec floor: an adapter reporting zero compute workgroups cannot
    // dispatch a single kernel — nothing above it matters.
    const workgroups = Number(adapter.limits?.maxComputeWorkgroupsPerDimension);
    if (!Number.isFinite(workgroups) || workgroups < 1) return false;
    if (typeof adapter.requestDevice !== "function") {
      // Browsers that ship requestAdapter always ship requestDevice; shape
      // alone is not evidence of a broken adapter — don't downgrade on it.
      return true;
    }
    const probe = await adapter.requestDevice({
      requiredLimits: { maxComputeWorkgroupsPerDimension: 65535 },
    });
    probe?.destroy?.();
    return probe != null;
  } catch {
    // Any rejection — including the "better than allowed" spec-floor class —
    // is exactly what the engine's own request would hit.
    return false;
  }
}

/**
 * Browser capability probe (§8.7, moved from the capability gate so the gate
 * and the prewarm share ONE verdict — and ONE adapter request — per page
 * session): a USABLE WebGPU device (the dist's preferred backend, asked for
 * the high-performance GPU — the same request its own boot pre-flight makes
 * — plus the device-creation probe above) or the WebGL2 floor. An adapter
 * that answers but cannot create a device arms the tab-scoped compatibility
 * breaker (the same marker the device-loss recovery arms) so the editor
 * iframe boots `?gpu=webgl2&nogpuworkers` instead of failing after the
 * engine download; the WebGL2 floor below still decides whether the machine
 * can run the editor at all.
 */
async function probeEditorGpuSupport(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { readonly gpu?: GpuLike | undefined };
  const gpu = nav.gpu;
  if (typeof gpu?.requestAdapter === "function") {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter != null) {
        if (await webgpuDeviceUsable(adapter)) return true;
        // The stub-adapter class: requestAdapter answers, requestDevice
        // never succeeds. WebGPU is unusable on this machine, not merely
        // absent — arm the breaker and let the WebGL2 floor decide below.
        activateGpuFallback();
      }
    } catch {
      // A broken WebGPU (blocklisted driver, crashed GPU process) falls
      // through to the WebGL2 floor.
    }
  }
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    // Some hardened browsers throw on context creation — treat as absent.
    return false;
  }
}

/** The module-cached verdict: one adapter request per page session. */
let gpuProbe: Promise<boolean> | null = null;

/**
 * The shared capability probe. The verdict is cached for the page session —
 * the shell's prewarm and the editor route's gate re-use the same answer
 * instead of racing two adapter requests — and never cached across SSR
 * (module state on the server is per-bundle, not per-user).
 */
export function probeEditorGpu(): Promise<boolean> {
  if (typeof navigator === "undefined") return Promise.resolve(false);
  if (gpuProbe === null) gpuProbe = probeEditorGpuSupport();
  return gpuProbe;
}

/**
 * The dist's small boot files, fetched into the HTTP cache so the iframe's
 * own loads are cache hits (prod cache policy — infra/caddy Caddyfile):
 * `index.html` is no-cache (a prefetch stores it; the iframe's later request
 * revalidates with a cheap 304), the glue JS is immutable for a year, the
 * helpers are shared-cache 1h. The 48 MB wasm is NOT here — it goes through
 * `warmEditorWasm` (progress + a compiled module), never a plain fetch.
 * The document entry is `editorIframeSrc()` — the iframe's EXACT document
 * URL (the HTTP cache key includes the query), which is the WebGL2
 * compatibility boot (`/editor/?empty&gpu=webgl2&nogpuworkers`) while the
 * GPU circuit breaker is armed (M3 tail 6, lib/editor-gpu-fallback.ts):
 * after a device-loss recovery reload, the prewarm prefetches the URL the
 * reopened iframe will actually load.
 */
const EDITOR_DIST_FILES: readonly string[] = [
  "/editor/studio_web.js",
  "/editor/worker.js",
  "/editor/audio-worklet.js",
  "/editor/favicon.svg",
];

/**
 * The wasm-bindgen snippet host.js lives under a CONTENT-HASHED directory
 * (`/editor/snippets/studio-web-<hash>/js/host.js`) — the hash changes
 * on every dist rebuild, so it must never be pinned in source (w3-b06: the
 * pinned hash silently 404'd after any rebuild). The dist's own service
 * worker (`sw.js`, generated by `cargo xtask web` with the build's full file
 * list) enumerates EVERY file it precaches, including the snippet — so the
 * path is DERIVED from it at runtime. A fetch/parse failure just skips the
 * snippet: the prefetch is a pure accelerator and the iframe fetches the
 * file on its own.
 */
const SNIPPET_HOST_JS_RE = /"\.\/(snippets\/[^"/]+\/js\/host\.js)"/;

/** Prefetch the snippet host.js at the path the dist's sw.js manifest names. */
async function prefetchSnippetHostJs(fetchImpl: FetchLike): Promise<void> {
  try {
    const manifest = await fetchImpl("/editor/sw.js");
    if (!manifest.ok) return;
    const text = await manifest.text();
    const match = SNIPPET_HOST_JS_RE.exec(text);
    if (match === null) return;
    const response = await fetchImpl(`/editor/${match[1]}`);
    if (typeof response.arrayBuffer === "function") {
      // Drain so the cache keeps the entry.
      void response.arrayBuffer().catch(() => {});
    }
  } catch {
    /* best-effort: the iframe fetches the snippet on its own */
  }
}

let distPrefetchStarted = false;

/**
 * One-shot prefetch of the dist's small files (bodies are DRAINED — an
 * unconsumed response body can be dropped from the HTTP cache). Failures are
 * silent: the iframe fetches on its own anyway, so this is a pure accelerator.
 * The content-hashed snippet is derived from the dist's sw.js manifest (see
 * {@link prefetchSnippetHostJs}) — never pinned here.
 */
export function prefetchEditorDist(fetchImpl: FetchLike = fetch): void {
  if (distPrefetchStarted || typeof window === "undefined") return;
  distPrefetchStarted = true;
  for (const url of [editorIframeSrc(), ...EDITOR_DIST_FILES]) {
    void fetchImpl(url)
      .then((response) => {
        if (typeof response.arrayBuffer === "function") {
          // Drain so the cache keeps the entry.
          void response.arrayBuffer().catch(() => {});
        }
      })
      .catch(() => {});
  }
  void prefetchSnippetHostJs(fetchImpl);
}

let prewarmStarted = false;

/**
 * W3-D — the app-start prewarm. One shot per page session: probe the GPU
 * once (shared with the editor route's gate) and, only on a machine that can
 * actually run the editor, start the engine's download + compile AND the dist
 * prefetch immediately. Unsupported machines never fetch the 48 MB module —
 * they can never mount the iframe that would use it.
 *
 * Mount via `components/editor-host/editor-prewarm.tsx` — the shell renders
 * it on every authenticated surface, so the engine loads while the user
 * browses, not when they click "Open editor".
 */
export function prewarmEditor(probe: () => Promise<boolean> = probeEditorGpu): void {
  if (prewarmStarted || typeof window === "undefined") return;
  prewarmStarted = true;
  void probe().then(
    (supported) => {
      if (!supported) return;
      warmEditorWasm();
      prefetchEditorDist();
    },
    () => {
      // A thrown probe answer is an unsupported verdict (probeEditorGpu
      // already catches internally; an injected test probe may not).
    },
  );
}

/** Tests only: reset the one-shot guard, the snapshot and the window global. */
export function __resetEditorWarmupForTests(): void {
  started = false;
  state = IDLE;
  gpuProbe = null;
  distPrefetchStarted = false;
  prewarmStarted = false;
  if (typeof window !== "undefined") {
    (window as WarmupWindow)[WARMUP_WINDOW_KEY] = undefined;
  }
}
