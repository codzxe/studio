/**
 * The editor RSC route tests — project resolution by slug (ONE
 * `GET /v1/projects/resolve/:slug` call, the perf round's TTFB fix), manifest
 * mapping into the host payload, and the 404/redirect semantics (hard rule 3).
 * `@/lib/gateway` is mocked (the seam's own tests cover the unwrap);
 * `EditorHost` is stubbed so this stays an RSC-logic test. The §8.7
 * `EditorCapabilityGate` stays REAL (the page mounts it around the host) —
 * jsdom is an unsupported browser (no navigator.gpu, no WebGL2), so the
 * supported paths stub `navigator.gpu` present and one arm keeps jsdom's
 * natural unsupported state to prove the gate blocks the host.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorHostPayload } from "@/components/editor-host/types";
import { __resetEditorWarmupForTests } from "@/lib/editor-warmup";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
  redirect: (to: string) => {
    throw new Error(`__REDIRECT__:${to}`);
  },
  // The real gate's checking arm renders EditorTopBar (the ROUND-13 LCP fix),
  // which calls useRouter at render time.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const gatewayMock = vi.fn();
vi.mock("@/lib/gateway", () => ({
  GatewayHttpError: class GatewayHttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(init: { status: number; code: string; message: string }) {
      super(init.message);
      this.status = init.status;
      this.code = init.code;
    }
    get isNotFound(): boolean {
      return this.status === 404 || this.code === "NOT_FOUND" || this.code === "WORKSPACE_NOT_FOUND";
    }
  },
  isGatewayHttpError: (error: unknown): boolean =>
    error instanceof Error && error.constructor.name === "GatewayHttpError",
  gatewayCall: (path: string, init?: { workspaceId?: string }) => gatewayMock(path, init),
}));

// The gate's "supported" verdict kicks the engine warm-up; the page test only
// cares about the route's RSC logic, so the warm-up is a no-op here (its own
// module tests cover the download/compile state machine). The REAL probe
// stays (the navigator.gpu stubs below exercise it); the session cache it
// now keeps (W3-D — shared with the shell's prewarm) resets per test in the
// afterEach below.
vi.mock("@/lib/editor-warmup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/editor-warmup")>();
  return { ...actual, warmEditorWasm: vi.fn() };
});

let lastHostPayload: EditorHostPayload | null = null;
vi.mock("@/components/editor-host/editor-host", () => ({
  EditorHost: (props: { payload: EditorHostPayload }) => {
    lastHostPayload = props.payload;
    return <div data-testid="editor-host-stub" data-project={props.payload.manifest.project.name} />;
  },
}));

import { GatewayHttpError } from "@/lib/gateway";
import EditorPage from "./page";

// ---------------------------------------------------------------------------
// Capability-probe stubs (§8.7) — mirror capability-gate.test.tsx: jsdom has
// neither a working navigator.gpu nor WebGL2, so without a stub the real gate
// blocks the editor-host stub in every supported-path render. "Present" means
// an adapter that can actually CREATE A DEVICE (the post-boot-bug probe does
// a floor-check + throwaway requestDevice, not a mere requestAdapter ping).
// ---------------------------------------------------------------------------

/**
 * Define (or clear) navigator.gpu. `undefined` is the honest "absent" stub
 * (biome bans `delete`); the present form carries the FULL post-boot-bug
 * probe contract (lib/editor-warmup.ts webgpuDeviceUsable): the adapter must
 * report a sane spec floor (`limits.maxComputeWorkgroupsPerDimension`) AND
 * `requestDevice` must create a throwaway device — an adapter that answers
 * without a usable device is the stub-adapter class the probe REJECTS.
 */
function stubNavigatorGpu(present: boolean): void {
  const nav = navigator as Navigator & { gpu?: unknown };
  Object.defineProperty(nav, "gpu", {
    value: present
      ? {
          requestAdapter: async () => ({
            limits: { maxComputeWorkgroupsPerDimension: 65535 },
            requestDevice: async () => ({ destroy: () => undefined }),
          }),
        }
      : undefined,
    configurable: true,
    writable: true,
  });
}

/** Stub canvas.getContext("webgl2") — `null` = no WebGL2 (jsdom's answer). */
function stubWebgl2(context: WebGL2RenderingContext | null) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as WebGL2RenderingContext | null);
}

// ---------------------------------------------------------------------------
// Wire fixture (the real §7.2 ProjectResolve shape the endpoint returns)
// ---------------------------------------------------------------------------

const PROJECT_DTO = {
  id: "prj_demo_launch_film",
  workspaceId: "ws_second",
  name: "Launch film",
  slug: "launch-film",
  thumbnailUrl: null,
  archived: false,
  currentVersionId: "ver_demo_2",
  createdBy: "usr_demo",
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  deletedAt: null,
};

const MANIFEST = {
  projectId: "prj_demo_launch_film",
  currentVersion: {
    id: "ver_demo_2",
    version: 2,
    sha256: "a".repeat(64),
    label: "Autosave",
    sizeBytes: 4096,
    createdAt: "2026-10-21T00:00:00Z",
    url: "https://storage.test/signed/prj/ver_demo_2.ecproj",
  },
  assets: [
    {
      id: "ast_logo",
      name: "logo.png",
      mime: "image/png",
      sizeBytes: 128,
      width: 64,
      height: 64,
      durationTicks: null,
      url: "https://storage.test/signed/assets/logo",
    },
  ],
  updatedAt: "2026-10-21T00:00:00Z",
};

/** The `GET /v1/projects/resolve/:slug` answer (everything in ONE call). */
const RESOLVE = {
  workspaceId: "ws_second",
  workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
  viewerId: "usr_demo",
  role: "viewer",
  project: PROJECT_DTO,
  manifest: MANIFEST,
};

