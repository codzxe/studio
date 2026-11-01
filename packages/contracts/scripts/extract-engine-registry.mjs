#!/usr/bin/env node
// @studio/contracts — extract the REAL EffectCraft engine command registry.
//
// Scans the vendored, frozen engine sources (`editor/` — READ ONLY) for `cmd!` and
// `query!` macro registrations and emits:
//
//   fixtures/engine-command-ids.json  (unchanged since M5-J)
//     { "extractedAt": "<ISO 8601>", "enginePin": "<sha>", "ids": [...], "queries": [...] }
//
//   src/generated/engine-catalog.json  (round 12 — "Tool catalog v3", tier 1)
//     { "version": 1, "generatedAt": "<ISO 8601>", "commands": [
//        { "id", "title", "category", "paramsDoc", "hasPath": boolean, "deny"?: string } ] }
//     — one entry per MUTATING (batchable, `cmd!`/journal:true) command, label + params
//     doc captured verbatim from the registration, plus a generation-time deny
//     classification (below). Read/only `query!` ids are NOT batchable and stay out.
//
//   src/generated/allowed-command-ids.json  (round 12 — tier 2, ids only)
//     [ "<id>", ... ]  — the ALLOWED (non-denied) subset, sorted. This is the ONLY
//     artifact the browser tier ever sees (~10 KB): the full catalog never rides
//     the client bundle (packages/allowed-commands.js imports just this file).
//
// Grammar (apps/editor/crates/engine/src/commands/mod.rs:119-153):
//   cmd!(id, label, [menus], shortcut, "{params doc}", enabled_guard, handler)
//   query!(id, label, "{params doc}", handler)                 // journal: false — read-only
//
// Registration invocations span MULTIPLE lines (e.g. layer.rs `layer.newText`), so the
// scanner tracks string literals and (), [], {} depth, splits top-level arguments at
// depth-1 commas, and keeps only invocations whose FIRST argument is a string literal
// (macro-definition bodies such as `$crate::cmd!($id, …)` in mod.rs and the local
// wrapper macros `style_cmd!` / `view_cmd!` use `$`-variables and are skipped by that
// same check). Closures with commas (`|s, _, p| …`) split into extra trailing args —
// harmless: id/label/menus/shortcut/params all sit BEFORE the closure, so
// `cmd!` args[4] / `query!` args[2] are always the params doc (verified: 0 entries
// whose args[4]/args[2] is a non-`{…}` literal across the whole vendored engine).
//
// Deny classification (round-12 design "Tool catalog v3" — generated ONCE here,
// never re-derived at runtime; the deny TAG travels with the catalog entry):
//   * app chrome / user config / filesystem / code-exec PREFIXES: app, file (law #5
//     — open/import/export/save/reveal/recent, watchFolder, runScript), help, learn,
//     mediaBrowser, models, panel, playback, prefs, shortcuts, storage, templates, ui,
//     view (viewer state — zoom/channels/guides/snapshots; 3D view toggles are
//     session chrome, not document content), watchFolder, window, scriptui, script
//     (script.run is the round-12 curated power tool's seam, NEVER batchable — the
//     engine's own NOT_IN_BATCH refuses it inside engine.batch).
//   * explicit destructive / out-of-document IDs: renderQueue remove/delete/save/
//     template-store/output-destination setters ("render-queue"), renderQueue +
//     render output-destination writers (setOutput/setOutputModule/addOutputModule —
//     they choose where files land on disk), project.delete (cascades: folders with
//     their contents), edit.purge* (cache clears — pointless for an agent,
//     irreversible), edit.purgeUndo (destroys the undo history), edit.editOriginal
//     (launches an external app), footage.open (opens the Footage panel — pushes a
//     Frontend event, pure UI).
//   * PATH-LIKE PARAMS (law #5: the model never sees filesystem paths): a command is
//     denied when a params-doc param NAME is exactly/ends with path|file|folder|dir
//     (camelCase suffix, optional plural — e.g. `paths`, `output?` hints, `filePath`)
//     or its type HINT mentions path/file/folder/dir/directory as a standalone word
//     (`output?: path|template`). Known false-positive exception: `profile` /
//     `proresProfile` (color/render profiles, NOT files). Deliberately conservative:
//     property-path names (`path|prop` — the engine's own alternative for property
//     paths, mod.rs aliases) trip this rule too; the curated ids that use them are
//     rescued by ALLOW_ADDITIONS below. Everything else path-named stays denied
//     until an explicit ruling widens it.
//
// ALLOW_ADDITIONS — the explicit rescue list (mission-pinned): curated
// command-registry.ts ids whose `path` param is a PROPERTY path, never a
// filesystem path (engine parity: `path|prop` alternatives in prop.rs/anim.rs
// docs). The contracts test suite enforces curated ⊆ allowed; if a future engine
// pin or curated addition trips the deny rules and is missing here, that test
// fails loudly and this list gains the id.
//
// Known, deliberate scope (see the M5-J worklog for the full survey):
//   * Only `apps/editor/crates/engine/src/commands/*.rs` is scanned, per the M5 seam. The
//     live engine ALSO registers a handful of ids elsewhere: models.rs / templates.rs /
//     storage.rs / preview.rs / learn.rs (~26 `cmd!`/`query!` — model install/download,
//     template file ops, storage.clear, tutorials: all file-system or destructive, so
//     never agent-batchable), the raw `CommandSpec` literal for `engine.batch`
//     (batch.rs — transport/meta), and viewer/frontend ids registered through the local
//     `fe!` / `res!` / `fast!` / `chan!` wrappers (UI handoffs — incl. `app.quit`;
//     zero agent relevance, and the prefix deny rules above cover them anyway).
//     None of those are curated, so none need fixture provenance.
//   * `query!` ids land in `queries` (read-only, `journal: false`); they are never
//     batchable and never enter the curated agent registry or the catalog.
//
// Idempotence: re-running with unchanged engine sources and pin rewrites NOTHING
// (existing `extractedAt`/`generatedAt` stamps are preserved), so `git diff` stays
// clean. Run from the package dir (`node scripts/extract-engine-registry.mjs`) or
// from anywhere else — paths resolve from this file's location, not the cwd.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const COMMANDS_DIR = path.join(REPO_ROOT, "apps", "editor", "crates", "engine", "src", "commands");
const UPSTREAM_MD = path.join(REPO_ROOT, "apps", "editor", "UPSTREAM.md");
const FIXTURE_PATH = path.join(PACKAGE_DIR, "fixtures", "engine-command-ids.json");
const GENERATED_DIR = path.join(PACKAGE_DIR, "src", "generated");
const CATALOG_PATH = path.join(GENERATED_DIR, "engine-catalog.json");
const ALLOWED_PATH = path.join(GENERATED_DIR, "allowed-command-ids.json");
const READ_QUERIES_PATH = path.join(GENERATED_DIR, "read-query-ids.json");
const PRESETS_DIR = path.join(REPO_ROOT, "apps", "editor", "crates", "engine", "presets");
const PRESET_LIBRARY_PATH = path.join(GENERATED_DIR, "preset-library.json");

