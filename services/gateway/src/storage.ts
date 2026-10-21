// @studio/gateway — object storage seam (PRODUCT_ARCHITECTURE §9.2).
//
// StorageDriver is the structural interface; drivers:
//   * S3Driver      — @aws-sdk/client-s3 against S3/R2/MinIO (env S3_ENDPOINT)
//   * LocalFSDriver — files under .local/storage/<key>, signed via unguessable
//                     tokens served by gateway routes; REJECTED in production.
//
// Object keys follow §9.2 exactly (tenant-prefixed, never exposed raw):
//   workspaces/{ws}/projects/{p}/versions/{sha256}/project.ecproj
//   workspaces/{ws}/assets/{asset_id}/{sanitized_name}
//   workspaces/{ws}/projects/{p}/renders/{render_id}/output.{ext}
//   workspaces/{ws}/thumbnails/{project_id}.webp
// `.ecproj` snapshots are content-addressed by SHA-256 (§9.2 note): the
// directory segment is the content hash, so identical bytes are stored once
// and history is never rewritten (§9.3).

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable as NodeReadable } from "node:stream";
import type { StudioEnv } from "@studio/config";

export interface ObjectMeta {
  readonly size: number | null;
  readonly contentType: string | null;
}

export interface SignedUrlOptions {
  readonly method?: "GET" | "PUT";
  readonly contentType?: string;
  readonly contentLength?: number;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
  readonly method: "GET" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
}

export interface StorageDriver {
  /** Write an object from a Buffer or a byte stream (no double buffering). */
  put(key: string, body: Buffer | ReadableStream<Uint8Array>, meta?: { contentType?: string }): Promise<void>;
  /** Object metadata or null when absent. */
  head(key: string): Promise<ObjectMeta | null>;
  /** Short-lived signed URL (5–15 min, §9.2). */
  getSignedUrl(key: string, ttlSeconds: number, options?: SignedUrlOptions): Promise<SignedUrl>;
  /** Remove an object; missing objects are not an error. */
  delete(key: string): Promise<void>;
  /** Read an object fully (local driver + small files only; null if absent). */
  read(key: string): Promise<Buffer | null>;
}

// ---------------------------------------------------------------------------
// Key layout (§9.2)
// ---------------------------------------------------------------------------

/** Reject traversal and control characters; keys are always forward-slash paths. */
export function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 1024 ||
    key.includes("..") ||
    key.includes("//") ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    /[\0\s]/.test(key)
  ) {
    throw new Error("invalid object key");
  }
}

export function snapshotKey(workspaceId: string, projectId: string, sha256: string): string {
  return `workspaces/${workspaceId}/projects/${projectId}/versions/${sha256}/project.ecproj`;
}

export function assetKey(workspaceId: string, assetId: string, sanitized: string): string {
  return `workspaces/${workspaceId}/assets/${assetId}/${sanitizeName(sanitized)}`;
}

export function renderKey(workspaceId: string, projectId: string, renderId: string, ext: string): string {
  return `workspaces/${workspaceId}/projects/${projectId}/renders/${renderId}/output.${ext}`;
}

export function thumbnailKey(workspaceId: string, projectId: string): string {
  return `workspaces/${workspaceId}/thumbnails/${projectId}.webp`;
}

/** ASCII-safe file name segment (never trust client bytes/encoding). */
export function sanitizeName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "file";
}

// ---------------------------------------------------------------------------
// LocalFS driver + token registry (signed URLs for local/dev only)
// ---------------------------------------------------------------------------

interface LocalToken {
  readonly key: string;
  readonly method: "GET" | "PUT";
  readonly expiresAt: number;
}

/** Token → object binding for LocalFSDriver signing. Unguessable, TTL-bound. */
export class LocalTokenRegistry {
  private readonly tokens = new Map<string, LocalToken>();

  issue(key: string, method: "GET" | "PUT", ttlSeconds: number): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.tokens.set(token, { key, method, expiresAt });
    return { token, expiresAt };
  }

  consume(token: string, method: "GET" | "PUT", now = Date.now()): string | null {
    const entry = this.tokens.get(token);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now || entry.method !== method) return null;
    return entry.key;
  }
}

export class LocalFSDriver implements StorageDriver {
  readonly root: string;
  private readonly registry = new LocalTokenRegistry();
  private readonly baseUrl: string;

