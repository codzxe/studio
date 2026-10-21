// packages/storage/tests/fuzz/corpus.mjs — W10-A.
//
// §21 Security row (upload fuzzing): polyglot files, zip bombs, EXIF payloads
// — a ZERO-DEPENDENCY in-memory attack corpus for the upload guards in
// ../../src/validate.ts (validateUpload / sniffMime / stripExifPlan).
//
// Every fixture is built programmatically as a Uint8Array: no image libraries,
// no binary files on disk (§21 "synthetic test data only", AGENTS.md "no
// installs"). The CRC-32 below is an independent table-driven implementation;
// src/validate.ts uses a table-free bitwise one, so the valid PNG fixtures
// double as a cross-check of the parser's CRC.
//
// Truth-table policy: each case pins the EXACT expected verdict of all three
// guards — `expect.sniff` (sniffed mime or "unsupported_media_type"),
// `expect.validate` ("ok" or the exact UploadErrorCode), `expect.strip`
// ("ok-keep" | "ok-strip" | "file_corrupt"). fuzz-validate.test.ts asserts
// these codes and that no guard ever throws (§1.5-4 typed envelopes only).
//
// Types for this module live in corpus.d.mts (hand-maintained mirror).

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const ASCII = new TextEncoder();

function ascii(text) {
  return ASCII.encode(text);
}

function bytes(...values) {
  return Uint8Array.from(values);
}

function be16(value) {
  return bytes((value >>> 8) & 0xff, value & 0xff);
}

