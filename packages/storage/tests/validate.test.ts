// W2-O — upload validation tests. §20 acceptance criterion 2 (JPEG/PNG, 25 MB
// cap, EXIF stripped, 60 MP bomb rejected) + §15.2/§21 upload fuzzing:
// polyglot files, EXIF payloads, dimension-mismatch headers.
//
// ALL fixtures are synthetic, hand-crafted literal byte arrays (no image
// library, no binary fixtures, §21 "synthetic test data only"). The PNG CRC32
// below is an independent table-driven implementation; src uses a table-free
// bitwise one, so fixtures double as a cross-check of the parser's CRC.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_UPLOAD_MEGAPIXELS,
  type ImageMime,
  checksum,
  dimensions,
  hasExif,
  jpegDimensions,
  pngDimensions,
  sniffMime,
  stripExifPlan,
  type UploadFailure,
  validateUpload,
} from '../src/validate.js';

// ---------------------------------------------------------------------------
// Fixture helpers — PNG
// ---------------------------------------------------------------------------

/** Independent table-driven CRC-32 (zlib polynomial 0xEDB88320). */
const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: readonly number[]): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32beBytes(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** PNG chunk: length(4 BE) + type(4 ascii) + data + crc32(type+data)(4 BE). */
function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32([...typeBytes, ...data]);
  return [...u32beBytes(data.length), ...typeBytes, ...data, ...u32beBytes(crc)];
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Minimal IHDR: width, height, bitDepth 8, RGBA, 0, 0, 0. */
function ihdr(width: number, height: number): number[] {
  return chunk('IHDR', [...u32beBytes(width), ...u32beBytes(height), 8, 6, 0, 0, 0]);
}

const IDAT = chunk('IDAT', [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
const IEND = chunk('IEND', []);

/** Synthetic PNG: sig + IHDR(w×h) + stub IDAT + IEND. Dimensions are claims. */
function pngFile(width: number, height: number, opts: { extra?: number[] } = {}): Uint8Array {
  const parts = [PNG_SIG, ihdr(width, height), IDAT, opts.extra ?? [], IEND];
  return Uint8Array.from(parts.flat());
}

function toBytes(parts: readonly number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

// ---------------------------------------------------------------------------
// Fixture helpers — JPEG (tiny literal segment arrays, per ISO 10918-1 layout:
// FF <code> <len16 BE includes itself> <payload>; SOF: P(1) Y(2) X(2) Nf(1))
// ---------------------------------------------------------------------------

function seg(code: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, code, (len >>> 8) & 255, len & 255, ...payload];
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

const APP0_JFIF = seg(0xe0, [
  0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
  0x01, 0x02, 0x00, // version, units
  0x00, 0x01, 0x00, 0x01, // densities
  0x00, 0x00, // no thumbnail
]);

function app1Exif(order: 'II' | 'MM' = 'II', extra: number[] = []): number[] {
  const tiff =
    order === 'II'
      ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]
      : [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00];
  return seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff, ...extra]);
}

const APP1_XMP = seg(0xe1, [...'http://ns.adobe.com/xap/1.0/\u0000'].map((c) => c.charCodeAt(0)));

const APP2_ICC = seg(0xe2, [
  ...'ICC_PROFILE\u0000'.split('').map((c) => c.charCodeAt(0)),
  0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

const APP2_EXIF = seg(0xe2, [
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
  0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00,
]);

const APP1_BROKEN_EXIF = seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

const COM_HELLO = seg(0xfe, [...'hello'].map((c) => c.charCodeAt(0)));

const DQT = seg(0xdb, [0x00, ...Array<number>(64).fill(0x10)]);

function sof(width: number, height: number, code = 0xc0): number[] {
  return seg(code, [0x08, (height >>> 8) & 255, height & 255, (width >>> 8) & 255, width & 255, 0x01, 0x01, 0x11, 0x00]);
}

/** SOF with three FF fill bytes before the code — walks must skip padding. */
function paddedSof(width: number, height: number): number[] {
  return [0xff, 0xff, 0xff, ...sof(width, height)];
}

const SOS_TAIL = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb, ...EOI];

/** Synthetic JPEG: SOI + chosen header segments + SOF + SOS/entropy/EOI. */
function jpegFile(
  width: number,
  height: number,
  opts: {
    parts?: number[][];
    sofCode?: number;
    omitSof?: boolean;
    fill?: boolean;
  } = {},
): Uint8Array {
  const parts = [SOI, opts.parts ?? [APP0_JFIF, DQT]];
  const body = opts.fill === true ? paddedSof(width, height) : sof(width, height, opts.sofCode);
  return toBytes([...parts, ...(opts.omitSof === true ? [] : [body]), SOS_TAIL]);
}

const WEBP_FILE = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, // "RIFF" + size
  0x57, 0x45, 0x42, 0x50, // "WEBP"
  0x00, 0x00, 0x00, 0x00,
]);

