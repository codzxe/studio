// S3Storage driver tests — fully offline: the aws4fetch signer is replaced by
// an injected fake (signerFactory seam) and fetch by a stub (fetchImpl seam);
// no aws4fetch install, no network. Presign (real code) is covered separately
// in s3-sign.test.ts against botocore-verified vectors.

import { describe, expect, it } from "vitest";

import {
  parseListObjectsXml,
  S3Storage,
  S3_STORAGE_OPTIONS_SCHEMA,
  type AwsClientLike,
} from "../src/drivers/s3.js";
import { assetKey, documentKey, expectOkKey } from "../src/s3-test-globals.js";
import { sha256Hex } from "../src/sha256.js";
import type { Storage } from "../src/types.js";
import { expectStorageErrorCode } from "./helpers.js";

const FIXED_NOW = () => new Date("2026-01-02T03:04:05.000Z");

/** Records what the signer saw and passes it through like aws4fetch would. */
function recordingSigner(sink: Array<{ method: string; url: string }>): AwsClientLike {
  return {
    async sign(input: RequestInfo, init?: RequestInit): Promise<Request> {
      const url = typeof input === "string" ? input : input.url;
      const method = init?.method ?? "GET";
      sink.push({ method, url });
      return new Request(url, { ...init, method });
    },
  };
}

interface RecordedFetch {
  requests: Request[];
  respond(request: Request, index: number): Response;
}

function recordingFetch(record: RecordedFetch): typeof fetch {
  let index = 0;
  const impl = async (input: RequestInfo): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    record.requests.push(request);
    const response = record.respond(request, index);
    index += 1;
    return response;
  };
  return impl as typeof fetch;
}

function newStorage(
  options: Partial<ConstructorParameters<typeof S3Storage>[0]> = {},
  signerSink?: Array<{ method: string; url: string }>,
  fetchRecord?: RecordedFetch,
): S3Storage {
  return new S3Storage({
    endpoint: "http://127.0.0.1:9000",
    region: "auto",
    bucket: "test-bucket",
    accessKeyId: "testkeyid1234",
    secretAccessKey: "0123456789abcdef0123456789abcdef",
    prefix: "prod/",
    forceR2Compat: true,
    now: FIXED_NOW,
    signerFactory: () => recordingSigner(signerSink ?? []),
    fetchImpl: fetchRecord === undefined ? undefined : recordingFetch(fetchRecord),
    ...options,
  });
}

