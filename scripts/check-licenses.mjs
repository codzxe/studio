#!/usr/bin/env node
// scripts/check-licenses.mjs — license policy gate for the studio monorepo.
//
// Spec: docs/BUILD_PROMPT.md §16.0 (license policy), §16.5 (avoid list), §1.5 rules
// 8–9 (licensing + attribution). AGENTS.md "Forbidden": no AGPL/SSPL/BUSL/RSALv2/
// Elastic-license deps, no font files committed, no secrets in the repo.
//
// Zero-dependency script (node stdlib only: fs/path/url + child_process for one
// `git ls-files` call) — it runs offline and never queries the npm registry.
// Wired as `pnpm check:licenses` (root package.json).
//
// What it enforces:
//   1. Every external dependency of root + apps/*/ + packages/*/package.json is
//      declared in `licenses.overrides.json` (repo root) with a license.
//      Workspace-internal packages (@studio/*, workspace: protocol) are skipped.
//   2. Every declared license passes the §16.0 allowlist:
//        ALLOW: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
//               PostgreSQL, MPL-2.0* (* unmodified files + notice only, §16.0)
//        DENY:  AGPL*, SSPL*, BUSL*, RSAL*, Elastic*, FSL*, Sustainable-Use,
//               GPL/LGPL (copyleft: internal unmodified utilities only, §16.0),
//               UNLICENSED/PROPRIETARY, anything not explicitly allowed.
//   3. No font binaries are committed (*.ttf/*.otf/*.ttc/*.woff/*.woff2 — fonts come
//      from CRAFT_FONTS_DIR, §1.5 rule 9) and no .env secret files are committed
//      (.env.example/.env.sample templates are allowed). The scan walks the git
//      index — i.e. what WOULD be committed — not the working tree: build-time
//      font files under editor/assets/fonts/ and a developer's local .env live
//      on disk untracked by design (W3-C4 fix, see listCommittedFiles()).
//
// Exit codes: 0 = pass; 1 = any DENY, any UNKNOWN/undeclared dependency, any
// forbidden file. Entries with status "TODO-verify" warn but pass — they are
// declared from offline knowledge and CI must confirm them against package
// metadata; set LICENSE_CHECK_STRICT=1 (or --strict) to make them fatal.
//
// Adding a dependency (also printed on failure):
//   1. Add it to licenses.overrides.json:
//        "name": { "license": "<SPDX>", "source": "<where you verified it>" }
//      Unsure of the license? add "status": "TODO-verify".
//   2. If it ships to users, add an ATTRIBUTION.md row in the same change (§1.5
//      rule 9) and make sure its license text exists under LICENSES/.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const MANIFEST_PATH = join(repoRoot, "licenses.overrides.json");
const STRICT = process.env.LICENSE_CHECK_STRICT === "1" || process.argv.includes("--strict");

const out = (line = "") => process.stdout.write(`${line}\n`);
const rel = (p) => relative(repoRoot, p);

// ---------------------------------------------------------------------------
// §16.0 / §16.5 policy tables (spec is authoritative; extend only with a spec note)
// ---------------------------------------------------------------------------

const ALLOW = new Set([
  "MIT",
  "APACHE-2.0",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "ISC",
  "0BSD",
  "POSTGRESQL",
  "MPL-2.0",
]);

// Allowed, but only under the §16.0 condition (printed as a notice).
const ALLOW_CONDITIONAL = new Map([
  [
    "MPL-2.0",
    "MPL-2.0 is allowed only for unmodified files, kept identifiable, notices retained (§16.0)",
  ],
]);

const DENY_RULES = [
  {
    match: (a) => a.startsWith("AGPL"),
    label: "AGPL — forbidden by §16.5 without written legal review",
  },
  { match: (a) => a.startsWith("SSPL"), label: "SSPL — forbidden by §16.5" },
  {
    match: (a) => a.startsWith("BUSL"),
    label: "BUSL (Business Source License) — forbidden by §16.5",
  },
  {
    match: (a) => a.startsWith("RSAL"),
    label:
      "RSALv2 (Redis Source Available License) — forbidden by §16.5; use Valkey (BSD-3-Clause)",
  },
  { match: (a) => a.startsWith("ELASTIC"), label: "Elastic License — forbidden by §16.5" },
  {
    match: (a) => a.startsWith("FSL"),
    label: "FSL (Functional Source License) — forbidden by §16.5",
  },
  {
    match: (a) => a === "SUSTAINABLE-USE" || a === "SUSTAINABLE USE LICENSE",
    label: "Sustainable Use License — forbidden by §16.5",
  },
  {
    match: (a) => a === "UNLICENSED" || a === "PROPRIETARY" || a.startsWith("SEE LICENSE"),
    label: "unlicensed/proprietary — not allowed in the closed core",
  },
  {
    match: (a) => a.startsWith("GPL"),
    label:
      "GPL/LGPL copyleft — not allowed as a product dependency (§16.0: copyleft tools are fine only as internal, unmodified, separately-run utilities)",
  },
  {
    match: (a) => a.startsWith("CC-BY-NC") || a.startsWith("CC-BY-SA") || a.startsWith("CC-BY-ND"),
    label: "restrictive Creative Commons license — not in the §16.0 allowlist",
  },
];

