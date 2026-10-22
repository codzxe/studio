/**
 * The editor RSC route tests — project resolution by slug, manifest mapping
 * into the host payload, and the 404/redirect semantics (hard rule 3).
 * `@/lib/gateway` is mocked (the seam's own tests cover the unwrap);
 * `EditorHost` is stubbed so this stays an RSC-logic test.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorHostPayload } from "@/components/editor-host/types";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
  redirect: (to: string) => {
    throw new Error(`__REDIRECT__:${to}`);
  },
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
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const MEMBERSHIPS = [
  {
    workspaceId: "ws_first",
    role: "owner",
    workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
  },
  {
    workspaceId: "ws_second",
    role: "viewer",
    workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
  },
];

const PROJECT_ROW = {
  id: "prj_demo_launch_film",
  workspaceId: "ws_second",
  name: "Launch film",
  slug: "launch-film",
  thumbnailUrl: null,
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

/** Script `/v1/me` + per-workspace project pages + the manifest in one go. */
function scriptHappyPath(): void {
  gatewayMock.mockImplementation((path: string, init?: { workspaceId?: string }) => {
    if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
    if (path.startsWith("/v1/projects?")) {
      // Page 1 in ws_first pages forward once, then the match in ws_second.
      if (init?.workspaceId === "ws_first" && path.includes("cursor=ws1-page-2")) {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      if (init?.workspaceId === "ws_first") {
        return Promise.resolve({
          items: [{ ...PROJECT_ROW, id: "prj_other", slug: "other", workspaceId: "ws_first" }],
          nextCursor: "ws1-page-2",
        });
      }
      return Promise.resolve({ items: [PROJECT_ROW], nextCursor: null });
    }
    if (path === "/v1/projects/prj_demo_launch_film/manifest") {
      return Promise.resolve(MANIFEST);
    }
    throw new Error(`unexpected gateway path: ${path}`);
  });
}

async function renderPage(slug: string): Promise<React.ReactNode> {
  return EditorPage({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  lastHostPayload = null;
  gatewayMock.mockReset();
});

describe("editor RSC route", () => {
  it("resolves the project by slug across workspaces and passes the mapped payload", async () => {
    scriptHappyPath();
    const page = await renderPage("launch-film");
    render(<>{page}</>);

    expect(screen.getByTestId("editor-host-stub")).toHaveAttribute("data-project", "Launch film");
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
    // Exactly one manifest fetch — the RSC payload is the single source.
    expect(gatewayMock.mock.calls.filter(([path]) => path.endsWith("/manifest"))).toHaveLength(1);
  });

  it("404s when no workspace has the slug (cross-tenant = 404, hard rule 3)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/projects?")) {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage("does-not-exist")).rejects.toThrow("__NOT_FOUND__");
  });

  it("404s soft-deleted projects", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/projects?")) {
        return Promise.resolve({
          items: [{ ...PROJECT_ROW, deletedAt: "2026-10-22T00:00:00Z" }],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected gateway path: ${path}`);
    });
    await expect(renderPage("launch-film")).rejects.toThrow("__NOT_FOUND__");
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

  it("404s the gateway's NOT_FOUND (cross-tenant manifest reach)", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/projects?")) {
        return Promise.resolve({ items: [PROJECT_ROW], nextCursor: null });
      }
      return Promise.reject(
        new GatewayHttpError({ status: 404, code: "NOT_FOUND", message: "Not found." }),
      );
    });
    await expect(renderPage("launch-film")).rejects.toThrow("__NOT_FOUND__");
  });

  it("renders the no-version empty state for a project without snapshots", async () => {
    gatewayMock.mockImplementation((path: string) => {
      if (path === "/v1/me") return Promise.resolve({ memberships: MEMBERSHIPS });
      if (path.startsWith("/v1/projects?")) {
        return Promise.resolve({ items: [PROJECT_ROW], nextCursor: null });
      }
      return Promise.resolve({ ...MANIFEST, currentVersion: null });
    });
    const page = await renderPage("launch-film");
    render(<>{page}</>);
    expect(screen.getByTestId("editor-no-version")).toBeInTheDocument();
    expect(lastHostPayload).toBeNull();
  });
});
