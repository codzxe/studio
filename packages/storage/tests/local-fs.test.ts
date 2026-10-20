// LocalFsStorage tests — real roundtrips under os.tmpdir (skipped wholesale
// when the temp dir is missing or read-only), plus pure signed-URL tests.
// Deterministic clocks via the `now` seam; no network.

import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_PUBLIC_BASE_URL,
  LOCAL_SIGNED_URL_PATH,
  LocalFsStorage,
  type LocalSignedUrlParams,
  localSignaturePayload,
  verifyLocalSignedUrlParams,
} from "../src/drivers/local-fs.js";
import { assetKey, checkpointKey, previewKey, validateStoragePrefix } from "../src/keys.js";
import { sha256Hex } from "../src/sha256.js";
import type { Storage } from "../src/types.js";
import { expectOk, expectStorageErrorCode } from "./helpers.js";

/** Writable base or null (read-only fs / no tmpdir) → skip the whole file. */
async function makeWritableBase(): Promise<string | null> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "studio-storage-"));
    const probe = join(dir, ".probe");
    await writeFile(probe, "ok");
    await rm(probe); // keep the probe out of list() assertions
    return dir;
  } catch {
    return null;
  }
}

const base = await makeWritableBase();
const describeFs = base === null ? describe.skip : describe;

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z"); // 1767225600000
const SECRET = "0123456789abcdef0123";
const ORG = "org-1";

function newStorage(): { storage: LocalFsStorage; dir: string } {
  if (base === null) {
    throw new Error("tmpdir is not writable");
  }
  const storage = new LocalFsStorage(base, {
    signingSecret: SECRET,
    publicBaseUrl: "http://localhost:8787",
    now: () => FIXED_NOW,
  });
  return { storage, dir: base };
}

const createdKeys: string[] = [];
afterEach(async () => {
  if (base === null) return;
  const { storage } = newStorage();
  for (const key of createdKeys.splice(0)) {
    await storage.delete(key);
  }
});