function be32(value) {
  return bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function le16(value) {
  return bytes(value & 0xff, (value >>> 8) & 0xff);
}

function le32(value) {
  return bytes(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(...parts) {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `n` zero bytes — the classic highly-compressible bomb payload. */
function zeros(n) {
  return new Uint8Array(n);
}

// ---------------------------------------------------------------------------
// Independent CRC-32 (zlib polynomial 0xEDB88320, table-driven)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffff_ffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG builders (signature + IHDR + optional middle chunks + IDAT + IEND)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type, data, { corruptCrc = false } = {}) {
  const body = concat(ascii(type), data);
  let crc = crc32(body);
  if (corruptCrc) {
    crc = (crc ^ 0x0000_0001) >>> 0; // single-bit flip — parser must notice
  }
  return concat(be32(data.length), body, be32(crc));
}

function ihdr(width, height, { corruptCrc = false } = {}) {
  // 13-byte IHDR data: width, height, bit depth 8, colour type 6, then zeros.
  return pngChunk("IHDR", concat(be32(width), be32(height), bytes(8, 6, 0, 0, 0)), {
    corruptCrc,
  });
}

function pngFile({
  width,
  height,
  idat = bytes(0xde, 0xad, 0xbe, 0xef),
  middleChunks = [],
  appendAfterIend = zeros(0),
  corruptIhdrCrc = false,
}) {
  return concat(
    PNG_SIGNATURE,
    ihdr(width, height, { corruptCrc: corruptIhdrCrc }),
    ...middleChunks,
    pngChunk("IDAT", idat),
    pngChunk("IEND", zeros(0)),
    appendAfterIend,
  );
}

/** A PNG chunk whose LENGTH field lies (claims far more data than exists). */
function pngChunkWithLyingLength(type, claimedLength, actualData) {
  return concat(be32(claimedLength), ascii(type), actualData, bytes(0xde, 0xad, 0xbe, 0xef));
}

// ---------------------------------------------------------------------------
// JPEG builders (SOI + header segments + SOF0 + SOS + entropy + EOI)
// ---------------------------------------------------------------------------

const JPEG_SOI = bytes(0xff, 0xd8);
const JPEG_EOI = bytes(0xff, 0xd9);
const JPEG_SOS = bytes(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
const JPEG_ENTROPY = bytes(0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc); // FF-free scan data

/** `FF <marker> <len> <payload>`; len counts itself (2 bytes). */
function jpegSegment(marker, payload) {
  return concat(bytes(0xff, marker), be16(payload.length + 2), payload);
}

function jfifApp0() {
  return jpegSegment(
    0xe0,
    concat(ascii("JFIF\0"), bytes(0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00)),
  );
}

/** Baseline SOF0, one component. Lf = 8 + 3×Nf = 11. */
function sof0(width, height) {
  return jpegSegment(
    0xc0,
    concat(bytes(0x08), be16(height), be16(width), bytes(0x01, 0x01, 0x11, 0x00)),
  );
}

function com(text) {
  return jpegSegment(0xfe, ascii(text));
}

function jpegFile({
  width,
  height,
  headerSegments = [],
  entropy = JPEG_ENTROPY,
  append = zeros(0),
}) {
  return concat(
    JPEG_SOI,
    ...headerSegments,
    sof0(width, height),
    JPEG_SOS,
    entropy,
    JPEG_EOI,
    append,
  );
}

// ---------------------------------------------------------------------------
// EXIF builders — APP1 "Exif\0\0" + TIFF (II/MM) with GPS block + thumbnail
// ---------------------------------------------------------------------------

/** A tiny embedded JPEG (nested SOI is legal inside APP1 — §21 EXIF payloads). */
function thumbnailJpeg() {
  return concat(JPEG_SOI, jfifApp0(), JPEG_EOI);
}

/**
 * APP1 EXIF payload with an IFD0 (Make + GPS IFD pointer) and a GPS IFD
 * (ASCII GPSLatitude) followed by an embedded thumbnail JPEG. IFD offsets are
 * patched after assembly so the TIFF structure is honestly consistent.
 */
function exifApp1Payload() {
  const parts = [];
  let len = 0;
  const push = (part) => {
    parts.push(part);
    len += part.length;
  };
  push(ascii("II*\0")); // TIFF byte order, little-endian
  push(le32(8)); // IFD0 offset (right after the 8-byte TIFF header)
  const ifd0At = len;
  push(le16(2)); // IFD0 entry count
  const makeEntryAt = len;
  push(le16(0x010f)); // Make, type 2 (ASCII)
  push(le16(2));
  push(le32(8)); // "FUZZCAM\0"
  push(le32(0)); // value offset — patched below
  const gpsEntryAt = len;
  push(le16(0x8825)); // GPSInfo IFD pointer, type 4 (LONG)
  push(le16(4));
  push(le32(1));
  push(le32(0)); // GPS IFD offset — patched below
  push(le32(0)); // no next IFD
  const makeAt = len;
  push(ascii("FUZZCAM\0"));
  const gpsAt = len;
  push(le16(1)); // GPS IFD entry count
  push(le16(0x0002)); // GPSLatitude, type 2 (ASCII)
  push(le16(2));
  push(le32(12));
  push(le32(0)); // ASCII offset — patched below
  push(le32(0)); // no next IFD
  push(ascii("37/1,46/1,0\0")); // plausible GPS latitude
  push(thumbnailJpeg());
  const tiff = concat(...parts);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  // Patch the three offset fields now that all parts have known positions:
  view.setUint32(makeEntryAt + 8, makeAt, true); // Make value offset
  view.setUint32(gpsEntryAt + 8, gpsAt, true); // GPS IFD offset
  view.setUint32(gpsAt + 2 + 8, gpsAt + 2 + 12 + 4, true); // GPSLatitude ASCII offset
  return concat(ascii("Exif\0\0"), tiff);
}

/** Minimal valid EXIF APP1 (one IFD0 entry) in either byte order. */
function minimalExifApp1(endian) {
  const big = endian === "MM";
  const order = big ? ascii("MM\0*") : ascii("II*\0");
  const u16 = big ? be16 : le16;
  const u32 = big ? be32 : le32;
  const ifd0 = concat(
    u16(1), // one entry
    u16(0x010f), // Make, ASCII
    u16(2),
    u32(4), // four bytes, stored inline
    ascii("FUZZ"),
    u32(0), // no next IFD
  );
  return jpegSegment(0xe1, concat(ascii("Exif\0\0"), order, u32(8), ifd0));
}

/** XMP APP1 (Adobe namespace — NOT EXIF; must survive the strip plan). */
function xmpApp1() {
  return jpegSegment(
    0xe1,
    concat(
      ascii("http://ns.adobe.com/xap/1.0/\0"),
      ascii('<?x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:FUZ/></x:xmpmeta>'),
    ),
  );
}

/** ICC colour-profile APP2 (must survive — §15.2 keep colour profiles). */
function iccApp2() {
  return jpegSegment(
    0xe2,
    concat(ascii("ICC_PROFILE\0"), bytes(0x01, 0x01), ascii("mntrRGB 1998-fuzz")),
  );
}

/** APP1 that hides a full PNG signature inside an EXIF-tagged payload. */
function exifApp1HidingPng() {
  return jpegSegment(
    0xe1,
    concat(ascii("Exif\0\0"), ascii("II*\0"), le32(8), PNG_SIGNATURE, bytes(0)),
  );
}

// ---------------------------------------------------------------------------
// WebP / other magics
// ---------------------------------------------------------------------------

function webpFile() {
  const vp8 = ascii("VP8 ");
  return concat(ascii("RIFF"), be32(vp8.length), ascii("WEBP"), vp8);
}

// ---------------------------------------------------------------------------
// Seeded PRNG (xorshift32) + deterministic mutation
// ---------------------------------------------------------------------------

function xorshift32(seed) {
  let state = seed >>> 0;
  if (state === 0) {
    state = 0x1357_2461;
  }
  return () => {
    let x = state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    state = x;
    return x >>> 0;
  };
}

function seededNoise(length, seed) {
  const next = xorshift32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = next() % 256;
  }
  return out;
}

/**
 * Deterministic single-fixture mutator for the never-a-crash sweep: byte
 * flips, window scribbles, truncation, insertion, zeroing. Same (bytes, seed)
 * always yields the same mutant — tests stay reproducible (AGENTS.md: tests
 * are deterministic, no flakiness).
 */
export function mutatedCopy(bytesInput, seed) {
  const next = xorshift32(seed >>> 0);
  const pick = (mod) => next() % mod;
  let out = bytesInput.slice();
  const ops = 1 + pick(3);
  for (let i = 0; i < ops; i++) {
    const op = pick(5);
    if (op === 0 && out.length > 0) {
      out[pick(out.length)] = pick(256);
    } else if (op === 1 && out.length > 3) {
      for (let k = 0; k < 4; k++) {
        out[pick(out.length)] = pick(256);
      }
    } else if (op === 2) {
      out = out.subarray(0, pick(out.length + 1));
    } else if (op === 3 && out.length > 0) {
      const at = pick(out.length);
      const inserted = new Uint8Array(1 + pick(16));
      for (let k = 0; k < inserted.length; k++) {
        inserted[k] = pick(256);
      }
      const grown = new Uint8Array(out.length + inserted.length);
      grown.set(out.subarray(0, at), 0);
      grown.set(inserted, at);
      grown.set(out.subarray(at), at + inserted.length);
      out = grown;
    } else if (out.length >= 8) {
      const at = pick(out.length - 7);
      out.fill(0, at, at + 8);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The corpus (§21 truth table)
// ---------------------------------------------------------------------------

const PNG_1x1 = pngFile({ width: 1, height: 1 });

export const CORPUS = [
  // ----- polyglot files (§21) -------------------------------------------
  {
    id: "polyglot/png-header-jpeg-trailer",
    category: "polyglot",
    threat: "PNG parse clean, then a whole JPEG is bolted on after IEND",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "vacation.png",
    bytes: pngFile({
      width: 4,
      height: 4,
      appendAfterIend: concat(JPEG_SOI, jfifApp0(), JPEG_EOI),
    }),
    expect: { sniff: "image/png", validate: "polyglot_detected", strip: "ok-keep" },
  },
  {
    id: "polyglot/png-header-webp-trailer",
    category: "polyglot",
    threat: "second strong-format (RIFF/WEBP) appended after IEND",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "vacation.png",
    bytes: pngFile({ width: 4, height: 4, appendAfterIend: webpFile() }),
    expect: { sniff: "image/png", validate: "polyglot_detected", strip: "ok-keep" },
  },
  {
    id: "polyglot/jpeg-double-soi",
    category: "polyglot",
    threat: "double SOI header — the classic double-header polyglot trick",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "IMG_0001.JPG",
    bytes: concat(JPEG_SOI, JPEG_SOI, jfifApp0(), sof0(4, 4), JPEG_SOS, JPEG_ENTROPY, JPEG_EOI),
    expect: { sniff: "image/jpeg", validate: "file_corrupt", strip: "file_corrupt" },
  },
  {
    id: "polyglot/jpeg-exif-png-stowaway",
    category: "polyglot",
    threat: "EXIF-tagged APP1 whose payload smuggles a full PNG signature",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "IMG_0002.JPG",
    bytes: jpegFile({ width: 4, height: 4, headerSegments: [exifApp1HidingPng()] }),
    expect: {
      sniff: "image/jpeg",
      validate: "polyglot_detected",
      strip: "ok-strip",
      hasExif: true,
      stripRemoved: ["APP1"],
      probes: [{ needle: "Exif", survives: false }],
    },
  },
  {
    id: "polyglot/jpeg-png-file-after-eoi",
    category: "polyglot",
    threat: "PNG-after-JPEG: an entire PNG file appended after the JPEG EOI",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "IMG_0003.JPG",
    bytes: jpegFile({
      width: 2,
      height: 2,
      headerSegments: [jfifApp0()],
      append: pngFile({ width: 2, height: 2 }),
    }),
    expect: { sniff: "image/jpeg", validate: "polyglot_detected", strip: "ok-keep" },
  },

  // ----- zip bombs as image claims (§21 + §20.2) -------------------------
  {
    id: "zip-bomb/png-61mp-claim-1kb-payload",
    category: "zip-bomb",
    threat: "IHDR claims 10000×6100 (61 MP) on a 1 KB zero IDAT — the decompression bomb is rejected from the header claim alone, nothing is ever inflated",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "totally-a-photo.png",
    bytes: pngFile({ width: 10000, height: 6100, idat: zeros(1000) }),
    expect: { sniff: "image/png", validate: "resolution_exceeds_ceiling", strip: "ok-keep" },
  },
  {
    id: "zip-bomb/jpeg-61mp-claim",
    category: "zip-bomb",
    threat: "SOF0 claims 8000×7625 (61 MP) — JPEG variant of the megapixel bomb",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "totally-a-photo.jpg",
    bytes: jpegFile({ width: 8000, height: 7625, headerSegments: [jfifApp0()] }),
    expect: { sniff: "image/jpeg", validate: "resolution_exceeds_ceiling", strip: "ok-keep" },
  },
  {
    id: "zip-bomb/png-60mp-claim-1kb-payload-inert",
    category: "zip-bomb",
    threat: "exactly 60 MP claimed on a 1 KB payload — inert-header rule: the validator parses headers only (never inflates), so an at-cap claim passes and decode safety is the worker's job",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "sixty-megapixels.png",
    bytes: pngFile({ width: 8000, height: 7500, idat: zeros(1000) }),
    expect: {
      sniff: "image/png",
      validate: "ok",
      strip: "ok-keep",
      dims: { width: 8000, height: 7500 },
    },
  },
  {
    id: "zip-bomb/jpeg-just-over-60mp",
    category: "zip-bomb",
    threat: "8000×7501 (60.008 MP) — one pixel over the inclusive 60 MP boundary",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "just-over.jpg",
    bytes: jpegFile({ width: 8000, height: 7501, headerSegments: [jfifApp0()] }),
    expect: { sniff: "image/jpeg", validate: "resolution_exceeds_ceiling", strip: "ok-keep" },
  },

  // ----- EXIF payloads (§21) ---------------------------------------------
  {
    id: "exif/app1-gps-thumbnail-and-comment",
    category: "exif-payload",
    threat: "APP1 EXIF with IFD0 + GPS block + embedded thumbnail JPEG plus a scripted COM segment — upload must be ACCEPTED (§20.2: stripped downstream, never rejected) and the strip plan must drop APP1+COM without growing the file",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "phone-photo.jpg",
    bytes: jpegFile({
      width: 4,
      height: 4,
      headerSegments: [jpegSegment(0xe1, exifApp1Payload()), com("<script>alert(1)</script>")],
    }),
    expect: {
      sniff: "image/jpeg",
      validate: "ok",
      strip: "ok-strip",
      hasExif: true,
      stripRemoved: ["APP1", "COM"],
      probes: [{ needle: "FUZZCAM", survives: false }],
    },
  },
  {
    id: "exif/xmp-and-icc-survive-strip",
    category: "exif-payload",
    threat: "XMP APP1 + ICC APP2 + COM: only the comment may be dropped — §15.2 keep colour profiles",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "profiled.jpg",
    bytes: jpegFile({
      width: 4,
      height: 4,
      headerSegments: [xmpApp1(), iccApp2(), com("track")],
    }),
    expect: {
      sniff: "image/jpeg",
      validate: "ok",
      strip: "ok-strip",
      hasExif: false,
      stripRemoved: ["COM"],
      probes: [
        { needle: "xmpmeta", survives: true },
        { needle: "ICC_PROFILE", survives: true },
      ],
    },
  },
  {
    id: "exif/dual-app1-little-and-big-endian",
    category: "exif-payload",
    threat: "two EXIF APP1 segments (II and MM byte order) + COM — all three metadata segments removed by one plan",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "dual-exif.jpg",
    bytes: jpegFile({
      width: 4,
      height: 4,
      headerSegments: [minimalExifApp1("II"), minimalExifApp1("MM"), com("x")],
    }),
    expect: {
      sniff: "image/jpeg",
      validate: "ok",
      strip: "ok-strip",
      hasExif: true,
      stripRemoved: ["APP1", "APP1", "COM"],
      probes: [{ needle: "Exif", survives: false }],
    },
  },
  {
    id: "exif/comment-only-strip",
    category: "exif-payload",
    threat: "COM-only metadata: strip plan drops the comment, detector reports no EXIF",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "commented.jpg",
    bytes: jpegFile({ width: 4, height: 4, headerSegments: [com("fuzz comment")] }),
    expect: {
      sniff: "image/jpeg",
      validate: "ok",
      strip: "ok-strip",
      hasExif: false,
      stripRemoved: ["COM"],
    },
  },

  // ----- corrupt chunks / structure (§21 + §20.2) ------------------------
  {
    id: "corrupt/png-ihdr-bad-crc",
    category: "corrupt",
    threat: "IHDR CRC has one flipped bit — dimension claims must not be trusted from a broken header",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "bad-crc.png",
    bytes: pngFile({ width: 4, height: 4, corruptIhdrCrc: true }),
    expect: { sniff: "image/png", validate: "file_corrupt", strip: "ok-keep" },
  },
  {
    id: "corrupt/png-ihdr-truncated",
    category: "corrupt",
    threat: "file cut off inside the IHDR chunk (18 bytes total)",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "truncated.png",
    bytes: concat(PNG_SIGNATURE, be32(13), ascii("IHDR"), be32(4), be16(4)),
    expect: { sniff: "image/png", validate: "file_corrupt", strip: "ok-keep" },
  },
  {
    id: "corrupt/png-chunk-overrun",
    category: "corrupt",
    threat: "IDAT length field claims 1000 bytes but only 4 exist — chunk exceeds the file",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "overrun.png",
    bytes: concat(
      PNG_SIGNATURE,
      ihdr(4, 4),
      pngChunkWithLyingLength("IDAT", 1000, bytes(0xde, 0xad, 0xbe, 0xef)),
      pngChunk("IEND", zeros(0)),
    ),
    expect: { sniff: "image/png", validate: "file_corrupt", strip: "ok-keep" },
  },
  {
    id: "corrupt/png-duplicate-ihdr",
    category: "corrupt",
    threat: "a second IHDR with different dimensions — dimension-mismatch trick",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "two-headers.png",
    bytes: pngFile({ width: 4, height: 4, middleChunks: [ihdr(9, 9)] }),
    expect: { sniff: "image/png", validate: "file_corrupt", strip: "ok-keep" },
  },
  {
    id: "corrupt/png-junk-after-iend",
    category: "corrupt",
    threat: "non-image garbage ('hello') after IEND — structurally invalid, not a polyglot",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "trailing.png",
    bytes: pngFile({ width: 4, height: 4, appendAfterIend: ascii("hello") }),
    expect: { sniff: "image/png", validate: "file_corrupt", strip: "ok-keep" },
  },
  {
    id: "corrupt/png-zero-dimensions",
    category: "corrupt",
    threat: "IHDR claims width 0 — degenerate dimension must not reach the ledger",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "zero-width.png",
    bytes: pngFile({ width: 0, height: 4 }),
    expect: { sniff: "image/png", validate: "file_corrupt", strip: "ok-keep" },
  },
  {
    id: "corrupt/jpeg-app0-bad-length",
    category: "corrupt",
    threat: "APP0 length field is 1 (impossible — segment lengths count themselves)",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "bad-length.jpg",
    bytes: concat(
      JPEG_SOI,
      bytes(0xff, 0xe0, 0x00, 0x01, 0x00),
      sof0(4, 4),
      JPEG_SOS,
      JPEG_ENTROPY,
      JPEG_EOI,
    ),
    expect: { sniff: "image/jpeg", validate: "file_corrupt", strip: "file_corrupt" },
  },
  {
    id: "corrupt/jpeg-no-sof",
    category: "corrupt",
    threat: "header ends at SOS with no SOF frame — dimensions cannot be established",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "no-frame.jpg",
    bytes: concat(JPEG_SOI, jfifApp0(), JPEG_SOS, JPEG_ENTROPY, JPEG_EOI),
    expect: { sniff: "image/jpeg", validate: "file_corrupt", strip: "ok-keep" },
  },
  {
    id: "corrupt/jpeg-truncated-mid-sof",
    category: "corrupt",
    threat: "file cut off two bytes into the SOF0 marker",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "cut.jpg",
    bytes: bytes(0xff, 0xd8, 0xff, 0xc0, 0x00),
    expect: { sniff: "image/jpeg", validate: "file_corrupt", strip: "file_corrupt" },
  },
  {
    id: "corrupt/jpeg-desync-marker-expected",
    category: "corrupt",
    threat: "ASCII garbage where a JPEG marker must appear (structure desync)",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "desync.jpg",
    bytes: concat(
      JPEG_SOI,
      jfifApp0(),
      ascii("GARBAGE!"),
      sof0(4, 4),
      JPEG_SOS,
      JPEG_ENTROPY,
      JPEG_EOI,
    ),
    expect: { sniff: "image/jpeg", validate: "file_corrupt", strip: "file_corrupt" },
  },
  {
    id: "corrupt/jpeg-second-sof",
    category: "corrupt",
    threat: "two SOF0 frames with conflicting dimensions — the dimension-mismatch trick on JPEG",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "two-frames.jpg",
    bytes: concat(
      JPEG_SOI,
      jfifApp0(),
      sof0(4, 4),
      sof0(16, 16),
      JPEG_SOS,
      JPEG_ENTROPY,
      JPEG_EOI,
    ),
    expect: { sniff: "image/jpeg", validate: "file_corrupt", strip: "file_corrupt" },
  },

  // ----- unsupported magics (§15.2 sniff, §21 XSS note) -------------------
  {
    id: "unsupported/svg-with-inline-script",
    category: "unsupported",
    threat: "SVG with inline script — must never be sniffable (§15.2 XSS note: only sanitised SVG may be accepted, never via this path)",
    claimedExt: ".svg",
    claimedMime: "image/svg+xml",
    filename: "logo.svg",
    bytes: ascii(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
        '<script>alert(document.domain)</script><rect width="4" height="4"/></svg>',
    ),
    expect: {
      sniff: "unsupported_media_type",
      validate: "unsupported_media_type",
      strip: "ok-keep",
    },
  },
  {
    id: "unsupported/gif89a-renamed-png",
    category: "unsupported",
    threat: "GIF89a magic with a lying .png extension and Content-Type",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "avatar.png",
    bytes: concat(ascii("GIF89a"), bytes(0x04, 0x00, 0x04, 0x00, 0x80, 0x00, 0x00)),
    expect: {
      sniff: "unsupported_media_type",
      validate: "unsupported_media_type",
      strip: "ok-keep",
    },
  },
  {
    id: "unsupported/zip-pk-renamed-png",
    category: "unsupported",
    threat: "ZIP container (PK\\x03\\x04) renamed to .png — archive bomb hoping to be re-served as an image",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "archive.png",
    bytes: concat(ascii("PK"), bytes(0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00)),
    expect: {
      sniff: "unsupported_media_type",
      validate: "unsupported_media_type",
      strip: "ok-keep",
    },
  },
  {
    id: "unsupported/mz-exe-renamed-jpg",
    category: "unsupported",
    threat: "PE executable (MZ) renamed to .jpg",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "photo.jpg",
    bytes: bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00),
    expect: {
      sniff: "unsupported_media_type",
      validate: "unsupported_media_type",
      strip: "ok-keep",
    },
  },

  // ----- renamed claims vs magic mismatch (§15.2 sniff never trusts) ------
  {
    id: "mislabeled/png-bytes-jpg-claim",
    category: "mislabeled",
    threat: "valid PNG whose client claims image/jpeg — the sniffed magic must win",
    claimedExt: ".jpg",
    claimedMime: "image/jpeg",
    filename: "actually-a-png.jpg",
    bytes: PNG_1x1,
    expect: { sniff: "image/png", validate: "ok", strip: "ok-keep" },
  },
  {
    id: "mislabeled/jpeg-bytes-png-claim",
    category: "mislabeled",
    threat: "valid JPEG whose client claims image/png — the sniffed magic must win",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "actually-a-jpeg.png",
    bytes: jpegFile({ width: 2, height: 2, headerSegments: [jfifApp0()] }),
    expect: { sniff: "image/jpeg", validate: "ok", strip: "ok-keep" },
  },
  {
    id: "mislabeled/webp-outside-upload-surface",
    category: "mislabeled",
    threat: "well-formed WebP — recognised by the sniffer but outside the §20.2 JPEG/PNG upload surface",
    claimedExt: ".webp",
    claimedMime: "image/webp",
    filename: "modern.webp",
    bytes: webpFile(),
    expect: { sniff: "image/webp", validate: "unsupported_media_type", strip: "ok-keep" },
  },

  // ----- filename payloads (bytes clean; policy is a gateway concern —
  // validate.ts is deliberately bytes-only, §15.2. See README "Deferred".)
  {
    id: "filename/traversal-climb",
    category: "filename",
    threat: "path traversal filename on an otherwise valid image (../../x.png family)",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "../../../etc/passwd.png",
    bytes: PNG_1x1,
    expect: { sniff: "image/png", validate: "ok", strip: "ok-keep" },
  },
  {
    id: "filename/null-byte-split",
    category: "filename",
    threat: "NUL byte inside the filename — splits extension and confuses naive parsers",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "evil\0.png",
    bytes: PNG_1x1,
    expect: { sniff: "image/png", validate: "ok", strip: "ok-keep" },
  },
  {
    id: "filename/ten-kilobyte-name",
    category: "filename",
    threat: "10 KB filename — header/DB overflow at layers that store names verbatim",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "a".repeat(10_000) + ".png",
    bytes: PNG_1x1,
    expect: { sniff: "image/png", validate: "ok", strip: "ok-keep" },
  },
  {
    id: "filename/rtlo-spoof",
    category: "filename",
    threat: "right-to-left-override in the filename flips the visible extension",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "invoice\u202Egnp.png",
    bytes: PNG_1x1,
    expect: { sniff: "image/png", validate: "ok", strip: "ok-keep" },
  },

  // ----- degenerate buffers ---------------------------------------------
  {
    id: "degenerate/empty-buffer",
    category: "degenerate",
    threat: "zero-byte upload",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "empty.png",
    bytes: zeros(0),
    expect: {
      sniff: "unsupported_media_type",
      validate: "unsupported_media_type",
      strip: "ok-keep",
    },
  },
  {
    id: "degenerate/all-null-bytes",
    category: "degenerate",
    threat: "64 NUL bytes — no magic anywhere",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "nulls.png",
    bytes: zeros(64),
    expect: {
      sniff: "unsupported_media_type",
      validate: "unsupported_media_type",
      strip: "ok-keep",
    },
  },
  {
    id: "degenerate/seeded-noise",
    category: "degenerate",
    threat: "256 bytes of deterministic pseudo-random noise with a non-magic prefix",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "noise.png",
    bytes: (() => {
      const noise = seededNoise(256, 0x5eed_1234);
      noise[0] = 0x78;
      noise[1] = 0x79;
      return noise;
    })(),
    expect: {
      sniff: "unsupported_media_type",
      validate: "unsupported_media_type",
      strip: "ok-keep",
    },
  },
  {
    id: "degenerate/over-25mb-cap",
    category: "degenerate",
    threat: "25 MB cap + 1 byte, PNG-prefixed — pins the check order: the size gate fires before any sniff or scan",
    claimedExt: ".png",
    claimedMime: "image/png",
    filename: "huge.png",
    bytes: concat(PNG_SIGNATURE, zeros(25 * 1024 * 1024 + 1 - 8)),
    expect: { sniff: "image/png", validate: "upload_too_large", strip: "ok-keep" },
  },
];
