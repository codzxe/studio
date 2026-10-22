/**
 * `session-client` tests — the production `EditorSessionClient` mapping
 * decisions (M3-A): payload-served manifest, pre-signed downloads, and the
 * REAL multipart §7.2 version upload with 409 → conflict mapping (never a
 * throw). `fetch` is injected; no network.
 */

import type { EditorSessionClient, UploadVersionResult } from "@/lib/editor-session";
import { describe, expect, it, vi } from "vitest";
import { createApiSession } from "./session-client";
import type { EditorHostPayload } from "./types";

const ZERO_SHA = "0".repeat(64);
const OTHER_SHA = "1".repeat(64);

const PAYLOAD: EditorHostPayload = {
  workspaceId: "ws_test",
  manifest: {
    project: { id: "prj_test", slug: "test-project", name: "Test Project" },
    currentVersion: { id: "ver_base", label: null, sha256: ZERO_SHA, sizeBytes: 4096 },
    assets: [
      {
        id: "ast_logo",
        name: "logo.png",
        virtualPath: "/assets/ast_logo/logo.png",
        downloadUrl: "https://storage.test/signed/logo",
        sizeBytes: 8,
      },
    ],
    projectFileUrl: "https://storage.test/signed/project.ecproj",
  },
};

function okData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errBody(
  status: number,
  body: { code: string; message: string; hint?: string; retryable?: boolean },
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: body.code,
        message: body.message,
        hint: body.hint,
        retryable: body.retryable ?? false,
        requestId: "req_test_0000000000000000000000",
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

interface RecordedFetch {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

function recordingFetch(handler: (input: string, init?: RequestInit) => Promise<Response>): {
  calls: RecordedFetch[];
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: RecordedFetch[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  return { calls, fetch };
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function uploadInput(
  overrides: Partial<{
    bytes: Uint8Array;
    baseVersionId: string;
    sha256: string;
    label: string;
  }> = {},
) {
  return {
    bytes: BYTES,
    baseVersionId: "ver_base",
    sha256: OTHER_SHA,
    ...overrides,
  };
}

const VERSION_ROW = {
  id: "ver_new",
  projectId: "prj_test",
  version: 3,
  parentVersionId: "ver_base",
  sha256: OTHER_SHA,
  sizeBytes: 8,
  label: "Manual save",
  agentRunId: null,
  createdBy: "usr_1",
  createdAt: "2026-10-22T00:00:00Z",
};

describe("session-client — getManifest", () => {
  it("serves the RSC-resolved payload without any fetch", async () => {
    const { calls, fetch } = recordingFetch(() => Promise.resolve(okData(null)));
    const session = createApiSession({ payload: PAYLOAD, fetch });
    const manifest = await (session.client.getManifest("prj_test") as ReturnType<
      EditorSessionClient["getManifest"]
    >);
    expect(manifest.project).toEqual({
      id: "prj_test",
      slug: "test-project",
      name: "Test Project",
    });
    expect(manifest.currentVersion.id).toBe("ver_base");
    expect(manifest.assets[0]?.virtualPath).toBe("/assets/ast_logo/logo.png");
    expect(manifest.projectFileUrl).toBe("https://storage.test/signed/project.ecproj");
    expect(calls).toHaveLength(0);
  });
});

describe("session-client — downloads", () => {
  it("fetches the pre-signed URL with NO auth headers", async () => {
    const { calls, fetch } = recordingFetch(() =>
      Promise.resolve(new Response(new Uint8Array(BYTES), { status: 200 })),
    );
    const session = createApiSession({ payload: PAYLOAD, fetch });
    const blob = await session.client.downloadAsset("https://storage.test/signed/logo");
    expect(blob.size).toBe(8);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://storage.test/signed/logo");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-workspace-id")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
  });

  it("rejects with a safe typed error on a failed download", async () => {
    const { fetch } = recordingFetch(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 })),
    );
    const session = createApiSession({ payload: PAYLOAD, fetch });
    await expect(
      session.client.downloadProjectFile("https://storage.test/signed/project.ecproj"),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("session-client — uploadVersion (real §7.2 multipart wire)", () => {
  it("posts descriptor+file multipart with Idempotency-Key and x-workspace-id", async () => {
    const { calls, fetch } = recordingFetch(() => Promise.resolve(okData(VERSION_ROW, 201)));
    const session = createApiSession({
      payload: PAYLOAD,
      fetch,
      idempotencyKey: () => "idem-upload-0001",
    });

    const result = (await session.client.uploadVersion("prj_test", uploadInput())) as Extract<
      UploadVersionResult,
      { ok: true }
    >;
    expect(result.ok).toBe(true);
    expect(result.version).toEqual({
      id: "ver_new",
      label: "Manual save",
      sha256: OTHER_SHA,
      sizeBytes: 8,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/v1/projects/prj_test/versions");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Idempotency-Key")).toBe("idem-upload-0001");
    expect(headers.get("x-workspace-id")).toBe("ws_test");
    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const descriptor = JSON.parse(String((body as FormData).get("descriptor"))) as Record<
      string,
      unknown
    >;
    expect(descriptor).toEqual({
      baseVersionId: "ver_base",
      sha256: OTHER_SHA,
      label: undefined,
      sizeBytes: 8,
    });
    const file = (body as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).size).toBe(8);
  });

  it("maps 409 PROJECT_VERSION_CONFLICT to { ok:false, conflict:true } — NEVER throws", async () => {
    const { fetch } = recordingFetch(() =>
      Promise.resolve(
        errBody(409, {
          code: "PROJECT_VERSION_CONFLICT",
          message: "The project changed while you were editing",
          hint: "Reload the latest version, or restore/compare to resolve the conflict.",
        }),
      ),
    );
    const session = createApiSession({ payload: PAYLOAD, fetch });
    const result = await session.client.uploadVersion("prj_test", uploadInput());
    expect(result).toEqual({ ok: false, conflict: true, serverVersion: null });
  });

  it("maps other failures to { ok:false, error } with a typed ApiError", async () => {
    const { fetch } = recordingFetch(() =>
      Promise.resolve(
        errBody(429, {
          code: "RATE_LIMITED",
          message: "Too many requests. Slow down for a moment.",
        }),
      ),
    );
    const session = createApiSession({ payload: PAYLOAD, fetch });
    const result = await session.client.uploadVersion("prj_test", uploadInput());
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect((result.error as { code: string }).code).toBe("RATE_LIMITED");
    } else {
      expect.unreachable("expected the error arm");
    }
  });

  it("maps a network failure to the error arm (retryable by the engine)", async () => {
    const { fetch } = recordingFetch(() => Promise.reject(new TypeError("fetch failed")));
    const session = createApiSession({ payload: PAYLOAD, fetch });
    const result = await session.client.uploadVersion("prj_test", uploadInput());
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect((result.error as { code: string }).code).toBe("NETWORK_ERROR");
    }
  });
});

describe("session-client — lease port", () => {
  it("acquires through the api-client's real §7.2 lease wire", async () => {
    const { calls, fetch } = recordingFetch(() =>
      Promise.resolve(
        okData({
          acquired: false,
          holderName: "Dana Flow",
          expiresAt: "2026-10-15T09:07:00Z",
          readOnly: true,
        }),
      ),
    );
    const session = createApiSession({ payload: PAYLOAD, fetch });
    const outcome = await session.leases.acquire("sess_12345678");
    expect(outcome).toEqual({ acquired: false, holderName: "Dana Flow", readOnly: true });
    expect(calls[0]?.input).toBe("/v1/projects/prj_test/lease");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-workspace-id")).toBe("ws_test");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ sessionId: "sess_12345678" });
  });

  it("releases best-effort (a failed release resolves)", async () => {
    const { calls, fetch } = recordingFetch(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const session = createApiSession({ payload: PAYLOAD, fetch });
    await expect(session.leases.release()).resolves.toBeUndefined();
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(calls[0]?.input).toBe("/v1/projects/prj_test/lease");
  });
});
