/**
 * A hand-written fake `EditorSessionClient` for tests (and for M3-A's page
 * tests): deterministic, in-memory, no network. Behaviours are injectable
 * per seam (asset failures, upload conflicts/failures/hangs) and every call
 * is recorded for assertions.
 *
 * Token-audit note (W5-06): the hex strings below are NOT styling — they are
 * DATA inside the fake `.ecproj` project file (a composition's background
 * colour in the project-file format, exactly what a real project would
 * carry). Design tokens govern UI colour/radius/type; project-file contents
 * are user data and pass through verbatim.
 */

import type {
  EditorSessionClient,
  ManifestAssetInfo,
  UploadVersionResult,
  VersionRef,
} from "./types";

// Re-export the seam types consumers expect from this module.
export type { UploadVersionResult, VersionRef } from "./types";

/** A `studio-fake-ecproj` the deterministic fake editor can open (state restores comp 2 at 3.5 s). */
export const defaultFakeProjectBytes: Uint8Array = new TextEncoder().encode(
  JSON.stringify({
    schema: "studio-fake-ecproj",
    version: "0.13.0-fake",
    project: {
      comps: [
        {
          id: 1,
          name: "Main",
          width: 1920,
          height: 1080,
          duration: 10,
          frameRate: 29.97,
          background: "#000000",
        },
        {
          id: 2,
          name: "Intro",
          width: 1080,
          height: 1920,
          duration: 5,
          frameRate: 30,
          background: "#101010",
        },
      ],
      layers: [],
      keyframes: [],
    },
    state: { activeComp: 2, selectedLayers: [], playhead: 3.5 },
  }),
);

export interface FakeUploadCall {
  readonly projectId: string;
  readonly input: {
    readonly bytes: Uint8Array;
    readonly baseVersionId: string | null;
    readonly sha256: string;
    readonly label?: string;
  };
}

export interface FakeEditorSessionClientCalls {
  readonly getManifest: string[];
  readonly downloadProjectFile: string[];
  readonly downloadAsset: string[];
  readonly uploads: FakeUploadCall[];
}

export interface FakeSessionClientOptions {
  /** Manifest returned by `getManifest` (defaults to a two-asset project; see below). */
  readonly manifest?: {
    readonly project?: { readonly id?: string; readonly slug?: string; readonly name?: string };
    /** `null` = a fresh project (no versions yet) — start-from-scratch. */
    readonly currentVersion?: VersionRef | null;
    readonly assets?: readonly ManifestAssetInfo[];
    readonly projectFileUrl?: string | null;
  };
  /** `.ecproj` bytes served by `downloadProjectFile` (default: `defaultFakeProjectBytes`). */
  readonly projectBytes?: Uint8Array;
  /**
   * assetId → bytes (registered normally), or an `Error` (download fails),
   * or `"hang"` (the download never settles — timeout tests).
   */
  readonly assets?: Readonly<Record<string, Uint8Array | Error | "hang">>;
  /**
   * Per-upload behaviour (default: success with a fresh version derived from
   * the input). Receives the zero-based call index for scripted failures.
   */
  readonly upload?: (
    call: FakeUploadCall,
    index: number,
  ) => UploadVersionResult | "hang" | Promise<UploadVersionResult | "hang">;
}

export interface FakeEditorSessionClient {
  readonly client: EditorSessionClient;
  readonly calls: FakeEditorSessionClientCalls;
  /** Resolve a `"hang"`ing upload manually (dispose/single-flight tests). */
  readonly resolveUpload: (index: number, result: UploadVersionResult) => void;
}

const ZERO_SHA = "0000000000000000000000000000000000000000000000000000000000000000";

/** The base `VersionRef` the default manifest reports (`manifest.currentVersion`). */
export const fakeBaseVersion: VersionRef = {
  id: "ver_base",
  label: null,
  sha256: ZERO_SHA,
  sizeBytes: 4096,
};

