import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256Hex, sha256HexFallback } from "./sha256";

/**
 * SHA-256 is the content address of every immutable version (§9.2) — both the
 * WebCrypto path and the no-subtle fallback must agree with node:crypto on
 * vectors covering the empty string, sub-block and multi-block inputs.
 */

function expected(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 13) % 256;
  return bytes;
}

const VECTORS: ReadonlyArray<{ label: string; bytes: Uint8Array }> = [
  { label: "empty", bytes: new Uint8Array(0) },
  { label: "abc", bytes: new TextEncoder().encode("abc") },
  { label: "exactly one block", bytes: pattern(64) },
  { label: "block boundary +1", bytes: pattern(56) },
  { label: "multi-block", bytes: pattern(1000) },
  { label: "200 KB", bytes: pattern(200_000) },
  {
    label: "multibyte utf8",
    bytes: new TextEncoder().encode("studio — éffèct craft — エフェクト"),
  },
];

describe("sha256HexFallback", () => {
  for (const vector of VECTORS) {
    it(`matches node:crypto (${vector.label})`, () => {
      expect(sha256HexFallback(vector.bytes)).toBe(expected(vector.bytes));
    });
  }

  it("knows the standard vectors", () => {
    expect(sha256HexFallback(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexFallback(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("sha256Hex (async)", () => {
  for (const vector of VECTORS) {
    it(`matches node:crypto (${vector.label})`, async () => {
      await expect(sha256Hex(vector.bytes)).resolves.toBe(expected(vector.bytes));
    });
  }

  it("agrees with the fallback", async () => {
    const bytes = pattern(1234);
    await expect(sha256Hex(bytes)).resolves.toBe(sha256HexFallback(bytes));
  });
});
