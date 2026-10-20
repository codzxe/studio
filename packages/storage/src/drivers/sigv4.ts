// @studio/storage — inline AWS SigV4 query-string presigning for S3/R2 GET
// objects. Zero dependencies by design (task W2-M): the data plane signs its
// headers via the OPTIONAL aws4fetch package, but presigned GET URLs — the
// §13.1 preview/export/upload surfaces, §15.1 "short-lived signed URLs ≤ 15
// min" — are produced here with plain node:crypto so the hot path has no
// optional-dependency failure mode.
//
// Algorithm: "Signature Version 4 for query requests" (SigV4 presigned URLs):
//   canonical request = METHOD \n canonical-URI \n canonical-query \n
//                       host:<host>\n \n host \n UNSIGNED-PAYLOAD
//   string to sign    = AWS4-HMAC-SHA256 \n <amzDate> \n <scope> \n hex(sha256(cr))
//   signing key       = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), "s3"), "aws4_request")
//   URL               = scheme://host<canonical-uri>?<canonical-query>&X-Amz-Signature=<hex>
//
// The canonical-query params are the X-Amz-Algorithm/Credential/Date/Expires/
// SignedHeaders set (plus response-content-disposition for downloads), sorted
// by name — exactly what the signature covers, so the FINAL URL differs from
// what some SDKs emit only in query ORDER, which is unsigned and irrelevant.
//
// Test vectors in tests/s3-sign.test.ts were cross-validated against botocore
// (S3SigV4Auth) with a frozen clock, offline.

import { createHash, createHmac } from "node:crypto";

import { storageFailure, type StorageResult } from "../types.js";

/** S3 caps presigned URLs at 7 days; the Storage seam caps them at 900 s (§15.1). */
export const S3_MAX_PRESIGN_TTL_SECONDS = 604800;

/** RFC 3986 unreserved characters stay literal; everything else is %XX-encoded. */
function uriEncode(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    if (/^[A-Za-z0-9\-_.~]$/.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** `2013-05-24T00:00:00.000Z` → `20130524T000000Z` (SigV4 amzDate form, UTC). */
function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface S3Addressing {
  /** Endpoint base URL, e.g. https://s3.us-east-1.amazonaws.com or an R2 URL. */
  readonly endpoint: string;
  /** Bucket name (S3 naming rules: 3..63, lowercase alphanumerics, dots, dashes). */
  readonly bucket: string;
  /**
   * Path-style addressing (bucket in the path) instead of virtual-host style
   * (`<bucket>.<host>`). Set for R2/SeaweedFS-style S3-compatible endpoints
   * (§16.4; MinIO/Garage are AGPL and forbidden, §16.5).
   */
  readonly forcePathStyle: boolean;
}

export interface S3PresignInput extends S3Addressing {
  /** PHYSICAL object key (driver prefix already applied), charset-safe per keys.ts. */
  readonly key: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresInSeconds: number;
  /** Adds a signed response-content-disposition=attachment (download disposition). */
  readonly download?: boolean;
  /** Clock seam (deterministic tests). Defaults to real time. */
  readonly now?: () => Date;
}

export interface PresignedS3Url {
  readonly url: string;
  /** Epoch milliseconds at which the URL stops authorizing (amzDate + expires). */
  readonly expiresAt: number;
  readonly amzDate: string;
  readonly signature: string;
  /** Exposed for tests/debugging: the exact canonical request that was signed. */
  readonly canonicalRequest: string;
  readonly stringToSign: string;
}

/** Host header value for object requests (virtual-host style prefixes the bucket). */
export function s3RequestHost(addressing: S3Addressing): string {
  const host = new URL(addressing.endpoint).host;
  return addressing.forcePathStyle ? host : `${addressing.bucket}.${host}`;
}

/** Object URL without query string (the URL presigning starts from). */
export function s3ObjectUrl(addressing: S3Addressing, key: string): string {
  const url = new URL(addressing.endpoint);
  const base = `${url.protocol}//${url.host}`.replace(/\/+$/, "");
  const path = addressing.forcePathStyle ? `/${encodePath(`${addressing.bucket}/${key}`)}` : `/${encodePath(key)}`;
  return `${base}${path}`;
}

function encodePath(path: string): string {
  return path.split("/").map(uriEncode).join("/");
}

/**
 * Presign a GET for one object. Pure: no network, no clock reads beyond `now`.
 * Caps expires at the S3 ceiling (the Storage seam separately enforces ≤ 900 s).
 */
export function presignS3Get(input: S3PresignInput): StorageResult<PresignedS3Url> {
  if (
    !Number.isInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 ||
    input.expiresInSeconds > S3_MAX_PRESIGN_TTL_SECONDS
  ) {
    return storageFailure(
      "storage_invalid_ttl",
      "presign expiry must be an integer between 1 and 604800 seconds",
    );
  }
  const now = input.now?.() ?? new Date();
  const amzDate = toAmzDate(now);
  const dateScope = amzDate.slice(0, 8);

  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${dateScope}/${input.region}/s3/aws4_request`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  if (input.download === true) {
    query.push(["response-content-disposition", "attachment"]);
  }
  query.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = query.map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`).join("&");

  const host = s3RequestHost(input);
  const canonicalUri = input.forcePathStyle
    ? `/${encodePath(`${input.bucket}/${input.key}`)}`
    : `/${encodePath(input.key)}`;
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`, // canonical headers section ends with its own newline
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const scope = `${dateScope}/${input.region}/s3/aws4_request`;
  const hashOfCanonical = createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashOfCanonical].join("\n");

  let signingKey: Uint8Array | string = `AWS4${input.secretAccessKey}`;
  for (const part of [dateScope, input.region, "s3", "aws4_request"]) {
    signingKey = createHmac("sha256", signingKey).update(part, "utf8").digest();
  }
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const base = new URL(input.endpoint);
  const url = `${base.protocol}//${base.host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return {
    ok: true,
    value: {
      url,
      expiresAt: now.getTime() + input.expiresInSeconds * 1000,
      amzDate,
      signature,
      canonicalRequest,
      stringToSign,
    },
  };
}
