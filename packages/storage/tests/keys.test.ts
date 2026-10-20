// Key-space tests — pure logic, table-driven, deterministic, no I/O.
// Attack table covers traversal, absolute paths, alternate separators, control
// characters, device names, charset/length caps and cross-tenant guards
// (§15.1 per-workspace prefixes; §13.3: messages never echo values).

import { describe, expect, it } from "vitest";

import {
  type ExportFormat,
  MAX_KEY_BYTES,
  assertTenant,
  assetKey,
  checkpointKey,
  documentKey,
  exportKey,
  extractTenant,
  isSafeFilename,
  isSafeId,
  isWindowsDeviceName,
  parseStorageKey,
  previewKey,
  validateStorageKey,
  validateStoragePrefix,
} from "../src/keys.js";
import { expectErr, expectOk } from "./helpers.js";

const ORG = "org-1";

const GOOD_ASSET = "assets/organizations/org-1/assets/ast-2/original-photo.png";
const GOOD_PREVIEW = "renders/organizations/org-1/documents/doc-9/preview-1024-3.png";

describe("validateStorageKey — builders produce valid keys", () => {
  it.each([
    [
      "assetKey without filename",
      () => assetKey({ organizationId: ORG, assetId: "ast-2" }),
      "assets/organizations/org-1/assets/ast-2",
    ],
    [
      "assetKey with filename",
      () => assetKey({ organizationId: ORG, assetId: "ast-2", filename: "original-photo.png" }),
      GOOD_ASSET,
    ],
    [
      "previewKey",
      () => previewKey({ organizationId: ORG, documentId: "doc-9", width: 1024, revision: 3 }),
      GOOD_PREVIEW,
    ],
    [
      "exportKey",
      () =>
        exportKey({
          organizationId: ORG,
          documentId: "doc-9",
          format: "png",
          versionId: "ver-abc",
        }),
      "exports/organizations/org-1/documents/doc-9/png-ver-abc.png",
    ],
    [
      "exportKey pcraft",
      () =>
        exportKey({
          organizationId: ORG,
          documentId: "doc-9",
          format: "pcraft",
          versionId: "v-42",
        }),
      "exports/organizations/org-1/documents/doc-9/pcraft-v-42.pcraft",
    ],
    [
      "documentKey",
      () => documentKey({ organizationId: ORG, documentId: "doc-9", versionId: "v-42" }),
      "documents/organizations/org-1/documents/doc-9/v-42.pcraft",
    ],
    [
      "checkpointKey",
      () =>
        checkpointKey({ organizationId: ORG, documentId: "doc-9", sessionId: "s-7", revision: 0 }),
      "checkpoints/organizations/org-1/documents/doc-9/sessions/s-7/checkpoint-0.pcraft",
    ],
  ] as const)("%s builds exactly the designed key", (name, build, expected) => {
    const key = expectOk(build());
    expect(key).toBe(expected);
    expect(expectOk(validateStorageKey(key))).toBe(key);
  });
});

