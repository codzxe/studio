/**
 * editor-warmup tests — the one-shot engine download + compile state machine
 * that lets the editor's 49 MB module stream in parallel with the iframe's
 * own load. No network: `fetch` and `compile` are injected; the global
 * `Response` is stubbed only where the streaming (tee) path needs the
 * constructor (the compile mock receives the wrapper, never real bytes).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetEditorWarmupForTests, editorWarmupSnapshot, warmEditorWasm } from "./editor-warmup";

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