/** Catalog artifact format version (bump when the entry shape changes). */
const CATALOG_VERSION = 1;

// ---------------------------------------------------------------------------
// Deny policy (round 12 — see the header comment for the rationale)
// ---------------------------------------------------------------------------

/** Whole-prefix denies: app chrome, user config, filesystem, code-exec. */
const DENY_PREFIXES = [
  "app",
  "file",
  "help",
  "learn",
  "mediaBrowser",
  "models",
  "panel",
  "playback",
  "prefs",
  "shortcuts",
  "storage",
  "templates",
  "ui",
  "view",
  "watchFolder",
  "window",
  "scriptui",
  "script",
];

/** Prefix → deny tag (kept small; the tag is data, not an enum). */
function denyTagForPrefix(prefix) {
  if (prefix === "file") return "filesystem";
  if (prefix === "script" || prefix === "scriptui") return "code-exec";
  return "app-chrome";
}

/**
 * Explicit destructive / out-of-document / render-output ids. Each rule's tag is
 * the honest reason the id never enters the agent-batchable surface.
 */
const DENY_ID_RULES = [
  [
    /^renderQueue\.(remove|deleteTemplate|saveTemplate|setTemplateDefault|setOutput|setOutputModule|setOverflowFolders)$/,
    "render-queue",
  ],
  [/^render\.(addOutputModule|preRender|saveCurrentPreview)$/, "render-output"],
  [/^project\.delete$/, "destructive"],
  [/^edit\.purge/, "destructive"],
  [/^edit\.editOriginal$/, "app-chrome"],
  [/^footage\.open$/, "app-chrome"],
];

