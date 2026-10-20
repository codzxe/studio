// @studio/storage — S3Storage: the production driver for AWS S3 and
// Cloudflare R2 (spec §3.1 `objects`; §16.5: no MinIO/Garage — AGPL).
//
// Data plane (put/get/delete/list) runs over global fetch, header-signed with
// SigV4 by the OPTIONAL `aws4fetch` package (MIT, licenses.overrides.json).
// The import is DYNAMIC with a variable specifier so the package stays truly
// optional: when it is absent at runtime every data-plane call rejects with
// the typed `storage_driver_unavailable` error + install hint; `sign()` and
// pure helpers keep working (they never touch aws4fetch). A `signerFactory`
// seam lets tests inject a fake client (deterministic, no network) and lets a
// future composition root plug a different signer.
//
// sign() presigns GET URLs with the inline zero-dep SigV4 query signer
// (drivers/sigv4.ts — canonical request unit-tested against botocore).
//
// `forceR2Compat` selects path-style addressing (bucket in the path) and is
// required for R2/SeaweedFS-style endpoints (§16.4); AWS S3 uses the default
// virtual-host style (<bucket>.<endpoint-host>). Physical keys are the tenant
// keys from keys.ts with the optional `prefix` (e.g. "prod/") prepended.

import { z } from "zod";

import { validateStorageKey, validateStoragePrefix } from "../keys.js";
import { sha256Hex } from "../sha256.js";
import {
  type PutOptions,
  type SignOptions,
  type SignedUrl,
  type Storage,
  StorageError,
  type StorageObject,
  storageErrorFromFailure,
} from "../types.js";
import {
  httpStatusError,
  keyError,
  prefixError,
  putOptionsError,
  signOptionsError,
} from "./driver-errors.js";
import { type PresignedS3Url, presignS3Get, s3ObjectUrl } from "./sigv4.js";

// ---------------------------------------------------------------------------
// Options (Zod at the boundary; config owners may reuse this schema)
// ---------------------------------------------------------------------------

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Za-z0-9]+$/;

export const S3_STORAGE_OPTIONS_SCHEMA = z.strictObject({
  /** Endpoint base URL, e.g. https://s3.us-east-1.amazonaws.com (AWS) or the R2 URL. */
  endpoint: z.string().url(),
  /** Bucket region; "auto" for R2. */
  region: z.string().min(1).max(64),
  bucket: z.string().regex(BUCKET_NAME_PATTERN, "bucket must be a valid S3 bucket name"),
  accessKeyId: z.string().min(3).regex(ACCESS_KEY_ID_PATTERN, "access key id must be alphanumeric"),
  secretAccessKey: z.string().min(8),
  /** Optional key prefix for every object, e.g. "staging/"; empty = bucket root. */
  prefix: z.string().max(512).optional(),
  /** Path-style addressing + R2-friendly settings (§16.4). */
  forceR2Compat: z.boolean().optional(),
});

export interface S3StorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly prefix?: string;
  readonly forceR2Compat?: boolean;
  /** Clock seam for sign() (deterministic tests). Defaults to real time. */
  readonly now?: () => Date;
  /** Signer seam (tests/composition root). Defaults to the aws4fetch loader below. */
  readonly signerFactory?: AwsClientFactory;
  /** fetch seam (tests). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// The optional aws4fetch signer (structural — no static import anywhere)
// ---------------------------------------------------------------------------

/** Constructor options of the aws4fetch AwsClient (the subset we use). */
export interface AwsClientOptions {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
  readonly service?: string;
}

/** Structural stand-in for RequestInfo (not a global under @types/node): url or Request. */
export type FetchInput = string | Request;

/** Structural surface of aws4fetch's AwsClient: sign(input, init?) → Request. */
export interface AwsClientLike {
  sign(input: FetchInput, init?: RequestInit): Promise<Request>;
}

/** Creates a signer; failures must reject (mapped to storage_driver_unavailable). */
export type AwsClientFactory = (
  options: AwsClientOptions,
) => AwsClientLike | Promise<AwsClientLike>;

/** Non-literal specifier keeps `aws4fetch` a true optional dependency (TS + bundlers). */
const AWS4FETCH_SPECIFIER = "aws4fetch";

async function defaultAwsClientFactory(options: AwsClientOptions): Promise<AwsClientLike> {
  let module: { AwsClient?: unknown };
  try {
    module = (await import(AWS4FETCH_SPECIFIER)) as { AwsClient?: unknown };
  } catch (err) {
    throw new StorageError(
      "storage_driver_unavailable",
      "the S3 storage driver could not load its optional request signer",
      {
        hint: "install aws4fetch@^1.0.20 (pnpm add aws4fetch) or set STORAGE_DRIVER=local",
        retryable: false,
        cause: err,
      },
    );
  }
  if (typeof module.AwsClient !== "function") {
    throw new StorageError(
      "storage_driver_unavailable",
      "the optional aws4fetch package did not export its AwsClient constructor",
      {
        hint: "pin aws4fetch@^1.0.20; presigned URLs (sign) still work without it",
        retryable: false,
      },
    );
  }
  const Ctor = module.AwsClient as new (options: AwsClientOptions) => AwsClientLike;
  return new Ctor(options);
}

