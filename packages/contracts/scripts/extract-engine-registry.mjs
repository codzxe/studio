#!/usr/bin/env node
// @studio/contracts — extract the REAL EffectCraft engine command registry.
//
// Scans the vendored, frozen engine sources (`editor/` — READ ONLY) for `cmd!` and
// `query!` macro registrations and emits `fixtures/engine-command-ids.json`:
//
//   { "extractedAt": "<ISO 8601>", "enginePin": "<sha>", "ids": [...], "queries": [...] }
//
// Grammar (editor/crates/engine/src/commands/mod.rs:119-153):
//   cmd!(id, label, [menus], shortcut, "{params doc}", enabled_guard, handler)
//   query!(id, label, "{params doc}", handler)                 // journal: false — read-only
//
// Registration invocations span MULTIPLE lines (e.g. layer.rs `layer.newText`), so the
// scanner tracks string literals and (), [], {} depth, splits top-level arguments at
// depth-1 commas, and keeps only invocations whose FIRST argument is a string literal
// (macro-definition bodies such as `$crate::cmd!($id, …)` in mod.rs and the local
// wrapper macros `style_cmd!` / `view_cmd!` use `$`-variables and are skipped by that
// same check).
//
// Known, deliberate scope (see the M5-J worklog for the full survey):
//   * Only `editor/crates/engine/src/commands/*.rs` is scanned, per the M5 seam. The
//     live engine ALSO registers a handful of ids elsewhere: models.rs / templates.rs /
//     storage.rs / preview.rs / learn.rs (~26 `cmd!`/`query!` — model install/download,
//     template file ops, storage.clear, tutorials: all file-system or destructive, so
//     never agent-batchable), the raw `CommandSpec` literal for `engine.batch`
//     (batch.rs — transport/meta), and viewer/frontend ids registered through the local
//     `fe!` / `res!` / `fast!` / `chan!` wrappers (UI handoffs; zero agent relevance).
//     None of those are curated, so none need fixture provenance.
//   * `query!` ids land in `queries` (read-only, `journal: false`); they are never
//     batchable and never enter the curated agent registry.
//
// Idempotence: re-running with unchanged engine sources and pin rewrites NOTHING
// (the existing `extractedAt` is preserved), so `git diff` stays clean. Run from the
// package dir (`node scripts/extract-engine-registry.mjs`) or from anywhere else —
// paths resolve from this file's location, not the cwd.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const COMMANDS_DIR = path.join(REPO_ROOT, "editor", "crates", "engine", "src", "commands");
const UPSTREAM_MD = path.join(REPO_ROOT, "editor", "UPSTREAM.md");
const FIXTURE_PATH = path.join(PACKAGE_DIR, "fixtures", "engine-command-ids.json");

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
    out.push({ id, line, fileName, kind });
  }
}

/** Strip surrounding quotes and unescape `\"` / `\\` (command ids are plain ASCII). */
function unquote(literal) {
  const inner = /^"((?:[^"\\]|\\.)*)"$/.exec(literal);
  if (inner === null) return undefined;
  return inner[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** The vendored engine pin, from the `Pinned commit` row of editor/UPSTREAM.md. */
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

function main() {
  const pin = readEnginePin();
  const warnings = [];
  const registrations = [];
  for (const fileName of fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".rs")).sort()) {
    const source = fs.readFileSync(path.join(COMMANDS_DIR, fileName), "utf8");
    scanRegistrations(source, fileName, "cmd", registrations, warnings);
    scanRegistrations(source, fileName, "query", registrations, warnings);
  }

  // The engine's find() keeps the first registration for a duplicated id; mirror that
  // and warn loudly — a duplicate today would mean a scanner bug.
  const ids = [];
  const queries = [];
  const seenCmd = new Set();
  const seenQuery = new Set();
  for (const reg of registrations) {
    if (reg.kind === "cmd") {
      if (seenCmd.has(reg.id)) {
        warnings.push(`duplicate cmd id "${reg.id}" (${reg.fileName}:${reg.line}); keeping the first`);
        continue;
      }
      seenCmd.add(reg.id);
      ids.push(reg.id);
    } else if (!seenQuery.has(reg.id)) {
      seenQuery.add(reg.id);
      queries.push(reg.id);
    } else {
      warnings.push(`duplicate query id "${reg.id}" (${reg.fileName}:${reg.line}); keeping the first`);
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

  // Idempotence: preserve the committed extractedAt when the extraction is unchanged.
  let extractedAt = new Date().toISOString();
  let status = "wrote";
  if (fs.existsSync(FIXTURE_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
      if (
        existing.enginePin === pin &&
        arraysEqual(existing.ids, ids) &&
        arraysEqual(existing.queries, queries)
      ) {
        extractedAt = existing.extractedAt;
        status = "unchanged";
      }
    } catch {
      status = "wrote"; // unreadable/invalid fixture — regenerate it
    }
  }

  const fixture = { extractedAt, enginePin: pin, ids, queries };
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

  for (const warning of warnings) process.stderr.write(`extract-engine-registry: warning: ${warning}\n`);
  process.stdout.write(
    `${JSON.stringify({
      enginePin: pin,
      mutating: ids.length,
      queries: queries.length,
      status,
      fixture: path.relative(REPO_ROOT, FIXTURE_PATH),
    })}\n`,
  );
}

main();
