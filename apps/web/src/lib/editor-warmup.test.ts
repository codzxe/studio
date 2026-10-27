/**
 * editor-warmup tests — the one-shot engine download + compile state machine
 * that lets the editor's 49 MB module stream in parallel with the iframe's
 * own load, the shared GPU capability probe (W3-D — moved here from the
 * capability gate so the gate and the shell's prewarm share one verdict),
 * the dist-file prefetch and the app-start prewarm. No network: `fetch` and
 * `compile` are injected; the global `Response` is stubbed only where the
 * streaming (tee) path needs the constructor (the compile mock receives the
 * wrapper, never real bytes).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetEditorWarmupForTests,
  editorWarmupSnapshot,
  prefetchEditorDist,
  prewarmEditor,
  probeEditorGpu,
  warmEditorWasm,
} from "./editor-warmup";

type WarmupWindow = typeof window & {
  __studioEditorWasm?: Promise<WebAssembly.Module>;
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A Headers stand-in: case-insensitive get, null for unknown names. */
function fakeHeaders(map: Record<string, string | null>) {
  return {
    get: (name: string) => map[name.toLowerCase()] ?? null,
  };
}

/** A Response stand-in — only the fields the warm-up reads. */
function fakeResponse(init: {
  readonly ok?: boolean;
  readonly status?: number;
  readonly headers?: Record<string, string | null>;
  readonly body?: unknown;
}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: fakeHeaders(init.headers ?? {}),
    body: init.body,
  } as unknown as Response;
}

/** A minimal async byte stream pair (the reader protocol the counter uses). */
function teeableBody(chunks: number[][]) {
  const branch = () => {
    let i = 0;
    return {
      getReader: () => ({
        read: async () => {
          const chunk = chunks[i++];
          return chunk === undefined
            ? { done: true as const, value: undefined }
            : { done: false as const, value: new Uint8Array(chunk) };
        },
      }),
    };
  };
  return {
    tee: () =>
      [branch(), branch()] as unknown as [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>],
  };
}

const wasmUrl = () => "/editor/effectcraft_web_bg.wasm";

afterEach(() => {
  __resetEditorWarmupForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // "Absent" for the probe is undefined (biome bans `delete`; a
  // defined-undefined property is the honest stub).
  (navigator as Navigator & { gpu?: unknown }).gpu = undefined;
});

describe("warmEditorWasm", () => {
  it("fetches the dist wasm once, compiles it and publishes the module on window for the dist to adopt", async () => {
    vi.stubGlobal(
      "Response",
      class {
        constructor(
          public body: unknown,
          public init?: unknown,
        ) {}
      },
    );
    const module = {} as WebAssembly.Module;
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        headers: { "content-length": "10" },
        body: teeableBody([
          [1, 2, 3],
          [4, 5],
        ]),
      }),
    );
    const compile = vi.fn(async () => module);

    warmEditorWasm(fetchImpl, compile);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(wasmUrl());
    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("done"));

    const snapshot = editorWarmupSnapshot();
    expect(snapshot.receivedBytes).toBe(5); // 3 + 2 decoded bytes
    expect(snapshot.totalBytes).toBe(10); // the wire size when not encoded
    // The dist's bootstrap adopts this exact global (same-origin parent).
    await expect((window as WarmupWindow).__studioEditorWasm).resolves.toBe(module);
  });

  it("is one-shot: a second call (React StrictMode double-mount) never fetches again", async () => {
    vi.stubGlobal("Response", class {});
    const module = {} as WebAssembly.Module;
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ headers: { "content-length": "2" }, body: teeableBody([[1, 2]]) }),
    );
    warmEditorWasm(fetchImpl, async () => module);
    warmEditorWasm(fetchImpl, async () => module);

    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("done"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("counts bytes while the compile is still running, then flips to compiling", async () => {
    vi.stubGlobal("Response", class {});
    const gate = deferred<WebAssembly.Module>();
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ headers: { "content-length": "100" }, body: teeableBody([[1], [2], [3]]) }),
    );

    warmEditorWasm(fetchImpl, () => gate.promise);

    // The body drains while the compiler is still pending (the compiling flip
    // is the settled signal; the byte count lands with it).
    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("compiling"));
    expect(editorWarmupSnapshot().receivedBytes).toBe(3);

    gate.resolve({} as WebAssembly.Module);
    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("done"));
  });

  it("shows no total when the body arrives content-encoded (the wire size would lie)", async () => {
    vi.stubGlobal("Response", class {});
    const gate = deferred<WebAssembly.Module>();
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        headers: { "content-encoding": "br", "content-length": "10" },
        body: teeableBody([[1, 2, 3]]),
      }),
    );

    warmEditorWasm(fetchImpl, () => gate.promise);

    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("compiling"));
    expect(editorWarmupSnapshot().totalBytes).toBeNull();
    gate.resolve({} as WebAssembly.Module);
  });

  it("a non-ok HTTP status records failed and rejects the published promise", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 404 }));

    warmEditorWasm(fetchImpl, async () => ({}) as WebAssembly.Module);

    await expect((window as WarmupWindow).__studioEditorWasm).rejects.toThrow(/HTTP 404/);
    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("failed"));
  });

  it("a rejected compile records failed (the dist falls back to its own fetch)", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ headers: { "content-length": "2" }, body: teeableBody([[1, 2]]) }),
    );

    warmEditorWasm(fetchImpl, async () => {
      throw new Error("compile failed");
    });

    await expect((window as WarmupWindow).__studioEditorWasm).rejects.toThrow(/compile failed/);
    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("failed"));
  });

  it("a response without a streaming body compiles the response itself (no tee path)", async () => {
    const response = fakeResponse({ headers: { "content-length": "4" } });
    const fetchImpl = vi.fn(async () => response);
    const compile = vi.fn(async () => ({}) as WebAssembly.Module);

    warmEditorWasm(fetchImpl, compile);

    await vi.waitFor(() => expect(editorWarmupSnapshot().phase).toBe("done"));
    expect(compile).toHaveBeenCalledWith(response);
    expect(editorWarmupSnapshot().receivedBytes).toBe(0); // nothing to count
  });
});

