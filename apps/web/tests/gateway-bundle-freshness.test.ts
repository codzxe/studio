import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Gateway bundle freshness — the SEC-01 recurrence guard, moved into the
 * DEFAULT test run (the CI `gateway-bundle-drift` job only fires after the
 * push, and the 2026-11-01 incident proved nobody looks there in time:
 * ~24h of gateway/contracts fixes — create_text `opacity`,
 * create_composition `background`, turn-time layer verdicts, color repair —
 * sat out of the committed bundle while every suite stayed green, because
 * the committed `api/gateway.mjs` IS the runtime the /v1 route executes).
 *
 * This test runs the canonical in-memory rebuild (`scripts/
 * build-gateway-bundle.mjs --check`, which never mutates the working tree)
 * and fails with the exact remediation whenever the committed artifact does
 * not match the source it is supposed to ship.
 */
describe("gateway bundle freshness (SEC-01 recurrence guard)", () => {
  it("committed apps/web/api/gateway.mjs byte-matches a rebuild of gateway/contracts source", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const script = join(repoRoot, "scripts", "build-gateway-bundle.mjs");
    const run = spawnSync(process.execPath, [script, "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    // On failure the script's remediation (run bundle:gateway, commit the
    // artifact) is the assertion message — the fixer sees the fix, not a
    // bare boolean.
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
    expect(run.status, output).toBe(0);
  }, 30_000);
});
