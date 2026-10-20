// @studio/storage — LocalFsStorage: the dev/single-box driver (node:fs/promises).
//
// Serves the same tenant-scoped key space as the S3/R2 driver (keys.ts) from a
// base directory, so local development and CI run without object storage.
// Traversal-proof by construction: every key is validated by keys.ts FIRST and
// then re-checked as a path containment (resolve + relative) before any fs
// effect — rejection, never normalization (fleet precedent, capabilities.ts).
//
// Signed URLs (§15.1: no public buckets, short-lived URLs ≤ 15 min) are
// unguessable HMAC-SHA256 query URLs: the dev gateway verifies them with the
// exported pure helper (verifyLocalSignedUrlParams) using a shared secret
// (STORAGE_SIGNING_SECRET, injected — never derived from request input):
//
//   GET <publicBaseUrl>/v1/storage/local-object?key=<urlencoded>&exp=<epoch-ms>&sig=<hex64>[&dl=1]
//   sig = HMAC-SHA256(secret, `${key}\n${exp}\n${disposition}`)   disposition = attachment|inline
//
// The signature covers key, expiry AND disposition, so `dl=1` cannot be
// stripped or added without invalidating the URL. This driver never serves the
// URL itself — signing and verifying are separated like on S3.

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { keyError, prefixError, putOptionsError, signOptionsError } from "./driver-errors.js";
import { validateStorageKey, validateStoragePrefix } from "../keys.js";
import { sha256Hex } from "../sha256.js";
import {
  StorageError,
  type PutOptions,
  type SignOptions,
  type SignedUrl,
  type Storage,
  type StorageObject,
} from "../types.js";

/** Dev-gateway route that serves local signed URLs (contract above). */
export const LOCAL_SIGNED_URL_PATH = "/v1/storage/local-object";

/** Default public base for local dev signed URLs (the local gateway). */
export const DEFAULT_LOCAL_PUBLIC_BASE_URL = "http://127.0.0.1:8787";

export interface LocalFsStorageOptions {
  /** HMAC secret for signed URLs (STORAGE_SIGNING_SECRET). Required for sign(). */
  readonly signingSecret?: string;
  /** Where signed URLs are rooted (STORAGE_PUBLIC_BASE_URL); default 127.0.0.1:8787. */
  readonly publicBaseUrl?: string;
  /** Clock seam (deterministic tests). Defaults to real time. */
  readonly now?: () => Date;
}

export type LocalDisposition = "inline" | "attachment";

/** The query params a local signed URL carries (the dev gateway reads these). */
export interface LocalSignedUrlParams {
  readonly key: string;
  readonly exp: number;
  readonly sig: string;
  readonly disposition: LocalDisposition;
}

function dispositionOf(download: boolean | undefined): LocalDisposition {
  return download === true ? "attachment" : "inline";
}

