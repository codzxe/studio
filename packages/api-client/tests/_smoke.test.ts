import { describe, expect, it } from "vitest";

// Smoke check (not committed): validateFixtures + reduceEvents on the demo runs.
import { reduceEvents } from "@studio/contracts";
import { fixtures, validateFixtures } from "../src/fixtures.js";

const issues = validateFixtures();
it("fixtures valid", () => {
  expect(issues).toEqual([]);
});
const _ = issues;
if (issues.length > 0) {
  console.error("FIXTURE ISSUES:");
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log("fixtures valid");

const applied = reduceEvents(fixtures.runs.applied.events);
console.log(
  "applied:",
  applied.status,
  "text:",
  applied.text.slice(0, 40),
  "version:",
  applied.versionId,
);
const undoneState = reduceEvents([
  ...fixtures.runs.undone.events,
  ...fixtures.runs.undone.clientActions,
]);
console.log("undone:", undoneState.status);
if (applied.status !== "applied" || undoneState.status !== "undone") {
  console.error("run folding mismatch");
  process.exit(1);
}
const last = fixtures.credits.ledger[fixtures.credits.ledger.length - 1];
if (last === undefined || last.balanceAfter !== fixtures.credits.summary.balance) {
  console.error("ledger does not balance to summary");
  process.exit(1);
}
console.log("ledger balances:", last?.balanceAfter);