const GIF_FILE = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)));
const SVG_FILE = Uint8Array.from(
  [...'<svg xmlns="http://www.w3.org/2000/svg"></svg>'].map((c) => c.charCodeAt(0)),
);

/** Deterministic PRNG (mulberry32) — fuzz rows must not depend on wall-clock. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const KNOWN_CODES = new Set([
  'unsupported_media_type',
  'upload_too_large',
  'resolution_exceeds_ceiling',
  'file_corrupt',
  'polyglot_detected',
]);

function failureOf(result: { ok: boolean }): UploadFailure {
  expect(result.ok).toBe(false);
  return result as unknown as UploadFailure;
}

// ---------------------------------------------------------------------------
// Fixtures sanity — the builders must emit spec-shaped bytes
// ---------------------------------------------------------------------------

describe('fixtures: hand-crafted PNG/JPEG bytes', () => {
  it('pngFile emits signature + IHDR(width@16, height@20, big-endian) + valid CRC', () => {
    const bytes = pngFile(1000, 500);
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIG);
    expect(bytes[8]).toBe(0); // IHDR length 13 (BE)
    expect(bytes[11]).toBe(13);
    expect([...bytes.slice(12, 16)]).toEqual([0x49, 0x48, 0x44, 0x52]); // "IHDR"
    expect(new DataView(bytes.buffer).getUint32(16, false)).toBe(1000);
    expect(new DataView(bytes.buffer).getUint32(20, false)).toBe(500);
    // CRC recomputed with the independent test implementation matches.
    expect([...bytes.slice(29, 33)]).toEqual(u32beBytes(crc32([...bytes.slice(12, 29)])));
  });

  it('jpegFile emits SOI, APP0 length 16, SOF length 11 with dims at codeAt+4/+6', () => {
    const bytes = jpegFile(1920, 1080);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xe0);
    const sofAt = bytes.indexOf(0xc0, 4);
    expect(sofAt).toBeGreaterThan(0);
    expect(bytes[sofAt - 1]).toBe(0xff);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(sofAt + 1, false)).toBe(11); // Lf
    expect(view.getUint16(sofAt + 4, false)).toBe(1080); // height
    expect(view.getUint16(sofAt + 6, false)).toBe(1920); // width
  });
});

// ---------------------------------------------------------------------------
// sniffMime — magic bytes only (§15.2)
// ---------------------------------------------------------------------------

describe('sniffMime', () => {
  it.each([
    ['PNG', pngFile(4, 4), 'image/png'],
    ['JPEG', jpegFile(4, 4), 'image/jpeg'],
    ['WEBP', WEBP_FILE, 'image/webp'],
  ])('recognises %s by magic bytes', (_name, bytes, mime) => {
    expect(sniffMime(bytes)).toEqual({ ok: true, mime });
  });

  it.each([
    ['GIF', GIF_FILE],
    ['SVG text (rejected, XSS §15.2)', SVG_FILE],
    ['empty', Uint8Array.of()],
    ['truncated PNG signature (7 bytes)', Uint8Array.from(PNG_SIG.slice(0, 7))],
    ['JPEG magic missing third FF', Uint8Array.from([0xff, 0xd8, 0x00])],
    ['RIFF without WEBP', Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])],
  ])('rejects %s with unsupported_media_type + hint', (_name, bytes) => {
    const result = sniffMime(bytes);
    const failure = failureOf(result);
    expect(failure.code).toBe('unsupported_media_type');
    expect(failure.hint).toBeDefined();
    expect(failure.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pngDimensions — IHDR parse + CRC verification
// ---------------------------------------------------------------------------

describe('pngDimensions', () => {
  it('parses width/height/megapixels from IHDR without touching pixel data', () => {
    expect(pngDimensions(pngFile(100, 50))).toEqual({
      ok: true,
      width: 100,
      height: 50,
      megapixels: 0.005,
    });
  });

  it('parses maximum 32-bit dimensions (65535×65535)', () => {
    expect(pngDimensions(pngFile(65535, 65535))).toEqual({
      ok: true,
      width: 65535,
      height: 65535,
      megapixels: 4294.836225,
    });
  });

  it.each([
    ['not a PNG (JPEG bytes)', jpegFile(4, 4), 'PNG signature missing.'],
    ['truncated before IHDR completes', pngFile(4, 4).slice(0, 20), 'truncated'],
    ['IHDR length not 13', toBytes([PNG_SIG, chunk('IHDR', [0, 0, 0, 0, 8, 6, 0, 0, 0, 0, 0, 0])]), 'IHDR length'],
    ['first chunk is not IHDR', toBytes([PNG_SIG, chunk('abcd', [0, 0, 0, 0, 8, 6, 0, 0, 0, 0, 0, 0, 0])]), 'first chunk must be IHDR'],
    ['zero width', pngFile(0, 10), 'zero'],
    ['zero height', pngFile(10, 0), 'zero'],
    ['IHDR CRC mismatch', Uint8Array.from([...toBytes([PNG_SIG, ihdr(3, 3)]).slice(0, 32), 0]), 'CRC'],
  ])('rejects %s as file_corrupt', (_name, bytes, fragment) => {
    const result = pngDimensions(bytes);
    const failure = failureOf(result);
    expect(failure.code).toBe('file_corrupt');
    expect(failure.message).toContain(fragment);
  });
});

// ---------------------------------------------------------------------------
// jpegDimensions — SOF0/SOF2 scan with FF padding
// ---------------------------------------------------------------------------

describe('jpegDimensions', () => {
  it('parses SOF0 (baseline) dimensions', () => {
    expect(jpegDimensions(jpegFile(1920, 1080))).toEqual({
      ok: true,
      width: 1920,
      height: 1080,
      megapixels: 2.0736,
    });
  });

  it('parses SOF2 (progressive) dimensions', () => {
    expect(jpegDimensions(jpegFile(640, 480, { sofCode: 0xc2 }))).toEqual({
      ok: true,
      width: 640,
      height: 480,
      megapixels: 0.3072,
    });
  });

  it('skips FF fill bytes before the SOF marker code', () => {
    expect(jpegDimensions(jpegFile(32, 16, { fill: true }))).toMatchObject({
      ok: true,
      width: 32,
      height: 16,
    });
  });

  it('skips APP0/APP1/DQT segments while scanning for SOF', () => {
    const bytes = jpegFile(128, 64, { parts: [APP0_JFIF, app1Exif(), COM_HELLO, DQT] });
    expect(jpegDimensions(bytes)).toMatchObject({ ok: true, width: 128, height: 64 });
  });

  it.each([
    ['no SOF before SOS', jpegFile(4, 4, { omitSof: true }), 'no SOF0/SOF2'],
    ['EOI before any SOF', toBytes([SOI, DQT, EOI]), 'no SOF0/SOF2'],
    ['second SOF (dimension mismatch trick)', jpegFile(4, 4, { parts: [DQT, sof(4, 4), sof(9, 9)] }), 'conflicting dimensions'],
    ['second SOI (double header)', toBytes([SOI, SOI, sof(4, 4), SOS_TAIL]), 'double header'],
    ['SOF1 only (unsupported variant)', jpegFile(4, 4, { sofCode: 0xc1 }), 'no SOF0/SOF2'],
    ['zero width in SOF', jpegFile(0, 10), 'zero'],
    ['truncated inside SOF segment', jpegFile(4, 4).slice(0, 40), 'truncated'],
    ['marker run without code at EOF', Uint8Array.from([0xff, 0xd8, 0xff, 0xff]), 'truncated'],
    ['non-marker byte where a marker is required', Uint8Array.from([0xff, 0xd8, 0x42]), 'invalid'],
  ])('rejects %s as file_corrupt', (_name, bytes, fragment) => {
    const result = jpegDimensions(bytes);
    const failure = failureOf(result);
    expect(failure.code).toBe('file_corrupt');
    expect(failure.message).toContain(fragment);
  });
});

// ---------------------------------------------------------------------------
// dimensions — dispatch
// ---------------------------------------------------------------------------

describe('dimensions dispatch', () => {
  it('dispatches by sniffed type', () => {
    expect(dimensions(pngFile(8, 8))).toMatchObject({ ok: true, width: 8, height: 8 });
    expect(dimensions(jpegFile(8, 8))).toMatchObject({ ok: true, width: 8, height: 8 });
  });

  it('WEBP is sniffable but not dimension-parsed (§20.2 surface is JPEG/PNG)', () => {
    const result = dimensions(WEBP_FILE);
    const failure = failureOf(result);
    expect(failure.code).toBe('unsupported_media_type');
  });

  it('unknown bytes fail with the sniff error', () => {
    const result = dimensions(Uint8Array.from([1, 2, 3]));
    const failure = failureOf(result);
    expect(failure.code).toBe('unsupported_media_type');
  });
});

// ---------------------------------------------------------------------------
// validateUpload — happy paths and §20.2 semantics
// ---------------------------------------------------------------------------

describe('validateUpload: acceptance (§20.2)', () => {
  it('accepts a PNG with exact parsed fields', () => {
    expect(validateUpload(pngFile(100, 50))).toEqual({
      ok: true,
      mime: 'image/png',
      width: 100,
      height: 50,
      megapixels: 0.005,
    });
  });

  it('accepts a JPEG (progressive) with exact parsed fields', () => {
    expect(validateUpload(jpegFile(1920, 1080, { sofCode: 0xc2 }))).toEqual({
      ok: true,
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
      megapixels: 2.0736,
    });
  });

  it('defaults mirror @studio/config constants (25 MB / 60 MP)', () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(DEFAULT_MAX_UPLOAD_MEGAPIXELS).toBe(60);
  });

  it('a JPEG with EXIF is ACCEPTED — §20.2 strips EXIF, never rejects it', () => {
    const bytes = jpegFile(64, 64, { parts: [APP0_JFIF, app1Exif(), DQT] });
    expect(validateUpload(bytes).ok).toBe(true);
    expect(hasExif(bytes)).toBe(true);
  });

  it('exactly 60.0 MP passes; one pixel column more is rejected', () => {
    expect(validateUpload(pngFile(8000, 7500)).ok).toBe(true); // 60,000,000 px
    const result = validateUpload(pngFile(8001, 7500));
    expect(failureOf(result).code).toBe('resolution_exceeds_ceiling');
  });
});

// ---------------------------------------------------------------------------
// validateUpload — attack table (§15.2 fuzzing / §21 Security row)
// ---------------------------------------------------------------------------

describe('validateUpload: attack table', () => {
  it.each([
    [
      'oversized vs a small cap → upload_too_large with hint: max',
      () => pngFile(4, 4),
      { maxBytes: 10 },
      'upload_too_large',
      'max 10 bytes',
    ],
    [
      'oversized at the default 25 MB cap (size checked before sniff)',
      () => new Uint8Array(DEFAULT_MAX_UPLOAD_BYTES + 1), // all-zero bytes sniff-fail
      undefined,
      'upload_too_large',
      `max ${DEFAULT_MAX_UPLOAD_BYTES} bytes`,
    ],
    [
      '61 MP PNG claimed by a 65-byte header alone (no pixel data) → bomb rejected',
      () => pngFile(8000, 7680), // 61.44 MP
      undefined,
      'resolution_exceeds_ceiling',
      'cap is 60 megapixels',
    ],
    [
      '61 MP JPEG claimed by SOF alone',
      () => jpegFile(8000, 7680),
      undefined,
      'resolution_exceeds_ceiling',
      'max 60 MP per image',
    ],
    [
      'polyglot: PNG with a JPEG appended after IEND',
      () => toBytes([pngFile(4, 4), SOI, seg(0xe0, [0]), SOS_TAIL]),
      undefined,
      'polyglot_detected',
      'polyglot',
    ],
    [
      'polyglot: PNG with a WEBP appended after IEND',
      () => toBytes([pngFile(4, 4), [...WEBP_FILE]]),
      undefined,
      'polyglot_detected',
      'polyglot',
    ],
    [
      'polyglot: double PNG headers (second file concatenated)',
      () => toBytes([pngFile(4, 4), pngFile(9, 9)]),
      undefined,
      'polyglot_detected',
      'polyglot',
    ],
    [
      'polyglot: JPEG with a PNG appended',
      () => toBytes([jpegFile(4, 4), PNG_SIG]),
      undefined,
      'polyglot_detected',
      'polyglot',
    ],
    [
      'PNG trailing junk with no image magic → corrupt, not polyglot',
      () => toBytes([pngFile(4, 4), [0x00, 0x01, 0x02]]),
      undefined,
      'file_corrupt',
      'trailing data after IEND',
    ],
    [
      'PNG truncated before IEND',
      () => pngFile(4, 4).slice(0, 53),
      undefined,
      'file_corrupt',
      'truncated before IEND',
    ],
    [
      'PNG duplicate IHDR chunk (dimension mismatch trick)',
      () => toBytes([PNG_SIG, ihdr(4, 4), ihdr(9, 9), IDAT, IEND]),
      undefined,
      'file_corrupt',
      'duplicate IHDR',
    ],
    [
      'PNG chunk claims more bytes than the file has',
      () => toBytes([PNG_SIG, ihdr(4, 4), [0xff, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54]]),
      undefined,
      'file_corrupt',
      'exceeds the file length',
    ],
    [
      'corrupt PNG header (bad CRC) reported before the megapixel ceiling',
      () => Uint8Array.from([...toBytes([PNG_SIG, ihdr(4000, 4000)]).slice(0, 32), 0, 0, 0, 0, IDAT, IEND]),
      undefined,
      'file_corrupt',
      'CRC',
    ],
    [
      'truncated JPEG SOF claiming 400 MP → corrupt (dimension parse precedes ceiling)',
      () => jpegFile(20000, 20000).slice(0, 40),
      undefined,
      'file_corrupt',
      'truncated',
    ],
    [
      'WEBP sniffed but not uploadable (§20.2 surface)',
      () => WEBP_FILE,
      undefined,
      'unsupported_media_type',
      'Only JPEG and PNG',
    ],
    [
      'SVG text rejected by sniff (§15.2 XSS)',
      () => SVG_FILE,
      undefined,
      'unsupported_media_type',
      'Only JPEG and PNG',
    ],
    [
      'empty upload rejected by sniff',
      () => Uint8Array.of(),
      undefined,
      'unsupported_media_type',
      'Only JPEG and PNG',
    ],
  ])('%s', (build, limits, code, fragment) => {
    const result = validateUpload(build(), limits);
    const failure = failureOf(result);
    expect(failure.code).toBe(code);
    expect(failure.message).toContain(fragment);
    expect(failure.retryable).toBe(false);
  });

  it('nested JPEG inside EXIF APP1 (thumbnail) is legitimate, not a polyglot', () => {
    // EXIF thumbnails legally contain FF D8 FF; the strip plan removes the whole
    // APP1, so a naive SOI scan would false-positive on ordinary photos.
    const bytes = jpegFile(32, 32, { parts: [app1Exif('II', [0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01]), DQT] });
    expect(validateUpload(bytes)).toMatchObject({ ok: true, width: 32, height: 32 });
  });

  it('planCeiling narrows the cap (§14.1 ladder)', () => {
    const fortyMp = pngFile(6400, 6250); // 40 MP — fine at 60, over a 32 MP plan cap
    const result = validateUpload(fortyMp, { planCeiling: 32 });
    const failure = failureOf(result);
    expect(failure.code).toBe('resolution_exceeds_ceiling');
    expect(failure.message).toContain('cap is 32 megapixels');
  });

  it('planCeiling above the global cap never widens it (min semantics)', () => {
    const bomb = pngFile(8000, 7680); // 61.44 MP
    const result = validateUpload(bomb, { planCeiling: 128 });
    const failure = failureOf(result);
    expect(failure.code).toBe('resolution_exceeds_ceiling');
    expect(failure.hint).toBe('max 60 MP per image');
  });

  it('throws only on nonsensical limit arguments (programmer error)', () => {
    expect(() => validateUpload(pngFile(2, 2), { maxBytes: 0 })).toThrow(Error);
    expect(() => validateUpload(pngFile(2, 2), { maxMegapixels: Number.NaN })).toThrow(Error);
    expect(() => validateUpload(pngFile(2, 2), { planCeiling: -1 })).toThrow(Error);
  });
});

// ---------------------------------------------------------------------------
// hasExif — APP1/APP2 Exif with II*/MM* byte order (§15.2 EXIF payloads)
// ---------------------------------------------------------------------------

