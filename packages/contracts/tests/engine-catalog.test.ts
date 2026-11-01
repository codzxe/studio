// Round-12 engine catalog tests ("Tool catalog v3"): the generated artifacts
// (src/generated/engine-catalog.json + allowed-command-ids.json), the typed
// accessors, the deny classification, the curated ⊆ allowed superset law and
// the digest budget. The extractor's own idempotence is covered here too
// (same spawn pattern as command-registry.test.ts).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_COMMAND_COUNT,
  ALLOWED_COMMAND_IDS,
  isAllowedEngineCommand,
} from "../src/allowed-commands.js";
import { AGENT_COMMAND_IDS } from "../src/command-registry.js";
import {
  ENGINE_CATALOG_DIGEST,
  ENGINE_CATALOG_VERSION,
  ENGINE_COMMAND_CATALOG,
  type EngineCatalogCommand,
  findEngineCommand,
} from "../src/engine-catalog.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACT_SCRIPT = path.join(PACKAGE_DIR, "scripts", "extract-engine-registry.mjs");
const CATALOG_PATH = path.join(PACKAGE_DIR, "src", "generated", "engine-catalog.json");
const ALLOWED_PATH = path.join(PACKAGE_DIR, "src", "generated", "allowed-command-ids.json");

/** The documented deny vocabulary (extractor tags — data, small on purpose). */
const DENY_TAGS = new Set([
  "app-chrome",
  "filesystem",
  "code-exec",
  "render-output",
  "render-queue",
  "destructive",
  "path-param",
]);

/**
 * The ONLY allowed commands whose params doc names a `path` param: the curated
 * property-path exceptions (engine `path|prop` alternative names — a PROPERTY
 * path, never a filesystem location). Mirrors the extractor's ALLOW_ADDITIONS.
 */
const PROPERTY_PATH_EXCEPTIONS = new Set([
  "prop.set",
  "prop.addKey",
  "prop.toggleAnimation",
  "prop.toggleKey",
  "prop.reset",
  "keys.set",
  "keys.select",
  "anim.applyPreset",
]);

describe("engine-catalog: the generated artifacts are well-formed", () => {
  it("every catalog entry has id/title/category/paramsDoc and a known deny tag", () => {
    expect(ENGINE_COMMAND_CATALOG.length).toBeGreaterThan(500); // documented band
    expect(ENGINE_COMMAND_CATALOG.length).toBeLessThanOrEqual(700);
    for (const entry of ENGINE_COMMAND_CATALOG) {
      expect(entry.id, `${entry.id}`).toMatch(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/);
      expect(entry.title, `${entry.id} title`).toBeTruthy();
      expect(entry.category, `${entry.id} category`).toBe(entry.id.split(".")[0]);
      expect(entry.paramsDoc, `${entry.id} paramsDoc`).toMatch(/^\{/);
      expect(typeof entry.hasPath, `${entry.id} hasPath`).toBe("boolean");
      if (entry.deny !== undefined) {
        expect(DENY_TAGS.has(entry.deny), `${entry.id} unknown tag ${entry.deny}`).toBe(true);
      }
    }
  });

  it("catalog ids are unique and sorted; version/generation stamps exist", () => {
    const ids = ENGINE_COMMAND_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids]).toEqual([...ids].sort());
    expect(ENGINE_CATALOG_VERSION).toBe(1);
  });

  it("ALLOWED_COMMAND_IDS is a sorted, unique, frozen subset of the catalog", () => {
    expect(Object.isFrozen(ALLOWED_COMMAND_IDS)).toBe(true);
    expect(ALLOWED_COMMAND_IDS.length).toBe(ALLOWED_COMMAND_COUNT);
    expect([...ALLOWED_COMMAND_IDS]).toEqual([...ALLOWED_COMMAND_IDS].sort());
    expect(new Set(ALLOWED_COMMAND_IDS).size).toBe(ALLOWED_COMMAND_IDS.length);
    const catalogIds = new Set(ENGINE_COMMAND_CATALOG.map((entry) => entry.id));
    for (const id of ALLOWED_COMMAND_IDS) expect(catalogIds.has(id), id).toBe(true);
  });

  it("findEngineCommand finds entries and never falls back", () => {
    const found = findEngineCommand("layer.newText");
    expect(found?.title).toBe("Text");
    expect(findEngineCommand("not.a.command")).toBeUndefined();
  });
});