// ---------------------------------------------------------------------------
// ListObjectsV2 response parsing (no XML dependency; charset-safe keys)
// ---------------------------------------------------------------------------

export interface ListObjectsPage {
  readonly keys: readonly string[];
  readonly isTruncated: boolean;
  readonly nextContinuationToken: string | null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse the keys + paging out of a ListObjectsV2 XML body. Keys produced by this
 * package's charset allowlist never need escaping, but the five basic entities
 * are decoded anyway (defense in depth).
 */
export function parseListObjectsXml(xml: string): ListObjectsPage {
  const keys: string[] = [];
  const contents = /<Contents>([\s\S]*?)<\/Contents>/g;
  for (const block of xml.matchAll(contents)) {
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block[1] ?? "");
    if (keyMatch !== null) {
      keys.push(decodeXmlEntities(keyMatch[1] ?? ""));
    }
  }
  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return {
    keys,
    isTruncated,
    nextContinuationToken: tokenMatch === null ? null : decodeXmlEntities(tokenMatch[1] ?? ""),
  };
}

function s3ErrorFromXml(xml: string): { code: string | null; message: string | null } {
  const codeMatch = /<Code>([\s\S]*?)<\/Code>/.exec(xml);
  const messageMatch = /<Message>([\s\S]*?)<\/Message>/.exec(xml);
  return {
    code: codeMatch === null ? null : decodeXmlEntities(codeMatch[1] ?? ""),
    message: messageMatch === null ? null : decodeXmlEntities(messageMatch[1] ?? ""),
  };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

const LIST_PAGE_SIZE = 1000;

interface ResolvedS3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly prefix: string;
  readonly forceR2Compat: boolean;
  readonly now: (() => Date) | undefined;
  readonly signerFactory: AwsClientFactory | undefined;
  readonly fetchImpl: typeof fetch | undefined;
}

export class S3Storage implements Storage {
  private readonly config: ResolvedS3Config;
  private signerPromise: Promise<AwsClientLike> | null = null;

