// Unit tests — the in-repo store-method ZIP writer (png-seq artifact rule,
// spike §5): CRC-32 vectors, structural round-trip (local headers + central
// directory + EOCD parsed back by hand), determinism, name-safety refusals.

import { describe, expect, it } from "vitest";

import { type ZipEntry, crc32, zipStore } from "../src/zip.js";

describe("crc32 (IEEE, reflected)", () => {
  it("matches the canonical vectors", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0x00000000);
    expect(crc32(Buffer.from("a"))).toBe(0xe8b7be43);
    expect(crc32(Buffer.from("abc"))).toBe(0x352441c2);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("is stable across runs (deterministic table)", () => {
    const data = Buffer.from("deterministic render frames");
    expect(crc32(data)).toBe(crc32(data));
  });
});

describe("zipStore", () => {
  const entries: ZipEntry[] = [
    { name: "frame_00000.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { name: "frame_00001.png", data: Buffer.alloc(1024, 7) },
  ];

  /** Minimal structural reader: local headers → names/data → central dir → EOCD. */
  function readStoreZip(zip: Buffer): { names: string[]; data: Buffer[]; entries: number } {
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // first local file header
    const names: string[] = [];
    const data: Buffer[] = [];
    let offset = 0;
    for (;;) {
      if (zip.readUInt32LE(offset) !== 0x04034b50) break;
      const method = zip.readUInt16LE(offset + 8);
      expect(method).toBe(0); // store
      const crc = zip.readUInt32LE(offset + 14);
      const compressed = zip.readUInt32LE(offset + 18);
      const uncompressed = zip.readUInt32LE(offset + 22);
      const nameLen = zip.readUInt16LE(offset + 26);
      const name = zip.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
      const start = offset + 30 + nameLen;
      const payload = zip.subarray(start, start + compressed);
      expect(compressed).toBe(uncompressed);
      expect(crc32(payload)).toBe(crc);
      names.push(name);
      data.push(Buffer.from(payload));
      offset = start + compressed;
    }
    // Central directory + EOCD agree with the local headers.
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const eocdAt = zip.length - 22;
    expect(zip.readUInt32LE(eocdAt)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocdAt + 8)).toBe(names.length); // entries on disk
    expect(zip.readUInt16LE(eocdAt + 10)).toBe(names.length); // total entries
    expect(zip.readUInt32LE(eocdAt + 12)).toBe(eocdAt - offset); // cd size = bytes between the last entry and the EOCD
    expect(zip.readUInt32LE(eocdAt + 16)).toBe(offset); // central dir offset
    return { names, data, entries: zip.readUInt16LE(eocdAt + 10) };
  }

  it("round-trips entry names and bytes through the structural reader", () => {
    const zip = zipStore(entries);
    const read = readStoreZip(zip);
    expect(read.names).toEqual(["frame_00000.png", "frame_00001.png"]);
    expect(read.data[0]).toEqual(entries[0]?.data);
    expect(read.data[1]).toEqual(entries[1]?.data);
    expect(read.entries).toBe(2);
  });

  it("produces byte-identical archives for identical inputs (fixed timestamps)", () => {
    expect(zipStore(entries)).toEqual(zipStore([...entries]));
  });

  it("accepts empty archives (a zero-frame case must still be a valid zip)", () => {
    const zip = zipStore([]);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
    expect(zip.readUInt16LE(10)).toBe(0);
  });

  it("refuses unsafe entry names (traversal / control chars / empty)", () => {
    expect(() => zipStore([{ name: "", data: Buffer.alloc(1) }])).toThrow(TypeError);
    expect(() => zipStore([{ name: "../evil.png", data: Buffer.alloc(1) }])).toThrow(TypeError);
    expect(() => zipStore([{ name: "a\\b.png", data: Buffer.alloc(1) }])).toThrow(TypeError);
    expect(() => zipStore([{ name: "bad\0name.png", data: Buffer.alloc(1) }])).toThrow(TypeError);
  });

  it("writes UTF-8 name flag (0x0800) and version 2.0 headers", () => {
    const zip = zipStore([{ name: "frame_00000.png", data: Buffer.alloc(4) }]);
    expect(zip.readUInt16LE(4)).toBe(20); // version needed
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800); // UTF-8 flag
    expect(zip.readUInt16LE(8)).toBe(0); // store method
  });
});