  constructor(root: string, baseUrl: string) {
    // Resolve once; every key is re-checked against the root below.
    this.root = resolve(root);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Local signing is dev-only; the gateway rejects it in production at factory. */
  get tokens(): LocalTokenRegistry {
    return this.registry;
  }

  private path(key: string): string {
    assertSafeKey(key);
    const resolved = resolve(join(this.root, key));
    const root = this.root.endsWith("/") ? this.root : `${this.root}/`;
    if (resolved !== this.root && !resolved.startsWith(root)) {
      throw new Error("invalid object key");
    }
    return resolved;
  }

  async put(key: string, body: Buffer | ReadableStream<Uint8Array>): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await writeFile(path, body);
      return;
    }
    await pipeline(Readable.fromWeb(body as never), createWriteStream(path));
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const info = await stat(this.path(key));
      return { size: info.size, contentType: null };
    } catch {
      return null;
    }
  }

  async getSignedUrl(key: string, ttlSeconds: number, options?: SignedUrlOptions): Promise<SignedUrl> {
    assertSafeKey(key);
    const method = options?.method ?? "GET";
    const { token, expiresAt } = this.registry.issue(key, method, ttlSeconds);
    return {
      url: `${this.baseUrl}/v1/local-storage/${token}`,
      expiresAt: new Date(expiresAt),
      method,
      headers: options?.contentType ? { "Content-Type": options.contentType } : {},
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch {
      // absent objects are already "deleted"
    }
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// S3 driver (S3 / R2 / MinIO via S3_ENDPOINT)
// ---------------------------------------------------------------------------

/** The S3-relevant subset of the environment, pre-narrowed (never undefined). */
export interface S3StorageEnv {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class S3Driver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(env: { storage: S3StorageEnv }) {
    this.bucket = env.storage.bucket;
    this.client = new S3Client({
      region: env.storage.region,
      endpoint: env.storage.endpoint,
      credentials: {
        accessKeyId: env.storage.accessKeyId,
        secretAccessKey: env.storage.secretAccessKey,
      },
      // MinIO/R2 style deployments serve buckets on the path, not the host.
      forcePathStyle: true,
    });
  }

  private object(key: string): { Bucket: string; Key: string } {
    assertSafeKey(key);
    return { Bucket: this.bucket, Key: key };
  }

  async put(key: string, body: Buffer | ReadableStream<Uint8Array>, meta?: { contentType?: string }): Promise<void> {
    const nodeBody: Buffer | NodeReadable = Buffer.isBuffer(body) ? body : Readable.fromWeb(body as never);
    await this.client.send(
      new PutObjectCommand({
        ...this.object(key),
        Body: nodeBody,
        ContentType: meta?.contentType,
      }),
    );
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand(this.object(key)));
      return {
        size: out.ContentLength ?? null,
        contentType: out.ContentType ?? null,
      };
    } catch {
      return null;
    }
  }

  async getSignedUrl(key: string, ttlSeconds: number, options?: SignedUrlOptions): Promise<SignedUrl> {
    const method = options?.method ?? "GET";
    assertSafeKey(key);
    if (method === "PUT") {
      const headers: Record<string, string> = {};
      if (options?.contentType !== undefined) headers["Content-Type"] = options.contentType;
      if (options?.contentLength !== undefined) headers["Content-Length"] = String(options.contentLength);
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options?.contentType,
        ContentLength: options?.contentLength,
      });
      const url = await s3GetSignedUrl(this.client, command, { expiresIn: ttlSeconds });
      return {
        url,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        method,
        headers,
      };
    }
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await s3GetSignedUrl(this.client, command, { expiresIn: ttlSeconds });
    return {
      url,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      method,
      headers: {},
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand(this.object(key)));
  }

  async read(key: string): Promise<Buffer | null> {
    // S3 objects are fetched via signed URLs; the gateway never buffers them.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory (by env)
// ---------------------------------------------------------------------------

export interface StorageChoice {
  readonly driver: StorageDriver;
  /** Present only for the LocalFS driver (gateway routes serve the tokens). */
  readonly local: LocalFSDriver | null;
}

export function createStorage(env: StudioEnv, fsRoot?: string): StorageChoice {
  if (env.app.env === "local") {
    const root = fsRoot ?? resolve(".local/storage");
    const driver = new LocalFSDriver(root, env.app.url);
    return { driver, local: driver };
  }
  if (env.app.env === "staging" && fsRoot !== undefined) {
    // Explicit opt-in for throwaway staging without object storage.
    const driver = new LocalFSDriver(fsRoot, env.app.url);
    return { driver, local: driver };
  }
  const { endpoint, region, accessKeyId, secretAccessKey, bucket } = env.storage;
  if (
    endpoint === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    bucket === undefined
  ) {
    // Unreachable when the env cross-rules run first (config requires the S3
    // group outside local) — a defensive stop, not a user-facing path.
    throw new Error("S3 storage environment is incomplete");
  }
  return { driver: new S3Driver({ storage: { endpoint, region, accessKeyId, secretAccessKey, bucket } }), local: null };
}

/** SHA-256 helper shared by the upload routes (single-pass hashing). */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