describe("S3Storage — configuration", () => {
  it("rejects invalid config at construction (fail fast)", () => {
    for (const bad of [
      { endpoint: "not-a-url" },
      { bucket: "Bad_Bucket" },
      { bucket: "no" },
      { accessKeyId: "has space" },
      { secretAccessKey: "short" },
    ]) {
      expect(() =>
        newStorage({
          endpoint: "http://127.0.0.1:9000",
          region: "auto",
          bucket: "test-bucket",
          accessKeyId: "testkeyid1234",
          secretAccessKey: "0123456789abcdef0123456789abcdef",
          ...bad,
        }),
      ).toThrowError(/storage/i);
    }
  });

  it("requires the key prefix to end with a slash", () => {
    try {
      newStorage({ prefix: "prod" });
      expect.unreachable("prefix without trailing slash must fail");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("storage_config_invalid");
    }
  });

  it("rejects unsafe prefixes", () => {
    try {
      newStorage({ prefix: "../prod/" });
      expect.unreachable("traversal prefix must fail");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("storage_config_invalid");
    }
  });

  it("accepts a valid driver config through the shared schema", () => {
    const parsed = S3_STORAGE_OPTIONS_SCHEMA.safeParse({
      endpoint: "http://127.0.0.1:9000",
      region: "auto",
      bucket: "test-bucket",
      accessKeyId: "testkeyid1234",
      secretAccessKey: "0123456789abcdef0123456789abcdef",
      prefix: "prod/",
      forceR2Compat: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("satisfies the Storage interface structurally", () => {
    const storage: Storage = newStorage();
    expect(typeof storage.put).toBe("function");
    expect(typeof storage.list[Symbol.asyncIterator]).toBe("function");
  });
});

describe("S3Storage — put/get/delete", () => {
  it("put signs a path-style PUT with the physical prefix and Content-Type", async () => {
    const signer: Array<{ method: string; url: string }> = [];
    const record: RecordedFetch = {
      requests: [],
      respond: () => new Response(null, { status: 200 }),
    };
    const storage = newStorage({}, signer, record);
    const key = "assets/organizations/org-1/assets/ast-1/photo.png";
    const bytes = new TextEncoder().encode("asset-bytes");

    const object = await storage.put(key, bytes, { contentType: "image/png" });

    expect(signer).toHaveLength(1);
    expect(signer[0]?.method).toBe("PUT");
    expect(signer[0]?.url).toBe(
      "http://127.0.0.1:9000/test-bucket/prod/assets/organizations/org-1/assets/ast-1/photo.png",
    );
    expect(record.requests[0]?.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await record.requests[0]?.arrayBuffer?.() ?? new ArrayBuffer(0))).toEqual(bytes);
    expect(object).toEqual({
      key,
      bytes: 11,
      contentType: "image/png",
      sha256: sha256Hex(bytes),
    });
  });

  it("put rejects bad keys, bad options and checksum mismatches", async () => {
    const signer: Array<{ method: string; url: string }> = [];
    const record: RecordedFetch = { requests: [], respond: () => new Response(null, { status: 200 }) };
    const storage = newStorage({}, signer, record);
    const bytes = new TextEncoder().encode("x");
    await expectStorageErrorCode(storage.put("../escape", bytes, { contentType: "image/png" }), "storage_invalid_key");
    await expectStorageErrorCode(
      storage.put("assets/organizations/org-1/assets/ast-1", bytes, { contentType: "nope" }),
      "storage_invalid_argument",
    );
    await expectStorageErrorCode(
      storage.put("assets/organizations/org-1/assets/ast-1", bytes, {
        contentType: "image/png",
        contentSha256: sha256Hex(new TextEncoder().encode("y")),
      }),
      "storage_checksum_mismatch",
    );
    expect(record.requests).toHaveLength(0);
  });

  it("get returns bytes on 200 and null on 404", async () => {
    const record: RecordedFetch = {
      requests: [],
      respond: (request, index) =>
        index === 0
          ? new Response(new TextEncoder().encode("object-body"), { status: 200 })
          : new Response("<Error><Code>NoSuchKey</Code><Message>does not exist</Message></Error>", { status: 404 }),
    };
    const storage = newStorage({}, undefined, record);
    const key = "documents/organizations/org-1/documents/doc-1/v-1.pcraft";
    expect(new TextDecoder().decode((await storage.get(key)) ?? new Uint8Array())).toBe("object-body");
    expect(await storage.get(key)).toBeNull();
  });

  it("get maps non-2xx/404 to a retryable storage_io_error with the S3 code", async () => {
    const record: RecordedFetch = {
      requests: [],
      respond: () =>
        new Response("<Error><Code>SlowDown</Code><Message>reduce request rate</Message></Error>", { status: 503 }),
    };
    const storage = newStorage({}, undefined, record);
    const err = await expectStorageErrorCode(
      storage.get("documents/organizations/org-1/documents/doc-1/v-1.pcraft"),
      "storage_io_error",
    );
    expect(err.message).toContain("503");
    expect(err.message).toContain("SlowDown");
    expect(err.hint).toContain("reduce request rate");
    expect(err.retryable).toBe(true);
  });

  it("delete accepts 204/200/404 and fails loudly otherwise", async () => {
    for (const status of [204, 200, 404]) {
      const record: RecordedFetch = { requests: [], respond: () => new Response(null, { status }) };
      const storage = newStorage({}, undefined, record);
      await storage.delete("documents/organizations/org-1/documents/doc-1/v-1.pcraft");
    }
    const record: RecordedFetch = { requests: [], respond: () => new Response("boom", { status: 500 }) };
    const storage = newStorage({}, undefined, record);
    await expectStorageErrorCode(
      storage.delete("documents/organizations/org-1/documents/doc-1/v-1.pcraft"),
      "storage_io_error",
    );
  });
});

describe("S3Storage — list (ListObjectsV2 paging, prefix stripping)", () => {
  const PAGE_1 = [
    "<ListBucketResult>",
    "<IsTruncated>true</IsTruncated>",
    "<NextContinuationToken>tok-1/2==</NextContinuationToken>",
    "<Contents><Key>prod/assets/organizations/org-1/assets/ast-1</Key></Contents>",
    "<Contents><Key>prod/renders/organizations/org-1/documents/doc-1/preview-1024-0.png</Key></Contents>",
    "<Contents><Key>other-tenant-prefix/should-not-yield</Key></Contents>",
    "</ListBucketResult>",
  ].join("");

  const PAGE_2 = [
    "<ListBucketResult>",
    "<IsTruncated>false</IsTruncated>",
    "<Contents><Key>prod/assets/organizations/org-1/assets/ast-2</Key></Contents>",
    "</ListBucketResult>",
  ].join("");

  it("pages through continuation tokens and strips the driver prefix", async () => {
    const record: RecordedFetch = {
      requests: [],
      respond: (_request, index) => (index === 0 ? new Response(PAGE_1, { status: 200 }) : new Response(PAGE_2, { status: 200 })),
    };
    const storage = newStorage({}, undefined, record);
    const keys: string[] = [];
    for await (const key of storage.list("assets/organizations/org-1/")) {
      keys.push(key);
    }
    expect(keys).toEqual([
      "assets/organizations/org-1/assets/ast-1",
      "assets/organizations/org-1/assets/ast-2",
    ]);
    expect(record.requests).toHaveLength(2);
    const firstUrl = record.requests[0]?.url ?? "";
    expect(firstUrl.startsWith("http://127.0.0.1:9000/test-bucket?")).toBe(true);
    expect(firstUrl).toContain("list-type=2");
    expect(firstUrl).toContain("prefix=prod%2Fassets%2Forganizations%2Forg-1%2F");
    expect(record.requests[1]?.url).toContain("continuation-token=tok-1%2F2%3D%3D");
  });

  it("yields the whole tenant space for the empty prefix", async () => {
    const record: RecordedFetch = {
      requests: [],
      respond: (_request, index) => (index === 0 ? new Response(PAGE_1, { status: 200 }) : new Response(PAGE_2, { status: 200 })),
    };
    const storage = newStorage({}, undefined, record);
    const keys: string[] = [];
    for await (const key of storage.list("")) {
      keys.push(key);
    }
    expect(keys).toContain("renders/organizations/org-1/documents/doc-1/preview-1024-0.png");
    expect(keys).toContain("assets/organizations/org-1/assets/ast-1");
    expect(keys).not.toContain("other-tenant-prefix/should-not-yield");
    expect((record.requests[0]?.url ?? "").match(/prefix=prod%2F($|&)/)).not.toBeNull();
  });

  it("stops instead of looping when a page claims truncation without a token", async () => {
    const malformed = "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>prod/a</Key></Contents></ListBucketResult>";
    const record: RecordedFetch = { requests: [], respond: () => new Response(malformed, { status: 200 }) };
    const storage = newStorage({}, undefined, record);
    const keys: string[] = [];
    for await (const key of storage.list("")) {
      keys.push(key);
    }
    expect(keys).toEqual(["a"]);
    expect(record.requests).toHaveLength(1);
  });
});

describe("S3Storage — signing (driver level)", () => {
  it("sign presigns the physical key and honours the ttl/download options", async () => {
    const storage = newStorage();
    const key = expectOkKey(documentKey({ organizationId: "org-1", documentId: "doc-1", versionId: "v-42" }));
    const { url, expiresAt } = await storage.sign(key, { ttlSeconds: 900 });
    expect(url).toContain("http://127.0.0.1:9000/test-bucket/prod/documents/organizations/org-1/documents/doc-1/v-42.pcraft?");
    expect(url).toContain("X-Amz-Expires=900");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Date=20260102T030405Z");
    expect(url).not.toContain("response-content-disposition");
    expect(expiresAt).toBe(FIXED_NOW().getTime() + 900_000);

    const download = await storage.sign(key, { ttlSeconds: 60, download: true });
    expect(download.url).toContain("response-content-disposition=attachment");
  });

  it("sign caps ttlSeconds at 900 (§15.1)", async () => {
    const storage = newStorage();
    const key = expectOkKey(assetKey({ organizationId: "org-1", assetId: "ast-1" }));
    await expectStorageErrorCode(storage.sign(key, { ttlSeconds: 901 }), "storage_invalid_ttl");
    await expectStorageErrorCode(storage.sign(key, { ttlSeconds: 0 }), "storage_invalid_ttl");
  });

  it("sign rejects unsafe keys", async () => {
    const storage = newStorage();
    await expectStorageErrorCode(storage.sign("../escape", { ttlSeconds: 60 }), "storage_invalid_key");
  });
});

describe("S3Storage — optional signer guard", () => {
  it("maps signer failures to storage_driver_unavailable with the install hint", async () => {
    const record: RecordedFetch = { requests: [], respond: () => new Response(null, { status: 200 }) };
    const storage = newStorage({ signerFactory: () => {
      throw new Error("Cannot find package 'aws4fetch'");
    } }, undefined, record);
    const err = await expectStorageErrorCode(
      storage.put("assets/organizations/org-1/assets/ast-1", new Uint8Array(1), { contentType: "image/png" }),
      "storage_driver_unavailable",
    );
    expect(err.hint).toContain("aws4fetch@^1.0.20");
    expect(err.hint).toContain("STORAGE_DRIVER=local");
    expect(err.retryable).toBe(false);
  });

  it("does not cache a failed signer load (retries on the next call)", async () => {
    let failures = 0;
    const record: RecordedFetch = { requests: [], respond: () => new Response(null, { status: 200 }) };
    const storage = newStorage(
      {
        signerFactory: () => {
          if (failures === 0) {
            failures += 1;
            throw new Error("load failed once");
          }
          return recordingSigner([]);
        },
      },
      undefined,
      record,
    );
    await expectStorageErrorCode(
      storage.put("assets/organizations/org-1/assets/ast-1", new Uint8Array(1), { contentType: "image/png" }),
      "storage_driver_unavailable",
    );
    await storage.put("assets/organizations/org-1/assets/ast-1", new Uint8Array(1), { contentType: "image/png" });
    expect(record.requests).toHaveLength(1);
  });
});

describe("parseListObjectsXml", () => {
  it("extracts keys, truncation and continuation tokens", () => {
    const page = parseListObjectsXml(
      [
        "<ListBucketResult>",
        "<IsTruncated>true</IsTruncated>",
        "<NextContinuationToken>next/tok==</NextContinuationToken>",
        "<Contents><Size>10</Size><Key>a/b.png</Key></Contents>",
        "<Contents><Key>c&amp;d.png</Key></Contents>",
        "</ListBucketResult>",
      ].join(""),
    );
    expect(page.keys).toEqual(["a/b.png", "c&d.png"]);
    expect(page.isTruncated).toBe(true);
    expect(page.nextContinuationToken).toBe("next/tok==");
  });

  it("handles empty and non-truncated bodies", () => {
    const empty = parseListObjectsXml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    expect(empty).toEqual({ keys: [], isTruncated: false, nextContinuationToken: null });
  });
});