/**
 * Curated ids whose params doc names a param `path` that is a PROPERTY path
 * (engine parity: `path|prop` alternatives), never a filesystem path. They stay
 * allowed even though the mechanical path-like-param rule denies them; the
 * contracts command-registry tests pin curated ⊆ allowed so this list can never
 * silently drift.
 */
const ALLOW_ADDITIONS = new Set([
  "prop.set",
  "prop.addKey",
  "prop.toggleAnimation",
  "prop.toggleKey",
  "prop.reset",
  "keys.set",
  "keys.select",
  "anim.applyPreset",
]);

/** Param names that merely LOOK path-like but never are (color/render profiles). */
const PATH_NAME_EXCEPTIONS = new Set(["profile", "profiles", "proresProfile"]);

/** Exact path-like param names (`path`, `paths`, `filePath`-style camel suffixes). */
const PATH_NAME_EXACT = /^(?:path|file|folder|dir)s?$/i;
const PATH_NAME_SUFFIX = /^(?:[A-Za-z0-9_]+?)(?:Path|File|Folder|Dir)s?$/;

/** Standalone path-ish words inside a param's type hint (`output?: path|template`). */
const PATH_HINT_WORD =
  /(?:^|[^A-Za-z0-9_])(?:paths?|files?|folders?|dirs?|directory|directories)(?:[^A-Za-z0-9_]|$)/i;

// Top-level piece/alternative splitting — the engine's own params-doc grammar
// (commands/mod.rs:275-366) simplified to name+hint extraction.
const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function splitAlternatives(piece) {
  const parts = [];
  let depth = 0;
  let inValue = false;
  let current = "";
  for (const ch of piece) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth -= 1;
    if (depth === 0) {
      if (ch === ":") inValue = true;
      if (ch === "|" && !inValue) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** End index of the `{…}` key list that starts a params doc, or -1. */
function keyListEnd(doc) {
  if (!doc.startsWith("{")) return -1;
  let depth = 0;
  let index = 0;
  for (const ch of doc) {
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) {
      depth -= 1;
      if (depth === 0 && ch === "}") return index;
    }
    index += 1;
  }
  return -1;
}

/** The path-like param names a params doc declares (diagnostic + hasPath flag). */
function pathLikeParamNames(doc) {
  const end = keyListEnd(doc);
  if (end === -1) return [];
  const hits = [];
  for (const piece of splitTopLevel(doc.slice(1, end), ",")) {
    for (const alternative of splitAlternatives(piece)) {
      const parsed = /^([A-Za-z0-9_]+)(\??)([\s\S]*)$/.exec(alternative);
      if (parsed === null) continue;
      const name = parsed[1];
      const hint = parsed[3] ?? "";
      const nameIsPathLike =
        (PATH_NAME_EXACT.test(name) ||
          (PATH_NAME_SUFFIX.test(name) && !PATH_NAME_EXCEPTIONS.has(name))) &&
        !PATH_NAME_EXCEPTIONS.has(name);
      if (nameIsPathLike || PATH_HINT_WORD.test(hint)) hits.push(name);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Registration scanning
// ---------------------------------------------------------------------------

/** Find `cmd!(` / `query!(` invocations and record one entry per string-literal id. */
function scanRegistrations(source, fileName, kind, out, warnings) {
  // The guard `(?:^|[^A-Za-z0-9_$.])` keeps `style_cmd!(` / `view_cmd!(` substrings
  // from matching; `$crate::cmd!(` matches but is dropped by the literal-id check.
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_$.])(${kind})!\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    let index = match.index + match[0].length;
    let depth = 1;
    let inString = false;
    let argument = "";
    const args = [];
    while (index < source.length && depth > 0) {
      const ch = source[index];
      if (inString) {
        argument += ch;
        if (ch === "\\" && index + 1 < source.length) {
          argument += source[index + 1];
          index += 2;
          continue;
        }
        if (ch === '"') inString = false;
        index += 1;
        continue;
      }
      if (ch === '"') {
        inString = true;
        argument += ch;
        index += 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
        argument += ch;
        index += 1;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) break; // end of the invocation
        argument += ch;
        index += 1;
        continue;
      }
      if (ch === "," && depth === 1) {
        args.push(argument.trim());
        argument = "";
        index += 1;
        continue;
      }
      argument += ch;
      index += 1;
    }
    if (argument.trim()) args.push(argument.trim());
    const first = args[0];
    if (first === undefined || !first.startsWith('"')) continue; // macro body / non-literal id
    const id = unquote(first);
    if (id === undefined) {
      warnings.push(`${fileName}: unparseable first argument ${JSON.stringify(first)}`);
      continue;
    }
    const line = source.slice(0, match.index).split("\n").length;
    // label: cmd! and query! both take (id, label, …); params: cmd! args[4],
    // query! args[2] — both sit before any handler closure (see header).
    const label = unquote(args[1] ?? "") ?? "";
    const paramsArg = kind === "cmd" ? args[4] : args[2];
    let paramsDoc = "";
    if (typeof paramsArg === "string" && paramsArg.startsWith('"')) {
      const parsed = unquote(paramsArg);
      if (parsed !== undefined) paramsDoc = parsed;
    }
    if (kind === "cmd" && paramsDoc === "") {
      warnings.push(`${fileName}:${line}: cmd! ${id} has no literal params doc (args[4])`);
    }
    out.push({ id, line, fileName, kind, label, paramsDoc });
  }
}