/** Script the single by-slug resolution call. */
function scriptHappyPath(): void {
  gatewayMock.mockImplementation((path: string) => {
    if (path === "/v1/projects/resolve/launch-film") return Promise.resolve(RESOLVE);
    throw new Error(`unexpected gateway path: ${path}`);
  });
}

async function renderPage(slug: string): Promise<React.ReactNode> {
  return EditorPage({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  lastHostPayload = null;
  gatewayMock.mockReset();
  // The page mounts the REAL gate around the host stub — pretend WebGPU
  // exists so the supported paths render the host (jsdom has neither probe).
  stubNavigatorGpu(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  // "Absent" for the next arm is undefined (see stubNavigatorGpu).
  (navigator as Navigator & { gpu?: unknown }).gpu = undefined;
  // The shared probe's verdict is session-cached (W3-D) — reset it so each
  // arm's navigator.gpu stub decides its own verdict.
  __resetEditorWarmupForTests();
});

describe("editor RSC route", () => {
  it("resolves the project by slug in ONE gateway call and passes the mapped payload", async () => {
    scriptHappyPath();
    const page = await renderPage("launch-film");
    render(<>{page}</>);

    // The gate's probe is async (one adapter request) — the host appears once
    // the verdict lands.
    expect(await screen.findByTestId("editor-host-stub")).toHaveAttribute(
      "data-project",
      "Launch film",
    );
    expect(lastHostPayload).not.toBeNull();
    const payload = lastHostPayload as EditorHostPayload;
    expect(payload.workspaceId).toBe("ws_second");
    expect(payload.manifest.project).toEqual({
      id: "prj_demo_launch_film",
      slug: "launch-film",
      name: "Launch film",
    });
    expect(payload.manifest.currentVersion).toEqual({
      id: "ver_demo_2",
      label: "Autosave",
      sha256: "a".repeat(64),
      sizeBytes: 4096,
    });
    expect(payload.manifest.projectFileUrl).toBe(MANIFEST.currentVersion.url);
    // §6.3 stable virtual path derivation for the client.
    expect(payload.manifest.assets).toEqual([
      {
        id: "ast_logo",
        name: "logo.png",
        virtualPath: "/assets/ast_logo/logo.png",
        downloadUrl: "https://storage.test/signed/assets/logo",
        sizeBytes: 128,
      },
    ]);
    // THE PERF PIN: the by-slug resolution is exactly ONE gateway call — no
    // `/v1/me`, no per-workspace project pages, no second manifest fetch (the
    // pre-fix fan-out paid the auth+workspace middleware once per call).
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock).toHaveBeenCalledWith("/v1/projects/resolve/launch-film", undefined);
  });

  it("blocks the editor host when the browser has neither WebGPU nor WebGL2 (§8.7 gate)", async () => {
    // jsdom's natural state: no navigator.gpu, no WebGL2. The getContext spy
    // keeps jsdom's "Not implemented" console error quiet (house pattern).
    stubNavigatorGpu(false);
    stubWebgl2(null);
    scriptHappyPath();
    const page = await renderPage("launch-film");
    render(<>{page}</>);

    // The gate replaces the canvas page with the §8.11 full-page state; the
    // host (and its wasm boot) never runs — `lastHostPayload` stays null.
    const gate = await screen.findByTestId("editor-capability-gate");
    expect(gate).toHaveAttribute("data-gate-state", "unsupported");
    expect(screen.queryByTestId("editor-host-stub")).not.toBeInTheDocument();
    expect(lastHostPayload).toBeNull();
    // §8.11 static-preview offer routes to THIS project's history page.
    expect(screen.getByTestId("editor-gate-preview-link")).toHaveAttribute(
      "href",
      "/w/launch-film/history",
    );
  });

  it("404s an unresolvable slug — missing, deleted, archived or foreign are indistinguishable (hard rule 3)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/projects/resolve/does-not-exist") {
        return Promise.reject(
          new GatewayHttpError({
            status: 404,
            code: "PROJECT_NOT_FOUND",
            message: "We couldn't find that project.",
          }),
        );
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage("does-not-exist")).rejects.toThrow("__NOT_FOUND__");
    // Cross-tenant probes learn NOTHING: exactly one call, one 404 shape.
    expect(gatewayMock).toHaveBeenCalledTimes(1);
  });

  it("redirects an expired session to /sign-in with a next round-trip", async () => {
    gatewayMock.mockImplementation(() =>
      Promise.reject(
        new GatewayHttpError({ status: 401, code: "UNAUTHORIZED", message: "Sign in to continue." }),
      ),
    );
    await expect(renderPage("launch-film")).rejects.toThrow(
      "__REDIRECT__:/sign-in?next=%2Fw%2Flaunch-film%2Feditor",
    );
  });

  it("boots the editor start-from-scratch for a project without snapshots", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/projects/resolve/launch-film") {
        return Promise.resolve({
          ...RESOLVE,
          manifest: { ...MANIFEST, currentVersion: null, assets: [] },
        });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    const page = await renderPage("launch-film");
    render(<>{page}</>);
    // No dead-end empty state: the host renders and receives the null-version
    // payload (first save creates v1 through the root-upload path, W3-G3).
    expect(await screen.findByTestId("editor-host-stub")).toBeInTheDocument();
    expect(lastHostPayload).not.toBeNull();
    const payload = lastHostPayload as EditorHostPayload;
    expect(payload.manifest.currentVersion).toBeNull();
    expect(payload.manifest.projectFileUrl).toBeNull();
    expect(payload.manifest.assets).toEqual([]);
  });
});