// Common non-SPDX spellings normalized to allowlist identifiers. Deliberately NOT
// mapping bare "BSD" or "MPL" — ambiguous forms must be written out precisely.
const ALIASES = {
  "MIT LICENSE": "MIT",
  X11: "MIT",
  "APACHE 2.0": "APACHE-2.0",
  "APACHE-2": "APACHE-2.0",
  "APACHE LICENSE 2.0": "APACHE-2.0",
  "APACHE SOFTWARE LICENSE": "APACHE-2.0",
  "BSD-2": "BSD-2-CLAUSE",
  "BSD 2-CLAUSE": "BSD-2-CLAUSE",
  "SIMPLIFIED BSD": "BSD-2-CLAUSE",
  "BSD-3": "BSD-3-CLAUSE",
  "BSD 3-CLAUSE": "BSD-3-CLAUSE",
  "NEW BSD": "BSD-3-CLAUSE",
  "MODIFIED BSD": "BSD-3-CLAUSE",
  "REVISED BSD": "BSD-3-CLAUSE",
  "ISC LICENSE": "ISC",
  "ZERO-CLAUSE BSD": "0BSD",
  "MOZILLA PUBLIC LICENSE 2.0": "MPL-2.0",
  "MPL-2": "MPL-2.0",
  POSTGRES: "POSTGRESQL",
  "POSTGRESQL LICENSE": "POSTGRESQL",
};

function normalizeAtom(raw) {
  const key = raw.replace(/\s+/g, " ").trim().toUpperCase();
  return ALIASES[key] ?? key;
}

/** Classify a license expression → { verdict: allow|conditional|deny|unknown, reason? }. */
function classify(raw) {
  const expr = String(raw ?? "").trim();
  if (!expr) return { verdict: "unknown", reason: "no license declared" };

  // SPDX choice ("MIT OR Apache-2.0"): any allowed branch makes it usable.
  const orParts = expr
    .split(" OR ")
    .map((p) => p.trim())
    .filter(Boolean);
  if (orParts.length > 1) {
    const parts = orParts.map(classify);
    const allowed = parts.find((p) => p.verdict === "allow" || p.verdict === "conditional");
    if (allowed) return allowed;
    if (parts.every((p) => p.verdict === "deny")) return parts[0];
    return { verdict: "unknown", reason: "no §16.0-allowed branch in compound license" };
  }

  // SPDX conjunction ("A AND B"): every branch must pass.
  const andParts = expr
    .split(" AND ")
    .map((p) => p.trim())
    .filter(Boolean);
  if (andParts.length > 1) {
    const parts = andParts.map(classify);
    const denied = parts.find((p) => p.verdict === "deny");
    if (denied) return denied;
    const unknown = parts.find((p) => p.verdict === "unknown");
    if (unknown) return unknown;
    return parts.find((p) => p.verdict === "conditional") ?? { verdict: "allow" };
  }

  // "X WITH <exception>": evaluate the base license; the exception rides along.
  const withIdx = expr.toUpperCase().indexOf(" WITH ");
  const base = withIdx >= 0 ? expr.slice(0, withIdx) : expr;
  const atom = normalizeAtom(base);

  const deny = DENY_RULES.find((r) => r.match(atom));
  if (deny) return { verdict: "deny", reason: deny.label };
  if (ALLOW.has(atom)) {
    if (ALLOW_CONDITIONAL.has(atom))
      return { verdict: "conditional", reason: ALLOW_CONDITIONAL.get(atom) };
    return { verdict: "allow" };
  }
  return { verdict: "unknown", reason: `"${expr}" is not in the §16.0 allowlist` };
}

// ---------------------------------------------------------------------------
// Dependency collection (root + apps/* + packages/*)
// ---------------------------------------------------------------------------

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function isWorkspaceInternal(name, spec) {
  return name.startsWith("@studio/") || (typeof spec === "string" && spec.startsWith("workspace:"));
}

function collectPackageManifests() {
  const manifests = [];
  const root = join(repoRoot, "package.json");
  if (existsSync(root)) manifests.push({ location: "(root)", path: root });
  for (const dir of ["apps", "packages"]) {
    let entries = [];
    try {
      entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const pkgPath = join(repoRoot, dir, entry.name, "package.json");
      if (existsSync(pkgPath)) manifests.push({ location: `${dir}/${entry.name}`, path: pkgPath });
    }
  }
  return manifests;
}