/** Strip surrounding quotes and unescape `\"` / `\\` (command ids are plain ASCII). */
function unquote(literal) {
  const inner = /^"((?:[^"\\]|\\.)*)"$/.exec(literal);
  if (inner === null) return undefined;
  return inner[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** The vendored engine pin, from the `Pinned commit` row of apps/editor/UPSTREAM.md. */
function readEnginePin() {
  const upstream = fs.readFileSync(UPSTREAM_MD, "utf8");
  const row = /^\|\s*Pinned commit\s*\|\s*`([0-9a-f]{7,40})`\s*\|/m.exec(upstream);
  if (row === null) {
    process.stderr.write(`extract-engine-registry: no "Pinned commit" row in ${UPSTREAM_MD}\n`);
    process.exit(1);
  }
  return row[1];
}

function arraysEqual(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, i) => value === b[i])
  );
}

/** Deep equality for the catalog `commands` arrays (order-sensitive, sorted anyway). */
function catalogsEqual(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((entry, i) => {
      const other = b[i];
      if (other === undefined) return false;
      // `deny` is optional: undefined must equal undefined (JSON drops the key).
      return ["id", "title", "category", "paramsDoc", "hasPath", "deny"].every(
        (key) => (entry[key] ?? null) === (other[key] ?? null),
      );
    })
  );
}

/** Classify one catalog entry; `undefined` deny = allowed. */
function classifyCommand(entry) {
  const prefix = entry.id.split(".")[0];
  if (DENY_PREFIXES.includes(prefix)) return denyTagForPrefix(prefix);
  for (const [rule, tag] of DENY_ID_RULES) {
    if (rule.test(entry.id)) return tag;
  }
  if (pathLikeParamNames(entry.paramsDoc).length > 0 && !ALLOW_ADDITIONS.has(entry.id)) {
    return "path-param";
  }
  return undefined;
}

