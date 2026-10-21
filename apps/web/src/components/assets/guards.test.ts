// Table-driven pure tests for the client-side upload guards (W8-I).
//
// Mirrors the §20.2 contract enforced server-side by @studio/storage
// validate.ts: JPEG/PNG whitelist, 25 MB cap, 60 MP ceiling with friendly
// copy, header-only dimension parsing, and §13.3 envelope → failure copy
// (the envelope hint must always survive the mapping). No network, no DOM
// rendering — File-like inputs are structural fakes (ClientUploadFile).

import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MEGAPIXELS } from "@studio/config";
import {
  ACCEPTED_UPLOAD_MIME_TYPES,
  UPLOAD_ACCEPT_ATTRIBUTE,
  describeLibraryFailure,
  describeUploadFailure,
  formatBytes,
  formatMegapixels,
  isNotFoundFailure,
  readImageDimensionsFromBytes,
  validateClientFile,
  type ClientUploadFile,
  type FailureCopy,
} from "./guards";

// ---------------------------------------------------------------------------
// Byte builders + file fakes
// ---------------------------------------------------------------------------

/** Minimal PNG: signature + IHDR (length, tag, width, height) — 24 bytes. */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13); // IHDR chunk length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * Minimal JPEG header: SOI, one DQT segment to skip, then SOF0 with the
 * dimensions, then SOS (which ends the header scan).
 */
function jpegBytes(width: number, height: number): Uint8Array {
  const dqtPayload = 64;
  const dqtLength = dqtPayload + 2; // length includes its own two bytes
  const sof = [
    0xff, 0xc0, 0x00, 0x08, 0x08, // SOF0, len 8, precision 8
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, // 1 component
  ];
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xdb, (dqtLength >> 8) & 0xff, dqtLength & 0xff, ...new Array<number>(dqtPayload).fill(0),
    ...sof,
    0xff, 0xda, 0x00, 0x08, // SOS — nothing after matters
  ]);
}

/** Structural File fake — `size` is independent of the header bytes returned. */
function fakeFile(name: string, type: string, size: number, bytes: Uint8Array): ClientUploadFile {
  return {
    name,
    type,
    size,
    slice: () => new Blob([bytes]),
  };
}

/** Gateway ApiError-shaped envelope (what src/lib/api.ts throws). */
function envelope(
  code: string,
  status: number,
  message: string,
  hint?: string,
): { code: string; message: string; hint?: string; retryable: boolean; status: number } {
  return { code, message, hint, retryable: false, status };
}

// ---------------------------------------------------------------------------
// readImageDimensionsFromBytes (header parsing only — §15.2 posture)
// ---------------------------------------------------------------------------

