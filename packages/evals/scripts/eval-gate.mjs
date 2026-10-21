// packages/evals/scripts/eval-gate.mjs
//
// THREE-GATE pass-rate gate for the golden-brief suite (spec §11.4 "block merge on
// regression beyond threshold"; §19 Phase 2 exit gates, verbatim: "eval suite >= 50
// briefs with >= 85% pass; chat edits correct >= 90% on the curated set").
//
// Gates (thresholds are §19 law, CLI-overridable for local experiments):
//   suite          >= 0.85 over ALL briefs in promptfoo.config.yaml
//                  (12 files, 67 cases)
//   chat-edits     >= 0.90 over the curated planner-level chat-edit briefs in
//                  chat-edits.config.yaml (cases/edits.yaml +
//                  cases/expanded/edits.yaml, 14 cases)
//   chat-edit      >= 0.90 over the §23.5 classifier curated set in
//     classifier   promptfoo.chat-edit.config.yaml (cases/chat-edits/, 5 files,
//                  20 cases). "Chat edits correct >= 90%" is graded at BOTH
//                  levels — planner routing AND classifier routing — so both
//                  gates default to 0.90.
//               One promptfoo eval yields ONE results file with ONE pass rate,
//               hence the three configs; this script reads all results files.
//
// Usage:
//   node scripts/eval-gate.mjs --suite results/suite.json [--suite-threshold 0.85] \
//                             [--chat results/chat-edits.json [--chat-threshold 0.90]]
//                             [--classifier results/chat-edit-eval.json [--classifier-threshold 0.90]]
//   node scripts/eval-gate.mjs <results.json> [threshold=0.85]   // legacy single gate
//   node scripts/eval-gate.mjs --dry                             // offline self-test
//
// Exit codes (CI contract — keep stable):
//   0  every gate passed
//   1  at least one gate below threshold — the STRICTEST failure wins, CI is red
//      (§11.4 "block merge on regression beyond threshold")
//   2  usage / input error: missing file, unparseable results, empty suite
//
// --dry runs offline (no promptfoo install, no network — §21 deterministic tests):
// it exercises the gate math, arg parsing and strictest-failure aggregation over
// synthetic results, plus a config-wiring sanity pass (every cases/*.yaml and
// cases/expanded/*.yaml on disk is registered in promptfoo.config.yaml, every
// cases/chat-edits/*.yaml is registered in promptfoo.chat-edit.config.yaml; the
// curated chat set is a subset of the suite; all files
// exist). CI parses the YAML for real — promptfoo eval itself is the authoritative
// YAML validator, and this script never attempts YAML parsing.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_THRESHOLD_DEFAULT = 0.85; // §19 Phase 2: "eval suite >= 50 briefs with >= 85% pass"
const CHAT_THRESHOLD_DEFAULT = 0.9; // §19 Phase 2: "chat edits correct >= 90% on the curated set"
const CLASSIFIER_THRESHOLD_DEFAULT = 0.9; // §19 chat gate at the §23.5 classifier level (same 90% law)

// ── helpers ──────────────────────────────────────────────────────────────────

// Strictest failure = worst exit code across gates (2 > 1 > 0).
const strictest = (codes) => codes.reduce((worst, code) => Math.max(worst, code), 0);

function usage(error) {
  if (error) console.error(`eval-gate: ${error}`);
  console.error(`usage: node scripts/eval-gate.mjs [--suite <suite.json> [--suite-threshold 0.85]] [--chat <chat.json> [--chat-threshold 0.90]] [--classifier <chat-edit-eval.json> [--classifier-threshold 0.90]]
       node scripts/eval-gate.mjs <results.json> [threshold=0.85]   (legacy single gate)
       node scripts/eval-gate.mjs --dry                             (offline self-test)
exit codes: 0 all gates passed | 1 >= one gate below threshold (strictest failure) | 2 usage/input error`);
}

function parseThreshold(value, label) {
  const t = Number(value);
  if (!Number.isFinite(t) || t <= 0 || t > 1) {
    return { error: `invalid ${label} "${value}" (expected 0 < t <= 1)` };
  }
  return { value: t };
}

function parseArgs(argv) {
  const parsed = {
    dry: false,
    dual: false,
    suite: null,
    chat: null,
    classifier: null,
    suiteThreshold: null,
    chatThreshold: null,
    classifierThreshold: null,
    positionals: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') {
      parsed.dry = true;
    } else if (
      a === '--suite' ||
      a === '--chat' ||
      a === '--classifier' ||
      a === '--suite-threshold' ||
      a === '--chat-threshold' ||
      a === '--classifier-threshold'
    ) {
      const value = argv[i + 1];
      if (value === undefined) return { error: `missing value for ${a}` };
      if (a === '--suite' || a === '--chat' || a === '--classifier') parsed.dual = true;
      if (a === '--suite') parsed.suite = value;
      else if (a === '--chat') parsed.chat = value;
      else if (a === '--classifier') parsed.classifier = value;
      else if (a === '--suite-threshold') parsed.suiteThreshold = value;
      else if (a === '--chat-threshold') parsed.chatThreshold = value;
      else parsed.classifierThreshold = value;
      i++;
    } else if (a.startsWith('--')) {
      return { error: `unknown flag "${a}"` };
    } else {
      parsed.positionals.push(a);
    }
  }
  return { parsed };
}