function main() {
  const pin = readEnginePin();
  const warnings = [];
  const registrations = [];
  for (const fileName of fs
    .readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".rs"))
    .sort()) {
    const source = fs.readFileSync(path.join(COMMANDS_DIR, fileName), "utf8");
    scanRegistrations(source, fileName, "cmd", registrations, warnings);
    scanRegistrations(source, fileName, "query", registrations, warnings);
  }

  // The engine's find() keeps the first registration for a duplicated id; mirror that
  // and warn loudly — a duplicate today would mean a scanner bug.
  const ids = [];
  const queries = [];
  const seenCmd = new Map();
  const seenQuery = new Set();
  for (const reg of registrations) {
    if (reg.kind === "cmd") {
      if (seenCmd.has(reg.id)) {
        warnings.push(
          `duplicate cmd id "${reg.id}" (${reg.fileName}:${reg.line}); keeping the first`,
        );
        continue;
      }
      seenCmd.set(reg.id, reg);
      ids.push(reg.id);
    } else if (!seenQuery.has(reg.id)) {
      seenQuery.add(reg.id);
      queries.push(reg.id);
    } else {
      warnings.push(
        `duplicate query id "${reg.id}" (${reg.fileName}:${reg.line}); keeping the first`,
      );
    }
  }
  ids.sort();
  queries.sort();

  if (ids.length === 0 || queries.length === 0) {
    process.stderr.write(
      `extract-engine-registry: scanned ${COMMANDS_DIR} and found ${ids.length} cmd ids / ` +
        `${queries.length} query ids — refusing to write an empty fixture\n`,
    );
    process.exit(1);
  }

  // --- the round-12 catalog (tier 1) + allowed ids (tier 2) -----------------
  const commands = [...ids]
    .sort()
    .map((id) => {
      const reg = seenCmd.get(id);
      const entry = {
        id,
        title: reg?.label ?? "",
        category: id.split(".")[0],
        paramsDoc: reg?.paramsDoc ?? "",
        hasPath: pathLikeParamNames(reg?.paramsDoc ?? "").length > 0,
      };
      const deny = classifyCommand(entry);
      if (deny !== undefined) entry.deny = deny;
      return entry;
    })
    .filter((entry) => {
      if (entry.title === "" || !entry.paramsDoc.startsWith("{")) {
        warnings.push(`catalog: ${entry.id} lacks a label or params doc — excluded`);
        return false;
      }
      return true;
    });
  const allowed = commands
    .filter((entry) => entry.deny === undefined)
    .map((entry) => entry.id)
    .sort();

  // The rescue list must only ever name ids the engine actually registers.
  const knownIds = new Set(ids);
  for (const id of ALLOW_ADDITIONS) {
    if (!knownIds.has(id)) {
      process.stderr.write(`extract-engine-registry: ALLOW_ADDITIONS id "${id}" is not registered\n`);
      process.exit(1);
    }
  }

  if (allowed.length === 0) {
    process.stderr.write("extract-engine-registry: allowlist came out empty — refusing to write\n");
    process.exit(1);
  }

  // --- idempotent writes (preserve the committed stamps when content is unchanged)
  const writeArtifact = (file, payload, isUnchanged) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    return isUnchanged ? "unchanged" : "wrote";
  };

  // Fixture (unchanged shape since M5-J).
  let extractedAt = new Date().toISOString();
  let fixtureStatus = "wrote";
  if (fs.existsSync(FIXTURE_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
      if (
        existing.enginePin === pin &&
        arraysEqual(existing.ids, ids) &&
        arraysEqual(existing.queries, queries)
      ) {
        extractedAt = existing.extractedAt;
        fixtureStatus = "unchanged";
      }
    } catch {
      fixtureStatus = "wrote"; // unreadable/invalid fixture — regenerate it
    }
  }
  const fixture = { extractedAt, enginePin: pin, ids, queries };
  writeArtifact(FIXTURE_PATH, fixture, fixtureStatus === "unchanged");

  // Catalog (tier 1).
  let generatedAt = new Date().toISOString();
  let catalogStatus = "wrote";
  if (fs.existsSync(CATALOG_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
      if (existing.version === CATALOG_VERSION && catalogsEqual(existing.commands, commands)) {
        generatedAt = existing.generatedAt;
        catalogStatus = "unchanged";
      }
    } catch {
      catalogStatus = "wrote"; // unreadable/invalid artifact — regenerate it
    }
  }
  const catalog = { version: CATALOG_VERSION, generatedAt, commands };
  catalogStatus = writeArtifact(CATALOG_PATH, catalog, catalogStatus === "unchanged");

  // Allowed ids (tier 2 — bare sorted string[]).
  let allowedStatus = "wrote";
  if (fs.existsSync(ALLOWED_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(ALLOWED_PATH, "utf8"));
      if (arraysEqual(existing, allowed)) allowedStatus = "unchanged";
    } catch {
      allowedStatus = "wrote";
    }
  }
  allowedStatus = writeArtifact(ALLOWED_PATH, allowed, allowedStatus === "unchanged");

  // Read-only query ids (tier 2 — w8 harness fix): `query!` registrations are
  // never batchable, so they stay OUT of the allowed list — but the params
  // docs REFERENCE them (anim.applyBuiltinPreset says "see anim.builtinPresets"),
  // so the model keeps proposing them and the old describe_command answer
  // ("not an allowed command id. Discover ids with studio.list_commands.")
  // looped forever: list_commands filters to ALLOWED and can never surface
  // them. Emit the non-denied query ids so describe_command can answer for
  // them (readOnly: true) and the error can name the id honestly.
  const readQueries = queries.filter((id) => {
    const prefix = id.split(".")[0] ?? "";
    return !DENY_PREFIXES.includes(prefix);
  });
  let readQueriesStatus = "wrote";
  if (fs.existsSync(READ_QUERIES_PATH)) {
    try {
      if (arraysEqual(JSON.parse(fs.readFileSync(READ_QUERIES_PATH, "utf8")), readQueries))
        readQueriesStatus = "unchanged";
    } catch {
      readQueriesStatus = "wrote";
    }
  }
  readQueriesStatus = writeArtifact(READ_QUERIES_PATH, readQueries, readQueriesStatus === "unchanged");

  // The built-in preset library (tier 2 — w8 harness fix): the model needs
  // preset NAMES to call anim.applyBuiltinPreset/text.presets/comp.presets.
  // The names live in the vendored engine's presets dir; emitting them here
  // keeps the same engine-pin provenance as everything else. Names only —
  // descriptions would bloat the digest.
  const presetCategories = [];
  if (fs.existsSync(PRESETS_DIR)) {
    for (const fileName of fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, fileName), "utf8"));
        const items = Array.isArray(data) ? data : (data.presets ?? []);
        const names = items
          .map((item) => (item && typeof item === "object" ? item.name : null))
          .filter((name) => typeof name === "string" && name.length > 0);
        if (names.length > 0)
          presetCategories.push({ category: fileName.replace(/\.json$/, ""), presets: names });
      } catch (error) {
        warnings.push(`preset-library: ${fileName} unreadable (${error.message}) — skipped`);
      }
    }
  }
  let presetStatus = "wrote";
  if (fs.existsSync(PRESET_LIBRARY_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(PRESET_LIBRARY_PATH, "utf8"));
      if (JSON.stringify(existing) === JSON.stringify(presetCategories)) presetStatus = "unchanged";
    } catch {
      presetStatus = "wrote";
    }
  }
  presetStatus = writeArtifact(PRESET_LIBRARY_PATH, presetCategories, presetStatus === "unchanged");

  for (const warning of warnings)
    process.stderr.write(`extract-engine-registry: warning: ${warning}\n`);
  process.stdout.write(
    `${JSON.stringify({
      enginePin: pin,
      mutating: ids.length,
      queries: queries.length,
      catalog: commands.length,
      allowed: allowed.length,
      denied: commands.length - allowed.length,
      status: fixtureStatus,
      catalogStatus,
      allowedStatus,
      readQueriesStatus,
      readQueries: readQueries.length,
      presetStatus,
      presets: presetCategories.reduce((sum, cat) => sum + cat.presets.length, 0),
      fixture: path.relative(REPO_ROOT, FIXTURE_PATH),
    })}\n`,
  );
}

main();
