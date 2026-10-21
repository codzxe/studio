// W10-L — zero-dep synthetic PNG generator for the §21 upload hop.
//
// "Test data: synthetic only in the repo (generated images, placeholder text)"
// (BUILD_PROMPT §21) — so no binary fixture is committed; the PNG is built
// in-test. The byte-level approach is copied from
// apps/mock-engine/src/engine.mjs `grayPng()` (CRC32 table + pngChunk() +
// 8×8 grayscale IHDR + zlib IDAT): the upload fixture is exactly the class of
// image mock-mode `doc.render` streams back, so preview/undo assertions and
// mock-engine behaviour stay in sync.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/* ---------- CRC32 (mirrors apps/mock-engine/src/engine.mjs) ---------- */
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    const table = CRC_TABLE[(c ^ buf[i]) & 0xff] ?? 0;
    c = (table ^ (c >>> 8)) >>> 0;
  }
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface TinyPngOptions {
  width?: number;
  height?: number;
  /** Grayscale pixel byte, 0x00–0xff (mock-engine uses 0x80 mid-gray). */
  fill?: number;
}

/** A tiny valid grayscale PNG, generated in memory — no deps, no fixture files. */
export function tinyPng({ width = 8, height = 8, fill = 0x80 }: TinyPngOptions = {}): Buffer {
  const ihdr = Buffer.alloc(13); // width, height, bit depth 8, color type 0 (gray)
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc(height * (width + 1), fill); // filter byte + row pixels
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Payload shape for `locator.setInputFiles()` (buffer path — no disk needed). */
export function pngUpload(name = "e2e-upload.png"): {
  name: string;
  mimeType: "image/png";
  buffer: Buffer;
} {
  return { name, mimeType: "image/png", buffer: tinyPng() };
}

/** Materialize a PNG at a real path when an `<input type=file>` requires one. */
export async function writePngFixture(
  dir = join(tmpdir(), "studio-e2e"),
  name = `fixture-${randomUUID()}.png`,
  png = tinyPng(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, png);
  return path;
}

/** PNG magic-byte check — for asserting downloaded previews/exports (§20 #9). */
export function isPng(buf: Buffer | Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}