// promptfoo's JSON export has kept a top-level { results: [...] } shape for years;
// the per-entry `success` flag is the pass/fail bit. Be defensive about minor
// format drift ({ eval: { results } } also accepted).
function extractResults(data) {
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.eval?.results)) return data.eval.results;
  return [];
}

// One gate: evaluate a parsed results file against a threshold.
// Returns { code: 0|1|2, lines: string[] } — never prints, never exits.
function gate(label, data, threshold) {
  const results = extractResults(data);
  if (results.length === 0) {
    return {
      code: 2,
      lines: [
        `eval-gate[${label}]: no results in output — an empty suite never passes a gate`,
      ],
    };
  }
  const isPass = (r) => r?.success === true;
  const passed = results.filter(isPass).length;
  const rate = passed / results.length;
  const bar = `${(rate * 100).toFixed(1)}% pass (gate >= ${(threshold * 100).toFixed(0)}%) — ${passed}/${results.length} cases`;
  if (rate >= threshold) {
    return { code: 0, lines: [`eval-gate[${label}]: PASS ${bar}`] };
  }
  // Fail loudly with the offending cases (§21: a good test "fails loudly with a message").
  const failed = results.filter((r) => !isPass(r));
  return {
    code: 1,
    lines: [
      `eval-gate[${label}]: FAIL ${bar}`,
      ...failed.map(
        (r) =>
          `eval-gate[${label}]:   FAILED ${
            r?.testCase?.id ?? r?.testCase?.description ?? r?.id ?? '<unnamed case>'
          }`,
      ),
    ],
  };
}

