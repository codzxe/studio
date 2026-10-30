# Army brief — round 13 (W1 audit)

You are one agent in a 500-agent army auditing the monorepo at `/home/z/my-project`.
READ-ONLY mission: you hunt, you report. You do NOT modify any file.

## Hunt targets (in priority order)

1. **Bugs** — logic errors, wrong operators, off-by-one, inverted conditions, dead branches,
   unreachable code, race-prone patterns, unwrapped fallible paths that can corrupt state.
2. **Bad algorithms / bad programs** — O(n²) or worse where O(n) is trivial, repeated
   linear scans inside loops, unbounded recursion, blocking I/O on hot paths, redrawing
   everything when one thing changed.
3. **Bad code** — copy-paste drift, wrong-crate imports, commented-out blocks kept alive,
   error paths that swallow the error, `unwrap()`/`panic!` on external input, silent
   fallbacks that mask failure.
4. **Hardcoded values** — magic numbers that should be config/tunables, hardcoded URLs,
   hardcoded model names, hardcoded paths, hardcoded colors/fonts/sizes that belong in
   theme tokens, hardcoded credits/prices, hardcoded version strings.
5. **Hardcoded stubs** — functions that return fake/placeholder data, `todo!()`,
   "not implemented yet" arms that pretend success, mock responses wired into real
   flows, canned strings pretending to be computed values.
6. **`effectcraft` references** (any case: EffectCraft / effectcraft / EFFECTCRAFT /
   `ai.storyteller.effectcraft` / `EffectCraft`) — report file + line + what it would
   take to remove (rename to what, or make config-driven).
7. **Upstream (graphite-clone) leftovers** — dead menu items for apps we are not,
   references to upstream docs/URLs/repo paths (`Graphite`, `graphite-editor`, upstream
   issue links), fonts/assets/branding that are not ours, features our SaaS never ships,
   "About" text, donation links, upstream telemetry/check-for-update URLs.

## Method

- Read EVERY file in your scope from the manifest (`/home/z/my-project/army/manifest-w1.md`).
- For each finding, record: `file:line` (be precise), severity (HIGH/MED/LOW),
  category (BUG / ALGO / BADCODE / HARDCODED / STUB / EFFECTCRAFT / UPSTREAM),
  one-line evidence (quote the actual line), and a one-line fix direction.
- Do not report style nits (formatting, import order) unless they hide a real bug.
- Do not report the same finding twice; dedupe within your scope.
- If a file in your scope is huge, prioritize: commands/ registries > panels > docs.

## Output (MANDATORY, race-safe)

Write EXACTLY ONE file: `/home/z/my-project/army/findings/w1/<your-agent-id>.md`
with this shape:

```
# <agent-id> findings
scope: <scope id + title>
files_read: <n>

## Findings
- <file>:<line> | <SEV> | <CAT> | <evidence> | <fix>
...
(or "no findings — clean" if truly nothing)

## Notes
<anything the fix wave must know>
```

Do NOT touch worklog.md. Do NOT modify product files. Do NOT create any other file.
If your scope's files do not exist, report that instead.
