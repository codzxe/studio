// @studio/storage — hex SHA-256 helper (node:crypto; sync, pure, no I/O).
// Used by both drivers: put() always records the digest in StorageObject and
// verifies caller-supplied contentSha256 (integrity at the §3.1 objects layer).

import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 digest of bytes (or a utf-8 string). */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