export function createFakeEditorSessionClient(
  opts: FakeSessionClientOptions = {},
): FakeEditorSessionClient {
  const manifestOpts = opts.manifest ?? {};
  const project = {
    id: manifestOpts.project?.id ?? "prj_test",
    slug: manifestOpts.project?.slug ?? "test-project",
    name: manifestOpts.project?.name ?? "Test Project",
  };
  const currentVersion: VersionRef | null =
    manifestOpts.currentVersion === null ? null : (manifestOpts.currentVersion ?? {
      id: "ver_base",
      label: null,
      sha256: ZERO_SHA,
      sizeBytes: 4096,
    });
  const assets: ManifestAssetInfo[] =
    manifestOpts.assets !== undefined
      ? [...manifestOpts.assets]
      : Object.keys(opts.assets ?? {}).length > 0
        ? Object.entries(opts.assets ?? {}).map(([id]) => fakeAsset(id))
        : [];
  const projectFileUrl =
    manifestOpts.projectFileUrl ??
    (currentVersion === null
      ? null
      : `https://storage.test/${project.slug}/${currentVersion.id}.ecproj`);

  const assetBytes = opts.assets ?? {};
  const projectBytes = opts.projectBytes ?? defaultFakeProjectBytes;

  const calls: FakeEditorSessionClientCalls = {
    getManifest: [],
    downloadProjectFile: [],
    downloadAsset: [],
    uploads: [],
  };
  const hangingUploads = new Map<number, (result: UploadVersionResult) => void>();

  function fakeAsset(id: string): ManifestAssetInfo {
    return {
      id,
      name: `${id.replace(/^ast_/, "")}.png`,
      virtualPath: `/assets/${id}/${id.replace(/^ast_/, "")}.png`,
      downloadUrl: `https://storage.test/${project.id}/${id}`,
      sizeBytes: 8,
    };
  }

  function assetForUrl(url: string): ManifestAssetInfo | undefined {
    return assets.find((asset) => asset.downloadUrl === url);
  }

  const client: EditorSessionClient = {
    async getManifest(projectId: string): Promise<{
      project: { id: string; slug: string; name: string };
      currentVersion: VersionRef | null;
      assets: ManifestAssetInfo[];
      projectFileUrl: string | null;
    }> {
      calls.getManifest.push(projectId);
      return {
        project,
        currentVersion,
        assets: [...assets],
        projectFileUrl,
      };
    },

    async downloadProjectFile(url: string): Promise<Blob> {
      calls.downloadProjectFile.push(url);
      return new Blob([projectBytes as Uint8Array<ArrayBuffer>], { type: "application/json" });
    },

    async downloadAsset(url: string): Promise<Blob> {
      calls.downloadAsset.push(url);
      const asset = assetForUrl(url);
      if (asset === undefined) {
        throw new Error(`HTTP 404: no asset at ${url}`);
      }
      const value = assetBytes[asset.id];
      if (value === undefined) throw new Error(`HTTP 404: no bytes for asset ${asset.id}`);
      if (value === "hang") return new Promise<Blob>(() => {});
      if (value instanceof Error) throw value;
      return new Blob([value as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
    },

    async uploadVersion(
      projectId: string,
      input: { bytes: Uint8Array; baseVersionId: string | null; sha256: string; label?: string },
    ): Promise<UploadVersionResult> {
      const index = calls.uploads.length;
      calls.uploads.push({ projectId, input });
      const behavior = opts.upload ?? defaultUpload;
      const result = await behavior({ projectId, input }, index);
      if (result === "hang") {
        return new Promise<UploadVersionResult>((resolve) => hangingUploads.set(index, resolve));
      }
      return result;
    },
  };

  function defaultUpload(call: FakeUploadCall): UploadVersionResult {
    const version: VersionRef = {
      id: `ver_upload_${calls.uploads.length}`,
      label: call.input.label ?? null,
      sha256: call.input.sha256,
      sizeBytes: call.input.bytes.byteLength,
    };
    return { ok: true, version };
  }

  return {
    client,
    calls,
    resolveUpload(index: number, result: UploadVersionResult): void {
      const resolve = hangingUploads.get(index);
      if (resolve !== undefined) {
        hangingUploads.delete(index);
        resolve(result);
      }
    },
  };
}