describe("validateStorageKey — attack table (all rejected, typed, value-free)", () => {
  it.each([
    ["empty string", ""],
    ["whitespace", " "],
    ["absolute path", "/documents/organizations/org-1/documents/d-1/v-1.pcraft"],
    ["UNC share", "\\\\server\\share\\v-1.pcraft"],
    ["backslash separators", "documents\\organizations\\org-1\\documents\\d-1\\v-1.pcraft"],
    ["drive prefix", "C:/documents/organizations/org-1/x/y.pcraft"],
    ["leading parent traversal", "../documents/organizations/org-1/documents/d-1/v-1.pcraft"],
    ["mid parent traversal", "documents/organizations/org-1/../org-2/documents/d-1/v-1.pcraft"],
    ["trailing parent traversal", "documents/organizations/org-1/documents/d-1/v-1.pcraft/.."],
    ["dot segment", "documents/organizations/org-1/./documents/d-1/v-1.pcraft"],
    ["double slash", "documents/organizations//documents/d-1/v-1.pcraft"],
    ["trailing slash", "documents/organizations/org-1/documents/d-1/"],
    ["unknown namespace", "tmp/organizations/org-1/documents/d-1/v-1.pcraft"],
    ["missing organizations segment", "documents/org-1/documents/d-1/v-1.pcraft"],
    ["short key", "assets/organizations"],
    ["unsafe tenant charset", "documents/organizations/or g-1/documents/d-1/v-1.pcraft"],
    ["tenant traversal", "documents/organizations/../organizations/org-1/documents/d-1/v-1.pcraft"],
    ["percent encoding tricks", "documents/organizations/%2e%2e/documents/d-1/v-1.pcraft"],
    ["hidden dotfile segment", "documents/organizations/org-1/documents/d-1/.v-1.pcraft"],
    ["control character", "documents/organizations/org-1/documents/d-1/v\x00-1.pcraft"],
    ["device name segment", "documents/organizations/org-1/documents/CON/v-1.pcraft"],
    ["device name with extension", "documents/organizations/org-1/documents/com1.txt/v-1.pcraft"],
    ["segment ending in dot", "documents/organizations/org-1/documents/d-1./v-1.pcraft"],
    ["overlong id segment", `documents/organizations/${"i".repeat(65)}/documents/d-1/v-1.pcraft`],
  ] as const)("%s is rejected with storage_invalid_key", (_name, key) => {
    const failure = expectErr(validateStorageKey(key));
    expect(failure.code).toBe("storage_invalid_key");
    // §13.3: the message never echoes hostile INPUT segments (layout words are fine).
    const layoutWords = new Set([
      "documents",
      "organizations",
      "renders",
      "exports",
      "checkpoints",
      "assets",
    ]);
    for (const segment of key.split("/")) {
      if (segment.length >= 5 && !layoutWords.has(segment)) {
        expect(failure.message).not.toContain(segment);
      }
    }
  });

  it("rejects keys over the 1024-byte cap but accepts exactly 1024 bytes", () => {
    // Bytes spread across ≤ 128-char segments (both caps must hold at once).
    const head = "documents/organizations/org-1/documents/";
    const tail = "/v.pcraft";
    let pad = MAX_KEY_BYTES - head.length - tail.length;
    const units: string[] = [];
    while (pad >= 128) {
      units.push("d".repeat(127)); // 127 chars + 1 separator
      pad -= 128;
    }
    if (pad > 0) {
      units.push("d".repeat(pad));
    }
    const at = `${head}${units.join("/")}${tail}`;
    expect(Buffer.byteLength(at, "utf8")).toBe(MAX_KEY_BYTES);
    expect(expectOk(validateStorageKey(at))).toBe(at);
    const over = `${head}${units.join("/")}/vw.pcraft`;
    expect(Buffer.byteLength(over, "utf8")).toBe(MAX_KEY_BYTES + 1);
    expect(expectErr(validateStorageKey(over)).code).toBe("storage_invalid_key");
  });
});

describe("component predicates", () => {
  it("isSafeId accepts db-shaped ids and rejects path tricks", () => {
    for (const good of ["a", "org-1", "A9_zZ", "x".repeat(64)]) {
      expect(isSafeId(good)).toBe(true);
    }
    for (const bad of ["", ".", "..", "a.b", "a/b", "a\\b", "-x", "_x", "x".repeat(65), "a b"]) {
      expect(isSafeId(bad)).toBe(false);
    }
  });

  it("isSafeFilename allows normal filenames and rejects tricks", () => {
    for (const good of ["a", "original-photo.png", "v-42.pcraft", "a_b.c-d", "x".repeat(128)]) {
      expect(isSafeFilename(good)).toBe(true);
    }
    for (const bad of [
      "",
      ".",
      "..",
      ".hidden",
      "a..",
      "a b",
      "a/b",
      "CON",
      "aux.txt",
      "x".repeat(129),
    ]) {
      expect(isSafeFilename(bad)).toBe(false);
    }
  });

  it("flags Windows device stems", () => {
    for (const device of ["CON", "con", "PRN.aux", "com1", "LPT9", "NUL"]) {
      expect(isWindowsDeviceName(device)).toBe(true);
    }
    for (const fine of ["console", "contact.png", "component"]) {
      expect(isWindowsDeviceName(fine)).toBe(false);
    }
  });
});

