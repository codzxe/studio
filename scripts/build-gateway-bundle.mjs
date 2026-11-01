#!/usr/bin/env node
// scripts/build-gateway-bundle.mjs — the ONE canonical build of the gateway
// bundle (apps/web/api/gateway.mjs).
//
// WHY THIS EXISTS (root-cause fix, 2026-11-01): the committed bundle IS the
// runtime — the /v1 Next route (src/app/v1/[...path]/route.ts) and the
// GATEWAY_INLINE seam both import it — so any gateway/contracts source change
// that is not followed by a bundle rebuild never ships. Tests stay green
// (they run against source) while users keep hitting pre-fix schemas:
// SEC-01 shipped pre-fix SECURITY fixes this way, and on 2026-11-01 the same
// failure class shipped ~24h of agent fixes (create_text `opacity`,
// create_composition `background`, turn-time layer-reference verdicts,
// color repair) while every suite passed. A CI gate after the push is not
// enough — the fixer never looks; the failure has to fire where the work
// happens. Hence:
//
//   node scripts/build-gateway-bundle.mjs           → writes the bundle
//   node scripts/build-gateway-bundle.mjs --check   → rebuilds IN MEMORY and
//       byte-compares against the committed artifact; exit 1 + remediation
//       when they differ. Never mutates the working tree (safe in tests).
//
// Consumers:
//   * apps/web package.json `bundle:gateway` (the CI `gateway-bundle-drift`
//     gate and scripts/ci-local.sh gate run it through the same script), and
//   * apps/web/tests/gateway-bundle-freshness.test.ts, which runs `--check`
//     on EVERY default `pnpm --filter @studio/web test` run — a stale bundle
//     now fails the suite the fixer actually watches, in the same commit.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const WEB_DIR = join(REPO_ROOT, "apps", "web");
const OUTFILE = join(WEB_DIR, "api", "gateway.mjs");
const ENTRY = join(WEB_DIR, "api-src", "gateway.ts");
const TSCONFIG = join(WEB_DIR, "api-src", "tsconfig.json");

// Resolve esbuild from apps/web's own dependency graph, independent of cwd —
// the script must behave identically from the repo root, from apps/web, and
// from a vitest worker.
const webRequire = createRequire(join(WEB_DIR, "package.json"));
const esbuild = webRequire("esbuild");

// Byte-identical to the historical CLI invocation
// (`esbuild --bundle api-src/gateway.ts --tsconfig api-src/tsconfig.json
//   --platform=node --format=esm --target=node22 --banner:js=… --outfile=…`),
// so switching the package.json script to this module does not churn the
// artifact. absWorkingDir pins esbuild's path resolution (the bundled
// `// path` comments are cwd-relative otherwise — a different cwd would
// produce a false-positive drift).
const BANNER_JS =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

async function buildBundle({ write }) {
  return esbuild.build({
    absWorkingDir: WEB_DIR,
    entryPoints: ["api-src/gateway.ts"],
    bundle: true,
    tsconfig: "api-src/tsconfig.json",
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: BANNER_JS },
    outfile: "api/gateway.mjs", // names the output; with write:false nothing hits disk
    write,
    logLevel: write ? "info" : "silent",
  });
}

const check = process.argv.includes("--check");

if (!check) {
  await buildBundle({ write: true });
  process.exit(0);
}

// --check: rebuild in memory, byte-compare with the committed artifact.
const result = await buildBundle({ write: false });
const built = Buffer.from(result.outputFiles[0].contents);

let committed;
try {
  committed = readFileSync(OUTFILE);
} catch {
  console.error(
    `gateway bundle freshness: ${OUTFILE} is MISSING. Run:
  corepack pnpm --filter @studio/web bundle:gateway
…then commit the result (the /v1 route imports this file — the product cannot start without it).`,
  );
  process.exit(1);
}

if (Buffer.compare(built, committed) !== 0) {
  console.error(
    `gateway bundle is STALE — the committed apps/web/api/gateway.mjs does not match a rebuild of the gateway/contracts source.
Every fix that lands only in source is INVISIBLE to the running product: the /v1 route executes the committed bundle,
and tests stay green because they run against source. This is exactly how SEC-01 and the 2026-11-01 'Unrecognized key: "opacity"'
incident shipped fixed code to users that was never built.

Fix for real (same commit as the source change):
  corepack pnpm --filter @studio/web bundle:gateway
  git add apps/web/api/gateway.mjs && git commit`,
  );
  process.exit(1);
}

console.log(
  "gateway bundle freshness: committed bundle matches a rebuild of gateway/contracts source.",
);