// ---------------------------------------------------------------------------
// Repo tree scan (font binaries + .env files)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
]);
const FONT_EXTS = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);

function* walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function isEnvSecretFile(name) {
  const lower = name.toLowerCase();
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) {
    return !(lower.endsWith(".example") || lower.endsWith(".sample"));
  }
  return false;
}

// Files that would be committed: the git index is the source of truth for §1.5
// rule 9 / AGENTS.md "Forbidden" (font binaries, .env secrets — the checks below
// and their error messages all say "committed"). The pre-W3-C4 implementation
// walked the whole working tree, which false-positived on legitimate UNTRACKED
// local files: the editor build's font binaries under editor/assets/fonts/
// (required on disk by crates/text/src/fonts.rs include_bytes!, supplied by
// CRAFT_FONTS_DIR) and a dev-box .env. Falls back to the working-tree walk only
// when git is unavailable (e.g. an exported tree without .git), preserving the
// old behavior there.
function listCommittedFiles() {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return out
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((f) => join(repoRoot, f));
  } catch {
    return [...walk(repoRoot)];
  }
}

// ---------------------------------------------------------------------------
// Manifest (licenses.overrides.json)
// ---------------------------------------------------------------------------

function normalizeEntry(name, raw) {
  if (typeof raw === "string") {
    return {
      license: raw,
      status: "declared",
      kind: "npm",
      note: "",
      source: "manifest shorthand",
    };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      license: typeof raw.license === "string" ? raw.license : "",
      status: typeof raw.status === "string" ? raw.status : "declared",
      kind: typeof raw.kind === "string" ? raw.kind : "npm",
      note: typeof raw.note === "string" ? raw.note : "",
      source: typeof raw.source === "string" ? raw.source : "",
    };
  }
  return {
    license: "",
    status: "invalid",
    kind: "npm",
    note: `invalid entry for "${name}"`,
    source: "",
  };
}

function loadManifestEntries(errors) {
  if (!existsSync(MANIFEST_PATH)) {
    errors.push(
      `licenses.overrides.json is missing at the repo root (${rel(MANIFEST_PATH)}). Create it with a "packages" map — see the file header of scripts/check-licenses.mjs for the format.`,
    );
    return null;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    errors.push(`licenses.overrides.json is not valid JSON: ${err.message}`);
    return null;
  }
  const rawEntries =
    data && typeof data === "object" && data.packages && typeof data.packages === "object"
      ? data.packages
      : null;
  if (!rawEntries) {
    errors.push(
      'licenses.overrides.json must contain a "packages" object mapping dependency name → license entry.',
    );
    return null;
  }
  const entries = new Map();
  for (const [name, raw] of Object.entries(rawEntries)) {
    entries.set(name, normalizeEntry(name, raw));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const errors = [];
const warnings = [];
const notices = [];
const counts = { ok: 0, conditional: 0, internal: 0, todoVerify: 0, unused: 0 };

const manifests = collectPackageManifests();
if (manifests.length === 0) {
  errors.push(
    "no package.json found at root, apps/* or packages/* — nothing to check (is this the repo root?)",
  );
}

const deps = new Map(); // name → { spec, locations: Set<string> }
for (const { location, path } of manifests) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`${rel(path)}: cannot parse package.json (${err.message})`);
    continue;
  }
  for (const field of DEP_FIELDS) {
    const fieldDeps = pkg[field];
    if (!fieldDeps || typeof fieldDeps !== "object") continue;
    for (const [name, spec] of Object.entries(fieldDeps)) {
      if (isWorkspaceInternal(name, spec)) {
        counts.internal += 1;
        continue;
      }
      const record = deps.get(name) ?? { spec: String(spec), locations: new Set() };
      record.locations.add(location);
      deps.set(name, record);
    }
  }
}

const entries = loadManifestEntries(errors);

const where = (locations) => [...locations].sort().join(", ");