  constructor(input: S3StorageOptions) {
    const parsed = S3_STORAGE_OPTIONS_SCHEMA.safeParse({
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      prefix: input.prefix,
      forceR2Compat: input.forceR2Compat,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new StorageError(
        "storage_config_invalid",
        `S3 storage driver config failed validation: ${issues}`,
      );
    }
    const prefix = parsed.data.prefix ?? "";
    if (prefix.length > 0 && !prefix.endsWith("/")) {
      throw new StorageError(
        "storage_config_invalid",
        "S3 key prefix must end with `/` (or be empty)",
        {
          hint: 'e.g. S3_PREFIX="prod/"',
        },
      );
    }
    if (prefix.length > 0) {
      const prefixCheck = validateStoragePrefix(prefix);
      if (!prefixCheck.ok) {
        throw new StorageError("storage_config_invalid", "S3 key prefix is not a safe key prefix", {
          hint: "prefix segments use alphanumerics, `.`, `_`, `-` only",
        });
      }
    }
    this.config = {
      ...parsed.data,
      prefix,
      forceR2Compat: parsed.data.forceR2Compat === true,
      now: input.now,
      signerFactory: input.signerFactory,
      fetchImpl: input.fetchImpl,
    };
  }

  // -- Storage ---------------------------------------------------------------

  async put(key: string, data: Uint8Array, options: PutOptions): Promise<StorageObject> {
    const validated = keyError(validateStorageKey(key));
    const parsed = putOptionsError(options);
    if (!(data instanceof Uint8Array)) {
      throw new StorageError("storage_invalid_argument", "put() data must be a Uint8Array");
    }
    const sha256 = sha256Hex(data);
    if (parsed.contentSha256 !== undefined && parsed.contentSha256 !== sha256) {
      throw new StorageError(
        "storage_checksum_mismatch",
        "contentSha256 does not match the bytes provided to put()",
        { hint: "re-upload the asset or fix the checksum source (§3.1 integrity)" },
      );
    }
    await this.request("PUT", key, { headers: { "Content-Type": parsed.contentType }, body: data });
    return { key: validated, bytes: data.byteLength, contentType: parsed.contentType, sha256 };
  }

  async get(key: string): Promise<Uint8Array | null> {
    keyError(validateStorageKey(key));
    const response = await this.request("GET", key);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await this.httpFailure("fetching object from object storage", response);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async delete(key: string): Promise<void> {
    keyError(validateStorageKey(key));
    const response = await this.request("DELETE", key);
    // S3 delete is idempotent: 204 (gone) and 404 (never existed) are both fine.
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw await this.httpFailure("deleting object in object storage", response);
    }
  }

  async *list(prefix: string): AsyncIterable<string> {
    const validated = prefixError(validateStoragePrefix(prefix));
    const physicalPrefix = `${this.config.prefix}${validated}`;
    const listBase = s3ObjectUrl(this.addressing(), "").replace(/\/$/, "");
    let continuationToken: string | null = null;
    do {
      const query = new URLSearchParams({
        "list-type": "2",
        "max-keys": String(LIST_PAGE_SIZE),
        prefix: physicalPrefix,
      });
      if (continuationToken !== null) {
        query.set("continuation-token", continuationToken);
      }
      const url = `${listBase}?${query.toString()}`;
      const signed = await this.signedRequest("GET", url);
      const response = await this.fetch(signed);
      if (!response.ok) {
        throw await this.httpFailure("listing objects in object storage", response);
      }
      const page = parseListObjectsXml(await response.text());
      for (const physicalKey of page.keys) {
        if (!physicalKey.startsWith(this.config.prefix)) {
          continue; // outside our prefix namespace — not ours to yield
        }
        const logical = physicalKey.slice(this.config.prefix.length);
        if (logical.startsWith(validated)) {
          yield logical;
        }
      }
      // Truncated without a token (or a malformed page): stop rather than loop forever.
      continuationToken = page.isTruncated ? page.nextContinuationToken : null;
    } while (continuationToken !== null);
  }

  async sign(key: string, options: SignOptions): Promise<SignedUrl> {
    const detail = await this.presignDetail(key, options);
    return { url: detail.url, expiresAt: detail.expiresAt };
  }

  /** The full presign detail (tests/debugging); not part of the Storage seam. */
  async presignDetail(key: string, options: SignOptions): Promise<PresignedS3Url> {
    const validated = keyError(validateStorageKey(key));
    const parsed = signOptionsError(options);
    const presigned = presignS3Get({
      endpoint: this.config.endpoint,
      region: this.config.region,
      bucket: this.config.bucket,
      key: this.physicalKey(validated),
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresInSeconds: parsed.ttlSeconds,
      download: parsed.download,
      forcePathStyle: this.config.forceR2Compat,
      now: this.config.now,
    });
    if (!presigned.ok) {
      throw storageErrorFromFailure(presigned);
    }
    return presigned.value;
  }

  // -- internals ---------------------------------------------------------------

  private addressing() {
    return {
      endpoint: this.config.endpoint,
      bucket: this.config.bucket,
      forcePathStyle: this.config.forceR2Compat,
    };
  }

  private physicalKey(key: string): string {
    return `${this.config.prefix}${key}`;
  }

  private fetch(input: FetchInput): Promise<Response> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    return fetchImpl(input);
  }

  /** Sign one object URL with the header signer and execute it. */
  private async request(
    method: string,
    key: string,
    init: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<Response> {
    const url = s3ObjectUrl(this.addressing(), this.physicalKey(key));
    const signed = await this.signedRequest(method, url, init);
    return this.fetch(signed);
  }

  private async signedRequest(
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<Request> {
    const signer = await this.loadSigner();
    return signer.sign(url, { method, headers: init.headers, body: init.body });
  }

  /** Lazily create (and cache) the header signer; failures are never cached. */
  private loadSigner(): Promise<AwsClientLike> {
    if (this.signerPromise === null) {
      const factory = this.config.signerFactory ?? defaultAwsClientFactory;
      const attempt = (async () => {
        try {
          return await factory({
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
            region: this.config.region,
            service: "s3",
          });
        } catch (err) {
          if (err instanceof StorageError) {
            throw err;
          }
          throw new StorageError(
            "storage_driver_unavailable",
            "the S3 storage driver could not initialize its request signer",
            {
              hint: "install aws4fetch@^1.0.20 (pnpm add aws4fetch) or set STORAGE_DRIVER=local",
              retryable: false,
              cause: err,
            },
          );
        }
      })();
      this.signerPromise = attempt;
      // Do not cache a failed load — a later call can retry (install, transient).
      attempt.catch(() => {
        if (this.signerPromise === attempt) {
          this.signerPromise = null;
        }
      });
    }
    return this.signerPromise;
  }

  private async httpFailure(action: string, response: Response): Promise<StorageError> {
    let s3Code: string | null = null;
    let snippet: string | null = null;
    try {
      const body = await response.text();
      const parsed = s3ErrorFromXml(body);
      s3Code = parsed.code;
      snippet = parsed.message;
    } catch {
      // body unreadable — status alone is enough for the envelope
    }
    return httpStatusError(action, response.status, s3Code, snippet);
  }
}
