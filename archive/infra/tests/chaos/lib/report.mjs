// Drill harness: PASS/FAIL transcript + summary + exit codes.
// Every chaos drill ends with a §3.4-shaped outcome statement so the
// expected outcome is visible right next to the evidence (spec §21:
// "Each has a scripted drill and expected outcome").

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

export function createDrill(title) {
  const failures = [];
  const checks = [];
  const t0 = performance.now();
  console.log(`\n${"═".repeat(72)}`);
  console.log(`${title} — ${new Date().toISOString()}`);
  console.log(`${"═".repeat(72)}`);

  return {
    phase(name) {
      console.log(`\n${cyan("▶")} ${name}`);
    },
    info(msg) {
      console.log(`  ${dim(msg)}`);
    },
    event(msg) {
      console.log(`  ${yellow("•")} ${msg}`);
    },
    /** Assert with details; collects failures for the summary. */
    check(label, cond, details) {
      const ok = cond === true;
      checks.push({ label, ok });
      console.log(`  ${ok ? green("PASS") : red("FAIL")}  ${label}${details !== undefined ? ` — ${details}` : ""}`);
      if (!ok) failures.push(label);
      return ok;
    },
    /** Expect a promise to reject; returns the error (null if it resolved). */
    async expectRejection(label, promise) {
      try {
        await promise;
        return null;
      } catch (err) {
        return err;
      }
    },
    summary({ expectedOutcome, crossLinks = [] }) {
      const elapsed = Math.round(performance.now() - t0);
      console.log(`\n${"═".repeat(72)}`);
      console.log(`drill summary  ${checks.length - failures.length}/${checks.length} checks passed in ${elapsed} ms`);
      if (expectedOutcome) {
        console.log(`expected outcome (§3.4): ${expectedOutcome}`);
      }
      for (const link of crossLinks) console.log(`${dim(`  ↳ ${link}`)}`);
      console.log("═".repeat(72));
      return failures.length;
    },
  };
}

export { red as redFail };
