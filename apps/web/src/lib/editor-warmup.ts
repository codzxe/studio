/**
 * `warmEditorWasm` — start the editor engine's download + compile the moment
 * the editor route mounts (the capability gate's "supported" verdict), so the
 * 49 MB module streams and compiles IN PARALLEL with the iframe's own HTML/JS
 * load instead of waiting for it. The dist's bootstrap
 * (`apps/web/public/editor/index.html`) adopts the compiled module through the
 * same-origin parent's `window.__studioEditorWasm` promise; if the warm-up
 * fails for any reason the iframe falls back to its own fetch, so this is a
 * pure accelerator, never a dependency.
 *
 * Progress is observable through `editorWarmupSnapshot` (the boot overlay polls
 * it at the same cadence as the dist's `effectcraftLoad`): `downloading` while
 * the byte counter runs, `compiling` once the body is drained (the streaming
 * compile overlaps both), `done`/`failed` at the end. Repeat visits are served
 * by the dist's service worker cache — the warm-up then resolves almost
 * instantly and the phases flash by.
 */

export type EditorWarmupPhase = "idle" | "downloading" | "compiling" | "done" | "failed";

export interface EditorWarmupSnapshot {
  readonly phase: EditorWarmupPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

/** The dist's index.html adopts this exact global (same-origin parent access). */
const WARMUP_WINDOW_KEY = "__studioEditorWasm";
/** The editor engine module served by the frozen dist (`/editor/`). */
const EDITOR_WASM_URL = "/editor/effectcraft_web_bg.wasm";

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

/** Tests only: reset the one-shot guard, the snapshot and the window global. */
export function __resetEditorWarmupForTests(): void {
  started = false;
  state = IDLE;
  if (typeof window !== "undefined") {
    (window as WarmupWindow)[WARMUP_WINDOW_KEY] = undefined;
  }
}
