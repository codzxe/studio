import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFakeEditor, attachFakeBridge } from "@studio/editor-bridge/fake";

describe("env probe", () => {
  it("subtle digest works", async () => {
    const subtle = globalThis.crypto?.subtle;
    console.log("subtle:", typeof subtle, subtle ? Object.getPrototypeOf(subtle).constructor.name : "-");
    if (subtle) {
      const digest = await subtle.digest("SHA-256", new Uint8Array([1, 2, 3]));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const expected = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
      console.log("digest:", hex, "ok:", hex === expected);
      expect(hex).toBe(expected);
    }
  });

  it("fake editor roundtrip: addFile reads a Blob", async () => {
    const fake = createFakeEditor();
    const bridge = attachFakeBridge(fake);
    const bytes = new TextEncoder().encode('{"schema":"studio-fake-ecproj","version":"0.13.0-fake","project":{"comps":[],"layers":[],"keyframes":[]},"state":{"activeComp":null,"selectedLayers":[],"playhead":0}}');
    const path = await bridge.addFile(new Blob([bytes], { type: "application/json" }), "probe.ecproj");
    console.log("addFile path:", path, "read:", new TextDecoder().decode(bridge ? await bridge.readFile(path) : new Uint8Array()));
    expect(path).toBe("/probe.ecproj");
  });

  it("FileReader under fake timers", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeEditor();
      const bridge = attachFakeBridge(fake);
      const bytes = new TextEncoder().encode("hello");
      const p = bridge.addFile(new Blob([bytes]), "probe2.bin");
      const path = await p; // does this settle without advancing fake timers?
      console.log("fileReader path:", path);
      expect(path).toBe("/probe2.bin");
    } finally {
      vi.useRealTimers();
    }
  });
});
