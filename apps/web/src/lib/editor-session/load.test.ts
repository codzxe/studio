import type { EditorBridge } from "@studio/editor-bridge";
import { type FakeEditor, attachFakeBridge, createFakeEditor } from "@studio/editor-bridge/fake";
import { describe, expect, it } from "vitest";

import { loadProjectSession } from "./load";
import { type FakeEditorSessionClient, createFakeEditorSessionClient } from "./testing";
import { type EditorSessionClient, EditorSessionError } from "./types";

/**
 * M3.3 load sequence against the deterministic fake editor (the real
 * `window.studioEngine` surface, incl. addFile/addAsset semantics) and a fake
 * `EditorSessionClient`. Real timers — the fake editor reads Blobs through
 * FileReader in jsdom, which fake timers cannot drive; the timeout test uses
 * a small real `assetTimeoutMs` instead.
 */

const LOGO_BYTES = new Uint8Array([1, 2, 3, 4]);
const FONT_BYTES = new Uint8Array([9, 8, 7, 6, 5]);

async function setup(
  clientOpts: Parameters<typeof createFakeEditorSessionClient>[0] = {},
): Promise<{ fake: FakeEditor; bridge: EditorBridge; client: FakeEditorSessionClient }> {
  const fake = createFakeEditor();
  const bridge = attachFakeBridge(fake);
  const assets =
    clientOpts.assets === undefined
      ? { ast_logo: LOGO_BYTES, ast_font: FONT_BYTES }
      : clientOpts.assets;
  const client = createFakeEditorSessionClient({ ...clientOpts, assets });
  return { fake, bridge, client };
}

