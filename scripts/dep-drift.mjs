// Round 5 — dependency drift audit across ALL pnpm workspace manifests.
// Finds every dependency that appears with MORE THAN ONE distinct range
// across the manifests and prints an alignment proposal (highest range wins).
// Usage: node scripts/dep-drift.mjs [--write]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/z/my-project";
const WRITE = process.argv.includes("--write");

function findManifests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.name === "editor" || entry.name === "archive") continue; // vendored upstream (apps/editor) + archive
    const p = join(dir, entry.name);
    if (entry.isDirectory()) findManifests(p, out);
    else if (entry.name === "package.json") out.push(p);
  }
  return out;
}

const manifests = [
  join(ROOT, "package.json"),
  ...findManifests(join(ROOT, "apps"), []),
  ...findManifests(join(ROOT, "services"), []),
  ...findManifests(join(ROOT, "packages"), []),
  join(ROOT, "evals", "package.json"),
].filter((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});

const depSections = ["dependencies", "devDependencies", "peerDependencies"];
const byDep = new Map(); // name -> [{manifest, section, range}]
const byDepSectionAware = new Map(); // name|section -> [...]

for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  for (const section of depSections) {
    const block = pkg[section] ?? {};
    for (const [name, range] of Object.entries(block)) {
      const key = `${name}|${section}`;
      if (!byDepSectionAware.has(key)) byDepSectionAware.set(key, []);
      byDepSectionAware.get(key).push({ manifest, section, name, range });
      if (!byDep.has(name)) byDep.set(name, []);
      byDep.get(name).push({ manifest, section, range });
    }
  }
}

// A dep is "drifted" when the SAME dep (any section) carries >1 distinct range.
const drifted = [];
for (const [key, entries] of byDepSectionAware) {
  const ranges = new Set(entries.map((e) => e.range));
  if (ranges.size > 1) drifted.push({ key, entries });
}

const cmp = (a, b) => a.localeCompare(b);
console.log(`manifests scanned: ${manifests.length}`);
console.log(`drifted dependency|section combos: ${drifted.length}\n`);

function highestRange(ranges) {
  // Sort by the leading numeric part descending; caret/tilde neutral.
  const num = (r) => Number(r.replace(/[^0-9.]/g, "").split(".")[0] || 0);
  return [...ranges].sort((a, b) => num(b) - num(a) || a.localeCompare(b))[0];
}

for (const { key, entries } of drifted.sort((a, b) => cmp(a.key, b.key))) {
  const ranges = [...new Set(entries.map((e) => e.range))];
  const winner = highestRange(ranges);
  console.log(`${key}`);
  for (const e of entries.sort((a, b) => cmp(a.manifest, b.manifest))) {
    const mark = e.range === winner ? " " : "*";
    console.log(`  ${mark} ${e.manifest.replace(`${ROOT}/`, "")}: ${e.range}`);
  }
  console.log(`  -> align to: ${winner}`);
}

if (WRITE) {
  for (const { key, entries } of drifted) {
    const ranges = [...new Set(entries.map((e) => e.range))];
    const winner = highestRange(ranges);
    for (const e of entries) {
      const pkg = JSON.parse(readFileSync(e.manifest, "utf8"));
      if (pkg[e.section]?.[e.name] !== undefined) {
        pkg[e.section][e.name] = winner;
        writeFileSync(e.manifest, `${JSON.stringify(pkg, null, 2)}\n`);
      }
    }
  }
  console.log("\n[write] manifests aligned — run `pnpm install` to refresh the lockfile.");
}
