// SigV4 presign tests — pure, offline. The three vectors below were constructed
// with an independent reference implementation of the AWS SigV4 query-string
// algorithm and CROSS-VALIDATED against botocore 1.42.86 (S3SigV4Auth,
// generate_presigned_url) with a frozen clock; signatures must match byte for
// byte. Credentials are the AWS documentation's public example values, not
// real secrets. Canonical-request SHA-256 lines are part of the recorded
// stringToSign, so any canonical-request drift fails the assertion.

import { describe, expect, it } from "vitest";

import {
  presignS3Get,
  s3ObjectUrl,
  s3RequestHost,
  S3_MAX_PRESIGN_TTL_SECONDS,
  type S3PresignInput,
} from "../src/drivers/sigv4.js";
import { expectErr, expectOk } from "./helpers.js";

// The AWS documentation example credential pair (public placeholder values).
const DOC_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const DOC_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const AT_2013 = () => new Date("2013-05-24T00:00:00.000Z");
const AT_2026 = () => new Date("2026-01-02T03:04:05.000Z");

// ---------------------------------------------------------------------------
// Vector 1 — AWS docs scenario: virtual-host style, us-east-1, 24 h
// ---------------------------------------------------------------------------

describe("presign vector 1 (AWS docs scenario, botocore-verified)", () => {
  const input: S3PresignInput = {
    endpoint: "https://s3.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    key: "test.txt",
    accessKeyId: DOC_ACCESS_KEY_ID,
    secretAccessKey: DOC_SECRET_ACCESS_KEY,
    expiresInSeconds: 86400,
    forcePathStyle: false,
    now: AT_2013,
  };

  const CANONICAL_REQUEST =
    "GET\n" +
    "/test.txt\n" +
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host\n" +
    "host:examplebucket.s3.amazonaws.com\n" +
    "\n" +
    "host\n" +
    "UNSIGNED-PAYLOAD";

  const STRING_TO_SIGN =
    "AWS4-HMAC-SHA256\n" +
    "20130524T000000Z\n" +
    "20130524/us-east-1/s3/aws4_request\n" +
    "3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04";

  const SIGNATURE = "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";

  const URL =
    "https://examplebucket.s3.amazonaws.com/test.txt" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
    "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
    "&X-Amz-Date=20130524T000000Z" +
    "&X-Amz-Expires=86400" +
    "&X-Amz-SignedHeaders=host" +
    `&X-Amz-Signature=${SIGNATURE}`;

  it("reproduces the canonical request byte for byte", () => {
    expect(expectOk(presignS3Get(input)).canonicalRequest).toBe(CANONICAL_REQUEST);
  });

  it("reproduces the string to sign (canonical-request hash included)", () => {
    expect(expectOk(presignS3Get(input)).stringToSign).toBe(STRING_TO_SIGN);
  });

  it("reproduces the botocore signature", () => {
    expect(expectOk(presignS3Get(input)).signature).toBe(SIGNATURE);
  });

  it("reproduces the final URL", () => {
    const result = expectOk(presignS3Get(input));
    expect(result.url).toBe(URL);
    expect(result.expiresAt).toBe(AT_2013().getTime() + 86_400_000);
    expect(result.amzDate).toBe("20130524T000000Z");
  });
});

// ---------------------------------------------------------------------------
// Vector 2 — R2-style path-style endpoint, region "auto", download disposition
// ---------------------------------------------------------------------------

describe("presign vector 2 (path-style + response-content-disposition, botocore-verified)", () => {
  const input: S3PresignInput = {
    endpoint: "http://127.0.0.1:9000",
    region: "auto",
    bucket: "test-bucket",
    key: "checkpoints/organizations/org-1/documents/doc-1/sessions/s-9/checkpoint-7.pcraft",
    accessKeyId: "testkeyid1234",
    secretAccessKey: "0123456789abcdef0123456789abcdef",
    expiresInSeconds: 900,
    download: true,
    forcePathStyle: true,
    now: AT_2026,
  };

  const CANONICAL_REQUEST =
    "GET\n" +
    "/test-bucket/checkpoints/organizations/org-1/documents/doc-1/sessions/s-9/checkpoint-7.pcraft\n" +
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=testkeyid1234%2F20260102%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260102T030405Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&response-content-disposition=attachment\n" +
    "host:127.0.0.1:9000\n" +
    "\n" +
    "host\n" +
    "UNSIGNED-PAYLOAD";

  const SIGNATURE = "2869cda70ea9309feddf2a3f9121f11352070b3f40f818e43ca954afc22cf56c";

  it("signs the disposition param inside the canonical request", () => {
    const result = expectOk(presignS3Get(input));
    expect(result.canonicalRequest).toBe(CANONICAL_REQUEST);
    expect(result.signature).toBe(SIGNATURE);
  });

  it("puts X-Amz-Signature after the sorted signed query, disposition last", () => {
    const result = expectOk(presignS3Get(input));
    expect(result.url.endsWith(`&response-content-disposition=attachment&X-Amz-Signature=${SIGNATURE}`)).toBe(true);
    expect(result.url.startsWith("http://127.0.0.1:9000/test-bucket/checkpoints/organizations/org-1/")).toBe(true);
    expect(result.expiresAt).toBe(AT_2026().getTime() + 900_000);
  });
});

// ---------------------------------------------------------------------------
// Vector 3 — virtual-host, deep tenant key, 900 s (the §15.1 ceiling)
// ---------------------------------------------------------------------------