// 1) Every external dependency must be declared and its license allowed.
if (entries) {
  for (const [name, { spec, locations }] of [...deps.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entry = entries.get(name);
    if (!entry) {
      errors.push(
        `[unknown] "${name}" (${spec}) used in: ${where(locations)} — not declared in licenses.overrides.json.\n        Fix: add   "${name}": { "license": "<SPDX>", "source": "<verified where>" }   to the "packages" map.\n        Unsure? add "status": "TODO-verify". If it ships to users, also add an ATTRIBUTION.md\n        row and its license text under LICENSES/ (spec §1.5 rule 9, §16.0).`,
      );
      continue;
    }
    if (entry.status === "invalid" || entry.license === "") {
      errors.push(
        `[unknown] "${name}" has an invalid entry in licenses.overrides.json (missing "license" string). Fix the entry.`,
      );
      continue;
    }
    const verdict = classify(entry.license);
    if (verdict.verdict === "deny") {
      errors.push(
        `[deny] "${name}" (${spec}; ${where(locations)}): ${entry.license} — ${verdict.reason}`,
      );
      continue;
    }
    if (verdict.verdict === "unknown") {
      errors.push(
        `[unknown] "${name}" (${spec}; ${where(locations)}): ${verdict.reason}.\n        If this is genuinely a §16.0-class permissive license, add it to ALLOW in\n        scripts/check-licenses.mjs with a spec citation; otherwise replace the dependency.`,
      );
      continue;
    }
    if (entry.status === "TODO-verify") {
      const msg = `[verify] "${name}" (${where(locations)}): declared ${entry.license} from offline knowledge (${entry.source || "no source given"}) — confirm against package metadata in CI.`;
      counts.todoVerify += 1;
      if (STRICT) errors.push(msg);
      else warnings.push(msg);
    }
    if (entry.kind === "infra") {
      warnings.push(
        `"${name}" is declared with kind "infra" but is a real package.json dependency — fix the manifest entry kind.`,
      );
    }
    if (verdict.verdict === "conditional") {
      counts.conditional += 1;
      notices.push(`[conditional] "${name}" (${entry.license}): ${verdict.reason}`);
    }
    counts.ok += 1;
  }

  // 2) Audit manifest rows that no package.json uses (deny anywhere in the manifest
  //    fails, used or not — used rows were already classified in the loop above).
  for (const [name, entry] of [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (deps.has(name)) continue;
    const verdict = classify(entry.license);
    if (verdict.verdict === "deny") {
      errors.push(
        `[deny] manifest entry "${name}" declares ${entry.license} — ${verdict.reason}. Remove the row or the dependency.`,
      );
      continue;
    }
    if (verdict.verdict === "unknown") {
      errors.push(
        `[unknown] manifest entry "${name}" declares ${entry.license || "(missing)"} — not in the §16.0 allowlist. Remove the row, or extend ALLOW in scripts/check-licenses.mjs with a spec citation.`,
      );
      continue;
    }
    if (entry.kind === "infra") continue; // infrastructure declarations are expected not to be npm deps
    counts.unused += 1;
    notices.push(
      `[info] manifest entry "${name}" matches no current dependency (leftover? fine to keep if a re-add is planned).`,
    );
  }
}

// 3) No committed font binaries, no .env secrets (AGENTS.md Forbidden, §1.5 rule 9).
let fontsFound = 0;
let envFilesFound = 0;
for (const path of listCommittedFiles()) {
  if (FONT_EXTS.has(extname(path).toLowerCase())) {
    fontsFound += 1;
    errors.push(
      `[forbidden file] ${rel(path)} — font binaries are never committed (spec §1.5 rule 9, AGENTS.md). Fonts come from CRAFT_FONTS_DIR at build time.`,
    );
  } else if (isEnvSecretFile(basename(path))) {
    envFilesFound += 1;
    errors.push(
      `[forbidden file] ${rel(path)} — .env files must never be committed (secrets; AGENTS.md). Use .env.example templates only.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

out("studio license check — spec §16.0/§16.5, §1.5 rules 8–9 (licenses + fonts + secrets)");
out(
  `manifest: ${rel(MANIFEST_PATH)} (${entries ? entries.size : 0} entries, strict mode: ${STRICT ? "on" : "off"})`,
);
out(
  `scanned:  ${manifests.length} package.json (root + apps/* + packages/*), ${deps.size} external dependencies`,
);
out(
  `deps:     ${counts.ok} allowed (${counts.conditional} conditional), ${counts.internal} workspace-internal skipped, ${counts.todoVerify} TODO-verify, ${counts.unused} unused manifest rows`,
);
out("");

if (notices.length > 0) {
  for (const n of notices) out(n);
  out("");
}
if (warnings.length > 0) {
  for (const w of warnings) out(w);
  out("");
}
if (errors.length > 0) {
  out(`FAIL — ${errors.length} violation(s):`);
  out("");
  for (const e of errors) out(e);
  out("");
  out("How to fix: see scripts/check-licenses.mjs header — add a licenses.overrides.json row");
  out("(+ ATTRIBUTION.md row and LICENSES/ text if it ships), or remove the dependency/file.");
  process.exitCode = 1;
} else {
  out(
    `PASS — ${counts.ok} declared dependencies allowed, 0 font binaries committed, 0 .env files committed.`,
  );
}