describe("loadProjectSession", () => {
  it("registers assets under editor-assigned paths, opens the project and returns the outcome", async () => {
    const { fake, bridge, client } = await setup();
    const outcome = await loadProjectSession({
      bridge,
      client: client.client,
      projectId: "prj_test",
    });

    expect(client.calls.getManifest).toEqual(["prj_test"]);
    expect(outcome.openedPath).toBe("/test-project.ecproj");
    // the fake restores the state saved inside the .ecproj (comp 2 at 3.5 s)
    expect(outcome.activeComp).toBe(2);
    expect(fake.state.playhead).toBe(3.5);
    expect(outcome.missingAssets).toEqual([]);

    // §6.3: the editor-assigned path is authoritative, keyed by asset id
    expect(outcome.assetPaths).toEqual({
      ast_logo: "/ast_logo-logo.png",
      ast_font: "/ast_font-font.png",
    });
    const paths = fake.state.fileTable.map((entry) => entry.path);
    expect(paths).toContain("/ast_logo-logo.png");
    expect(paths).toContain("/ast_font-font.png");
    expect(paths).toContain("/test-project.ecproj");
    expect(Array.from(fake.readFile("/ast_logo-logo.png") ?? [])).toEqual(Array.from(LOGO_BYTES));
    expect(Array.from(fake.readFile("/ast_font-font.png") ?? [])).toEqual(Array.from(FONT_BYTES));
    // the project file itself was downloaded via the manifest URL
    expect(client.calls.downloadProjectFile).toHaveLength(1);
  });

  it("downloads assets through the manifest's signed URLs", async () => {
    const { bridge, client } = await setup();
    await loadProjectSession({ bridge, client: client.client, projectId: "prj_test" });
    expect(client.calls.downloadAsset).toHaveLength(2);
    for (const url of client.calls.downloadAsset) {
      expect(url).toContain("https://storage.test/prj_test/ast_");
    }
  });

  it("a missing asset never blocks the project from opening", async () => {
    const { bridge, client } = await setup({
      assets: { ast_logo: LOGO_BYTES, ast_font: new Error("HTTP 403: forbidden") },
    });
    const outcome = await loadProjectSession({
      bridge,
      client: client.client,
      projectId: "prj_test",
    });

    expect(outcome.openedPath).toBe("/test-project.ecproj");
    expect(outcome.activeComp).toBe(2);
    expect(outcome.missingAssets).toHaveLength(1);
    expect(outcome.missingAssets[0]?.asset.id).toBe("ast_font");
    expect(outcome.missingAssets[0]?.reason).toContain("HTTP 403");
    expect(outcome.assetPaths).toEqual({ ast_logo: "/ast_logo-logo.png" });
  });

  it("a hung asset download times out into a missing asset instead of wedging the load", async () => {
    const { bridge, client } = await setup({
      assets: { ast_logo: LOGO_BYTES, ast_font: "hang" },
    });
    const startedAt = Date.now();
    const outcome = await loadProjectSession({
      bridge,
      client: client.client,
      projectId: "prj_test",
      assetTimeoutMs: 40,
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outcome.activeComp).toBe(2);
    expect(outcome.missingAssets).toHaveLength(1);
    expect(outcome.missingAssets[0]?.asset.id).toBe("ast_font");
    expect(outcome.missingAssets[0]?.reason).toContain("timed out after 40 ms");
    expect(outcome.assetPaths).toEqual({ ast_logo: "/ast_logo-logo.png" });
  });

  it("bounds parallel asset downloads to the configured concurrency", async () => {
    const assets: Record<string, Uint8Array> = {
      ast_a: new Uint8Array([1]),
      ast_b: new Uint8Array([2]),
      ast_c: new Uint8Array([3]),
      ast_d: new Uint8Array([4]),
      ast_e: new Uint8Array([5]),
    };
    const { bridge, client } = await setup({ assets });
    let inFlight = 0;
    let maxInFlight = 0;
    const wrapped: EditorSessionClient = {
      ...client.client,
      downloadAsset: async (url: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return await client.client.downloadAsset(url);
        } finally {
          inFlight--;
        }
      },
    };
    const outcome = await loadProjectSession({
      bridge,
      client: wrapped,
      projectId: "prj_test",
      assetConcurrency: 2,
    });
    expect(client.calls.downloadAsset).toHaveLength(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(outcome.missingAssets).toEqual([]);
    expect(Object.keys(outcome.assetPaths)).toHaveLength(5);
  });

  it("opens with an empty manifest (no assets)", async () => {
    const { bridge, client } = await setup({ assets: {} });
    const outcome = await loadProjectSession({
      bridge,
      client: client.client,
      projectId: "prj_test",
    });
    expect(outcome.activeComp).toBe(2);
    expect(outcome.missingAssets).toEqual([]);
    expect(outcome.assetPaths).toEqual({});
  });

  it("boots start-from-scratch for a project with no version (nothing downloaded, nothing opened)", async () => {
    const { bridge, client } = await setup({
      manifest: { currentVersion: null },
      assets: {},
    });
    const outcome = await loadProjectSession({
      bridge,
      client: client.client,
      projectId: "prj_test",
    });
    // No snapshot to fetch or open — the editor keeps its own default
    // project; the first save creates v1 (root upload, W3-G3).
    expect(outcome.openedPath).toBeNull();
    expect(outcome.missingAssets).toEqual([]);
    expect(outcome.assetPaths).toEqual({});
    expect(client.calls.downloadProjectFile).toEqual([]);
  });

  it("rejects with a typed error when the manifest is malformed", async () => {
    const { bridge, client } = await setup();
    const broken: EditorSessionClient = {
      ...client.client,
      getManifest: async () => ({}) as never,
    };
    const err = await loadProjectSession({ bridge, client: broken, projectId: "prj_test" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EditorSessionError);
    expect((err as EditorSessionError).code).toBe("manifest-invalid");
  });

  it("rejects when the project file download fails", async () => {
    const { bridge, client } = await setup();
    const broken: EditorSessionClient = {
      ...client.client,
      downloadProjectFile: async () => {
        throw new Error("HTTP 500: object unavailable");
      },
    };
    const err = await loadProjectSession({ bridge, client: broken, projectId: "prj_test" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EditorSessionError);
    expect((err as EditorSessionError).code).toBe("project-file-failed");
    expect((err as EditorSessionError).message).toContain("HTTP 500");
  });

  it("rejects when the editor does not end up with the project open (open-failed)", async () => {
    const { bridge, client } = await setup({
      projectBytes: new TextEncoder().encode("not a studio-fake-ecproj"),
    });
    const err = await loadProjectSession({
      bridge,
      client: client.client,
      projectId: "prj_test",
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EditorSessionError);
    expect((err as EditorSessionError).code).toBe("open-failed");
  });

  it("validates its options", async () => {
    const err = await loadProjectSession({} as Parameters<typeof loadProjectSession>[0]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EditorSessionError);
    expect((err as EditorSessionError).code).toBe("bad-args");
  });
});
