// @studio/worker — minimal ZIP writer (store method + CRC-32).
//
// PNG-sequence outputs are zipped into ONE downloadable artifact (spike §5).
// No zip dependency exists in the lockfile and none is added: this is the
// ~80-line, store-method (method 0, no compression) writer — deterministic
// bytes for identical inputs, testable round-trip via the structural reader in
// tests/zip.test.ts. DOS timestamps are pinned to a fixed value so the archive
// bytes are reproducible byte-for-byte.

/** One archive member: a flat file name (no directories) and its bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

// ───────────────────────────────────────────────────────────────────────────
// CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320)
// ───────────────────────────────────────────────────────────────────────────

const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const table = CRC_TABLE[(crc ^ byte) & 0xff];
    crc = (table ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Little-endian helpers
// ───────────────────────────────────────────────────────────────────────────

/** Fixed DOS date/time (1980-01-01 00:00) — deterministic archive bytes. */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value >>> 0, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

// ───────────────────────────────────────────────────────────────────────────
// The writer (PKZIP spec: local file headers → central directory → EOCD)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a store-method ZIP archive from ordered entries. Entry names must be
 * non-empty flat names without `\`, `..` or NUL (sequence files are
 * `frame_00000.png` style basenames). Throws TypeError on an illegal name.
 */
export function zipStore(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    if (
      entry.name.length === 0 ||
      entry.name.includes("\\") ||
      entry.name.includes("\0") ||
      entry.name.split("/").includes("..")
    ) {
      throw new TypeError("zip entry name must be a safe flat file name");
    }
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed (2.0)
      u16(0x0800), // flags: UTF-8 names
      u16(0), // method: store
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(name.length),
      u16(0), // extra length
      name,
      entry.data,
    ]);
    locals.push(local);

    centrals.push(
      Buffer.concat([
        u32(0x02014b50), // central directory signature
        u16(0x031e), // version made by: UNIX, ZIP 3.0
        u16(20), // version needed
        u16(0x0800), // flags: UTF-8 names
        u16(0), // method: store
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(size),
        u32(size),
        u16(name.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk start
        u16(0), // internal attrs
        u32(0o100644 << 16), // external attrs: -rw-r--r--
        u32(offset),
        name,
      ]),
    );

    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // this disk
    u16(0), // disk with the directory
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0), // comment length
  ]);

  return Buffer.concat([...locals, centralDirectory, end]);
}
