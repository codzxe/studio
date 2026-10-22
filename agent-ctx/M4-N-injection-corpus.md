# M4-N — injection corpus + safety proofs (record for the fleet)

Task ID: M4-N · Agent: M4-N (prompt-injection + safety corpus) · 2026-10-23

## Owned paths (all NEW)

- `services/gateway/tests/injection.test.ts` — 23 gateway proofs.
- `apps/web/src/lib/chat/__tests__/injection-corpus.ts` — the exported corpus
  (18 text fixtures + 5 tool results + 8 hostile args + 6 hostile plans +
  `minimalPlan` builder + needle/sweep helpers). ZERO imports — importable
  from both trees (the gateway test reaches it via relative path
  `../../../apps/web/src/lib/chat/__tests__/injection-corpus.js`).
- `apps/web/src/lib/chat/__tests__/injection-corpus.test.tsx` — 37 web proofs.
  DEVIATION (extension only): the brief listed `injection-corpus.test.ts`; the
  file renders React components (JSX) so it must be `.tsx` — esbuild rejects
  JSX in `.ts`. Same path stem, vitest include covers `*.test.tsx`.
- `docs/phases/M4-SAFETY.md` — the closeout security audit note.

## Test inventory

Gateway (23): write-tool begging (perfect args → repair → RUN_INVALID_TOOL) ·
write-flood (zero repairs) · poisoned tool results ×5 fed back VERBATIM with
the begged write tool still refused · plan path scanned for engine strings ·
prompt-boundary sweep (system turn FIRST + byte-exact for all 18 payloads) ·
hostile pinned labels · fingerprint sweep (length+sha256 only, distinct
digests) · logger sweep (no corpus needle in any record) · 999-layerIds repair
+ recovery · repeat-offense loop ×4 · proto-keys stripped by Zod · plan schema
reject sweep + valid-base sanity · $ref-escape plan → 2 attempts → PLAN_INVALID,
run survives (goal schema-override rides as data) · adversarial multi-tool
step cap · corpus self-check.

Web (37): markdown sweep ×14 (zero elements / zero unescaped tags / text
preserved) + label-only links + markdown-syntax meta case · tool card ×5
hostile results (pngBase64 as data: URL only, never text; failure-shape
summary as text) + collapsed-summary redaction + hostile args as text ·
executor sweep ×6 (verbatim JSON-serializable data) · list_layers proto-key
survival through spread (deep-merge safe) · F-1 demonstration (self-cleaning)
· client-side write refusal · context chips (labels as text, pinned, aria-live
thread) · corpus self-check.

## Findings (report-only, see M4-SAFETY.md §2)

- F-1 HIGH: `tool-executor.ts` `runGetProperties` (lines 399–406) —
  `layers["__proto__"]` READ returns Object.prototype, so `entry[pair.path] =
  value` writes onto Object.prototype with a model-chosen key (`paths` is a
  free string array) and bridge-chosen value. `layerIds`/`paths` Zod schemas
  allow arbitrary strings. Pinned + demonstrated in the web test
  (self-cleaning); needs M4-C2/M5 + a contracts ruling to fix
  (Object.create(null) / Map / dunder-refine).
- F-2 LOW: `tool-card.tsx` `redactForDisplay` — `out["__proto__"]` silently
  rebinds the LOCAL output prototype (key dropped from display; conservative,
  no global effect). Data-fidelity note only.
- F-3 INFO: `$ref` inside plan step `args` parses as inert data (args is
  `z.unknown()`); M4-safe (no apply path), M5's compiler must keep it data.
- F-4 INFO (by design): `planInstruction` names write tools for PLANNING;
  plans are proposal-only data; calling them is allowlist-rejected (proved).

## Gates (final)

- `DATABASE_URL=… pnpm --filter @studio/gateway test` → 124/124 (10 files) —
  injection.test.ts 23/23. (chat-loop.test.ts was mid-flight red in one
  interim run — M4-K's file, green after their sync; never M4-N's.)
- `pnpm --filter @studio/web test` → 430/430 (35 files) — corpus tests 37/37.
- Both typechecks clean; biome clean on all three M4-N files (after
  `biome check --write` formatting).

## Handoff facts

- Corpus reuse: import from either tree; sweeps pick up new fixtures
  automatically; self-checks fail fast on drift (needle visibility, counts).
- The F-1 test intentionally asserts the VULNERABLE behavior and cleans
  Object.prototype afterwards — when the fix lands, flip the assertions
  (the test name says FINDING F-1; the file/function to change is
  `runGetProperties`).
- `MARKDOWN_SWEEP` = the markdown-surface subset (14 fixtures); md-link
  fixture's needle lives in the URL (dropped by design) — `visibleNeedle()`
  maps it to the label "prizes here".