describe("readImageDimensionsFromBytes", () => {
  it.each([
    { label: "PNG IHDR", bytes: () => pngBytes(4000, 3000), width: 4000, height: 3000 },
    { label: "JPEG SOF0 after a DQT segment", bytes: () => jpegBytes(4000, 2000), width: 4000, height: 2000 },
    { label: "JPEG SOF0 at 1×1 (bounds floor)", bytes: () => jpegBytes(1, 1), width: 1, height: 1 },
  ])("parses dimensions from $label", ({ bytes, width, height }) => {
    expect(readImageDimensionsFromBytes(bytes())).toEqual({ width, height });
  });

  it.each([
    { label: "empty input", bytes: new Uint8Array(0) },
    { label: "truncated PNG (signature only)", bytes: pngBytes(10, 10).subarray(0, 16) },
    { label: "PNG with a non-IHDR first chunk", bytes: (() => { const b = pngBytes(10, 10); b.set([0x4a, 0x48, 0x44, 0x52], 12); return b; })() },
    { label: "JPEG with no SOF before SOS", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08]) },
    { label: "unknown format (zeros)", bytes: new Uint8Array(64) },
  ])("returns null for $label instead of throwing", ({ bytes }) => {
    expect(readImageDimensionsFromBytes(bytes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateClientFile (§20.2 client mirror)
// ---------------------------------------------------------------------------

describe("validateClientFile", () => {
  it.each([
    { label: "JPEG", type: "image/jpeg", name: "sunset.jpg", bytes: () => jpegBytes(4032, 3024) },
    { label: "PNG", type: "image/png", name: "chart.png", bytes: () => pngBytes(1920, 1080) },
    {
      label: "upper-case MIME (normalised)",
      type: "IMAGE/PNG",
      name: "chart.png",
      bytes: () => pngBytes(1920, 1080),
    },
  ])("accepts a $label under every cap", async ({ type, name, bytes }) => {
    const file = fakeFile(name, type, 1024, bytes());
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(true);
  });

  it("accepts an empty-MIME file with a JPEG extension (extension fallback)", async () => {
    const file = fakeFile("photo.jpeg", "", 1024, jpegBytes(100, 100));
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(true);
  });

  it.each([
    { label: "GIF", type: "image/gif", name: "cat.gif" },
    { label: "WEBP (server-sniffed but outside the §20.2 surface)", type: "image/webp", name: "shot.webp" },
    { label: "SVG (never uploadable)", type: "image/svg+xml", name: "icon.svg" },
    { label: "PDF", type: "application/pdf", name: "doc.pdf" },
  ])("rejects a $label with the JPEG/PNG copy", async ({ type, name }) => {
    const file = fakeFile(name, type, 1024, pngBytes(10, 10));
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.title).toContain("not a JPEG or PNG");
      expect(guard.hint).toBe("Only JPEG and PNG images are accepted.");
    }
  });

  it("rejects an empty-MIME file with an unsupported extension", async () => {
    const file = fakeFile("clip.gif", "", 1024, pngBytes(10, 10));
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(false);
  });

  it("rejects a zero-byte file", async () => {
    const file = fakeFile("empty.png", "image/png", 0, pngBytes(1, 1));
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.title).toContain("empty");
    }
  });

  it("rejects a file over the 25 MB cap with human units", async () => {
    const file = fakeFile("huge.png", "image/png", MAX_UPLOAD_BYTES + 1, pngBytes(10, 10));
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.title).toContain("25 MB");
      expect(guard.title).toContain("over the 25 MB per-file cap");
    }
  });

  it("accepts a file at exactly the 25 MB cap (server rejects only >)", async () => {
    const file = fakeFile("edge.png", "image/png", MAX_UPLOAD_BYTES, pngBytes(1000, 1000));
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(true);
  });

  it.each([
    { label: "PNG 8000×8000 (64 MP)", bytes: () => pngBytes(8000, 8000), mpFragment: "64 MP" },
    { label: "PNG 7750×7750 (60.06 MP)", bytes: () => pngBytes(7750, 7750), mpFragment: "60.1 MP" },
  ])("rejects a $label with a friendly 60 MP warning", async ({ bytes, mpFragment }) => {
    const file = fakeFile("bomb.png", "image/png", 1024, bytes());
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.title).toContain(mpFragment);
      expect(guard.title).toContain(`${MAX_UPLOAD_MEGAPIXELS} MP cap`);
      expect(guard.hint).toBeDefined();
    }
  });

  it.each([
    { label: "PNG 7000×8000 (56 MP)", bytes: () => pngBytes(7000, 8000) },
    { label: "PNG 7745×7745 (59.99 MP)", bytes: () => pngBytes(7745, 7745) },
  ])("accepts a $label under the ceiling", async ({ bytes }) => {
    const file = fakeFile("big.png", "image/png", 1024, bytes());
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(true);
  });

  it("abstains (accepts) when dimensions cannot be parsed — the server decides", async () => {
    const file = fakeFile("odd.png", "image/png", 1024, new Uint8Array(64)); // garbage header
    const guard = await validateClientFile(file);
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.dimensions).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Failure copy mapping (§13.3 — the envelope hint must survive)
// ---------------------------------------------------------------------------

describe("describeUploadFailure", () => {
  it.each([
    {
      label: "413 too large",
      error: () => envelope("upload_too_large", 413, "The upload exceeds the per-file size cap.", "max 26214400 bytes"),
      title: "This file is over the 25 MB cap.",
      hint: "max 26214400 bytes",
    },
    {
      label: "60 MP ceiling rejection",
      error: () => envelope("resolution_exceeds_ceiling", 400, "This image exceeds the resolution ceiling."),
      title: "This image is over the 60 MP cap.",
    },
    {
      label: "polyglot rejection",
      error: () => envelope("polyglot_detected", 400, "File contains more than one image format (polyglot)."),
      title: "This file hides more than one image format.",
    },
    {
      label: "corrupt file rejection",
      error: () => envelope("file_corrupt", 400, "The image data is truncated."),
      title: "This image file is damaged or incomplete.",
    },
    {
      label: "viewer 403",
      error: () => envelope("forbidden", 403, "Viewers cannot upload assets."),
      title: "Your role does not allow uploads.",
    },
    {
      label: "network failure",
      error: () => envelope("network_error", 0, "Could not reach the server."),
      title: "Could not reach the server.",
    },
  ])("maps a $label to curated copy", ({ error, title }) => {
    const copy: FailureCopy = describeUploadFailure(error());
    expect(copy.title).toBe(title);
  });

  it("always keeps the envelope's hint for known codes", () => {
    const copy = describeUploadFailure(
      envelope("polyglot_detected", 400, "File contains more than one image format.", "Upload a plain JPEG or PNG."),
    );
    expect(copy.hint).toBe("Upload a plain single-format JPEG or PNG.");
  });

  it("falls back to the envelope message for unknown codes", () => {
    const copy = describeUploadFailure(envelope("quota_exceeded", 400, "Library is full.", "Delete unused assets."));
    expect(copy.title).toBe("Library is full.");
    expect(copy.hint).toBe("Delete unused assets.");
  });

  it("never leaks internals for non-envelope errors", () => {
    const copy = describeUploadFailure(new Error("ZodError: issues=[…] at /assets"));
    expect(copy.title).toBe("The upload failed. Please try again.");
    expect(copy.hint).toBeUndefined();
  });
});

describe("describeLibraryFailure", () => {
  it.each([
    {
      label: "forbidden",
      error: () => envelope("forbidden", 403, "Viewers cannot delete assets."),
      title: "Your role does not allow this action.",
    },
    {
      label: "storage unavailable",
      error: () => envelope("storage_error", 503, "Object storage is unavailable."),
      title: "Object storage is unavailable right now.",
    },
    {
      label: "plain network error",
      error: () => envelope("network_error", 0, "Could not reach the server."),
      title: "Could not reach the server.",
    },
  ])("maps a $label to curated copy", ({ error, title }) => {
    expect(describeLibraryFailure(error()).title).toBe(title);
  });

  it("falls back to the envelope message for unmapped codes", () => {
    const copy = describeLibraryFailure(envelope("internal_error", 500, "Something went wrong."));
    expect(copy.title).toBe("Something went wrong.");
  });
});

describe("isNotFoundFailure", () => {
  it("recognises the not_found envelope (a re-delete is a success)", () => {
    expect(isNotFoundFailure(envelope("not_found", 404, "Asset not found."))).toBe(true);
    expect(isNotFoundFailure(envelope("forbidden", 403, "no"))).toBe(false);
    expect(isNotFoundFailure(new Error("not found"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Formatters + constants
// ---------------------------------------------------------------------------

describe("formatters", () => {
  it.each([
    { bytes: 0, expected: "0 B" },
    { bytes: 512, expected: "512 B" },
    { bytes: 1536, expected: "1.5 KB" },
    { bytes: MAX_UPLOAD_BYTES, expected: "25 MB" },
  ])("formatBytes($bytes) → $expected", ({ bytes, expected }) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([
    { mp: 56, expected: "56 MP" },
    { mp: 60.0625, expected: "60.1 MP" },
    { mp: 95.28, expected: "95.3 MP" },
  ])("formatMegapixels($mp) → $expected", ({ mp, expected }) => {
    expect(formatMegapixels(mp)).toBe(expected);
  });

  it("exposes the JPEG/PNG whitelist constants for the file input", () => {
    expect(ACCEPTED_UPLOAD_MIME_TYPES).toEqual(["image/jpeg", "image/png"]);
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toBe("image/jpeg,image/png");
  });
});