describeFs("LocalFsStorage roundtrips", () => {
  it("put → get returns the same bytes and reports sha256/bytes", async () => {
    const { storage } = newStorage();
    const key = expectOk(
      assetKey({ organizationId: ORG, assetId: "ast-1", filename: "photo.png" }),
    );
    createdKeys.push(key);
    const bytes = new TextEncoder().encode("hello world");
    const object = await storage.put(key, bytes, { contentType: "image/png" });
    expect(object).toEqual({
      key,
      bytes: 11,
      contentType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const read = await storage.get(key);
    expect(read).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(read ?? new Uint8Array())).toBe("hello world");
  });

  it("put accepts an empty object (zero-byte)", async () => {
    const { storage } = newStorage();
    const key = expectOk(assetKey({ organizationId: ORG, assetId: "ast-empty" }));
    createdKeys.push(key);
    const object = await storage.put(key, new Uint8Array(0), {
      contentType: "application/octet-stream",
    });
    expect(object.bytes).toBe(0);
    expect(object.sha256).toBe(sha256Hex(new Uint8Array(0)));
    expect(await storage.get(key)).toBeInstanceOf(Uint8Array);
  });

  it("put verifies a correct contentSha256 and rejects a mismatch", async () => {
    const { storage } = newStorage();
    const key = expectOk(
      previewKey({ organizationId: ORG, documentId: "doc-1", width: 512, revision: 0 }),
    );
    createdKeys.push(key);
    const bytes = new TextEncoder().encode("png-bytes");
    await storage.put(key, bytes, { contentType: "image/png", contentSha256: sha256Hex(bytes) });
    const err = await expectStorageErrorCode(
      storage.put(key, bytes, {
        contentType: "image/png",
        contentSha256: sha256Hex(new TextEncoder().encode("other")),
      }),
      "storage_checksum_mismatch",
    );
    expect(err.retryable).toBeUndefined();
  });

  it("get resolves null for missing objects", async () => {
    const { storage } = newStorage();
    const key = expectOk(
      checkpointKey({ organizationId: ORG, documentId: "doc-1", sessionId: "s-1", revision: 3 }),
    );
    expect(await storage.get(key)).toBeNull();
  });

  it("delete is idempotent (missing objects are fine)", async () => {
    const { storage } = newStorage();
    const key = expectOk(assetKey({ organizationId: ORG, assetId: "ast-gone" }));
    await storage.delete(key);
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
  });

  it("rejects traversal keys with storage_invalid_key before any fs effect", async () => {
    const { storage } = newStorage();
    for (const key of [
      "../escape.png",
      "assets/organizations/org-1/assets/a-1/../../escape.png",
      "/abs/escape.png",
      "assets\\organizations\\org-1\\assets\\a-1",
    ]) {
      await expectStorageErrorCode(
        storage.put(key, new Uint8Array(1), { contentType: "image/png" }),
        "storage_invalid_key",
      );
      await expectStorageErrorCode(storage.get(key), "storage_invalid_key");
      await expectStorageErrorCode(storage.delete(key), "storage_invalid_key");
    }
  });

  it("rejects bad put options with storage_invalid_argument", async () => {
    const { storage } = newStorage();
    const key = expectOk(assetKey({ organizationId: ORG, assetId: "ast-opts" }));
    await expectStorageErrorCode(
      storage.put(key, new Uint8Array(1), { contentType: "not-a-mime-type" }),
      "storage_invalid_argument",
    );
    await expectStorageErrorCode(
      storage.put(key, new Uint8Array(1), { contentType: "image/png", contentSha256: "zz" }),
      "storage_invalid_argument",
    );
    await expectStorageErrorCode(
      storage.put(key, "not bytes" as unknown as Uint8Array, { contentType: "image/png" }),
      "storage_invalid_argument",
    );
  });

  it("list walks the tenant subtree sorted and honours partial prefixes", async () => {
    const { storage } = newStorage();
    const keys = [
      expectOk(assetKey({ organizationId: ORG, assetId: "ast-1", filename: "b.png" })),
      expectOk(assetKey({ organizationId: ORG, assetId: "ast-1", filename: "a.png" })),
      expectOk(previewKey({ organizationId: ORG, documentId: "doc-1", width: 512, revision: 0 })),
      expectOk(
        checkpointKey({
          organizationId: "org-2",
          documentId: "doc-2",
          sessionId: "s-1",
          revision: 0,
        }),
      ),
    ];
    createdKeys.push(...keys);
    for (const key of keys) {
      await storage.put(key, new Uint8Array([1]), { contentType: "application/octet-stream" });
    }
    expectOk(validateStoragePrefix(""));

    const allOrg1: string[] = [];
    for await (const key of storage.list(`assets/organizations/${ORG}/`)) {
      allOrg1.push(key);
    }
    expect(allOrg1).toEqual([
      "assets/organizations/org-1/assets/ast-1/a.png",
      "assets/organizations/org-1/assets/ast-1/b.png",
    ]);

    const whole: string[] = [];
    for await (const key of storage.list("")) {
      whole.push(key);
    }
    expect(whole).toContain("renders/organizations/org-1/documents/doc-1/preview-512-0.png");
    expect(whole).toContain(
      "checkpoints/organizations/org-2/documents/doc-2/sessions/s-1/checkpoint-0.pcraft",
    );
    expect(whole.length).toBe(4);

    const partial: string[] = [];
    for await (const key of storage.list("renders/organizations/org-1/docum")) {
      partial.push(key);
    }
    expect(partial).toEqual(["renders/organizations/org-1/documents/doc-1/preview-512-0.png"]);

    const nonexistent: string[] = [];
    for await (const key of storage.list("renders/organizations/org-9/")) {
      nonexistent.push(key);
    }
    expect(nonexistent).toEqual([]);
  });

  it("rejects traversal prefixes at list time", async () => {
    const { storage } = newStorage();
    await expectStorageErrorCode(
      (async () => {
        for await (const key of storage.list("../escape/")) {
          expect(key).toBe("unreachable");
        }
      })(),
      "storage_invalid_key",
    );
  });
});

describeFs("local signed URLs (dev §15.1 contract)", () => {
  it("sign produces a deterministic HMAC URL with exp = now + ttl*1000", async () => {
    const { storage } = newStorage();
    const key = expectOk(
      assetKey({ organizationId: ORG, assetId: "ast-1", filename: "photo.png" }),
    );
    createdKeys.push(key);
    const { url, expiresAt } = await storage.sign(key, { ttlSeconds: 900 });
    expect(expiresAt).toBe(FIXED_NOW.getTime() + 900_000);
    expect(url.startsWith(`http://localhost:8787${LOCAL_SIGNED_URL_PATH}?`)).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get("key")).toBe(key);
    expect(query.get("exp")).toBe(String(expiresAt));
    expect(query.get("dl")).toBeNull();
    expect(query.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("download:true adds dl=1 and covers the disposition in the HMAC", async () => {
    const { storage } = newStorage();
    const key = expectOk(assetKey({ organizationId: ORG, assetId: "ast-dl" }));
    createdKeys.push(key);
    const { url } = await storage.sign(key, { ttlSeconds: 60, download: true });
    expect(new URL(url).searchParams.get("dl")).toBe("1");
    // Same key, no dl → different signature (disposition is signed).
    const inline = await storage.sign(key, { ttlSeconds: 60 });
    expect(new URL(inline.url).searchParams.get("sig")).not.toBe(
      new URL(url).searchParams.get("sig"),
    );
  });

  it("sign enforces ttlSeconds ≤ 900 (§15.1)", async () => {
    const { storage } = newStorage();
    const key = expectOk(assetKey({ organizationId: ORG, assetId: "ast-ttl" }));
    for (const ttl of [0, -5, 901, 9000, 12.5]) {
      await expectStorageErrorCode(storage.sign(key, { ttlSeconds: ttl }), "storage_invalid_ttl");
    }
  });

  it("sign without a secret fails with storage_config_invalid", async () => {
    const storage = new LocalFsStorage(base ?? "/nonexistent", { now: () => FIXED_NOW });
    const key = expectOk(assetKey({ organizationId: ORG, assetId: "ast-1" }));
    const err = await expectStorageErrorCode(
      storage.sign(key, { ttlSeconds: 60 }),
      "storage_config_invalid",
    );
    expect(err.hint).toContain("STORAGE_SIGNING_SECRET");
  });

  it("uses the default public base URL when none is configured", async () => {
    const storage = new LocalFsStorage(base ?? "/nonexistent", {
      signingSecret: SECRET,
      now: () => FIXED_NOW,
    });
    const key = expectOk(assetKey({ organizationId: ORG, assetId: "ast-default" }));
    const { url } = await storage.sign(key, { ttlSeconds: 60 });
    expect(url.startsWith(`${DEFAULT_LOCAL_PUBLIC_BASE_URL}${LOCAL_SIGNED_URL_PATH}?`)).toBe(true);
  });

  it("different secrets produce different signatures (unguessability)", async () => {
    const key = "assets/organizations/org-1/assets/ast-1";
    const one = new LocalFsStorage(base ?? "/nonexistent", {
      signingSecret: "secret-one-0123456789",
      now: () => FIXED_NOW,
    });
    const two = new LocalFsStorage(base ?? "/nonexistent", {
      signingSecret: "secret-two-0123456789",
      now: () => FIXED_NOW,
    });
    const sigOne = new URL((await one.sign(key, { ttlSeconds: 60 })).url).searchParams.get("sig");
    const sigTwo = new URL((await two.sign(key, { ttlSeconds: 60 })).url).searchParams.get("sig");
    expect(sigOne).not.toBe(sigTwo);
  });
});

describe("verifyLocalSignedUrlParams (pure — runs even on read-only fs)", () => {
  const key = "exports/organizations/org-1/documents/doc-1/png-v-1.png";
  const exp = FIXED_NOW.getTime() + 60_000;

  /** HMAC computed with node:crypto directly — independent of the driver under test. */
  const hmacHex = (secret: string, payload: string): string =>
    createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  const make = (
    disposition: LocalSignedUrlParams["disposition"],
    secret = SECRET,
  ): LocalSignedUrlParams => {
    const payload = localSignaturePayload({ key, exp, sig: "", disposition });
    return { key, exp, sig: hmacHex(secret, payload), disposition };
  };

  it("accepts a correctly signed URL", () => {
    expect(verifyLocalSignedUrlParams(SECRET, make("inline"), FIXED_NOW)).toEqual({ ok: true });
  });

  it("accepts attachment disposition as signed", () => {
    expect(verifyLocalSignedUrlParams(SECRET, make("attachment"), FIXED_NOW)).toEqual({ ok: true });
  });

  it("rejects a wrong secret / tampered key / tampered disposition", () => {
    expect(
      verifyLocalSignedUrlParams("wrong-secret-0123456789", make("inline"), FIXED_NOW),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const tampered = {
      ...make("inline"),
      key: "exports/organizations/org-2/documents/doc-1/png-v-1.png",
    };
    expect(verifyLocalSignedUrlParams(SECRET, tampered, FIXED_NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const flipped = { ...make("inline"), disposition: "attachment" as const };
    expect(verifyLocalSignedUrlParams(SECRET, flipped, FIXED_NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("reports expired URLs after exp, and never before", () => {
    expect(verifyLocalSignedUrlParams(SECRET, make("inline"), new Date(exp + 1))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyLocalSignedUrlParams(SECRET, make("inline"), new Date(exp - 1))).toEqual({
      ok: true,
    });
  });

  it("rejects malformed signatures without throwing", () => {
    expect(
      verifyLocalSignedUrlParams(SECRET, { ...make("inline"), sig: "nothex" }, FIXED_NOW),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyLocalSignedUrlParams(SECRET, { ...make("inline"), sig: "" }, FIXED_NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("structural seam", () => {
  it("LocalFsStorage satisfies the Storage interface", () => {
    const storage: Storage = new LocalFsStorage(base ?? "/nonexistent", { signingSecret: SECRET });
    expect(typeof storage.put).toBe("function");
    const iterable: AsyncIterable<string> = storage.list("");
    expect(typeof iterable[Symbol.asyncIterator]).toBe("function");
  });
});