describe("presign vector 3 (virtual-host, tenant key, botocore-verified)", () => {
  const input: S3PresignInput = {
    endpoint: "https://s3.amazonaws.com",
    region: "us-east-1",
    bucket: "assets-bucket",
    key: "exports/organizations/org-42/documents/doc-7/png-ver-9abc.png",
    accessKeyId: DOC_ACCESS_KEY_ID,
    secretAccessKey: DOC_SECRET_ACCESS_KEY,
    expiresInSeconds: 900,
    forcePathStyle: false,
    now: AT_2026,
  };

  const STRING_TO_SIGN =
    "AWS4-HMAC-SHA256\n" +
    "20260102T030405Z\n" +
    "20260102/us-east-1/s3/aws4_request\n" +
    "89d5c3323d5dcf6d1c4f5a2e4b545c647bd4e12133db56ffeb86abf27e34ea9c";

  const SIGNATURE = "825fa0748cc8b7cb4c62f5004afcad4b7caa4a6110825034e9ad06fa7bb6fd8f";

  it("matches the botocore signature for the deep key", () => {
    const result = expectOk(presignS3Get(input));
    expect(result.stringToSign).toBe(STRING_TO_SIGN);
    expect(result.signature).toBe(SIGNATURE);
    expect(result.url.startsWith("https://assets-bucket.s3.amazonaws.com/exports/organizations/org-42/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape + bounds (pure)
// ---------------------------------------------------------------------------

describe("presign shape rules", () => {
  const base: S3PresignInput = {
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    key: "test.txt",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    expiresInSeconds: 900,
    forcePathStyle: false,
    now: AT_2013,
  };

  it("signs UNSIGNED-PAYLOAD with host as the only signed header", () => {
    const result = expectOk(presignS3Get(base));
    expect(result.canonicalRequest).toContain("\nhost\nUNSIGNED-PAYLOAD");
    expect(result.url).toContain("X-Amz-SignedHeaders=host");
    expect(result.url).toContain("X-Amz-Expires=900");
  });

  it("sorts query names by code unit (X-Amz-* before lowercase params)", () => {
    const withDownload = expectOk(presignS3Get({ ...base, download: true }));
    const query = withDownload.canonicalRequest.split("\n")[2] ?? "";
    expect(query.indexOf("X-Amz-Algorithm")).toBeLessThan(query.indexOf("X-Amz-Credential"));
    expect(query.indexOf("X-Amz-Credential")).toBeLessThan(query.indexOf("X-Amz-Date"));
    expect(query.indexOf("X-Amz-Date")).toBeLessThan(query.indexOf("X-Amz-Expires"));
    expect(query.indexOf("X-Amz-Expires")).toBeLessThan(query.indexOf("X-Amz-SignedHeaders"));
    expect(query.indexOf("X-Amz-SignedHeaders")).toBeLessThan(query.indexOf("response-content-disposition"));
  });

  it("rejects expiry outside 1..604800 seconds", () => {
    expect(expectErr(presignS3Get({ ...base, expiresInSeconds: 0 })).code).toBe("storage_invalid_ttl");
    expect(expectErr(presignS3Get({ ...base, expiresInSeconds: S3_MAX_PRESIGN_TTL_SECONDS + 1 })).code).toBe(
      "storage_invalid_ttl",
    );
    expect(expectErr(presignS3Get({ ...base, expiresInSeconds: 1.5 })).code).toBe("storage_invalid_ttl");
  });

  it("changes the signature when any signed input changes", () => {
    const original = expectOk(presignS3Get(base)).signature;
    const differentKey = expectOk(presignS3Get({ ...base, key: "test2.txt" })).signature;
    const differentHost = expectOk(presignS3Get({ ...base, forcePathStyle: true })).signature;
    const differentSecret = expectOk(
      presignS3Get({ ...base, secretAccessKey: "another-secret-access-key-1" }),
    ).signature;
    expect(differentKey).not.toBe(original);
    expect(differentHost).not.toBe(original);
    expect(differentSecret).not.toBe(original);
  });
});

describe("object URL + host building", () => {
  it("virtual-host style puts the bucket in the host", () => {
    expect(
      s3ObjectUrl(
        { endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "examplebucket", forcePathStyle: false },
        "documents/organizations/org-1/documents/doc-1/v-1.pcraft",
      ),
    ).toBe("https://examplebucket.s3.us-east-1.amazonaws.com/documents/organizations/org-1/documents/doc-1/v-1.pcraft");
    expect(
      s3RequestHost({ endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "examplebucket", forcePathStyle: false }),
    ).toBe("examplebucket.s3.us-east-1.amazonaws.com");
  });

  it("path-style keeps the endpoint host (R2/compatible mode, §16.4)", () => {
    expect(
      s3ObjectUrl(
        { endpoint: "http://127.0.0.1:9000", bucket: "test-bucket", forcePathStyle: true },
        "documents/organizations/org-1/documents/doc-1/v-1.pcraft",
      ),
    ).toBe("http://127.0.0.1:9000/test-bucket/documents/organizations/org-1/documents/doc-1/v-1.pcraft");
    expect(s3RequestHost({ endpoint: "http://127.0.0.1:9000", bucket: "test-bucket", forcePathStyle: true })).toBe(
      "127.0.0.1:9000",
    );
  });

  it("builds the list base without a trailing slash", () => {
    expect(s3ObjectUrl({ endpoint: "http://127.0.0.1:9000", bucket: "test-bucket", forcePathStyle: true }, "")).toBe(
      "http://127.0.0.1:9000/test-bucket/",
    );
    expect(
      s3ObjectUrl({ endpoint: "https://s3.amazonaws.com", bucket: "examplebucket", forcePathStyle: false }, ""),
    ).toBe("https://examplebucket.s3.amazonaws.com/");
  });
});
