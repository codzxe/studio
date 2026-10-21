// @ts-check
/**
 * png.mjs — zero-dependency PNG container writer/inspector for the eval fixture
 * generator.
 *
 * Precedent: `apps/mock-engine/src/engine.mjs` (`grayPng()`) — manual
 * IHDR/IDAT/IEND chunk construction + `node:zlib` deflate, hand-rolled CRC-32.
 * The template assets-notes (`evals/templates/<id>@<version>/assets-note.md`) mandate exactly
 * this: "any pure-Node zero-dependency writer (manual IHDR/IDAT/IEND chunks +
 * `zlib` deflate, 8-bit RGB, no interlace). Fixed filter byte 0 per scanline."
 *
 * Scope: 8-bit truecolor only — color type 2 (RGB) and 6 (RGBA) — no interlace,
 * no ancillary chunks. That is all the synthetic gradient fixtures need (§7.4),
 * and keeps the encoder auditable in one screen.
 */

import { deflateSync } from "node:zlib";

/* ---------- CRC-32 (PNG spec, same table derivation as mock-engine) ---------- */

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  return c;
});

/** @param {Buffer} buf @returns {number} unsigned 32-bit CRC of `buf` */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ -1) >>> 0;
}

/** @param {string} type 4-byte chunk type @param {Buffer} data @returns {Buffer} length + type + data + crc */
export function pngChunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode raw RGBA8888 pixels as a PNG.
 *
 * @param {object} spec
 * @param {number} spec.width  canvas width in pixels (>= 1)
 * @param {number} spec.height canvas height in pixels (>= 1)
 * @param {Buffer} spec.pixels `width * height * 4` bytes, row-major, RGBA order
 * @param {boolean} spec.hasAlpha true → color type 6 (RGBA), false → color type 2
 *                    (RGB; the alpha byte of each pixel is dropped)
 * @returns {Buffer} the complete PNG file bytes
 */
export function encodePng({ width, height, pixels, hasAlpha }) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 0x7fffffff ||
    height > 0x7fffffff
  ) {
    throw new Error(`png: invalid dimensions ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new Error(`png: pixel buffer is ${pixels.length} bytes, expected ${expected}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = hasAlpha ? 6 : 2; // color type: 6 = RGBA, 2 = RGB (assets-note: "8-bit RGB")
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  // Raw scanlines: one filter byte 0 per scanline (assets-note mandate), then
  // 3 or 4 bytes per pixel. Deterministic: same pixels in → same PNG out on a
  // given zlib build (the notes only need same-run determinism for the gate).
  const bpp = hasAlpha ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    if (hasAlpha) {
      pixels.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
    } else {
      for (let x = 0; x < width; x++) {
        const src = (y * width + x) * 4;
        const dst = rowStart + 1 + x * bpp;
        raw[dst] = pixels[src];
        raw[dst + 1] = pixels[src + 1];
        raw[dst + 2] = pixels[src + 2];
      }
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Sniff a PNG buffer's IHDR dimensions (no full decode — just the 8-byte
 * signature + first chunk header). Used by the render-golden stub to sanity
 * check engine output shape.
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }}
 * @throws {Error} when `buf` is not a PNG with an IHDR first chunk
 */
export function readPngSize(buf) {
  if (buf.length < 24 || !PNG_SIGNATURE.equals(buf.subarray(0, 8))) {
    throw new Error("png: not a PNG (bad signature)");
  }
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error("png: first chunk is not IHDR");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** @param {Buffer} buf @returns {boolean} true when `buf` starts with the PNG signature */
export function isPng(buf) {
  return buf.length >= 8 && PNG_SIGNATURE.equals(buf.subarray(0, 8));
}