describe("tenant extraction + cross-tenant guard (§15.1)", () => {
  it("extracts the organization id from a validated key", () => {
    expect(expectOk(extractTenant(GOOD_ASSET))).toBe("org-1");
    expect(expectOk(extractTenant(GOOD_PREVIEW))).toBe("org-1");
  });

  it("refuses to extract from invalid keys", () => {
    expect(expectErr(extractTenant("../escape")).code).toBe("storage_invalid_key");
    expect(expectErr(extractTenant("")).code).toBe("storage_invalid_key");
  });

  it("assertTenant passes for the owning organization", () => {
    expect(expectOk(assertTenant(GOOD_ASSET, "org-1"))).toBe(GOOD_ASSET);
  });

  it("assertTenant fails with cross_tenant_key for another organization", () => {
    const failure = expectErr(assertTenant(GOOD_ASSET, "org-2"));
    expect(failure.code).toBe("cross_tenant_key");
    expect(failure.message).not.toContain("org-1");
    expect(failure.message).not.toContain("org-2");
  });

  it("assertTenant fails with storage_invalid_key for hostile keys or ids", () => {
    for (const [key, org] of [
      ["../escape", ORG],
      ["", ORG],
      ["assets/organizations/org-1/assets/a-1", "../org-1"],
      ["assets/organizations/org-1/assets/a-1", "or g"],
      ["assets/organizations/org-1/assets/a-1", "a.b"],
    ] as const) {
      expect(expectErr(assertTenant(key, org)).code).toBe("storage_invalid_key");
    }
  });
});

describe("parseStorageKey — typed layouts", () => {
  it("round-trips every builder", () => {
    const asset = expectOk(parseStorageKey(GOOD_ASSET));
    expect(asset).toMatchObject({
      kind: "asset",
      organizationId: "org-1",
      assetId: "ast-2",
      filename: "original-photo.png",
    });

    const bareAsset = expectOk(parseStorageKey("assets/organizations/org-1/assets/ast-2"));
    expect(bareAsset).toMatchObject({ kind: "asset", assetId: "ast-2" });
    expect("filename" in bareAsset && bareAsset.filename !== undefined).toBe(false);

    const preview = expectOk(parseStorageKey(GOOD_PREVIEW));
    expect(preview).toMatchObject({
      kind: "preview",
      documentId: "doc-9",
      width: 1024,
      revision: 3,
    });

    const exportPng = expectOk(
      parseStorageKey("exports/organizations/org-1/documents/doc-9/png-ver-abc.png"),
    );
    expect(exportPng).toMatchObject({ kind: "export", format: "png", versionId: "ver-abc" });

    const doc = expectOk(
      parseStorageKey("documents/organizations/org-1/documents/doc-9/v-42.pcraft"),
    );
    expect(doc).toMatchObject({ kind: "document", documentId: "doc-9", versionId: "v-42" });

    const checkpoint = expectOk(
      parseStorageKey(
        "checkpoints/organizations/org-1/documents/doc-9/sessions/s-7/checkpoint-12.pcraft",
      ),
    );
    expect(checkpoint).toMatchObject({ kind: "checkpoint", sessionId: "s-7", revision: 12 });
  });

  it("rejects structurally unknown-but-safe keys with storage_invalid_key", () => {
    for (const key of [
      "assets/organizations/org-1/assets", // missing assetId
      "assets/organizations/org-1/assets/a-1/original.png/extra", // too deep
      "renders/organizations/org-1/documents/doc-9/render-1024-3.png", // not preview-*
      "renders/organizations/org-1/documents/doc-9/preview-1024-3.jpg", // wrong extension
      "renders/organizations/org-1/documents/doc-9/preview-50000-3.png", // width out of range
      "renders/organizations/org-1/workspaces/doc-9/preview-1024-3.png", // wrong middle segment
      "exports/organizations/org-1/documents/doc-9/gif-ver-abc.gif", // unknown format
      "exports/organizations/org-1/documents/doc-9/png-ver-abc.psd", // format/ext mismatch
      "documents/organizations/org-1/documents/doc-9/v-42.png", // not .pcraft
      "documents/organizations/org-1/documents/doc-9/v..pcraft", // unsafe version id
      "checkpoints/organizations/org-1/documents/doc-9/sessions/s-7/other-7.pcraft", // not checkpoint-*
      "checkpoints/organizations/org-1/documents/doc-9/sessions/s-7/checkpoint-7.pcraft/x", // too deep
      "documents/organizations/org-1/x/y.pcraft", // not a documents/ layout
    ] as const) {
      expect(expectErr(parseStorageKey(key)).code).toBe("storage_invalid_key");
    }
  });
});