// ---------------------------------------------------------------------------
// The shared GPU probe (W3-D) — the arms the capability gate used to own,
// plus the session-cache contract (one adapter request per page session).
// jsdom has neither WebGPU nor WebGL2, so every arm stubs the globals.
// ---------------------------------------------------------------------------

/** A requestAdapter stub the probe can call (records its options). */
function adapterStub(result: "adapter" | "null" | "throw") {
  return vi.fn(async (_options?: unknown) => {
    if (result === "adapter") return { adapter: true };
    if (result === "null") return null;
    throw new Error("WebGPU is unavailable (hardware acceleration off)");
  });
}

/** Define (or clear) navigator.gpu with a given requestAdapter behaviour. */
function stubNavigatorGpu(requestAdapter?: ReturnType<typeof adapterStub>): void {
  const nav = navigator as Navigator & { gpu?: unknown };
  Object.defineProperty(nav, "gpu", {
    value: requestAdapter === undefined ? undefined : { requestAdapter },
    configurable: true,
    writable: true,
  });
}

describe("probeEditorGpu", () => {
  it("a WebGPU adapter answers: true, and the request asks for the high-performance GPU", async () => {
    const requestAdapter = adapterStub("adapter");
    stubNavigatorGpu(requestAdapter);

    await expect(probeEditorGpu()).resolves.toBe(true);
    // The dist's own boot pre-flight asks the same: the high-performance GPU,
    // not the browser's default (power-saving) adapter.
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
  });

  it("navigator.gpu exists but every adapter request is refused with no WebGL2: false", async () => {
    stubNavigatorGpu(adapterStub("null"));
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null as WebGL2RenderingContext | null);

    await expect(probeEditorGpu()).resolves.toBe(false);
    expect(getContext).toHaveBeenCalledWith("webgl2");
  });

  it("a throwing adapter request (broken WebGPU) falls through to the WebGL2 floor: true", async () => {
    stubNavigatorGpu(adapterStub("throw"));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as WebGL2RenderingContext | null,
    );

    await expect(probeEditorGpu()).resolves.toBe(true);
  });

  it("no navigator.gpu at all (WebGL2-only browser): the floor alone decides", async () => {
    stubNavigatorGpu(undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as WebGL2RenderingContext | null,
    );

    await expect(probeEditorGpu()).resolves.toBe(true);
  });

  it("caches the verdict: a second call never issues another adapter request", async () => {
    const requestAdapter = adapterStub("adapter");
    stubNavigatorGpu(requestAdapter);

    await expect(probeEditorGpu()).resolves.toBe(true);
    await expect(probeEditorGpu()).resolves.toBe(true);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The dist prefetch (W3-D) — the small files the iframe fetches on every
// boot, fetched once into the HTTP cache. Bodies are drained (a dropped body
// can evict the cache entry); failures are silent.
// ---------------------------------------------------------------------------

describe("prefetchEditorDist", () => {
  it("fetches every dist boot file once, with the iframe's exact document URL (query included)", async () => {
    const fetchImpl = vi.fn(
      async (_url: string) =>
        ({
          arrayBuffer: async () => new ArrayBuffer(1),
        }) as unknown as Response,
    );

    prefetchEditorDist(fetchImpl);
    prefetchEditorDist(fetchImpl); // one-shot (StrictMode double-mount safe)

    // Five fixed files + the sw.js manifest probe, each fetched EXACTLY once —
    // the second call is a no-op (the content-hashed snippet is derived from
    // the manifest separately, below; this stub's manifest answers not-ok).
    const urls = fetchImpl.mock.calls.map(([url]) => url);
    expect(urls).toHaveLength(6);
    expect(new Set(urls).size).toBe(6);
    // The HTTP cache key includes the query string — prefetching
    // /editor/index.html would be a cache MISS for the iframe's /editor/?empty.
    expect(urls).toContain("/editor/?empty");
    expect(urls).toContain("/editor/effectcraft_web.js");
    expect(urls).toContain("/editor/sw.js");
    // The 48 MB wasm is NEVER a plain prefetch — it goes through
    // warmEditorWasm (progress + the compiled module).
    expect(urls).not.toContain("/editor/effectcraft_web_bg.wasm");
  });

  it("derives the content-hashed snippet from the dist's sw.js manifest — a rebuilt hash still prefetches (w3-b06)", async () => {
    // The snippet dir hash is wasm-bindgen content-hash: it changes on every
    // dist rebuild. The dist's own service worker (generated by
    // `cargo xtask web` with the build's file list) names it — the prefetch
    // reads THAT, so a rebuilt hash (here: a DIFFERENT one than any old pin)
    // is discovered instead of silently 404ing.
    const rebuiltHash = "effectcraft-web-00000000deadbeef";
    const swManifest = `const VERSION = "d0049f28f42ad009";\nconst FILES = ["./", "./effectcraft_web.js", "./snippets/${rebuiltHash}/js/host.js", "./worker.js"];\n`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "/editor/sw.js") {
        return { ok: true, text: async () => swManifest } as unknown as Response;
      }
      return { arrayBuffer: async () => new ArrayBuffer(1) } as unknown as Response;
    });

    prefetchEditorDist(fetchImpl);

    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(`/editor/snippets/${rebuiltHash}/js/host.js`),
    );
    expect(fetchImpl).toHaveBeenCalledWith("/editor/sw.js");
    // The manifest response itself was consumed (text) — drained for the cache.
  });

  it("a missing/unparseable sw.js just skips the snippet — never throws, nothing pinned (w3-b06)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "/editor/sw.js") {
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }
      return { arrayBuffer: async () => new ArrayBuffer(1) } as unknown as Response;
    });

    expect(() => prefetchEditorDist(fetchImpl)).not.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledWith("/editor/sw.js"));
    // Only the fixed files + the manifest probe — no guessed snippet path.
    const urls = fetchImpl.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("/snippets/"))).toBe(false);
  });

  it("drains each response body (an unconsumed body can be dropped from the HTTP cache)", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    const fetchImpl = vi.fn(async () => ({ arrayBuffer }) as unknown as Response);

    prefetchEditorDist(fetchImpl);

    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalled());
  });

  it("a failed fetch is silent — the iframe fetches on its own anyway", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });

    expect(() => prefetchEditorDist(fetchImpl)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The app-start prewarm (W3-D) — one shot; a supported verdict starts the
// engine warm-up AND the dist prefetch; an unsupported verdict never fetches
// the 48 MB module (no iframe would ever use it).
// ---------------------------------------------------------------------------

describe("prewarmEditor", () => {
  it("a supported verdict starts the engine warm-up AND the dist prefetch", async () => {
    // Observe the DEFAULT-path actions through the global fetch seam: the
    // warm-up's wasm fetch plus every dist prefetch file, all fired by the
    // prewarm alone (the compile's fate is the warmup's own concern — here
    // only that the download STARTED matters).
    const globalFetch = vi.fn(async () => fakeResponse({ headers: { "content-length": "2" } }));
    vi.stubGlobal("fetch", globalFetch);
    const probe = vi.fn(async () => true);

    prewarmEditor(probe);

    await vi.waitFor(() =>
      expect(globalFetch).toHaveBeenCalledWith("/editor/effectcraft_web_bg.wasm"),
    );
    // The dist prefetch files were requested through the same seam.
    await vi.waitFor(() => expect(globalFetch).toHaveBeenCalledWith("/editor/?empty"));
    expect(globalFetch).toHaveBeenCalledWith("/editor/effectcraft_web.js");
    // The engine download was published for the dist to adopt.
    expect((window as WarmupWindow).__studioEditorWasm).toBeInstanceOf(Promise);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("an unsupported verdict warms nothing", async () => {
    const globalFetch = vi.fn(async () => fakeResponse({}));
    vi.stubGlobal("fetch", globalFetch);
    const probe = vi.fn(async () => false);

    prewarmEditor(probe);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    // No engine download was published for the dist to adopt; nothing fetched.
    expect((window as WarmupWindow).__studioEditorWasm).toBeUndefined();
    expect(editorWarmupSnapshot().phase).toBe("idle");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("is one-shot: a second call never probes again (shell remounts are no-ops)", async () => {
    const probe = vi.fn(async () => true);

    prewarmEditor(probe);
    prewarmEditor(probe);

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  });

  it("a rejected probe is absorbed as an unsupported verdict (never throws)", async () => {
    const probe = vi.fn(async () => {
      throw new Error("adapter exploded");
    });

    expect(() => prewarmEditor(probe)).not.toThrow();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect((window as WarmupWindow).__studioEditorWasm).toBeUndefined();
  });
});
