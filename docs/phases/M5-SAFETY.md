# M5-SAFETY — the write-surface audit (M5 task 8, `panic_hunt` for tool args)

Status: **evidence pack for BUILD_PLAN §M5 task 8 ("panic_hunt equivalent for
tool args: adversarial JSON never crashes gateway or editor bridge")** ·
Owner: M5-N · 2026-10-24 · Extends `docs/phases/M4-SAFETY.md` (findings
F-1…F-4 there; numbering continues here). Corpus:
`services/gateway/tests/injection-write.ts` (the write-surface fixtures,
self-contained, zero runtime imports) + its web mirror inside
`apps/web/src/lib/chat/__tests__/injection-write.test.tsx` (cross-tree
duplication accepted per the M5-N ruling; needles identical where fixtures
overlap). Sweeps: `services/gateway/tests/injection-write.test.ts` (96 tests)
and `apps/web/src/lib/chat/__tests__/injection-write.test.tsx` (28 tests).

M4 proved the read pipeline treats project text as data. M5 adds the surface
that can MUTATE a project, so the safety claim grows a chain of five gates
between the model and the engine:

## 1. Findings (F-5…F-7; report-only per law #12 — nothing was fixed here)

**F-5 (HIGH, drift — fail-closed, not a security hole).
`services/gateway/src/plan-compiler.ts` `Compiler.translate()` reads an
EARLIER DRAFT of the write-tool args shapes; the landed
`@studio/contracts` write-tools.ts uses different field names.**
Contracts (M5-A, landed) say `set_properties {layers:[{name}], properties:[{path,value}]}`,
`set_keyframes {layers, propertyPath, keys:[{timeSeconds,value}]}`,
`add_effect {layers, effect:{name}, params}`, `apply_preset {preset:{name|builtinId}, layers}`,
`create_text {text,name,position,font,style,size,fill,…}` — the compiler still
reads `{updates:[{layer,path,value}]}`, `{layer,keyframes:[{time,easing}]}`,
`{layer,effect:string}`, `{targets,preset:string}` and `{compId,fontSize,fontFamily,color}`.
Verified consequences (all pinned by deterministic tests):
- five of the eight tools translate PERFECT, schema-valid args to ZERO commands →
  every such write-tool call answers `PROPOSAL_INVALID`, and `studio.plan_edit`
  plans whose steps use those tools ride the wire UN-enriched (no compiledBatch,
  no Apply button);
- `create_text` compiles but SILENTLY DROPS the validated typography fields
  (font/style/size/fill) — the compiled batch only carries text/name/position;
- the sharpest edge: a MIXED plan (one create_text + one set_properties step)
  compiles `ok:true` with ONLY the create_text command — the user approves two
  edits and Apply would silently run one (a completeness hazard, not an
  injection hazard — nothing hostile can ride it, the dropped step is simply
  gone).
Not triggerable by project data — it fires on the BEST-behaved model. It blocks
the M5 exit criteria ("10 representative prompts apply successfully") until
fixed. Pinned by: gateway `injection-write.test.ts` → "M5-N FINDING F-5 — the
compiler reads the OLD draft args shapes (drift pins)" (all 5 probes +
"FINDING F-5 (sharpest edge): a mixed plan SILENTLY DROPS the drifted step…")
and "FINDING F-5 at the runner wire: PERFECT set_properties args propose
NOTHING today". Suggested fix (plan-compiler.ts is M5-B's seam — needs its
owner or the integrator): make `translate()` read the landed shapes (it
already validates them — `WRITE_TOOL_ARGS_SCHEMAS` is the same file pair's
source of truth), then flip the five drift pins + the two runner pins; the
corpus fixtures (`COMPILER_DRIFT_PROBES`, `DRIFT_MIXED_PLAN`) are the fix's
ready-made acceptance tests.

