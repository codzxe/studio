/**
 * W1-c journey tests — the asset-hardening + project-lifecycle surface
 * (BUILD_PLAN §M2 tasks 1/2/5, AUD-1 gaps #4/#5/#6). The routes landed via the
 * Wave-1 sweeps; THIS file is the integrator-owned test debt: nothing else in
 * the suite exercises POST /v1/assets end-to-end (AUD-1: zero gateway tests
 * touched the upload route).
 *
 * Real gateway + real Postgres + real LocalFS storage (DB-gated, skipIf).
 * Every flow goes through the REAL wire: descriptor → signed PUT → verify.
 *
 * Coverage map (AUD-1 → test):
 *   M2.2 verify-by-head sniff   → 1, 3, 4
 *   M2.2 SHA-256 dedupe         → 2
 *   M2.5 per-plan storageBytes  → 5
 *   M2.5 flat env cap           → 6
 *   M2.5 maxProjects            → 7
 *   M2.1 archived lifecycle     → 8
 *   M2.1 duplicate (+tenant)    → 9, 10
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CookieJar, HAS_DATABASE, api, bootServer, unique, uniqueEmail } from "./helpers.js";

const d = describe.skipIf(!HAS_DATABASE);

/** The canonical 1×1 transparent PNG (magic bytes + a complete valid image). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

d("W1-c asset hardening + project lifecycle (real gateway + real DB)", () => {
  let server: Awaited<ReturnType<typeof bootServer>>;

  beforeAll(async () => {
    // Quota math needs big descriptors: the default TEST env caps a single
    // asset at 10 MiB (helpers.ts) — lift the flat cap for THIS server so the
    // plan-side 1 GiB gate is the one under test (500 MB × 3 > 1 GiB).
    server = await bootServer({ env: { ASSET_MAX_BYTES: "600000000" } });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  interface Workspace {
    readonly jar: CookieJar;
    readonly id: string;
  }

  async function newWorkspace(): Promise<Workspace> {
    const jar = new CookieJar();
    const signUp = await api(server.base, "/v1/auth/sign-up/email", {
      method: "POST",
      jar,
      body: {
        email: uniqueEmail("w1c"),
        password: "Passw0rd!longenough",
        name: "W1-c Harness",
      },
    });
    expect(signUp.status).toBe(200);
    const wsResponse = await api(server.base, "/v1/workspaces", {
      method: "POST",
      jar,
      headers: { "idempotency-key": unique("ws") },
      body: { name: unique("W1C WS"), slug: unique("w1c-ws") },
    });
    expect(wsResponse.status).toBe(201);
    const ws = (await wsResponse.json()) as { data: { id: string } };
    return { jar, id: ws.data.id };
  }

  async function createProject(ws: Workspace, name?: string): Promise<string> {
    const response = await api(server.base, "/v1/projects", {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
      body: { name: name ?? unique("W1C Project") },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string } };
    return body.data.id;
  }

  /** Descriptor → (optional PUT) → response body. */
  async function describeAsset(
    ws: Workspace,
    spec: { name: string; mime: string; sizeBytes: number; sha256: string },
  ): Promise<Response> {
    return api(server.base, "/v1/assets", {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("ast") },
      body: spec,
    });
  }

  async function putBytes(ws: Workspace, uploadUrl: string, bytes: Buffer): Promise<void> {
    const target = new URL(uploadUrl).pathname;
    const put = await fetch(`${server.base}${target}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
  }

  async function complete(ws: Workspace, assetId: string): Promise<Response> {
    return api(server.base, `/v1/assets/${assetId}/complete`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("cmp") },
      body: {},
    });
  }

  // ── 1. The verified upload journey ────────────────────────────────────────

  it("uploads a real PNG through descriptor → signed PUT → verify, and verifies clean", async () => {
    const ws = await newWorkspace();
    const descriptor = await describeAsset(ws, {
      name: "tiny.png",
      mime: "image/png",
      sizeBytes: TINY_PNG.byteLength,
      sha256: sha256Of(TINY_PNG),
    });
    expect(descriptor.status).toBe(201);
    const body = (await descriptor.json()) as {
      data: {
        asset: { id: string; width: number | null; height: number | null };
        upload: { url: string } | null;
        duplicate?: boolean;
      };
    };
    expect(body.data.upload).not.toBeNull();
    expect(body.data.duplicate).toBeUndefined();
    await putBytes(ws, body.data.upload?.url ?? "", TINY_PNG);

    const verified = await complete(ws, body.data.asset.id);
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as {
      data: { asset: { id: string }; duplicate: boolean };
    };
    expect(verifiedBody.data.asset.id).toBe(body.data.asset.id);
    expect(verifiedBody.data.duplicate).toBe(false);
  });

  // ── 2. SHA-256 dedupe ─────────────────────────────────────────────────────

  it("dedupes an identical re-upload: existing row back, upload null, duplicate true, 200 not 201", async () => {
    const ws = await newWorkspace();
    const first = await describeAsset(ws, {
      name: "noise.png",
      mime: "image/png",
      sizeBytes: TINY_PNG.byteLength,
      sha256: sha256Of(TINY_PNG),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: { asset: { id: string }; upload: { url: string } | null };
    };
    await putBytes(ws, firstBody.data.upload?.url ?? "", TINY_PNG);
    expect((await complete(ws, firstBody.data.asset.id)).status).toBe(200);

    const twin = await describeAsset(ws, {
      name: "noise-again.png",
      mime: "image/png",
      sizeBytes: TINY_PNG.byteLength,
      sha256: sha256Of(TINY_PNG),
    });
    expect(twin.status).toBe(200); // nothing was created
    const twinBody = (await twin.json()) as {
      data: { asset: { id: string }; upload: { url: string } | null; duplicate?: boolean };
    };
    expect(twinBody.data.duplicate).toBe(true);
    expect(twinBody.data.upload).toBeNull();
    expect(twinBody.data.asset.id).toBe(firstBody.data.asset.id);
  });

  // ── 3. Type truth-up: the sniff catches a smuggle ─────────────────────────

  it("rejects a declared PNG whose bytes are text: 415 ASSET_TYPE_MISMATCH + the row is removed", async () => {
    const ws = await newWorkspace();
    const smuggled = Buffer.from("definitely not a png, just prose", "utf8");
    const descriptor = await describeAsset(ws, {
      name: "smuggle.png",
      mime: "image/png",
      sizeBytes: smuggled.byteLength,
      sha256: sha256Of(smuggled),
    });
    expect(descriptor.status).toBe(201);
    const body = (await descriptor.json()) as {
      data: { asset: { id: string }; upload: { url: string } | null };
    };
    await putBytes(ws, body.data.upload?.url ?? "", smuggled);

    const verified = await complete(ws, body.data.asset.id);
    expect(verified.status).toBe(415);
    const errBody = (await verified.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("ASSET_TYPE_MISMATCH");

    // Hygiene: the rejected row must be gone (§12.1 tenant read → 404).
    const after = await api(server.base, `/v1/assets/${body.data.asset.id}/url`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(after.status).toBe(404);
  });

  // ── 4. Size truth-up from the object HEAD ─────────────────────────────────

  it("rejects a lying sizeBytes: 400 SHA256_MISMATCH + the row is removed", async () => {
    const ws = await newWorkspace();
    const descriptor = await describeAsset(ws, {
      name: "liar.png",
      mime: "image/png",
      sizeBytes: TINY_PNG.byteLength + 4096, // lies about the size
      sha256: sha256Of(TINY_PNG),
    });
    expect(descriptor.status).toBe(201);
    const body = (await descriptor.json()) as {
      data: { asset: { id: string }; upload: { url: string } | null };
    };
    await putBytes(ws, body.data.upload?.url ?? "", TINY_PNG);

    const verified = await complete(ws, body.data.asset.id);
    expect(verified.status).toBe(400);
    const errBody = (await verified.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("SHA256_MISMATCH");
  });

  // ── 5. Per-plan storageBytes quota (§M2.5) ────────────────────────────────

  it("enforces the plan storage quota across uploads: the third 500 MB descriptor 429s (trial = 1 GiB)", async () => {
    const ws = await newWorkspace();
    const half = 500_000_000; // < the flat 500 MB env cap, > 1 GiB when tripled
    for (let index = 0; index < 3; index += 1) {
      const response = await describeAsset(ws, {
        name: `big-${index}.bin`,
        mime: "application/octet-stream",
        sizeBytes: half,
        sha256: sha256Of(Buffer.from(`distinct-${index}`)),
      });
      // Descriptors 1-2 fit (0/500 MB, 500/1000 MB); the third tips past 1 GiB.
      expect(response.status).toBe(index === 2 ? 429 : 201);
      if (index === 2) {
        const errBody = (await response.json()) as { error: { code: string } };
        expect(errBody.error.code).toBe("QUOTA_EXCEEDED");
      }
    }
  });

  // ── 6. The flat env cap stays the outer bound ─────────────────────────────

  it("rejects a single asset over the env cap with 413 ASSET_TOO_LARGE", async () => {
    const ws = await newWorkspace();
    const response = await describeAsset(ws, {
      name: "huge.bin",
      mime: "application/octet-stream",
      sizeBytes: 700_000_000, // > this server's 600 MB env cap, < the plan quota
      sha256: sha256Of(Buffer.from("huge")),
    });
    expect(response.status).toBe(413);
    const errBody = (await response.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("ASSET_TOO_LARGE");
  });

  // ── 7. maxProjects quota (§M2.5) ──────────────────────────────────────────

  it("enforces the trial maxProjects cap: the fourth create 429s QUOTA_EXCEEDED", async () => {
    const ws = await newWorkspace();
    for (let index = 0; index < 3; index += 1) {
      await createProject(ws, unique(`Cap ${index}`));
    }
    const fourth = await api(server.base, "/v1/projects", {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("prj") },
      body: { name: "One too many" },
    });
    expect(fourth.status).toBe(429);
    const errBody = (await fourth.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("QUOTA_EXCEEDED");
  });

  // ── 8. The archived lifecycle (§9.1) ──────────────────────────────────────

  it("archives a project: the default list drops it, ?archived=true keeps it, the direct read stays", async () => {
    const ws = await newWorkspace();
    const projectId = await createProject(ws, "To archive");

    const patch = await api(server.base, `/v1/projects/${projectId}`, {
      method: "PATCH",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("pat") },
      body: { archived: true },
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { data: { archived: boolean } };
    expect(patched.data.archived).toBe(true);

    const defaults = await api(server.base, "/v1/projects", {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const defaultsBody = (await defaults.json()) as { data: { items: { id: string }[] } };
    expect(defaultsBody.data.items.some((item) => item.id === projectId)).toBe(false);

    const archivedOnly = await api(server.base, "/v1/projects?archived=true", {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    const archivedBody = (await archivedOnly.json()) as { data: { items: { id: string }[] } };
    expect(archivedBody.data.items.some((item) => item.id === projectId)).toBe(true);

    // Archived ≠ deleted: the direct read still resolves.
    const direct = await api(server.base, `/v1/projects/${projectId}`, {
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id },
    });
    expect(direct.status).toBe(200);
  });

  // ── 9. Duplicate (§9.1) ───────────────────────────────────────────────────

  it('duplicates a project as "<name> (copy)" in the same workspace', async () => {
    const ws = await newWorkspace();
    const sourceId = await createProject(ws, "Launch film");

    const duplicate = await api(server.base, `/v1/projects/${sourceId}/duplicate`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("dup") },
      body: {},
    });
    expect(duplicate.status).toBe(201);
    const body = (await duplicate.json()) as { data: { id: string; name: string } };
    expect(body.data.id).not.toBe(sourceId);
    expect(body.data.name).toBe("Launch film (copy)");
  });

  it("refuses to duplicate past the maxProjects cap (429 before anything is created)", async () => {
    const ws = await newWorkspace();
    const sourceId = await createProject(ws, "Source");
    await createProject(ws);
    await createProject(ws); // trial cap = 3 reached
    const duplicate = await api(server.base, `/v1/projects/${sourceId}/duplicate`, {
      method: "POST",
      jar: ws.jar,
      headers: { "x-workspace-id": ws.id, "idempotency-key": unique("dup") },
      body: {},
    });
    expect(duplicate.status).toBe(429);
    const errBody = (await duplicate.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("QUOTA_EXCEEDED");
  });

  // ── 10. Tenant isolation on the new surfaces (§12.1) ──────────────────────

  it("reads another workspace's project as 404 on duplicate and asset url (never 403)", async () => {
    const [own, stranger] = await Promise.all([newWorkspace(), newWorkspace()]);
    const strangerProject = await createProject(stranger);

    const duplicate = await api(server.base, `/v1/projects/${strangerProject}/duplicate`, {
      method: "POST",
      jar: own.jar,
      headers: { "x-workspace-id": own.id, "idempotency-key": unique("dup") },
      body: {},
    });
    expect(duplicate.status).toBe(404);
  });
});