describe('hasExif', () => {
  it.each([
    ['APP1 Exif with II* (little-endian TIFF)', jpegFile(8, 8, { parts: [app1Exif('II'), DQT] }), true],
    ['APP1 Exif with MM* (big-endian TIFF)', jpegFile(8, 8, { parts: [app1Exif('MM'), DQT] }), true],
    ['APP2 Exif segment', jpegFile(8, 8, { parts: [APP2_EXIF, DQT] }), true],
    [
      'APP1 XMP is not EXIF',
      jpegFile(8, 8, { parts: [APP1_XMP, DQT] }),
      false,
    ],
    ['APP2 ICC colour profile is not EXIF', jpegFile(8, 8, { parts: [APP2_ICC, DQT] }), false],
    ['APP1 Exif id without a valid TIFF byte order', jpegFile(8, 8, { parts: [APP1_BROKEN_EXIF, DQT] }), false],
    ['COM only', jpegFile(8, 8, { parts: [COM_HELLO, DQT] }), false],
    ['no APP segments at all', jpegFile(8, 8, { parts: [DQT] }), false],
  ])('%s → %s', (_name, bytes, expected) => {
    expect(hasExif(bytes)).toBe(expected);
  });

  it('PNG has no EXIF standard → always false', () => {
    expect(hasExif(pngFile(4, 4))).toBe(false);
    expect(hasExif(WEBP_FILE)).toBe(false);
    expect(hasExif(Uint8Array.of())).toBe(false);
    expect(hasExif(GIF_FILE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripExifPlan — pure description; the worker performs the re-slice (§15.2)
// ---------------------------------------------------------------------------

describe('stripExifPlan', () => {
  it('removes APP1-Exif and COM, keeps everything else as exact byte ranges', () => {
    // Layout (bytes): SOI [0,2) APP0 [2,20) APP1-Exif [20,40) COM [40,49)
    // DQT [49,118) SOF [118,131) SOS..EOI [131,145)
    const bytes = jpegFile(64, 64, { parts: [APP0_JFIF, app1Exif(), COM_HELLO, DQT] });
    expect(bytes.length).toBe(145);
    const plan = stripExifPlan(bytes);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.needsStrip).toBe(true);
    expect(plan.keepBytes).toEqual([
      { start: 0, end: 20 },
      { start: 49, end: 145 },
    ]);
    expect(plan.removed).toEqual([
      { marker: 'APP1', start: 20, end: 40 },
      { marker: 'COM', start: 40, end: 49 },
    ]);
  });

  it('keeps ICC APP2 colour profiles (§15.2: strip EXIF except colour profile)', () => {
    const bytes = jpegFile(64, 64, { parts: [APP2_ICC, app1Exif(), DQT] });
    const plan = stripExifPlan(bytes);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.removed).toEqual([{ marker: 'APP1', start: 22, end: 42 }]);
    expect(plan.keepBytes).toEqual([
      { start: 0, end: 22 },
      { start: 42, end: bytes.length },
    ]);
  });

  it('drops APP2-Exif segments too', () => {
    const bytes = jpegFile(64, 64, { parts: [APP2_EXIF, APP2_ICC, DQT] });
    const plan = stripExifPlan(bytes);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.removed).toEqual([{ marker: 'APP2', start: 2, end: 22 }]);
    expect(plan.needsStrip).toBe(true);
  });

  it('a clean JPEG plans a whole-file keep', () => {
    const bytes = jpegFile(64, 64);
    expect(stripExifPlan(bytes)).toEqual({
      needsStrip: false,
      keepBytes: [{ start: 0, end: bytes.length }],
      removed: [],
    });
  });

  it('PNG / WebP / unknown need no strip (PNG has no EXIF standard)', () => {
    for (const bytes of [pngFile(4, 4), WEBP_FILE, Uint8Array.of()]) {
      expect(stripExifPlan(bytes)).toEqual({
        needsStrip: false,
        keepBytes: [{ start: 0, end: bytes.byteLength }],
        removed: [],
      });
    }
  });

  it('an unwalkable JPEG header fails file_corrupt (worker must not strip it)', () => {
    const result = stripExifPlan(jpegFile(4, 4).slice(0, 30));
    const failure = failureOf(result);
    expect(failure.code).toBe('file_corrupt');
  });

  it('kept + removed ranges partition the file (non-overlapping, sorted)', () => {
    const bytes = jpegFile(64, 64, { parts: [APP0_JFIF, app1Exif('MM'), COM_HELLO, APP2_ICC, DQT] });
    const plan = stripExifPlan(bytes);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const all = [...plan.keepBytes, ...plan.removed.map((r) => ({ start: r.start, end: r.end }))]
      .sort((a, b) => a.start - b.start);
    const total = all.reduce((sum, r) => sum + (r.end - r.start), 0);
    expect(total).toBe(bytes.byteLength);
    expect(all[0]?.start).toBe(0);
    expect(all[all.length - 1]?.end).toBe(bytes.byteLength);
    for (let i = 1; i < all.length; i++) {
      expect(all[i]?.start).toBe(all[i - 1]?.end); // contiguous, no overlaps
    }
  });

  it('is pure: the input bytes are never mutated', () => {
    const bytes = jpegFile(64, 64, { parts: [app1Exif(), DQT] });
    const before = Uint8Array.from(bytes);
    stripExifPlan(bytes);
    expect([...bytes]).toEqual([...before]);
  });
});

// ---------------------------------------------------------------------------
// checksum — sha256 via node:crypto
// ---------------------------------------------------------------------------

describe('checksum', () => {
  it('matches known SHA-256 vectors', () => {
    expect(checksum(Uint8Array.of())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(checksum(Uint8Array.from([...'abc'].map((c) => c.charCodeAt(0)))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns 64 lowercase hex chars and is deterministic', () => {
    const bytes = pngFile(3, 3);
    const first = checksum(bytes);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(checksum(bytes)).toBe(first);
    expect(checksum(pngFile(3, 4))).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Fuzz — malformed input never throws and never yields an out-of-contract result
// (§21 Security: upload fuzzing — polyglots, corrupt, truncated, EXIF payloads)
// ---------------------------------------------------------------------------

describe('fuzz: random and magic-prefixed buffers', () => {
  const rand = mulberry32(0x5eed_0001);

  function randomBytes(maxSize: number): Uint8Array {
    const size = rand() % (maxSize + 1);
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = rand() % 256;
    }
    return bytes;
  }

  it('every API returns a typed result, never throws', () => {
    for (let i = 0; i < 300; i++) {
      const bytes = randomBytes(200);
      for (const bytesUnderTest of [
        bytes,
        Uint8Array.from([...PNG_SIG, ...bytes]), // PNG-magic-prefixed fuzz
        Uint8Array.from([...SOI, ...bytes]), // JPEG-magic-prefixed fuzz
      ]) {
        const sniffed = sniffMime(bytesUnderTest);
        if (sniffed.ok) {
          expect(KNOWN_MIMES.has(sniffed.mime)).toBe(true);
        } else {
          expect(KNOWN_CODES.has(sniffed.code)).toBe(true);
        }
        for (const result of [
          pngDimensions(bytesUnderTest),
          jpegDimensions(bytesUnderTest),
          dimensions(bytesUnderTest),
        ]) {
          if (result.ok) {
            expect(result.width).toBeGreaterThan(0);
            expect(result.height).toBeGreaterThan(0);
            expect(result.megapixels).toBeGreaterThanOrEqual(0);
          } else {
            expect(KNOWN_CODES.has(result.code)).toBe(true);
          }
        }
        expect(hasExif(bytesUnderTest)).toBeTypeOf('boolean');
        const plan = stripExifPlan(bytesUnderTest);
        expect(plan.ok || KNOWN_CODES.has(plan.code)).toBe(true);
        const validated = validateUpload(bytesUnderTest, { maxBytes: 4096 });
        if (validated.ok) {
          expect(validated.width).toBeGreaterThan(0);
          expect(validated.height).toBeGreaterThan(0);
          expect(validated.megapixels).toBeLessThanOrEqual(DEFAULT_MAX_UPLOAD_MEGAPIXELS);
        } else {
          expect(KNOWN_CODES.has(validated.code)).toBe(true);
          expect(validated.message).toBeTypeOf('string');
          expect(validated.retryable).toBe(false);
        }
      }
    }
  });
});

const KNOWN_MIMES = new Set<ImageMime>(['image/png', 'image/jpeg', 'image/webp']);