/** The exact string that is HMAC-signed — the contract the dev gateway shares. */
export function localSignaturePayload(params: LocalSignedUrlParams): string {
  return `${params.key}\n${params.exp}\n${params.disposition}`;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Timing-safe constant compare of two hex digests (lengths are checked first). */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Verify local signed-URL params for the dev gateway (pure; export for the
 * route owner + tests). Checks disposition consistency (`dl=1` ⇔ attachment),
 * the HMAC (timing-safe) and the expiry against `now`.
 */
export function verifyLocalSignedUrlParams(
  secret: string,
  params: LocalSignedUrlParams,
  now: Date,
): { readonly ok: true } | { readonly ok: false; readonly reason: "bad_signature" | "expired" } {
  const expected = hmacHex(secret, localSignaturePayload(params));
  if (!sameHex(expected, params.sig)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (params.exp <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

export class LocalFsStorage implements Storage {
  private readonly baseDir: string;
  private readonly signingSecret: string | undefined;
  private readonly publicBaseUrl: string;
  private readonly now: () => Date;

  constructor(baseDir: string, options: LocalFsStorageOptions = {}) {
    if (typeof baseDir !== "string" || baseDir.trim().length === 0) {
      throw new StorageError("storage_config_invalid", "local storage driver needs a base directory", {
        hint: "set STORAGE_LOCAL_DIR to a writable directory",
      });
    }
    this.baseDir = resolve(baseDir);
    this.signingSecret = options.signingSecret;
    this.publicBaseUrl = (options.publicBaseUrl ?? DEFAULT_LOCAL_PUBLIC_BASE_URL).replace(/\/+$/, "");
    this.now = options.now ?? (() => new Date());
  }

  async put(key: string, data: Uint8Array, options: PutOptions): Promise<StorageObject> {
    keyError(validateStorageKey(key));
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
    const target = this.resolveObjectPath(key);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    } catch (err) {
      throw ioError("writing object to local storage", err);
    }
    return { key, bytes: data.byteLength, contentType: parsed.contentType, sha256 };
  }

  async get(key: string): Promise<Uint8Array | null> {
    keyError(validateStorageKey(key));
    const target = this.resolveObjectPath(key);
    try {
      return await readFile(target);
    } catch (err) {
      const notFound = nodeErrorCode(err) === "ENOENT";
      if (notFound) {
        return null;
      }
      throw ioError("reading object from local storage", err);
    }
  }

  async delete(key: string): Promise<void> {
    keyError(validateStorageKey(key));
    const target = this.resolveObjectPath(key);
    try {
      await unlink(target);
    } catch (err) {
      const notFound = nodeErrorCode(err) === "ENOENT";
      if (!notFound) {
        throw ioError("deleting object in local storage", err);
      }
      // S3 semantics: deleting a missing object is a no-op.
    }
  }

  async *list(prefix: string): AsyncIterable<string> {
    prefixError(validateStoragePrefix(prefix));
    const { dir, relativeDir } = this.resolvePrefixDir(prefix);
    yield* this.walkDirectory(dir, relativeDir, prefix);
  }

  private async *walkDirectory(
    dir: string,
    relativeDir: string,
    prefix: string,
  ): AsyncIterable<string> {
    const entries = await readSortedEntries(dir, "listing objects in local storage");
    for (const entry of entries) {
      const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isFile()) {
        const key = this.toKey(relativePath);
        if (key.startsWith(prefix)) {
          yield key;
        }
      } else if (entry.isDirectory()) {
        yield* this.walkDirectory(resolve(dir, entry.name), relativePath, prefix);
      }
    }
  }

  async sign(key: string, options: SignOptions): Promise<SignedUrl> {
    keyError(validateStorageKey(key));
    const parsed = signOptionsError(options);
    if (this.signingSecret === undefined) {
      throw new StorageError(
        "storage_config_invalid",
        "local storage driver cannot sign URLs without a signing secret",
        { hint: "set STORAGE_SIGNING_SECRET (≥ 16 random chars) for driver=local" },
      );
    }
    const exp = this.now().getTime() + parsed.ttlSeconds * 1000;
    const disposition = dispositionOf(parsed.download);
    const sig = hmacHex(this.signingSecret, localSignaturePayload({ key, exp, sig: "", disposition }));
    const query = new URLSearchParams({ key, exp: String(exp), sig });
    if (disposition === "attachment") {
      query.set("dl", "1");
    }
    const url = `${this.publicBaseUrl}${LOCAL_SIGNED_URL_PATH}?${query.toString()}`;
    return { url, expiresAt: exp };
  }

  // -------------------------------------------------------------------------
  // Path resolution (traversal-proof: reject, never normalize)
  // -------------------------------------------------------------------------

  /** Resolve a validated key under the base dir; refuses anything that escapes. */
  private resolveObjectPath(key: string): string {
    const target = resolve(this.baseDir, ...key.split("/"));
    const rel = relative(this.baseDir, target);
    if (rel.length === 0 || rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
      throw new StorageError("storage_invalid_key", "storage key escapes the local storage base directory");
    }
    return target;
  }

  /** Resolve the directory a prefix scan starts from + its key-space-relative form. */
  private resolvePrefixDir(prefix: string): { readonly dir: string; readonly relativeDir: string } {
    const components = prefix.split("/");
    const last = components[components.length - 1] ?? "";
    const fullComponents = last.length === 0 ? components.slice(0, -1) : components.slice(0, -1);
    const dir = resolve(this.baseDir, ...fullComponents);
    const rel = relative(this.baseDir, dir);
    if (rel.startsWith("..") || resolve(rel) === rel) {
      throw new StorageError("storage_invalid_key", "storage prefix escapes the local storage base directory");
    }
    return { dir, relativeDir: fullComponents.join("/") };
  }

  private toKey(relativePath: string): string {
    return relativePath.split(sep).join("/");
  }
}

/** Read one directory, sorted by name; a missing directory lists as empty. */
async function readSortedEntries(
  dir: string,
  action: string,
): Promise<ReadonlyArray<Dirent>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (nodeErrorCode(err) === "ENOENT") {
      return [];
    }
    throw ioError(action, err);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** Map a node fs error to a typed storage error without leaking paths. */
function ioError(action: string, err: unknown): StorageError {
  const code = nodeErrorCode(err);
  return new StorageError("storage_io_error", `${action} failed${code === null ? "" : ` (node error ${code})`}`, {
    retryable: true,
    cause: err,
  });
}

function nodeErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}