function loadResults(file) {
  try {
    return { data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return {
      error: `cannot read/parse ${file} — did 'promptfoo eval --output <file>' run first?`,
    };
  }
}

// ── offline config-wiring sanity (used by --dry; NOT a YAML parser) ──────────

// Extracts the `tests:` case-file entries from a config's text. All three configs in
// this package list test files as `- cases/<path>.yaml  # optional comment`.
function extractTests(configText) {
  const refs = [];
  const re = /^[ \t]*-[ \t]+(cases\/[A-Za-z0-9_/.@-]+\.yaml)[ \t]*(?:#.*)?$/gm;
  for (const m of configText.matchAll(re)) refs.push(m[1]);
  return refs;
}

function configSanity() {
  const lines = [];
  const fail = (msg) => {
    lines.push(`eval-gate[config-sanity]: FAIL — ${msg}`);
    return { code: 1, lines };
  };
  const suitePath = path.join(PKG_ROOT, 'promptfoo.config.yaml');
  const chatPath = path.join(PKG_ROOT, 'chat-edits.config.yaml');
  const classifierPath = path.join(PKG_ROOT, 'promptfoo.chat-edit.config.yaml');
  if (!existsSync(suitePath)) return fail('promptfoo.config.yaml not found');
  if (!existsSync(chatPath)) return fail('chat-edits.config.yaml not found');
  if (!existsSync(classifierPath)) return fail('promptfoo.chat-edit.config.yaml not found');

  const suiteRefs = extractTests(readFileSync(suitePath, 'utf8'));
  const chatRefs = extractTests(readFileSync(chatPath, 'utf8'));
  const classifierRefs = extractTests(readFileSync(classifierPath, 'utf8'));
  if (suiteRefs.length === 0) return fail('no tests: entries parsed from promptfoo.config.yaml');
  if (chatRefs.length === 0) return fail('no tests: entries parsed from chat-edits.config.yaml');
  if (classifierRefs.length === 0) {
    return fail('no tests: entries parsed from promptfoo.chat-edit.config.yaml');
  }
  if (new Set(suiteRefs).size !== suiteRefs.length) {
    return fail('duplicate tests: entries in promptfoo.config.yaml');
  }
  if (new Set(classifierRefs).size !== classifierRefs.length) {
    return fail('duplicate tests: entries in promptfoo.chat-edit.config.yaml');
  }
  for (const ref of [...suiteRefs, ...chatRefs, ...classifierRefs]) {
    if (!existsSync(path.join(PKG_ROOT, ref))) {
      return fail(`referenced case file missing on disk: ${ref}`);
    }
  }
  // Every case file on disk must be registered in the config that gates its
  // contract (completeness — the §19 ">= 50 briefs" gate counts what promptfoo
  // actually runs): planner-envelope files → the SUITE config; §23.5 classifier
  // files → the CLASSIFIER config (their output contract intentionally violates
  // the suite's {plan, run} defaultTest, so they must NOT be appended to the
  // suite — see promptfoo.chat-edit.config.yaml header).
  const onDiskSuite = [
    ...readdirSync(path.join(PKG_ROOT, 'cases'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => `cases/${f}`),
    ...readdirSync(path.join(PKG_ROOT, 'cases/expanded'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => `cases/expanded/${f}`),
  ];
  const onDiskClassifier = readdirSync(path.join(PKG_ROOT, 'cases/chat-edits'))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => `cases/chat-edits/${f}`);
  const suiteSet = new Set(suiteRefs);
  const classifierSet = new Set(classifierRefs);
  const orphaned = onDiskSuite.filter((f) => !suiteSet.has(f));
  if (orphaned.length > 0) {
    return fail(`case files on disk but NOT registered in the suite config: ${orphaned.join(', ')}`);
  }
  const orphanedClassifier = onDiskClassifier.filter((f) => !classifierSet.has(f));
  if (orphanedClassifier.length > 0) {
    return fail(
      `classifier case files on disk but NOT registered in promptfoo.chat-edit.config.yaml: ${orphanedClassifier.join(', ')}`,
    );
  }
  // The curated planner chat set must be a subset of the full suite.
  const notInSuite = chatRefs.filter((r) => !suiteSet.has(r));
  if (notInSuite.length > 0) {
    return fail(`chat-gate files not part of the full suite: ${notInSuite.join(', ')}`);
  }
  lines.push(
    `eval-gate[config-sanity]: PASS — suite config registers ${suiteRefs.length} case files (` +
      `${onDiskSuite.length} on disk, none orphaned); chat gate registers ${chatRefs.length} (subset of suite); ` +
      `classifier gate registers ${classifierRefs.length} of ${onDiskClassifier.length} on disk; all exist`,
  );
  return { code: 0, lines };
}

// ── --dry: offline self-test of this script's own logic (no deps, no CI needed) ─

function selfTest() {
  let ok = true;
  const check = (name, cond) => {
    ok = ok && cond;
    console.log(`eval-gate --dry: ${cond ? 'ok' : 'FAIL'} — ${name}`);
  };
  const mk = (passed, total) => ({
    results: Array.from({ length: total }, (_, i) => ({
      success: i < passed,
      testCase: { id: `case-${i + 1}` },
    })),
  });

  // 1. gate math at the §19 thresholds (exact suite/chat/classifier sizes included).
  check('suite boundary 57/67 = 0.8507 >= 0.85 passes', gate('suite', mk(57, 67), 0.85).code === 0);
  check('suite 56/67 = 0.8358 < 0.85 fails (exit 1)', gate('suite', mk(56, 67), 0.85).code === 1);
  check('chat boundary 13/14 = 0.9286 >= 0.90 passes', gate('chat-edits', mk(13, 14), 0.9).code === 0);
  check('chat 12/14 = 0.8571 < 0.90 fails (exit 1)', gate('chat-edits', mk(12, 14), 0.9).code === 1);
  check('classifier boundary 18/20 = 0.90 passes (>= semantics)', gate('chat-edit-classifier', mk(18, 20), 0.9).code === 0);
  check('classifier 17/20 = 0.85 < 0.90 fails (exit 1)', gate('chat-edit-classifier', mk(17, 20), 0.9).code === 1);
  check('exact boundary 17/20 = 0.85 passes (>= semantics)', gate('x', mk(17, 20), 0.85).code === 0);
  check('empty results is an input error (exit 2)', gate('suite', { results: [] }, 0.85).code === 2);
  check(
    'results nested under data.eval.results are read (format drift)',
    gate('suite', { eval: { results: mk(10, 10).results } }, 0.85).code === 0,
  );
  const failedGate = gate('suite', mk(9, 10), 0.95);
  check(
    'failure output names the failed cases (§21 fail loudly)',
    failedGate.code === 1 &&
      failedGate.lines.some((l) => l.includes('FAILED case-10')) &&
      failedGate.lines.length === 2,
  );

  // 2. arg parsing.
  const p1 = parseArgs(['--suite', 'a.json', '--chat', 'b.json', '--chat-threshold', '0.95']);
  check(
    '--suite/--chat/--chat-threshold parse as dual mode',
    !p1.error && p1.parsed.dual && p1.parsed.suite === 'a.json' && p1.parsed.chat === 'b.json' && p1.parsed.chatThreshold === '0.95',
  );
  const p1c = parseArgs(['--classifier', 'c.json', '--classifier-threshold', '0.95']);
  check(
    '--classifier/--classifier-threshold parse as dual mode',
    !p1c.error && p1c.parsed.dual && p1c.parsed.classifier === 'c.json' && p1c.parsed.classifierThreshold === '0.95',
  );
  const p2 = parseArgs(['results/eval.json', '0.9']);
  check(
    'legacy positional mode preserved',
    !p2.error && !p2.parsed.dual && p2.parsed.positionals.join(',') === 'results/eval.json,0.9',
  );
  const p3 = parseArgs(['--nope']);
  check('unknown flag is a usage error', !!p3.error);
  const p4 = parseArgs(['--chat']);
  check('flag without value is a usage error', !!p4.error);
  check('--dry parses', parseArgs(['--dry']).parsed.dry === true);
  check(
    'threshold validation rejects 0 / negative / >1 / NaN',
    !!parseThreshold('0', 't').error &&
      !!parseThreshold('-1', 't').error &&
      !!parseThreshold('1.5', 't').error &&
      !!parseThreshold('nope', 't').error &&
      parseThreshold('0.9', 't').value === 0.9,
  );

  // 3. strictest-failure aggregation (the exit code CI sees).
  check('strictest: pass+pass -> 0', strictest([0, 0]) === 0);
  check('strictest: suite-fail+chat-pass -> 1', strictest([1, 0]) === 1);
  check('strictest: suite-pass+chat-fail -> 1', strictest([0, 1]) === 1);
  check('strictest: fail+fail -> 1', strictest([1, 1]) === 1);
  check('strictest: input error dominates gate failure (2 > 1)', strictest([1, 2]) === 2);

  // 4. config wiring sanity (offline; CI validates the YAML via promptfoo itself).
  const sane = configSanity();
  for (const line of sane.lines) console.log(line);
  check('config wiring sanity (see [config-sanity] lines above)', sane.code === 0);

  console.log(
    `eval-gate --dry: ${ok ? 'OK' : 'FAILED'} — offline logic self-test; ` +
      'CI parses the configs for real via promptfoo eval',
  );
  return ok ? 0 : 1;
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    usage(parsed.error);
    return 2;
  }
  if (parsed.parsed.dry) return selfTest();

  const gates = [];
  if (parsed.parsed.dual) {
    if (!parsed.parsed.suite && !parsed.parsed.chat && !parsed.parsed.classifier) {
      usage('dual mode needs --suite and/or --chat and/or --classifier results files');
      return 2;
    }
    if (parsed.parsed.positionals.length > 0) {
      usage('dual mode takes no positional arguments');
      return 2;
    }
    if (parsed.parsed.suite) {
      const t = parseThreshold(parsed.parsed.suiteThreshold ?? String(SUITE_THRESHOLD_DEFAULT), '--suite-threshold');
      if (t.error) {
        usage(t.error);
        return 2;
      }
      gates.push({ label: 'suite', file: parsed.parsed.suite, threshold: t.value });
    }
    if (parsed.parsed.chat) {
      const t = parseThreshold(parsed.parsed.chatThreshold ?? String(CHAT_THRESHOLD_DEFAULT), '--chat-threshold');
      if (t.error) {
        usage(t.error);
        return 2;
      }
      gates.push({ label: 'chat-edits', file: parsed.parsed.chat, threshold: t.value });
    }
    if (parsed.parsed.classifier) {
      const t = parseThreshold(
        parsed.parsed.classifierThreshold ?? String(CLASSIFIER_THRESHOLD_DEFAULT),
        '--classifier-threshold',
      );
      if (t.error) {
        usage(t.error);
        return 2;
      }
      gates.push({ label: 'chat-edit-classifier', file: parsed.parsed.classifier, threshold: t.value });
    }
  } else {
    // Legacy single-gate mode (pre-chat-gate wiring, e.g. the eval:ci script).
    const [file, thresholdArg] = parsed.parsed.positionals;
    if (!file) {
      usage('missing results file');
      return 2;
    }
    const t = parseThreshold(thresholdArg ?? String(SUITE_THRESHOLD_DEFAULT), 'threshold');
    if (t.error) {
      usage(t.error);
      return 2;
    }
    gates.push({ label: 'suite', file, threshold: t.value });
  }

  const codes = [];
  for (const g of gates) {
    const loaded = loadResults(g.file);
    if (loaded.error) {
      console.error(`eval-gate[${g.label}]: ${loaded.error}`);
      codes.push(2);
      continue;
    }
    const result = gate(g.label, loaded.data, g.threshold);
    for (const line of result.lines) {
      if (result.code === 0) console.log(line);
      else console.error(line);
    }
    codes.push(result.code);
  }
  return strictest(codes); // 0 all passed | 1 a gate failed | 2 input error
}

process.exit(main(process.argv.slice(2)));