**F-6 (LOW, defense-in-depth gap). The §8.5 wire gate and the client apply
gate are BOUNDS/SHAPE-only — command-id membership is never checked after the
compiler.** `AGENT_BATCH_SCHEMA` (and therefore `PLAN_EVENT_SCHEMA.compiledBatch`,
and the SSE reader's zod re-validation) accepts a batch whose steps carry
`command: "__proto__"` or `command: "engine.batch"`; the web's
`run-state.ts parseCompiledBatch` and `apply.ts validCompiledBatch` are
deliberately narrow hand-rolled shape checks with the same property. A hostile
*server* (or a schema-drift bug) could therefore deliver an executable-shaped
batch with non-registry commands to the client — the FINAL gate is the engine
itself: the fake-editor parity suite proves `engine.batch` rejects the dunder
command with `unknown command` and the NOT_IN_BATCH entrypoint with `can't run
inside a batch`, atomically, with zero mutations. The model can never emit a
compiledBatch (it is server-compiled from validated args — section B proves
the compiled output is registry-only), so the realistic threat is a compromised
gateway. Pinned by: gateway → "M5-N safety — §8.5 batch bounds on the wire…" +
"FINDING F-6 (report-only): the wire gate is BOUNDS-ONLY…"; web → "M5-N FINDING
F-6 (report-only) — hostile command ids pass the client gate; the engine
refuses" (both engine-rejection pins). Suggested fix (one line + a flip):
`apply.ts`/`run-state.ts` could check `isAgentCommand(step.command)`
(`@studio/contracts` exports it) before `engine.batch`; needs an owner ruling
because apps/web deliberately keeps runtime contracts imports out of product
code (the api-client seam would host it).

**F-7 (INFO, consistency). Composition names and version labels are not
dunder-guarded, by design.** `SAFE_NAME_SCHEMA` (dunder-rejecting) covers
layer/preset/effect NAMES; `create_composition` names and `save_version`
labels are plain bounded strings, so `{"name":"__proto__"}` and a
`__proto__`-prefixed version label PARSE. They are VALUES, never keys — the
corpus proves they ride the compiled batch/annotation as inert data and
Object.prototype stays clean. If comp names or version labels ever become
object keys downstream, revisit. Pinned by: gateway args sweep
(`cc-name-dunder`, `sv-label-dunder` "data" expectations) + the plan sweep
(`plan-save-dunder-label`).

*Infra observation (not numbered — editor-bridge's file):* the FAKE bridge's
`substitute()` rebuilds batch params onto a plain `{}`, so an own `__proto__`
param key rebinds that LOCAL clone's prototype (local-only; Object.prototype
untouched — the web suite proves it end-to-end). The real engine is Rust and
unaffected; the fake could adopt a null-prototype clone for fidelity with the
M4-N F-1 fix pattern.

## 2. The write-surface boundary map (W1–W6 → proofs)

| # | Boundary | Untrusted source | Defender | Evidence (file → test) |
|---|---|---|---|---|
| W1 | model → tool args | `tool_calls[].function.arguments` for the 8 write tools | STRICT Zod: dunder names/paths/values rejected at any depth; bounds (≤50 refs, ≤100 updates, ≤500 keys, ≤2000-char text, 2 MB args); NaN/∞/−0-outside-bounds rejected; the client executor refuses ALL write tools before looking at args | gateway `injection-write.test.ts` → "write-tool args: every hostile payload is rejected or inert data" (43 fixtures) + "the dunder rejection holds for EVERY tool…" ; web → "hostile write-tool args never reach a bridge call" (8 mirrored tools, ZERO bridge calls) |
| W2 | model plan → server compiler | the structured-output EditPlan (proposed batches, tool ids, args) | EDIT_PLAN_SCHEMA bounds → per-step write-tool allowlist (`unknown_tool` for read-tool/raw-engine/plan_edit/empty/double-prefix ids) → args re-validation → translation from ARGS ONLY (proposed batches are advisory: unknown ids/forward/self refs/oversize labels/`atomic:false` extras → typed warns, never merged) → registry gate + §8.5 bounds on the COMPILED batch (unknown/missing-param/refs fatal) | gateway → "the plan compiler under hostile plans" (19 fixtures: plan_invalid / compile_fatal / compiled_clean) + "hostile plans across the whole corpus leave the danger invariants intact…" |
| W3 | compiler → wire | the plan event's `compiledBatch` | AGENT_BATCH_SCHEMA bounds (steps ≤100, 2 MB, timeout 1…60000, atomic literal, backwards-only $N) re-validated by PLAN_EVENT_SCHEMA at the SSE reader; poisoned plans yield NO compiledBatch (PLAN_INVALID / un-enriched) and poisoned-but-compiling plans yield a POISON-FREE compiledBatch | gateway → "§8.5 batch bounds on the wire" (16 fixtures) + "a poisoned plan NEVER yields a poisoned compiledBatch on the wire" (3 scripted-model runs + args-repair + F-5 runner pin + law-5 redaction pin) |
| W4 | wire → client apply | the plan event (SSE) | api-client zod gate (bounds only — F-6) → run-state narrow fold (poisoned runtime → NULL → M4 display card) → apply's shape gate (invalid-batch BEFORE any engine call) → resolution: exact-name matches, typed `ambiguous` (50-Twin pinned) / `not-found`, unbound `$request:` tokens refuse | web → "poisoned compiled batches are rejected before engine.batch" (6 shapes, zero mutations), "the Twin-50 name-collision abuse resolves to typed ambiguity", "a poisoned plan event never grows an apply surface" (+ the timeout-sanitize pin) |
| W5 | apply → engine | the patched atomic batch | the engine's own registry (`unknown command`), NOT_IN_BATCH (`can't run inside a batch`), atomic rollback — final gate after F-6's shape-only layers; dunder request ids/param keys ride as OWN data (null-prototype accumulators, F-1 pattern) and the engine consumes the clean fields | web → "FINDING F-6 … the engine refuses" (2 pins, real fake editor) + "dunder ids/keys ride the apply as inert data" (2 pins incl. prop.get content check) |
| W6 | everything → Object.prototype | every dunder payload above | schema dunder guards + null-prototype accumulators + own-key data clones | gateway → `expectPrototypeClean()` in every sweep; web → "M5-N global canary" (suite-wide Object.prototype + toString + zero enumerable additions) |

## 3. Corpus taxonomy (`injection-write.ts`; counts verified by both self-checks)

- **Hostile write-tool args (43)**: dunder names/paths/values in every
  name-taking tool; bounds+1 floods (51 refs / 101 updates / 501 keys) and the
  literal 1001-bomb; 2 MB single strings (text/value/label); numeric poison
  (Infinity-via-`1e999`, NaN via `argsValue`, −0, negative/1e18 keyframe
  times); null values, `$ref` inside values (F-3 carry-forward), deep own
  `__proto__` chains; Twin×50 same-name abuse; preset names shadowing
  `effect.apply`/`engine.batch` and an fs-path preset; strict-schema extra
  keys; hostile version labels.
- **Hostile plans (19)**: proposed-batch poison (unknown ids, forward/self
  `$N` refs, `timeoutMs:0`/`atomic:false` extras, 281-char labels, 101-step
  and steps-as-strings shapes), tool-field poison (read-tool/raw-engine/
  plan_edit/empty/double-prefix ids), args poison riding valid envelopes,
  label poison, and the summary-injection fidelity pin.
- **§8.5 wire poisons (16)**: timeout 0/1e12/60000-boundary, `atomic:false`,
  101/100-step boundaries, empty/281 labels, steps-as-strings, forward/self
  refs, 2 MB payload, the F-6 dunder/shadow command parses, the clean sanity.
- **F-5 drift probes (5 + the mixed plan)**: perfect current-contracts args
  per drifted tool, `compiledToday` pinned (`empty` ×4, `partial` ×1).

Both suites pick fixtures from the gateway file; the web file mirrors its
slice with identical needles (documented lockstep check). The corpus is static
by design — new write-surface threats extend `injection-write.ts` and every
sweep picks them up.

## 4. Handoff

- **F-5 needs an owner now** (plan-compiler.ts, M5-B seam): the drift pins and
  `COMPILER_DRIFT_PROBES` are the acceptance tests; when the fix lands, flip
  the five `compiledToday` expectations, the mixed-plan pin and the two
  runner-wire pins — the surrounding invariants stay green.
- **F-6** is a one-line client allowlist away from closed if a ruling puts
  `isAgentCommand` behind the api-client seam; the web F-6 tests then flip
  from "the engine refuses" to "the client refuses".
- Golden-prompt and failure-injection suites (the other §M5 task-8 bullets)
  are NOT this task; the corpus fixtures here are ready raw material for them.