describe("builder input validation", () => {
  it.each([
    ["assetKey traversal org", () => assetKey({ organizationId: "..", assetId: "a-1" })],
    [
      "assetKey unsafe filename",
      () => assetKey({ organizationId: ORG, assetId: "a-1", filename: "../evil.png" }),
    ],
    [
      "previewKey zero width",
      () => previewKey({ organizationId: ORG, documentId: "d", width: 0, revision: 1 }),
    ],
    [
      "previewKey fractional width",
      () => previewKey({ organizationId: ORG, documentId: "d", width: 12.5, revision: 1 }),
    ],
    [
      "previewKey too wide",
      () => previewKey({ organizationId: ORG, documentId: "d", width: 8193, revision: 1 }),
    ],
    [
      "previewKey negative revision",
      () => previewKey({ organizationId: ORG, documentId: "d", width: 64, revision: -1 }),
    ],
    [
      "exportKey unknown format",
      () =>
        exportKey({
          organizationId: ORG,
          documentId: "d",
          format: "gif" as ExportFormat,
          versionId: "v",
        }),
    ],
    [
      "exportKey unsafe version id",
      () => exportKey({ organizationId: ORG, documentId: "d", format: "png", versionId: "v 1" }),
    ],
    [
      "documentKey empty version id",
      () => documentKey({ organizationId: ORG, documentId: "d", versionId: "" }),
    ],
    [
      "checkpointKey unsafe session id",
      () => checkpointKey({ organizationId: ORG, documentId: "d", sessionId: "s/1", revision: 0 }),
    ],
    [
      "checkpointKey huge revision",
      () =>
        checkpointKey({
          organizationId: ORG,
          documentId: "d",
          sessionId: "s",
          revision: 2_147_483_648,
        }),
    ],
  ] as const)("%s fails with storage_invalid_key", (_name, build) => {
    expect(expectErr(build()).code).toBe("storage_invalid_key");
  });
});

describe("validateStoragePrefix", () => {
  it("accepts whole-space, component-boundary and partial-segment prefixes", () => {
    for (const prefix of [
      "",
      "renders",
      "renders/",
      "renders/organizations/org-1/documents/doc-9/",
      "renders/organizations/org-1/docum",
    ]) {
      expect(expectOk(validateStoragePrefix(prefix))).toBe(prefix);
    }
  });

  it.each([
    ["absolute", "/renders"],
    ["traversal", "renders/organizations/../org-2"],
    ["empty segment", "renders//organizations"],
    ["lone boundary slash", "/"],
    ["control character", "renders/\tx"],
    ["unsafe charset", "renders/organizations/or g"],
    ["device name", "renders/CON"],
  ] as const)("rejects %s", (_name, prefix) => {
    expect(expectErr(validateStoragePrefix(prefix)).code).toBe("storage_invalid_key");
  });
});