describe("engine-catalog: allowlist policy (deny classes are excluded)", () => {
  it("every catalog entry with a deny tag is NOT allowed; allowed entries carry none", () => {
    for (const entry of ENGINE_COMMAND_CATALOG) {
      expect(isAllowedEngineCommand(entry.id), `${entry.id} deny=${entry.deny}`).toBe(
        entry.deny === undefined,
      );
    }
  });

  it("no denied-pattern id is allowed: script.run, file.*, app chrome, purge, renders", () => {
    for (const id of ["script.run", "file.import", "file.save", "file.runScript"]) {
      expect(isAllowedEngineCommand(id), id).toBe(false);
    }
    // The extractor scope covers cmd! ids only; wrapper-registered chrome is
    // absent by construction — it must never sneak into the allowed list.
    for (const id of ["app.quit", "app.settings", "window.scriptPanel", "engine.batch"]) {
      expect(isAllowedEngineCommand(id), id).toBe(false);
    }
    for (const entry of ENGINE_COMMAND_CATALOG.filter((c) => c.deny !== undefined)) {
      expect(ALLOWED_COMMAND_IDS.includes(entry.id), `${entry.id} (${entry.deny})`).toBe(false);
    }
  });

  it("the known deny classes are tagged honestly (spot checks)", () => {
    const byId = (id: string): EngineCatalogCommand | undefined =>
      ENGINE_COMMAND_CATALOG.find((entry) => entry.id === id);
    expect(byId("script.run")?.deny).toBe("code-exec");
    expect(byId("file.import")?.deny).toBe("filesystem");
    expect(byId("edit.purge")?.deny).toBe("destructive");
    expect(byId("project.delete")?.deny).toBe("destructive");
    expect(byId("renderQueue.setOutput")?.deny).toBe("render-queue");
    expect(byId("renderQueue.remove")?.deny).toBe("render-queue");
    expect(byId("render.saveCurrentPreview")?.deny).toBe("render-output");
    expect(byId("essential.exportTemplate")?.deny).toBe("path-param");
    expect(byId("comp.new")?.deny).toBeUndefined();
    expect(byId("edit.pasteSvg")?.deny).toBeUndefined(); // the add_asset seam
  });

  it("hasPath flags are honest; allowed+hasPath are exactly the property-path exceptions", () => {
    const hasPathAllowed: string[] = [];
    for (const entry of ENGINE_COMMAND_CATALOG) {
      if (entry.hasPath) {
        // A denied id may honestly carry the flag; only ALLOWED ones matter here.
        if (entry.deny === undefined) hasPathAllowed.push(entry.id);
      }
    }
    expect(hasPathAllowed.sort()).toEqual([...PROPERTY_PATH_EXCEPTIONS].sort());
  });

  it("the curated 39 command ids remain a subset of the allowed list (mission law)", () => {
    expect(AGENT_COMMAND_IDS.length).toBe(39);
    const missing = AGENT_COMMAND_IDS.filter((id) => !isAllowedEngineCommand(id));
    expect(missing, "curated ids missing from the allowed catalog").toEqual([]);
  });
});

describe("engine-catalog: digest (the compact prompt string)", () => {
  it("is a non-empty string under the 4 KB prompt budget", () => {
    expect(ENGINE_CATALOG_DIGEST.length).toBeGreaterThan(500);
    expect(ENGINE_CATALOG_DIGEST.length).toBeLessThan(4 * 1024);
  });

  it("carries the category table, the discovery guidance and allowed exemplars", () => {
    expect(ENGINE_CATALOG_DIGEST).toContain("- layer (");
    expect(ENGINE_CATALOG_DIGEST).toContain("- prop (");
    expect(ENGINE_CATALOG_DIGEST).toContain("studio.describe_command");
    expect(ENGINE_CATALOG_DIGEST).toContain("studio.engine_commands");
    for (const id of ["layer.newText", "comp.new", "edit.pasteSvg", "prop.set"]) {
      expect(ENGINE_CATALOG_DIGEST, `${id} exemplar`).toContain(id);
    }
  });

  it("never lists a fully-denied category or a denied id", () => {
    // file.* is 100% denied — the digest must not advertise the category.
    expect(ENGINE_CATALOG_DIGEST).not.toContain("- file (");
    expect(ENGINE_CATALOG_DIGEST).not.toContain("- view (");
    expect(ENGINE_CATALOG_DIGEST).not.toContain("script.run");
    expect(ENGINE_CATALOG_DIGEST).not.toContain("file.import");
    // ...and every category line matches at least one ALLOWED id.
    const allowed = new Set(ALLOWED_COMMAND_IDS);
    for (const line of ENGINE_CATALOG_DIGEST.split("\n")) {
      const match = /^- ([a-z][a-zA-Z0-9]*) \((\d+)\):/.exec(line);
      if (match === null) continue;
      const category = match[1] ?? "";
      const count = Number(match[2] ?? 0);
      const actual = ALLOWED_COMMAND_IDS.filter((id) => id.split(".")[0] === category).length;
      expect(actual, `category ${category}`).toBe(count);
      expect(count, `category ${category} must have allowed ids`).toBeGreaterThan(0);
      expect(allowed.has(`${category}.x`)).toBe(false); // sanity, never a real lookup
    }
  });
});

describe("engine-catalog: extractor idempotence (byte-stable artifacts)", () => {
  it("runs with node, reports the catalog/allowed counts, and rewrites nothing", () => {
    const run = (): { catalog: number; allowed: number; status: string } => {
      const result = spawnSync(process.execPath, [EXTRACT_SCRIPT], {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse((result.stdout ?? "").trim()) as {
        catalog: number;
        allowed: number;
        status: string;
        catalogStatus: string;
        allowedStatus: string;
      };
      expect(summary.status).toBe("unchanged"); // the M5-J fixture stays stable
      expect(summary.catalogStatus).toBe("unchanged");
      expect(summary.allowedStatus).toBe("unchanged");
      return summary;
    };

    const hash = (file: string): string =>
      createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = [hash(CATALOG_PATH), hash(ALLOWED_PATH)];
    const summary = run();
    expect(summary.catalog).toBe(ENGINE_COMMAND_CATALOG.length);
    expect(summary.allowed).toBe(ALLOWED_COMMAND_IDS.length);
    expect(summary.allowed).toBeLessThan(summary.catalog); // deny rules bite
    const after = [hash(CATALOG_PATH), hash(ALLOWED_PATH)];
    expect(after).toEqual(before);
  });
});
